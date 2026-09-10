// utils/waStateMachine.js
//
// Decides what happens when a WhatsApp message arrives from a customer.
// Called by routes/waWebhook.js AFTER the inbound row is persisted and the
// inbox counters/SSE are updated — this module only produces side effects
// (bot replies, state transitions, operator alerts).
//
// Dispatch order:
//   0. Empty message — a sticker, a contact card, an unsupported
//      attachment. Nothing to answer, so nothing is sent; the inbox
//      already has it with the badge raised.
//   1. Onboarding — contact not yet 'active'. Leads with what we do and
//      what we charge, then invites a product link; the name and delivery
//      address are asked for while the customer is already waiting on a
//      quote, which is the only moment those questions cost nothing.
//      Name + address mints the Customer Code. No M-Pesa number is
//      collected — payments are identified from the M-Pesa statement.
//   1b. Product link — pages staff on WhatsApp and raises a sticky
//      toast in the inbox, whoever holds the thread. Only a person can
//      send a quote, and an unnoticed quote request is the most
//      expensive thing this system can drop.
//   1c. SHEIN product link with no cart — asks for the cart link
//      instead. A product link often won't open on our side and never
//      shows the size or colour picked. Said once per 30 minutes, and
//      not at all while a human holds the thread.
//   2. Tracking auto-reply — an 'active' contact texting a TRK-#### code
//      gets the order's live status back, no operator needed (Phase 4
//      self-service). Collection orders get collection wording — they
//      never enter dispatch.
//   3. Payment claim — "I've paid" / a pasted M-Pesa SMS gets an
//      it's-being-verified reply (never a handoff), the reference stamped
//      onto the open payment, and a staff alert. Runs BEFORE the
//      confirmation branch because "ok, I have paid" opens with a
//      confirm word. When nothing is open and the latest order is
//      settled, the reply is the parcel's live status instead.
//   3b. Quote confirmation — a "yes"-like reply while the contact has
//      exactly one order awaiting confirmation flips it to 'confirmed',
//      opens the awaiting_review payment row, and sends till
//      instructions. Anything ambiguous falls through to a human.
//   4. Everything else: when the Gemini layer is enabled (wa_settings
//      ai_enabled + ANTHROPIC_API_KEY), it answers from the operator's
//      knowledge base PLUS a live summary of this customer's own orders
//      (loadOrderContext), so "where is my parcel?" works without an
//      exact code. It can also decline in two distinct ways:
//        HANDOFF   → a person is needed (complaint, refund, a question
//                    about our service we can't answer): acknowledge,
//                    hand the thread over, page staff.
//        OFF_TOPIC → nothing to do with us (wrong number, general
//                    knowledge, jokes): say what we do, once an hour,
//                    and leave the assistant live. No alert, no takeover.
//      On any AI failure the message just sits in the operator inbox
//      (the webhook already bumped unread + SSE before calling us).
//
// The AI is consulted ONLY for onboarding interpretation and the final
// fall-through. Money and state (tracking replies, confirmations, quotes,
// payments, pipeline moves) run BEFORE it and stay fully deterministic.
//
// Human takeover: while wa_contacts.human_takeover_at is set (an operator
// replied, or the assistant handed off) the AI stays quiet. It clears
// itself after ai_resume_after_minutes of silence, or when an operator
// re-enables it for that chat from the inbox.
//
// State lives entirely on wa_contacts.state — no in-memory sessions, so
// deploys/restarts never lose a customer mid-onboarding.

import { sendToContact } from './waSend.js';
import { extractTrackingCode, extractOrderCode, nextCustomerCode } from './waCodes.js';
import { pushToStaff } from '../routes/events.js';
import { getWaSettings } from './waSettings.js';
import { aiConfigured, chatReply, onboardingTurn, renderFacts, summarizeConversation } from './waAi.js';
import { notifyStaff } from './waStaffAlert.js';
import {
  attachMpesaReference, ensureManualPayment, extractMpesaReference,
  findOpenContactPayment, mpesaTill,
} from './waPayments.js';

// "accept" is here because the approved quote template tells the customer
// "Reply to accept" — a customer following that instruction literally must
// land in this branch, not fall through to the AI.
//
// Matching this is not on its own consent: see isUnqualifiedConfirm.
const CONFIRM_WORDS =
  /^(yes+|yeah|yep|ok(ay)?|sure|fine|confirm(ed)?|accept(ed)?|proceed|go ahead|sawa( ?sawa)?|haya|ndio|ndiyo|nakubali|nimekubali|ni sawa|niko sawa|poa|twende)\b/i;

// A conjunction or a condition means the message is doing something other
// than agreeing. "Okay so this is the final price, no added costs?" and
// "Okay I'll send the link by tonight" both open with a confirm word and
// neither is a yes.
const QUALIFIER =
  /[?¿]|\b(but|however|though|although|first|before|after|once|when|if|unless|instead|also|and|then|so|lakini|kwanza|halafu|kabla|nikipata|nitakuambia|later|tonight|tomorrow|kesho)\b/i;
// Three, not four. "yes its a macbook" is four words, carries no
// question and no conjunction, and is a customer answering "what is it?"
// — not accepting a price. Real acceptances are almost always one or two
// words ("Yes", "Sawa sawa", "Go ahead"); a longer one costs an extra
// exchange, and erring the other way bills someone still deciding.
const MAX_CONFIRM_WORDS = 3;

/**
 * Is this message a plain, unqualified acceptance of the open quote?
 *
 * Accepting a quote moves money state and fires a payment demand, so it
 * is a judgement, not a prefix match. The old rule matched the start of
 * the message and nothing else, which meant "1.24kg" (the bare digit 1),
 * "yes its a macbook", and "okay confirm the price then I'll get back to
 * you when i am ready" all accepted a live quote. The bare 1 is gone —
 * a weight, a quantity or a shoe size is not consent — and anything
 * carrying a question, a condition or more than four words now goes to a
 * person instead.
 *
 * Erring toward the AI costs one extra exchange. Erring the other way
 * bills someone who was still deciding.
 */
export function isUnqualifiedConfirm(value) {
  const v = String(value || '').trim();
  if (!v || !CONFIRM_WORDS.test(v)) return false;
  if (QUALIFIER.test(v)) return false;
  return v.split(/\s+/).filter(Boolean).length <= MAX_CONFIRM_WORDS;
}

// "I've paid" in the shapes Kenyan customers actually type, including a
// pasted M-Pesa confirmation (which always carries a 10-char reference).
// Deliberately narrower than "sent"/"lipa" on their own — those show up in
// "I sent the link" and in our own "Lipa na M-Pesa" instructions quoted
// back at us, and a false positive here silences the assistant.
const PAID_CLAIM =
  /\bpaid\b|\bnime(sha)?lipa\b|\bnimelipia\b|\bnishalipa\b|\bnimemaliza kulipa\b|\bnimefanya payment\b|\bnimetuma\b|\bnimesend\b|\bpayment (sent|made|done|complete)\b|\bsent (the |you )?(money|payment|cash|funds)\b|\bconfirmed\b[\s\S]{0,80}\bksh/i;

/**
 * Did the customer say they HAVE paid, rather than ask about paying?
 *
 * "When is payment done?" and "can I try again at the end of the month
 * once I get paid?" both matched the pattern above and were both answered
 * "Asante. We've got your payment notification and our team is verifying
 * it with M-Pesa now" — plus a staff page. The second was a lead telling
 * us they would buy next month, answered as a transaction.
 *
 * A question with no M-Pesa reference in it is a question. A pasted
 * confirmation always carries the 10-character reference, so the
 * exception costs nothing.
 */
export function claimsPaid(value, ref) {
  const v = String(value || '').trim();
  if (!PAID_CLAIM.test(v)) return false;
  // A pasted M-Pesa confirmation always carries the 10-character
  // reference, and nobody pastes one to ask a question.
  if (ref) return true;
  // An interrogative OPENER, not merely a question mark: "I have paid,
  // any update?" is a claim that happens to end in one, while "When is
  // payment done?" is an enquiry that was being answered "Asante. We've
  // got your payment notification and our team is verifying it now."
  if (/^\s*(how|when|where|what|which|why|can|could|do|does|did|is|are|was|will|would|should|kwani|vipi|lini|naweza|je)\b/i.test(v)) return false;
  // "...once I get paid" is a customer telling us they will buy next
  // month. It was answered as a transaction, and paged a person.
  if (/\b(get|gets|getting|got|be|been|am|are|is)\s+paid\b/i.test(v) && !/\bhave\s+paid\b/i.test(v)) return false;
  return true;
}

// A product link is now the whole point of the first conversation — the
// assistant opens by inviting one, and everything after it (the quote,
// the order, the money) is a person's job. Nothing was watching for it:
// a link landed in the inbox and waited for somebody to look. This is
// the pattern that says "there is a URL in here", kept deliberately
// dumb — any link a customer sends us is worth a person's attention,
// and a false positive costs one alert.
// Bare `something.com` used to count, which meant every e-mail address
// collected at signup ("kibugicharles128@gmail.com") paged staff with
// "Product link received — quote needed" and, worse, set linkReceived
// true forever for that contact. A scheme or a www. is now required, and
// an @ anywhere before the host disqualifies it.
// A scheme, a www., or a bare host WITH A PATH — "next.co.uk/p/123" is a
// link a customer really does paste; "gmail.com" on its own never is.
// The lookbehind kills the local-part-then-@ case outright.
export const PRODUCT_LINK = new RegExp(
  '(?<![\\w@.])(?:'
  + 'https?:\\/\\/\\S+'
  + '|www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)+\\S*'
  + '|[a-z0-9-]+(?:\\.[a-z0-9-]+)+\\/\\S+'
  + ')', 'i');

// SHEIN links come in two shapes and only one of them is usable.
//
//   cart    onelink.shein.com/49/5zw9b7anck7k?shc=2_RwLdztAJWDF
//   product m.shein.com/Lenovo-EA400-Bluetooth-Earphones-...-p-12345.html
//
// A shared cart carries `shc=` and opens for us with every item, size and
// colour on it. A product page frequently will not open on our side at
// all, and never says which size or colour the customer picked. Byrone
// sent product links; an operator spent eleven minutes and two rounds
// getting to a cart before anything could be quoted.
const SHEIN_LINK = /\bhttps?:\/\/[^\s]*shein\.com\/[^\s]*/gi;
const SHEIN_CART = /[?&]shc=/i;

// Said once per burst — customers often paste three product links in a
// row, and three identical corrections is worse than the problem.
const CART_REQUEST_MARKER = 'share the cart from there';

/**
 * Is this a SHEIN order that cannot be quoted as sent — one or more
 * product links and no cart among them?
 */
export function needsSheinCart(body) {
  const links = String(body || '').match(SHEIN_LINK);
  if (!links || links.length === 0) return false;
  return !links.some((l) => SHEIN_CART.test(l));
}

// Stable phrases inside two of our own replies — also how we recognise
// that we already sent one recently (template_key isn't recorded for
// free text, so the transcript body is what we have to match on).
const VERIFYING_MARKER = 'verifying it with M-Pesa';
const OFF_TOPIC_MARKER = 'only help with Thapsus Cargo';
const HANDOFF_MARKER = 'get a colleague for you';
const HANDOFF_REPLY = `Let me ${HANDOFF_MARKER} — someone from our team will reply here shortly.`;

// Asking for a person, in the shapes customers actually type. The person
// words are listed explicitly: "can I speak to you about sizes?" is a
// question for the assistant, not an escalation.
const ASKS_FOR_HUMAN =
  /\b(?:talk|speak|chat|connect|transfer|put|get|link|refer|ongea|kuongea|niunganishe|unganisha)\b[^?!.]{0,24}?\b(?:to|with|from|na)\s+(?:a|an|the|any|some)?\s*(?:real\s+|actual\s+|live\s+|proper\s+)?(?:human|person|people|someone|somebody|agent|representative|operator|staff|mtu|admin|manager)\b/i;
// The escalation said as a noun rather than a request — "human support",
// "customer care" — which is how Diane wrote it.
const NAMES_HUMAN_SUPPORT =
  /\b(?:human|live|real)\s+(?:support|agent|help|assistance|person|being)\b|\bcustomer\s+(?:care|service)\b|\b(?:is|are)\s+there\s+(?:a|an|any)\s+(?:real\s+)?(?:human|person|agent)\b/i;
// The whole message is the word. Common enough to be worth catching, and
// only safe as an exact match: "agent" appears inside plenty of sentences
// that are not asking for one.
const BARE_HUMAN_REQUEST = /^\s*(?:human|agent|operator|customer\s+care|mtu)\s*[!.?]*$/i;
// Someone else's person. "Let me talk to my agent in Dubai" matches the
// first pattern and is not a request for us.
const SOMEONE_ELSES_PERSON =
  /\b(?:my|your|his|her|their|our|the\s+seller'?s?)\s+(?:agent|person|manager|admin|staff|mtu)\b/i;

/**
 * Did the customer ask for a human being?
 *
 * This is a rule cheap enough to enforce in code, and until now it lived
 * only in the assistant's prompt — which meant it was not enforced at all
 * whenever the assistant was not consulted. Diane Mworia wrote
 * "Requesting human support please" at 10:15 on 4 September into a thread
 * a handoff had muted the assistant on 44 minutes earlier. The AI branch
 * is skipped while a human holds the thread, so nothing ran: no reply, no
 * page, no takeover — the clearest possible request for a person was the
 * quietest event in the system, and the only thing that would ever have
 * noticed was the 15-minute unanswered sweeper.
 *
 * Both directions are tested. A guard that fires wrongly here escalates
 * customers who were talking about somebody else entirely.
 */
export function wantsHuman(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (SOMEONE_ELSES_PERSON.test(v)) return false;
  return BARE_HUMAN_REQUEST.test(v) || NAMES_HUMAN_SUPPORT.test(v) || ASKS_FOR_HUMAN.test(v);
}

// How much verbatim transcript rides in the prompt, and how often the
// durable memory note behind it gets refreshed.
const HISTORY_WINDOW = 30;
// How far back a product link still means "they are waiting on a quote".
// The fact was previously read off the last 60 inbound messages with no
// time bound at all, so a customer whose order was delivered in July was
// still flagged as waiting in September.
const LINK_MEMORY_DAYS = 14;
const SUMMARY_EVERY_MESSAGES = 8;

const STATUS_LABEL = {
  quoting: 'Being quoted',
  quoted: 'Quote sent — awaiting your confirmation',
  confirmed: 'Confirmed — awaiting payment',
  paid: 'Paid — purchase in progress',
  purchased: 'Purchased — on its way to our facility',
  in_kenya: 'Arrived in Kenya',
  delivery_fee_pending: 'Arrived in Kenya — delivery fee pending',
  dispatched: 'Out for delivery',
  delivered: 'Delivered',
  collected: 'Collected',
  cancelled: 'Cancelled',
};

/**
 * @param {pg.Pool} db
 * @param {object} contact  fresh wa_contacts row
 * @param {{id: string, body: string|null, mediaUrl: string|null}} message
 */
export async function handleInbound(db, contact, message) {
  if (contact.state === 'blocked') return;

  const body = (message.body || '').trim();

  // Nothing to answer. A sticker, a contact card, an unsupported
  // attachment — anything the provider hands us with no text arrives
  // here as an empty body, and answering it treats silence as a reply.
  // One customer's empty message was read as their delivery address,
  // failed validation, and got them asked the same question again. The
  // message is already in the inbox with the badge raised; a person can
  // see it and decide whether it meant anything.
  if (!body && !message.mediaUrl) return;

  let settings = null;
  try { settings = await getWaSettings(db); } catch { /* run without AI */ }
  const ai = Boolean(settings?.ai_enabled) && aiConfigured();

  // 1. Human takeover, evaluated before anything else so it applies to
  // onboarding too — the assistant can hand a signup over (a complaint
  // arrives mid-questionnaire) and must then stay quiet like anywhere
  // else. Deterministic replies (tracking codes, quote confirmations)
  // keep working throughout; only the AI chat pauses.
  const aiPaused = await aiOnHold(db, contact, message, settings);

  // 1b. A link means somebody wants a quote, and only a person can give
  // one. Page staff before any of the branching below, so it reaches
  // them whether the sender is a stranger mid-signup or a regular, and
  // whether the AI or an operator is holding the thread. The unread
  // badge in the inbox was the only signal until now, and an unnoticed
  // quote request is the most expensive thing this system can drop.
  const wantsCart = body ? needsSheinCart(body) : false;
  if (body && PRODUCT_LINK.test(body)) {
    notifyStaff(db, {
      title: wantsCart
        ? 'SHEIN product link — cart requested, no action yet'
        : 'Product link received — quote needed',
      detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code yet'}): "${body.slice(0, 200)}"`,
      dedupeKey: `link:${contact.id}:${body.slice(0, 80)}`,
    });
    pushToStaff('wa_quote_request', {
      contact_id: contact.id,
      customer_code: contact.customer_code || null,
      full_name: contact.full_name || null,
      phone: contact.phone,
      preview: body.slice(0, 200),
    });
  }

  // 1c. A SHEIN product link cannot be quoted, so ask for the cart now
  // rather than letting an operator discover it later. Deterministic and
  // ahead of the AI, for the same reason money and state are: it is a
  // fact about what we can open, not a judgement call.
  //
  // Skipped while a human has the thread — they can see the link and may
  // already be typing — and said once per burst, because three product
  // links in a row should not earn three identical corrections.
  if (wantsCart && !aiPaused && !await sentRecently(db, contact.id, CART_REQUEST_MARKER, 30)) {
    await sendToContact(db, contact, {
      text:
        `Thanks! To quote SHEIN we need your *cart* link rather than links to `
        + `individual items — a product link often won't open on our side, and it `
        + `doesn't show us the size or colour you picked.\n\n`
        + `Add everything you want to your SHEIN cart, then tap the three dots at `
        + `the top right of the cart and ${CART_REQUEST_MARKER}. One link and we'll `
        + `send your quote.`,
    });
    return;
  }

  // 1d. A change of delivery method after a quote is a change of PRICE.
  // Collection is free and delivery carries the last-mile fee, and
  // whichever was chosen is baked into quote_kes when the operator
  // prices the order — so the old number is simply wrong once they
  // switch. Brian asked to switch to delivery at 21:54 against a KSh
  // 107,679 collection quote; the assistant answered "plus KSh 300", the
  // confirm branch below then took quote_kes at face value, and he paid
  // 107,679 with the fee never charged and the parcel headed to
  // Hurlingham. Money, so it resolves here rather than in a prompt —
  // and BEFORE the onboarding split, because he was still being
  // onboarded when he asked.
  const wantedMethod = body ? saysDeliveryMethod(body) : null;
  if (wantedMethod && await handleDeliveryMethodSwitch(db, contact, wantedMethod, { aiPaused })) {
    return;
  }

  // 1e. Asking for a person is not a judgement call, so it does not wait
  // on the model — and above all it does not wait on the model being
  // consulted at all. See wantsHuman(): the request that reached nobody
  // arrived while the assistant was muted, which is precisely when a
  // customer is most likely to ask again. The page fires either way;
  // that is the whole point of moving this out of the prompt.
  //
  // The deterministic money paths still win where they run, because they
  // page a person too AND stamp the reference or answer the code: "I have
  // paid, can I speak to someone" must not lose the M-Pesa reference.
  const moneyPathAnswers = contact.state === 'active' && body
    && (Boolean(extractTrackingCode(body)) || claimsPaid(body, extractMpesaReference(body)));
  if (body && !moneyPathAnswers && wantsHuman(body)) {
    await escalateHumanRequest(db, contact, body, { aiPaused });
    return;
  }

  if (contact.state !== 'active') {
    // AI-first: when enabled, Gemini drives onboarding from the very
    // first message — greeting, explaining, answering questions, and
    // gathering the profile in whatever order the conversation flows.
    // Any AI failure drops to the deterministic script below.
    if (ai && !aiPaused) {
      try {
        return await aiOnboarding(db, contact, message, body, settings);
      } catch (e) {
        console.warn('[waStateMachine] AI onboarding failed — using scripted flow:', e?.message);
      }
    }
    // While a human has the thread, the scripted questionnaire would
    // talk over them just as loudly as the AI would. Leave it in the
    // inbox.
    if (aiPaused) return;
    return handleOnboarding(db, contact, body, { settings });
  }

  // 2. Status self-service. Order numbers are answered here as well as
  // tracking codes: since migration 0021 the quote and the payment
  // prompt both carry ORD-3001, so for the whole pre-payment half of the
  // pipeline that is the only code the customer has. Handing out a code
  // and then not recognising it drops the message through to the
  // assistant, which knows the transcript and not the order.
  const statusCode = extractTrackingCode(body) || extractOrderCode(body);
  if (statusCode) {
    return replyOrderStatus(db, contact, statusCode);
  }

  // 3. Customer says they've paid — evaluated BEFORE the quote-confirm
  // branch, because "ok, I have paid" opens with a confirm word and used
  // to match it first: the customer was answered with the till
  // instructions again, for money they had just sent. With STK
  // unavailable every payment is checked against the M-Pesa statement by
  // hand, so we answer this ourselves rather than letting the AI
  // improvise (it used to read the message as a complaint and hand off
  // with "let me get a colleague", which reads like nobody has their
  // money).
  if (body && claimsPaid(body, extractMpesaReference(body))) {
    const ref = extractMpesaReference(body);

    let open = null;
    try {
      open = await findOpenContactPayment(db, contact.id);
    } catch (e) {
      console.warn('[waStateMachine] payment-claim lookup failed:', e?.message);
    }

    // Nothing awaiting verification. "I paid yesterday, any update?" used
    // to get "our team is verifying it now" — the worst possible reply to
    // somebody whose money already cleared. When their latest order is
    // settled, answer with where the parcel actually is, and page no one.
    if (!open) {
      const { rows: latest } = await db.query(
        `SELECT * FROM wa_orders
          WHERE contact_id = $1 AND status <> 'cancelled'
          ORDER BY created_at DESC LIMIT 1`,
        [contact.id]
      );
      const settled = latest[0];
      if (settled && settled.tracking_code
          && !['quoting', 'quoted', 'confirmed'].includes(settled.status)) {
        return sendToContact(db, contact, {
          text:
            `Your payment for ${settled.tracking_code} is confirmed — nothing is pending on our side.\n` +
            parcelStateSentence(settled, settled.tracking_code),
        });
      }
    }

    notifyStaff(db, {
      title: 'Payment claimed — verify on M-Pesa',
      detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code'}): "${body.slice(0, 160)}"${ref ? ` — ref ${ref}` : ''}`,
      dedupeKey: `paid:${contact.id}:${ref || body.slice(0, 40)}`,
    });

    let amountKes = null;
    try {
      if (open) {
        amountKes = Number(open.amount_due_kes);
        if (ref) await attachMpesaReference(db, open.id, ref);
      }
    } catch (e) {
      console.warn('[waStateMachine] payment-claim bookkeeping failed:', e?.message);
    }

    // One reassurance per burst — customers often send the M-Pesa SMS and
    // "I have paid" as two messages seconds apart.
    if (!await sentRecently(db, contact.id, VERIFYING_MARKER, 30)) {
      await sendToContact(db, contact, {
        templateKey: 'payment_verifying',
        templateParams: { reference: ref || 'pending confirmation' },
        text:
          `Asante. We've got your payment notification${ref ? ` (ref *${ref}*)` : ''}` +
          `${amountKes ? ` for KSh ${amountKes.toLocaleString('en-KE')}` : ''} and our team is ` +
          `${VERIFYING_MARKER} now.\n\n` +
          `We'll confirm here as soon as it clears and send your tracking code — usually within a few minutes.`,
      });
    }
    return;
  }

  // 3c. "How do I pay?" / "send me the till", with money actually due.
  //
  // Marion had an order confirmed at KSh 17,746 and asked four times —
  // "How do i make payment??", "Send me the till" — and was told four
  // times that the details would arrive automatically. Nothing was going
  // to send them: the till goes out when the CUSTOMER accepts a quote or
  // an operator presses the button, and hers had been confirmed by an
  // operator hours earlier. She waited nine minutes and wrote "You
  // haven't sent the details aki🤦‍♀️".
  //
  // The assistant was doing as it was told — a guardrail written to stop
  // it inventing payment instructions also stopped it giving real ones,
  // and told it to promise they were coming. Answering this is money, so
  // it resolves here, before the AI, from the order row.
  if (body && asksHowToPay(body)) {
    const handled = await replyWithPaymentDetails(db, contact);
    if (handled) return;
    // Nothing owing — fall through and let the assistant answer the
    // general "how does paying work" question from the knowledge base.
  }

  // 3b. Quote confirmation.
  if (isUnqualifiedConfirm(body)) {
    const { rows } = await db.query(
      `SELECT id, quote_kes, tracking_code, quote_expires_at, delivery_method FROM wa_orders
        WHERE contact_id = $1 AND status = 'quoted'
        ORDER BY quoted_at DESC`,
      [contact.id]
    );
    // Only automate the unambiguous case — exactly one quote awaiting a
    // yes. Zero or several quoted orders → let the operator sort it out.
    if (rows.length === 1) {
      const order = rows[0];
      // An expired quote is not automatically confirmable: the FX rate
      // has moved on and the template told them the price may change.
      // Tell the customer the price is being re-checked, page staff to
      // re-quote, and touch nothing.
      if (order.quote_expires_at && new Date(order.quote_expires_at).getTime() < Date.now()) {
        notifyStaff(db, {
          title: 'Expired quote confirmed — re-quote needed',
          detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code'}) said yes to a quote `
            + `that expired ${new Date(order.quote_expires_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' })}. Send a fresh quote.`,
          dedupeKey: `expired-confirm:${order.id}`,
        });
        await sendToContact(db, contact, {
          text:
            `Thanks for confirming! Your quote has expired, so we're just re-checking the price ` +
            `with today's exchange rate. We'll send the confirmed amount and payment details here shortly.`,
        });
        return;
      }
      // The quote was priced for one delivery method and the customer
      // now wants the other. quote_kes carries the fee (or the absence
      // of one), so confirming it charges the wrong amount — the same
      // shape as the expired quote above, and the failure that let
      // Brian pay a collection price for a Hurlingham delivery. The
      // switch branch pages staff when it sees the request; this
      // catches the case where the preference changed some other way.
      if (order.delivery_method && contact.delivery_preference
          && order.delivery_method !== contact.delivery_preference) {
        notifyStaff(db, {
          title: 'Quote confirmed at the wrong delivery method — re-quote needed',
          detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code'}) said yes to `
            + `${order.tracking_code || 'their order'}, quoted for ${order.delivery_method} at `
            + `KSh ${Number(order.quote_kes || 0).toLocaleString('en-KE')}, but they now want `
            + `${contact.delivery_preference}. Re-quote before taking payment.`,
          dedupeKey: `method-mismatch:${order.id}:${contact.delivery_preference}`,
        });
        await sendToContact(db, contact, {
          text:
            `Thanks for confirming! Because you've switched to ${contact.delivery_preference === 'delivery'
              ? 'delivery' : 'collection'}, your total changes, so we're updating the quote now. ` +
            `We'll send the new amount and the payment details here.`,
        });
        return;
      }
      await db.query(
        `UPDATE wa_orders
            SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'quoted'`,
        [order.id]
      );
      await db.query(
        `INSERT INTO wa_order_events (id, order_id, from_status, to_status, note)
         VALUES (gen_random_uuid()::text, $1, 'quoted', 'confirmed', 'Customer confirmed on WhatsApp')`,
        [order.id]
      );
      pushToStaff('wa_pipeline_update', { order_id: order.id, status: 'confirmed', contact_id: contact.id });
      notifyStaff(db, {
        title: 'Order confirmed — send payment details',
        detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code'}) confirmed KSh ${Number(order.quote_kes).toLocaleString('en-KE')}`,
        dedupeKey: `confirmed:${order.id}`,
      });
      // M-Pesa STK is unavailable (provider withdrawn), so every payment
      // is a Buy Goods transfer the team verifies by hand. Open the
      // awaiting_review payment now: the operator's "Approve payment"
      // action needs a row to act on, and the customer is about to pay.
      try {
        await ensureManualPayment(db, {
          orderId: order.id,
          contactId: contact.id,
          amountKes: Number(order.quote_kes),
          phone: contact.mpesa_number || contact.phone || null,
        });
      } catch (e) {
        console.warn('[waStateMachine] could not open payment row:', e?.message);
      }
      const till = mpesaTill();
      await sendToContact(db, contact, {
        templateKey: 'payment_prompt',
        templateParams: {
          full_name: contact.full_name,
          order_ref: order.tracking_code || 'your order',
          total_kes: Number(order.quote_kes).toLocaleString('en-KE'),
          expires_at: order.quote_expires_at
            ? new Date(order.quote_expires_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'long' })
            : undefined,
        },
        text:
          `Great! Your order is confirmed at KSh ${Number(order.quote_kes).toLocaleString('en-KE')}.\n\n` +
          `To pay: Lipa na M-Pesa → Buy Goods${till ? ` → Till *${till}*` : ''} → ` +
          `KSh ${Number(order.quote_kes).toLocaleString('en-KE')}.\n\n` +
          `Reply here once you've paid and we'll confirm it right away.`,
      });
      return;
    }
  }

  // 4. AI answer — knowledge base + who they are + what we remember +
  // their live orders. Skipped while a human has the conversation.
  if (ai && body && !aiPaused) {
    try {
      const { rows: history } = await db.query(
        `SELECT direction, body FROM (
           SELECT direction, body, created_at FROM wa_messages
            WHERE contact_id = $1 AND body IS NOT NULL AND id <> $2
            ORDER BY created_at DESC LIMIT ${HISTORY_WINDOW}
         ) h ORDER BY created_at ASC`,
        [contact.id, message.id]
      );
      const answer = await chatReply({
        knowledgeBase: settings.ai_knowledge_base,
        history,
        message: body,
        orderContext: await loadOrderContext(db, contact.id),
        facts: await conversationFacts(db, contact),
        profile: describeContact(contact),
        summary: contact.ai_summary,
      });

      if (answer.kind === 'reply') {
        await sendToContact(db, contact, { text: answer.text });
      } else if (answer.kind === 'off_topic') {
        // Nothing to do with us — a wrong number, a joke, a general
        // question. Say what we do and stop there: no staff alert, no
        // takeover, the assistant stays live for their next real
        // message. Escalating these would page an operator for every
        // stray text.
        await replyOffTopic(db, contact);
      } else {
        await handOffToHuman(db, contact, body, { silenceBot: !answer.guardTripped });
      }

      // Refresh durable memory in the background every so often, so the
      // assistant still recalls this conversation once it scrolls out of
      // the verbatim window. Never blocks the reply.
      maybeRefreshSummary(db, contact).catch(() => {});
    } catch (e) {
      // The message is in the inbox with the badge raised, but nobody is
      // told, and the 15-minute sweeper is the only thing that will ever
      // notice. A customer who asked a real question and got silence has
      // usually already decided.
      console.warn('[waStateMachine] AI fallthrough failed (non-fatal):', e?.message);
      notifyStaff(db, {
        title: 'Assistant failed to answer — needs a person',
        detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code'}): `
          + `"${body.slice(0, 160)}" — the assistant errored (${e?.message || 'unknown'}) and sent nothing.`,
        dedupeKey: `aierror:${contact.id}:${message.id}`,
      });
    }
  }
}

/**
 * How to sign off once a profile is complete.
 *
 * "Send us a product link any time" is right for someone who has never
 * ordered and wrong for everyone else. Eunice was told it three minutes
 * after an operator placed and purchased TRK-8828 for her, and reasonably
 * asked whether anything was happening at all. If there is work in
 * flight, the sign-off should say where it is.
 */
async function signOffLine(db, contactId) {
  const { rows } = await db.query(
    `SELECT tracking_code, status FROM wa_orders
      WHERE contact_id = $1 AND status NOT IN ('cancelled', 'delivered')
      ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  );
  const open = rows[0];
  if (!open) return `Send us a product link any time and we'll get you a quote.`;
  const ref = open.tracking_code || 'Your order';
  return `${ref} is already with us — ${(STATUS_LABEL[open.status] || open.status).toLowerCase()}. `
    + `We'll message you as it moves. No need to send anything else for it.`;
}

/** One-line profile for the prompt: who the assistant is talking to. */
function describeContact(contact) {
  const bits = [];
  if (contact.full_name) bits.push(`Name: ${contact.full_name}`);
  if (contact.customer_code) bits.push(`Customer code: ${contact.customer_code}`);
  if (contact.delivery_address) bits.push(`Delivery address: ${contact.delivery_address}`);
  if (contact.created_at) {
    bits.push(`Customer since: ${new Date(contact.created_at).toLocaleDateString('en-KE', { month: 'long', year: 'numeric' })}`);
  }
  return bits.length ? bits.join('; ') : '(unknown)';
}

/**
 * Rebuild the durable memory note when enough has been said since the
 * last one. Best-effort and out of band — a failure just means the note
 * is a little stale.
 */
async function maybeRefreshSummary(db, contact) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM wa_messages
      WHERE contact_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2)`,
    [contact.id, contact.ai_summary_at || null]
  );
  if ((rows[0]?.n ?? 0) < SUMMARY_EVERY_MESSAGES) return;

  const { rows: history } = await db.query(
    `SELECT direction, body FROM (
       SELECT direction, body, created_at FROM wa_messages
        WHERE contact_id = $1 AND body IS NOT NULL
        ORDER BY created_at DESC LIMIT 60
     ) h ORDER BY created_at ASC`,
    [contact.id]
  );
  const summary = await summarizeConversation({ previous: contact.ai_summary, history });
  await db.query(
    `UPDATE wa_contacts SET ai_summary = $2, ai_summary_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [contact.id, summary]
  );
  console.info(`[waStateMachine] refreshed AI memory for ${contact.id}`);
}

/**
 * A customer asked for a person, in so many words.
 *
 * Not yet handed over: the ordinary handoff — acknowledge, mute the
 * assistant, page. Already handed over: page anyway, because a second
 * ask means the first one has not been answered yet and the operator
 * needs to know that, not the same silence again. The acknowledgement is
 * repeated at most hourly — a thread a person already holds does not need
 * "someone will reply shortly" on every message, and saying it twice in
 * five minutes promises a message behind it.
 */
async function escalateHumanRequest(db, contact, body, { aiPaused }) {
  pushToStaff('wa_human_requested', {
    contact_id: contact.id,
    customer_code: contact.customer_code || null,
    full_name: contact.full_name || null,
    phone: contact.phone,
    preview: body.slice(0, 200),
  });

  if (!aiPaused) {
    // handOffToHuman pages on its way through, so this path pages once.
    await handOffToHuman(db, contact, body);
    return;
  }

  notifyStaff(db, {
    title: 'Customer asked for a person again',
    detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code'}): "${body.slice(0, 200)}" `
      + `— the thread is already handed over and the assistant is muted, so they are waiting on a person.`,
    dedupeKey: `wants-human:${contact.id}:${body.slice(0, 40)}`,
  });
  if (!await sentRecently(db, contact.id, HANDOFF_MARKER, 60)) {
    await sendToContact(db, contact, { text: HANDOFF_REPLY });
  }
}

/**
 * Is the assistant paused on this conversation? True while a human has
 * it (an operator replied, or the AI handed off). Clears itself once the
 * chat has been silent for ai_resume_after_minutes, so a customer who
 * comes back days later isn't stuck waiting on a person who has moved on.
 */
async function aiOnHold(db, contact, message, settings) {
  if (!contact.human_takeover_at) return false;

  const { rows } = await db.query(
    `SELECT MAX(created_at) AS at FROM wa_messages WHERE contact_id = $1 AND id <> $2`,
    [contact.id, message.id]
  );
  const lastAt = rows[0]?.at ? new Date(rows[0].at).getTime() : 0;
  const quietMs = Date.now() - lastAt;
  const resumeAfterMs = Math.max(1, Number(settings?.ai_resume_after_minutes ?? 120)) * 60_000;
  if (!lastAt || quietMs < resumeAfterMs) return true;

  await db.query(
    `UPDATE wa_contacts SET human_takeover_at = NULL, updated_at = NOW() WHERE id = $1`,
    [contact.id]
  );
  console.info(`[waStateMachine] AI resumed for ${contact.id} after ${Math.round(quietMs / 60000)}m of silence`);
  return false;
}

/** Did we already send this line to this contact recently? */
async function sentRecently(db, contactId, marker, minutes) {
  const { rows } = await db.query(
    `SELECT 1 FROM wa_messages
      WHERE contact_id = $1 AND direction = 'out' AND body LIKE $2
        AND created_at > NOW() - ($3 || ' minutes')::interval
      LIMIT 1`,
    [contactId, `%${marker}%`, String(minutes)]
  );
  return rows.length > 0;
}

/**
 * The message has nothing to do with us. Say what we do, once, and stay
 * out of the way — no operator alert, no takeover, the assistant is
 * still live for their next real message. Repeats are suppressed for an
 * hour so a chatty wrong number doesn't get the same line ten times;
 * their messages still land in the inbox either way.
 *
 * @param {string} [followUp] appended when we still need something from
 *   them (mid-onboarding), so the redirect also moves the flow along.
 */
async function replyOffTopic(db, contact, followUp = '') {
  // Suppressed because we said the same thing within the hour. That is
  // right for a wrong number texting twice and wrong for a real customer
  // misread twice — who would otherwise get nothing at all: no reply, no
  // alert, no takeover. Page a person instead of going quiet.
  if (await sentRecently(db, contact.id, OFF_TOPIC_MARKER, 60)) {
    notifyStaff(db, {
      title: 'Second off-topic in an hour — probably not off-topic',
      detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code'}) `
        + `has been classified off-topic twice running. They have had one reply and are now getting silence.`,
      dedupeKey: `offtopic-twice:${contact.id}`,
    });
    return;
  }
  await sendToContact(db, contact, {
    text:
      `Sorry, I can ${OFF_TOPIC_MARKER} orders — quotes, payments, tracking and delivery. `
      + (followUp || `Send us a product link any time and we'll get you a quote, `
        + `or text your tracking code for an update.`),
  });
}

/**
 * A person is needed: a complaint, a refund, a human request, or a
 * question about our service the assistant can't answer. Acknowledge so
 * the customer isn't left in silence, hand the thread over (the AI goes
 * quiet until it times out or an operator re-enables it), and page staff.
 */
/**
 * @param {object} opts
 * @param {boolean} [opts.silenceBot=true]  set human_takeover_at, muting
 *   the assistant on this thread until an operator has had their turn.
 *
 * A customer who asks for a person wants a person, and the assistant
 * talking over them is the thing takeover exists to stop. But our own
 * output guard tripping is not that: Marion tripped it on "Heey", was
 * told to wait for a colleague, and then sent five more messages —
 * including "there's a pair of boots missing" — into a thread the
 * assistant had been muted on for two hours. Pass silenceBot: false
 * there, so the page goes out and the next message still gets answered.
 * The operator's own reply sets takeover anyway when they arrive.
 */
async function handOffToHuman(db, contact, body, { silenceBot = true } = {}) {
  await sendToContact(db, contact, { text: HANDOFF_REPLY });
  if (silenceBot) {
    await db.query(
      `UPDATE wa_contacts SET human_takeover_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [contact.id]
    );
  }
  notifyStaff(db, {
    title: silenceBot ? 'Customer needs a human' : 'Assistant could not answer safely — needs a human',
    detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code'}): "${body.slice(0, 200)}"`,
    dedupeKey: `handoff:${contact.id}:${body.slice(0, 40)}`,
  });
}

// ── Onboarding ──────────────────────────────────────────────────────────────

async function setState(db, contactId, state, fields = {}) {
  const sets = ['state = $2', 'updated_at = NOW()'];
  const params = [contactId, state];
  for (const [col, val] of Object.entries(fields)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  await db.query(`UPDATE wa_contacts SET ${sets.join(', ')} WHERE id = $1`, params);
}

/**
 * Render this customer's orders for the AI prompt so questions like
 * "where is my parcel?" or a half-remembered code can be answered without
 * an exact TRK match. Read-only: the model is told these are live facts it
 * may state, and that it must hand off for anything not listed.
 */
async function loadOrderContext(db, contactId) {
  const { rows } = await db.query(
    `SELECT tracking_code, status, quote_kes, delivery_fee_kes, delivery_fee_waived,
            delivery_fee_paid_at, delivery_method, paid_at, purchased_at, arrived_at,
            dispatched_at, delivered_at, created_at
       FROM wa_orders
      WHERE contact_id = $1 AND status <> 'cancelled'
      ORDER BY created_at DESC LIMIT 5`,
    [contactId]
  );
  if (rows.length === 0) return '(none on file)';

  const day = (d) => (d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }) : null);
  return rows.map((o) => {
    const steps = [
      ['paid', o.paid_at], ['purchased', o.purchased_at], ['arrived in Kenya', o.arrived_at],
      ['out for delivery', o.dispatched_at], ['delivered', o.delivered_at],
    ].filter(([, at]) => at).map(([label, at]) => `${label} ${day(at)}`);

    const bits = [
      o.tracking_code ? `Tracking ${o.tracking_code}` : 'No tracking code yet (not paid)',
      `status: ${STATUS_LABEL[o.status] || o.status}`,
    ];
    if (o.quote_kes) bits.push(`agreed total KSh ${Number(o.quote_kes).toLocaleString('en-KE')}`);
    // Money is owing on this one, so the assistant is given the figure AND
    // the till rather than being left to say "the details are coming".
    // The deterministic branch answers the common phrasings first; this
    // covers the ones it does not catch.
    if (o.status === 'confirmed' && o.quote_kes) {
      bits.push(`AWAITING PAYMENT: KSh ${Number(o.quote_kes).toLocaleString('en-KE')} to `
        + `M-Pesa Buy Goods Till ${mpesaTill() || '(till not configured)'}`);
    }
    if (steps.length) bits.push(`history: ${steps.join(', ')}`);
    if (o.status === 'delivery_fee_pending' && !o.delivery_fee_waived && !o.delivery_fee_paid_at) {
      bits.push(`delivery fee outstanding: KSh ${Number(o.delivery_fee_kes || 0).toLocaleString('en-KE')} `
        + `to M-Pesa Buy Goods Till ${mpesaTill() || '(till not configured)'}`);
    }
    if (o.delivery_fee_waived) bits.push('delivery fee waived');
    return `- ${bits.join('; ')}`;
  }).join('\n');
}

/**
 * The most recent product link this contact sent us, and how many
 * messages they have sent at all.
 *
 * Shared by conversationFacts and the scripted onboarding flow, because
 * both have to answer the same question — is anything actually being
 * priced for this person — and only one of them was asking it.
 */
async function inboundLinkHistory(db, contactId) {
  const { rows } = await db.query(
    `SELECT body, created_at FROM wa_messages
      WHERE contact_id = $1 AND direction = 'in' AND body IS NOT NULL
        AND created_at > NOW() - ($2 || ' days')::interval
      ORDER BY created_at DESC LIMIT 60`,
    [contactId, String(LINK_MEMORY_DAYS)]
  );
  // The most recent link they sent, not merely whether they ever sent one.
  const lastLink = rows.find((m) => PRODUCT_LINK.test(m.body || ''));
  return {
    lastLinkAt: lastLink ? new Date(lastLink.created_at).getTime() : null,
    inboundCount: rows.length,
  };
}

/**
 * What is actually true of this conversation, for the AI prompt.
 *
 * +447428777090 asked "How do I pay?" three messages into a chat with no
 * link and no order, and was told "your quote is being worked out now
 * and will come through here shortly". Nothing was. The model had the
 * transcript and the order list, and inferred an order from how far
 * along the conversation felt — the prompt's "tell them the quote is
 * coming" rule was written for the message after a link arrives, and
 * nothing told the model whether a link had ever arrived.
 *
 * So it is looked up rather than inferred: has this customer ever sent a
 * link, is any order open, is a quote genuinely being prepared. Cheap,
 * indexed, and it runs once per AI turn.
 */
async function conversationFacts(db, contact) {
  const [orders, { lastLinkAt, inboundCount }] = await Promise.all([
    db.query(
      `SELECT status, quoted_at FROM wa_orders
        WHERE contact_id = $1 AND status <> 'cancelled'`,
      [contact.id]
    ),
    inboundLinkHistory(db, contact.id),
  ]);

  const missing = [];
  if (!contact.full_name) missing.push('full name');
  if (!contact.delivery_address) missing.push('delivery address or pickup point');

  // The most recent quote we sent them.
  const lastQuotedAt = orders.rows
    .map((o) => (o.quoted_at ? new Date(o.quoted_at).getTime() : 0))
    .reduce((a, b) => Math.max(a, b), 0);

  // How long they have been waiting on the quote, if they are.
  const waitedMs = lastLinkAt && lastLinkAt > lastQuotedAt ? Date.now() - lastLinkAt : 0;
  const overdue = waitedMs > QUOTE_PROMISE_MS;

  return renderFacts({
    linkReceived: Boolean(lastLinkAt),
    orderCount: orders.rows.length,
    // Past the promise window the quote is not "in flight", it is late —
    // see renderFacts. The window is generous on purpose: the sweeper
    // pages a person at WA_SLA_QUOTE_MINUTES, and this only stops the
    // assistant promising once that page has had hours to be acted on.
    quoteOverdue: overdue,
    quoteWaitedLabel: overdue ? waitedLabel(waitedMs) : null,
    // A quote is in flight when the customer can see why it would be:
    // they sent a link and nothing has been quoted since. Keying this on
    // an order sitting at 'quoting' was wrong in the only way that
    // matters — 20 of 24 priced orders spent two minutes or less in that
    // status, and 13 spent none at all, because the operator creates the
    // order already priced. The customer's wait starts when they send
    // the link, minutes before any row exists. TRK-8834 sent a cart link
    // at 19:38 and was not opened until 19:43; for those five minutes
    // the old rule called a true "your quote is coming" a hallucination,
    // suppressed it, and handed the warmest lead in the business to a
    // stall.
    quoteInFlight: Boolean(lastLinkAt) && lastLinkAt > lastQuotedAt && !overdue,
    missing,
    inboundCount,
  });
}

// How long a "your quote is coming" stays true. Nothing bounded it, so it
// stayed true for as long as nobody priced the link — eighteen hours, in
// +254790325255's case, across four reassurances. The sweeper pages a
// person at WA_SLA_QUOTE_MINUTES (an hour); this is deliberately much
// longer, because the assistant should go quiet on the subject only once
// that page has had a working day's worth of chances to be acted on, not
// the moment it fires.
const QUOTE_PROMISE_MS = (() => {
  const n = parseInt(process.env.WA_QUOTE_PROMISE_MINUTES ?? '', 10);
  return (Number.isFinite(n) && n > 0 ? n : 180) * 60_000;
})();

/** "2 hours" / "35 minutes" — how the wait reads to the person who waited. */
function waitedLabel(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 120) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

// What to ask for next, keyed by the awaiting_* state. Used when an
// off-topic message interrupts signup — the redirect carries the
// question so the flow keeps moving.
const MISSING_FIELD_PROMPT = {
  awaiting_name: `To set you up, what's your full name?`,
  awaiting_address: `To set you up: where should the parcel go? Send a delivery address (estate/building, street, town), or the area you'd like to collect in — we'll confirm the nearest Pickup Mtaani point.`,
};

// Somewhere we can actually send a parcel — a street address, or a
// collection point. Collection answers are short by nature ("CBD",
// "Mtaani", "Stanbank"), so a length floor on its own would re-ask a
// customer who has already answered perfectly well.
const PICKUP_WORDS = /\b(cbd|town|stanbank|pick\s?up|pickup|mtaani|collect(ion)?|office)\b/i;

/** Is this plausibly a destination — an address, or a pickup point? */
export function looksLikeDestination(value) {
  const v = String(value || '').trim();
  if (!v || NOT_A_NAME.test(v)) return false;
  // Five characters rejected Voi, Juja, Meru, Embu, Ruai and Yaya — all
  // real answers — and the customer was then asked the same question
  // again. The operator confirms the exact Pickup Mtaani point anyway, so
  // a short town name loses nothing; a greeting is the only thing worth
  // turning away.
  return v.length >= 3 || PICKUP_WORDS.test(v);
}

/**
 * Which way does this message say the parcel should reach them —
 * 'delivery', 'collection', or neither?
 *
 * Used for two different jobs, both of which turn on the same fact.
 * During signup it is how "CBD collection" is recognised as a complete
 * answer to where the parcel goes (there is no address to wait for when
 * the parcel comes to our counter). After a quote it is a change of
 * PRICE, because collection is free and delivery carries the last-mile
 * fee — see the branch in handleInbound.
 *
 * Deliberately narrow. A question opening with where/when/how is asking
 * about a method, not choosing one ("How long does it take for items to
 * be delivered?" is not a request for delivery), and a longer sentence
 * has to carry an actual intent word before it counts.
 */
const WANTS_DELIVERY = /\b(deliver|delivers|delivery|delivered|delivering|dropped off)\b/i;
const WANTS_COLLECTION = /\b(collect|collects|collection|collecting|pick\s?-?\s?up|picking (it|them|my parcel) up|self\s?-?collect)\b/i;
const SWITCH_INTENT = /\b(change|switch|instead|rather|prefer|can i|could i|may i|i want|i'?d like|i would like|i will|we will|let me|make it|i'?ll|we'?ll)\b/i;
const INFO_QUESTION = /^(where|when|what|how|why|who)\b/i;

/** @returns {'delivery'|'collection'|null} */
export function saysDeliveryMethod(text) {
  const v = String(text || '').trim();
  if (!v || INFO_QUESTION.test(v)) return null;

  let wantsDelivery = WANTS_DELIVERY.test(v);
  let wantsCollection = WANTS_COLLECTION.test(v);

  // "Can I pick up my parcel instead of delivery?" names BOTH. What
  // follows "instead of" is the one being dropped, so the other one is
  // the answer — Brian's message, which a both-match test would have
  // thrown away.
  const dropped = v.match(/instead of\s+([a-z]+)/i)?.[1];
  if (dropped) {
    if (WANTS_DELIVERY.test(dropped)) wantsDelivery = false;
    else if (WANTS_COLLECTION.test(dropped)) wantsCollection = false;
  }

  if (wantsDelivery === wantsCollection) return null; // neither, or still both
  // A bare answer to "delivered, or collect?" is the whole message
  // ("collection", "CBD collection"). Anything longer has to say it
  // means it.
  if (!SWITCH_INTENT.test(v) && v.split(/\s+/).length > 3) return null;
  return wantsDelivery ? 'delivery' : 'collection';
}

/**
 * Greetings and pleasantries people open with, which are not names.
 *
 * Eunice said "Hi" while we were waiting on her name and was answered
 * with "Thanks Hi! What's your delivery address?" — the greeting went
 * into full_name and the profile moved on. The prompt now tells the model
 * the same thing, but the model is not the place to enforce it: this runs
 * on the scripted path too, and a rule this cheap should not depend on
 * whether the AI is having a good day.
 */
const NOT_A_NAME = /^(hi|hey|hello+|yo|habari|niaje|sasa|mambo|karibu|jambo|salamu|hola|good\s*(morning|afternoon|evening|day)|asante|thanks?|thank\s*you|ok(ay)?|sawa(sawa)?|yes|no|please|help|start|hi\s*there)\b[\s!.,]*$/i;

// Somebody asked to see the price before handing over their details:
// "Can I first get the pricing and quotation ndio tujue details". The
// whole sentence went into full_name and they were answered "Thanks
// Can!". A greeting list was never going to catch that — the shape of a
// question is what gives it away, not its vocabulary.
//
// Structural rules only, because vocabulary lists do not travel: a name
// is short, it is not a question, and it does not open with the words
// people start requests with.
const SENTENCE_OPENER =
  /^(can|could|may|might|shall|will|would|should|do|does|did|is|are|was|were|am|have|has|had|what|when|where|which|who|whom|whose|why|how|i|i'?m|im|my|me|we|you|your|the|a|an|please|let|give|send|tell|show|need|want|first|before|after|also|but|and|so|if|ok(ay)?|sorry|hebu|naomba|nataka|nini|vipi|kwani|sasa)\b/i;
const MAX_NAME_WORDS = 5;

/** Is this plausibly someone's name, rather than a greeting, link or question? */
export function looksLikeName(value) {
  const name = String(value || '').trim();
  if (name.length < 2 || name.length > 120) return false;
  if (/^https?:\/\//i.test(name)) return false;
  if (NOT_A_NAME.test(name)) return false;
  // Nobody's name is a question, and none contain digits.
  if (/[?¿]/.test(name)) return false;
  if (/\d/.test(name)) return false;
  // "Brian Mwarari" is two words; "Can I first get the pricing and
  // quotation ndio tujue details" is eleven. Five leaves room for a long
  // Kenyan name and still turns away a sentence.
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > MAX_NAME_WORDS) return false;
  // A short phrase can still be a request — "give me pricing", "my name".
  if (words.length > 1 && SENTENCE_OPENER.test(name)) return false;
  // A name has letters in it; "0700092005" and "..." do not.
  return /\p{L}{2,}/u.test(name);
}

/**
 * Are they asking how to pay, or asking for the till?
 *
 * Deliberately narrow — it only decides whether we answer from the order
 * row instead of the knowledge base, and a false positive on someone with
 * nothing owing falls through to the assistant anyway.
 */
export function asksHowToPay(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return /\b(till|paybill|buy ?goods)\b/i.test(v)
    // "How do i make payment??" was Marion's opener, and a pattern that
    // wanted the bare verb "pay" missed it.
    || /\bhow\b[^.?!]{0,40}\b(pay|paying|payment)\b/i.test(v)
    || /\b(payment|pay)\b[^.?!]{0,25}\b(details|number|instructions|info)\b/i.test(v)
    || /\b(where|how)\b[^.?!]{0,25}\bsend\b[^.?!]{0,20}\b(money|payment|cash|pesa)\b/i.test(v)
    || /\bnilipe\b|\bnitalipaje\b|\bnalipaje\b|\blipa\b[^.?!]{0,15}\bwapi\b/i.test(v);
}

/**
 * Send the real amount and the real till when something is genuinely
 * owing. Returns false when nothing is, so the caller can fall through.
 *
 * Every figure comes from the order row — this never computes a total.
 */
async function replyWithPaymentDetails(db, contact) {
  const { rows } = await db.query(
    `SELECT id, status, quote_kes, tracking_code, order_code, delivery_fee_kes,
            delivery_fee_waived, delivery_fee_paid_at, delivery_fee_in_quote
       FROM wa_orders
      WHERE contact_id = $1 AND status IN ('confirmed', 'quoted', 'in_kenya', 'delivery_fee_pending')
      ORDER BY updated_at DESC`,
    [contact.id]
  );
  // Several things owing at once is a conversation for a person: sending
  // one till figure would invite paying the wrong amount.
  const owing = rows.filter((o) =>
    o.status === 'confirmed'
    || o.status === 'quoted'
    || (!o.delivery_fee_in_quote && !o.delivery_fee_waived && !o.delivery_fee_paid_at
        && Number(o.delivery_fee_kes) > 0));
  if (owing.length !== 1) return false;

  const order = owing[0];
  const till = mpesaTill();
  // Nothing owing has a tracking code — that is minted at payment — so
  // this named no order at all in exactly the case a customer is most
  // likely to have two of them open.
  const code = order.tracking_code || order.order_code;
  const ref = code ? ` (${code})` : '';

  // A quote they have not accepted yet. Give them the number and the
  // till — that is what they asked for — but leave the money state alone;
  // accepting is still their word, not our inference.
  if (order.status === 'quoted') {
    await sendToContact(db, contact, {
      text:
        `Your quote${ref} is KSh ${Number(order.quote_kes).toLocaleString('en-KE')}.\n\n`
        + `To pay: Lipa na M-Pesa → Buy Goods${till ? ` → Till *${till}*` : ''} → `
        + `KSh ${Number(order.quote_kes).toLocaleString('en-KE')}.\n\n`
        + `Reply *YES* here to lock it in, or just pay and tell us — either way we'll `
        + `confirm it and send your tracking code.`,
    });
    return true;
  }

  const amount = order.status === 'confirmed'
    ? Number(order.quote_kes)
    : Number(order.delivery_fee_kes);
  if (!Number.isFinite(amount) || amount <= 0) return false;

  // The payment row is what the operator's "Approve payment" acts on.
  try {
    await ensureManualPayment(db, {
      orderId: order.id,
      contactId: contact.id,
      amountKes: amount,
      phone: contact.mpesa_number || contact.phone || null,
    });
  } catch (e) {
    console.warn('[waStateMachine] could not open payment row:', e?.message);
  }

  await sendToContact(db, contact, {
    text: order.status === 'confirmed'
      ? `Your order${ref} is KSh ${amount.toLocaleString('en-KE')}.\n\n`
        + `To pay: Lipa na M-Pesa → Buy Goods${till ? ` → Till *${till}*` : ''} → `
        + `KSh ${amount.toLocaleString('en-KE')}.\n\n`
        + `Reply here once you've paid and we'll confirm it and send your tracking code.`
      : `The last-mile delivery fee${ref} is KSh ${amount.toLocaleString('en-KE')}.\n\n`
        + `To pay: Lipa na M-Pesa → Buy Goods${till ? ` → Till *${till}*` : ''} → `
        + `KSh ${amount.toLocaleString('en-KE')}.\n\n`
        + `Reply here once you've paid and we'll get it on its way.`,
  });
  return true;
}

/**
 * Is this message a question or a push-back, rather than the answer we
 * asked for? Used to tell "not yet, tell me the price first" apart from
 * an answer that simply failed validation — the two deserve different
 * replies, and re-asking somebody who just asked us something is how a
 * conversation stops feeling like one.
 */
export function looksLikeQuestion(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (/[?¿]/.test(v)) return true;
  return v.split(/\s+/).length > 1 && SENTENCE_OPENER.test(v);
}

/**
 * AI-first onboarding turn. Gemini produces the reply AND any profile
 * fields it spotted in the message; this function stays in charge of the
 * rules: field validation (looksLikeName is the hard gate on the name),
 * state bookkeeping (the awaiting_* states track what's still missing, so
 * the scripted flow can take over seamlessly if AI is ever disabled
 * mid-conversation), Customer Code minting, and operator alerts. Throws
 * on AI failure so the caller falls back to the script.
 */
async function aiOnboarding(db, contact, message, body, settings) {
  const { rows: history } = await db.query(
    `SELECT direction, body FROM (
       SELECT direction, body, created_at FROM wa_messages
        WHERE contact_id = $1 AND body IS NOT NULL AND id <> $2
        ORDER BY created_at DESC LIMIT ${HISTORY_WINDOW}
     ) h ORDER BY created_at ASC`,
    [contact.id, message.id]
  );

  const turn = await onboardingTurn({
    knowledgeBase: settings.ai_knowledge_base,
    history,
    message: body,
    orderContext: await loadOrderContext(db, contact.id),
    facts: await conversationFacts(db, contact),
    profile: {
      full_name: contact.full_name || null,
      delivery_address: contact.delivery_address || null,
      // Without this the model was told the destination was still
      // missing after the customer had already said they would collect,
      // so it kept asking for a street address it was never going to get.
      delivery_preference: contact.delivery_preference || null,
    },
  });

  // Apply extracted fields under the same rules as the scripted flow.
  const fields = {};
  // A field the model claimed to have read but the gate then threw away.
  // The reply was sent regardless — so the customer was thanked for a
  // detail nothing had saved, and asked for it again on the next turn.
  // Asking the specific question instead is the only honest reply.
  let rejected = null;
  if (!contact.full_name && turn.full_name) {
    if (looksLikeName(turn.full_name)) fields.full_name = turn.full_name.trim();
    else rejected = `Sorry — just to be sure I have it right: what is the full name the parcel should be labelled with?`;
  }
  if (!contact.delivery_address && turn.delivery_address) {
    if (looksLikeDestination(turn.delivery_address)) fields.delivery_address = turn.delivery_address;
    else if (!rejected) rejected = `Sorry — where should the parcel go? An address (estate/building, street, town), or the area you'd rather collect in.`;
  }
  // Seeds the operator's default at quote time — delivery is charged the
  // last-mile fee and collection is not, so it is worth keeping whatever
  // the customer already said rather than making somebody guess later.
  if (!contact.delivery_preference && turn.delivery_preference) {
    fields.delivery_preference = turn.delivery_preference;
  }

  // A name and somewhere to send the parcel. The M-Pesa number used to be
  // the third thing we held people up for, and it earned nothing: payments
  // are read off the M-Pesa statement, so knowing the number in advance
  // never once told us anything we could not see afterwards.
  const merged = { ...contact, ...fields };
  // Collection IS the answer to where the parcel goes: it comes to our
  // counter, so there is no address to wait for. Brian said "CBD
  // collection" at 21:51 and stayed unregistered — no code, no
  // confirmation — until he gave a street in Hurlingham four minutes and
  // one quote later, because this asked for an address he had already
  // told us he did not need.
  const destinationKnown = Boolean(merged.delivery_address)
    || merged.delivery_preference === 'collection';
  const complete = Boolean(merged.full_name) && destinationKnown;
  const nextState = complete ? 'active'
    : !merged.full_name ? 'awaiting_name'
    : 'awaiting_address';

  const collecting = destinationKnown && !merged.delivery_address;

  let customerCode = contact.customer_code;
  if (complete && !customerCode) {
    customerCode = await nextCustomerCode(db);
    fields.customer_code = customerCode;
  }
  if (nextState !== contact.state || Object.keys(fields).length > 0) {
    await setState(db, contact.id, nextState, fields);
  }

  if (turn.kind === 'reply' && turn.reply) {
    // `rejected` means the model wrote its reply believing it had the
    // detail. Sending that reply would confirm something we did not save.
    await sendToContact(db, contact, { text: rejected || turn.reply });
  } else if (turn.kind === 'off_topic') {
    // Off-topic mid-signup: redirect, then re-ask whatever we still
    // need so the conversation doesn't stall. (Before this branch
    // existed the sentinel was stripped to null and the customer got
    // nothing back at all.)
    await replyOffTopic(db, contact, complete ? '' : `${MISSING_FIELD_PROMPT[nextState]}`);
  } else if (turn.kind === 'handoff') {
    await handOffToHuman(db, contact, body, { silenceBot: !turn.guardTripped });
    return; // a person has the thread now — don't also run the welcome media
  }

  // The assistant tried to promise a quote nobody was preparing and the
  // guard caught it. Worth a person's eyes: it means either the prompt
  // is drifting or this customer really is waiting on something.
  if (turn.falseClaim) {
    notifyStaff(db, {
      title: 'Assistant nearly promised a quote that does not exist',
      detail: `${contact.full_name || contact.phone}: "${body.slice(0, 200)}" — no link and no order on file.`,
      dedupeKey: `falseclaim:${contact.id}`,
    });
  }

  // First-ever exchange: send the welcome infographics (best-effort).
  if (contact.state === 'new') {
    for (const url of (settings.welcome_media_urls || []).slice(0, 3)) {
      await sendToContact(db, contact, { templateKey: 'welcome_media', mediaUrl: url, mediaType: 'image' });
    }
  }

  if (complete && !contact.customer_code) {
    pushToStaff('wa_new_customer', {
      contact_id: contact.id,
      customer_code: customerCode,
      full_name: merged.full_name,
      phone: contact.phone,
    });
    notifyStaff(db, {
      title: 'New customer onboarded',
      detail: `${merged.full_name || contact.phone} — ${customerCode} — ${merged.delivery_address || 'no address'}`,
      dedupeKey: `onboarded:${contact.id}`,
    });
    await sendToContact(db, contact, {
      templateKey: 'onboarded',
      templateParams: { customer_code: customerCode },
      text:
        `You're all set. Your customer code is *${customerCode}* — keep it handy, it goes on all your parcels.\n\n` +
        // Confirm the choice back to them. Somebody who has just said
        // they will collect should hear that we heard it — and it is the
        // half of the quote they can check without knowing our fees.
        (collecting ? `You're collecting, so there's no delivery fee — we'll message you the moment your parcel is ready.\n\n` : '') +
        `${await signOffLine(db, contact.id)}`,
    });
  }
}

/**
 * They want the other delivery method, and a quote already exists for
 * this one.
 *
 * Nothing here re-prices anything: the fee, the FX rate and the margin
 * are the operator's to set, and a quote this code invented would be a
 * second source of truth for the only number that matters. What it does
 * is make the change visible before it becomes money — page the team to
 * re-quote, record the customer's choice so the re-quote defaults to it,
 * and tell the customer plainly that the total moves and a new quote is
 * coming. The confirm branch refuses the stale quote in the meantime.
 *
 * @returns {Promise<boolean>} true when this was handled and the rest of
 *   the pipeline (assistant included) should stay out of it.
 */
async function handleDeliveryMethodSwitch(db, contact, wanted, { aiPaused } = {}) {
  const { rows } = await db.query(
    `SELECT id, tracking_code, quote_kes, delivery_method, status
       FROM wa_orders
      WHERE contact_id = $1 AND status IN ('quoted', 'confirmed') AND paid_at IS NULL
      ORDER BY quoted_at DESC NULLS LAST, created_at DESC`,
    [contact.id]
  );
  // Only a priced order can be mis-priced. Somebody choosing a method
  // before any quote exists is answering a question, not changing a
  // price — that belongs to onboarding and the assistant.
  const order = rows.find((o) => o.delivery_method && o.delivery_method !== wanted);
  if (!order) return false;

  if (contact.delivery_preference !== wanted) {
    await db.query(
      `UPDATE wa_contacts SET delivery_preference = $2, updated_at = NOW() WHERE id = $1`,
      [contact.id, wanted]
    );
    contact.delivery_preference = wanted;
  }
  await db.query(
    `INSERT INTO wa_order_events (id, order_id, from_status, to_status, note)
     VALUES (gen_random_uuid()::text, $1, $2, $2, $3)`,
    [order.id, order.status, `Customer switched to ${wanted} after quoting — re-quote needed`]
  );

  const ref = order.tracking_code || 'their order';
  notifyStaff(db, {
    title: 'Delivery method changed after quoting — re-quote needed',
    detail: `${contact.full_name || contact.phone} (${contact.customer_code || 'no code'}) wants `
      + `${wanted} instead of ${order.delivery_method} on ${ref}, quoted at `
      + `KSh ${Number(order.quote_kes || 0).toLocaleString('en-KE')}. That price is for `
      + `${order.delivery_method}, so it needs re-quoting before they pay.`,
    dedupeKey: `method-switch:${order.id}:${wanted}`,
  });

  // A human on the thread can see the switch and may already be pricing
  // it; two voices answering is worse than one.
  if (aiPaused) return true;

  const needsAddress = wanted === 'delivery' && !contact.delivery_address;
  await sendToContact(db, contact, {
    text: wanted === 'delivery'
      ? `Yes, we can deliver instead. That changes your total — delivery carries the `
        + `last-mile fee, which collection doesn't — so we're updating your quote now and `
        + `will send the new one here.`
        + (needsAddress ? ` Meanwhile, what's the delivery address (estate/building, street, town)?` : '')
      : `Yes, you can collect instead. That changes your total — collection has no `
        + `last-mile fee — so we're updating your quote now and will send the new one here.`,
  });
  return true;
}

/**
 * A question the scripted flow has no knowledge base to answer.
 *
 * Both onboarding states used to reply "your quote is being worked out
 * now and will come through here shortly" to any question at all — the
 * exact sentence claimsQuoteInFlight() exists to stop the model sending,
 * hard-coded, and said with no link, no order and nothing behind it. When
 * the Claude swap left the assistant throwing on every turn this script
 * was what customers actually got. The chat that surfaced it (28 August,
 * 16:17–16:19) opened "Hi", asked "Is there an offer?", was told the
 * quote was coming, wrote back "I haven't sent a link", and was told the
 * same thing again word for word.
 *
 * So the claim is made only when a link really did arrive — the same
 * lookup conversationFacts hands the model, because the script has no
 * more right to guess than the model does. Otherwise it asks for the
 * link, which is the only thing that starts a quote.
 *
 * Either way a person gets the question, because this path only runs when
 * the assistant is off or broken and nobody else is going to answer it.
 * Once per customer: a repeated alert is an ignored one.
 */
async function answerScriptedQuestion(db, contact, body, detailLine) {
  const { lastLinkAt } = await inboundLinkHistory(db, contact.id);
  if (lastLinkAt) {
    return sendToContact(db, contact, {
      text:
        `Of course — your quote is being worked out now and will come through here shortly. ` +
        `There's nothing to pay or decide until you've seen it.\n\n${detailLine}`,
    });
  }
  notifyStaff(db, {
    title: 'Question during signup the script cannot answer',
    detail: `${contact.full_name || contact.phone}: "${body.slice(0, 200)}" — no link on file.`,
    dedupeKey: `scriptedquestion:${contact.id}`,
  });
  return sendToContact(db, contact, {
    // No promise of a second message except the one that is true: a link
    // pages staff (see handleInbound) and an operator prices it.
    text:
      `Good question — one of our team is picking that up for you now.\n\n` +
      `Whenever you're ready, send the link to what you'd like and we'll come back with the ` +
      `price in KES. A quote is free and commits you to nothing.`,
  });
}

// The deterministic onboarding script — the fallback whenever the AI is
// disabled, unconfigured, or errored on a turn.
async function handleOnboarding(db, contact, body, { settings = null } = {}) {
  switch (contact.state) {
    case 'new': {
      await setState(db, contact.id, 'awaiting_name');
      await sendToContact(db, contact, {
        templateKey: 'welcome',
        text:
          `Karibu Thapsus Cargo.\n\n` +
          `We buy items from online stores abroad and deliver them to your door in Kenya. ` +
          `How it works:\n` +
          `1. Send us the product link(s)\n` +
          `2. We reply with a KES quote\n` +
          `3. Pay via M-Pesa\n` +
          `4. We buy and ship it — you track it with your code until it's delivered\n\n` +
          `What would you like to do? Send a product link for a quote, or ask us anything.`,
      });
      // Welcome infographics (operator-configurable). Best-effort.
      try {
        const settings = await getWaSettings(db);
        for (const url of (settings.welcome_media_urls || []).slice(0, 3)) {
          await sendToContact(db, contact, { templateKey: 'welcome_media', mediaUrl: url, mediaType: 'image' });
        }
      } catch { /* non-fatal */ }
      return;
    }

    case 'awaiting_name': {
      // A link is the likeliest second message now that the welcome asks
      // for one. Answer what they actually sent before asking anything:
      // "please reply with your full name" to somebody who just sent a
      // product link reads like nobody looked at it. Staff were paged the
      // moment it arrived, so the quote really is in motion.
      if (PRODUCT_LINK.test(body)) {
        return sendToContact(db, contact, {
          text:
            `Got it — our team is pricing that now and your quote will come through here shortly.\n\n` +
            `While you wait: what's your full name? (As we should write it on your parcels.)`,
        });
      }
      // They asked us something instead of answering. Re-asking for a
      // name at that point ignores a customer who is still deciding
      // whether to buy at all — and the detail is only needed once they
      // accept, so there is nothing to lose by waiting.
      if (looksLikeQuestion(body)) {
        return answerScriptedQuestion(db, contact, body,
          `We'll only need your name and where to send the parcel once you're happy to go ahead.`);
      }
      if (!looksLikeName(body)) {
        return sendToContact(db, contact, {
          text: `Please reply with your full name (as we should write it on your parcels).`,
        });
      }
      await setState(db, contact.id, 'awaiting_address', { full_name: body.slice(0, 120) });
      return sendToContact(db, contact, {
        text: `Thanks ${body.split(/\s+/)[0]}! Where should we send it? A delivery address (estate/building, street, town), or the area you'd like to collect in — we'll confirm the nearest Pickup Mtaani point.`,
      });
    }

    case 'awaiting_address': {
      if (PRODUCT_LINK.test(body)) {
        return sendToContact(db, contact, {
          text:
            `Got it — our team is pricing that now and your quote will come through here shortly.\n\n` +
            `While you wait: where should the parcel go? A delivery address (estate/building, street, town), or the area you'd like to collect in — we'll confirm the nearest Pickup Mtaani point.`,
        });
      }
      // "CBD collection" is an answer, not an address: it names a method,
      // and the parcel comes to our counter. Storing it in
      // delivery_address made the ops screens read as though a rider had
      // somewhere to go, and told the quote nothing about the fee — the
      // one thing the answer actually decides. Read first, too, because
      // "I will collect it myself" was being taken for a question and
      // handed to a person while the customer waited for a code.
      const collecting = saysDeliveryMethod(body) === 'collection';
      if (!collecting && looksLikeQuestion(body)) {
        return answerScriptedQuestion(db, contact, body,
          `We'll only need to know where to send the parcel once you're happy to go ahead.`);
      }
      if (!collecting && !looksLikeDestination(body)) {
        return sendToContact(db, contact, {
          text: `Please tell us where the parcel should go — a delivery address (estate/building, street and town), or the area you'd like to collect in.`,
        });
      }
      // Last question. There used to be one more, for an M-Pesa number we
      // never needed: payments are read off the M-Pesa statement.
      const customerCode = await nextCustomerCode(db);
      await setState(db, contact.id, 'active', {
        ...(collecting
          ? { delivery_preference: 'collection' }
          : { delivery_address: body.slice(0, 400) }),
        customer_code: customerCode,
      });
      pushToStaff('wa_new_customer', {
        contact_id: contact.id,
        customer_code: customerCode,
        full_name: contact.full_name,
        phone: contact.phone,
      });
      notifyStaff(db, {
        title: 'New customer onboarded',
        detail: `${contact.full_name || contact.phone} — ${customerCode}`,
        dedupeKey: `onboarded:${contact.id}`,
      });
      return sendToContact(db, contact, {
        templateKey: 'onboarded',
        templateParams: { customer_code: customerCode },
        text:
          `You're all set. Your customer code is *${customerCode}* — keep it handy, it goes on all your parcels.\n\n` +
          (collecting ? `You're collecting, so there's no delivery fee — we'll message you the moment your parcel is ready.\n\n` : '') +
          `${await signOffLine(db, contact.id)}`,
      });
    }

    default:
      return; // 'blocked' handled upstream; unknown states stay silent
  }
}

// ── Status self-service ─────────────────────────────────────────────────────
//
// Answers a TRK code (the parcel) or an ORD number (the order). Both are
// scoped to the contact who sent them — see the note on enumeration
// below.

async function replyOrderStatus(db, contact, code) {
  const { rows } = await db.query(
    `SELECT o.*, c.customer_code
       FROM wa_orders o
       JOIN wa_contacts c ON c.id = o.contact_id
      WHERE o.tracking_code = $1 OR o.order_code = $1`,
    [code]
  );
  const order = rows[0];
  // Codes are sequential, so an unscoped reply let any onboarded contact
  // walk TRK-8800, TRK-8801, … (and now ORD-3001, ORD-3002, …) and read
  // every order's status, milestone dates and outstanding fee. The order
  // number needs this at least as much as the tracking code did: it
  // exists from the moment an order is created, so the range that
  // resolves is every order the business has ever taken, priced or not.
  // A code that isn't yours gets the same wording as one that doesn't
  // exist — the difference is nobody's business — and a person can still
  // help with the legitimate checking-for-a-friend case.
  if (!order || order.contact_id !== contact.id) {
    return sendToContact(db, contact, {
      text:
        `We couldn't find an order with code ${code} on this number — double-check the code ` +
        `on your quote or receipt. If you're checking an order for someone else, reply here and our team will help.`,
    });
  }

  return sendToContact(db, contact, { text: parcelStateSentence(order, code) });
}

/**
 * Where the order is, in a sentence or two. That is the entire question
 * behind "TRK-8822?" or "ORD-3001?" — an earlier version answered with a
 * status label, a progress bar, a next-step line and the amount paid,
 * which restated the same fact three times and buried it. Each status
 * owns its own wording so the update reads like a person wrote it.
 *
 * `code` is whichever code the customer used, echoed back so they can
 * see we are answering about the thing they asked about.
 */
function parcelStateSentence(order, code) {
  const on = (d) => (d ? ` on ${new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'long' })}` : '');
  const feeDue = order.status === 'delivery_fee_pending' && !order.delivery_fee_waived
    && !order.delivery_fee_paid_at && Number(order.delivery_fee_kes) > 0;

  switch (order.status) {
    case 'paid':
      return `${code} — we received your payment${on(order.paid_at)} and we're buying your item now. `
        + `We'll let you know the moment it's purchased.`;

    case 'purchased':
      // The 2–3 week stretch with nothing to say is where "where is my
      // parcel?" volume comes from — a coarse honest window beats
      // repeating the same sentence with no horizon.
      return `${code} — your item was purchased${on(order.purchased_at)} and is on its way to our facility. `
        + `Most parcels land in Kenya within 14 to 21 days of purchase — we'll message you the moment yours does.`;

    case 'in_kenya':
      // A customer who chose to collect is not waiting on a rider, and
      // telling them one is coming sends them to the wrong place.
      return order.delivery_method === 'collection'
        ? `${code} — your parcel arrived${on(order.arrived_at)} and is ready to collect at `
          + `Stanbank House, 4th floor, room 28, Nairobi CBD. We're open Monday to Saturday, closed Sunday.`
        : `${code} — your parcel arrived in Kenya${on(order.arrived_at)}. `
          + `We're getting it ready and will send it on to you shortly.`;

    case 'delivery_fee_pending':
      return feeDue
        ? `${code} — your parcel arrived in Kenya${on(order.arrived_at)} and is ready to send out. `
          + `Last step is the delivery fee of KSh ${Number(order.delivery_fee_kes).toLocaleString('en-KE')}: `
          + `Lipa na M-Pesa, Buy Goods, Till ${mpesaTill()}. Reply here once you've paid and we'll dispatch it.`
        : `${code} — your parcel arrived in Kenya${on(order.arrived_at)} and will be dispatched to your address shortly.`;

    case 'collected':
      return `${code} — you collected this${on(order.delivered_at)}. `
        + `Asante for shopping with Thapsus Cargo. Send us another link any time.`;

    case 'dispatched':
      return `${code} — your parcel went out for delivery${on(order.dispatched_at)}. `
        + `Our rider will call you when they arrive, usually within 24 hours.`;

    case 'delivered':
      return `${code} — delivered${on(order.delivered_at)}. Asante for shopping with Thapsus Cargo. `
        + `Send us another link whenever you're ready.`;

    case 'cancelled':
      return `${code} — this order was cancelled. Reply here if that's unexpected and we'll sort it out.`;

    // Pre-payment states used to be all but unreachable here — the code
    // was minted when the payment settled — so all three shared one
    // sentence: "we're still finalising your quote. We'll send it here
    // shortly." Order numbers make these the states this lookup answers
    // MOST often, and that sentence was wrong in two ways at once for a
    // quoted order: the quote is not being finalised, it was sent, and
    // the reply promised a message behind it that nothing was going to
    // send. That is the shape of the eighteen hours +254790325255 spent
    // being told her quote was coming. Every figure below is read off
    // the order row; nothing here computes a total.
    case 'confirmed': {
      const due = Number(order.quote_kes);
      const till = mpesaTill();
      return due > 0
        ? `${code} — confirmed, and we start buying the moment your payment lands. `
          + `Total: KSh ${due.toLocaleString('en-KE')}. `
          + `Lipa na M-Pesa, Buy Goods${till ? `, Till ${till}` : ''}. `
          + `Reply here once you've paid and we'll confirm it.`
        : `${code} — confirmed. Reply here if you need the payment details.`;
    }

    case 'quoted': {
      const total = Number(order.quote_kes);
      return total > 0
        ? `${code} — your quote is KSh ${total.toLocaleString('en-KE')}`
          + (order.quote_expires_at
            ? `, held until ${new Date(order.quote_expires_at)
              .toLocaleDateString('en-KE', { day: 'numeric', month: 'long' })}`
            : '')
          + `. Reply *YES* to confirm and we'll send the M-Pesa details.`
        : `${code} — your quote is with you and we're waiting on your go-ahead.`;
    }

    case 'quoting':
      // No price yet, and no promise of when one arrives: the only thing
      // watching a 'quoting' order is a person.
      return `${code} — we have your item and we're working out the price. `
        + `Nothing is needed from you yet.`;

    default:
      return `${code} — ${STATUS_LABEL[order.status] || order.status}. Reply here if you need anything else.`;
  }
}

