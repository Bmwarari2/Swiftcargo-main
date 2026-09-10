import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { KanbanSquare, Search, ScanLine, MessageSquareText, RefreshCw, UserPlus, PackagePlus, Tags, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { waApi } from '../../api'
import { GlassStyles, GlassCard, PageHeading, StatusBadge } from '../../components/GlassUI'
import { BarcodeScanner } from '../../components/BarcodeScanner'
import { AddOrderModal, AddCustomerModal } from '../../components/AddOrderModal'
import { useWaPipelineUpdates } from '../../hooks/useRealtimeUpdates'

// Everything still moving. Fetched in full (up to 500) separately from
// the recently-finished orders, because the single 200-row recency query
// used to let delivered parcels crowd old-but-active ones off the board
// silently.
const ACTIVE_STATUSES = [
  'quoting', 'quoted', 'confirmed', 'paid', 'purchased',
  'in_kenya', 'delivery_fee_pending', 'dispatched',
]

// Stages the bulk tools can move parcels to. Each order is validated
// individually server-side, so a mixed batch fails only where it should.
const BULK_TARGETS = [
  { v: 'purchased', label: 'Purchased' },
  { v: 'in_kenya', label: 'Arrived in Kenya' },
  { v: 'dispatched', label: 'Dispatched' },
  { v: 'delivered', label: 'Delivered' },
  { v: 'collected', label: 'Collected (CBD orders)' },
]

// The five visual columns of the spec, each grouping its DB statuses.
const COLUMNS = [
  { title: 'Quoting', statuses: ['quoting', 'quoted', 'confirmed'] },
  { title: 'Paid', statuses: ['paid'] },
  { title: 'Purchased', statuses: ['purchased'] },
  { title: 'In Kenya', statuses: ['in_kenya', 'delivery_fee_pending'] },
  { title: 'Delivered', statuses: ['dispatched', 'delivered', 'collected'] },
]

export function Pipeline() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [scanOpen, setScanOpen] = useState(false)
  const [addOrderOpen, setAddOrderOpen] = useState(false)
  const [addCustomerOpen, setAddCustomerOpen] = useState(false)
  // Tagging mode: tick the parcels that went into one supplier purchase.
  const [tagging, setTagging] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const [supplierRef, setSupplierRef] = useState('')
  // Bulk-advance mode: tick parcels (or scan them in a row) and move
  // them all one stage — the flight-landed workflow.
  const [advancing, setAdvancing] = useState(false)
  const [bulkStatus, setBulkStatus] = useState('in_kenya')
  const [scanMode, setScanMode] = useState('open') // 'open' navigates; 'advance' advances each scan
  const navigate = useNavigate()

  // The query the board is actually showing — set on submit, not on every
  // keystroke. SSE refreshes used to re-query with the live input value,
  // so typing three characters without pressing Enter silently re-filtered
  // the whole board to that half-typed string the moment any pipeline
  // event arrived.
  const submittedQ = useRef('')

  const load = useCallback(async (query = submittedQ.current, { quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      if (query) {
        const res = await waApi.orders({ q: query })
        setOrders(res.data.orders || [])
      } else {
        const [active, done] = await Promise.all([
          waApi.orders({ status: ACTIVE_STATUSES.join(','), limit: 500 }),
          waApi.orders({ status: 'delivered,collected', limit: 30 }),
        ])
        setOrders([...(active.data.orders || []), ...(done.data.orders || [])])
      }
    } catch (e) {
      if (!quiet) toast.error(e.response?.data?.message || 'Failed to load orders')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useWaPipelineUpdates(() => load(submittedQ.current, { quiet: true }))

  const onSearch = (e) => {
    e.preventDefault()
    submittedQ.current = q.trim()
    load(submittedQ.current)
  }

  const onScan = async (code) => {
    if (scanMode === 'advance') {
      // Continuous mode: the camera stays open; every scanned parcel is
      // advanced to the chosen stage with an audible-enough toast.
      try {
        const found = await waApi.scan(code)
        const o = found.data.order
        const res = await waApi.advanceBatch([o.id], bulkStatus)
        const r = res.data.results?.[0]
        if (r?.ok) toast.success(`${o.tracking_code || code} → ${bulkStatus.replace(/_/g, ' ')}`)
        else toast.error(`${o.tracking_code || code}: ${r?.reason || 'not moved'}`)
        load(undefined, { quiet: true })
      } catch (e) {
        toast.error(e.response?.data?.message || `No order found for ${code}`)
      }
      return
    }
    setScanOpen(false)
    try {
      const res = await waApi.scan(code)
      navigate(`/ops/orders/${res.data.order.id}`)
    } catch (e) {
      toast.error(e.response?.data?.message || `No order found for ${code}`)
    }
  }

  const togglePicked = (orderId) => setPicked((prev) => {
    const next = new Set(prev)
    next.has(orderId) ? next.delete(orderId) : next.add(orderId)
    return next
  })

  const cancelTagging = () => {
    setTagging(false)
    setPicked(new Set())
    setSupplierRef('')
  }

  const cancelAdvancing = () => {
    setAdvancing(false)
    setPicked(new Set())
    setScanMode('open')
    setScanOpen(false)
  }

  const applyBulk = async () => {
    if (picked.size === 0) return toast.error('Tick the parcels to move')
    try {
      const res = await waApi.advanceBatch([...picked], bulkStatus)
      const { advanced, failed, results } = res.data
      if (failed > 0) {
        const reasons = (results || []).filter((r) => !r.ok).slice(0, 3)
          .map((r) => r.reason).filter(Boolean).join('; ')
        toast.error(`${advanced} moved, ${failed} skipped${reasons ? ` — ${reasons}` : ''}`, { duration: 8000 })
      } else {
        toast.success(`${advanced} ${advanced === 1 ? 'parcel' : 'parcels'} moved — each customer has been messaged`)
      }
      cancelAdvancing()
      load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Bulk advance failed')
    }
  }

  const applySupplierRef = async () => {
    const ref = supplierRef.trim()
    if (!ref) return toast.error('Enter the supplier order number')
    if (picked.size === 0) return toast.error('Tick the parcels that went into it')
    try {
      const res = await waApi.setSupplierRef([...picked], ref)
      toast.success(`${res.data.updated} ${res.data.updated === 1 ? 'parcel' : 'parcels'} tagged to ${ref}`)
      cancelTagging()
      load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Could not tag the orders')
    }
  }

  const byColumn = useMemo(() => COLUMNS.map((col) => ({
    ...col,
    orders: orders.filter((o) => col.statuses.includes(o.status)),
  })), [orders])

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <GlassStyles />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeading icon={KanbanSquare} title="Order Pipeline"
          subtitle="Quoting → Paid → Purchased → In Kenya → Delivered" />
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setAddCustomerOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-line text-white hover:bg-white/10 transition-colors">
            <UserPlus size={18} /> Customer
          </button>
          <button onClick={() => setAddOrderOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-ember-600 hover:bg-ember-500 text-white font-semibold transition-colors">
            <PackagePlus size={18} /> Add order
          </button>
          <button onClick={() => (advancing ? cancelAdvancing() : (cancelTagging(), setAdvancing(true)))}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-colors ${
              advancing
                ? 'bg-ember-600 border-ember-500 text-white'
                : 'bg-white/5 border-line text-white hover:bg-white/10'
            }`}>
            {advancing ? <X size={18} /> : <ScanLine size={18} />} {advancing ? 'Cancel' : 'Bulk advance'}
          </button>
          <button onClick={() => (tagging ? cancelTagging() : (cancelAdvancing(), setTagging(true)))}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-colors ${
              tagging
                ? 'bg-ember-600 border-ember-500 text-white'
                : 'bg-white/5 border-line text-white hover:bg-white/10'
            }`}>
            {tagging ? <X size={18} /> : <Tags size={18} />} {tagging ? 'Cancel' : 'Tag supplier order'}
          </button>
          <button onClick={() => setScanOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-line text-white hover:bg-white/10 transition-colors">
            <ScanLine size={18} /> Scan
          </button>
          <button onClick={() => load()}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-line text-white hover:bg-white/10 transition-colors">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <form onSubmit={onSearch} className="relative mb-6 max-w-xl">
        <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-mute" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by ORD-number, TRK-code, TC-code, supplier order, name or phone… (USB scanners type here too)"
          className="w-full pl-11 pr-4 py-3 rounded-xl bg-white/5 border border-line text-white placeholder:text-mute focus:outline-none focus:border-ember-500/50"
        />
      </form>

      {advancing && (
        <GlassCard className="p-4 mb-6 border-ember-500/40">
          <div className="flex flex-wrap items-center gap-3">
            <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}
              className="px-3 py-2 rounded-lg bg-surface border border-line text-white text-sm focus:outline-none">
              {BULK_TARGETS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
            <span className="text-sm text-mute">
              {picked.size} {picked.size === 1 ? 'parcel' : 'parcels'} ticked
            </span>
            <button onClick={applyBulk}
              className="px-4 py-2 rounded-lg bg-ember-600 hover:bg-ember-500 text-white font-semibold text-sm">
              Move them
            </button>
            <button onClick={() => { setScanMode('advance'); setScanOpen(true) }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-line text-white text-sm hover:bg-white/10">
              <ScanLine size={16} /> Scan to advance
            </button>
          </div>
          <p className="text-xs text-mute mt-2">
            Tick parcels and move them one stage together, or keep the scanner open and
            advance each parcel as you scan its label — every customer gets the normal
            stage message.
          </p>
        </GlassCard>
      )}

      {tagging && (
        <GlassCard className="p-4 mb-6 border-ember-500/40">
          <div className="flex flex-wrap items-center gap-3">
            <Tags size={18} className="text-ember-400 shrink-0" />
            <input
              value={supplierRef}
              onChange={(e) => setSupplierRef(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applySupplierRef() }}
              placeholder="Supplier order number, e.g. GSHMU0A9K00A1YW"
              autoFocus
              className="flex-1 min-w-[220px] px-3 py-2 rounded-lg bg-white/5 border border-line text-white placeholder:text-mute text-sm focus:outline-none focus:border-ember-500/50"
            />
            <span className="text-sm text-mute">
              {picked.size} {picked.size === 1 ? 'parcel' : 'parcels'} ticked
            </span>
            <button onClick={applySupplierRef}
              className="px-4 py-2 rounded-lg bg-ember-600 hover:bg-ember-500 text-white font-semibold text-sm">
              Tag them
            </button>
          </div>
          <p className="text-xs text-mute mt-2">
            Tick every parcel that went into this one purchase. They will all carry the
            number, so searching it later brings back the whole batch.
          </p>
        </GlassCard>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {byColumn.map((col) => (
          <div key={col.title}>
            <div className="flex items-center justify-between mb-3 px-1">
              <h2 className="text-sm font-bold uppercase tracking-wider text-mute">{col.title}</h2>
              <span className="text-xs font-bold text-white bg-white/10 rounded-full px-2 py-0.5">
                {col.orders.length}
              </span>
            </div>
            <div className="space-y-3 min-h-[80px]">
              {col.orders.map((o) => {
                const card = (
                  <GlassCard className={`p-4 transition-colors ${
                    (tagging || advancing) && picked.has(o.id)
                      ? 'border-ember-500 bg-ember-500/10'
                      : 'hover:border-ember-500/40'
                  }`}>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="font-bold text-white text-sm truncate">
                        {(tagging || advancing) && (picked.has(o.id) ? '☑ ' : '☐ ')}
                        {o.tracking_code || o.order_code || o.customer_code || 'New quote'}
                      </span>
                      <StatusBadge status={o.status} />
                    </div>
                    <p className="text-xs text-mute truncate">
                      {o.full_name || o.phone}
                      {o.quote_kes ? ` · KSh ${Number(o.quote_kes).toLocaleString()}` : ''}
                    </p>
                    {o.supplier_ref && (
                      <p className="text-[11px] text-ember-400/90 truncate mt-1" title={o.supplier_ref}>
                        <Tags size={10} className="inline mr-1 -mt-0.5" />{o.supplier_ref}
                      </p>
                    )}
                  </GlassCard>
                )
                // While tagging, a card is a checkbox — following the link
                // would lose the ticks you already made.
                return (tagging || advancing) ? (
                  <button key={o.id} type="button" onClick={() => togglePicked(o.id)}
                    className="block w-full text-left">
                    {card}
                  </button>
                ) : (
                  <Link key={o.id} to={`/ops/orders/${o.id}`} className="block">{card}</Link>
                )
              })}
              {!loading && col.orders.length === 0 && (
                <p className="text-xs text-mute/60 px-1">Nothing here</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8">
        <Link to="/ops/inbox" className="inline-flex items-center gap-2 text-ember-400 hover:text-ember-300 text-sm font-semibold">
          <MessageSquareText size={16} /> Open the WhatsApp inbox to start a new quote
        </Link>
      </div>

      <BarcodeScanner open={scanOpen} onScan={onScan} continuous={scanMode === 'advance'}
        onClose={() => { setScanOpen(false); setScanMode('open') }} />
      {addCustomerOpen && (
        <AddCustomerModal onClose={() => setAddCustomerOpen(false)} onAdded={() => load()} />
      )}
      {addOrderOpen && (
        <AddOrderModal onClose={() => setAddOrderOpen(false)}
          onCreated={(o) => navigate(`/ops/orders/${o.id}`)} />
      )}
    </div>
  )
}
