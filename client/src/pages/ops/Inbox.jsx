import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  MessageSquareText, Search, Send, Paperclip, PackagePlus,
  Phone, MapPin, Wallet, Pencil, RefreshCw, Bot, BotOff, BellOff,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { waApi } from '../../api'
import { GlassStyles, GlassCard, PageHeading, StatusBadge } from '../../components/GlassUI'
import { useWaInboxUpdates, useWaNewCustomer, useWaQuoteRequest } from '../../hooks/useRealtimeUpdates'
import { parseWhatsAppText } from '../../lib/waText'

const URL_RE = /https?:\/\/[^\s<>"')]+/g

// WhatsApp's failure codes, said plainly, with what to do about it.
// Anything unmapped falls through to the provider's own words rather than
// a shrug — an operator can act on "Message undeliverable"; they cannot
// act on "failed".
const SEND_FAILURES = {
  131026: 'Undeliverable — this number cannot receive WhatsApp from us. Check it is right and on WhatsApp.',
  131047: 'Outside the 24-hour window. Send an approved template instead of free text.',
  131049: 'Held back by WhatsApp to limit marketing messages to this person.',
  132001: 'The template does not exist, or not in this language. Check the template map in Settings.',
  470:    'Outside the 24-hour window. Send an approved template instead of free text.',
}

/**
 * WhatsApp markup as the customer sees it. The bubble printed bodies
 * raw, so an operator read "*TC-1058*" where the customer read bold.
 */
function MessageBody({ text }) {
  return parseWhatsAppText(text).map((t, i) => {
    if (t.type === 'bold') return <strong key={i}>{t.value}</strong>
    if (t.type === 'italic') return <em key={i}>{t.value}</em>
    if (t.type === 'strike') return <s key={i}>{t.value}</s>
    if (t.type === 'mono') return <code key={i} className="font-mono text-[0.9em]">{t.value}</code>
    if (t.type === 'link') {
      return (
        <a key={i} href={t.value} target="_blank" rel="noreferrer"
          className="underline break-all hover:opacity-80">{t.value}</a>
      )
    }
    return <span key={i}>{t.value}</span>
  })
}

/**
 * An attachment the customer sent. Images show themselves — the common
 * case is an M-Pesa screenshot, and making somebody click through to
 * read a payment reference is a click they should not have to make.
 */
function Attachment({ url, type }) {
  if (type === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block mb-1.5">
        <img src={url} alt="Attachment" loading="lazy"
          className="rounded-lg max-h-64 w-auto border border-white/15" />
      </a>
    )
  }
  const label = type === 'video' ? 'Video' : type === 'audio' ? 'Voice note' : 'Document'
  return (
    <a href={url} target="_blank" rel="noreferrer"
      className="block underline text-xs mb-1">
      📎 Open {label.toLowerCase()}
    </a>
  )
}

function describeSendFailure(raw) {
  if (!raw) return 'Failed — no reason recorded. Newer failures capture one.'
  const code = Number(String(raw).match(/"?(?:code|metaCode)"?\s*[:=]\s*"?(\d{3,6})/)?.[1])
  if (SEND_FAILURES[code]) return `${SEND_FAILURES[code]} (${code})`
  const message = String(raw).match(/"message"\s*:\s*"([^"]{3,180})"/)?.[1]
  return message ? `Failed — ${message}` : `Failed — ${String(raw).slice(0, 180)}`
}

export function Inbox() {
  const [conversations, setConversations] = useState([])
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState(null)       // contact row
  const [orders, setOrders] = useState([])
  const [messages, setMessages] = useState([])
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // True while the last history fetch came back full — i.e. there may be
  // more above. The API has always supported a `before` cursor; the UI
  // simply never used it, hard-capping every thread at 50 messages.
  const [mayHaveEarlier, setMayHaveEarlier] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef(null)
  const fileRef = useRef(null)
  const navigate = useNavigate()
  const [params] = useSearchParams()

  // The query the list is actually filtered by — set on submit, not per
  // keystroke. SSE refreshes used to re-query with the live input value,
  // so a half-typed search silently re-filtered the inbox the moment any
  // message arrived.
  const submittedQ = useRef('')

  const loadConversations = useCallback(async (query = '') => {
    try {
      const res = await waApi.conversations(query)
      setConversations(res.data.conversations || [])
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to load inbox')
    }
  }, [])

  const openConversation = useCallback(async (contactId) => {
    try {
      const [conv, msgs] = await Promise.all([
        waApi.conversation(contactId),
        waApi.messages(contactId),
      ])
      setSelected(conv.data.contact)
      setOrders(conv.data.orders || [])
      setMessages(msgs.data.messages || [])
      setMayHaveEarlier((msgs.data.messages || []).length >= 50)
      waApi.markRead(contactId).catch(() => {})
      setConversations((prev) =>
        prev.map((c) => (c.id === contactId ? { ...c, unread_count: 0 } : c)))
      setTimeout(() => bottomRef.current?.scrollIntoView({ block: 'end' }), 50)
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to open conversation')
    }
  }, [])

  useEffect(() => { loadConversations() }, [loadConversations])
  // Deep link: /ops/inbox?contact=<id>
  useEffect(() => {
    const contactId = params.get('contact')
    if (contactId) openConversation(contactId)
  }, [params, openConversation])

  useWaInboxUpdates((data) => {
    loadConversations(submittedQ.current)
    // Re-open (and mark read) only while somebody is actually looking.
    // A conversation left selected in a background tab used to clear its
    // own unread badge for messages no human ever read.
    if (selected && data.contact_id === selected.id
        && document.visibilityState === 'visible') {
      openConversation(selected.id)
    }
  })
  useWaNewCustomer((data) => {
    toast.success(`New customer onboarded: ${data.full_name || data.phone} (${data.customer_code})`)
    loadConversations(submittedQ.current)
  })
  // Someone wants a quote. The assistant tells them one is coming; only a
  // person can actually send it, so this toast stays up until it is
  // dismissed or the conversation is opened.
  useWaQuoteRequest((data) => {
    toast((t) => (
      <button onClick={() => { toast.dismiss(t.id); openConversation(data.contact_id) }}
        className="text-left">
        <span className="font-semibold">Quote needed</span>
        <br />
        {data.full_name || data.phone} sent a product link — tap to open
      </button>
    ), { duration: Infinity, icon: '🔗' })
    loadConversations(submittedQ.current)
  })

  const onSearch = (e) => {
    e.preventDefault()
    submittedQ.current = q.trim()
    loadConversations(submittedQ.current)
  }

  const loadEarlier = async () => {
    if (!selected || messages.length === 0) return
    setLoadingEarlier(true)
    try {
      const oldest = messages[0].created_at
      const res = await waApi.messages(selected.id, oldest)
      const earlier = res.data.messages || []
      setMessages((prev) => [...earlier, ...prev])
      setMayHaveEarlier(earlier.length >= 50)
    } catch (e) {
      toast.error(e.response?.data?.message || 'Could not load earlier messages')
    } finally {
      setLoadingEarlier(false)
    }
  }

  const sendText = async () => {
    const text = draft.trim()
    if (!text || !selected) return
    setSending(true)
    try {
      await waApi.sendMessage(selected.id, { text })
      setDraft('')
      await openConversation(selected.id)
      setSelected((c) => (c ? { ...c, human_takeover_at: new Date().toISOString() } : c))
    } catch (e) {
      toast.error(e.response?.data?.message || 'Send failed')
    } finally {
      setSending(false)
    }
  }

  const sendFile = async (file) => {
    if (!file || !selected) return
    setSending(true)
    try {
      const { data } = await waApi.uploadUrl(file.name, file.type)
      const put = await fetch(data.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!put.ok) throw new Error(`upload failed (${put.status})`)
      await waApi.sendMessage(selected.id, {
        media_path: data.path,
        media_type: file.type === 'application/pdf' ? 'document' : 'image',
        caption: draft.trim() || undefined,
      })
      setDraft('')
      await openConversation(selected.id)
      toast.success('Sent')
    } catch (e) {
      toast.error(e.response?.data?.message || e.message || 'Attachment failed')
    } finally {
      setSending(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // Create a quote-stage order, pre-filling product links found in the
  // customer's recent inbound messages.
  const createOrder = async () => {
    if (!selected) return
    const links = [...new Set(
      messages.filter((m) => m.direction === 'in')
        .flatMap((m) => (m.body || '').match(URL_RE) || [])
    )].slice(-10)
    try {
      const res = await waApi.createOrder(selected.id, links)
      toast.success('Order created — enter the USD price to quote')
      navigate(`/ops/orders/${res.data.order.id}`)
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to create order')
    }
  }

  // The assistant pauses automatically when you reply (so the customer
  // isn't answered twice) and resumes after the configured quiet period.
  // This is the manual override.
  const toggleAi = async () => {
    if (!selected) return
    const enable = Boolean(selected.human_takeover_at)
    try {
      const res = await waApi.setAi(selected.id, enable)
      setSelected((c) => ({ ...c, human_takeover_at: res.data.ai_paused ? new Date().toISOString() : null }))
      toast.success(res.data.ai_paused
        ? 'Assistant paused — you have this chat'
        : 'Assistant is answering this chat again')
      loadConversations(submittedQ.current)
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to update assistant')
    }
  }

  // Some messages need no reply — a "thank you", an emoji, a screenshot.
  // Without this the sweeper pages staff 15 minutes later anyway. A new
  // customer message re-arms the reminder automatically, so this never
  // mutes a conversation for good.
  const dismissReminder = async () => {
    if (!selected) return
    try {
      await waApi.dismissReminder(selected.id)
      toast.success('Reminder silenced — no page for this message')
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to silence the reminder')
    }
  }

  const editContact = async () => {
    if (!selected) return
    const full_name = window.prompt('Full name', selected.full_name || '')
    if (full_name === null) return
    const delivery_address = window.prompt('Delivery address', selected.delivery_address || '')
    if (delivery_address === null) return
    // No M-Pesa prompt: we stopped collecting it. Payments are identified
    // from the M-Pesa statement, and anything already on file still shows
    // in the header above.
    // The WhatsApp number is editable because a mistyped one leaves the
    // customer unreachable with no other way to fix it.
    const phone = window.prompt('WhatsApp number (include the country code if not Kenyan)', selected.phone || '')
    if (phone === null) return
    try {
      const res = await waApi.updateContact(selected.id, { full_name, delivery_address, phone })
      setSelected(res.data.contact)
      toast.success(res.data.contact.customer_code
        ? `Contact updated — ${res.data.contact.customer_code}`
        : 'Contact updated')
    } catch (e) {
      toast.error(e.response?.data?.message || 'Update failed')
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <GlassStyles />
      <PageHeading icon={MessageSquareText} title="WhatsApp Inbox"
        subtitle="Every customer conversation, live" />

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4 items-start">
        {/* ── Conversation list ── */}
        <GlassCard className="p-0 overflow-hidden">
          <form onSubmit={onSearch} className="relative p-3 border-b border-line">
            <Search size={16} className="absolute left-6 top-1/2 -translate-y-1/2 text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Name, phone or TC-code…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-white/5 border border-line text-sm text-white placeholder:text-mute focus:outline-none" />
          </form>
          <div className="max-h-[65vh] overflow-y-auto divide-y divide-line">
            {conversations.map((c) => (
              <button key={c.id} onClick={() => openConversation(c.id)}
                className={`w-full text-left px-4 py-3 hover:bg-white/5 transition-colors ${selected?.id === c.id ? 'bg-white/10' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-white text-sm truncate">
                    {c.full_name || c.phone}
                  </span>
                  {c.unread_count > 0 && (
                    <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-ember-500 text-white text-[11px] font-bold flex items-center justify-center">
                      {c.unread_count}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="text-xs text-mute truncate">{c.last_message_preview || '—'}</span>
                  <span className="shrink-0 flex items-center gap-1.5">
                    {c.human_takeover_at && <BotOff size={12} className="text-amber-400" title="You are handling this" />}
                    {c.customer_code && (
                      <span className="text-[10px] font-bold text-ember-400">{c.customer_code}</span>
                    )}
                  </span>
                </div>
              </button>
            ))}
            {conversations.length === 0 && (
              <p className="p-4 text-sm text-mute">No conversations yet — they appear the moment a customer messages the WhatsApp line.</p>
            )}
          </div>
        </GlassCard>

        {/* ── Thread ── */}
        <GlassCard className="p-0 overflow-hidden">
          {!selected ? (
            <div className="p-10 text-center text-mute text-sm">Select a conversation</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-line">
                <div className="min-w-0">
                  <p className="font-bold text-white truncate">
                    {selected.full_name || selected.phone}
                    {selected.customer_code && (
                      <span className="ml-2 text-xs font-bold text-ember-400">{selected.customer_code}</span>
                    )}
                  </p>
                  <p className="text-xs text-mute flex flex-wrap gap-x-3 mt-0.5">
                    <span className="inline-flex items-center gap-1"><Phone size={11} />{selected.phone}</span>
                    {selected.mpesa_number && <span className="inline-flex items-center gap-1"><Wallet size={11} />{selected.mpesa_number}</span>}
                    {selected.delivery_address && <span className="inline-flex items-center gap-1 truncate max-w-[260px]"><MapPin size={11} />{selected.delivery_address}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {/* State and action are separate on purpose. This used to
                      be one button labelled "You" or "AI" — the current
                      state — and tapping it flipped to the other. An
                      operator mid-conversation read "You" as the setting
                      they wanted, tapped it, and put the assistant back on
                      top of their own chat. The pill says what is true; the
                      button says what tapping will do. */}
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs font-semibold ${
                      selected.human_takeover_at
                        ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                        : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                    }`}>
                    {selected.human_takeover_at
                      ? <><BotOff size={15} /> You have this chat</>
                      : <><Bot size={15} /> Assistant is on</>}
                  </span>
                  <button onClick={toggleAi}
                    title={selected.human_takeover_at
                      ? 'Let the assistant answer this chat again'
                      : 'Stop the assistant answering so you can reply yourself'}
                    className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-line bg-white/5 text-white text-xs font-semibold hover:bg-white/10 transition-colors">
                    {selected.human_takeover_at ? 'Hand back to assistant' : 'Take over'}
                  </button>
                  <button onClick={dismissReminder}
                    title="No reply needed — silence the unanswered reminder for this message"
                    className="p-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10">
                    <BellOff size={16} />
                  </button>
                  <button onClick={editContact} title="Edit contact"
                    className="p-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10">
                    <Pencil size={16} />
                  </button>
                  <button onClick={() => openConversation(selected.id)} title="Refresh"
                    className="p-2 rounded-lg bg-white/5 border border-line text-white hover:bg-white/10">
                    <RefreshCw size={16} />
                  </button>
                  <button onClick={createOrder}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-ember-600 hover:bg-ember-500 text-white text-sm font-semibold transition-colors">
                    <PackagePlus size={16} /> New order
                  </button>
                </div>
              </div>

              {orders.length > 0 && (
                <div className="flex gap-2 px-4 py-2 border-b border-line overflow-x-auto">
                  {orders.slice(0, 6).map((o) => (
                    <button key={o.id} onClick={() => navigate(`/ops/orders/${o.id}`)}
                      className="shrink-0 inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-white/5 border border-line hover:bg-white/10">
                      <span className="text-xs font-bold text-white">{o.tracking_code || o.order_code || 'Quote'}</span>
                      <StatusBadge status={o.status} />
                    </button>
                  ))}
                </div>
              )}

              <div className="h-[48vh] overflow-y-auto px-4 py-4 space-y-2">
                {mayHaveEarlier && (
                  <div className="text-center">
                    <button onClick={loadEarlier} disabled={loadingEarlier}
                      className="px-3 py-1.5 rounded-full bg-white/5 border border-line text-xs text-mute hover:text-white disabled:opacity-50">
                      {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
                    </button>
                  </div>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
                      m.direction === 'out'
                        ? 'bg-ember-600/90 text-white rounded-br-sm'
                        : 'bg-white/10 text-white rounded-bl-sm'
                    }`}>
                      {m.media_url && <Attachment url={m.media_url} type={m.media_type} />}
                      {m.body
                        ? <MessageBody text={m.body} />
                        : !m.media_url && (
                          // Neither words nor a readable attachment. Say so,
                          // rather than leaving an empty bubble that looks
                          // like the inbox failed to load.
                          <span className="italic text-mute">
                            Attachment we couldn't read — check WhatsApp directly
                          </span>
                        )}
                      <div className={`text-[10px] mt-1 ${m.direction === 'out' ? 'text-white/70' : 'text-mute'}`}>
                        {new Date(m.created_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}
                        {m.direction === 'out' && ` · ${m.status}`}
                        {m.direction === 'out' && !m.sent_by && ' · bot'}
                      </div>
                      {m.status === 'failed' && (
                        // "failed" on its own tells an operator nothing they
                        // can act on. WhatsApp's reason usually does.
                        <div className="text-[10px] mt-1 pt-1 border-t border-white/20 text-white/90">
                          {describeSendFailure(m.error)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              <div className="flex items-end gap-2 p-3 border-t border-line">
                <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden
                  onChange={(e) => sendFile(e.target.files?.[0])} />
                <button onClick={() => fileRef.current?.click()} disabled={sending}
                  title="Attach image or PDF"
                  className="p-2.5 rounded-xl bg-white/5 border border-line text-white hover:bg-white/10 disabled:opacity-50">
                  <Paperclip size={18} />
                </button>
                <textarea
                  value={draft} rows={1}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() }
                  }}
                  placeholder="Type a reply… (Enter to send)"
                  className="flex-1 resize-none px-3.5 py-2.5 rounded-xl bg-white/5 border border-line text-sm text-white placeholder:text-mute focus:outline-none focus:border-ember-500/50" />
                <button onClick={sendText} disabled={sending || !draft.trim()}
                  className="p-2.5 rounded-xl bg-ember-600 hover:bg-ember-500 text-white disabled:opacity-50">
                  <Send size={18} />
                </button>
              </div>
            </>
          )}
        </GlassCard>
      </div>
    </div>
  )
}
