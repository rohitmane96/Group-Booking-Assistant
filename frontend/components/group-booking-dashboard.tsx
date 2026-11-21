'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowUpRight, Bot, Check, ChevronDown, CircleHelp, Clock3, Copy, FileText, Filter, Plane, Search, Send, ShieldCheck, Sparkles, X } from 'lucide-react'
import { api, ApiError, type ApprovalRequest, type AuditEntry, type ChatMessage, type RequestDetail, type RequestSummary, type ScenarioResponse, type ScoreResponse, type SendCounterOfferRequest } from '@/lib/api'

const DEADLINES = [7, 14, 21]
const REC_COLORS: Record<string, string> = { Accept: '#00b26e', Counteroffer: '#d9892b', Partial: '#ff0041', Reject: '#ff0041' }
const REC_LABELS: Record<string, string> = { Accept: 'Accept request', Counteroffer: 'Counteroffer', Partial: 'Partial allocation', Reject: 'Reject request' }

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong')
const aed = (n: number | null | undefined) => (n == null ? '—' : `AED ${Math.round(n).toLocaleString()}`)
const pct = (p: number | null | undefined) => (p == null ? '—' : `${(p * 100).toFixed(1)}%`)
const initials = (s: string) => s.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '··'
const route = (ond: string) => ond.replace('/', ' → ')
const parseDt = (s: string | null) => (s ? new Date(s.replace(' ', 'T')) : null)
const fmtDate = (s: string | null) => { const d = parseDt(s); return d && !isNaN(+d) ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—' }
const fmtTime = (s: string | null) => { const d = parseDt(s); return d && !isNaN(+d) ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—' }
const daysLeft = (s: string | null) => { const d = parseDt(s); return d && !isNaN(+d) ? Math.max(0, Math.ceil((+d - Date.now()) / 864e5)) : null }
const featureLabel = (f: string) => f.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const fmtTs = (t: string) => { const d = new Date(t); return isNaN(+d) ? t : d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) }

export function GroupBookingDashboard() {
  const [requests, setRequests] = useState<RequestSummary[]>([])
  const [total, setTotal] = useState(0)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RequestDetail | null>(null)
  const [score, setScore] = useState<ScoreResponse | null>(null)
  const [scoring, setScoring] = useState(false)
  const [scoreError, setScoreError] = useState('')
  const [retryTick, setRetryTick] = useState(0)
  const [scenario, setScenario] = useState<ScenarioResponse | null>(null)
  const [fare, setFare] = useState(0)
  const [seats, setSeats] = useState(0)
  const [deadline, setDeadline] = useState(7)
  const [heatDeadline, setHeatDeadline] = useState(7)
  const [query, setQuery] = useState('')
  const [decision, setDecision] = useState<'approve' | 'edit' | 'reject' | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [today, setToday] = useState('')
  const [chat, setChat] = useState('')
  const [answer, setAnswer] = useState('')
  const [chatHistory, setChatHistory] = useState<ChatMessage[] | null>(null)
  const [chatBusy, setChatBusy] = useState(false)
  const [counterofferDraft, setCounterofferDraft] = useState('')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const noticeTimer = useRef<number | undefined>(undefined)

  function flash(msg: string) {
    setNotice(msg)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3500)
  }

  // initial load: queue (polled every 60s) + audit log
  useEffect(() => {
    setToday(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase())
    let alive = true
    const load = () => api.listRequests().then((r) => {
      if (!alive) return
      setRequests(r.requests); setTotal(r.total); setListState('ready'); setListError('')
      setSelectedId((cur) => cur ?? r.requests[0]?.request_id ?? null)
    }).catch((e) => { if (alive) { setListState('error'); setListError(errMsg(e)) } })
    load()
    api.audit().then((r) => alive && setAudit([...r.entries].reverse())).catch(() => {})
    const poll = window.setInterval(load, 60_000)
    return () => { alive = false; window.clearInterval(poll) }
  }, [])

  // selecting a request: detail + score
  useEffect(() => {
    if (!selectedId) return
    let alive = true
    setDetail(null); setScore(null); setScenario(null); setScoreError(''); setScoring(true)
    setDecision(null); setAnswer(''); setCounterofferDraft(''); setChatHistory(null)
    setRecipientEmail(''); setEmailSent(false)
    api.getRequest(selectedId).then((d) => alive && setDetail(d)).catch(() => {})
    api.score(selectedId).then((s) => {
      if (!alive) return
      setScore(s); setFare(Math.round(s.best_fare)); setSeats(s.best_seats)
      const dl = DEADLINES.includes(s.best_deadline_days) ? s.best_deadline_days : 7
      setDeadline(dl); setHeatDeadline(dl)
    }).catch((e) => alive && setScoreError(errMsg(e))).finally(() => alive && setScoring(false))
    return () => { alive = false }
  }, [selectedId, retryTick])

  // what-if scenario (debounced)
  useEffect(() => {
    if (!selectedId || !score || !fare || !seats) return
    let alive = true
    const t = window.setTimeout(() => {
      api.scenario(selectedId, { fare, seats, deadline_days: deadline })
        .then((s) => alive && setScenario(s))
        .catch((e) => alive && flash(errMsg(e)))
    }, 300)
    return () => { alive = false; window.clearTimeout(t) }
  }, [selectedId, score, fare, seats, deadline])

  const selected = requests.find((r) => r.request_id === selectedId) ?? null
  const pax = detail?.group_size ?? selected?.group_size ?? 0
  const probability = scenario?.p_convert ?? score?.p_convert_at_best ?? null
  const contribution = scenario?.expected_contribution ?? score?.expected_contribution ?? null
  const refFare = score?.ref_fare ?? detail?.ref_fare ?? selected?.ref_fare ?? 0
  const filtered = useMemo(() => requests.filter((r) => `${r.ond} ${r.request_id} ${r.group_request_id} ${r.flight_number}`.toLowerCase().includes(query.toLowerCase())), [requests, query])

  const curve = score?.fare_curve ?? []
  const fareMin = curve.length ? curve[0].fare : Math.round(refFare * 0.7)
  const fareMax = curve.length ? curve[curve.length - 1].fare : Math.round(refFare * 1.2)
  const yMax = Math.max(0.01, ...curve.map((p) => p.p_convert)) * 1.15
  const xPct = (f: number) => Math.max(0, Math.min(100, ((f - fareMin) / Math.max(1, fareMax - fareMin)) * 100))
  const curvePts = curve.map((p) => [xPct(p.fare) * 5, 160 - (p.p_convert / yMax) * 150] as const)
  const linePath = curvePts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const yTicks = [0.75, 0.5, 0.25].map((f) => `${(yMax * f * 100).toFixed(1)}%`)

  const drivers = (score?.drivers ?? []).slice(0, 5)
  const maxShap = Math.max(0.0001, ...drivers.map((d) => Math.abs(d.shap_value)))

  const heat = (score?.heat_map ?? []).filter((c) => c.deadline === heatDeadline)
  const heatFares = [...new Set(heat.map((c) => c.fare))].sort((a, b) => a - b)
  const heatSeats = [...new Set(heat.map((c) => c.seats))].sort((a, b) => b - a)
  const heatMin = Math.min(0, ...heat.map((c) => c.expected_contribution))
  const heatMax = Math.max(1, ...heat.map((c) => c.expected_contribution))
  const heatColor = (v: number) => v >= 0 ? `rgba(31,157,99,${0.12 + 0.75 * (v / heatMax)})` : `rgba(208,68,62,${0.15 + 0.7 * (v / (heatMin || -1))})`

  const left = selected ? daysLeft(selected.departure_dt) : null
  const offerChanged = !!score && (fare !== Math.round(score.best_fare) || seats !== score.best_seats)

  async function decide(action: 'approve' | 'reject') {
    if (!selectedId || busy) return
    const act = action === 'approve' && offerChanged ? 'edit' : action
    setBusy(true)
    try {
      const body: ApprovalRequest = act === 'reject' ? { action: act } : { action: act, fare, seats }
      const res = await api.approve(selectedId, body)
      setDecision(act)
      setAudit((a) => [res.entry, ...a])
      flash(act === 'reject' ? `Request rejected · ${selectedId}` : `Decision recorded · ${selectedId}`)
    } catch (e) { flash(errMsg(e)) } finally { setBusy(false) }
  }

  async function draftCounteroffer() {
    if (!selectedId) return
    try {
      setAnswer('Drafting counteroffer…')
      const r = await api.counteroffer(selectedId, { fare, seats, deadline_days: deadline })
      setCounterofferDraft(r.counteroffer_email)
      setAnswer(`Counteroffer drafted for ${selectedId}: ${r.seats} seats at ${aed(r.fare)} per passenger, ${r.deadline_days}-day deadline. It remains a draft for human review; nothing has been sent.`)
    } catch (e) { setAnswer(''); flash(errMsg(e)) }
  }

  async function copyCounteroffer() {
    try { await navigator.clipboard.writeText(counterofferDraft); flash('Counteroffer copied to clipboard') }
    catch { flash('Clipboard unavailable — select and copy the draft text') }
  }

  async function sendEmail() {
    if (!selectedId || !recipientEmail || !counterofferDraft || emailSending) return
    setEmailSending(true)
    try {
      const subject = `Group booking counteroffer — ${selected?.ond ?? selectedId}`
      await api.sendCounteroffer(selectedId, { to_email: recipientEmail, subject, body: counterofferDraft })
      setEmailSent(true)
      flash(`Counteroffer sent to ${recipientEmail}`)
    } catch (e) { flash(errMsg(e)) } finally { setEmailSending(false) }
  }

  async function ask(message: string) {
    if (!message.trim() || !selectedId || chatBusy) return
    setChatBusy(true); setAnswer('Thinking…')
    try {
      const r = await api.chat(`[Request ID: ${selectedId}] ${message}`, chatHistory)
      setAnswer(r.response); setChatHistory(r.history)
    } catch (e) { setAnswer(''); flash(errMsg(e)) } finally { setChatBusy(false) }
  }

  const recColor = score ? REC_COLORS[score.recommendation] : undefined

  return <main className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#dashboard" aria-label="Aeroform home"><span className="brand-mark"><Plane size={18} strokeWidth={2.2}/></span><span>Aeroform<span className="brand-sub">REVENUE INTELLIGENCE</span></span></a>
      <div className="workspace-label">WORKSPACE <ChevronDown size={13}/></div>
      <nav aria-label="Main navigation">
        <a className="nav-item active" href="#dashboard"><Activity size={17}/> Overview</a>
        <a className="nav-item" href="#requests"><FileText size={17}/> Group requests <span className="nav-count">{total}</span></a>
        <a className="nav-item" href="#inventory"><Plane size={17}/> Flight inventory</a>
        <a className="nav-item" href="#audit"><ShieldCheck size={17}/> Decision log</a>
      </nav>
      <div className="sidebar-bottom"><div className="status-card"><span className="live-dot"/> {listState === 'error' ? 'API unreachable' : 'Systems operational'} <span className="status-time">{listState === 'error' ? listError : 'Connected to API'}</span></div><div className="profile"><div className="avatar dark">JS</div><div><b>Jordan Smith</b><span>Revenue manager</span></div><ChevronDown size={15}/></div></div>
    </aside>

    <section className="main-content" id="dashboard">
      <header className="topbar"><div className="breadcrumb">Revenue management <span>/</span> <b>Overview</b></div><div className="top-actions"><span className="date-pill"><span className="live-dot"/> Live inventory</span><button className="icon-button" aria-label="Help"><CircleHelp size={18}/></button><div className="avatar">JS</div></div></header>
      <div className="page-content">
        {listState === 'error' && <div className="empty-state" role="alert">Cannot connect to server — {listError}. Check that the API is running and NEXT_PUBLIC_API_BASE_URL is correct.</div>}
        <div className="heading-row"><div><div className="eyebrow">{today}</div><h1>Good morning, Jordan <span className="wave">✳</span></h1><p className="subheading">Here’s your group booking performance at a glance.</p></div></div>
        <div className="metrics-grid">
          <Metric label="Open requests" value={listState === 'loading' ? '…' : String(total)} change="Quoted or submitted" icon={<FileText size={17}/>} tone="teal"/>
          <Metric label="Selected P(convert)" value={scoring ? '…' : pct(probability)} change={selectedId ? `at ${aed(fare)} · ${seats} seats` : 'Select a request'} icon={<Activity size={17}/>} tone="blue"/>
          <Metric label="Expected contribution" value={scoring ? '…' : aed(contribution)} change={score ? `${score.lift_vs_baseline >= 0 ? '+' : '−'}${aed(Math.abs(score.lift_vs_baseline))} vs. baseline` : '—'} icon={<ArrowUpRight size={17}/>} tone="amber" positive={!!score && score.lift_vs_baseline >= 0}/>
          <Metric label="Remaining demand" value={scoring ? '…' : score ? `${Math.round(score.remaining_demand)} pax` : '—'} change="Est. individual demand" icon={<Plane size={17}/>} tone="rose"/>
        </div>
        <div className="content-grid">
          <section className="panel queue-panel" id="requests"><div className="panel-head"><div><div className="panel-title">Requests to review <span className="count-badge">{total}</span></div><div className="panel-caption">Open group requests</div></div><button className="subtle-button"><Filter size={14}/> Filter</button></div>
            <label className="search-box"><Search size={15}/><input aria-label="Search requests" placeholder="Search requests…" value={query} onChange={(e) => setQuery(e.target.value)}/><kbd>⌘ K</kbd></label>
            <div className="request-list">{filtered.map((r) => <button key={r.request_id} className={`request-row ${selectedId === r.request_id ? 'selected' : ''}`} onClick={() => setSelectedId(r.request_id)}><span className="request-avatar">{initials(r.ond)}</span><span className="request-main"><span className="request-route">{route(r.ond)}<span className="request-id">{r.request_id}</span></span><span className="request-meta">{r.flight_number} · {r.group_size} passengers</span></span><span className="request-side"><span className={`status ${r.status.toLowerCase()}`}>{r.status}</span><span className="request-date"><Clock3 size={12}/>{daysLeft(r.departure_dt) ?? '—'}d left</span></span></button>)}{listState === 'loading' && <div className="empty-state">Loading requests…</div>}{listState === 'ready' && filtered.length === 0 && <div className="empty-state">No matching requests</div>}</div>
          </section>
          <section className="panel recommendation-panel"><div className="panel-head"><div><div className="panel-title">AI recommendation <span className="ai-tag"><Sparkles size={11}/> ASSIST</span></div><div className="panel-caption">{selected ? `${selected.request_id} · ${route(selected.ond)} · ${fmtDate(selected.departure_dt)}` : 'No request selected'}</div></div><button className="more-button" aria-label="More options">···</button></div>
            {scoring && <div className="empty-state">Scoring request — this can take a few seconds…</div>}
            {scoreError && <div className="empty-state" role="alert">{scoreError} <button className="subtle-button" onClick={() => setRetryTick((n) => n + 1)}>Retry</button></div>}
            {score && <>
            <div className="recommendation-banner"><div className="recommend-icon" style={{ background: recColor }}><Sparkles size={17}/></div><div><div className="recommend-label">RECOMMENDED ACTION</div><strong style={{ color: recColor }}>{REC_LABELS[score.recommendation] ?? score.recommendation}</strong></div><span className="confidence">{pct(score.p_convert_base)} base P(convert)</span></div>
            <div className="offer-grid"><Offer label="Proposed fare" value={aed(fare)} suffix="/ passenger"/><Offer label="Seat allocation" value={`${seats}`} suffix={`of ${pax} seats`}/><Offer label="Confirmation deadline" value={`${deadline} days`} suffix="after quote"/><Offer label="Conversion probability" value={pct(probability)} suffix="model estimate" highlight/></div>
            <label className="deadline-control">Confirmation deadline<select value={deadline} onChange={(e) => setDeadline(Number(e.target.value))}>{DEADLINES.map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
            <div className="contribution-line"><span>Expected incremental contribution <CircleHelp size={13}/></span><b className={(contribution ?? 0) > 0 ? 'positive-value' : ''}>{aed(contribution)}</b></div>
            <p className="recommend-copy">Optimizer pick: {score.best_seats} seats at {aed(score.best_fare)} within {score.best_deadline_days} days, worth {aed(score.expected_contribution)} vs. {aed(score.baseline_contribution)} for the rule-based baseline. Displacement cost: {aed(score.displacement_cost)}.</p>
            <div className="button-row"><button disabled={busy} className={`primary-button ${decision && decision !== 'reject' ? 'is-approved' : ''}`} onClick={() => decide('approve')}>{decision && decision !== 'reject' ? <><Check size={15}/> Recorded</> : <><Check size={15}/> {offerChanged ? 'Approve edited offer' : 'Approve recommendation'}</>}</button><button disabled={busy} className="outline-button" onClick={() => decide('reject')}><X size={15}/> {decision === 'reject' ? 'Rejected' : 'Reject'}</button></div>
            </>}
          </section>
        </div>
        <div className="analysis-grid">
          <section className="panel analysis-panel"><div className="panel-head"><div><div className="panel-title">Scenario analysis</div><div className="panel-caption">Adjust the offer to explore the trade-off</div></div><span className="model-tag"><span className="live-dot"/> MODEL-BASED</span></div>
            {score ? <>
            <div className="scenario-controls"><label>Fare per passenger <strong>{aed(fare)}</strong><input aria-label="Fare per passenger" type="range" min={Math.round(fareMin)} max={Math.round(fareMax)} step="5" value={fare} onChange={(e) => setFare(Number(e.target.value))}/><span className="range-labels"><span>70% · {aed(fareMin)}</span><span>120% · {aed(fareMax)}</span></span></label><label>Seats to allocate <strong>{seats} seats</strong><input aria-label="Seats to allocate" type="range" min="1" max={Math.max(1, pax, score.best_seats)} step="1" value={seats} onChange={(e) => setSeats(Number(e.target.value))}/><span className="range-labels"><span>1 seat</span><span>{Math.max(pax, score.best_seats)} max</span></span></label></div>
            {scenario && <div className="assumption-note">Group revenue {aed(scenario.group_revenue)} · displacement {aed(scenario.displacement_cost)} · holding {aed(scenario.holding_cost)}</div>}
            <div className="chart-wrap"><div className="chart-top"><span>Fare response curve</span><span className="chart-legend"><i/> Conversion probability</span></div><div className="curve-chart"><div className="y-labels">{yTicks.map((t) => <span key={t}>{t}</span>)}</div><div className="chart-plot"><div className="grid-line one"/><div className="grid-line two"/><div className="grid-line three"/><svg viewBox="0 0 500 160" preserveAspectRatio="none" role="img" aria-label="Conversion probability versus fare"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#ff0041" stopOpacity=".16"/><stop offset="100%" stopColor="#ff0041" stopOpacity="0"/></linearGradient></defs>{linePath && <><path d={`${linePath} L500,160 L0,160Z`} fill="url(#fill)"/><path d={linePath} fill="none" stroke="#ff0041" strokeWidth="3" vectorEffect="non-scaling-stroke"/></>}<line x1={`${xPct(refFare)}%`} y1="0" x2={`${xPct(refFare)}%`} y2="100%" stroke="#6b777c" strokeDasharray="2 4"/><line x1={`${xPct(score.best_fare)}%`} y1="0" x2={`${xPct(score.best_fare)}%`} y2="100%" stroke="#00b26e"/><line x1={`${xPct(fare)}%`} y1="0" x2={`${xPct(fare)}%`} y2="100%" stroke="#e39c4e" strokeDasharray="4 4"/></svg><div className="x-labels"><span>{Math.round(fareMin)}</span><span>ref {Math.round(refFare)}</span><span>{Math.round(fareMax)} AED</span></div></div></div></div>
            </> : <div className="empty-state">{scoring ? 'Waiting for score…' : 'Select a request'}</div>}
          </section>
          <section className="panel drivers-panel"><div className="panel-head"><div><div className="panel-title">What drives this decision?</div><div className="panel-caption">Top SHAP factors for P(convert)</div></div><button className="more-button" aria-label="More options">···</button></div>
            {drivers.map((d) => <Driver key={d.feature} label={featureLabel(d.feature)} detail={`value ${Number(d.value.toFixed(3))}`} value={`${d.shap_value >= 0 ? '+' : ''}${d.shap_value.toFixed(2)}`} positive={d.shap_value >= 0} negative={d.shap_value < 0} width={`${Math.max(4, (Math.abs(d.shap_value) / maxShap) * 100)}%`}/>)}
            {!drivers.length && <div className="empty-state">{scoring ? 'Waiting for score…' : 'No drivers yet'}</div>}
            <div className="confidence-note"><ShieldCheck size={15}/><span><b>Positive = raises P(convert)</b><br/>Negative = lowers P(convert)</span></div>
          </section>
        </div>
        <div className="bottom-grid">
          <section className="panel inventory-panel" id="inventory"><div className="panel-head"><div><div className="panel-title">Flight inventory</div><div className="panel-caption">{selected ? `${route(selected.ond)} · ${fmtDate(selected.departure_dt)} · ${selected.flight_number}` : '—'}</div></div></div><div className="inventory-stats"><div><span>Seats available</span><b>{detail?.seats_available ?? '—'}</b></div><div><span>Load factor</span><b>{detail?.load_factor != null ? `${Math.round(detail.load_factor * 100)}%` : '—'}</b></div><div><span>Departure</span><b>{fmtTime(selected?.departure_dt ?? null)} <small>{left != null ? `· ${left}d` : ''}</small></b></div><div><span>Reference fare</span><b>{aed(refFare)}</b></div></div>
            {detail?.load_factor != null && <div className="capacity-bar"><span style={{ width: `${Math.round(detail.load_factor * 100)}%` }}/></div>}
            <div className="classes"><span>Agent</span><b>{detail?.agent_code ?? '—'}</b><b>conv. <i>{detail ? pct(detail.agent_conv_rate) : '—'}</i></b><b>route conv. <i>{detail ? pct(detail.route_conv_rate) : '—'}</i></b></div></section>
          <section className="panel trend-panel"><div className="panel-head"><div><div className="panel-title">Fare × seats heat map</div><div className="panel-caption">Expected contribution · deadline {heatDeadline} days</div></div><select aria-label="Heat map deadline" className="subtle-button" value={heatDeadline} onChange={(e) => setHeatDeadline(Number(e.target.value))}>{DEADLINES.map((d) => <option key={d} value={d}>{d} days</option>)}</select></div>
            {heat.length ? <div role="img" aria-label="Expected contribution by fare and seats" style={{ display: 'grid', gridTemplateColumns: `auto repeat(${heatFares.length}, 1fr)`, gap: 2, fontSize: 10 }}>
              {heatSeats.map((s) => <HeatRow key={s} seats={s} fares={heatFares} heat={heat} color={heatColor}/>)}
              <span/>{heatFares.map((f) => <span key={f} style={{ textAlign: 'center' }}>{f}</span>)}
            </div> : <div className="empty-state">{scoring ? 'Waiting for score…' : 'No data'}</div>}</section>
        </div>
        <section className="panel audit-panel" id="audit"><div className="panel-head"><div><div className="panel-title">Decision log</div><div className="panel-caption">Human approvals and rejections recorded by the API</div></div><ShieldCheck size={16} color="#ff0041"/></div>{audit.length ? <div className="audit-list">{audit.slice(0, 20).map((e, i) => <div className="audit-entry" key={`${e.timestamp}-${i}`}><span className="audit-dot"/><span>{fmtTs(e.timestamp)} · {e.action} · {e.request_id}{e.fare != null ? ` · ${e.seats ?? '?'} seats at ${aed(e.fare)}` : ''}{e.note ? ` · ${e.note}` : ''}</span></div>)}</div> : <div className="audit-empty">No decisions recorded yet. Approve or reject a recommendation to create an audit entry.</div>}</section>
        <footer className="footer"><span>AI recommendations support decisions — all offers require human approval.</span></footer>
      </div>
    </section>
    <aside className="agent-panel"><div className="agent-head"><div className="agent-icon"><Bot size={18}/></div><div><b>Booking assistant</b><span><i className="live-dot"/> Ready to help</span></div><button className="more-button" aria-label="More assistant options">···</button></div><div className="agent-body"><div className="agent-intro"><div className="agent-spark"><Sparkles size={15}/></div><b>Your decision copilot</b><p>Ask me to explain a recommendation or explore a what-if scenario.</p></div><div className="chat-context"><span>ACTIVE REQUEST</span><b>{selected ? `${selected.request_id} · ${route(selected.ond)}` : '—'}</b><span>{pax} passengers · {fmtDate(selected?.departure_dt ?? null)}</span></div><div className="suggestions-label">TRY ASKING</div><button className="suggestion" disabled={chatBusy} onClick={() => ask('Why this recommendation?')}>Why this recommendation?</button><button className="suggestion" disabled={chatBusy} onClick={() => ask('What if we raise the fare by 5%?')}>What if we raise the fare?</button><button className="suggestion" onClick={draftCounteroffer}>Draft a counteroffer</button>{answer && <div className="agent-answer"><div><Sparkles size={13}/> ASSISTANT</div>{answer}</div>}{counterofferDraft && <section className="counteroffer-card" aria-label="Counteroffer draft"><div className="counteroffer-card-head"><div><b>Counteroffer email</b><span>{emailSent ? 'SENT' : 'DRAFT · NOT SENT'}</span></div><FileText size={15}/></div><label className="sr-only" htmlFor="counteroffer-draft">Editable counteroffer message</label><textarea id="counteroffer-draft" value={counterofferDraft} onChange={(event) => { setCounterofferDraft(event.target.value); setEmailSent(false) }}/><div className="counteroffer-actions"><button type="button" className="copy-draft-button" onClick={copyCounteroffer}><Copy size={13}/> Copy</button><div className="send-email-row"><input className="email-input" type="email" placeholder="Recipient email…" value={recipientEmail} onChange={(e) => { setRecipientEmail(e.target.value); setEmailSent(false) }} aria-label="Recipient email address"/><button type="button" className={`send-email-button ${emailSent ? 'is-sent' : ''}`} onClick={sendEmail} disabled={emailSending || !recipientEmail || emailSent}>{emailSent ? <><Check size={13}/> Sent</> : emailSending ? 'Sending…' : <><Send size={13}/> Send</>}</button></div></div><p className="counteroffer-note">Review and edit the draft before sending. All sends are logged to the audit trail.</p></section>}</div><form className="chat-compose" onSubmit={(e) => { e.preventDefault(); const m = chat; setChat(''); ask(m) }}><input aria-label="Ask the booking assistant" value={chat} onChange={(e) => setChat(e.target.value)} placeholder="Ask about this request…"/><button aria-label="Send message" type="submit" disabled={chatBusy}><Send size={15}/></button></form><div className="agent-disclaimer">AI responses are based on model scenarios, not live PSS updates.</div></aside>
    {notice && <div className="toast" role="status"><Check size={15}/>{notice}</div>}
  </main>
}

function HeatRow({ seats, fares, heat, color }: { seats: number; fares: number[]; heat: { fare: number; seats: number; expected_contribution: number }[]; color: (v: number) => string }) {
  return <>
    <span style={{ paddingRight: 4, alignSelf: 'center' }}>{seats}</span>
    {fares.map((f) => { const c = heat.find((h) => h.fare === f && h.seats === seats); return <span key={f} title={c ? `${f} AED × ${seats} seats → AED ${Math.round(c.expected_contribution).toLocaleString()}` : ''} style={{ height: 22, borderRadius: 3, background: c ? color(c.expected_contribution) : 'transparent' }}/> })}
  </>
}
function Metric({label,value,change,icon,tone,positive}:{label:string;value:string;change:string;icon:React.ReactNode;tone:string;positive?:boolean}) { return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><span className="metric-label">{label}</span><strong>{value}</strong><span className={`metric-change ${positive?'up':''}`}>{positive && <ArrowUpRight size={13}/>} {change}</span></div> }
function Offer({label,value,suffix,highlight}:{label:string;value:string;suffix:string;highlight?:boolean}) {return <div className={`offer ${highlight?'highlight':''}`}><span>{label}</span><b>{value}</b><small>{suffix}</small></div>}
function Driver({label,detail,value,positive,negative,width}:{label:string;detail:string;value:string;positive?:boolean;negative?:boolean;width:string}) {return <div className="driver"><div className="driver-head"><span><b>{label}</b><small>{detail}</small></span><em className={positive?'driver-positive':negative?'driver-negative':''}>{value}</em></div><div className="driver-track"><i className={positive?'driver-fill-positive':negative?'driver-fill-negative':''} style={{width}}/></div></div>}
