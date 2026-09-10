// utils/waCodes.js
//
// Customer Codes (TC-1042), Order Numbers (ORD-3001) and Tracking Codes
// (TRK-8821) for the WhatsApp flow. All three are short, human-friendly,
// and sequential — customers read them aloud, type them into chats, and
// operators write them onto parcels ("John Doe - TC-1042"), so the long
// random formats used by the legacy `orders.tracking_number` column are
// exactly wrong here.
//
// The three name different things and are minted at different moments:
//
//   TC-1042   the customer      — when they give us a name
//   ORD-3001  the order         — when the order is created, always
//   TRK-8821  the parcel        — when the payment settles
//
// Order numbers have no mint function here on purpose. They come from a
// DEFAULT on wa_orders.order_code (migration 0021) so that every row
// gets one whatever inserted it — a rule enforced only at the one call
// site you remembered is the rule that isn't enforced on the day
// somebody adds a second one.
//
// Sequences (`wa_customer_code_seq`, `wa_order_code_seq`,
// `wa_tracking_code_seq`) make collisions impossible by construction —
// nextval() never returns the same value twice, even across concurrent
// transactions. The UNIQUE constraints on wa_contacts.customer_code,
// wa_orders.order_code and wa_orders.tracking_code remain the backstop
// against hand-inserted rows.
//
// Enumerability: codes are guessable by design (spec'd that way). The
// public tracking endpoint only ever reveals status + timeline and sits
// behind the tracking rate limiter, so a guessed code leaks nothing
// personal. It resolves TRK codes only: an order number exists from the
// moment an order does, so ORD-#### would open the whole pre-payment
// pipeline to anyone counting upwards. Inbound WhatsApp answers ORD
// codes, scoped to the contact who sent them.

/** @returns {Promise<string>} e.g. "TC-1042" */
export async function nextCustomerCode(db) {
  const { rows } = await db.query(`SELECT nextval('wa_customer_code_seq') AS n`);
  return `TC-${rows[0].n}`;
}

/** @returns {Promise<string>} e.g. "TRK-8821" */
export async function nextTrackingCode(db) {
  const { rows } = await db.query(`SELECT nextval('wa_tracking_code_seq') AS n`);
  return `TRK-${rows[0].n}`;
}

/**
 * Normalize free-text a customer might send ("trk 8821", "TRK-8821",
 * "Trk8821") to the canonical code, or null if the text doesn't contain
 * one. Used by the inbound state machine for tracking auto-replies.
 */
export function extractTrackingCode(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bTRK[\s-]?(\d{3,12})\b/i);
  return m ? `TRK-${m[1]}` : null;
}

/**
 * Same normalization for order numbers ("ord 3001", "ORD3001" →
 * "ORD-3001"). The customer is given this number on the quote and on the
 * payment prompt — months before a tracking code exists — so it is the
 * code they have to hand when they write in to ask where things are.
 */
export function extractOrderCode(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bORD[\s-]?(\d{3,12})\b/i);
  return m ? `ORD-${m[1]}` : null;
}

/** Same normalization for customer codes ("tc 1042" → "TC-1042"). */
export function extractCustomerCode(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bTC[\s-]?(\d{3,12})\b/i);
  return m ? `TC-${m[1]}` : null;
}
