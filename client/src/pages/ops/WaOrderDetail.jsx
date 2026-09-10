import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Package, ArrowLeft, MessageSquareText, Printer, FileText,
  CheckCircle2, Smartphone, HandCoins, Gift, Send,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { waApi, paymentsApi } from '../../api'
import { GlassStyles, GlassCard, PageHeading, StatusBadge } from '../../components/GlassUI'
import { PrintableParcelLabel } from '../../components/PrintableParcelLabel'
import { useWaPipelineUpdates } from '../../hooks/useRealtimeUpdates'
import MTAANI_AGENTS from '../../lib/pickupMtaaniAgents.json'
// Stage buttons live in lib so they are unit-testable — a collection
// order at 'purchased' once offered none at all (TRK-8826).
import { nextActions } from '../../lib/orderStages'

export function WaOrderDetail() {
  const { id } = useParams()
  const [order, setOrder] = useState(null)
  const [events, setEvents] = useState([])
  const [payments, setPayments] = useState([])
  const [usd, setUsd] = useState('')
  // Per-order, because the 10% is a SHEIN charge and nothing else pays
  // it: UK is £9/kg + £3, Dubai is $9/kg, and SHEIN itself is 0 while the
  // promotion runs. Blank falls back to the settings default.
  const [margin, setMargin] = useState('')
  // Decides whether the last-mile fee is added to the quote. Seeded from
  // whatever the customer told the assistant at signup.
  const [method, setMethod] = useState('delivery')
  // Which Pickup Mtaani agent a parcel goes to is the team's call. The
  // customer names an area; the assistant is told never to confirm a
  // point, having once invented coverage of one.
  const [pickup, setPickup] = useState('')
  // Editable copy of the order's product links. Customers send a second
  // cart minutes after the first, or change their mind about an item —
  // the list used to be frozen at creation, leaving the operator to quote
  // from a wrong list or throw the order away and start again.
  const [linkDraft, setLinkDraft] = useState([])
  const [newLink, setNewLink] = useState('')
  const [linksDirty, setLinksDirty] = useState(false)
  const [mpesaRef, setMpesaRef] = useState('')
  // What the reviewer saw on the till statement; blank = the outstanding
  // amount (the common case). A short amount needs an override reason.
  const [amountReceived, setAmountReceived] = useState('')
  const [supplierRef, setSupplierRef] = useState('')
  const [siblings, setSiblings] = useState([])   // others in the same supplier order
  const [busy, setBusy] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)
  // M-Pesa STK is unavailable in production (provider withdrawn), so the
  // dashboard offers till instructions + manual approval only.
  const [stkAvailable, setStkAvailable] = useState(false)
  // Live quote inputs (FX rate, default margin + fee) so the KES total is
  // visible BEFORE the quote goes out. Sending was the one irreversible
  // customer-facing action with no preview — the arithmetic only rendered
  // after the customer had already been told the number, and the only
  // remedy for a typo was re-quoting them.
  const [quoteDefaults, setQuoteDefaults] = useState(undefined) // undefined=loading, null=unavailable

  const load = useCallback(async () => {
    try {
      const res = await waApi.order(id)
      setOrder(res.data.order)
      setEvents(res.data.events || [])
      setPayments(res.data.payments || [])
      if (res.data.order.usd_price) setUsd(String(res.data.order.usd_price))
      setMethod(res.data.order.delivery_method || res.data.order.delivery_preference || 'delivery')
      setPickup(res.data.order.pickup_point || '')
      setSupplierRef(res.data.order.supplier_ref || '')
      // Don't stomp an in-progress edit when an SSE refresh lands.
      setLinksDirty((dirty) => {
        if (!dirty) setLinkDraft(Array.isArray(res.data.order.product_links) ? res.data.order.product_links : [])
        return dirty
      })

      // Who else went into the same supplier purchase. This is the whole
      // reason for the field: when a box turns up with only SHEIN's
      // paperwork, or they refund one line, you need the other parcels.
      const ref = res.data.order.supplier_ref
      if (ref) {
        const found = await waApi.orders({ q: ref, limit: 100 }).catch(() => null)
        setSiblings((found?.data.orders || []).filter((o) => o.id !== res.data.order.id))
      } else {
        setSiblings([])
      }
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to load order')
    }
  }, [id])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    waApi.settings()
      .then((r) => setStkAvailable(Boolean(r.data.capabilities?.stk_available)))
      .catch(() => setStkAvailable(false))
    waApi.quoteDefaults()
      .then((r) => setQuoteDefaults(r.data))
      .catch(() => setQuoteDefaults(null))
  }, [])
  useWaPipelineUpdates((data) => { if (data.order_id === id) load() })

  const run = (fn, okMsg) => async (...args) => {
    setBusy(true)
    try {
      await fn(...args)
      if (okMsg) toast.success(okMsg)
      await load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const sendQuote = run(() => {
    const price = Number(usd)
    if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error(), { response: { data: { message: 'Enter a valid USD price' } } })
    const pct = margin.trim() === '' ? undefined : Number(margin)
    if (pct !== undefined && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
      throw Object.assign(new Error(), { response: { data: { message: 'Margin must be between 0 and 100' } } })
    }
    return waApi.quote(id, price, pct, method)
  }, 'Quote sent to the customer')

  const savePickup = run(() => waApi.setPickupPoint(id, pickup), 'Pickup point saved')

  const addLink = () => {
    const v = newLink.trim()
    if (!v) return
    setLinkDraft((prev) => [...prev, v])
    setNewLink('')
    setLinksDirty(true)
  }
  const removeLink = (i) => {
    setLinkDraft((prev) => prev.filter((_, idx) => idx !== i))
    setLinksDirty(true)
  }
  const saveLinks = run(async () => {
    const res = await waApi.setProductLinks(id, linkDraft)
    setLinksDirty(false)
    // Changing what we buy after a price went out usually means the
    // price is wrong now — but re-quoting is the operator's call.
    if (res.data?.requote_advised) {
      toast('Links changed on a quoted order — re-quote if the price has moved.',
        { icon: '⚠️', duration: 7000 })
    }
    return res
  }, 'Product links saved')

  // Switch delivery ↔ collection so every later message (arrival,
  // dispatch, tracking replies) fires on the right branch. The confirm
  // spells out what happens to the money, because it differs by stage.
  const switchMethod = (to) => {
    if (!order) return
    const fee = Number(order.delivery_fee_kes || 0)
    const prePayment = ['quoting', 'quoted', 'confirmed'].includes(order.status)
    const consequence = to === 'collection'
      ? (prePayment
        ? (fee > 0 ? `The KSh ${fee.toLocaleString()} delivery fee comes off the total and the customer is told the new amount.` : 'The customer is told collection details.')
        : (fee > 0 && order.delivery_fee_in_quote
          ? `They already paid the KSh ${fee.toLocaleString()} delivery fee — you'll need to settle the difference with them.`
          : 'Arrival and tracking messages will use collection wording.'))
      : (prePayment
        ? 'The delivery fee is added to the total and the customer is told the new amount.'
        : 'A delivery fee becomes due on arrival and the customer is told.')
    if (!window.confirm(`Switch this order to ${to}?\n\n${consequence}`)) return
    run(() => waApi.setDeliveryMethod(id, to), `Order switched to ${to}`)()
  }

  const confirm = run(() => waApi.confirm(id), 'Order confirmed')
  const advance = (to) => run(() => waApi.advance(id, to), 'Status updated')()
  const waive = run(() => waApi.waiveFee(id), 'Delivery fee waived')
  const requestPay = (method, purpose) =>
    run(() => waApi.requestPayment(id, { method, purpose }),
      method === 'stk' ? 'STK push sent' : 'Payment instructions sent')()
  // Approving needs the amount the reviewer matched on the till
  // statement; the "KSh received" input (blank = the amount due) feeds
  // both this and mark-paid. A short amount prompts for an override
  // reason, same as the queue page.
  const approvePayment = (p) => run(async () => {
    const amt = Math.round(Number(amountReceived.trim() === '' ? p.amount_due_kes : amountReceived))
    if (!Number.isFinite(amt) || amt <= 0) {
      throw Object.assign(new Error(), { response: { data: { message: 'Enter the amount received on the till statement' } } })
    }
    try {
      return await paymentsApi.approve(p.id, { amountReceived: amt })
    } catch (e) {
      if (e.response?.data?.error !== 'amount_mismatch') throw e
      const reason = window.prompt(`${e.response.data.message}`)
      if (!reason || reason.trim().length < 10) throw e
      return await paymentsApi.approve(p.id, { amountReceived: amt, overrideReason: reason.trim() })
    }
  }, 'Payment approved')()
  // Record a till payment even when no payments row exists yet — the
  // common case, since customers who confirm a quote on WhatsApp pay
  // immediately without an operator ever pressing "request payment".
  const markPaid = run(async () => {
    const outstanding = Number(
      ['quoting', 'quoted', 'confirmed'].includes(order?.status)
        ? order?.quote_kes : order?.delivery_fee_kes
    ) || 0
    const amt = amountReceived.trim() === '' ? outstanding : Math.round(Number(amountReceived))
    if (!Number.isFinite(amt) || amt <= 0) {
      throw Object.assign(new Error(), { response: { data: { message: 'Enter the amount received on the till statement' } } })
    }
    try {
      const res = await waApi.markPaid(id, {
        mpesa_reference: mpesaRef.trim() || null,
        amount_received_kes: amt,
      })
      setMpesaRef(''); setAmountReceived('')
      return res
    } catch (e) {
      if (e.response?.data?.error !== 'amount_mismatch') throw e
      const reason = window.prompt(`${e.response.data.message}`)
      if (!reason || reason.trim().length < 10) throw e
      const res = await waApi.markPaid(id, {
        mpesa_reference: mpesaRef.trim() || null,
        amount_received_kes: amt,
        override_reason: reason.trim(),
      })
      setMpesaRef(''); setAmountReceived('')
      return res
    }
  }, 'Payment recorded — tracking code and receipt sent')
  const resendReceipt = run(() => waApi.resendReceipt(id), 'Receipt re-sent')
  const saveSupplierRef = run(
    () => waApi.setSupplierRef([id], supplierRef.trim() || null),
    supplierRef.trim() ? 'Supplier order saved' : 'Supplier order cleared')
  const openReceipt = async () => {
    try {
      const res = await waApi.receiptUrl(id)
      window.open(res.data.url, '_blank', 'noopener')
    } catch (e) {
      toast.error(e.response?.data?.message || 'No receipt yet')
    }
  }

  if (!order) {
    return <div className="max-w-4xl mx-auto px-4 py-16 text-center text-mute">Loading…</div>
  }

  const links = Array.isArray(order.product_links) ? order.product_links : []
  const awaitingReview = payments.find((p) => p.status === 'awaiting_review')
  const feePayable = ['in_kenya', 'delivery_fee_pending'].includes(order.status)
    && !order.delivery_fee_waived && !order.delivery_fee_paid_at && Number(order.delivery_fee_kes) > 0
  // Label needs something to call the item: the operator's note, else
  // the retailer host off the first product link.
  const itemName = order.product_note
    || (links[0] ? (() => { try { return `Order from ${new URL(links[0]).hostname.replace(/^www\./, '')}` } catch { return '' } })() : '')
    || 'Personal effects'
  // What the customer still owes, by stage — mirrors the server's rule in
  // POST /wa/orders/:id/mark-paid.
  const outstandingKes = ['quoting', 'quoted', 'confirmed'].includes(order.status)
    ? Number(order.quote_kes || 0)
    : feePayable ? Number(order.delivery_fee_kes || 0) : 0
  const owesMoney = outstandingKes > 0

  // Same arithmetic the server runs on Send: usd × rate × (1 + margin%)
  // + last-mile fee. Blank margin falls back to the settings default,
  // matching the server's behaviour.
  //
  // quoteDefaults.usd_kes is already the BUFFERED rate — mid plus
  // wa_settings.fx_buffer_pct, rounded to the 2dp the quote message
  // prints — so this preview and the customer's total agree to the
  // shilling. usd_kes_mid is carried alongside only to show the
  // operator what the cushion is costing them.
  const preview = (() => {
    if (!quoteDefaults) return null
    const price = Number(usd)
    if (!Number.isFinite(price) || price <= 0) return null
    const pct = margin.trim() === '' ? Number(quoteDefaults.markup_pct_default) : Number(margin)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null
    const goods = Math.round(price * Number(quoteDefaults.usd_kes) * (1 + pct / 100))
    const fee = method === 'collection' ? 0 : Number(quoteDefaults.default_delivery_fee_kes || 0)
    return {
      goods, fee, total: goods + fee, pct,
      rate: Number(quoteDefaults.usd_kes),
      mid: Number(quoteDefaults.usd_kes_mid) || null,
      buffer: Number(quoteDefaults.fx_buffer_pct) || 0,
    }
  })()

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <GlassStyles />
      <Link to="/ops/pipeline" className="inline-flex items-center gap-1.5 text-sm text-mute hover:text-white mb-4">
        <ArrowLeft size={15} /> Pipeline
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeading icon={Package}
          title={order.tracking_code || order.order_code || 'New quote'}
          subtitle={`${order.full_name || order.phone} · ${order.customer_code || 'onboarding'}`} />
        <div className="flex items-center gap-2">
          <StatusBadge status={order.status} />
          {order.tracking_code && (
            <button onClick={() => setPrintOpen(true)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10 text-sm">
              <Printer size={15} /> Label
            </button>
          )}
          <Link to={`/ops/inbox?contact=${order.contact_id}`}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10 text-sm">
            <MessageSquareText size={15} /> Chat
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Quote / money ── */}
        <GlassCard className="p-5">
          <h2 className="font-bold text-white mb-4">Quote</h2>
          {/* Product links — editable. A frozen list meant quoting from a
              wrong one or recreating the order when a customer sent a
              second cart or dropped an item. */}
          <div className="mb-4">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-xs font-semibold text-mute">
                Product links{linkDraft.length ? ` (${linkDraft.length})` : ''}
              </span>
              {linksDirty && (
                <button onClick={saveLinks} disabled={busy}
                  className="px-2.5 py-1 rounded-lg bg-ember-600 hover:bg-ember-500 text-white text-xs font-semibold disabled:opacity-50">
                  Save links
                </button>
              )}
            </div>
            <div className="space-y-1">
              {linkDraft.map((l, i) => (
                <div key={`${l}-${i}`} className="flex items-center gap-2 group">
                  <a href={l} target="_blank" rel="noreferrer"
                    className="flex-1 min-w-0 text-xs text-ember-400 hover:text-ember-300 truncate">{l}</a>
                  <button onClick={() => removeLink(i)} disabled={busy}
                    title="Remove this link"
                    className="shrink-0 px-1.5 rounded text-mute hover:text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                    ×
                  </button>
                </div>
              ))}
              {linkDraft.length === 0 && (
                <p className="text-xs text-mute/70">No links yet — paste the customer's cart or product link below.</p>
              )}
            </div>
            <div className="flex gap-2 mt-2">
              <input value={newLink} onChange={(e) => setNewLink(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink() } }}
                placeholder="Paste a cart or product link"
                className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-white/5 border border-line text-white placeholder:text-mute text-xs focus:outline-none focus:border-ember-500/50" />
              <button onClick={addLink} disabled={busy || !newLink.trim()}
                className="px-3 py-1.5 rounded-lg bg-white/5 border border-line text-white text-xs font-semibold hover:bg-white/10 disabled:opacity-50">
                Add
              </button>
            </div>
            {linksDirty && (
              <p className="text-xs text-amber-300/80 mt-1.5">
                Unsaved changes — tap Save links.
                {['quoted', 'confirmed'].includes(order.status) && ' This order is already quoted, so re-quote if the price has moved.'}
              </p>
            )}
          </div>
          {['quoting', 'quoted'].includes(order.status) ? (
            <>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-mute text-sm">$</span>
                  <input value={usd} onChange={(e) => setUsd(e.target.value)} inputMode="decimal"
                    placeholder="Item price in USD"
                    className="w-full pl-7 pr-3 py-2.5 rounded-xl bg-white/5 border border-line text-white placeholder:text-mute focus:outline-none focus:border-ember-500/50" />
                </div>
                <div className="relative w-32">
                  <input value={margin} onChange={(e) => setMargin(e.target.value)} inputMode="decimal"
                    placeholder="Margin"
                    className="w-full pl-3 pr-7 py-2.5 rounded-xl bg-white/5 border border-line text-white placeholder:text-mute focus:outline-none focus:border-ember-500/50" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-mute text-sm">%</span>
                </div>
                <button onClick={sendQuote} disabled={busy}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-ember-600 hover:bg-ember-500 text-white font-semibold disabled:opacity-50">
                  <Send size={16} /> {order.status === 'quoted' ? 'Re-quote' : 'Send quote'}
                </button>
              </div>
              <div className="mt-3 flex gap-2">
                {[
                  // Pickup Mtaani is a delivery: the customer collects it,
                  // but it costs us to send the parcel there, so it is
                  // charged like a door delivery. Only coming to the CBD
                  // office is free.
                  { v: 'delivery', label: 'Address or Mtaani' },
                  { v: 'collection', label: 'Collect at CBD — free' },
                ].map((o) => (
                  <button key={o.v} type="button" onClick={() => setMethod(o.v)}
                    className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition ${
                      method === o.v
                        ? 'bg-ember-600/20 border-ember-500/60 text-white'
                        : 'bg-white/5 border-line text-mute hover:text-white'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
              {/* What Send will actually tell the customer, before it does. */}
              {preview ? (
                <div className="mt-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 px-3.5 py-2.5 text-sm">
                  <span className="text-emerald-200">
                    ${Number(usd).toFixed(2)} × {preview.rate.toFixed(2)}
                    {preview.pct > 0 ? ` + ${preview.pct}%` : ''}
                    {preview.fee > 0 ? ` + KSh ${preview.fee.toLocaleString()} delivery` : ''}
                    {' = '}
                  </span>
                  <span className="text-white font-bold">KSh {preview.total.toLocaleString()}</span>
                  <span className="text-emerald-200/80"> — the customer will be quoted this total.</span>
                  {preview.buffer > 0 && preview.mid ? (
                    <p className="text-xs text-emerald-200/70 mt-1">
                      Rate includes a {preview.buffer}% FX buffer over today's mid-market{' '}
                      {preview.mid.toFixed(2)} — that covers the KES→GBP spread, so don't
                      discount it away. Change it under Settings.
                    </p>
                  ) : null}
                </div>
              ) : quoteDefaults === null && Number(usd) > 0 ? (
                <p className="text-xs text-amber-300/80 mt-2">
                  Live rate unavailable — the total will only be visible after sending.
                </p>
              ) : null}
              <p className="text-xs text-mute mt-1.5">
                The 10% service fee is SHEIN only, and is waived while the promotion runs.
                Enter <span className="text-white">0</span> for UK (£9/kg + £3) and Dubai ($9/kg)
                orders. Leave blank to use the default from Settings.
                {' '}Delivery adds the last-mile fee to this quote, so nothing is asked for on
                arrival; collection adds nothing.
              </p>
            </>
          ) : null}
          {order.quote_kes && (
            <div className="mt-4 grid grid-cols-2 gap-y-1.5 text-sm">
              <span className="text-mute">Item price</span>
              <span className="text-white text-right">${Number(order.usd_price).toFixed(2)}</span>
              <span className="text-mute">Rate</span>
              <span className="text-white text-right">
                1 USD = {Number(order.fx_rate).toFixed(2)} KES
                {order.fx_buffer_pct != null && Number(order.fx_buffer_pct) > 0
                  ? ` (incl. ${Number(order.fx_buffer_pct)}% FX buffer)` : ''}
              </span>
              <span className="text-mute">Margin</span>
              <span className="text-white text-right">{Number(order.markup_pct)}%</span>
              {order.delivery_fee_in_quote && (
                <>
                  <span className="text-mute">
                    {order.delivery_method === 'collection' ? 'Collection' : 'Last-mile delivery'}
                  </span>
                  <span className="text-white text-right">
                    {Number(order.delivery_fee_kes) > 0
                      ? `KSh ${Number(order.delivery_fee_kes).toLocaleString()}`
                      : 'free'}
                  </span>
                </>
              )}
              <span className="text-mute font-semibold">Total</span>
              <span className="text-ember-400 font-bold text-right">KSh {Number(order.quote_kes).toLocaleString()}</span>
            </div>
          )}

          {order.delivery_method !== 'collection' && (
            <div className="mt-4 pt-4 border-t border-line">
              <span className="block text-xs font-semibold text-mute mb-1.5">
                Pickup Mtaani point <span className="font-normal">(leave blank for door delivery)</span>
              </span>
              <div className="flex gap-2">
                <input list="mtaani-agents" value={pickup} onChange={(e) => setPickup(e.target.value)}
                  placeholder="Search an area, e.g. Hurlingham"
                  className="flex-1 px-3 py-2.5 rounded-xl bg-white/5 border border-line text-white placeholder:text-mute text-sm focus:outline-none focus:border-ember-500/50" />
                <datalist id="mtaani-agents">
                  {MTAANI_AGENTS.map((a) => <option key={a} value={a} />)}
                </datalist>
                <button onClick={savePickup} disabled={busy}
                  className="px-3 py-2.5 rounded-xl bg-white/5 border border-line text-white text-sm font-semibold hover:bg-white/10 disabled:opacity-50">
                  Save
                </button>
              </div>
              <p className="text-xs text-mute mt-1.5">
                Set this and the dispatch message names the point instead of promising a rider.
                Suggestions come from the agent list — type anything if the agent you want isn't there.
              </p>
            </div>
          )}

          {/* Stage actions */}
          <div className="mt-5 flex flex-wrap gap-2">
            {order.status === 'quoted' && (
              <button onClick={confirm} disabled={busy}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10 text-sm">
                <CheckCircle2 size={15} /> Confirm for customer
              </button>
            )}
            {['confirmed', 'quoted'].includes(order.status) && (
              <>
                {stkAvailable && (
                  <button onClick={() => requestPay('stk', 'order')} disabled={busy}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 text-white text-sm font-semibold">
                    <Smartphone size={15} /> M-Pesa STK push
                  </button>
                )}
                <button onClick={() => requestPay('manual', 'order')} disabled={busy}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 text-white text-sm font-semibold">
                  <HandCoins size={15} /> Send till instructions
                </button>
              </>
            )}
            {nextActions(order).map((a) => (
              <button key={a.to} onClick={() => advance(a.to)} disabled={busy}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-ember-600 hover:bg-ember-500 text-white text-sm font-semibold disabled:opacity-50">
                {a.label}
              </button>
            ))}
            {['quoting', 'quoted', 'confirmed'].includes(order.status) && (
              <button onClick={() => advance('cancelled')} disabled={busy}
                className="px-3.5 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 text-sm">
                Cancel
              </button>
            )}
          </div>

          {/* Payment received — the manual-M-Pesa approval, in the place
              the operator is already looking. Always visible while money
              is outstanding, whether or not a payments row exists yet. */}
          {owesMoney && (
            <div className="mt-5 pt-4 border-t border-line">
              <h3 className="text-sm font-bold text-white mb-1">Payment</h3>
              <p className="text-xs text-mute mb-3">
                KSh {Number(outstandingKes).toLocaleString()} outstanding · Buy Goods till
                {awaitingReview?.mpesa_reference
                  ? ` · customer's ref ${awaitingReview.mpesa_reference}`
                  : ''}
              </p>
              {/* Operators record payments too — this was admin-only, and
                  operators were pointed at a queue page they couldn't open. */}
              <div className="flex flex-wrap gap-2">
                <input value={mpesaRef} onChange={(e) => setMpesaRef(e.target.value.toUpperCase())}
                  placeholder="M-Pesa ref (optional)" maxLength={32}
                  className="flex-1 min-w-[10rem] px-3 py-2 rounded-lg bg-white/5 border border-line text-white placeholder:text-mute text-sm focus:outline-none focus:border-ember-500/50" />
                <input value={amountReceived} onChange={(e) => setAmountReceived(e.target.value)}
                  inputMode="numeric"
                  placeholder={`KSh received (${Number(outstandingKes).toLocaleString()})`}
                  className="w-40 px-3 py-2 rounded-lg bg-white/5 border border-line text-white placeholder:text-mute text-sm focus:outline-none focus:border-ember-500/50" />
                <button onClick={markPaid} disabled={busy}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold disabled:opacity-50">
                  <CheckCircle2 size={15} /> Payment received
                </button>
              </div>
            </div>
          )}

          {/* Delivery fee */}
          {['in_kenya', 'delivery_fee_pending'].includes(order.status) && (
            <div className="mt-5 pt-4 border-t border-line">
              <h3 className="text-sm font-bold text-white mb-2">Last-mile delivery fee</h3>
              <p className="text-sm text-mute mb-3">
                {order.delivery_fee_waived
                  ? 'Waived 🎉'
                  : order.delivery_fee_paid_at
                    ? 'Paid ✅'
                    : `KSh ${Number(order.delivery_fee_kes || 0).toLocaleString()} pending`}
              </p>
              {feePayable && (
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => requestPay(stkAvailable ? 'stk' : 'manual', 'delivery_fee')} disabled={busy}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 text-white text-sm font-semibold">
                    {stkAvailable ? <><Smartphone size={15} /> STK for fee</> : <><HandCoins size={15} /> Request fee</>}
                  </button>
                  <button onClick={waive} disabled={busy}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10 text-sm">
                    <Gift size={15} /> Waive fee
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Receipt */}
          {order.paid_at && (
            <div className="mt-5 pt-4 border-t border-line flex flex-wrap gap-2">
              <button onClick={openReceipt}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10 text-sm">
                <FileText size={15} /> View receipt
              </button>
              <button onClick={resendReceipt} disabled={busy}
                className="px-3.5 py-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10 text-sm">
                Re-send to customer
              </button>
            </div>
          )}
        </GlassCard>

        {/* ── Payments + timeline ── */}
        <div className="space-y-4">
          <GlassCard className="p-5">
            <h2 className="font-bold text-white mb-3">Payments</h2>
            {payments.length === 0 && <p className="text-sm text-mute">None yet</p>}
            <div className="space-y-2">
              {payments.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="text-white truncate">KSh {Number(p.amount_due_kes).toLocaleString()} · {p.mpesa_provider}</p>
                    <p className="text-xs text-mute">{new Date(p.created_at).toLocaleString('en-KE')}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={p.status} />
                    {p.status === 'awaiting_review' && (
                      <button onClick={() => approvePayment(p)} disabled={busy}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">
                        Approve
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </GlassCard>

          <GlassCard className="p-5">
            <h2 className="font-bold text-white mb-1">Supplier order</h2>
            <p className="text-xs text-mute mb-3">
              The retailer's own number — SHEIN, Amazon, whoever we bought from.
              Give several of our orders the same number and they group together.
            </p>
            <div className="flex gap-2">
              <input
                value={supplierRef}
                onChange={(e) => setSupplierRef(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveSupplierRef() }}
                placeholder="e.g. GSHMU0A9K00A1YW"
                className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-white/5 border border-line text-white placeholder:text-mute text-sm focus:outline-none focus:border-ember-500/50"
              />
              <button onClick={saveSupplierRef} disabled={busy}
                className="px-3 py-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10 text-sm disabled:opacity-50">
                Save
              </button>
            </div>
            {siblings.length > 0 && (
              <div className="mt-3 pt-3 border-t border-line">
                <p className="text-xs text-mute mb-2">
                  {siblings.length} other {siblings.length === 1 ? 'parcel' : 'parcels'} in this supplier order
                </p>
                <div className="space-y-1">
                  {siblings.map((s) => (
                    <Link key={s.id} to={`/ops/orders/${s.id}`}
                      className="flex items-center justify-between gap-2 text-xs hover:bg-white/5 rounded px-1.5 py-1 -mx-1.5">
                      <span className="text-ember-400 font-bold shrink-0">
                        {s.tracking_code || s.order_code || s.customer_code || 'New quote'}
                      </span>
                      <span className="text-mute truncate">{s.full_name || s.phone}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </GlassCard>

          <GlassCard className="p-5">
            <h2 className="font-bold text-white mb-3">Delivery details</h2>
            {/* Which journey this parcel is on — and the switch, so a
                customer who changes their mind doesn't get rider messages
                for a parcel they'll collect (or vice versa). */}
            <div className="flex items-center justify-between gap-2 mb-3 pb-3 border-b border-line">
              <span className="text-sm text-white">
                {order.delivery_method === 'collection' ? 'Collection — CBD office' : 'Delivery to address / Mtaani'}
              </span>
              {!['dispatched', 'delivered', 'collected', 'cancelled'].includes(order.status) && (
                <button
                  onClick={() => switchMethod(order.delivery_method === 'collection' ? 'delivery' : 'collection')}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg bg-white/5 border border-line text-white text-xs font-semibold hover:bg-white/10 disabled:opacity-50">
                  Switch to {order.delivery_method === 'collection' ? 'delivery' : 'collection'}
                </button>
              )}
            </div>
            <p className="text-sm text-white">{order.full_name || '—'}</p>
            <p className="text-sm text-mute">{order.delivery_address || 'No address on file'}</p>
            <p className="text-sm text-mute mt-1">M-Pesa: {order.mpesa_number || '—'}</p>
            {order.customer_code && (
              <p className="text-xs text-ember-400 font-bold mt-2">
                Ship-to label: {order.full_name} — {order.customer_code}
              </p>
            )}
          </GlassCard>

          <GlassCard className="p-5">
            <h2 className="font-bold text-white mb-3">History</h2>
            <div className="space-y-2">
              {events.map((ev) => (
                <div key={ev.id} className="text-xs">
                  <span className="text-white font-semibold">{String(ev.to_status).replace(/_/g, ' ')}</span>
                  <span className="text-mute"> · {new Date(ev.created_at).toLocaleString('en-KE')}</span>
                  {ev.note && <p className="text-mute">{ev.note}</p>}
                </div>
              ))}
              {events.length === 0 && <p className="text-sm text-mute">No events yet</p>}
            </div>
          </GlassCard>
        </div>
      </div>

      {printOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setPrintOpen(false)}>
          <div className="bg-white rounded-xl p-4 max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <PrintableParcelLabel parcel={{
              tracking_number: order.tracking_code,
              name: order.full_name,
              customer_code: order.customer_code,
              phone: order.phone,
              delivery_address: order.delivery_address,
              description: itemName,
              created_at: order.created_at,
            }} />
            <div className="flex gap-2 mt-3 print:hidden">
              <button onClick={() => window.print()}
                className="px-4 py-2 rounded-lg bg-ember-600 text-white text-sm font-semibold">Print</button>
              <button onClick={() => setPrintOpen(false)}
                className="px-4 py-2 rounded-lg bg-gray-200 text-gray-800 text-sm">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
