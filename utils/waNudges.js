// utils/waNudges.js
//
// Revenue follow-ups. The conversation data for the first month said one
// thing loudly: the assistant answers instantly and accurately, and then
// nobody ever follows up. Twenty-six warm leads active in a single week
// were left after OUR reply ("feel free to send your cart whenever
// you're ready") and never touched again; every stalled quote had zero
// messages from us after the quote went out. WhatsApp gives a free
// 24-hour customer-service window after every inbound message — these
// nudges spend it.
//
// Three customer nudges + one staff page, all run from the sweeper:
//
//   1. Quote follow-up   — a quote 4–48h old with no customer reply gets
//                          one "we're holding it for you" message.
//   2. Browse-abandon    — a contact who asked about the service, got an
//                          answer, and sent no cart within ~16h gets one
//                          how-to-share-your-cart message before their
//                          window shuts. At most once per 14 days.
//   3. Repeat purchase   — a customer whose parcel was delivered or
//                          collected 20–72h ago, with nothing else in
//                          flight, gets one "anything else on your list?".
//   4. Stalled-quote staff page — a quote unanswered for 48h is a
//                          person's job now: a personal touch closes what
//                          a bot can't. Paged once, audit-trail claimed.
//
// Rules every nudge obeys:
//   - One send each, claimed BEFORE sending (audit event / transcript
//     marker) so a crash never double-nudges.
//   - Free text only inside the 24-hour window. The quote follow-up can
//     go out-of-window ONLY once a 'quote_reminder' template is approved
//     and mapped in Settings (see utils/waTemplateVars.js).
//   - Never while a human holds the thread, never to blocked contacts.
//   - Promotions come from wa_settings.promo_message — copy never
//     invents an offer or a date.
//   - Kill switch: wa_settings.nudges_enabled.

import { sendToContact, sessionWindowOpen } from './waSend.js';
import { getWaSettings } from './waSettings.js';
import { notifyStaff } from './waStaffAlert.js';

const MIN = 60_000;

const QUOTE_NUDGE_NOTE = 'Quote follow-up sent';
const REPEAT_NUDGE_NOTE = 'Repeat-purchase nudge sent';
// Stable phrase inside the browse-abandon message — how we recognise a
// contact already got one recently (same mechanism as the state
// machine's sentRecently markers).
export const BROWSE_NUDGE_MARKER = 'nothing to pay until you have seen and accepted the quote';

const kes = (v) => Number(v).toLocaleString('en-KE');
const dayOf = (d) => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'long' });

export async function runNudges(pool) {
  let settings;
  try { settings = await getWaSettings(pool); } catch { return; }
  if (!settings.nudges_enabled) return;
  await Promise.allSettled([
    quoteFollowUps(pool, settings),
    browseAbandonNudges(pool, settings),
    repeatPurchaseNudges(pool, settings),
    stalledQuoteStaffPage(pool),
  ]);
}

/** The promo line, only when a promotion is actually configured. */
function promoLine(settings) {
  return settings.promo_active && settings.promo_message
    ? `\n${settings.promo_message}` : '';
}

// ── 1. Quote follow-up ──────────────────────────────────────────────────────
// "Will get back to you when I'm ready" used to be answered with "take
// your time!" and then permanent silence. One nudge, while the quote is
// young and the window is (usually) still open from the cart link they
// sent.
async function quoteFollowUps(pool, settings) {
  const { rows } = await pool.query(
    `SELECT o.id, o.quote_kes, o.quote_expires_at, o.tracking_code, o.order_code,
            c.id AS contact_id, c.phone, c.full_name
       FROM wa_orders o JOIN wa_contacts c ON c.id = o.contact_id
      WHERE o.status = 'quoted'
        AND o.quoted_at < NOW() - interval '4 hours'
        AND o.quoted_at > NOW() - interval '48 hours'
        AND (o.quote_expires_at IS NULL OR o.quote_expires_at > NOW())
        AND c.state <> 'blocked' AND c.human_takeover_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM wa_messages m
                         WHERE m.contact_id = c.id AND m.direction = 'in'
                           AND m.created_at > o.quoted_at)
        AND NOT EXISTS (SELECT 1 FROM wa_order_events e
                         WHERE e.order_id = o.id AND e.note = '${QUOTE_NUDGE_NOTE}')
      ORDER BY o.quoted_at ASC
      LIMIT 10`
  );
  for (const o of rows) {
    // Out-of-window free text is refused outright; only proceed when the
    // window is open or an approved quote_reminder template can carry it.
    const templateMapped = Boolean(settings.template_map?.quote_reminder);
    if (!templateMapped && !await sessionWindowOpen(pool, o.contact_id)) continue;

    // Claim before sending — a crash mid-loop nudges zero times, not two.
    await pool.query(
      `INSERT INTO wa_order_events (id, order_id, from_status, to_status, note)
       VALUES (gen_random_uuid()::text, $1, 'quoted', 'quoted', '${QUOTE_NUDGE_NOTE}')`,
      [o.id]
    );

    const amount = kes(o.quote_kes);
    await sendToContact(pool, { id: o.contact_id, phone: o.phone }, {
      templateKey: 'quote_reminder',
      templateParams: {
        full_name: o.full_name,
        // A quoted order has no tracking code — that is minted at
        // payment — so this said "your order" to every customer it has
        // ever chased. The order number exists from creation, and a
        // customer holding two open quotes could not tell which one this
        // was about.
        order_ref: o.tracking_code || o.order_code || 'your order',
        total_kes: amount,
      },
      text:
        `Just checking in — your quote of *KSh ${amount}* is ready and we're holding it for you.` +
        (o.quote_expires_at ? ` It's locked in until ${dayOf(o.quote_expires_at)}.` : '') +
        promoLine(settings) + `\n\n` +
        `Reply *YES* to confirm and we'll send the M-Pesa details — your order goes out for purchase the same day. ` +
        `If you'd like to change anything first, just send an updated cart and we'll re-quote it.`,
    });
    console.info(`[wa-nudges] quote follow-up sent for order ${o.id}`);
  }
}

// ── 2. Browse-abandon ───────────────────────────────────────────────────────
// The biggest pool in the funnel: people who asked "is the SHEIN promo
// on?", got a good answer, and never sent a cart. Their last inbound is
// 16–23 hours old — quiet long enough to mean they drifted, young enough
// that free text still delivers.
async function browseAbandonNudges(pool, settings) {
  const { rows } = await pool.query(
    `SELECT c.id, c.phone, c.full_name
       FROM wa_contacts c
       JOIN LATERAL (
         SELECT max(m.created_at) AS last_in FROM wa_messages m
          WHERE m.contact_id = c.id AND m.direction = 'in'
       ) li ON true
      WHERE c.state <> 'blocked' AND c.human_takeover_at IS NULL
        AND li.last_in BETWEEN NOW() - interval '23 hours' AND NOW() - interval '16 hours'
        AND NOT EXISTS (SELECT 1 FROM wa_orders o WHERE o.contact_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM wa_messages m
                         WHERE m.contact_id = c.id AND m.direction = 'in'
                           AND m.body ~* 'https?://')
        AND NOT EXISTS (SELECT 1 FROM wa_messages m
                         WHERE m.contact_id = c.id AND m.direction = 'out'
                           AND m.body LIKE '%${BROWSE_NUDGE_MARKER}%'
                           AND m.created_at > NOW() - interval '14 days')
      LIMIT 10`
  );
  for (const c of rows) {
    await sendToContact(pool, { id: c.id, phone: c.phone }, {
      text:
        `Karibu again${c.full_name ? ` ${String(c.full_name).split(/\s+/)[0]}` : ''}! ` +
        `Still thinking it over? Getting a quote takes two minutes: on SHEIN, open your cart, ` +
        `tap the three dots at the top right and *Share* — send us that link and we'll reply ` +
        `with your total in KSh within the hour.` +
        promoLine(settings) + `\n\n` +
        `There's ${BROWSE_NUDGE_MARKER}.`,
    });
    console.info(`[wa-nudges] browse-abandon nudge sent to contact ${c.id}`);
  }
}

// ── 3. Repeat purchase ──────────────────────────────────────────────────────
// A customer who just had a good delivery is the cheapest sale there is.
// One message inside the window their pickup/delivery chatter opened,
// only when nothing else of theirs is in flight.
async function repeatPurchaseNudges(pool, settings) {
  const { rows } = await pool.query(
    `SELECT o.id, o.tracking_code,
            c.id AS contact_id, c.phone, c.full_name, c.customer_code
       FROM wa_orders o JOIN wa_contacts c ON c.id = o.contact_id
      WHERE o.status IN ('delivered', 'collected')
        AND o.delivered_at BETWEEN NOW() - interval '72 hours' AND NOW() - interval '20 hours'
        AND c.state <> 'blocked' AND c.human_takeover_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM wa_orders live
                         WHERE live.contact_id = c.id
                           AND live.status NOT IN ('delivered', 'collected', 'cancelled'))
        AND NOT EXISTS (SELECT 1 FROM wa_order_events e
                         WHERE e.order_id = o.id AND e.note = '${REPEAT_NUDGE_NOTE}')
      LIMIT 10`
  );
  for (const o of rows) {
    if (!await sessionWindowOpen(pool, o.contact_id)) continue;
    await pool.query(
      `INSERT INTO wa_order_events (id, order_id, from_status, to_status, note)
       SELECT gen_random_uuid()::text, $1, status, status, '${REPEAT_NUDGE_NOTE}'
         FROM wa_orders WHERE id = $1`,
      [o.id]
    );
    await sendToContact(pool, { id: o.contact_id, phone: o.phone }, {
      text:
        `Asante for shopping with Thapsus Cargo — we hope you love your order.` +
        promoLine(settings) + `\n\n` +
        `If there's anything else on your list, just send the link or cart here` +
        (o.customer_code ? ` — you're already set up as ${o.customer_code}, so the next one is even quicker.` : `.`),
    });
    console.info(`[wa-nudges] repeat-purchase nudge sent for order ${o.id}`);
  }
}

// ── 4. Stalled quotes are a person's job on day 2 ───────────────────────────
// The bot's follow-up went on day 1. A quote still unanswered after 48
// hours needs a human's "anything holding you back?" — ONE page per
// quote, claimed in the audit trail first. (Expiry itself is paged
// separately by the sweeper, also once.)
async function stalledQuoteStaffPage(pool) {
  const { rows } = await pool.query(
    `SELECT o.id, o.quote_kes, o.quoted_at, c.full_name, c.phone, c.customer_code
       FROM wa_orders o JOIN wa_contacts c ON c.id = o.contact_id
      WHERE o.status = 'quoted'
        AND o.quoted_at < NOW() - interval '48 hours'
        AND (o.quote_expires_at IS NULL OR o.quote_expires_at > NOW())
        AND NOT EXISTS (SELECT 1 FROM wa_order_events e
                         WHERE e.order_id = o.id AND e.note = 'Stalled-quote staff page sent')
      ORDER BY o.quoted_at ASC
      LIMIT 10`
  );
  for (const o of rows) {
    await pool.query(
      `INSERT INTO wa_order_events (id, order_id, from_status, to_status, note)
       VALUES (gen_random_uuid()::text, $1, 'quoted', 'quoted', 'Stalled-quote staff page sent')`,
      [o.id]
    );
    const days = Math.round((Date.now() - new Date(o.quoted_at).getTime()) / (24 * 60 * MIN));
    await notifyStaff(pool, {
      title: 'Quote needs a personal follow-up',
      detail: `${o.full_name || o.phone} (${o.customer_code || 'no code'}) has had a KSh ${kes(o.quote_kes)} quote `
        + `for ${days} day(s) with no answer. A personal "anything holding you back?" closes what the bot can't. `
        + `This reminder won't repeat.`,
      dedupeKey: `quote-stalled:${o.id}`,
    });
  }
}
