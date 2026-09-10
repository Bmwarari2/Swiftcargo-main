# Architecture

How the backend, the WhatsApp layer and the operator dashboard fit
together. Written for a developer who has read `README.md` and wants the
why-behind-the-what — the conversation dispatcher, the AI boundary, auth,
RLS, webhook idempotency, and the non-obvious invariants the code
depends on.

For what the system used to be and why it changed, see
[`REBUILD.md`](./REBUILD.md). For run/deploy instructions see
[`SETUP.md`](./SETUP.md) and [`CUTOVER.md`](./CUTOVER.md).

---

## 1. Top-level shape

```
   ┌──────────────┐                        ┌──────────────────┐
   │  Customer    │                        │  Operator/Admin  │
   │  (WhatsApp)  │                        │  (browser)       │
   └──────┬───────┘                        └────────┬─────────┘
          │                                         │ HTTP + JWT
          ▼                                         ▼
   ┌───────────┐   webhook    ┌──────────────────────────────────────┐
   │  sent.dm  │─────────────▶│  Express 5 (server.js, routes/*)     │
   │  (WhatsApp│◀─────────────│   • the only write path              │
   │   BSP)    │   send API   │   • auth, roles, rate limits, sanitize│
   └───────────┘              │   • serves the built SPA             │
                              └──┬────────────┬───────────┬──────────┘
                                 │            │           │
                                 ▼            ▼           ▼
                        ┌────────────┐ ┌───────────┐ ┌──────────────┐
                        │  Postgres  │ │ Supabase  │ │  Claude /    │
                        │ (Supabase) │ │  Storage  │ │  Lipana /    │
                        │ RLS forced │ │ (private) │ │  Frankfurter │
                        └────────────┘ └───────────┘ └──────────────┘
                                 │
                                 │ SSE (/api/events)
                                 ▼
                        operator dashboard, live
```

One server, one database, two human surfaces: a WhatsApp thread for the
customer and a React dashboard for staff. There is no customer web
account and no mobile app consuming this API.

---

## 2. The WhatsApp layer

Six modules, each with one job. If you are changing conversation
behaviour, it is almost certainly in the second one.

| Module | Responsibility |
| --- | --- |
| `utils/sentdm.js` | The only place that knows the provider. Send text/template, fetch delivery activities, verify webhook signatures, manage the registration. |
| `utils/waStateMachine.js` | Decides what happens on an inbound message. |
| `utils/waSend.js` | The single outbound path — persists to `wa_messages`, bumps the conversation head, broadcasts SSE. Bot, templates and operators all go through it, so the transcript is complete. |
| `utils/waOrderFlow.js` | `transition()` — validates the edge, stamps the timestamp, writes the audit row, sends the customer alert, broadcasts. |
| `utils/waAi.js` | Claude (`claude-sonnet-5`). Onboarding turns and knowledge-base answers. Nothing else. |
| `utils/waPayments.js` | Get-or-create the `awaiting_review` payment row, attach M-Pesa references. |

### Inbound path

```
POST /api/wa/webhook  (raw body, mounted before express.json)
  → verify Svix-style HMAC: x-webhook-id, x-webhook-timestamp, x-webhook-signature
  → dedupe on wa_messages.provider_message_id
  → persist inbound row, bump unread, SSE to dashboards
  → 200 ACK
  → handleInbound() runs after the ACK
```

The ACK comes before the bot reply on purpose: a slow model call must
never make the provider think delivery failed and retry.

### Dispatch order

`handleInbound()` runs these in order and returns at the first match.
Money and state resolve **before** the assistant is consulted, so no
model output can move an order or quote a price:

0. **Empty message** — no text and no recognised attachment. Returns
   immediately. A sticker or unsupported attachment arrives with no body,
   and one was read as a customer's delivery address, failed validation
   and earned them the same question twice. The row is in the inbox with
   its badge raised; a person decides whether it meant anything.
1. **Human takeover** — if `human_takeover_at` is set and the chat hasn't
   been quiet for `ai_resume_after_minutes`, the assistant stays silent.
   Runs first so it covers onboarding too.
1b. **Quote request** — the message contains a link. Pages staff on
   WhatsApp and over SSE, then falls through to whatever branch would
   have handled it. Nothing downstream is automatic: the assistant says a
   quote is coming, and a person has to send it.
1c. **SHEIN without a cart** — a `shein.com` link with no `shc=` share
   parameter among them. A product page frequently will not open on our
   side and never says which size or colour was picked, so the customer
   gets the three-dot cart instructions immediately rather than after an
   operator has tried and failed. Deterministic for the same reason money
   is: it is a fact about what we can open, not a judgement call. Silent
   while an operator holds the thread, and said once per burst — three
   pasted product links should not earn three identical corrections.
2. **Onboarding** — contact isn't `active` yet.
3. **Tracking auto-reply** — a `TRK-####` anywhere in the text.
4. **Quote confirmation** — a yes-like reply *and exactly one* order in
   `quoted`. Zero or several is ambiguous and goes to a human.
5. **Payment claim** — "I've paid" or a pasted M-Pesa SMS.
6. **AI fall-through** — everything else.

A collection order takes a different path out of arrival: `in_kenya →
collected`, terminal, with no dispatch step and no customer message —
they were at the counter when it happened. `transition()` refuses
`dispatched`/`delivered` on a collection order and `collected` on a
delivery one, because the edge table cannot express a rule that depends
on the row rather than the status.

The last-mile fee rides on the quote rather than being collected on
arrival, so `delivery_fee_pending` is now reached only by orders quoted
before that change, or ones an operator priced without a method. Watch
`Number(null) === 0` around the fee columns: a NULL fee means "not yet
decided, still owed", and reading it as zero grants a free delivery.

Conversation state lives entirely on `wa_contacts.state`
(`new → awaiting_name → awaiting_address → active`, plus `blocked`). No
in-memory sessions, so a restart never loses a customer mid-signup.
`awaiting_mpesa` was a fourth step until `0008`; the value stays in the
CHECK constraint but nothing writes it any more — payments are matched
from the M-Pesa statement, so asking for the number up front only cost
us people at the door.

### The AI boundary

The assistant is deliberately fenced, and the fence is deliberately
short. It may read the knowledge base and a rendered summary of that
customer's own orders, and it may state anything they contain: a status,
a tracking code, a date, the agreed total, and — when money is owing —
the amount and the till. It may not work out a price, confirm anything,
promise a date, or claim an action was taken. Those paths ran before it.

The prompt carries **three** prohibitions, not fifteen. It had fifteen,
including two that duplicated each other and a blanket "only state facts
found in the knowledge base" that forbade ordinary warmth, and the effect
was an assistant that stalled rather than answered. The three that
remain — no invented money figure, no invented order or tracking code, no
named Pickup Mtaani point — are the three that have actually gone wrong,
and each is written with the customer it cost us. A rule that forbids the
right answer is worse than no rule.

It has three possible outcomes, tagged rather than stringly-typed so a
control token can't reach a customer:

| Outcome | Meaning | Effect |
| --- | --- | --- |
| `reply` | It answered | Send the text |
| `HANDOFF` | A person is needed | Acknowledge, page staff, and set takeover — unless our own output guard tripped (`guardTripped`), which pages without muting the assistant |
| `OFF_TOPIC` | Nothing to do with us | Say what we do handle (max once/hour), no alert, no takeover |

`classifyReply()` in `utils/waAi.js` is the boundary. An empty generation
classifies as `handoff`, so every failure mode degrades to the pre-AI
behaviour: a human picks it up. The sentinel must BE the whole reply, not
appear in it — a substring test once discarded "Our HANDOFF process takes
a minute." and handed that customer to a person.

**A gap in the knowledge base is where inventions come from.**
`wa_settings.ai_knowledge_base` is operator-owned prose, edited at
`/ops/settings` with no deploy, and it is the assistant's entire factual
surface for anything outside a customer's own orders. When a question
customers actually ask has no answer in it, the model fills the gap
rather than declining: asked about Nakuru, with a rule forbidding it to
name any area and nothing telling it we deliver countrywide, it invented
a Pickup Mtaani point there. It now covers where we deliver, why we can
be trusted (registration, office, receipt and M-Pesa trail), which stores
we do not yet buy from, and the ship-my-own-parcel case — every one added
after a real customer asked and got nothing. Read the inbox for the
questions it still cannot answer; that list is the backlog.

**It is told where the conversation stands, not left to infer it.**
`conversationFacts()` in `utils/waStateMachine.js` looks it up per turn
and `renderFacts()` puts it in both prompts above the transcript, as a
**single** line about the quote. The model had been inferring it from
the transcript alone and getting it wrong: +447428777090 asked "How do I
pay?" three messages in, having sent nothing, and was told "your quote
is being worked out now and will come through here shortly." A
transcript shows what was said; only the system knows what is true.

**A quote is in flight when a link has arrived and nothing has been
quoted since** — not when an order sits at `quoting`. That first version
measured the wrong interval and would have broken the cleanest sale in
the database: TRK-8834 sent a cart link at 19:38 and the operator did
not open the order until 19:43, so for five minutes the customer was
genuinely waiting and no row proved it. Worse, the block rendered "link
received: YES" directly above "NO quote is being prepared" and told the
model to ask for the link it had just been sent. 20 of 24 priced orders
spent two minutes or less at `quoting` and 13 spent none at all — the
operator creates the order already priced — so the flag was false for
almost the whole time anyone was actually waiting. The customer's wait
starts at the link, which is the event they can see, so that is what it
keys on.

**And the output is checked, not just discouraged.** `falseClaimIn()`
rejects two things: a promise that a quote is coming when nothing is in
flight (`claimsQuoteInFlight()`), and a money figure the turn's own
context cannot account for (`unbackedFigures()`). Either one regenerates
the turn once with the problem named; a second offence degrades to
`HANDOFF` and pages staff.

`claimsQuoteInFlight()` judges **per sentence**, skipping sentences that
ask for a link — otherwise it flags "send your cart and we'll quote you
in KES within the hour", which is the reply the funnel depends on. It
also splits present tense from future: "your quote **is** ready" is a
fact about a quote that exists and must go out, while "your quote **will
be** ready" is a promise about work nobody has started. The first
version conflated them and escalated a customer sitting on an open quote
at KSh 17,746 who had said nothing but "Heey".

When the guard trips twice the turn degrades to `HANDOFF`, but it is
flagged `guardTripped` so the caller pages a person **without** muting
the assistant for two hours — that mute is for a customer who asked for
a human, not for our own output check failing. The generation timeout is
30s, and the transcript window is 16 turns (twice the summary cadence):
sending all 30 tripled the prompt and started aborting mid-generation,
which cost a customer a reply entirely.

`unbackedFigures()` exists because "never price a specific item" was in
the prompt three times and in code zero times, while the assistant had
already sent a customer *"Please proceed with payment of KSh 4,980 via
Lipa na M-Pesa to Buy Goods Till 5530500"* — a sentence that appears
nowhere in this codebase. That figure was correct, which is the point:
nothing checked it. Only currency-marked amounts over 100 are checked,
so the model stays free to say "£9 per kilogram" and "2 to 3 weeks".

Same reasoning as `looksLikeName()`: a promise that leaves a customer
waiting for a message nobody will send, or a price nobody can honour, is
too expensive to depend on the model having a good day.

**Money answers before the AI, including "how do I pay?".**
`asksHowToPay()` + `replyWithPaymentDetails()` answer from the order row
when exactly one thing is owing — the agreed total and the real till for
a `confirmed` order, the fee for one awaiting last-mile payment, and for
a quote not yet accepted the figure plus an invitation to reply YES,
without moving the money state. Several things owing at once falls
through to a person. `loadOrderContext()` also carries the till on an
order awaiting payment, so the phrasings the predicate misses are still
answerable rather than deflected.

This exists because the opposite was tried: a guardrail forbidding the
assistant from giving payment instructions at all. It stopped the
invented ones and the real ones alike, and instructed the model to
promise the details were coming — so a customer with KSh 17,746
confirmed asked four times, was reassured four times, and wrote "You
haven't sent the details aki". The rule now is narrower and the answer is
deterministic.

**The memory note sits below the guardrails and is labelled unverified.**
`ai_summary` is model-written prose distilled from what the customer
said, and it used to be injected above both the knowledge base and the
rules under a heading that read as established fact — a standing channel
for anything a customer asserted once. Production notes already carry
M-Pesa numbers the onboarding flow deliberately never asks for, and one
records a fee concession. The summariser is now barred from recording
commercial terms, instructions addressed to the assistant, and
volunteered contact details.

**The model is pinned, and the turn is cheap.** `claude-sonnet-5`
(`ANTHROPIC_MODEL` overrides), adaptive thinking at `effort: low`,
`max_tokens: 4096`, a 30-second client timeout and one retry. A WhatsApp
reply is one to three sentences; deep thinking buys nothing here and
latency is what the customer feels — Diane asked where to send her
parcel, the call ran past the abort, and she got nothing at all.

Sonnet rather than Opus because this workload is knowledge-base lookup,
not reasoning: measured at ~3,000 input and ~450 output tokens over ~35
calls a day, Opus 5 came to about $29 a month against orders worth KSh
12,000–18,000 each. **Not every cheaper model is a drop-in.** Sonnet 5
supports everything this request sends; Haiku 4.5 rejects
`output_config.effort` outright and has no adaptive thinking (it wants
the retired `{type:'enabled', budget_tokens}`), so pinning it without
changing the request would 400 every turn and fall through to the
scripted flow — the same shape as the outage below.

The ceiling covers **thinking as well as the reply**, where the 1024 it
inherited from Gemini bought output only. No production failure was
traced to it — that was the schema, below — but a thinking-enabled turn
needs room to be wrong in. Thinking is asked for explicitly rather than
inherited for the same class of reason: whether omitting it means "on"
differs per model, and the model is an environment variable.

**The system prompt is split so the half every customer shares can be
cached.** Caching is a prefix match, so the ~2,700 tokens that are
identical for everyone — the role, the knowledge base, the guardrails —
come first and carry one explicit `cache_control` breakpoint; the
per-customer tail (today's date, profile, checked facts, order list,
memory note) follows and is never cached. That ordering is the whole
mechanism: those blocks used to sit *below* the per-customer content, so
nothing could ever be reused.

Two deliberate choices. An **explicit** breakpoint rather than top-level
automatic caching, because this prompt ends in per-customer content and
the automatic breakpoint lands after it — paying the write premium on
bytes nothing reads back. And a **1-hour TTL** rather than the 5-minute
default, because turns arrive roughly 20 minutes apart across the whole
customer base, so 5-minute entries would expire before the next turn and
every request would pay to write a cache nobody reads.

The reorder moved blocks only — the assembled prompt is byte-identical in
length to the version before it — and both invariants the old order
existed for still hold, with tests that say so: the checked facts still
precede the transcript (which lives in `messages`, after all of this),
and the memory note still sits below the guardrails that tell the model
how far to trust it. A prefix under the model's minimum (1024 tokens on
Sonnet 5) or perturbed by anything per-request does not error, it just
silently costs full price forever, so `generateWithUsage()` warns when a
request that asked to cache comes back having neither read nor written.

Measured: ~$29/month on Opus 5, ~$12 on Sonnet 5, ~$7 with the cache.

**What the swap actually broke was the output schema.** `onboardingTurn`
constrains its reply with `output_config.format`, and spelled the
optional `delivery_preference` as `type: ['string','null']` with an
`enum` beside it. Structured outputs rejects that pairing with a 400 —
*"Enum value 'delivery' does not match declared type '['string',
'null']'"* — before a token is generated, so **every onboarding turn
failed from the swap until it was read out of the deploy logs**, and
customers got the scripted questionnaire. The supported spelling is
`anyOf: [{type: 'string', enum: [...]}, {type: 'null'}]`.

No test caught it and none could have: every AI test answers the HTTP
call with a stub, and a stub validates nothing. `unsupportedSchemaBits()`
closes the specific gap — it checks the schema against the documented
subset in code, before the request goes out — but the general lesson is
in CLAUDE.md: a provider change is not finished until one real call has
been made against the real API.

Until 28 August this ran on Gemini, where the model name had to be
discovered from ListModels at runtime and re-resolved on a 404 because
Google retires names on a rolling basis — a stale default had taken the
assistant down once. That machinery is gone. `buildTurns()` is what the
switch did need: Anthropic rejects a conversation opening on the
assistant, and rejects an empty content string, so our own welcome line
and a caption-less image (Marion has one) are dropped rather than sent.

### Outbound copy constraints

sent.dm delivers free text through a system template, and WhatsApp
forbids newlines, tabs and 4+ space runs inside template variables. A
multi-line body is rejected with `VALIDATION_008` — in sent.dm's own
words, "param text cannot have new-line/tab characters or more than 4
consecutive spaces", *because WhatsApp does not accept them in a
parameter* — and retried flattened. After the first rejection the client
flattens up front instead of paying a wasted round-trip every time.

**Consequence: all customer copy must read correctly as one line.** The
tracking reply is a plain sentence or two for exactly this reason — an
earlier version used a labelled block with a progress bar, and flattening
turned it into a run-on smear.

What flattening preserves is structure carried by *characters*, which is
the only kind that survives: a bulleted line becomes ` • ` (the break is
the bullet — keeping both gave `· - Send your cart link`), a numbered
step keeps its number and gets a two-space gap, a paragraph break becomes
` — ` and any other break ` · `. The assistant's prompt says the same
thing in its own terms: number a sequence inline, three steps at most,
and never rely on a layout the customer will not see.

Approved templates are exempt: their body text can contain newlines (up
to two consecutive, never at the start or end), only the *variables*
can't. So a fixed-copy notification could be laid out over several lines
— at the price of a new Meta review.

---

## 3. Data model

WhatsApp tables (migration `0004`, extended by `0005`, `0007`, `0008`,
`0010`, `0011` and `0012`):

```
wa_contacts ──1:N──▶ wa_messages
     │
     └────1:N──────▶ wa_orders ──1:N──▶ wa_order_events
                          │
                          └──1:N──▶ payments (target_kind='wa_order')
wa_settings   key/value, operator-editable
```

- `wa_contacts.customer_code` — `TC-####` from `wa_customer_code_seq`, minted when onboarding completes.
- `wa_orders.order_code` — `ORD-####` from `wa_order_code_seq`, minted by a **column default** so every row has one whatever created it (`0021`). It names the *order*, from creation to delivery, and is what goes out as the `order_ref` template variable on the quote and the payment prompt. Before it, an order with no tracking code had no name at all and those messages carried `#` plus eight characters of its uuid. Deliberately **not** answered by the public `/api/tracking/:code` endpoint: codes here are sequential and guessable by design, and an order code exists from the moment an order does, so answering them publicly would expose every order nobody has paid for yet. The inbound state machine answers them, scoped to the contact who sent them.
- `wa_orders.tracking_code` — `TRK-####` from `wa_tracking_code_seq`, minted **inside the payment transaction**, so the code exists the instant money lands. It names the *parcel*: it goes on labels, on the receipt, and it is what the public tracking endpoint resolves.
- `wa_messages.provider_message_id` — unique; the inbound dedupe key and the handle delivery-status callbacks update.
- `wa_orders` snapshots `usd_price`, `fx_rate`, `markup_pct`, `fx_buffer_pct` and `quote_kes` at quote time. Never recompute a historical quote from today's rate.
- `wa_orders.fx_rate` is the **buffered** rate the customer was quoted at, not the mid-market rate. `exchange_rates.USD_KES` is a mid rate — the midpoint of a spread nobody trades at — and the business collects KES while paying suppliers in GBP from the UK, a round trip costing 3–4 KES on the cross. `wa_settings.fx_buffer_pct` (default 2.5) lifts mid to the quoting rate; `wa_orders.fx_buffer_pct` records how much of the snapshot was cushion, so the day's mid stays recoverable. NULL means the order predates the buffer. It is deliberately **not** `markup_pct`: the service margin is promoted and waived (it was 0 on all 18 quotes to the first month's end), while the buffer is cost recovery and must survive a promotion.
- `wa_orders.delivery_method` — `delivery` or `collection`, and `delivery_fee_in_quote` records that `quote_kes` already contains the fee. Watch `Number(null) === 0` around the fee columns: a NULL fee means "not yet decided, still owed", and reading it as zero grants a free delivery to every order quoted before `0010`.
- `wa_orders.pickup_point` — the Pickup Mtaani agent, set by staff. The customer names an area; the assistant is forbidden from confirming a point, having once invented coverage of one and been right only by luck.

`payments` was extended rather than duplicated: `user_id` is nullable,
`wa_contact_id` was added, `target_kind` accepts `'wa_order'`, and a
CHECK enforces that a payment has exactly one owner kind. That means the
WhatsApp flow reuses `utils/markPaymentPaid.js` unchanged.

### Pipeline

```
quoting ─▶ quoted ─▶ confirmed ─▶ paid ─▶ purchased ─▶ in_kenya ─┬─▶ dispatched ─▶ delivered
   │          │          │                                       ├─▶ collected (terminal)
   └──────────┴──────────┴─▶ cancelled          delivery_fee_pending ─┘
```

Edges are declared in `EDGES` in `utils/waOrderFlow.js` and enforced —
`advance` refuses anything not on the list, and `paid` can't be forced by
an operator at all because money moves through the payments machinery.
Board columns collapse this to five: Quoting `{quoting, quoted,
confirmed}`, Paid, Purchased, In Kenya `{in_kenya,
delivery_fee_pending}`, Delivered `{dispatched, delivered}`.

Arrival branches on whether anything is still owed. Since `0010` the
last-mile fee is charged **with the quote**, so almost nothing reaches
`delivery_fee_pending` any more — only an order quoted before that
change, or one an operator priced without a method. A settled or waived
fee returns the order to `in_kenya`: that status is a claim about a debt,
and an order that owes nothing must not sit in it.

The **promo toggle** still waives the fee on arrival, but it now waives
something already paid, so it should stay off while last-mile is charged
on every order. Its arrival template is MARKETING-classified and can be
refused for anyone opted out of marketing.

---

## 4. Payments

M-Pesa STK Push is coded (`utils/lipanaClient.js`, webhook, `pending`
payment rows) but **off** — Lipana withdrew service for regulatory
reasons, so `MPESA_PROVIDER=manual` in production and `stkAvailable()`
gates the UI.

The manual path holds one invariant: **the moment a customer owes money,
an `awaiting_review` payment row exists.** Three code paths can create
it — WhatsApp quote confirmation, the operator's "send till
instructions", and "payment received" — and all three go through
`ensureManualPayment()`, so none of them can produce a duplicate.

Approval runs through `markPaymentPaid()`, the same function the Lipana
and (formerly) Stripe webhooks call. It opens its own transaction,
flips the payment, flips the target row and mints the tracking code
atomically, then fires post-commit side effects (tracking code message,
receipt generation, receipt link). Never duplicate that logic; change it
in one place.

---

## 5. Receipts

Rendered with pdfkit — pure JS, no headless browser, Railway-safe — to a
private Supabase Storage bucket at `receipts/<orderId>/<paymentId>.pdf`
with upsert.

Delivery is a **short link**, not the signed URL. A Supabase signed URL
is ~600 characters of JWT, which arrives on WhatsApp as a wall of text
and expires after 7 days. Instead:

```
https://thapsus.uk/r/TRK-8821.<12-char HMAC>
        └─ GET /r/:token → verify → sign a fresh 10-minute URL → 302
```

The token is stateless: tracking code plus a truncated HMAC over the
order id, keyed on `JWT_SECRET`. No column, no migration, no cleanup, and
the link never goes stale because it re-signs per click. Rotating
`JWT_SECRET` invalidates every outstanding link — that is the intended
revocation mechanism.

`/r` is mounted **above** the SPA fallback and behind the public tracking
rate limiter. `tests/integration/appBoot.test.js` pins that ordering.

`/m/:token` (`utils/mediaLink.js`, `routes/mediaRedirect.js`) does the
same for outbound attachments, with one difference that matters. A
receipt token names a tracking code and the route looks up which file
that order owns. A **media token carries the storage path itself**, so
without the signature a well-formed token would reach any object the
service key can — receipts included. Hence the bucket is pinned inside
the helper rather than passed in, traversal and absolute paths are
rejected before the HMAC is consulted, and the comparison is
constant-time.

### Inbound media

Attachments a customer sends are stored on the message
(`wa_messages.media_url` / `media_type`). This was missing until
2026-08-25: the ingest INSERT never named those columns, so a payment
screenshot arrived as an empty row and the operator saw a blank bubble.

sent.dm's hydrated message carries no media at all — a real photo came
back as `{"header":null,"content":"","footer":null,"buttons":null}` — so
`extractInboundMedia()` searches the webhook envelope as well, over a set
of plausible keys plus a depth-capped sweep for anything that looks like
a file. **When it finds nothing, the webhook logs both envelopes.** That
log is the diagnostic: the provider's inbound shape is undocumented, and
the next blank message either names its key or proves one is never sent.

---

## 6. Authentication

Only staff have accounts. Customer self-registration is 410-stubbed.

Staff accounts are created from `/ops/team` and **send no email**. The
admin sets a temporary password (or leaves it blank for a generated one)
and hands it over; it is returned once and only the hash is stored.
`email_verified_at` is stamped at creation — login refuses an unverified
account with "activate your account from the link we emailed you", so
without that stamp every account created this way could be made and then
never signed into. No setup token is minted either: nothing emails one,
and an unused 24-hour credential is a liability rather than a
convenience.

### Token model

- **`sc_token`** — HS256 JWT, `Authorization: Bearer`. Payload
  `{ id, email, role, warehouse_id, iat }`, expiry `JWT_EXPIRY` (default
  `7d`). Silent refresh on `GET /auth/me` attaches `refreshed_token` when
  the current one is near expiry; the SPA also refreshes on tab focus.
- **`supabase_token`** — minted on demand by
  `POST /api/auth/supabase-token` for direct PostgREST access under RLS.
  Nothing in this repo's web client uses it; it is kept for out-of-band
  tooling.

### Defence-in-depth chain

Four layers on every authenticated request (`middleware/auth.js`,
`checkAuthStatus()` — one round trip):

1. **Signature**, with algorithms pinned to `['HS256']` to block
   algorithm-confusion.
2. **Revocation** — `revoked_tokens` holds SHA-256 hashes from
   `POST /api/auth/logout`. Plaintext is never stored.
3. **`password_changed_at`** — any JWT whose `iat` predates it is
   rejected, which is what makes a password reset actually invalidate
   outstanding sessions.
4. **`is_active`** — a live lookup, so deactivating a user takes effect
   on the next request.

### Roles

`requireRole(...allowed)`; admins always pass. Live roles are `operator`
and `admin`. `customer`, `clearing_agent`, `rider` and `influencer` rows
still exist in the database from the old system but have no surface to
log into. `tests/integration/roleMatrix.test.js` exercises the matrix.

Money approval is admin-only — `routes/adminPayments.js` and
`POST /api/wa/orders/:id/mark-paid`. Everything else in the pipeline is
operator-level.

---

## 7. RLS posture

All public tables have RLS enabled, and the `wa_*` tables have it
**forced**. The model is backend-mediated writes, defence-in-depth reads:

- Express holds the service-role key and is the only writer, so RLS is a
  second line rather than the first gate.
- Read policies are mostly `self_or_staff`, with staff-detection helpers
  (`is_admin`, `is_operator`, `is_thapsus_staff`) as Postgres functions
  with locked-down `search_path`.
- Some tables carry explicit `qual = false` deny policies
  (`password_reset_tokens`, `revoked_tokens`, `lipana_events_seen`, …) —
  never readable from any client role.

When in doubt read `pg_policies` directly.

---

## 8. Webhook idempotency

Two webhooks mount before `express.json()` so signatures verify against
the raw body:

- `POST /api/wa/webhook` — sent.dm, Svix-style HMAC over
  `${id}.${timestamp}.${rawBody}`. Idempotent via the unique
  `wa_messages.provider_message_id`, which is also what makes a replay
  harmless — so the staleness bound is 24h, not the Svix-conventional
  300s. sent.dm reuses the original signature on every retry, so a tight
  window rejects any event their queue holds.
- `POST /api/payments/lipana/webhook` — HMAC over the raw body,
  idempotent via `lipana_events_seen (event_id PK)`.

Both short-circuit on replay so retries land twice but run side effects
once. Webhooks bypass every rate limiter — the signature is the defence,
and dropping a legitimate retry is worse than the cost surface.

---

## 9. Body-parsing and middleware order

`server.js`, in order, with the why:

1. `helmet` — CSP, HSTS (1y, `includeSubDomains`, `preload`).
2. `cors` — explicit allowlist; boot throws on `CORS_ORIGIN='*'` outside development.
3. **Request-ID** — from a validated `X-Request-Id` or a fresh UUIDv4. Echoed back, threaded into morgan and `error_logs.meta.request_id`.
4. `compression`
5. `morgan`
6. **Raw-body webhook routes** (`express.raw({ limit: '1mb' })`) — must precede the JSON parser.
7. `express.json` / `express.urlencoded`, capped at **200kb**. Real binary uploads bypass Express entirely: clients PUT to Supabase Storage via signed URLs minted by `/api/*/upload-url`.
8. `sanitizeBody` / `sanitizeQuery` — XSS scrub with bounded recursion (16) and key count (256) so a hostile payload can't pin the event loop. Express 5's lazy `req.query` getter is replaced via `Object.defineProperty`; plain assignment is a no-op.
9. **Rate limiters** — 10/15min auth and payments, 30/15min signed-URL mints, 60/15min public tracking and `/r`, 200/15min global.
10. Routes.
11. SPA fallback `app.get(/^\/(?!api).*/, …)`.
12. JSON 404 + error logger.

---

## 10. Realtime

`GET /api/events` (SSE) fans out to the dashboard. Chosen over WebSocket
because HTTP/2 multiplexing is free and `EventSource` auto-reconnects.

Event types: `wa_inbox_update` (new message either direction),
`wa_pipeline_update` (order status moved), `wa_new_customer` (onboarding
completed). Handlers update the row, return 200, then emit — the emit is
best-effort and never blocks or fails a mutation.

---

## 11. Background jobs and reminders

Three timers start in `server.js` and stop on SIGTERM/SIGINT: the FX
refresh (`utils/fxRefresh.js`), daily log retention
(`utils/logRetention.js`), and the WhatsApp sweeper
(`utils/waSweeper.js`, every `WA_SWEEP_INTERVAL_MINUTES`, default 5).

**A recurring job must not measure elapsed process time.** The FX
refresh was a 60-second warm-up plus a 24-hour `setInterval`, and the
interval never once fired in production: Railway replaces the container
on every deploy, which through August happened every few hours, so the
timer was reset long before it came due. Every refresh the service had
ever done was the boot-time one — fine while deploys were constant, and
about to become a silent staleness bug the moment they stopped, which is
exactly when nobody is looking.

It now ticks every `FX_CHECK_INTERVAL_MINUTES` (default 30) and asks the
database how old the newest rate it owns is, refreshing only past
`FX_STALE_AFTER_HOURS` (default 12). Restart-proof in both directions: a
container that dies hourly is covered, and one that stays up for a week
is too. `rateAgeMs()` scopes the question to the four pairs this job
writes — `AED_KES` is a pre-rebuild leftover nothing reads, and
age-checking it would make the table look permanently stale.

The sweeper is the safety net for everything that fires once and can be
missed. Each tick it: retries failed free-text sends once inside the
24-hour window (`wa_messages.retry_count`), re-fires the post-payment
hook for paid orders whose receipt never generated, sends the one-day
payment reminder for confirmed-but-unpaid orders, runs the revenue
nudges (`utils/waNudges.js` — quote follow-up, browse-abandon, repeat
purchase; kill switch `wa_settings.nudges_enabled`), and pages staff for
the states below.

### Reminder discipline

Staff asked for this explicitly: **every staff reminder fires ONCE per
condition**, and the money-facing ones can be muted before they fire.
The mechanics are uniform — eligibility is excluded in SQL by a durable
claim, and the claim is written *before* the page goes out, so a crash
pages zero times rather than twice, and restarts or multiple instances
cannot re-page.

| Reminder | Fires | Claim |
| --- | --- | --- |
| Customer message unanswered | once, 15m after the inbound (`WA_SLA_UNANSWERED_MINUTES`) | `wa_contacts.unanswered_alerted_at` |
| Payment awaiting review | once, 15m after the row opens (`WA_SLA_PAYMENT_MINUTES`) | `payments.review_alerted_at` |
| Quote unanswered 48h / quote expired | once per quote | `wa_order_events` note |
| Order stalled in paid/dispatched 48h | once per order per stage | `wa_order_events` note |
| Paid order missing its receipt | once per payment | `wa_order_events` note |

**Muting.** The same stamps are the mute mechanism: the inbox thread
header's bell-off button ("No reply needed" —
`POST /api/wa/conversations/:id/dismiss-reminder`) and the payments
queue's bell-off button
(`POST /api/admin/payments/:id/dismiss-reminder`) write the claim
directly, so a page that needs no action never fires. Muting is never
permanent: a condition that recurs — a new customer message after a
reply, a new payment row — re-arms its reminder, because the claim is
compared against the condition's own timestamp (or belongs to the old
row entirely).

Muting a payment reminder does not touch the payment: the row still
sits in the queue until it is approved or rejected.

---

## 12. Things that look weird but are intentional

- **Retired tables were never dropped.** Renaming or dropping breaks the drift checker for no gain, and legacy orders still read them. A later `0006_legacy_readonly.sql` may revoke writes; actual DROPs stay owner-triggered.
- **`routes/orders.js` and `parcels.js` are still mounted.** Two pre-WhatsApp orders are still open, and public tracking falls back to them. `POST /api/orders` is 410-stubbed so no *new* legacy orders can be created while the read surface stays alive. `routes/ops.js` went with the console it served.
- **`utils/lipanaClient.js` and the STK code paths are dead but present.** `MPESA_PROVIDER` flips them back on if a provider becomes available. Deleting them would mean rewriting the integration from scratch.
- **The migration auto-runner is on in production.** It was opt-in, to keep concurrent deploys from racing on DDL — but Railway runs one instance and deploys are automatic on merge, so the real risk was the other one: code arriving ahead of its column. That happened on 2026-08-20 and took order creation down. Each migration still runs in its own transaction against the `_migrations` ledger, so a re-boot applies nothing.
- **The drift checker can't parse `FOR UPDATE OF <alias>`.** Queries use plain single-table `FOR UPDATE` and a separate fetch instead. It isn't a style preference.
- **Free-text sends are flattened.** See §2 — this is a WhatsApp template-variable rule, not a formatting choice, and it is why copy avoids multi-line layout.
- **`inbound_number` is the *sender*** in sent.dm's webhook payload, and `outbound_number` is our own line. The names read backwards. The sender is resolved authoritatively via `GET /v3/messages/{id}` with the payload as fallback.
- **The receipt is A5.** Every one is opened on a phone; A4 left a third of the page empty.
- **`apple-app-site-association`** is served by an explicit handler above the SPA wildcard because Apple's validator is strict about content type and redirects. Keep it above the fallback if you touch routing.
- **The delivery method is part of the price, so changing it voids the quote.** Collection is free and delivery carries the last-mile fee, and whichever was chosen is baked into `quote_kes` when the operator prices the order. A customer who switches afterwards gets the change recorded, staff get paged to re-quote, and the confirm branch refuses to bill the stale total — the same shape as the expired-quote guard beside it. Brian switched to delivery on a KSh 107,679 collection quote, was told "107,679 plus KSh 300" by the assistant, and paid 107,679: the fee was never charged and the parcel was routed to Hurlingham.
- **Choosing collection completes a signup.** The parcel comes to our counter, so there is no address to wait for: a name plus "I'll collect" earns the customer code. Holding the signup open for a street a collector was never going to give left the same customer unregistered through a quote and a confirmation.
- **`delivery_fee_pending` should be rare.** Since `0010` the last-mile fee rides on the quote, so only pre-`0010` orders and ones priced without a method land there. An order in that status with `delivery_fee_paid_at` set is a bug — the status is a claim about a debt.
- **`Number(null)` is `0`, and that has bitten this codebase three times** — on `markup_pct`, on `default_delivery_fee_kes`, and on `delivery_fee_kes`. Each would have quietly given money away. Absence is checked explicitly, never by falsiness, anywhere a number can be missing.
- **`looksLikeName()` is strict on purpose.** It refuses questions, digits, anything past five words and phrases opening the way requests do. A customer once replied "Can I first get the pricing and quotation ndio tujue details" and it became their name; they were addressed as "Can". A rejected real name costs one repeated question, an accepted sentence corrupts the record.
- **The assistant never says a quote is coming unless one is, and never states a figure it cannot point at.** Both are checked in code (`falseClaimIn()`), because the prompt said each of them three times and stopped neither.
- **Accepting a quote is a judgement, not a prefix match.** `isUnqualifiedConfirm()` requires a short, unqualified message — no question, no conjunction, at most three words — before a "yes" moves money state and fires a payment demand. The bare digit `1` used to match, so `"1.24kg"` accepted a live quote; `"okay confirm the price then I'll get back to you when i am ready"` did too.
- **The assistant says we deliver countrywide, but never names a Pickup Mtaani point.** The old rule forbade both, so the model filled the gap itself and told a customer about "a Pickup Mtaani point in Nakuru". The knowledge base now carries the true answer.
- **The assistant never names a Pickup Mtaani point.** It once told a customer we cover Hurlingham. That happened to be true, and nothing had checked. Which agent serves an area is the team's call, made against a list only they can see.
- **A 202 from sent.dm is not a delivery.** Three terminal statuses arrive only later, over the webhook: `FAILED`, `BLOCKED` (a precondition — unapproved template, no open conversation, account gate) and `FILTERED` (suppressed before any provider call — the contact is opted out, or routing denied the send). The send-time `ERR_*` code behind the last two is documented as absent from both the API response and the activity log, so `terminalStatusReason()` writes what the status can mean instead of leaving an operator with a bare "failed". A `FILTERED` row is never retried: it would be filtered again, and the retry's own 202 would erase the only line saying why the customer went quiet.
- **A customer who types only "CANCEL" is not cancelling an order — they are leaving.** `STOP`, `CANCEL`, `UNSUBSCRIBE`, `QUIT` and `END` are sent.dm's compliance keywords, matched on the whole trimmed body, and its consent engine flips `opt_out` on the contact — across every channel — before the event reaches us. Nothing we send afterwards is delivered until they reply `START`. Those messages are stored and then left unanswered: a bot reply would be filtered on the way out and sit in the transcript looking sent. Staff are paged instead, because a live order going silent is the actual event.
- **Every `template_map` slot is mapped, and a test enforces it.** An unmapped slot falls back to free text, which is refused outside the 24-hour window — silently, and precisely for arrival and dispatch, which land weeks after a customer last wrote in. That failure mode cost real customers their notifications twice before it was understood.

---

## 13. Tests

```bash
npm test                      # vitest; integration self-skips without TEST_DATABASE_URL
npm run check:drift:snapshot
npm run build
```

616 unit + smoke tests. The WhatsApp layer's behaviour lives in
`tests/unit/waStateMachine.test.js` (211 cases) — onboarding edges and
validation gates, empty messages, tracking-code formats for delivery and
collection, what counts as accepting a quote and what counts as saying
you have paid (each with the real customer message that got it wrong),
SHEIN cart requests, takeover and auto-resume, both AI sentinels,
answering "how do I pay?" from the order row, and that the reply survives
flattening. `waAiClassify` covers the sentinel boundary, the
quote-in-flight guard in both directions, unbacked money figures, the
facts block, and the turn builder that keeps an assistant-first or empty
message off the wire. `waOrderFlow` the transition edges, `orderStages`
the buttons the order screen offers, `waQuote` and `waDeliveryFeeSettle`
the arithmetic (both exist because `Number(null) === 0` quietly produced
a zero markup and a zero fee), `waTemplateVars` the positional variable
orderings, `sentdm` and `sentdmMedia` signature verification and inbound
media extraction, `fxRefresh` the staleness schedule, `receiptPdf`,
`receiptLink` and `mediaLink` the customer artefacts.

Nearly every case here pins a specific incident, and the comment above it
names the customer. Read that before changing what it asserts.

CI (`.github/workflows/ci.yml`) runs four jobs on every PR: unit +
client build, a Postgres-backed integration job that also gates
migrations and schema drift, a Playwright e2e pass over the operator
screens, and a Lighthouse accessibility assertion. `security.yml` runs
CodeQL `security-extended` on every code PR — and weekly, to catch
newly-disclosed CVEs in code nobody has touched. Together that is the
five checks a PR waits on.

**No test exercises a real model turn.** Every one of them stubs the
assistant, which is why two audits in a row have had to reason about its
behaviour from the outside, and why 576 green tests still shipped a guard
that escalated the customers closest to paying. A fixture suite of real
scenarios scored against the guardrails is the thing this repo is missing
most.

Both workflows were **disabled manually in May 2026** and only came back
on 2026-08-12. GitHub keys that state to the workflow's file path, which
is why they were renamed from `test.yml` / `codeql.yml` — a new path
registers a new, enabled workflow. Renaming them back would switch CI
off again.

---

## 14. Where to look next

- [`REBUILD.md`](./REBUILD.md) — what changed in the rebuild and why.
- [`API_REFERENCE.md`](./API_REFERENCE.md) — endpoint contracts (`routes/*.js` is authoritative).
- [`CUTOVER.md`](./CUTOVER.md) — deploy runbook.
- [`SECURITY.md`](./SECURITY.md) — disclosure policy + threat model.
- `database/MIGRATIONS.md` — how to add a migration safely.
- `sentdm-templates.json` — the 13 WhatsApp templates, ready to upload.

---

*Last updated 2026-08-12 (WhatsApp-first rebuild).*
