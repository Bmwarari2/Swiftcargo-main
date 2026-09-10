import React, { useEffect, useMemo, useState } from 'react'
import { UserPlus, PackagePlus, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { waApi } from '../api'
import { GlassCard } from './GlassUI'

// Work does not always arrive through WhatsApp in the right order. Someone
// DMs on Instagram, pays by hand, and the parcel is already in Nairobi
// before anyone opens the dashboard. These two modals are the way to put
// that into the system without pretending it started at "quoting".

const STAGES = [
  { value: 'quoting',              label: 'Quoting — no price yet' },
  { value: 'quoted',              label: 'Quoted — waiting on their yes' },
  { value: 'confirmed',           label: 'Confirmed — waiting on payment' },
  { value: 'paid',                label: 'Paid — not bought yet' },
  { value: 'purchased',           label: 'Purchased — on its way to us' },
  { value: 'in_kenya',            label: 'In Kenya — ready to dispatch' },
  { value: 'delivery_fee_pending', label: 'In Kenya — delivery fee owed' },
  { value: 'dispatched',          label: 'Out for delivery' },
  { value: 'delivered',           label: 'Delivered' },
]
// Past this point the customer has been told a number, so we need one.
const NEEDS_AMOUNT = STAGES.findIndex((s) => s.value === 'confirmed')

const field = 'w-full px-3 py-2.5 rounded-xl bg-white/5 border border-line text-white placeholder:text-mute text-sm focus:outline-none focus:border-ember-500/50'
const label = 'block text-xs font-semibold text-mute mb-1.5'

function Modal({ title, icon: Icon, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center p-4 overflow-auto"
      onClick={onClose}>
      <GlassCard className="w-full max-w-lg mt-12 p-5" >
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-white inline-flex items-center gap-2">
              <Icon size={17} /> {title}
            </h2>
            <button onClick={onClose} className="text-mute hover:text-white"><X size={18} /></button>
          </div>
          {children}
        </div>
      </GlassCard>
    </div>
  )
}

/** Add a customer who came from Instagram, TikTok, a call, a referral. */
export function AddCustomerModal({ onClose, onAdded }) {
  const [f, setF] = useState({ phone: '', full_name: '', delivery_address: '', source: 'Instagram', note: '' })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    if (!f.phone.trim()) return toast.error('A phone number is required')
    setBusy(true)
    try {
      const res = await waApi.addContact(f)
      const c = res.data.contact
      toast.success(c.customer_code ? `Added — ${c.customer_code}` : 'Added — give them a name to issue a customer code')
      onAdded?.(c)
      onClose()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add the customer')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Add a customer" icon={UserPlus} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <span className={label}>WhatsApp number *</span>
          <input value={f.phone} onChange={set('phone')} placeholder="0712 345 678, or +44… with the country code" className={field} autoFocus />
        </div>
        <div>
          <span className={label}>Full name</span>
          <input value={f.full_name} onChange={set('full_name')} placeholder="As it goes on their parcels" className={field} />
        </div>
        <div>
          <span className={label}>Delivery address</span>
          <input value={f.delivery_address} onChange={set('delivery_address')} placeholder="Building, street, town, county" className={field} />
        </div>
        <div>
          <span className={label}>Came from</span>
          <input value={f.source} onChange={set('source')} placeholder="Instagram, TikTok, referral…" className={field} />
        </div>
        <p className="text-xs text-mute">
          A name is enough to get them a customer code. Whatever you leave blank, the
          assistant asks for the next time they message.
        </p>
        <button disabled={busy}
          className="w-full py-2.5 rounded-xl bg-ember-600 hover:bg-ember-500 text-white font-semibold disabled:opacity-50">
          {busy ? 'Adding…' : 'Add customer'}
        </button>
      </form>
    </Modal>
  )
}

/** Log an order that is already partway through the pipeline. */
export function AddOrderModal({ onClose, onCreated }) {
  const [contacts, setContacts] = useState([])
  const [q, setQ] = useState('')
  const [f, setF] = useState({
    contact_id: '', links: '', product_note: '', status: 'quoting',
    quote_kes: '', delivery_fee_kes: '', supplier_ref: '', notify: false,
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    waApi.conversations(q).then((r) => setContacts(r.data.conversations || [])).catch(() => {})
  }, [q])

  const stageIndex = useMemo(() => STAGES.findIndex((s) => s.value === f.status), [f.status])
  const needsAmount = stageIndex >= NEEDS_AMOUNT

  const submit = async (e) => {
    e.preventDefault()
    if (!f.contact_id) return toast.error('Pick a customer first')
    if (needsAmount && !(Number(f.quote_kes) > 0)) {
      return toast.error('This stage needs the agreed total — the customer has been told a number')
    }
    setBusy(true)
    try {
      const links = f.links.split(/[\s,]+/).map((l) => l.trim()).filter(Boolean)
      const res = await waApi.createOrder(f.contact_id, links, f.product_note || null, {
        status: f.status,
        quote_kes: f.quote_kes ? Number(f.quote_kes) : undefined,
        delivery_fee_kes: f.delivery_fee_kes ? Number(f.delivery_fee_kes) : undefined,
        supplier_ref: f.supplier_ref.trim() || undefined,
        notify: f.notify,
      })
      const o = res.data.order
      // Always a number to read back: order_code is minted for every order
      // (migration 0021), tracking codes only from 'paid' onward.
      const ref = o.tracking_code || o.order_code
      toast.success(ref ? `Order added — ${ref}` : 'Order added')
      onCreated?.(o)
      onClose()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add the order')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Add an order" icon={PackagePlus} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <span className={label}>Customer *</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone or TC- code" className={`${field} mb-2`} />
          <select value={f.contact_id} onChange={(e) => setF({ ...f, contact_id: e.target.value })} className={field}>
            <option value="">Select a customer…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name || c.phone}{c.customer_code ? ` · ${c.customer_code}` : ''} · {c.phone}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={label}>Product links</span>
          <textarea value={f.links} onChange={(e) => setF({ ...f, links: e.target.value })} rows={2}
            placeholder="One per line" className={field} />
        </div>
        <div>
          <span className={label}>Note</span>
          <input value={f.product_note} onChange={(e) => setF({ ...f, product_note: e.target.value })}
            placeholder="What it is, or the reference it had elsewhere" className={field} />
        </div>
        <div>
          <span className={label}>Supplier order number</span>
          <input value={f.supplier_ref} onChange={(e) => setF({ ...f, supplier_ref: e.target.value })}
            placeholder="SHEIN or other retailer's own number — optional" className={field} />
          <p className="text-xs text-mute mt-1.5">
            Theirs, not ours. This order gets its own number (ORD-…) the moment you
            add it, and that is what goes on the customer's quote.
          </p>
        </div>
        <div>
          <span className={label}>Stage</span>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className={field}>
            {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {needsAmount && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>Agreed total (KSh) *</span>
              <input value={f.quote_kes} onChange={(e) => setF({ ...f, quote_kes: e.target.value })}
                inputMode="numeric" placeholder="6486" className={field} />
            </div>
            <div>
              <span className={label}>Delivery fee (KSh)</span>
              <input value={f.delivery_fee_kes} onChange={(e) => setF({ ...f, delivery_fee_kes: e.target.value })}
                inputMode="numeric" placeholder="optional" className={field} />
            </div>
          </div>
        )}
        {stageIndex >= STAGES.findIndex((s) => s.value === 'paid') && (
          <p className="text-xs text-emerald-300/80">A tracking code is issued automatically at this stage.</p>
        )}
        {f.status !== 'quoting' && (
          <label className="flex items-start gap-2 text-xs text-mute">
            <input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })}
              className="mt-0.5" />
            <span>Message the customer about this stage. Off by default — back-filling history
              should not text somebody about a parcel they already have.</span>
          </label>
        )}
        <button disabled={busy}
          className="w-full py-2.5 rounded-xl bg-ember-600 hover:bg-ember-500 text-white font-semibold disabled:opacity-50">
          {busy ? 'Adding…' : 'Add order'}
        </button>
      </form>
    </Modal>
  )
}
