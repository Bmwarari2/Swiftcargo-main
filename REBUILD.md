# The WhatsApp-first rebuild

What changed, why, and what it means operationally. This document covers
the rebuild of Thapsus Cargo from a multi-portal logistics platform into
a WhatsApp-first parcel-forwarding service with a small operator
dashboard behind it.

Companion documents: [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the
system works now, [`API_REFERENCE.md`](./API_REFERENCE.md) for the
endpoint surface, [`CUTOVER.md`](./CUTOVER.md) for the deploy runbook.

---

## 1. Why

The platform had grown to roughly 39 routers, 250+ endpoints, 62 tables
and 55 SPA pages spanning a customer portal, an influencer programme, a
referral scheme, a clearing-agent portal, a rider portal, a finance
module, consolidation flows, a buy-for-me concierge product, a ticketing
system and two payment providers. Almost none of it was load-bearing for
the actual business, which is: someone in Kenya sends a link to a product
abroad, we buy it, we ship it, they pay by M-Pesa, we deliver it.

Customers were already doing that over WhatsApp. The rebuild makes
WhatsApp the product surface rather than a side channel, and reduces the
web app to the tool operators use to run the pipeline behind it.

**Net effect:** 348 files changed, +8,620 / −65,020 lines.

---

## 2. The customer journey, end to end

All four phases happen inside one WhatsApp conversation. The customer
never sees a login screen, and there is no customer-facing web account
any more.

### Phase 1 — Onboarding

A first message from an unknown number creates a `wa_contacts` row in
state `new`. **The first reply sells before it asks.** The assistant
opens with what we do and what we charge — the service fee, the minimum
order, the delivery time and any promotion running, all read from the
operator-maintained knowledge base — and closes by asking what they'd
like to do: send a product link, or ask a question. It does not ask for
a name or an address in that message.

Details are collected in the one window where the customer is already
waiting: after they send a product link. The assistant tells them the
team is pricing it, then asks for the first thing still missing —
full name, then Kenyan delivery address — explaining that it's so the
parcel can reach them once they accept the quote. Either can arrive
early, in any order; whatever a message contains is extracted from it.

When both are present the contact is issued a permanent **Customer
Code** (`TC-1042`, `TC-1043`, …) and moves to state `active`. Operators
are notified in the dashboard over SSE and on WhatsApp via the
staff-alert template.

**No M-Pesa number is asked for.** Signup used to hold people at a third
question — the number they would pay from — and it earned nothing:
payments are identified from the M-Pesa statement after the fact. The
column survives for the contacts that already have one (an STK push is
sent to it, falling back to their WhatsApp number) and an operator can
still type one in, but nothing asks and nothing waits on it.

A greeting is never accepted as a name, whatever the model extracted:
`looksLikeName` is enforced in `waStateMachine`, not in the prompt.

### Phase 2 — Quoting

The customer sends one or more product links. Any link in an inbound
message pages staff immediately — on WhatsApp via the staff-alert
template, and in the dashboard as a `wa_quote_request` SSE event that
raises a sticky toast in the inbox. That alert is load-bearing now that
the assistant's opening line invites a link: it promises a quote, and
only a person can send one.

An operator opens the conversation, creates an order, and enters the
item price in USD. The
server does the arithmetic — it never trusts a client-supplied total:

```
quoting_rate = round2(mid_USD_KES × (1 + fx_buffer_pct / 100))
quote_kes    = round(usd_price × quoting_rate × (1 + markup_pct / 100))
```

Customers who collect never enter dispatch. Their parcel goes
`in_kenya → collected` and stops, and the operator's only button is
"Mark as collected". The arrival message already told them where to
come, so marking it collected sends nothing.

The last-mile delivery fee is quoted with the order, not requested when
the parcel lands. Asking for a second payment two to three weeks after
the first is a second chance to lose the money, long after the customer
has stopped thinking about the order. `delivery_method` on the order
decides whether it applies — delivery pays
`wa_settings.default_delivery_fee_kes`, collection pays nothing — and
`delivery_fee_in_quote` records that `quote_kes` already contains it, so
arrival knows there is nothing to collect and the receipt can bill it as
its own line rather than folding it into the service margin.

Orders quoted before this change carry `delivery_fee_in_quote = false`
and a NULL fee. They keep the arrival-fee flow they were quoted under,
which is the only honest option: the customer agreed to a total that did
not include it.

`markup_pct` is chosen per order, defaulting to the settings value. It has
to be: the 10% service fee is a SHEIN charge, waived outright while the
SHEIN promotion runs, and the weight-based lanes (UK at £9/kg + £3
handling, Dubai at $9/kg) carry no percentage at all. A single global
markup added 10% to every one of those quotes, and printed "Service
margin: 10%" in the message as though it were intended.

The live rate comes from the `USD_KES` row that `utils/fxRefresh.js`
upserts daily from frankfurter.dev; `markup_pct` comes from
`wa_settings` and defaults to 10. All the inputs plus the result are
snapshotted onto the order row, so a rate move tomorrow can't retroactively
change what a customer was quoted today. The quote is sent to WhatsApp
with the breakdown shown.

**The rate quotes are priced at is not the mid-market rate.**
`exchange_rates.USD_KES` is frankfurter.dev's **mid** rate — the
midpoint of a spread nobody actually trades at. The business collects
KES and pays suppliers in GBP from the UK, so every order is a real
round trip costing 3–4 shillings on the cross. Quoting at mid handed
that away on all 18 quotes of the first month, which had also all run at
`markup_pct = 0` (the SHEIN promotion, and the weight-priced UK and
Dubai lanes carry no percentage), so nothing anywhere absorbed it.

`wa_settings.fx_buffer_pct` — default **2.5**, capped at 25 — lifts mid
to the rate a quote is priced at. It is deliberately **not**
`markup_pct`: the service margin is a price we promote and waive, while
the buffer is cost recovery and has to survive a promotion that zeroes
the margin. `utils/waQuote.js` `effectiveFxRate()` rounds the result to
2dp, the precision the quote message prints, so a customer who
multiplies the printed rate by the printed USD price lands on our total
to the shilling.

`wa_orders.fx_rate` therefore stores the **buffered** rate — what the
customer was quoted and what the receipt prints — and `fx_buffer_pct`
records how much of it was cushion, so the day's mid stays recoverable
from the pair. NULL means the order was quoted before the buffer
existed. Existing quotes were not repriced.

The customer sees a rate, never a buffer: the quote message prints
`Exchange rate: 1 USD = 132.58 KES` where 132.58 is ours, not a claim
about the interbank market. The operator sees both — the live KES
preview names the buffer and the day's mid underneath the total, so
nobody discounts a cost back out believing it was margin.

### Phase 3 — Payment and procurement

The customer replies `YES` (or `sawa`, `ndio`, `ok`, `haya`, `nimekubali`,
`sure`, …). That flips the order to `confirmed`, **opens an
`awaiting_review` payment row**, and sends Buy Goods till instructions.

Acceptance is a judgement, not a prefix match: `isUnqualifiedConfirm()`
wants a short message carrying no question and no conjunction. The
original rule matched the start of the message and included the bare
digit `1`, so `"1.24kg"` accepted a live quote and fired a payment
demand, and so did `"okay confirm the price then I'll get back to you
when i am ready"`. Erring toward a person costs one exchange; erring the
other way bills someone who was still deciding.

**Asking how to pay is also answered here, not by the assistant.**
`asksHowToPay()` plus `replyWithPaymentDetails()` reply from the order
row when exactly one thing is owing — the agreed total and the real till
for a `confirmed` order, the fee for one awaiting last-mile payment, and
for a quote not yet accepted the figure plus an invitation to reply YES,
without moving the money state. Several things owing at once goes to a
person, since one till figure would invite paying the wrong amount.

That path exists because the opposite was tried. A guardrail forbidding
the assistant from giving payment instructions at all stopped the
invented ones and the real ones together, and told it to say the details
were coming instead — so Marion, with KSh 17,746 confirmed, asked four
times, was reassured four times, and wrote "You haven't sent the details
aki". Nothing was going to send them: the till goes out when the customer
accepts a quote or an operator presses the button, and hers had been
confirmed by an operator hours earlier. A rule that forbids the right
answer is worse than no rule.

M-Pesa STK Push is not available: Lipana withdrew the service for
regulatory reasons, so production runs `MPESA_PROVIDER=manual`. Every
payment is a till transfer that a person verifies against the M-Pesa
statement. The code still contains the working Lipana STK path behind
that flag, so it can be turned back on if a provider becomes available.

When the customer says they've paid, the assistant does not improvise:
it replies that the payment is being verified, stamps the M-Pesa
reference onto their open payment row, and pages staff. An admin then
approves it from `/ops/payments` or the order screen. Approval is what
mints the **Tracking Code** (`TRK-8821`, …), sends it to the customer,
and generates the PDF receipt.

The operator buys the item abroad using `Name — TC-1042` as the shipping
address, so the parcel identifies itself on arrival.

### Phase 4 — Transit and delivery

Operators advance the order through `purchased → in_kenya → dispatched →
delivered`, each step firing its own WhatsApp message. Parcel labels are
printed from the order screen (100 × 150 mm thermal, Code128 barcode) and
can be scanned back with the camera scanner or a USB wedge.

Arrival in Kenya branches four ways, and each branch has its own
approved template because all four fire long after the customer's
24-hour window has shut:

| Order | Arrival message | Next |
| --- | --- | --- |
| Collection | `arrived_collect` — the office address and opening hours | `collected`, and the only button is **Mark as collected** |
| Delivery, fee already in the quote | `arrived_paid` — nothing owed | `dispatched → delivered` |
| Delivery, fee outstanding, promo waiving it | `arrived_waived` | `dispatched → delivered` |
| Delivery, fee outstanding | `arrived_fee` — the amount and how to pay | `delivery_fee_pending` until settled or waived |

Collection orders never enter dispatch. Marking one collected sends
nothing — the arrival message already told them where to come, and the
customer is standing at the counter when the button is pressed.

For **delivery** orders, staff can assign a Pickup Mtaani agent
(`wa_orders.pickup_point`) instead of a door drop, which changes the
dispatch message from "our rider will call you" to the named point. The
customer names an area; the assistant is forbidden from confirming an
agent, having once told a customer we cover Hurlingham and been right
only by luck. Which agent serves an area is the team's call, made
against a list only they can see.

At any point the customer can text their tracking code and get a live
status reply with no operator involved, worded for collection or
delivery as appropriate.

---

## 3. What was removed

Deleted outright — routers, utils, client pages, tests and dependencies:

| Area | What went |
| --- | --- |
| Finance | `routes/finance.js`, `utils/financeSync.js`, the whole finance dashboard |
| Influencer / referral | `influencer.js`, `influencerPortal.js`, `referral.js`, partner portal pages, visitor analytics |
| Clearing agent | `customs.js`, `agentInvoices.js`, `amlFlags.js`, the agent portal |
| Rider | `lastMile.js` and the rider portal |
| Consolidation | `consolidation.js`, `consolidationsV2.js`, `customerConsolidations.js` |
| Buy-for-me | `buyForMe.js` and its customer surfaces |
| Support | `tickets.js` |
| Compliance surfaces | `dsar.js`, `accountDeletion.js`, `nps.js`, `insurance.js` |
| Metrics | `kpi.js` |
| Pricing engine | `pricing.js`, `pricingTiers.js` and the six-knob model |
| Notifications | `push.js`, `notifications.js`, `webpush.js`, the PWA outbox |
| Payments | Stripe entirely — SDK, Elements, webhook, CSP entries |
| Dead trees | `client/src/_legacy/` (18.7k lines), `_legacy/`, archived migrations (4.6k) |

Customer self-registration and legacy order creation are **410-stubbed**
rather than deleted, so an old client gets an explicit "orders are placed
on WhatsApp now" instead of a confusing 404.

**No tables were dropped.** Retired tables are left in place, untouched.
Renaming or dropping them would break the drift tooling for no
operational gain, and in-flight legacy orders still read from them.

### Still mounted, deliberately

`routes/orders.js`, `parcels.js`, a trimmed `admin.js` and
`adminPayments.js` remain so operators can finish pre-WhatsApp orders.
The warehouse console (`/ops`) and the old admin dashboard (`/admin`)
were retired in August 2026 along with `routes/ops.js`; both URLs now
redirect, and user management plus error logs moved to `/ops/team`.
`/api/tracking/:code` checks `wa_orders.tracking_code` first and falls
back to legacy `orders.tracking_number`. These retire in a final cleanup
pass once the last legacy order is delivered — ask for "stage F cleanup".

---

## 4. What was added

### Schema — migrations `0004`–`0018`

All additive only, all applied to production.

| Table | Purpose |
| --- | --- |
| `wa_contacts` | One row per WhatsApp number: profile, `customer_code`, onboarding `state`, unread counters, conversation head, AI memory |
| `wa_messages` | Full transcript both directions, `provider_message_id` unique for inbound dedupe and delivery-status updates |
| `wa_orders` | The order: product links, quote snapshot (`usd_price`, `fx_rate` — the buffered rate — `markup_pct`, `fx_buffer_pct`, `quote_kes`), `order_code`, `tracking_code`, status, delivery fee, receipt path, per-status timestamps |
| `wa_order_events` | Append-only audit trail of every status move and who made it |
| `wa_settings` | Operator-editable key/value: markup, FX buffer, promo, default fee, quote validity, nudge switch, welcome media, template map, AI toggle + knowledge base, staff alert numbers |
| `wa_staff_alerts` | One row per staff page: phone, what it said, provider id, delivery status. Added because an unrecorded page cannot be seen failing |

Sequences `wa_customer_code_seq` (from 1042) and `wa_tracking_code_seq`
(from 8821) mint the public codes. `payments` was extended rather than
duplicated: `user_id` is now nullable, `wa_contact_id` was added, the
`target_kind` check accepts `'wa_order'`, and a CHECK enforces that a
payment belongs to either a user or a WhatsApp contact.

The later migrations are all small, and each one exists because
something went wrong in production:

| Migration | What it changed | Why |
| --- | --- | --- |
| `0005` | `wa_contacts.human_takeover_at`, `ai_summary`, `ai_summary_at` | Human takeover and durable AI memory |
| `0006` | Folded the archived 254Shippers database in | Same business, separate build — its people, orders, payments and conversations |
| `0007` | `wa_orders.supplier_ref` | The retailer's own order number, so "which of ours is this?" is answerable |
| `0008` | Dropped `awaiting_mpesa` from the onboarding state CHECK | Nothing asks for an M-Pesa number any more |
| `0009` | Cleared `delivery_fee_pending` on settled orders | Paying or waiving the fee left the status saying it was still owed |
| `0010` | `wa_orders.delivery_method`, `delivery_fee_in_quote` | The last-mile fee is quoted with the order |
| `0011` | `collected` status | Collection orders never enter dispatch |
| `0012` | `wa_orders.pickup_point` | The admin picks the Pickup Mtaani agent, not the customer |
| `0013` | `users.phone` nullable | Staff accounts are created from a name and an email |

Contacts that already had an M-Pesa number keep it — `0008` dropped only
the onboarding state, not the column.

### WhatsApp transport — `utils/sentdm.js`

sent.dm v3 client: send text, send template, fetch message and delivery
activities, verify inbound webhook signatures, manage the webhook
registration. Every provider assumption in the codebase lives in this one
file.

Two behaviours here were learned the hard way and are worth knowing:

- **Free text rides a system template.** WhatsApp forbids newlines, tabs
  and runs of four or more spaces inside template variables, so any
  multi-line body is rejected with `VALIDATION_008` and retried with the
  line breaks flattened into ` · ` separators. After the first rejection
  the client flattens up front rather than paying a wasted round-trip on
  every subsequent message. **All customer-facing copy is written to read
  correctly once flattened.**
- **Webhook payload semantics.** `inbound_number` is the external sender
  and `outbound_number` is our own line — the opposite of what the names
  suggest at a glance. The sender is resolved authoritatively via
  `GET /v3/messages/{id}`, with `inbound_number` as a fallback.

Signatures are Svix-style: `x-webhook-id`, `x-webhook-timestamp`,
`x-webhook-signature`, HMAC-SHA256 over `${id}.${ts}.${rawBody}`, with a
24h staleness bound (`SENTDM_WEBHOOK_TOLERANCE_SECONDS`) — sent.dm signs
once at creation and replays the same timestamp on every retry, so a
five-minute window rejects anything their queue delays. The webhook mounts before `express.json()` with the raw body
preserved, and ACKs before running bot replies so a slow reply can't
cause a provider retry.

### The dispatcher — `utils/waStateMachine.js`

Everything that happens on an inbound message, in strict order. Money and
state run **before** the AI is ever consulted and stay fully
deterministic:

0. **Empty message** — a sticker, a contact card, an unsupported
   attachment. Nothing to answer, so nothing is sent. One customer's
   empty message was read as their delivery address, failed validation,
   and got them asked the same question again.
1. **Human takeover check** — is the assistant paused on this chat?
2. **Product link** — pages staff on WhatsApp and raises a sticky toast
   in the inbox, whoever holds the thread
3. **SHEIN cart request** — a SHEIN link with no `shc=` cannot be
   quoted, so the cart link is asked for before an operator discovers it
4. **Onboarding** — anything not yet `active`
5. **Tracking auto-reply** — a `TRK-####` in the message
6. **Quote confirmation** — a yes-like reply against exactly one quoted order
7. **Payment claim** — "I've paid" or a pasted M-Pesa SMS
8. **AI fall-through** — everything else

Conversation state lives entirely on `wa_contacts.state`. There are no
in-memory sessions, so a deploy or restart never loses a customer
mid-signup.

### The assistant — `utils/waAi.js`

Claude (`claude-sonnet-5` via `@anthropic-ai/sdk`), hard-gated away from
money. It answers from
an operator-maintained knowledge base plus a live summary of that
customer's own orders, and it drives onboarding conversationally from the
very first message.

It is never allowed to work out a price, confirm an order or a payment,
promise a delivery date, or claim an action was taken — those paths run
before it. It may state what our own records already say: the status,
tracking code, agreed total and, when money is owing, the amount and the
till. The line is between reciting a figure from the order row and
inventing one, and `unbackedFigures()` holds it in code.

It has durable memory: a rolling summary of the conversation is
regenerated in the background every 8 messages, half the verbatim window,
so nothing falls into the gap between the two.

The model is pinned (`claude-sonnet-5`, overridable with
`ANTHROPIC_MODEL`) and short conversational turns run at `effort: low` —
this workload does not repay deep thinking, and latency is what customers
feel.

It ran on Opus 5 for the first day. The bill was measured rather than
guessed — ~3,000 input and ~450 output tokens across ~35 calls a day,
about $29 a month — and Sonnet does this job, which is knowledge-base
lookup rather than reasoning, for a third of that. Haiku 4.5 was
considered and rejected as a **non-drop-in**: it rejects
`output_config.effort` and has no adaptive thinking, so pinning it
without rewriting the request would 400 every turn.

The system prompt is now split so the ~2,700 tokens identical for every
customer (role, knowledge base, guardrails) form a cacheable prefix with
one explicit `cache_control` breakpoint at a 1-hour TTL, and the
per-customer tail follows it uncached. Explicit rather than automatic
because the prompt ends in per-customer content; 1-hour rather than the
5-minute default because turns arrive ~20 minutes apart. Only the block
order changed — the assembled prompt is the same length as before — and
the two orderings that existed for a reason are pinned by tests: checked
facts before the transcript, memory note below the guardrails. Together:
~$29/month → ~$7.

It ran on Gemini until 28 August, where the model name had to be
**discovered** from the ListModels API at runtime, ranked, cached for six
hours and re-resolved on a 404, because Google retires names on a rolling
basis and a stale default had already taken the assistant down in
production (`gemini-2.5-flash`). Anthropic model IDs are stable, so that
machinery went with the switch.

Every prompt crossed over byte for byte — which is what made the switch
look like a one-variable change, and is why the part that did not travel
went unnoticed. The prompts were never the risk; the **request** was.

`onboardingTurn` constrains its reply with a JSON Schema, and spelled the
optional `delivery_preference` as `type: ['string','null']` with an
`enum` beside it — legal JSON Schema, and what Gemini's `responseSchema`
had taken. Structured outputs rejects it with a 400 before a token is
generated:

```
output_config.format.schema: Invalid schema:
Enum value 'delivery' does not match declared type '['string', 'null']'
```

So **every onboarding turn failed from the swap until it was read out of
the Railway deploy logs**, and every new customer got the scripted
questionnaire instead. The supported spelling is `anyOf: [{type:
'string', enum: [...]}, {type: 'null'}]`.

626 tests were green throughout, and none of them could have caught it:
every AI test answers the HTTP call with a stub, so the schema was never
seen by the thing whose job is to reject schemas. `unsupportedSchemaBits()`
now checks it in code on the way out. The `/ops/settings` self-test also
reported healthy the whole time — it asks for the single word "OK" and
sends no schema at all.

Fixed alongside, as headroom rather than diagnosis: `max_tokens` bought
output on Gemini and buys thinking *plus* output here, and 1024 came
across untouched, which leaves a thinking-enabled turn no room to be
wrong in. It is now 4096, the self-test reports what the turn spent, and
`thinking` is stated in the request rather than inherited from a default
that differs per model.

**When the provider changes, re-read the request parameter by parameter
and ask what each one now means — then get one real call through before
calling it done.**

The assistant declines in two distinct ways, which matters more than it
sounds:

- **`HANDOFF`** — a person is needed. Complaints, refunds, a request for a
  human, or a question about our service it can't answer. Acknowledges the
  customer, hands the thread over, pages staff.
- **`OFF_TOPIC`** — nothing to do with this business. A wrong number, a
  general-knowledge question, a joke. Says what we do handle, at most once
  an hour per contact, and stops. No alert, no takeover, still live for
  their next real message.

Collapsing these into one outcome meant every stray text paged an
operator and muted the bot for two hours. Both entry points return a
tagged `{kind, text}` through a shared `classifyReply()`, so a control
sentinel can never be mistaken for a message and sent to a customer.

**It is told where the conversation stands; it does not infer it.**
`conversationFacts()` in the state machine looks it up per turn and
`renderFacts()` puts it into both prompts above the transcript, marked as
outranking the model's own reading of the chat — as a **single** line
about the quote, because the first version rendered "link received: YES"
directly above "NO quote is being prepared" and told the model to ask for
the link the customer had just sent.

A quote is in flight when **a link has arrived and nothing has been
quoted since** — not when an order sits at `quoting`. That first version
measured the wrong interval: 13 of 24 priced orders never occupied that
status at all, because the operator creates the order already priced, and
20 spent two minutes or less in it. TRK-8834 sent a cart link at 19:38
and was not opened until 19:43; for those five minutes the customer was
genuinely waiting and no row proved it. The customer's wait starts at the
link, which is the event they can see.

That gap cost a real conversation. A customer opened with "Hi", asked
how long delivery takes, then asked **"How do I pay?"** — no link sent,
no order anywhere — and was told "your quote is being worked out now and
will come through here shortly". Nothing was. They were left waiting on a
message nobody would send, and the payment question, which the knowledge
base answers in full, was never answered. The prompt's "tell them the
quote is coming" rule was written for the message *after* a link
arrives, and nothing told the model whether one ever had. A transcript
shows what was said; only the system knows what is true.

The prompt's steps now branch on those facts rather than assuming the
link arrived, and `claimsQuoteInFlight()` enforces it instead of hoping:
it matches a reply asserting our side is already pricing something,
while leaving the invitation the funnel depends on — "send your cart
link and we'll quote you" — alone. When the facts say nothing is in
flight, the turn is regenerated once with the false claim named; a
second offence degrades to `HANDOFF` so a person answers, and pages
staff either way — flagged `guardTripped`, so it pages **without** muting
the assistant for two hours, because that mute is for a customer who
asked for a human and not for our own output check failing.

The guard judges per sentence, and separates present from future.
Both lessons were paid for. Judging the whole reply at once flagged
"send us the link and we'll quote you within the hour" — the sales line
the funnel depends on. And grouping "is ready" with "is on its way"
meant Marion, holding an open quote at KSh 17,746, said "Heey", was
correctly told her quote was ready, and was handed to a colleague for it:
the guard fired on the customers closest to paying. A guard that fires
wrongly is worse than no guard.

Same reasoning as `looksLikeName()`: a promise that leaves a customer
waiting for a message nobody will send is too expensive to depend on the
model having a good day.

### Human takeover

When an operator replies — or the assistant hands off — the assistant
goes quiet on that conversation so the customer isn't answered by two
voices. It resumes by itself after `ai_resume_after_minutes` of silence
(default 120), or the moment an operator flips it back on from the inbox.
Deterministic replies keep working throughout; only the AI chat pauses.
The check runs ahead of everything else, so a handed-over signup silences
the questionnaire too.

### Staff alerts — `utils/waStaffAlert.js`

The approved `Staff_Alert` WhatsApp template, sent to the numbers in
`wa_settings.staff_alert_numbers`, with 5-minute deduplication. Fires on:
new customer onboarded, quote confirmed, payment claimed, and customer
needs a human. Never throws — a failed alert can't break a conversation.

### Payments — `utils/waPayments.js`

One rule: the moment a customer owes money, an `awaiting_review` payment
row exists for it. Get-or-create is shared by the quote-confirmation
path, the operator's "send till instructions" button and the "payment
received" action, so no two of them can create duplicate rows.

Approval runs through the same `markPaymentPaid` state machine the legacy
flow uses, which mints the tracking code inside the same transaction that
flips the order to paid, then sends the code and the receipt post-commit.

### Receipts and labels

`utils/receiptPdf.js` renders an A5 invoice-style receipt with pdfkit —
brand rail, receipt number, PAID stamp, billed-to and order columns, an
itemised table splitting goods from service using the quote snapshot,
totals, and a delivery progress strip. A5 rather than A4 because every
one of these is opened on a phone from a WhatsApp link.

It is stored in the private Supabase Storage bucket `receipts` and
delivered as a **short link**: `https://thapsus.uk/r/TRK-8821.<sig>`.
`utils/receiptLink.js` mints a stateless token — tracking code plus a
truncated HMAC over the order id, keyed on `JWT_SECRET` — and
`GET /r/:token` verifies it and redirects to a freshly signed 10-minute
URL. Because it re-signs on each click the link never expires, which the
old 7-day signed URL did. Nothing is stored, so there was no migration.

Inbox attachments take the same route. `utils/mediaLink.js` mints a
`/m/<token>` link over the private `wa-media` bucket, and
`routes/mediaRedirect.js` re-signs it on each click. Inbound media is a
separate problem: sent.dm does not put the file on the hydrated message,
so `extractInboundMedia()` looks through the raw webhook envelope as
well, checking a list of known keys before falling back to a bounded
deep scan for anything that looks like a media URL.

`PrintableParcelLabel.jsx` follows the standard shipping-label
convention: ruled outer box, a boxed TO: block sized to be read at arm's
length, a two-column code grid, and a Code128 barcode across the bottom
with its digits printed underneath. Pure black on white — thermal
printers have no greys.

### Operator dashboard

Five screens under `/ops`, all behind the operator role:

| Screen | What it does |
| --- | --- |
| `/ops/inbox` | Unified WhatsApp inbox — conversations, unread badges, live SSE, composer with media upload, per-chat AI toggle, "create order from link" |
| `/ops/pipeline` | Five-column board (Quoting / Paid / Purchased / In Kenya / Delivered), global `TC-`/`TRK-` search, camera scanner |
| `/ops/orders/:id` | Quote entry with live KES preview, delivery method, pickup-point picker, payment actions, status advance, fee settle/waive, receipt, printable label |
| `/ops/payments` | Manual M-Pesa approval queue (admin) — the pipeline's real bottleneck, so it gets its own screen and nav item |
| `/ops/settings` | Markup, FX buffer, promo toggle, default fee, welcome media, template map, AI toggle + knowledge base, staff alert numbers, webhook doctor (admin) |
| `/ops/team` | Staff accounts and recent server errors (admin) — what survived the old admin dashboard. New accounts are created with a temporary password shown once on screen; no email is sent |

The public site keeps the home page, public tracking, FAQ, articles,
legal pages and operator login. Everything else is gone.

---

## 5. Behaviour decisions worth knowing

These are the calls that aren't obvious from reading the code, recorded
so they don't get "fixed" by accident.

**No emojis anywhere a customer can see.** Removed from the state
machine, the pipeline alerts, the quote and till instructions, the PDF
receipt, all eleven templates and the homepage WhatsApp prefill. The
assistant's guardrails forbid them too, so the model can't reintroduce
what the templates dropped. Operator dashboard chrome keeps its icons.

**A tracking code gets the parcel's current state, in plain words.** Not
a status label plus a progress bar plus a next-step line plus the amount
paid — that restated the same fact three times and buried it, and
flattening turned it into a smear. Each status owns its own wording:

```
TRK-8822 — your item was purchased on 12 August and is on its way to our
facility. We'll message you as soon as it lands in Kenya.
```

**Only unambiguous cases are automated.** A yes-like reply confirms a
quote only when the contact has *exactly one* order awaiting
confirmation. Zero or several, and it goes to a human.

**Last-mile delivery is 24 hours**, not "1–2 business days".

**Payment claims never reach the AI.** "I have paid" used to fall through
to the assistant, which read it as a complaint and replied "let me get a
colleague" — the worst possible answer to someone who has just sent
money. It's now handled deterministically, with the reassurance sent at
most once per 30 minutes so a two-message burst doesn't double-reply.

**The payment-claim matcher is deliberately narrow.** It does not match
bare `sent` or `lipa`, which fired on "I sent the link" and on our own
"Lipa na M-Pesa" instructions quoted back at us. A false positive here
silences the assistant.

---

## 6. Operational notes

### Environment

New variables: `SENTDM_API_KEY`, `SENTDM_WEBHOOK_SECRET`,
`SENTDM_BASE_URL` (optional), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
(optional — leave unset to let discovery run), `MPESA_PROVIDER=manual`,
`MPESA_TILL_NUMBER`.

`SITE_URL` must be the apex domain the app actually serves — receipt
links are built from it. A leading `www.` is stripped automatically
because that host is not served, which is what broke the original
webhook registration.

Dead variables to remove are listed in [`CUTOVER.md`](./CUTOVER.md) §5.

### Supabase Storage

Two **private** buckets must exist: `receipts` and `wa-media`. Receipts
are written to `receipts/<orderId>/<paymentId>.pdf` with upsert, so a
retry overwrites rather than duplicating; inbox attachments go to
`wa-media`. Neither is publicly readable — both are served through the
re-signing short links (`/r/`, `/m/`).

Storage is not reachable from SQL. Erasing a customer's data means
deleting their objects through the Storage API separately; a `DELETE`
against `storage.objects` is refused by Supabase and rolls the whole
transaction back.

### WhatsApp templates

Free-form replies work inside WhatsApp's 24-hour customer-service window,
which covers every reply to a customer message. Business-initiated
messages outside that window need approved templates — and arrival,
dispatch and receipt land two to three weeks after the customer last
wrote in, so their window is always shut.

All eleven slots are mapped, so nothing the code can send falls back to
free text. Six were approved from `sentdm-templates.json` under `tc_`
names; the other five keep the names they were approved under before
that manifest existed. `tc_arrived_waived` was classified MARKETING by
Meta and can be refused for anyone opted out of marketing — it only
fires when the promo toggle waives the delivery fee. The full map and
the reasoning are in [`CUTOVER.md`](./CUTOVER.md) §5.

A stored map is merged **over** the defaults per key, never swapped in
for them. Production once held a four-key map, and a wholesale replace
made the other seven resolve to nothing — every one of those sends went
out as free text and was refused. To disable a slot deliberately, map it
to an empty string.

### Verification

Every change runs `npm test`, `npm run check:drift -- --snapshot` and
`npm run build`. The WhatsApp layer is covered by unit tests for the
state machine (79 cases: onboarding edges, empty messages, tracking
formats for both delivery and collection, confirmation ambiguity,
payment claims, SHEIN cart requests, takeover and resume, both AI
sentinels), the sentinel classifier, order flow transitions, code
minting, quote and delivery-fee arithmetic, fee settlement, sent.dm
signature verification and inbound media extraction, receipt rendering,
receipt and media short links, the template-variable orderings, and the
WhatsApp text formatter. Integration suites cover order creation and
staff-account creation end to end, and an `appBoot` test pins the `/r/`
and `/m/` routes above the SPA fallback.

### Known limitation

sent.dm cannot currently deliver to UK numbers — messages are accepted
and then fail downstream. This is a sender-routing restriction on their
side, not a code bug. Kenyan numbers deliver normally.

---

## 7. Change log

Commits are on `claude/thapsus-cargo-simplify-jl983m`, oldest first.

| Stage | Commits | What |
| --- | --- | --- |
| A | `9827d65` | Delete dead code — legacy trees, archived migrations, stale docs (~27k lines) |
| B | `0ebc921`, `84e7283` | Remove dropped modules; drop unused deps and env surface |
| C | `4f261b4`, `524f34a`, `55fee26`, `831ad4d` | Migration 0004; sent.dm client, webhook, state machine; orders, quoting, payments, receipts, inbox, settings |
| D | `7432dd8` | WhatsApp-first operator dashboard + public site rework |
| E | `db35326`, `ccba36a` | Cutover: retire self-registration, close legacy intake, webhook registrar + runbook |
| Live fixes | `fa92b8c`, `a2a51d7`, `a86cee8`, `32cf058`, `b178efc`, `26f7fc4`, `57cfcc0` | Inbound ingestion, sender resolution, webhook doctor, free-text template rules, template pack |
| AI | `0eeb0d0`, `d337ac1`, `f131e20`, `59ac2ed` | The assistant; AI-first onboarding; live order context. Ran on Gemini until 28 August, then moved to Claude — prompts unchanged, and the runtime model discovery Google's rolling retirements forced was deleted with it |
| Ops reality | `b45cf55`, `862dd9b` | Manual payments + staff alerts; handoff acknowledgement, takeover, AI memory |
| Polish | `624cc3a`, `006a590`, `7888a8c`, `a1ef0e3` | Payment verification reply + approval path; no emojis, short receipt links, 24h delivery; structured tracking reply, label and receipt redesign; OFF_TOPIC vs HANDOFF |

Merged to `main` since; later work is on `main` directly and grouped by
theme rather than by commit:

| Theme | What |
| --- | --- |
| Sales-first opening | The assistant leads with what we do and what we charge, invites a product link, and asks for the name and address only while the customer is waiting on a quote. M-Pesa collection dropped (`0008`) |
| Per-order markup | `markup_pct` moved onto the order — the 10% is a SHEIN service fee, and the weight-based UK and Dubai lanes carry none |
| FX buffer | `fx_buffer_pct` lifts the mid-market rate to one we can transact at. Separate from the margin because the margin gets waived and this must not |
| The assistant is told the conversation's state | `conversationFacts()` looks up whether a link ever arrived and whether an order is open, rather than letting the model infer it from the transcript |
| Delivery fee up front | Quoted with the order rather than requested on arrival (`0010`); `delivery_fee_in_quote` keeps older orders on the flow they were quoted under |
| Collection orders | `collected` status (`0011`) — collection skips dispatch and delivery entirely |
| Pickup Mtaani | `wa_orders.pickup_point` (`0012`), assigned by staff from the agent list; the assistant may recommend an area but never confirms an agent |
| Template map | Every slot mapped, and a stored map now merges over the defaults instead of replacing them — the bug that silently dropped seven templates |
| Inbox media | `/m/` short links over the `wa-media` bucket, inbound media pulled from the raw webhook envelope, and a WhatsApp-markup renderer so `*bold*` stops showing as asterisks |
| Staff accounts | Created from a name and an email with a temporary password shown once; no invitation email, phone optional (`0013`) |
| SHEIN carts | A SHEIN product link is answered with a request for the cart link, deterministically, ahead of the AI |
| sent.dm, against the published v3 reference | The provider layer re-checked line by line against docs.sent.dm. `FILTERED` and `SCHEDULED` were being dropped on the floor: a message suppressed by the consent gate stayed on 'queued' and paged nobody. Compliance keywords (`STOP`, `CANCEL`, `END` …) opt a contact out of every channel, so those inbounds are stored but not answered, and staff are paged. Failure reasons now come from `events[]`, where the API actually puts them, and 429/409/503 are retried under a capped wait — never an unkeyed mutation |
| Alerts that reach somebody | A page's fate is now a fact, not a hope: `batch_id` groups the sends of one page so "did ANY number get it?" is a query, `rescued_at` claims the fallback, and the sweeper re-sends a page nobody received by email and reports a number that has stopped receiving to the colleague whose phone still works (`0020`). The failure reason comes from `/activities` — the endpoint that has one — because `GET /v3/messages/{id}` carries no history and every failure for three days read "no reason given" |
| A promise with a deadline | `conversationFacts()` stops calling a quote "on its way" once the customer has been waiting past `WA_QUOTE_PROMISE_MINUTES`, and the sweeper pages a person for a link that has gone unquoted. The old fact was true for as long as nobody priced the link, so a lost staff page turned into eighteen hours of "shortly" |
| Every order has a number | `wa_orders.order_code` — `ORD-3001` from a column default (`0021`), so no creation path can forget one. An order had no name of its own until payment: the quote and the payment prompt called it `#` plus eight characters of its uuid, which no customer reads back to us and no operator can search for. The order number names the order for its whole life, `tracking_code` still names the parcel. The inbound status lookup answers ORD codes too, scoped to the contact who sent them — which made the pre-payment wording reachable, and it no longer tells a customer holding a quote that their quote is being finalised |
