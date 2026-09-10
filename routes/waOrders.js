// routes/waOrders.js
//
// Operator API for the WhatsApp order pipeline (Quoting → Paid →
// Purchased → In Kenya → Delivered). Every mutation that talks money or
// status funnels through the shared helpers — quote math is computed
// server-side from the live USD→KES rate + settings markup, payments ride
// the same payments-table machinery as the legacy flow (Lipana STK or
// manual admin approval), and status changes go through
// utils/waOrderFlow.transition() so customer alerts can't be skipped.

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { logRouteError } from '../utils/errorLogger.js';
import { getUsdToKesRate, FxRateUnavailableError } from '../utils/fx.js';
import { getWaSettings } from '../utils/waSettings.js';
import { deliveryFeeFor, effectiveFxRate, resolveMarkupPct, switchDeliveryMethod } from '../utils/waQuote.js';
import { normalizeProductLinks } from '../utils/productLinks.js';
import { transition, isValidEdge, sendCustomerStatusMessage } from '../utils/waOrderFlow.js';
import { sendToContact } from '../utils/waSend.js';
import { extractTrackingCode, extractOrderCode, extractCustomerCode, nextTrackingCode } from '../utils/waCodes.js';
import { createSignedDownloadUrl } from '../utils/supabaseAdmin.js';
import { receiptShortUrl, receiptToken } from '../utils/receiptLink.js';
import { markPaymentPaid } from '../utils/markPaymentPaid.js';
import {
  attachMpesaReference, ensureManualPayment, extractMpesaReference,
  findOpenOrderPayment, mpesaTill,
} from '../utils/waPayments.js';
import {
  initiateStkPush as lipanaInitiateStkPush,
  normalizeKenyanPhone,
  LipanaError,
} from '../utils/lipanaClient.js';
import { pushToStaff } from './events.js';

const router = express.Router();
const STAFF = requireRole('operator'); // admins pass via requireRole's bypass

const MPESA_TILL = mpesaTill();

/**
 * What to call an order in a message. Tracking codes only exist from
 * payment onward, so before that use the imported/original reference in
 * product_note (a migrated 254shippers customer already knows that one),
 * then the order number.
 *
 * The order number is why the last fallback is now unreachable in
 * practice: order_code is NOT NULL with a default (migration 0021).
 * Until it existed this function answered `#a3f9c2b1` — the first eight
 * characters of the row's uuid — and that string went out on real quotes
 * and real payment prompts as order_ref. Nobody reads that back to us,
 * and nobody can search for it either. The `#` branch stays only for a
 * partially-selected row.
 */
function orderRef(order) {
  if (order.tracking_code) return order.tracking_code;
  const noted = String(order.product_note || '').match(/^[A-Z]{2,4}-[\d-]+/);
  if (noted) return noted[0];
  return order.order_code || `#${String(order.id).slice(0, 8)}`;
}

/**
 * STK Push is only offered when an M-Pesa API provider is actually wired
 * up. Lipana withdrew service (regulatory), so production runs
 * MPESA_PROVIDER=manual: the customer pays the till and an admin approves
 * the payment by hand. Surfaced to the dashboard so the STK button hides.
 */
function stkAvailable() {
  return String(process.env.MPESA_PROVIDER || 'manual').toLowerCase().trim() === 'lipana';
}

const ORDER_SELECT = `
  SELECT o.*, c.phone, c.full_name, c.customer_code, c.delivery_address,
         c.mpesa_number, c.delivery_preference
    FROM wa_orders o
    JOIN wa_contacts c ON c.id = o.contact_id`;

/**
 * GET /api/wa/orders?status=&q=&limit=&offset=
 * Pipeline board + global search. `q` matches TRK-/TC- codes (any
 * formatting), names, and phone digits.
 */
router.get('/', authMiddleware, STAFF, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim();

    const where = [];
    const params = [];
    if (status) {
      params.push(status.split(',').map((s) => s.trim()).filter(Boolean));
      where.push(`o.status = ANY($${params.length}::text[])`);
    }
    if (q) {
      const trk = extractTrackingCode(q);
      const ord = extractOrderCode(q);
      const tc = extractCustomerCode(q);
      if (trk) {
        params.push(trk);
        where.push(`o.tracking_code = $${params.length}`);
      } else if (ord) {
        params.push(ord);
        where.push(`o.order_code = $${params.length}`);
      } else if (tc) {
        params.push(tc);
        where.push(`c.customer_code = $${params.length}`);
      } else {
        // A supplier reference typed in full is almost never also
        // somebody's name, so match it exactly first: that returns the
        // whole batch that went into one purchase, in one search, rather
        // than whatever else happens to contain the string.
        params.push(q);
        const exact = `lower(o.supplier_ref) = lower($${params.length})`;
        params.push(`%${q}%`);
        const like = params.length;
        where.push(`(${exact} OR c.full_name ILIKE $${like} OR c.phone LIKE $${like}`
          + ` OR c.customer_code ILIKE $${like} OR o.tracking_code ILIKE $${like}`
          + ` OR o.order_code ILIKE $${like} OR o.supplier_ref ILIKE $${like})`);
      }
    }
    params.push(limit, offset);
    const { rows } = await req.db.query(
      `${ORDER_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY o.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ success: true, orders: rows, limit, offset });
  } catch (err) {
    logRouteError(req, res, err, 'GET /api/wa/orders');
    res.status(500).json({ success: false, message: 'Failed to load orders' });
  }
});

/**
 * POST /api/wa/orders/supplier-ref
 *   { order_ids: string[], supplier_ref: string|null }
 *
 * Tag one or many of our orders with the retailer's own order number, so
 * "what was in SHEIN order SO12345678?" is a search rather than a
 * memory. One call covers both cases — tagging a single order and
 * tagging the whole batch that went into one purchase are the same
 * operation, and splitting them into two endpoints would only invite
 * them to drift.
 *
 * Passing null or an empty string clears the reference.
 */
router.post('/supplier-ref', authMiddleware, STAFF, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.order_ids)
      ? [...new Set(req.body.order_ids.filter((v) => typeof v === 'string' && v))]
      : [];
    if (ids.length === 0 || ids.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Pick between 1 and 100 orders to tag',
      });
    }

    const raw = typeof req.body?.supplier_ref === 'string' ? req.body.supplier_ref.trim() : '';
    // Stored as typed — a supplier reference is their identifier, not
    // ours, and mangling the case makes it harder to match against their
    // paperwork. Searching is case-insensitive instead.
    const ref = raw ? raw.slice(0, 64) : null;
    if (raw && !/^[\w./#-]{3,64}$/.test(raw)) {
      return res.status(400).json({
        success: false,
        message: 'That does not look like an order number — letters, digits, . / # - only',
      });
    }

    const client = await req.db.connect();
    let orders;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE wa_orders SET supplier_ref = $2, updated_at = NOW()
          WHERE id = ANY($1::text[]) RETURNING id, tracking_code, supplier_ref`,
        [ids, ref]
      );
      orders = rows;
      // The history is where an operator reconstructs what happened, and
      // "which supplier order was this in" is exactly the kind of thing
      // that gets asked weeks later.
      for (const o of rows) {
        await client.query(
          `INSERT INTO wa_order_events (id, order_id, from_status, to_status, actor_user_id, note)
           SELECT $1, $2, status, status, $3, $4 FROM wa_orders WHERE id = $2`,
          [uuidv4(), o.id, req.user.id,
           ref ? `Tagged to supplier order ${ref}` : 'Supplier order reference cleared']
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: 'No matching orders' });
    }
    res.json({ success: true, supplier_ref: ref, updated: orders.length, orders });
  } catch (err) {
    logRouteError(req, res, err, 'POST /api/wa/orders/supplier-ref');
    res.status(500).json({ success: false, message: 'Failed to tag the orders' });
  }
});

/**
 * GET /api/wa/orders/quote-defaults — the live inputs a quote is built
 * from, so the dashboard can show the KES total BEFORE the quote is
 * sent. Quoting was the one irreversible customer-facing action with no
 * preview: the operator typed a USD figure and the arithmetic was only
 * visible after the customer had already been told the number.
 * Staff-accessible on purpose — /api/wa/settings is admin-only and
 * carries far more than a preview needs.
 */
router.get('/quote-defaults', authMiddleware, STAFF, async (req, res) => {
  try {
    const [{ rate }, settings] = await Promise.all([
      getUsdToKesRate(req.db),
      getWaSettings(req.db),
    ]);
    // usd_kes is the rate a quote is PRICED at (mid + the FX buffer), so
    // the preview arithmetic matches what the customer is sent to the
    // shilling. usd_kes_mid and fx_buffer_pct ride alongside it so the
    // operator can see the cushion rather than wonder why the dashboard
    // rate differs from the one on their banking app.
    const { rate: quoteRate, error: fxError } = effectiveFxRate(rate, settings.fx_buffer_pct);
    if (fxError) return res.status(500).json({ success: false, message: fxError });
    res.json({
      success: true,
      usd_kes: quoteRate,
      usd_kes_mid: Number(rate),
      fx_buffer_pct: Number(settings.fx_buffer_pct),
      markup_pct_default: Number(settings.markup_pct),
      default_delivery_fee_kes: Number(settings.default_delivery_fee_kes),
      quote_validity_days: Number(settings.quote_validity_days),
    });
  } catch (err) {
    if (err instanceof FxRateUnavailableError) {
      return res.status(err.status).json({ success: false, error: err.code, message: err.message });
    }
    logRouteError(req, res, err, 'GET /api/wa/orders/quote-defaults');
    res.status(500).json({ success: false, message: 'Failed to load quote defaults' });
  }
});

/**
 * POST /api/wa/orders/advance-batch  { order_ids[], to_status, note? }
 *
 * The flight-landed case: forty parcels arrive at once and every one
 * needs 'in_kenya'. That used to be forty round-trips through the order
 * screen. Each order still goes through transition() individually — the
 * edge validation, audit rows, and the customer's arrival message all
 * fire exactly as a single advance would — and the response reports
 * per-order outcomes so a mixed batch (one already moved, one a
 * collection order) fails only where it should.
 */
router.post('/advance-batch', authMiddleware, STAFF, async (req, res) => {
  try {
    const to = String(req.body?.to_status || '').trim();
    if (!['quoted', 'confirmed', 'purchased', 'in_kenya', 'dispatched', 'delivered', 'collected', 'cancelled'].includes(to)) {
      return res.status(400).json({ success: false, message: `to_status '${to}' is not operator-advanceable` });
    }
    const ids = Array.isArray(req.body?.order_ids)
      ? [...new Set(req.body.order_ids.filter((v) => typeof v === 'string' && v))]
      : [];
    if (ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ success: false, message: 'Pick between 1 and 100 orders' });
    }

    const results = [];
    for (const id of ids) {
      // Same fee guard as the single-advance route: never dispatch with
      // an unsettled, unwaived delivery fee.
      if (to === 'dispatched') {
        const { rows } = await req.db.query(
          `SELECT status, delivery_fee_waived, delivery_fee_paid_at, delivery_fee_kes
             FROM wa_orders WHERE id = $1`, [id]
        );
        const o = rows[0];
        if (o && o.status === 'delivery_fee_pending'
            && !o.delivery_fee_waived && !o.delivery_fee_paid_at && Number(o.delivery_fee_kes) > 0) {
          results.push({ id, ok: false, reason: 'delivery fee unpaid' });
          continue;
        }
      }
      const r = await transition(req.db, id, to, {
        actorUserId: req.user.id,
        note: req.body?.note || null,
      });
      results.push({ id, ok: r.ok, status: r.status, reason: r.ok ? undefined : r.reason });
    }

    const advanced = results.filter((r) => r.ok).length;
    res.json({ success: true, advanced, failed: results.length - advanced, results });
  } catch (err) {
    logRouteError(req, res, err, 'POST /api/wa/orders/advance-batch');
    res.status(500).json({ success: false, message: 'Batch advance failed' });
  }
});

/**
 * GET /api/wa/orders/scan/:code — scanner/search resolver. Accepts a TRK
 * or ORD code in any formatting; returns the order for the detail
 * screen. ORD is here because an operator holding a quote the customer
 * has quoted back at them has an order number and no parcel yet.
 */
router.get('/scan/:code', authMiddleware, STAFF, async (req, res) => {
  try {
    const code = extractTrackingCode(req.params.code) || extractOrderCode(req.params.code)
      || req.params.code.trim().toUpperCase();
    const { rows } = await req.db.query(
      `${ORDER_SELECT} WHERE o.tracking_code = $1 OR o.order_code = $1`, [code]);
    if (!rows[0]) return res.status(404).json({ success: false, message: `No order with code ${code}` });
    res.json({ success: true, order: rows[0] });
  } catch (err) {
    logRouteError(req, res, err, 'GET /api/wa/orders/scan/:code');
    res.status(500).json({ success: false, message: 'Scan lookup failed' });
  }
});

// Which timestamp column each stage stamps, and everything a stage
// implies has already happened. An order logged as 'in_kenya' was also
// quoted, paid and purchased — backfilling those keeps the customer's
// tracking reply and the receipt honest.
const STAGE_ORDER = ['quoting', 'quoted', 'confirmed', 'paid', 'purchased', 'in_kenya', 'delivery_fee_pending', 'dispatched', 'delivered'];
const STAGE_STAMP = {
  quoted: 'quoted_at', confirmed: 'confirmed_at', paid: 'paid_at',
  purchased: 'purchased_at', in_kenya: 'arrived_at',
  delivery_fee_pending: 'arrived_at', dispatched: 'dispatched_at',
  delivered: 'delivered_at',
};

/**
 * POST /api/wa/orders
 *   { contact_id, product_links[], product_note?,
 *     status?, quote_kes?, delivery_fee_kes?, notify? }
 *
 * Normally an order starts at 'quoting' and walks the pipeline. But work
 * arrives mid-flight — someone paid by hand last week, a parcel is
 * already in the Nairobi office, a customer came from Instagram with an
 * order half-done. `status` drops the order in at that stage instead.
 *
 * Starting past 'confirmed' needs a `quote_kes`, because every later
 * stage tells the customer an amount, and 'paid' onwards mints a tracking
 * code — the code is the customer's handle on a parcel and must exist the
 * moment money has changed hands.
 *
 * The order number (ORD-3001) is not minted here: it is a column default
 * (migration 0021), so it exists for every order this or any other code
 * path creates, and comes back on the RETURNING row.
 *
 * Silent by default: back-filling history should not text somebody about
 * a parcel they received a week ago. Pass `notify: true` to send the
 * stage's message anyway.
 */
router.post('/', authMiddleware, STAFF, async (req, res) => {
  try {
    const { contact_id, product_links, product_note } = req.body || {};
    if (!contact_id || typeof contact_id !== 'string') {
      return res.status(400).json({ success: false, message: 'contact_id is required' });
    }
    // Same rules as the edit route (utils/productLinks.js): trimmed,
    // schemes added, de-duplicated, and junk refused rather than saved
    // as though it were a product.
    const { links, error: linkError } = normalizeProductLinks(product_links ?? []);
    if (linkError) return res.status(400).json({ success: false, message: linkError });
    const { rows: contactRows } = await req.db.query(
      `SELECT id, phone, full_name FROM wa_contacts WHERE id = $1`, [contact_id]
    );
    const contact = contactRows[0];
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    const status = String(req.body?.status || 'quoting');
    const stage = STAGE_ORDER.indexOf(status);
    if (stage < 0) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${STAGE_ORDER.join(', ')}`,
      });
    }

    const quoteKes = req.body?.quote_kes != null ? Math.round(Number(req.body.quote_kes)) : null;
    if (stage >= STAGE_ORDER.indexOf('confirmed') && !(quoteKes > 0)) {
      return res.status(400).json({
        success: false,
        message: `An order starting at '${status}' needs quote_kes — the customer is told this amount.`,
      });
    }
    const feeKes = req.body?.delivery_fee_kes != null ? Math.round(Number(req.body.delivery_fee_kes)) : null;

    // An order logged after the fact has usually already been bought, so
    // the supplier's number is known at creation time.
    const supplierRefRaw = typeof req.body?.supplier_ref === 'string' ? req.body.supplier_ref.trim() : '';
    if (supplierRefRaw && !/^[\w./#-]{3,64}$/.test(supplierRefRaw)) {
      return res.status(400).json({
        success: false,
        message: 'That does not look like an order number — letters, digits, . / # - only',
      });
    }
    const supplierRef = supplierRefRaw || null;

    // Stamp this stage and everything it implies, so the timeline reads
    // as a real history rather than one lonely date.
    const stamps = {};
    for (const s of STAGE_ORDER.slice(0, stage + 1)) {
      if (STAGE_STAMP[s]) stamps[STAGE_STAMP[s]] = 'NOW()';
    }
    const stampCols = Object.keys(stamps);

    const id = uuidv4();

    // One connection, one transaction. Without this an error thrown after
    // the INSERT (as one was, on an unimported pushToStaff) leaves a real
    // order — holding a real tracking code — behind a 500 that tells the
    // operator nothing was created. They retry, and the customer has two.
    const client = await req.db.connect();
    let order;
    try {
      await client.query('BEGIN');
      const trackingCode = stage >= STAGE_ORDER.indexOf('paid') ? await nextTrackingCode(client) : null;

      const { rows } = await client.query(
        `INSERT INTO wa_orders (id, contact_id, product_links, product_note, status,
                tracking_code, quote_kes, delivery_fee_kes, supplier_ref
                ${stampCols.length ? ', ' + stampCols.join(', ') : ''})
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9
                ${stampCols.length ? ', ' + stampCols.map(() => 'NOW()').join(', ') : ''})
         RETURNING *`,
        [id, contact_id, JSON.stringify(links), product_note || null, status,
         trackingCode, quoteKes, feeKes, supplierRef]
      );
      order = rows[0];

      await client.query(
        `INSERT INTO wa_order_events (id, order_id, from_status, to_status, actor_user_id, note)
         VALUES ($1, $2, NULL, $3, $4, $5)`,
        [uuidv4(), id, status, req.user.id,
         status === 'quoting' ? 'Order created' : `Order added directly at '${status}' by an operator`]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // Everything below is post-commit: the order exists, so a failure here
    // must not turn into "creation failed".
    try {
      pushToStaff('wa_pipeline_update', { order_id: id, status, contact_id });
    } catch (e) {
      console.warn('[waOrders] pipeline broadcast failed (non-fatal):', e?.message);
    }

    // Opt-in only — see the note above about texting people about parcels
    // they already have.
    if (req.body?.notify === true && status !== 'quoting') {
      try {
        await sendCustomerStatusMessage(req.db, contact, order);
      } catch (e) {
        console.warn('[waOrders] back-dated order notify failed (non-fatal):', e?.message);
      }
    }

    res.status(201).json({ success: true, order });
  } catch (err) {
    logRouteError(req, res, err, 'POST /api/wa/orders');
    res.status(500).json({ success: false, message: 'Failed to create order' });
  }
});

/** GET /api/wa/orders/:id — order + contact + audit trail + payments. */
router.get('/:id', authMiddleware, STAFF, async (req, res) => {
  try {
    const { rows } = await req.db.query(`${ORDER_SELECT} WHERE o.id = $1`, [req.params.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const [{ rows: events }, { rows: payments }] = await Promise.all([
      req.db.query(
        `SELECT * FROM wa_order_events WHERE order_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [order.id]
      ),
      req.db.query(
        `SELECT id, status, method, amount_due_kes, mpesa_provider, mpesa_reference,
                created_at, paid_at
           FROM payments WHERE target_kind = 'wa_order' AND target_id = $1
          ORDER BY created_at DESC`,
        [order.id]
      ),
    ]);
    res.json({ success: true, order, events, payments });
  } catch (err) {
    logRouteError(req, res, err, 'GET /api/wa/orders/:id');
    res.status(500).json({ success: false, message: 'Failed to load order' });
  }
});

/**
 * POST /api/wa/orders/:id/quote  { usd_price, markup_pct?, delivery_method? }
 * Computes goods = usd × live USD_KES rate × (1 + markup%/100), adds the
 * last-mile fee when the customer wants delivery, snapshots the inputs
 * onto the row, and sends the quote to the customer.
 *
 * The last-mile fee is quoted with the order rather than requested when
 * the parcel lands. Asking for a second payment two to three weeks after
 * the first is a second chance to lose the money, long after the
 * customer has stopped thinking about the order. Collection is free, so
 * delivery_method decides whether the fee applies at all; the amount is
 * wa_settings.default_delivery_fee_kes.
 *
 * quote_kes is the total the customer pays, fee included, because every
 * consumer downstream — the payment row, the confirm message, the
 * receipt — already treats it as the agreed total. delivery_fee_kes
 * keeps the component so the receipt can name it.
 *
 * The margin is per-order, defaulting to the settings value. It has to
 * be: the 10% service fee is a SHEIN charge, and it is waived outright
 * while the SHEIN promotion runs. UK stores are £9/kg + £3 handling and
 * Dubai is $9/kg — neither carries the 10%, so a single global margin
 * silently added it to every one of those quotes. Passing 0 here is the
 * normal case for a non-SHEIN order, not an exception.
 */
router.post('/:id/quote', authMiddleware, STAFF, idempotency, async (req, res) => {
  try {
    const usd = Number(req.body?.usd_price);
    if (!Number.isFinite(usd) || usd <= 0 || usd > 1_000_000) {
      return res.status(400).json({ success: false, message: 'usd_price must be a positive number' });
    }
    const { rows } = await req.db.query(`${ORDER_SELECT} WHERE o.id = $1`, [req.params.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['quoting', 'quoted'].includes(order.status)) {
      return res.status(409).json({ success: false, message: `Cannot quote an order in status '${order.status}'` });
    }

    const [{ rate }, settings] = await Promise.all([
      getUsdToKesRate(req.db),
      getWaSettings(req.db),
    ]);
    const { markup, error: markupError } = resolveMarkupPct(req.body?.markup_pct, settings.markup_pct);
    if (markupError) return res.status(400).json({ success: false, message: markupError });

    // Falls back to what the customer told the assistant at signup, and
    // to 'delivery' only when nobody has ever said. Under-charging is
    // the worse default: an unwanted fee is visible in the quote and the
    // customer will say so, while a missing one is discovered on arrival
    // when it is awkward to ask for.
    const method = req.body?.delivery_method || order.delivery_preference || 'delivery';
    const { feeKes, error: feeError } = deliveryFeeFor(method, settings.default_delivery_fee_kes);
    if (feeError) return res.status(400).json({ success: false, message: feeError });

    // Price off the buffered rate, not the mid-market one the FX table
    // holds. Mid is the midpoint of a spread nobody trades at; the KES →
    // GBP round trip this business actually makes costs 3–4 KES on the
    // cross, and quoting at mid gave that away on every order.
    const { rate: quoteRate, bufferPct, error: fxError } =
      effectiveFxRate(rate, settings.fx_buffer_pct);
    if (fxError) return res.status(500).json({ success: false, message: fxError });

    const goodsKes = Math.round(usd * quoteRate * (1 + markup / 100));
    const quoteKes = goodsKes + feeKes;

    // The approved payment-prompt template promises "The quote expires
    // {{4}}" — this stamp is what makes that true. The FX snapshot means
    // something once the quote actually lapses.
    const validityDays = Math.round(Number(settings.quote_validity_days) || 7);

    const { rows: updated } = await req.db.query(
      `UPDATE wa_orders
          SET usd_price = $2, fx_rate = $3, markup_pct = $4, quote_kes = $5,
              delivery_method = $6, delivery_fee_kes = $7,
              delivery_fee_in_quote = true,
              quote_expires_at = NOW() + ($8 || ' days')::interval,
              fx_buffer_pct = $9,
              status = 'quoted', quoted_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      // fx_rate holds the rate the customer was quoted at — the buffered
      // one, which is what the quote message and the receipt print.
      // fx_buffer_pct records how much of it was cushion, so the mid rate
      // of the day stays recoverable from the pair.
      [order.id, usd, quoteRate, markup, quoteKes, method, feeKes, String(validityDays), bufferPct]
    );
    await req.db.query(
      `INSERT INTO wa_order_events (id, order_id, from_status, to_status, actor_user_id, note)
       VALUES ($1, $2, $3, 'quoted', $4, $5)`,
      [uuidv4(), order.id, order.status, req.user.id,
        `Quoted $${usd} → KSh ${quoteKes}`
        + (feeKes > 0 ? ` (incl. KSh ${feeKes} delivery)` : ' (collection — no delivery fee)')]
    );

    await sendToContact(req.db, { id: order.contact_id, phone: order.phone }, {
      templateKey: 'quote',
      // Must cover every variable of the tc_quote template
      // (sentdm-templates.json) — WhatsApp rejects partial fills.
      templateParams: {
        full_name: order.full_name,
        order_ref: order.tracking_code || orderRef(order),
        total_kes: quoteKes.toLocaleString('en-KE'),
      },
      text:
        `*Your quote is ready*\n` +
        `Item price: $${usd.toFixed(2)}\n` +
        `Exchange rate: 1 USD = ${quoteRate.toFixed(2)} KES\n` +
        // No margin line when there is no margin — printing "Service
        // margin: 0%" on a promotional quote invites the question of
        // what it would otherwise have been.
        (markup > 0 ? `Service margin: ${markup}%\n` : '') +
        // Name the fee. It is inside the total now, and a customer who
        // cannot see why the number moved assumes the worst.
        (feeKes > 0
          ? `Delivery to your address or Pickup Mtaani point: KSh ${feeKes.toLocaleString('en-KE')}\n`
          : `Collection from our CBD office: free\n`) +
        `*Total: KSh ${quoteKes.toLocaleString('en-KE')}*\n\n` +
        `This quote is valid until ${new Date(updated[0].quote_expires_at)
          .toLocaleDateString('en-KE', { day: 'numeric', month: 'long' })}.\n` +
        `Reply *YES* to confirm and we'll send the M-Pesa payment details.`,
      sentBy: req.user.id,
    });

    res.json({ success: true, order: updated[0] });
  } catch (err) {
    if (err instanceof FxRateUnavailableError) {
      return res.status(err.status).json({ success: false, error: err.code, message: err.message });
    }
    logRouteError(req, res, err, 'POST /api/wa/orders/:id/quote');
    res.status(500).json({ success: false, message: 'Failed to quote order' });
  }
});

/** POST /api/wa/orders/:id/confirm — operator confirms on the customer's behalf. */
router.post('/:id/confirm', authMiddleware, STAFF, async (req, res) => {
  try {
    const result = await transition(req.db, req.params.id, 'confirmed', {
      actorUserId: req.user.id,
      note: req.body?.note || 'Confirmed by operator',
      silent: true, // the payment prompt follows via request-payment
    });
    if (!result.ok) return res.status(409).json({ success: false, message: result.reason });
    res.json({ success: true, status: result.status });
  } catch (err) {
    logRouteError(req, res, err, 'POST /api/wa/orders/:id/confirm');
    res.status(500).json({ success: false, message: 'Failed to confirm order' });
  }
});

/**
 * POST /api/wa/orders/:id/request-payment
 *   { method: 'stk' | 'manual', purpose?: 'order' | 'delivery_fee', phone? }
 *
 * 'stk'    → fires a Lipana STK push to the contact's M-Pesa number (or
 *            the phone override) and creates a pending payments row that
 *            the Lipana webhook settles.
 * 'manual' → creates an awaiting_review payments row and sends the
 *            customer till-payment instructions; the admin approves it in
 *            the payments queue ("Approve Payment" button).
 */
router.post('/:id/request-payment', authMiddleware, STAFF, idempotency, async (req, res) => {
  // Default to manual — STK only when a provider is genuinely configured.
  const method = (req.body?.method === 'stk' && stkAvailable()) ? 'stk' : 'manual';
  if (req.body?.method === 'stk' && !stkAvailable()) {
    return res.status(409).json({
      success: false,
      error: 'stk_unavailable',
      message: 'M-Pesa STK Push is not available — send till instructions and approve the payment manually.',
    });
  }
  const purpose = req.body?.purpose === 'delivery_fee' ? 'delivery_fee' : 'order';
  try {
    const { rows } = await req.db.query(`${ORDER_SELECT} WHERE o.id = $1`, [req.params.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    let amountKes;
    if (purpose === 'order') {
      if (!['confirmed', 'quoted'].includes(order.status)) {
        return res.status(409).json({ success: false, message: `Cannot request order payment in status '${order.status}'` });
      }
      amountKes = Number(order.quote_kes);
    } else {
      if (!['in_kenya', 'delivery_fee_pending'].includes(order.status)) {
        return res.status(409).json({ success: false, message: `Cannot request the delivery fee in status '${order.status}'` });
      }
      if (order.delivery_fee_waived) {
        return res.status(409).json({ success: false, message: 'Delivery fee is waived for this order' });
      }
      amountKes = Number(order.delivery_fee_kes);
    }
    if (!Number.isFinite(amountKes) || amountKes <= 0) {
      return res.status(400).json({ success: false, message: 'Order has no payable amount' });
    }

    const phone = normalizeKenyanPhone(req.body?.phone || order.mpesa_number || order.phone);
    if (method === 'stk' && !phone) {
      return res.status(400).json({ success: false, message: 'No valid M-Pesa number on file — pass phone or use manual' });
    }

    // One live payment per order. A pending STK is a genuine conflict —
    // two prompts on one phone is a mess. A manual awaiting_review row is
    // not: the customer may already have one from confirming the quote on
    // WhatsApp, and re-sending them the till details is exactly what the
    // operator meant to do, so we reuse it.
    const existing = await findOpenOrderPayment(req.db, order.id);
    if (existing && (method === 'stk' || existing.status === 'pending')) {
      return res.status(409).json({
        success: false,
        message: `A ${existing.status} payment (${existing.id}) already exists for this order — approve, reject, or wait for it first.`,
        payment: existing,
      });
    }

    let paymentId;
    if (method === 'stk') {
      paymentId = `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await req.db.query(
        `INSERT INTO payments
           (id, user_id, wa_contact_id, target_kind, target_id,
            amount_gross_kes, amount_credit_kes, amount_due_kes,
            currency, method, status, mpesa_provider, mpesa_phone_used)
         VALUES ($1, NULL, $2, 'wa_order', $3, $4, 0, $4, 'KES', 'mpesa', 'pending', 'lipana', $5)`,
        [paymentId, order.contact_id, order.id, amountKes, phone]
      );
    } else {
      const { payment } = await ensureManualPayment(req.db, {
        orderId: order.id,
        contactId: order.contact_id,
        amountKes,
        phone,
      });
      paymentId = payment.id;
    }

    const contact = { id: order.contact_id, phone: order.phone };
    if (method === 'stk') {
      let stk;
      try {
        stk = await lipanaInitiateStkPush({ phone, amountKes, idempotencyKey: paymentId });
      } catch (e) {
        // Roll the row back so the operator can retry cleanly.
        await req.db.query(`DELETE FROM payments WHERE id = $1 AND status = 'pending'`, [paymentId]);
        if (e instanceof LipanaError) {
          return res.status(e.status >= 400 && e.status < 600 ? e.status : 502)
            .json({ success: false, error: e.code, message: e.message });
        }
        throw e;
      }
      await req.db.query(
        `UPDATE payments
            SET lipana_transaction_id = $2, lipana_checkout_request_id = $3, updated_at = NOW()
          WHERE id = $1`,
        [paymentId, stk.transactionId, stk.checkoutRequestID]
      );
      await sendToContact(req.db, contact, {
        text:
          `We've sent an M-Pesa prompt for KSh ${amountKes.toLocaleString('en-KE')} to ` +
          `${phone.replace(/^254/, '0')} — just enter your PIN to complete the payment.`,
        sentBy: req.user.id,
      });
    } else {
      // templateKey so this can still land when the customer's 24-hour
      // window has shut — an operator often sends till instructions days
      // after the customer last wrote in. In-window the richer free text
      // below is what goes out (see waSend.js).
      await sendToContact(req.db, contact, {
        templateKey: 'payment_prompt',
        templateParams: {
          full_name: order.full_name,
          order_ref: order.tracking_code || orderRef(order),
          total_kes: amountKes.toLocaleString('en-KE'),
          expires_at: order.quote_expires_at
            ? new Date(order.quote_expires_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'long' })
            : undefined,
        },
        text:
          `To pay KSh ${amountKes.toLocaleString('en-KE')}:\n` +
          `1. Lipa na M-Pesa, Buy Goods (Till)\n` +
          `2. Till number: *${MPESA_TILL}*\n` +
          `3. Amount: KSh ${amountKes.toLocaleString('en-KE')}\n\n` +
          `Reply here once you've paid and we'll confirm it right away.`,
        sentBy: req.user.id,
      });
    }

    res.status(201).json({ success: true, payment_id: paymentId, method, purpose, amount_kes: amountKes });
  } catch (err) {
    logRouteError(req, res, err, 'POST /api/wa/orders/:id/request-payment');
    res.status(500).json({ success: false, message: 'Failed to request payment' });
  }
});

/**
 * POST /api/wa/orders/:id/mark-paid  { mpesa_reference?, note? }
 *
 * The manual-M-Pesa approval, on the order screen where the operator
 * already is. STK is gone, so "approving a payment" is really "I can see
 * this money on the till statement" — and the payments row it acts on may
 * not exist yet (a customer who confirms their quote on WhatsApp and pays
 * straight away never goes through request-payment). So: get-or-create the
 * awaiting_review row for whatever this order currently owes, stamp the
 * M-Pesa reference on it, then settle it through the same
 * markPaymentPaid state machine the admin queue uses — which mints the
 * tracking code, sends it, and pushes the PDF receipt.
 *
 * Staff-gated, matching routes/adminPayments.js: operators settle money
 * too, with reviewed_by/reviewed_at and the order event as the audit
 * trail. This was admin-only, which made one admin the serial bottleneck
 * for every order in the business.
 */
router.post('/:id/mark-paid', authMiddleware, STAFF, idempotency, async (req, res) => {
  try {
    const { rows } = await req.db.query(`${ORDER_SELECT} WHERE o.id = $1`, [req.params.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Which money is outstanding is decided by the order's status — the
    // same rule markPaymentPaid uses when it flips the target row.
    let amountKes;
    if (['quoting', 'quoted', 'confirmed'].includes(order.status)) {
      amountKes = Number(order.quote_kes);
      if (!Number.isFinite(amountKes) || amountKes <= 0) {
        return res.status(409).json({ success: false, message: 'Quote the order before recording a payment' });
      }
    } else if (['in_kenya', 'delivery_fee_pending'].includes(order.status)) {
      if (order.delivery_fee_waived || order.delivery_fee_paid_at) {
        return res.status(409).json({ success: false, message: 'Nothing outstanding on this order' });
      }
      amountKes = Number(order.delivery_fee_kes);
      if (!Number.isFinite(amountKes) || amountKes <= 0) {
        return res.status(409).json({ success: false, message: 'No delivery fee set on this order' });
      }
    } else {
      return res.status(409).json({
        success: false,
        message: `Nothing to pay for on an order in status '${order.status}'`,
      });
    }

    const reference = extractMpesaReference(req.body?.mpesa_reference || '')
      || (typeof req.body?.mpesa_reference === 'string' && req.body.mpesa_reference.trim()
        ? req.body.mpesa_reference.trim().toUpperCase().slice(0, 32) : null);

    // What the operator actually saw on the till statement. Optional for
    // backwards compatibility, but the dashboard always sends it — it is
    // what makes the receipt's PAID stamp a verified claim, and a short
    // amount needs an explicit override reason, same as the queue page.
    let receivedKes = null;
    if (req.body?.amount_received_kes != null) {
      receivedKes = Math.round(Number(req.body.amount_received_kes));
      if (!Number.isFinite(receivedKes) || receivedKes <= 0) {
        return res.status(400).json({ success: false, message: 'amount_received_kes must be a positive number' });
      }
      const overrideReason = typeof req.body?.override_reason === 'string' ? req.body.override_reason.trim() : '';
      if (receivedKes < amountKes && overrideReason.length < 10) {
        return res.status(409).json({
          success: false,
          error: 'amount_mismatch',
          message: `KES ${receivedKes.toLocaleString()} received but KES ${amountKes.toLocaleString()} is due. Provide override_reason (>=10 chars) to approve anyway.`,
          amount_due_kes: amountKes,
          amount_claimed_kes: receivedKes,
        });
      }
    }

    const { payment } = await ensureManualPayment(req.db, {
      orderId: order.id,
      contactId: order.contact_id,
      amountKes,
      phone: normalizeKenyanPhone(order.mpesa_number || order.phone),
    });
    if (payment.status === 'pending') {
      return res.status(409).json({
        success: false,
        message: 'An M-Pesa STK push is still pending on this order — wait for it to settle or fail.',
      });
    }
    if (reference) await attachMpesaReference(req.db, payment.id, reference);
    if (receivedKes != null) {
      const overrideReason = typeof req.body?.override_reason === 'string' ? req.body.override_reason.trim() : '';
      await req.db.query(
        `UPDATE payments
            SET amount_received_kes = $2,
                approval_override_reason = COALESCE($3, approval_override_reason),
                updated_at = NOW()
          WHERE id = $1 AND status = 'awaiting_review'`,
        [payment.id, receivedKes, receivedKes < amountKes ? overrideReason : null]
      );
    }

    const result = await markPaymentPaid(req.db, payment.id, { adminUserId: req.user.id });
    if (!result.ok) {
      return res.status(409).json({ success: false, message: result.reason || 'Failed to record payment' });
    }
    await req.db.query(
      `INSERT INTO wa_order_events (id, order_id, from_status, to_status, actor_user_id, note)
       VALUES ($1, $2, $3, $3, $4, $5)`,
      [uuidv4(), order.id, order.status, req.user.id,
       `Manual M-Pesa payment recorded${reference ? ` (ref ${reference})` : ''}${req.body?.note ? ` — ${String(req.body.note).slice(0, 200)}` : ''}`]
    );

    res.json({ success: true, payment_id: payment.id, already_paid: Boolean(result.alreadyPaid) });
  } catch (err) {
    logRouteError(req, res, err, 'POST /api/wa/orders/:id/mark-paid');
    res.status(500).json({ success: false, message: 'Failed to record payment' });
  }
});

/**
 * POST /api/wa/orders/:id/advance  { to_status, note? }
 * Validated single-step pipeline moves; each fires its WhatsApp alert.
 * Payment-side statuses ('paid') can't be forced here — money moves via
 * the payments machinery (webhook / admin approve).
 */
router.post('/:id/advance', authMiddleware, STAFF, async (req, res) => {
  try {
    const to = String(req.body?.to_status || '').trim();
    if (!['quoted', 'confirmed', 'purchased', 'in_kenya', 'dispatched', 'delivered', 'collected', 'cancelled'].includes(to)) {
      return res.status(400).json({ success: false, message: `to_status '${to}' is not operator-advanceable` });
    }
    if (to === 'dispatched') {
      // Guard: don't dispatch with an unsettled, unwaived fee.
      const { rows } = await req.db.query(
        `SELECT status, delivery_fee_waived, delivery_fee_paid_at, delivery_fee_kes
           FROM wa_orders WHERE id = $1`, [req.params.id]
      );
      const o = rows[0];
      if (o && o.status === 'delivery_fee_pending'
          && !o.delivery_fee_waived && !o.delivery_fee_paid_at && Number(o.delivery_fee_kes) > 0) {
        return res.status(409).json({
          success: false,
          message: 'Delivery fee is still unpaid — collect it or waive it before dispatching.',
        });
      }
    }
    const result = await transition(req.db, req.params.id, to, {
      actorUserId: req.user.id,
      note: req.body?.note || null,
    });
    if (!result.ok) return res.status(409).json({ success: false, message: result.reason });
    res.json({ success: true, status: result.status });
  } catch (err) {
    logRouteError(req, res, err, 'POST /api/wa/orders/:id/advance');
    res.status(500).json({ success: false, message: 'Failed to advance order' });
  }
});

/**
 * PATCH /api/wa/orders/:id/product-links
 *   { product_links: string[], product_note?: string|null }
 *
 * Add or remove the links on an order. Customers send a second cart ten
 * minutes after the first, change their mind about an item, or paste a
 * link that does not open — and until now the list was frozen at
 * creation, so the operator's only options were quoting from a wrong
 * list or throwing the order away and starting again.
 *
 * The whole list is replaced (the editor sends what the order should
 * now hold), normalised by utils/productLinks.js. The audit row records
 * what actually changed, because "why is this quote for three items when
 * the customer asked for two" is a question asked weeks later.
 *
 * Deliberately NOT touching money: links describe what to buy, and
 * re-pricing is the operator's decision — the response carries
 * `requote_advised` so the dashboard can say so on an already-quoted
 * order. Refused once the order is cancelled; a cancelled order is a
 * record, not a work item.
 */
router.patch('/:id/product-links', authMiddleware, STAFF, async (req, res) => {
  try {
    const { links, error } = normalizeProductLinks(req.body?.product_links ?? []);
    if (error) return res.status(400).json({ success: false, message: error });

    const { rows: existing } = await req.db.query(
      `SELECT id, status, product_links, product_note FROM wa_orders WHERE id = $1`,
      [req.params.id]
    );
    const order = existing[0];
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status === 'cancelled') {
      return res.status(409).json({ success: false, message: 'This order is cancelled — reopen or recreate it to change the links' });
    }

    // product_note rides along because it is the other half of "what are
    // we buying" — and when it is set, the receipt prefers it over the
    // link hostname. Absent means leave it alone; null or '' clears it.
    const noteGiven = Object.prototype.hasOwnProperty.call(req.body || {}, 'product_note');
    const note = noteGiven
      ? (typeof req.body.product_note === 'string' && req.body.product_note.trim()
        ? req.body.product_note.trim().slice(0, 500) : null)
      : order.product_note;

    const { rows: updated } = await req.db.query(
      `UPDATE wa_orders SET product_links = $2::jsonb, product_note = $3, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [order.id, JSON.stringify(links), note]
    );

    const before = Array.isArray(order.product_links) ? order.product_links : [];
    const added = links.filter((l) => !before.includes(l));
    const removed = before.filter((l) => !links.includes(l));
    const changes = [];
    if (added.length) changes.push(`added ${added.length}`);
    if (removed.length) changes.push(`removed ${removed.length}`);
    if (noteGiven && note !== order.product_note) changes.push(note ? 'note updated' : 'note cleared');
    if (changes.length) {
      await req.db.query(
        `INSERT INTO wa_order_events (id, order_id, from_status, to_status, actor_user_id, note)
         VALUES ($1, $2, $3, $3, $4, $5)`,
        [uuidv4(), order.id, order.status, req.user.id,
         `Product links edited — ${changes.join(', ')} (now ${links.length})`]
      );
      pushToStaff('wa_pipeline_update', { order_id: order.id, status: order.status });
    }

    res.json({
      success: true,
      order: updated[0],
      added: added.length,
      removed: removed.length,
      // Changing what we buy after a price was quoted almost always
      // means the price is wrong now — but only a person can decide
      // that, so this is advice, not an action.
      requote_advised: (added.length > 0 || removed.length > 0)
        && ['quoted', 'confirmed'].includes(order.status),
    });
  } catch (err) {
    logRouteError(req, res, err, 'PATCH /api/wa/orders/:id/product-links');
    res.status(500).json({ success: false, message: 'Failed to update the product links' });
  }
});

/**
 * PATCH /api/wa/orders/:id/pickup-point  { pickup_point }
 *
 * Staff assign the Pickup Mtaani agent. The customer tells us the area
 * they want; which agent serves it is a decision only the team can make,
 * against a list that changes as agents open and close. The assistant is
 * told never to confirm one — it invented Hurlingham coverage once and
 * was right by accident.
 *
 * Sending an empty value clears it, for an order that switched to home
 * delivery after a point had been set.
 */
router.patch('/:id/pickup-point', authMiddleware, STAFF, async (req, res) => {
  try {
    const raw = req.body?.pickup_point;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      return res.status(400).json({ success: false, message: 'pickup_point must be a string' });
    }
    const point = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 200) : null;

    const { rows } = await req.db.query(
      `UPDATE wa_orders SET pickup_point = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [req.params.id, point]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Order not found' });

    await req.db.query(
      `INSERT INTO wa_order_events (id, order_id, from_status, to_status, actor_user_id, note)
       VALUES ($1, $2, $3, $3, $4, $5)`,
      [uuidv4(), rows[0].id, rows[0].status, req.user.id,
        point ? `Pickup point set to ${point}` : 'Pickup point cleared']
    );
    res.json({ success: true, order: rows[0] });
  } catch (err) {
    logRouteError(req, res, err, 'PATCH /api/wa/orders/:id/pickup-point');
    res.status(500).json({ success: false, message: 'Failed to set the pickup point' });
  }
});

/**
 * PATCH /api/wa/orders/:id/delivery-method  { delivery_method, notify? }
 *
 * Customers change their minds — "actually I'll pick it up", "please
 * bring it after all". The method used to be fixed at quote time, so
 * every later message fired on the wrong branch: a collector was
 * promised a rider, a delivery customer was sent to Stanbank House, and
 * the fee was wrong either way. The money rules live in
 * utils/waQuote.switchDeliveryMethod (see its header); this route
 * persists them, re-amounts any open payment, writes the audit event,
 * and tells the customer what changed (pass notify:false to stay quiet).
 * Too late once the parcel is dispatched, delivered, collected or
 * cancelled.
 */
router.patch('/:id/delivery-method', authMiddleware, STAFF, async (req, res) => {
  try {
    const method = req.body?.delivery_method;
    const { rows } = await req.db.query(`${ORDER_SELECT} WHERE o.id = $1`, [req.params.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const settings = await getWaSettings(req.db);
    const plan = switchDeliveryMethod(order, method, settings.default_delivery_fee_kes);
    if (plan.error) return res.status(409).json({ success: false, message: plan.error });

    const sets = ['updated_at = NOW()'];
    const params = [order.id];
    for (const [col, val] of Object.entries(plan.updates)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    const { rows: updated } = await req.db.query(
      `UPDATE wa_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );

    // An open till payment must ask for the NEW total, or the operator
    // approves against a figure the customer was never told.
    if (plan.updates.quote_kes != null) {
      await req.db.query(
        `UPDATE payments
            SET amount_due_kes = $2, amount_gross_kes = $2, updated_at = NOW()
          WHERE target_kind = 'wa_order' AND target_id = $1 AND status = 'awaiting_review'`,
        [order.id, plan.updates.quote_kes]
      );
    }

    const noteBits = [`Switched to ${method}`];
    if (plan.updates.quote_kes != null) noteBits.push(`new total KSh ${Number(plan.updates.quote_kes).toLocaleString('en-KE')}`);
    if (plan.refundFeeKes > 0) noteBits.push(`customer already paid the KSh ${plan.refundFeeKes.toLocaleString('en-KE')} delivery fee — settle the difference with them`);
    if (plan.feeOwedOnArrivalKes > 0) noteBits.push(`KSh ${plan.feeOwedOnArrivalKes.toLocaleString('en-KE')} delivery fee now due on arrival`);
    await req.db.query(
      `INSERT INTO wa_order_events (id, order_id, from_status, to_status, actor_user_id, note)
       VALUES ($1, $2, $3, $3, $4, $5)`,
      [uuidv4(), order.id, order.status, req.user.id, noteBits.join(' — ')]
    );
    pushToStaff('wa_pipeline_update', { order_id: order.id, contact_id: order.contact_id, status: order.status });

    // Tell the customer, unless the operator is only correcting a record
    // (notify:false) or nothing has been communicated yet (no quote).
    if (req.body?.notify !== false && order.quote_kes != null) {
      const ref = order.tracking_code || orderRef(order);
      const newTotal = plan.updates.quote_kes != null ? Number(plan.updates.quote_kes) : null;
      let text;
      if (method === 'collection') {
        text = plan.prePayment
          ? `We've updated ${ref} for collection at Stanbank House, 4th floor, Nairobi CBD — no delivery fee applies.` +
            (newTotal != null ? ` Your new total is *KSh ${newTotal.toLocaleString('en-KE')}*.` : '') +
            (order.status === 'quoted' ? `\nReply *YES* to confirm.` : `\nTo pay: Lipa na M-Pesa, Buy Goods, Till *${MPESA_TILL}*.`)
          : `We've updated ${ref} for collection at Stanbank House, 4th floor, Nairobi CBD` +
            (['in_kenya', 'delivery_fee_pending'].includes(updated[0].status)
              ? ` — it's ready whenever you are. We're open Monday to Saturday, closed Sunday.`
              : ` — we'll message you the moment it's ready to collect.`) +
            (plan.refundFeeKes > 0
              ? `\nYour order included a KSh ${plan.refundFeeKes.toLocaleString('en-KE')} delivery fee — our team will be in touch about the difference.`
              : '');
      } else {
        text = plan.prePayment
          ? `We've updated ${ref} for delivery to your address.` +
            (newTotal != null ? ` Delivery adds KSh ${Number(plan.updates.delivery_fee_kes || 0).toLocaleString('en-KE')}, making your total *KSh ${newTotal.toLocaleString('en-KE')}*.` : '') +
            (order.status === 'quoted' ? `\nReply *YES* to confirm.` : `\nTo pay: Lipa na M-Pesa, Buy Goods, Till *${MPESA_TILL}*.`)
          : `We've updated ${ref} for delivery to your address.` +
            (plan.feeOwedOnArrivalKes > 0
              ? ` The last step will be a KSh ${plan.feeOwedOnArrivalKes.toLocaleString('en-KE')} delivery fee — we'll send the payment details when it ${['in_kenya', 'delivery_fee_pending'].includes(updated[0].status) ? 'is ready to send out' : 'arrives in Kenya'}.`
              : '');
      }
      await sendToContact(req.db, { id: order.contact_id, phone: order.phone }, {
        text, sentBy: req.user.id,
      });
    }

    res.json({ success: true, order: updated[0] });
  } catch (err) {
    logRouteError(req, res, err, 'PATCH /api/wa/orders/:id/delivery-method');
    res.status(500).json({ success: false, message: 'Failed to switch the delivery method' });
  }
});

/** POST /api/wa/orders/:id/waive-fee — manual per-order fee waiver. */
router.post('/:id/waive-fee', authMiddleware, STAFF, async (req, res) => {
  try {
    // Waiving clears the debt, so the order leaves 'delivery_fee_pending'
    // for 'in_kenya' — same reasoning as a paid fee in markPaymentPaid:
    // that status means money is owed, and nothing is. RETURNING gives
    // back the status the row held *before* this update, which is what
    // the audit event should record as the from_status.
    const { rows } = await req.db.query(
      `WITH prev AS (
         SELECT id, status FROM wa_orders WHERE id = $1 FOR UPDATE
       )
       UPDATE wa_orders o
          SET delivery_fee_waived = true, status = 'in_kenya', updated_at = NOW()
         FROM prev
        WHERE o.id = prev.id
          AND prev.status IN ('in_kenya', 'delivery_fee_pending')
        RETURNING o.id, prev.status AS from_status, o.tracking_code, o.contact_id`,
      [req.params.id]
    );
    const order = rows[0];
    if (!order) return res.status(409).json({ success: false, message: 'Order is not awaiting a delivery fee' });
    await req.db.query(
      `INSERT INTO wa_order_events (id, order_id, from_status, to_status, actor_user_id, note)
       VALUES ($1, $2, $3, 'in_kenya', $4, 'Delivery fee waived')`,
      [uuidv4(), order.id, order.from_status, req.user.id]
    );
    const { rows: c } = await req.db.query(`SELECT id, phone FROM wa_contacts WHERE id = $1`, [order.contact_id]);
    if (c[0]) {
      // templateKey: a waiver usually lands weeks after the customer last
      // wrote in, when free text is refused. The arrived_waived template
      // ("your delivery fee is on us, we will dispatch shortly") is true
      // for this case too.
      await sendToContact(req.db, c[0], {
        templateKey: 'arrived_waived',
        templateParams: { tracking_code: order.tracking_code || '' },
        text: `Good news — your delivery fee for ${order.tracking_code} has been waived. We'll dispatch your parcel shortly.`,
        sentBy: req.user.id,
      });
    }
    res.json({ success: true });
  } catch (err) {
    logRouteError(req, res, err, 'POST /api/wa/orders/:id/waive-fee');
    res.status(500).json({ success: false, message: 'Failed to waive fee' });
  }
});

/** GET /api/wa/orders/:id/receipt — 7-day signed download URL. */
router.get('/:id/receipt', authMiddleware, STAFF, async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT receipt_path FROM wa_orders WHERE id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!rows[0].receipt_path) return res.status(404).json({ success: false, message: 'No receipt generated yet' });
    const signed = await createSignedDownloadUrl('receipts', rows[0].receipt_path, 7 * 24 * 3600);
    if (!signed?.signedUrl) return res.status(502).json({ success: false, message: 'Failed to sign receipt URL' });
    res.json({ success: true, url: signed.signedUrl });
  } catch (err) {
    logRouteError(req, res, err, 'GET /api/wa/orders/:id/receipt');
    res.status(500).json({ success: false, message: 'Failed to load receipt' });
  }
});

/**
 * POST /api/wa/orders/:id/receipt/resend — regenerate (if needed) and
 * re-push the receipt to the customer. Backstop for post-paid hook
 * failures.
 */
router.post('/:id/receipt/resend', authMiddleware, STAFF, async (req, res) => {
  try {
    const { rows } = await req.db.query(`${ORDER_SELECT} WHERE o.id = $1`, [req.params.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const { rows: payRows } = await req.db.query(
      `SELECT * FROM payments
        WHERE target_kind = 'wa_order' AND target_id = $1 AND status = 'paid'
        ORDER BY paid_at DESC LIMIT 1`,
      [order.id]
    );
    if (!payRows[0]) return res.status(409).json({ success: false, message: 'No settled payment on this order yet' });

    const contact = {
      id: order.contact_id, phone: order.phone,
      full_name: order.full_name, customer_code: order.customer_code,
      // The receipt PDF prints the delivery address; without this the
      // "Deliver to" block rendered blank.
      delivery_address: order.delivery_address,
    };
    const { generateAndStoreReceipt } = await import('../utils/receiptPdf.js');
    const path = await generateAndStoreReceipt({ order, contact, payment: payRows[0] });
    await req.db.query(
      `UPDATE wa_orders SET receipt_path = $2, updated_at = NOW() WHERE id = $1`,
      [order.id, path]
    );
    // Short /r/ link — the signed Supabase URL is ~600 chars of JWT and
    // looks like spam on WhatsApp. The redirect re-signs on each click.
    // Guard the null case (JWT_SECRET unset, missing tracking code):
    // without it the customer received literally "your receipt: null".
    const url = receiptShortUrl(order);
    if (!url) {
      return res.status(500).json({
        success: false,
        message: 'Receipt was generated but the link could not be built — check JWT_SECRET and the order tracking code.',
      });
    }
    await sendToContact(req.db, contact, {
      templateKey: 'receipt',
      templateParams: {
        tracking_code: order.tracking_code || '',
        receipt_token: receiptToken(order),
      },
      text: `Here's your receipt for ${order.tracking_code}: ${url}`,
      sentBy: req.user.id,
    });
    res.json({ success: true, path, url });
  } catch (err) {
    logRouteError(req, res, err, 'POST /api/wa/orders/:id/receipt/resend');
    res.status(500).json({ success: false, message: 'Failed to resend receipt' });
  }
});

export default router;
