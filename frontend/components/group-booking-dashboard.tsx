'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowUpRight, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Copy, FileText, History, LayoutDashboard, List, ListFilter, Wallet, TrendingUp, TrendingDown, Armchair, ClipboardList, RefreshCw, AlertCircle, Plane, Search, Send, ShieldCheck, Sparkles, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, ApiError, type ApprovalRequest, type AuditEntry, type ChatMessage, type RequestAllSummary, type RequestDetail, type ExecutiveSummary, type StrategyComparison, type Opportunity, type OpportunityCategory, type OpportunityData, type RequestSummary, type ScenarioResponse, type ScoreResponse, type SendCounterOfferRequest } from '@/lib/api'

type Page = 'overview' | 'requests' | 'all-requests' | 'audit'
const PAGE_LABELS: Record<Page, string> = { overview: 'Overview', requests: 'Open Requests', 'all-requests': 'All Requests', audit: 'Decision Log' }

const DEADLINES = [7, 14, 21]
const PAGE_SIZES = [5, 8, 10, 20]
const pageList = (cur: number, total: number): (number | '…')[] => {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const set = new Set([1, total, cur - 1, cur, cur + 1].filter((n) => n >= 1 && n <= total))
  const sorted = [...set].sort((a, b) => a - b)
  return sorted.flatMap((n, i) => (i && n - sorted[i - 1] > 1 ? ['…' as const, n] : [n]))
}
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
  const [statusFilter, setStatusFilter] = useState('')
  const [routeFilter, setRouteFilter] = useState('')
  const [flightFilter, setFlightFilter] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(8)
  const [queueCollapsed, setQueueCollapsed] = useState(false)
  const [scoreMap, setScoreMap] = useState<Record<string, number>>({})
  const [greeting, setGreeting] = useState('Welcome')
  const searchRef = useRef<HTMLInputElement>(null)
  const [decision, setDecision] = useState<'approve' | 'edit' | 'reject' | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [summary, setSummary] = useState<ExecutiveSummary | null>(null)
  const [summaryState, setSummaryState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [summaryError, setSummaryError] = useState('')
  const [summaryTick, setSummaryTick] = useState(0)
  const [comparison, setComparison] = useState<StrategyComparison | null>(null)
  const [comparisonState, setComparisonState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [comparisonError, setComparisonError] = useState('')
  const [oppData, setOppData] = useState<OpportunityData | null>(null)
  const [oppState, setOppState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [oppError, setOppError] = useState('')
  const [today, setToday] = useState('')
  const [chat, setChat] = useState('')
  const [thread, setThread] = useState<{ role: 'user' | 'assistant'; text: string }[]>([])
  const [typing, setTyping] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [chatHistory, setChatHistory] = useState<ChatMessage[] | null>(null)
  const [chatBusy, setChatBusy] = useState(false)
  const [counterofferDraft, setCounterofferDraft] = useState('')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const noticeTimer = useRef<number | undefined>(undefined)
  const draftRef = useRef<HTMLElement | null>(null)
  const [activePage, setActivePage] = useState<Page>('overview')
  const [panelOpen, setPanelOpen] = useState(true)
  const [allRequests, setAllRequests] = useState<RequestAllSummary[]>([])
  const [allStatus, setAllStatus] = useState('')
  const [allPage, setAllPage] = useState(1)
  const [allPageSize, setAllPageSize] = useState(10)
  const [allReqState, setAllReqState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  function flash(msg: string) {
    setNotice(msg)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3500)
  }

  // initial load: queue (polled every 60s) + audit log
  useEffect(() => {
    const hr = new Date().getHours(); setGreeting(hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening')
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

  // executive summary: refresh when the open queue changes, after a decision, or on retry
  useEffect(() => {
    if (listState !== 'ready') return
    let alive = true
    setSummaryState((st) => (summary ? st : 'loading'))
    api.executiveSummary(summaryTick > 0).then((d) => { if (alive) { setSummary(d); setSummaryState('ready'); setSummaryError('') } })
      .catch((e) => { if (alive) { setSummaryState('error'); setSummaryError(errMsg(e)) } })
    setComparisonState((st) => (comparison ? st : 'loading'))
    api.strategyComparison(summaryTick > 0).then((d) => { if (alive) { setComparison(d); setComparisonState('ready'); setComparisonError('') } })
      .catch((e) => { if (alive) { setComparisonState('error'); setComparisonError(errMsg(e)) } })
    setOppState((st) => (oppData ? st : 'loading'))
    api.opportunities(summaryTick > 0).then((d) => { if (alive) { setOppData(d); setOppState('ready'); setOppError('') } })
      .catch((e) => { if (alive) { setOppState('error'); setOppError(errMsg(e)) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listState, requests, audit.length, summaryTick])

  // selecting a request: detail + score
  useEffect(() => {
    if (!selectedId) return
    let alive = true
    setDetail(null); setScore(null); setScenario(null); setScoreError(''); setScoring(true)
    setDecision(null); setThread([]); setTyping(false); setCounterofferDraft(''); setChatHistory(null)
    setEmailSent(false)
    api.getRequest(selectedId).then((d) => alive && setDetail(d)).catch(() => {})
    api.score(selectedId).then((s) => {
      if (!alive) return
      setScore(s); setFare(Math.round(s.best_fare)); setSeats(s.best_seats)
      const dl = DEADLINES.includes(s.best_deadline_days) ? s.best_deadline_days : 7
      setDeadline(dl); setHeatDeadline(dl)
      setScoreMap((m) => ({ ...m, [selectedId]: s.p_convert_at_best }))
    }).catch((e) => alive && setScoreError(errMsg(e))).finally(() => alive && setScoring(false))
    return () => { alive = false }
  }, [selectedId, retryTick])

  // pre-fill recipient email from agent_email when detail loads
  useEffect(() => {
    if (detail?.agent_email) setRecipientEmail(detail.agent_email)
  }, [detail])

  // scroll counteroffer card into view when it appears
  useEffect(() => {
    if (counterofferDraft && draftRef.current) {
      draftRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [counterofferDraft])

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

  // load all requests when navigating to that page
  useEffect(() => {
    if (activePage !== 'all-requests' || allReqState !== 'idle') return
    setAllReqState('loading')
    api.listAllRequests().then((r) => { setAllRequests(r.requests); setAllReqState('ready') }).catch(() => setAllReqState('error'))
  }, [activePage, allReqState])

  // reset to first page whenever the result set changes
  useEffect(() => { setPage(1) }, [query, statusFilter, routeFilter, flightFilter, pageSize])
  useEffect(() => { setAllPage(1) }, [allStatus, allPageSize])
  // ⌘K / Ctrl+K focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selected = requests.find((r) => r.request_id === selectedId) ?? null
  const pax = detail?.group_size ?? selected?.group_size ?? 0
  const probability = scenario?.p_convert ?? score?.p_convert_at_best ?? null
  const contribution = scenario?.expected_contribution ?? score?.expected_contribution ?? null
  const refFare = score?.ref_fare ?? detail?.ref_fare ?? selected?.ref_fare ?? 0
  const allStatusCounts = useMemo(() => allRequests.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {}), [allRequests])
  const allStatuses = useMemo(() => Object.keys(allStatusCounts).sort(), [allStatusCounts])
  const allFiltered = useMemo(() => allRequests.filter((r) => !allStatus || r.status === allStatus), [allRequests, allStatus])
  const allTotalPages = Math.max(1, Math.ceil(allFiltered.length / allPageSize))
  const allSafePage = Math.min(allPage, allTotalPages)
  const allRows = allFiltered.slice((allSafePage - 1) * allPageSize, allSafePage * allPageSize)
  const statuses = useMemo(() => [...new Set(requests.map((r) => r.status))].sort(), [requests])
  const routes = useMemo(() => [...new Set(requests.map((r) => r.ond))].sort(), [requests])
  const flights = useMemo(() => [...new Set(requests.map((r) => r.flight_number).filter(Boolean))].sort(), [requests])
  const filtered = useMemo(() => requests.filter((r) =>
    (!statusFilter || r.status === statusFilter) &&
    (!routeFilter || r.ond === routeFilter) &&
    (!flightFilter || r.flight_number === flightFilter) &&
    `${r.ond} ${r.request_id} ${r.group_request_id} ${r.flight_number}`.toLowerCase().includes(query.toLowerCase())
  ), [requests, query, statusFilter, routeFilter, flightFilter])
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const hasFilters = !!(statusFilter || routeFilter || flightFilter || query)
  const clearFilters = () => { setStatusFilter(''); setRouteFilter(''); setFlightFilter(''); setQuery('') }
  const pConvertClass = (p: number | undefined) => { if (p == null) return ''; if (p >= 0.35) return 'prob-high'; if (p >= 0.12) return 'prob-mid'; return 'prob-low' }
  const statusCounts = useMemo(() => requests.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {}), [requests])

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
      setThread((t) => [...t, { role: 'user', text: 'Draft a counteroffer' }]); setTyping(true)
      const r = await api.counteroffer(selectedId, { fare, seats, deadline_days: deadline })
      setCounterofferDraft(r.counteroffer_email)
      setThread((t) => [...t, { role: 'assistant', text: `**Counteroffer drafted** for ${selectedId}.\n\n- ${r.seats} seats at **${aed(r.fare)}** per passenger\n- ${r.deadline_days}-day confirmation deadline\n\nReview and edit the email below. **Nothing has been sent.**` }])
    } catch (e) { flash(errMsg(e)) } finally { setTyping(false) }
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
    setChatBusy(true); setTyping(true); setThread((t) => [...t, { role: 'user', text: message }])
    try {
      const r = await api.chat(`[Request ID: ${selectedId}] ${message}`, chatHistory)
      setThread((t) => [...t, { role: 'assistant', text: r.response }]); setChatHistory(r.history)
    } catch (e) { flash(errMsg(e)) } finally { setChatBusy(false); setTyping(false) }
  }

  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' }) }, [thread, typing, counterofferDraft])

  const recColor = score ? REC_COLORS[score.recommendation] : undefined

  return <main className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#dashboard" aria-label="Aeroform home"><span className="brand-mark"><Plane size={18} strokeWidth={2.2}/></span><span>Aeroform<span className="brand-sub">REVENUE INTELLIGENCE</span></span></a>
      <div className="workspace-label">WORKSPACE <ChevronDown size={13}/></div>
      <nav aria-label="Main navigation">
        <button type="button" className={`nav-item ${activePage === 'overview' ? 'active' : ''}`} onClick={() => setActivePage('overview')}><LayoutDashboard size={17}/> Overview</button>
        <button type="button" className={`nav-item ${activePage === 'requests' ? 'active' : ''}`} onClick={() => setActivePage('requests')}><FileText size={17}/> Open requests <span className="nav-count">{total}</span></button>
        <button type="button" className={`nav-item ${activePage === 'all-requests' ? 'active' : ''}`} onClick={() => { setActivePage('all-requests'); setAllReqState((s) => s === 'error' ? 'idle' : s) }}><List size={17}/> All requests</button>
        <button type="button" className={`nav-item ${activePage === 'audit' ? 'active' : ''}`} onClick={() => setActivePage('audit')}><History size={17}/> Decision log</button>
      </nav>
      <div className="sidebar-bottom"><div className="profile"><div className="avatar dark">RM</div><div><b>Revenue Manager</b><span>Group desk</span></div><ChevronDown size={15}/></div></div>
    </aside>

    <section className="main-content" id="dashboard">
      <header className="topbar"><div className="breadcrumb">Revenue management <span>/</span> <b>{PAGE_LABELS[activePage]}</b></div><div className="top-actions"><span className={`api-status ${listState === 'error' ? 'error' : ''}`}><span className="live-dot"/> {listState === 'error' ? 'API unreachable' : 'Live'}</span></div></header>
      <div className="page-content">
        {listState === 'error' && <div className="empty-state" role="alert">Cannot connect to server — {listError}. Check that the API is running and NEXT_PUBLIC_API_BASE_URL is correct.</div>}

        {/* ── OVERVIEW PAGE ─────────────────────────────────────────── */}
        {activePage === 'overview' && <><div className="heading-row"><div><div className="eyebrow">{today}</div><h1>{greeting} <span className="wave">✳</span></h1><p className="subheading">Here's your group booking performance at a glance.</p></div></div>
        <ExecutiveSummaryPanel data={summary} state={summaryState} error={summaryError} onRetry={() => setSummaryTick((n) => n + 1)}/>
        <OpportunitiesPanel data={oppData} state={oppState} error={oppError} onRetry={() => setSummaryTick((n) => n + 1)} onOpen={(id) => { setSelectedId(id); setQueueCollapsed(true); setActivePage('requests') }} onViewAll={() => setActivePage('requests')}/>
        <StrategyComparisonPanel data={comparison} state={comparisonState} error={comparisonError} onRetry={() => setSummaryTick((n) => n + 1)}/>
        </>}

        {/* ── OPEN REQUESTS PAGE ────────────────────────────────────── */}
        {activePage === 'requests' && <>

        {/* Queue list (shown when not collapsed) */}
        {!queueCollapsed && <section className="panel queue-panel" style={{marginBottom:14}}>
          <div className="panel-head">
            <div><div className="panel-title">Requests to review <span className="count-badge">{filtered.length === requests.length ? total : `${filtered.length} of ${requests.length}`}</span></div><div className="panel-caption">Click a request to review and act on it</div></div>
          </div>
          {/* Dropdown filters */}
          <div className="filter-dropdowns">
            <StatusFilter label="Filter requests by status" value={statusFilter} onChange={setStatusFilter} total={requests.length} options={statuses.map((st) => ({ value: st, count: statusCounts[st] }))}/>
            <div className="filter-select-wrap">
              <Plane size={12}/>
              <select aria-label="Filter by route" value={routeFilter} onChange={(e) => setRouteFilter(e.target.value)}>
                <option value="">All routes</option>
                {routes.map((r) => <option key={r} value={r}>{route(r)}</option>)}
              </select>
            </div>
            <div className="filter-select-wrap">
              <Activity size={12}/>
              <select aria-label="Filter by flight" value={flightFilter} onChange={(e) => setFlightFilter(e.target.value)}>
                <option value="">All flights</option>
                {flights.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <label className="search-box inline-search"><Search size={13}/><input ref={searchRef} aria-label="Search requests" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)}/><kbd>Ctrl K</kbd></label>
            {hasFilters && <button type="button" className="filter-clear" onClick={clearFilters}>Clear</button>}
          </div>
          {/* Prob legend */}
          <div className="prob-legend"><span className="prob-dot prob-high"/>High conv. (&ge;35%)<span className="prob-dot prob-mid"/>Medium (12–35%)<span className="prob-dot prob-low"/>Low (&lt;12%)<span className="prob-dot prob-none"/>Not scored</div>
          <div className="request-list">
            {pageRows.map((r) => {
              const p = scoreMap[r.request_id]
              return <button key={r.request_id} className={`request-row ${selectedId === r.request_id ? 'selected' : ''} ${pConvertClass(p)}`} onClick={() => { setSelectedId(r.request_id); setQueueCollapsed(true) }}>
                <span className="request-avatar">{initials(r.ond)}</span>
                <span className="request-main">
                  <span className="request-route">{route(r.ond)}<span className="request-id">{r.request_id}</span></span>
                  <span className="request-meta">{r.flight_number} · {r.group_size} pax · {aed(r.quoted_fare_per_pax)}/pax</span>
                </span>
                <span className="request-side">
                  <StatusBadge status={r.status}/>
                  <span className="request-date"><Clock3 size={12}/>{daysLeft(r.departure_dt) ?? '—'}d left</span>
                  {p != null && <span className={`prob-badge ${pConvertClass(p)}`}>{pct(p)}</span>}
                </span>
              </button>
            })}
            {listState === 'loading' && Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton-row" aria-hidden="true"/>)}
            {listState === 'ready' && filtered.length === 0 && <div className="empty-state">No requests match current filters. <button type="button" className="filter-clear" onClick={clearFilters}>Clear filters</button></div>}
          </div>
          {filtered.length > 0 && <nav className="pagination" aria-label="Requests pagination"><span className="page-info">{(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}</span><div className="page-controls"><button type="button" className="page-btn" aria-label="Previous page" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>&#8249;</button>{pageList(safePage, totalPages).map((n, i) => n === '…' ? <span key={`e${i}`} className="page-gap">…</span> : <button type="button" key={n} className={`page-btn ${n === safePage ? 'current' : ''}`} aria-current={n === safePage ? 'page' : undefined} onClick={() => setPage(n)}>{n}</button>)}<button type="button" className="page-btn" aria-label="Next page" disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>&#8250;</button></div><label className="page-size">Rows<select aria-label="Rows per page" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label></nav>}
        </section>}

        {/* Full detail view when queue is collapsed */}
        {queueCollapsed && selectedId && <section className="panel request-detail-card">
          <div className="request-detail-nav">
            <button type="button" className="back-btn" onClick={() => setQueueCollapsed(false)}><ChevronLeft size={14}/> All requests</button>
            <div className="request-detail-nav-right">
              {scoring && <span className="scoring-badge">Scoring…</span>}
              {score && <span className={`prob-badge large ${pConvertClass(score.p_convert_at_best)}`}>{pct(score.p_convert_at_best)} P(convert)</span>}
              {(detail?.status ?? selected?.status) ? <StatusBadge status={(detail?.status ?? selected?.status) as string}/> : <span>—</span>}
            </div>
          </div>
          <div className="request-detail-title">
            <h2>{route(detail?.ond ?? selected?.ond ?? '')}</h2>
            <span className="request-detail-ids">{detail?.request_id ?? selected?.request_id} <i>·</i> {detail?.group_request_id ?? '—'}</span>
          </div>
          <div className="request-detail-grid">
            <DetailField label="Flight" value={detail?.flight_number ?? selected?.flight_number ?? '—'}/>
            <DetailField label="Departure" value={fmtDate(detail?.departure_dt ?? selected?.departure_dt ?? null)}/>
            <DetailField label="Dep. time" value={fmtTime(detail?.departure_dt ?? selected?.departure_dt ?? null)}/>
            <DetailField label="Days to dep." value={left != null ? `${left} days` : '—'}/>
            <DetailField label="Trip type" value={detail?.trip_type ?? '—'}/>
            <DetailField label="Group size" value={detail?.group_size != null ? `${detail.group_size} pax` : selected?.group_size ? `${selected.group_size} pax` : '—'}/>
            <DetailField label="Agent code" value={detail?.agent_code ?? '—'}/>
            <DetailField label="Agent email" value={detail?.agent_email ?? '—'}/>
            <DetailField label="Quoted fare" value={aed(detail?.quoted_fare_per_pax ?? selected?.quoted_fare_per_pax)}/>
            <DetailField label="Ref. fare" value={aed(detail?.ref_fare ?? selected?.ref_fare)}/>
            <DetailField label="Fare ratio" value={detail?.fare_ratio != null ? `${(detail.fare_ratio * 100).toFixed(0)}%` : '—'}/>
            <DetailField label="Competitor fare" value={aed(detail?.competitor_fare)}/>
            <DetailField label="Load factor" value={detail?.load_factor != null ? `${Math.round(detail.load_factor * 100)}%` : '—'}/>
            <DetailField label="Seats available" value={detail?.seats_available != null ? String(detail.seats_available) : '—'}/>
            <DetailField label="Lead time" value={detail?.lead_time != null ? `${Math.round(detail.lead_time)} days` : '—'}/>
            <DetailField label="Agent conv. rate" value={detail ? pct(detail.agent_conv_rate) : '—'}/>
            <DetailField label="Route conv. rate" value={detail ? pct(detail.route_conv_rate) : '—'}/>
            <DetailField label="Agent prior reqs." value={detail?.agent_prior_requests != null ? String(detail.agent_prior_requests) : '—'}/>
            <DetailField label="Route prior reqs." value={detail?.route_prior_requests != null ? String(detail.route_prior_requests) : '—'}/>
            <DetailField label="Options" value={detail?.num_options != null ? String(detail.num_options) : '—'}/>
          </div>
        </section>}

        {/* AI recommendation + action buttons */}
        <div style={{marginBottom:14}}>
          <section className="panel recommendation-panel">
            <div className="panel-head"><div><div className="panel-title">AI recommendation <span className="ai-tag"><Sparkles size={11}/> ASSIST</span></div><div className="panel-caption">{selected ? `${selected.request_id} · ${route(selected.ond)} · ${fmtDate(selected.departure_dt)}` : 'No request selected'}</div></div></div>
            {scoring && <div className="empty-state">Scoring request — this can take a few seconds…</div>}
            {scoreError && <div className="empty-state" role="alert">{scoreError} <button className="subtle-button" onClick={() => setRetryTick((n) => n + 1)}>Retry</button></div>}
            {!selectedId && !scoring && <div className="empty-state">Select a request from the list to see the AI recommendation.</div>}
            {score && <>
            <div className="recommendation-banner"><div className="recommend-icon" style={{ background: recColor }}><Sparkles size={17}/></div><div><div className="recommend-label">RECOMMENDED ACTION</div><strong style={{ color: recColor }}>{REC_LABELS[score.recommendation] ?? score.recommendation}</strong></div><span className="confidence">{pct(score.p_convert_base)} base P(convert)</span></div>
            <div className="offer-grid"><Offer label="Proposed fare" value={aed(fare)} suffix="/ passenger"/><Offer label="Seat allocation" value={`${seats}`} suffix={`of ${pax} seats`}/><Offer label="Confirmation deadline" value={`${deadline} days`} suffix="after quote"/><Offer label="Conversion probability" value={pct(probability)} suffix="model estimate" highlight/></div>
            <label className="deadline-control">Confirmation deadline<select value={deadline} onChange={(e) => setDeadline(Number(e.target.value))}>{DEADLINES.map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
            <div className="contribution-line"><span>Expected incremental contribution</span><b className={(contribution ?? 0) > 0 ? 'positive-value' : ''}>{aed(contribution)}</b></div>
            <p className="recommend-copy">Optimizer pick: {score.best_seats} seats at {aed(score.best_fare)} within {score.best_deadline_days} days, worth {aed(score.expected_contribution)} vs. {aed(score.baseline_contribution)} for the rule-based baseline. Displacement cost: {aed(score.displacement_cost)}.</p>
            <div className="button-row"><button disabled={busy} className={`primary-button ${decision && decision !== 'reject' ? 'is-approved' : ''}`} onClick={() => decide('approve')}>{decision && decision !== 'reject' ? <><Check size={15}/> Recorded</> : <><Check size={15}/> {offerChanged ? 'Approve edited offer' : 'Approve recommendation'}</>}</button><button disabled={busy} className="outline-button" onClick={() => decide('reject')}><X size={15}/> {decision === 'reject' ? 'Rejected' : 'Reject'}</button><button className="outline-button draft-button" onClick={draftCounteroffer}><FileText size={14}/> Draft counteroffer</button></div>
            </>}
          </section>
        </div>

        {/* Analysis + inventory (shown when request is selected and detail is open) */}
        {selectedId && queueCollapsed && <>
        <div className="analysis-grid">
          <section className="panel analysis-panel"><div className="panel-head"><div><div className="panel-title">Scenario analysis</div><div className="panel-caption">Adjust the offer to explore the trade-off</div></div><span className="model-tag"><span className="live-dot"/> MODEL-BASED</span></div>
            {score ? <>
            <div className="scenario-controls"><label>Fare per passenger <strong>{aed(fare)}</strong><input aria-label="Fare per passenger" type="range" min={Math.round(fareMin)} max={Math.round(fareMax)} step="5" value={fare} onChange={(e) => setFare(Number(e.target.value))}/><span className="range-labels"><span>70% · {aed(fareMin)}</span><span>120% · {aed(fareMax)}</span></span></label><label>Seats to allocate <strong>{seats} seats</strong><input aria-label="Seats to allocate" type="range" min="1" max={Math.max(1, pax, score.best_seats)} step="1" value={seats} onChange={(e) => setSeats(Number(e.target.value))}/><span className="range-labels"><span>1 seat</span><span>{Math.max(pax, score.best_seats)} max</span></span></label></div>
            {scenario && <div className="assumption-note">Group revenue {aed(scenario.group_revenue)} · displacement {aed(scenario.displacement_cost)} · holding {aed(scenario.holding_cost)}</div>}
            <div className="chart-wrap"><div className="chart-top"><span>Fare response curve</span><span className="chart-legend"><i/> Conversion probability</span></div><div className="curve-chart"><div className="y-labels">{yTicks.map((t) => <span key={t}>{t}</span>)}</div><div className="chart-plot"><div className="grid-line one"/><div className="grid-line two"/><div className="grid-line three"/><svg viewBox="0 0 500 160" preserveAspectRatio="none" role="img" aria-label="Conversion probability versus fare"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#ff0041" stopOpacity=".16"/><stop offset="100%" stopColor="#ff0041" stopOpacity="0"/></linearGradient></defs>{linePath && <><path d={`${linePath} L500,160 L0,160Z`} fill="url(#fill)"/><path d={linePath} fill="none" stroke="#ff0041" strokeWidth="3" vectorEffect="non-scaling-stroke"/></>}<line x1={`${xPct(refFare)}%`} y1="0" x2={`${xPct(refFare)}%`} y2="100%" stroke="#6b777c" strokeDasharray="2 4"/><line x1={`${xPct(score.best_fare)}%`} y1="0" x2={`${xPct(score.best_fare)}%`} y2="100%" stroke="#00b26e"/><line x1={`${xPct(fare)}%`} y1="0" x2={`${xPct(fare)}%`} y2="100%" stroke="#e39c4e" strokeDasharray="4 4"/></svg><div className="x-labels"><span>{Math.round(fareMin)}</span><span>ref {Math.round(refFare)}</span><span>{Math.round(fareMax)} AED</span></div></div></div></div>
            </> : <div className="empty-state">{scoring ? 'Waiting for score…' : 'Select a request'}</div>}
          </section>
          <section className="panel drivers-panel"><div className="panel-head"><div><div className="panel-title">What drives this decision?</div><div className="panel-caption">Top SHAP factors for P(convert)</div></div></div>
            {drivers.map((d) => <Driver key={d.feature} label={featureLabel(d.feature)} detail={`value ${Number(d.value.toFixed(3))}`} value={`${d.shap_value >= 0 ? '+' : ''}${d.shap_value.toFixed(2)}`} positive={d.shap_value >= 0} negative={d.shap_value < 0} width={`${Math.max(4, (Math.abs(d.shap_value) / maxShap) * 100)}%`}/>)}
            {!drivers.length && <div className="empty-state">{scoring ? 'Waiting for score…' : 'No drivers yet'}</div>}
            <div className="confidence-note"><ShieldCheck size={15}/><span><b>Positive = raises P(convert)</b><br/>Negative = lowers P(convert)</span></div>
          </section>
        </div>
        <div className="bottom-grid">
          <section className="panel inventory-panel"><div className="panel-head"><div><div className="panel-title">Flight inventory</div><div className="panel-caption">{selected ? `${route(selected.ond)} · ${fmtDate(selected.departure_dt)} · ${selected.flight_number}` : '—'}</div></div></div><div className="inventory-stats"><div><span>Seats available</span><b>{detail?.seats_available ?? '—'}</b></div><div><span>Load factor</span><b>{detail?.load_factor != null ? `${Math.round(detail.load_factor * 100)}%` : '—'}</b></div><div><span>Departure</span><b>{fmtTime(selected?.departure_dt ?? null)} <small>{left != null ? `· ${left}d` : ''}</small></b></div><div><span>Reference fare</span><b>{aed(refFare)}</b></div></div>
            {detail?.load_factor != null && <div className="capacity-bar"><span style={{ width: `${Math.round(detail.load_factor * 100)}%` }}/></div>}
            <div className="classes"><span>Agent</span><b>{detail?.agent_code ?? '—'}</b><b>conv. <i>{detail ? pct(detail.agent_conv_rate) : '—'}</i></b><b>route conv. <i>{detail ? pct(detail.route_conv_rate) : '—'}</i></b></div></section>
          <section className="panel trend-panel"><div className="panel-head"><div><div className="panel-title">Fare × seats heat map</div><div className="panel-caption">Expected contribution · deadline {heatDeadline} days</div></div><select aria-label="Heat map deadline" className="subtle-button" value={heatDeadline} onChange={(e) => setHeatDeadline(Number(e.target.value))}>{DEADLINES.map((d) => <option key={d} value={d}>{d} days</option>)}</select></div>
            {heat.length ? <div role="img" aria-label="Expected contribution by fare and seats" style={{ display: 'grid', gridTemplateColumns: `auto repeat(${heatFares.length}, 1fr)`, gap: 2, fontSize: 12 }}>
              {heatSeats.map((s) => <HeatRow key={s} seats={s} fares={heatFares} heat={heat} color={heatColor}/>)}
              <span/>{heatFares.map((f, i) => <span key={f} style={{ textAlign: 'center', fontSize: 11 }}>{i % 2 === 0 ? f : ''}</span>)}
            </div> : <div className="empty-state">{scoring ? 'Waiting for score…' : 'No data'}</div>}</section>
        </div>
        </>}
        </>}

        {/* ── ALL REQUESTS PAGE ─────────────────────────────────────── */}
        {activePage === 'all-requests' && <section className="panel all-requests-panel" style={{margin:'0 0 24px'}}>
          <div className="panel-head"><div><div className="panel-title">All requests <span className="count-badge">{allFiltered.length === allRequests.length ? allRequests.length : `${allFiltered.length} of ${allRequests.length}`}</span></div><div className="panel-caption">Complete history including closed and converted</div></div>{allReqState === 'error' && <button className="subtle-button" onClick={() => setAllReqState('idle')}>Retry</button>}{allReqState === 'ready' && <StatusFilter label="Filter all requests by status" value={allStatus} onChange={setAllStatus} total={allRequests.length} options={allStatuses.map((st) => ({ value: st, count: allStatusCounts[st] }))}/>}</div>
          {allReqState === 'loading' && Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton-row" aria-hidden="true"/>)}
          {allReqState === 'ready' && <div className="all-requests-table"><table><thead><tr><th>Request ID</th><th>Group ID</th><th>Created</th><th>Status</th><th>Route</th><th>Group size</th><th>Converted</th></tr></thead><tbody>{allRows.map((r) => <tr key={r.request_id} className={selectedId === r.request_id ? 'selected-row' : ''} onClick={() => { setSelectedId(r.request_id); setActivePage('requests') }}><td><code>{r.request_id}</code></td><td><code>{r.group_request_id}</code></td><td>{fmtTs(r.created_on)}</td><td><StatusBadge status={r.status}/></td><td>{route(r.ond)}</td><td>{r.group_size}</td><td>{r.converted != null ? r.converted : '—'}</td></tr>)}</tbody></table></div>}
          {allReqState === 'ready' && allRequests.length === 0 && <div className="empty-state">No requests found.</div>}
          {allReqState === 'ready' && allRequests.length > 0 && allFiltered.length === 0 && <div className="empty-state">No requests with status {allStatus}. <button type="button" className="filter-clear" onClick={() => setAllStatus('')}>Clear filter</button></div>}
          {allReqState === 'ready' && allFiltered.length > 0 && <nav className="pagination" aria-label="All requests pagination"><span className="page-info">{(allSafePage - 1) * allPageSize + 1}–{Math.min(allSafePage * allPageSize, allFiltered.length)} of {allFiltered.length}</span><div className="page-controls"><button type="button" className="page-btn" aria-label="Previous page" disabled={allSafePage === 1} onClick={() => setAllPage(allSafePage - 1)}>‹</button>{pageList(allSafePage, allTotalPages).map((n, i) => n === '…' ? <span key={`e${i}`} className="page-gap">…</span> : <button type="button" key={n} className={`page-btn ${n === allSafePage ? 'current' : ''}`} aria-current={n === allSafePage ? 'page' : undefined} aria-label={`Page ${n}`} onClick={() => setAllPage(n)}>{n}</button>)}<button type="button" className="page-btn" aria-label="Next page" disabled={allSafePage === allTotalPages} onClick={() => setAllPage(allSafePage + 1)}>›</button></div><label className="page-size">Rows<select aria-label="Rows per page" value={allPageSize} onChange={(e) => setAllPageSize(Number(e.target.value))}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label></nav>}
        </section>}

        {/* ── DECISION LOG PAGE ─────────────────────────────────────── */}
        {activePage === 'audit' && <section className="panel audit-panel"><div className="panel-head"><div><div className="panel-title">Decision log</div><div className="panel-caption">Human approvals and rejections recorded by the API</div></div><ShieldCheck size={16} color="#ff0041"/></div>{audit.length ? <div className="audit-list">{audit.slice(0, 50).map((e, i) => <div className="audit-entry" key={`${e.timestamp}-${i}`}><span className="audit-dot"/><span>{fmtTs(e.timestamp)} · {e.action} · {e.request_id}{e.fare != null ? ` · ${e.seats ?? '?'} seats at ${aed(e.fare)}` : ''}{e.note ? ` · ${e.note}` : ''}</span></div>)}</div> : <div className="audit-empty">No decisions recorded yet. Approve or reject a recommendation to create an audit entry.</div>}</section>}

        <footer className="footer"><span>AI recommendations support decisions — all offers require human approval.</span></footer>
      </div>
    </section>
    <aside className={`agent-panel ${panelOpen ? '' : 'panel-collapsed'}`}>
      <button type="button" className="panel-toggle-btn" aria-label={panelOpen ? 'Collapse assistant' : 'Expand assistant'} onClick={() => setPanelOpen((o) => !o)}>{panelOpen ? <ChevronRight size={16}/> : <ChevronLeft size={16}/>}</button>
      {panelOpen && <>
      <div className="agent-head">
        <div className="agent-icon"><Bot size={22}/></div>
        <div className="agent-title"><b>AI Booking Assistant</b><span>Explains · Simulates · Drafts</span></div>
        <span className="agent-online"><i className="live-dot"/> Online</span>
        <div className="agent-context"><span className="agent-context-label">Discussing</span><b>{selected ? `${selected.request_id} · ${route(selected.ond)}` : 'No request selected'}</b>{selected && <span>{pax} pax · {fmtDate(selected.departure_dt)}</span>}</div>
      </div>
      <div className="agent-body" ref={bodyRef}>
        {thread.length === 0 && !typing && <div className="agent-hero">
          <div className="agent-hero-icon"><Sparkles size={26}/></div>
          <h3>How can I help with {selected ? selected.request_id : 'this request'}?</h3>
          <p>I use the model's scores and scenarios, so every number is traceable.</p>
          <div className="agent-cards">
            <button type="button" className="agent-card" disabled={chatBusy || !selectedId} onClick={() => ask('Why this recommendation?')}><span className="agent-card-icon"><Sparkles size={16}/></span><span><b>Why this recommendation?</b><small>Plain-language reasoning behind the decision</small></span></button>
            <button type="button" className="agent-card" disabled={chatBusy || !selectedId} onClick={() => ask('What if we raise the fare by 5%?')}><span className="agent-card-icon"><Activity size={16}/></span><span><b>What if we raise the fare?</b><small>Simulate a +5% fare and compare outcomes</small></span></button>
            <button type="button" className="agent-card" disabled={chatBusy || !selectedId} onClick={draftCounteroffer}><span className="agent-card-icon"><FileText size={16}/></span><span><b>Draft a counteroffer</b><small>Generate an email for the travel agent</small></span></button>
          </div>
        </div>}
        <div className="thread" aria-live="polite">
          {thread.map((m, i) => m.role === 'user'
            ? <div key={i} className="msg user"><div className="bubble">{m.text}</div></div>
            : <div key={i} className="msg assistant"><span className="msg-avatar"><Bot size={15}/></span><div className="bubble"><article className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown></article></div></div>)}
          {typing && <div className="msg assistant"><span className="msg-avatar"><Bot size={15}/></span><div className="bubble typing" aria-label="Assistant is thinking"><i/><i/><i/></div></div>}
        </div>
        {counterofferDraft && <section ref={draftRef} className="counteroffer-card" aria-label="Counteroffer draft"><div className="counteroffer-card-head"><div><b>Counteroffer email</b><span>{emailSent ? 'SENT' : 'DRAFT · NOT SENT'}</span></div><FileText size={15}/></div><label className="sr-only" htmlFor="counteroffer-draft">Editable counteroffer message</label><textarea id="counteroffer-draft" value={counterofferDraft} onChange={(event) => { setCounterofferDraft(event.target.value); setEmailSent(false) }}/><div className="counteroffer-actions"><button type="button" className="copy-draft-button" onClick={copyCounteroffer}><Copy size={13}/> Copy</button><div className="send-email-row"><input className="email-input" type="email" placeholder="Recipient email…" value={recipientEmail} onChange={(e) => { setRecipientEmail(e.target.value); setEmailSent(false) }} aria-label="Recipient email address"/><button type="button" className={`send-email-button ${emailSent ? 'is-sent' : ''}`} onClick={sendEmail} disabled={emailSending || !recipientEmail || emailSent}>{emailSent ? <><Check size={13}/> Sent</> : emailSending ? 'Sending…' : <><Send size={13}/> Send</>}</button></div></div>{detail?.agent_email && <p className="counteroffer-note agent-email-note"><Check size={10}/> Recipient pre-filled from agent profile ({detail.agent_email})</p>}<p className="counteroffer-note">Review and edit before sending. All sends are logged to the audit trail.</p></section>}
      </div>
      {thread.length > 0 && <div className="quick-actions" role="group" aria-label="Suggested questions"><button type="button" disabled={chatBusy} onClick={() => ask('Why this recommendation?')}>Why this?</button><button type="button" disabled={chatBusy} onClick={() => ask('What if we raise the fare by 5%?')}>Raise fare 5%</button><button type="button" disabled={chatBusy} onClick={() => ask('What are the main risks?')}>Key risks</button><button type="button" disabled={chatBusy} onClick={draftCounteroffer}>Draft counteroffer</button></div>}
      <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); const m = chat; setChat(''); ask(m) }}><input aria-label="Ask the booking assistant" value={chat} onChange={(e) => setChat(e.target.value)} placeholder={selected ? `Ask about ${selected.request_id}…` : 'Select a request to start…'} disabled={!selectedId}/><button aria-label="Send message" type="submit" disabled={chatBusy || !chat.trim()}><Send size={17}/></button></form>
      <div className="agent-disclaimer">AI responses are based on model scenarios, not live PSS updates.</div>
      </>}
    </aside>
    {notice && <div className="toast" role="status"><Check size={15}/>{notice}</div>}
  </main>
}

function HeatRow({ seats, fares, heat, color }: { seats: number; fares: number[]; heat: { fare: number; seats: number; expected_contribution: number }[]; color: (v: number) => string }) {
  return <>
    <span style={{ paddingRight: 4, alignSelf: 'center' }}>{seats}</span>
    {fares.map((f) => { const c = heat.find((h) => h.fare === f && h.seats === seats); return <span key={f} title={c ? `${f} AED × ${seats} seats → AED ${Math.round(c.expected_contribution).toLocaleString()}` : ''} style={{ height: 22, borderRadius: 3, background: c ? color(c.expected_contribution) : 'transparent' }}/> })}
  </>
}
function Offer({label,value,suffix,highlight}:{label:string;value:string;suffix:string;highlight?:boolean}) {return <div className={`offer ${highlight?'highlight':''}`}><span>{label}</span><b>{value}</b><small>{suffix}</small></div>}
function Driver({label,detail,value,positive,negative,width}:{label:string;detail:string;value:string;positive?:boolean;negative?:boolean;width:string}) {return <div className="driver"><div className="driver-head"><span><b>{label}</b><small>{detail}</small></span><em className={positive?'driver-positive':negative?'driver-negative':''}>{value}</em></div><div className="driver-track"><i className={positive?'driver-fill-positive':negative?'driver-fill-negative':''} style={{width}}/></div></div>}

const statusSlug = (st: string) => st.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function StatusBadge({ status }: { status: string }) {
  return <span className={`status ${statusSlug(status)}`}><i className="status-dot" aria-hidden="true"/>{status}</span>
}

function StatusFilter({ label, value, onChange, total, options }: { label: string; value: string; onChange: (v: string) => void; total: number; options: { value: string; count: number }[] }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const items = [{ value: '', count: total }, ...options]
  const current = items.find((o) => o.value === value) ?? items[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  function choose(v: string) { onChange(v); setOpen(false); btn.current?.focus() }
  function onKey(e: React.KeyboardEvent) {
    if (!open) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, items.findIndex((o) => o.value === value))); setOpen(true) } return }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btn.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(items[active].value) }
    else if (e.key === 'Tab') setOpen(false)
  }

  return <div className="sf" ref={wrap} onKeyDown={onKey}>
    <button ref={btn} type="button" className={`sf-trigger ${value ? 'active' : ''}`} aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => { setActive(Math.max(0, items.findIndex((o) => o.value === value))); setOpen((o) => !o) }}>
      {value ? <i className={`status-dot ${statusSlug(value)}`} aria-hidden="true"/> : <ListFilter size={14} aria-hidden="true"/>}
      <span className="sf-label">{value || 'All statuses'}</span>
      <span className="sf-count">{current.count}</span>
      <ChevronDown size={14} className="sf-chevron" aria-hidden="true"/>
    </button>
    {open && <ul className="sf-menu" role="listbox" aria-label={label}>
      {items.map((o, i) => <li key={o.value || 'all'} role="option" aria-selected={o.value === value} className={`sf-option ${i === active ? 'focus' : ''} ${o.value === value ? 'selected' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(o.value)}>
        {o.value ? <i className={`status-dot ${statusSlug(o.value)}`} aria-hidden="true"/> : <i className="status-dot all" aria-hidden="true"/>}
        <span className="sf-opt-label">{o.value || 'All statuses'}</span>
        <span className="sf-opt-count">{o.count}</span>
        {o.value === value && <Check size={14} className="sf-check" aria-hidden="true"/>}
      </li>)}
    </ul>}
  </div>
}
function DetailField({ label, value }: { label: string; value: string }) { return <div className="detail-field"><span>{label}</span><b>{value}</b></div> }

/* ── Overview: executive summary ────────────────────────────────────────────── */
type KpiTone = 'brand' | 'positive' | 'negative' | 'neutral' | 'info'

function KpiCard({ icon, label, value, caption, detail, tone = 'brand', valueTone }: { icon: React.ReactNode; label: string; value: string; caption: string; detail?: React.ReactNode; tone?: KpiTone; valueTone?: 'positive' | 'negative' }) {
  return <article className="kpi-card" aria-label={label}>
    <div className="kpi-head"><span className={`kpi-icon ${tone}`} aria-hidden="true">{icon}</span><h3 className="kpi-label">{label}</h3></div>
    <div className={`kpi-value ${valueTone ?? ''} ${value === 'N/A' ? 'na' : ''}`}>{value}</div>
    {detail && <div className="kpi-detail">{detail}</div>}
    <p className="kpi-caption">{caption}</p>
  </article>
}

const signedAed = (n: number) => `${n >= 0 ? '+' : '−'}${aed(Math.abs(n))}`
const fmtPct = (n: number | null | undefined, digits = 1) => (n == null ? 'N/A' : `${n.toLocaleString(undefined, { maximumFractionDigits: digits })}%`)

function SectionHead({ id, title, sub, action }: { id: string; title: string; sub: string; action?: React.ReactNode }) {
  return <div className="exec-head"><div><h2 id={id} className="exec-title">{title}</h2><p className="exec-sub">{sub}</p></div>{action}</div>
}

function SectionError({ message, error, onRetry }: { message: string; error: string; onRetry: () => void }) {
  return <div className="kpi-error" role="alert"><AlertCircle size={18}/><div><b>{message}</b><span>{error || 'Service temporarily unavailable'}</span></div><button type="button" className="subtle-button" onClick={onRetry}><RefreshCw size={14}/> Retry</button></div>
}

function ExecutiveSummaryPanel({ data, state, error, onRetry }: { data: ExecutiveSummary | null; state: 'loading' | 'ready' | 'error'; error: string; onRetry: () => void }) {
  const head = <SectionHead id="exec-title" title="Executive summary" sub="Estimates for requests awaiting a decision"/>
  if (state === 'loading' && !data) return <section className="exec" aria-labelledby="exec-title" aria-busy="true">{head}<div className="kpi-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="kpi-card kpi-skeleton" aria-hidden="true"><i/><b/><u/></div>)}</div></section>
  if (state === 'error' && !data) return <section className="exec" aria-labelledby="exec-title">{head}<SectionError message="Couldn’t load the summary" error={error} onRetry={onRetry}/></section>
  if (!data) return null

  const empty = data.open_requests === 0
  const noScore = !empty && data.ai_contribution == null
  const inc = data.incremental_contribution
  const positive = inc != null && inc >= 0
  const pctText = data.improvement_pct == null ? null : `${data.improvement_pct >= 0 ? '+' : '−'}${fmtPct(Math.abs(data.improvement_pct))} vs baseline`

  return <section className="exec" aria-labelledby="exec-title">
    {head}
    <div className="kpi-grid">
      <KpiCard icon={<Wallet size={18}/>} label="Expected contribution" tone="brand" value={empty ? 'AED 0' : noScore ? 'N/A' : aed(data.ai_contribution)} caption="Across pending opportunities"/>
      <KpiCard icon={positive ? <TrendingUp size={18}/> : <TrendingDown size={18}/>} label="Incremental vs baseline" tone={inc == null ? 'neutral' : positive ? 'positive' : 'negative'}
        value={empty || inc == null ? 'N/A' : signedAed(inc)} valueTone={inc == null ? undefined : positive ? 'positive' : 'negative'}
        detail={inc != null && pctText && <span className={`kpi-pill ${positive ? 'positive' : 'negative'}`}>{pctText}</span>}
        caption="Compared with existing pricing rules"/>
      <KpiCard icon={<ClipboardList size={18}/>} label="Open requests" tone="info" value={data.open_requests.toLocaleString()} caption="Awaiting a decision"/>
      <KpiCard icon={<Armchair size={18}/>} label="Seats requested" tone="neutral" value={data.seats_requested.toLocaleString()} caption="Across pending requests"/>
    </div>
    {state === 'error' && <p className="exec-note">Showing the last loaded figures — refresh failed.</p>}
  </section>
}

/* ── Overview: revenue opportunities (the action list) ──────────────────────── */
type OppFilter = '' | OpportunityCategory
const OPP_FILTERS: { key: OppFilter; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'high_value', label: 'High value' },
  { key: 'deadline_approaching', label: 'Deadline soon' },
  { key: 'inventory_review', label: 'Inventory check' },
]
const OPP_SORTS = [
  { value: 'priority', label: 'Priority' },
  { value: 'contribution', label: 'Expected contribution' },
  { value: 'conversion', label: 'Conversion' },
  { value: 'departure', label: 'Departure date' },
  { value: 'deadline', label: 'Confirm-by date' },
]
const OPP_STEP = 5
const fmtShort = (iso: string | null) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(+d) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) }
const inDays = (n: number | null) => (n == null ? '' : n < 1 ? 'today' : `in ${Math.round(n)}d`)

function OpportunityRow({ o, onOpen }: { o: Opportunity; onOpen: (id: string) => void }) {
  const urgent = o.urgency === 'critical' ? 'red' : o.urgency === 'soon' ? 'amber' : ''
  const flags: { text: string; tone: string }[] = []
  if (o.categories.includes('high_value')) flags.push({ text: 'High value', tone: 'green' })
  if (o.categories.includes('deadline_approaching') && o.days_to_latest_confirmation != null) flags.push({ text: `Cut-off ${inDays(o.days_to_latest_confirmation)}`, tone: o.urgency === 'critical' ? 'red' : 'amber' })
  if (o.categories.includes('inventory_review')) flags.push({ text: o.inventory_status === 'unknown' ? 'Inventory unknown' : 'Inventory risk', tone: 'amber' })
  return <button type="button" className="opp-row" onClick={() => onOpen(o.request_id)} aria-label={`Open request ${o.request_id}`}>
    <span className="opp-rank" title={`Priority ${o.priority_rank}`}>{o.priority_rank}</span>
    <span className="opp-main"><b>{o.request_id}</b><span>{o.ond ? route(o.ond) : '—'}{o.flight_number ? ` · ${o.flight_number}` : ''}</span><small>{o.agent_code ?? 'Agent n/a'} · {o.requested_seats} pax · departs {fmtShort(o.departure_dt)}</small></span>
    <span className="opp-money"><b className={o.expected_contribution > 0 ? 'pos' : 'neg'}>{aed(o.expected_contribution)}</b><small>{o.recommended_fare_pct != null ? `${fmtPct(o.recommended_fare_pct, 0)} of normal fare` : '—'} · {o.recommended_seats} seats</small></span>
    <span className="opp-meta"><b>{pct(o.p_convert)}</b><small>est. conversion</small></span>
    <span className="opp-meta"><b className={urgent}>{fmtShort(o.effective_deadline_date)}</b><small>confirm by</small></span>
    <span className={`opp-action ${o.recommendation.toLowerCase()}`} title="Recommended action from the AI optimizer">{o.recommendation.toUpperCase()}</span>
    {flags.length > 0 && <span className="opp-flags">{flags.map((f) => <i key={f.text} className={`opp-flag ${f.tone}`}>{f.text}</i>)}</span>}
  </button>
}

function OpportunitiesPanel({ data, state, error, onRetry, onOpen, onViewAll }: { data: OpportunityData | null; state: 'loading' | 'ready' | 'error'; error: string; onRetry: () => void; onOpen: (id: string) => void; onViewAll: () => void }) {
  const [filter, setFilter] = useState<OppFilter>('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('priority')
  const [visible, setVisible] = useState(OPP_STEP)

  const all = data?.opportunities ?? []
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = all.filter((o) => (!filter || o.categories.includes(filter)) && (!q || o.request_id.toLowerCase().includes(q) || (o.agent_code ?? '').toLowerCase().includes(q)))
    const num = (v: number | null) => (v == null ? 1e9 : v)
    const by: Record<string, (a: Opportunity, b: Opportunity) => number> = {
      priority: (a, b) => a.priority_rank - b.priority_rank,
      contribution: (a, b) => b.expected_contribution - a.expected_contribution,
      conversion: (a, b) => b.p_convert - a.p_convert,
      departure: (a, b) => num(a.days_to_departure) - num(b.days_to_departure),
      deadline: (a, b) => num(a.days_to_latest_confirmation) - num(b.days_to_latest_confirmation),
    }
    return [...list].sort((a, b) => by[sort](a, b) || a.priority_rank - b.priority_rank)
  }, [all, filter, query, sort])
  useEffect(() => { setVisible(OPP_STEP) }, [filter, query, sort])

  const head = <SectionHead id="opp-title" title="Revenue Opportunities Requiring Attention" sub="Pending requests ranked by expected contribution, urgency and inventory risk" action={<button type="button" className="subtle-button" onClick={onViewAll}>All open requests <ChevronRight size={14}/></button>}/>
  if (state === 'loading' && !data) return <section className="exec opp" aria-labelledby="opp-title" aria-busy="true">{head}{Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton-row" style={{ height: 72 }} aria-hidden="true"/>)}</section>
  if (state === 'error' && !data) return <section className="exec opp" aria-labelledby="opp-title">{head}<SectionError message="Couldn’t load revenue opportunities" error={error} onRetry={onRetry}/></section>
  if (!data) return null
  if (all.length === 0) return <section className="exec opp" aria-labelledby="opp-title">{head}<div className="empty-state">No pending group requests to prioritise right now.</div></section>

  const count = (k: OppFilter) => (k ? all.filter((o) => o.categories.includes(k)).length : all.length)
  const rows = shown.slice(0, visible)
  const clear = () => { setFilter(''); setQuery('') }

  return <section className="exec opp" aria-labelledby="opp-title">
    {head}
    <div className="opp-bar">
      <div className="opp-tabs" role="group" aria-label="Show opportunities">
        {OPP_FILTERS.map((f) => <button key={f.key || 'all'} type="button" className={`opp-tab ${filter === f.key ? 'on' : ''}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label} <i>{count(f.key)}</i></button>)}
      </div>
      <div className="opp-tools">
      <label className="search-box inline-search"><Search size={13}/><input aria-label="Search opportunities" placeholder="Search request or agent…" value={query} onChange={(e) => setQuery(e.target.value)}/></label>
      <div className="filter-select-wrap"><span className="sort-label">Sort</span><select aria-label="Sort opportunities" value={sort} onChange={(e) => setSort(e.target.value)}>{OPP_SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
      </div>
    </div>
    <div className="opp-list">
      {rows.map((o) => <OpportunityRow key={o.request_id} o={o} onOpen={onOpen}/>)}
      {shown.length === 0 && <div className="empty-state">No opportunities match. <button type="button" className="filter-clear" onClick={clear}>Clear filters</button></div>}
    </div>
    {shown.length > OPP_STEP && <div className="opp-more">
      <span>Showing {rows.length} of {shown.length}</span>
      {visible < shown.length && <button type="button" className="subtle-button" onClick={() => setVisible((v) => v + OPP_STEP)}>Show more</button>}
      {visible > OPP_STEP && <button type="button" className="subtle-button" onClick={() => setVisible(OPP_STEP)}>Show less</button>}
    </div>}
  </section>
}

/* ── Overview: AI vs traditional strategy ───────────────────────────────────── */
function BarRow({ label, caption, value, max, tone }: { label: string; caption: string; value: number; max: number; tone: 'ai' | 'base' }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (Math.max(value, 0) / max) * 100)) : 0
  return <div className="cmp-bar-row">
    <span className="cmp-bar-label">{label}<small>{caption}</small></span>
    <div className="cmp-track" role="img" aria-label={`${label}: ${aed(value)}`}><i className={`cmp-fill ${tone}`} style={{ width: `${w}%` }}/></div>
    <b className="cmp-bar-value">{aed(value)}</b>
  </div>
}

function StrategyComparisonPanel({ data, state, error, onRetry }: { data: StrategyComparison | null; state: 'loading' | 'ready' | 'error'; error: string; onRetry: () => void }) {
  const head = <SectionHead id="cmp-title" title="AI vs Traditional Strategy" sub="Expected contribution with AI optimisation compared with the existing rules"/>
  if (state === 'loading' && !data) return <section className="exec cmp" aria-labelledby="cmp-title" aria-busy="true">{head}<div className="cmp-card kpi-skeleton" style={{ minHeight: 130 }} aria-hidden="true"><i/><b/><u/></div></section>
  if (state === 'error' && !data) return <section className="exec cmp" aria-labelledby="cmp-title">{head}<SectionError message="Couldn’t load the comparison" error={error} onRetry={onRetry}/></section>
  if (!data) return null
  if (data.evaluated_requests === 0) return <section className="exec cmp" aria-labelledby="cmp-title">{head}<div className="empty-state">No pending requests could be evaluated yet.</div></section>

  const { ai, baseline: bl } = data
  const inc = data.incremental_contribution ?? 0
  const tone = inc > 0 ? 'positive' : inc < 0 ? 'negative' : 'neutral'
  const max = Math.max(ai.expected_contribution, bl.expected_contribution, 1)
  const pctText = data.improvement_pct == null ? '' : ` (${data.improvement_pct >= 0 ? '+' : '−'}${fmtPct(Math.abs(data.improvement_pct))})`

  return <section className="exec cmp" aria-labelledby="cmp-title">
    {head}
    <div className="cmp-card">
      <div className="cmp-bars">
        <BarRow label="AI optimizer" caption={`${data.evaluated_requests} requests · avg ${fmtPct(ai.avg_fare_pct_of_normal, 0)} of normal fare`} value={ai.expected_contribution} max={max} tone="ai"/>
        <BarRow label="Traditional rules" caption={`avg ${fmtPct(bl.avg_fare_pct_of_normal, 0)} of normal fare`} value={bl.expected_contribution} max={max} tone="base"/>
      </div>
      <p className={`cmp-result ${tone}`} role="status">
        {inc > 0 ? <TrendingUp size={18} aria-hidden="true"/> : inc < 0 ? <TrendingDown size={18} aria-hidden="true"/> : null}
        <span><b>{data.incremental_contribution == null ? 'N/A' : signedAed(inc)}</b>{pctText} {inc >= 0 ? 'more' : 'less'} expected contribution with AI optimisation</span>
      </p>
    </div>
  </section>
}
