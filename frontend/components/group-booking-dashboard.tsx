'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Armchair, AlertCircle, ArrowUpRight, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock3, Copy, FileText, Filter, History, LayoutDashboard, List, Plane, RefreshCw, Search, Send, ShieldCheck, Sparkles, TrendingDown, TrendingUp, Wallet, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, ApiError, type ApprovalRequest, type AuditEntry, type ChatMessage, type ExecutiveSummary, type Opportunity, type OpportunityCategory, type OpportunityData, type StrategyComparison, type RequestAllSummary, type RequestDetail, type RequestSummary, type ScenarioResponse, type ScoreResponse, type SendCounterOfferRequest } from '@/lib/api'

type Page = 'overview' | 'requests' | 'all-requests' | 'audit'
const PAGE_LABELS: Record<Page, string> = { overview: 'Overview', requests: 'Open Requests', 'all-requests': 'All Requests', audit: 'Decision Log' }

const DEADLINES = [3, 7, 14]
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
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(8)
  const [queueCollapsed, setQueueCollapsed] = useState(false)
  const [scoreMap, setScoreMap] = useState<Record<string, number>>({})
  // greeting/today set in useEffect below
  const searchRef = useRef<HTMLInputElement>(null)
  const [decision, setDecision] = useState<'approve' | 'edit' | 'reject' | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [audit, setAudit] = useState<AuditEntry[]>([])
  // today set in useEffect below
  const [chat, setChat] = useState('')
  const [answer, setAnswer] = useState('')
  const [chatHistory, setChatHistory] = useState<ChatMessage[] | null>(null)
  const [chatBusy, setChatBusy] = useState(false)
  const [counterofferDraft, setCounterofferDraft] = useState('')
  const [rejectionDraft, setRejectionDraft] = useState('')
  const [rejectionSending, setRejectionSending] = useState(false)
  const [rejectionSent, setRejectionSent] = useState(false)
  const [recipientEmail, setRecipientEmail] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const noticeTimer = useRef<number | undefined>(undefined)
  const draftRef = useRef<HTMLElement | null>(null)
  const [activePage, setActivePage] = useState<Page>('overview')
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
  const [greeting, setGreeting] = useState('')
  const [panelOpen, setPanelOpen] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(224)
  const [agentWidth, setAgentWidth] = useState(300)
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const agentDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [allRequests, setAllRequests] = useState<RequestAllSummary[]>([])
  const [allReqState, setAllReqState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [allQuery, setAllQuery] = useState('')
  const [allStatusFilter, setAllStatusFilter] = useState<string[]>([])
  const [allFilterOpen, setAllFilterOpen] = useState(false)
  const [allPage, setAllPage] = useState(1)
  const [allPageSize, setAllPageSize] = useState(10)
  const [selectedAllId, setSelectedAllId] = useState<string | null>(null)
  const [allDetail, setAllDetail] = useState<RequestDetail | null>(null)
  const [allDetailLoading, setAllDetailLoading] = useState(false)

  function flash(msg: string) {
    setNotice(msg)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3500)
  }

  // initial load: queue (polled every 60s) + audit log
  useEffect(() => {
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

  // greeting + today date
  useEffect(() => {
    const hr = new Date().getHours()
    setGreeting(hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening')
    setToday(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase())
  }, [])

  // load overview summary data whenever queue or audit changes
  useEffect(() => {
    if (listState !== 'ready') return
    let alive = true
    setSummaryState((st) => (summary ? st : 'loading'))
    api.executiveSummary(summaryTick > 0).then((d) => { if (alive) { setSummary(d); setSummaryState('ready'); setSummaryError('') } }).catch((e) => { if (alive) { setSummaryState('error'); setSummaryError(errMsg(e)) } })
    setComparisonState((st) => (comparison ? st : 'loading'))
    api.strategyComparison(summaryTick > 0).then((d) => { if (alive) { setComparison(d); setComparisonState('ready'); setComparisonError('') } }).catch((e) => { if (alive) { setComparisonState('error'); setComparisonError(errMsg(e)) } })
    setOppState((st) => (oppData ? st : 'loading'))
    api.opportunities(summaryTick > 0).then((d) => { if (alive) { setOppData(d); setOppState('ready'); setOppError('') } }).catch((e) => { if (alive) { setOppState('error'); setOppError(errMsg(e)) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listState, requests, audit.length, summaryTick])

  // selecting a request: detail + score
  useEffect(() => {
    if (!selectedId) return
    let alive = true
    setDetail(null); setScore(null); setScenario(null); setScoreError(''); setScoring(true)
    setDecision(null); setAnswer(''); setCounterofferDraft(''); setRejectionDraft(''); setChatHistory(null)
    setEmailSent(false); setRejectionSent(false)
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

  // clear chat context when leaving requests page
  useEffect(() => {
    if (activePage !== 'requests') { setChatHistory(null); setAnswer('') }
  }, [activePage])

  // auto-generate "Why this recommendation?" as a chat message when score first loads for a request
  useEffect(() => {
    if (!score || !selectedId || chatHistory !== null || chatBusy) return
    const dow = detail?.dow_travel != null ? (['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][detail.dow_travel] ?? `day ${detail.dow_travel}`) : null
    const lf = detail?.load_factor != null ? `${Math.round(detail.load_factor * 100)}%` : 'unknown'
    const topDrivers = (score.drivers ?? []).slice(0, 3).map((d) => `${featureLabel(d.feature)}: ${d.shap_value > 0 ? '+' : ''}${d.shap_value.toFixed(3)}`).join('; ')
    const prompt = `[Request ID: ${selectedId}] Group booking: ${selected?.ond ?? ''} · ${pax} pax · ${aed(score.best_fare)}/pax · ${score.best_seats} seats. AI recommends: ${score.recommendation}. P(convert) = ${pct(score.p_convert_at_best)}, expected contribution = ${aed(score.expected_contribution)}, displacement cost = ${aed(score.displacement_cost)}, load factor = ${lf}${dow ? `, travel day = ${dow}` : ''}. Top SHAP drivers: ${topDrivers}. As a revenue management analyst, give a 2–3 sentence plain-English explanation of why the AI made this recommendation, referencing the specific numbers above. Mention any notable booking pattern or risk factor (e.g. load, day of week, agent history, fare ratio).`
    setChatBusy(true)
    api.chat(prompt, null).then((r) => { setChatHistory(r.history); setChatBusy(false) }).catch(() => setChatBusy(false))
  }, [score, selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // load all requests when navigating to that page
  useEffect(() => {
    if (activePage !== 'all-requests' || allReqState !== 'idle') return
    setAllReqState('loading')
    api.listAllRequests().then((r) => { setAllRequests(r.requests); setAllReqState('ready') }).catch(() => setAllReqState('error'))
  }, [activePage, allReqState])

  // reset to first page whenever the result set changes
  useEffect(() => { setPage(1) }, [query, statusFilter, pageSize])
  useEffect(() => { setAllPage(1) }, [allQuery, allStatusFilter, allPageSize])

  // load detail for selected all-requests row
  useEffect(() => {
    if (!selectedAllId) return
    let alive = true
    setAllDetail(null); setAllDetailLoading(true)
    api.getRequest(selectedAllId)
      .then((d) => { if (alive) { setAllDetail(d); setAllDetailLoading(false) } })
      .catch(() => { if (alive) setAllDetailLoading(false) })
    return () => { alive = false }
  }, [selectedAllId])
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
  const statusCounts = useMemo(() => requests.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {}), [requests])
  const statuses = useMemo(() => Object.keys(statusCounts).sort(), [statusCounts])
  const filtered = useMemo(() => requests.filter((r) =>
    (statusFilter.length === 0 || statusFilter.includes(r.status)) &&
    `${r.ond} ${r.request_id} ${r.group_request_id} ${r.flight_number}`.toLowerCase().includes(query.toLowerCase())
  ), [requests, query, statusFilter])
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const toggleStatus = (st: string) => setStatusFilter((cur) => cur.includes(st) ? cur.filter((x) => x !== st) : [...cur, st])
  const hasFilters = !!(statusFilter.length || query)
  const clearFilters = () => { setStatusFilter([]); setQuery('') }

  const allStatusCounts = useMemo(() => allRequests.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {}), [allRequests])
  const allStatuses = useMemo(() => Object.keys(allStatusCounts).sort(), [allStatusCounts])
  const allFiltered = useMemo(() => allRequests.filter((r) =>
    (allStatusFilter.length === 0 || allStatusFilter.includes(r.status)) &&
    `${r.ond} ${r.request_id} ${r.group_request_id}`.toLowerCase().includes(allQuery.toLowerCase())
  ), [allRequests, allQuery, allStatusFilter])
  const allTotalPages = Math.max(1, Math.ceil(allFiltered.length / allPageSize))
  const allSafePage = Math.min(allPage, allTotalPages)
  const allPageRows = allFiltered.slice((allSafePage - 1) * allPageSize, allSafePage * allPageSize)
  const toggleAllStatus = (st: string) => setAllStatusFilter((cur) => cur.includes(st) ? cur.filter((x) => x !== st) : [...cur, st])
  const hasAllFilters = !!(allStatusFilter.length || allQuery)
  const clearAllFilters = () => { setAllStatusFilter([]); setAllQuery('') }
  const pConvertClass = (p: number | undefined) => { if (p == null) return ''; if (p >= 0.15) return 'prob-high'; if (p >= 0.04) return 'prob-mid'; return 'prob-low' }

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
  const heatFaresAll = [...new Set(heat.map((c) => c.fare))].sort((a, b) => a - b)
  // Show every 2nd fare column → 6 clean columns at ~10% intervals (70,80,90,100,110,120%)
  const heatFares = heatFaresAll.filter((_, i) => i % 2 === 0)
  const heatSeats = [...new Set(heat.map((c) => c.seats))].sort((a, b) => b - a)
  const heatMin = Math.min(0, ...heat.map((c) => c.expected_contribution))
  const heatMax = Math.max(1, ...heat.map((c) => c.expected_contribution))
  const heatColor = (v: number) => v > 0 ? `rgba(31,157,99,${0.15 + 0.75 * (v / heatMax)})` : v < 0 ? `rgba(208,68,62,${0.15 + 0.6 * (Math.abs(v) / (Math.abs(heatMin) || 1))})` : '#f0f2f1'

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
      if (act === 'reject') draftRejectionEmail()
    } catch (e) { flash(errMsg(e)) } finally { setBusy(false) }
  }

  async function draftRejectionEmail() {
    if (!selectedId || !score) return
    const lf = detail?.load_factor != null ? `${Math.round(detail.load_factor * 100)}%` : 'unknown'
    const topDrivers = (score.drivers ?? []).slice(0, 3).map((d) => `${featureLabel(d.feature)}: ${d.shap_value > 0 ? '+' : ''}${d.shap_value.toFixed(3)}`).join('; ')
    const agentName = detail?.agent_code ?? 'Agent'
    const prompt = `Draft a professional rejection email from Air Arabia Group Desk to ${agentName} for request ${selectedId} (${selected?.ond ?? ''}, ${pax} pax, departure ${fmtDate(selected?.departure_dt ?? null)}).

Rejection details:
- Quoted fare: ${aed(selected?.quoted_fare_per_pax ?? 0)}/pax vs reference fare ${aed(refFare)}/pax (fare ratio: ${detail?.fare_ratio != null ? `${(detail.fare_ratio*100).toFixed(0)}%` : 'unknown'} of market rate)
- Load factor on requested flight: ${lf}
- AI recommendation was: ${score.recommendation}
- Key factors: ${topDrivers}
- Minimum viable fare for this route/date: ${aed(score.best_fare)}/pax

Write a 3–4 paragraph email that:
1. Politely declines the request with a clear reason (e.g. fare below commercial threshold, high load factor displacing higher-value demand)
2. Gives a specific, actionable suggestion (e.g. resubmit at ${aed(score.best_fare)}/pax, consider a different departure date, reduce group size to ${score.best_seats} seats)
3. Keeps the door open for future business
Use professional airline tone. Subject line on first line as "Subject: ..."`
    try {
      const r = await api.chat(prompt, null)
      const msg = r.history.find((m) => m.role === 'assistant')
      if (msg) setRejectionDraft(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))
    } catch { /* silent — draft is optional */ }
  }

  async function sendRejectionEmail() {
    if (!selectedId || !rejectionDraft || rejectionSending) return
    const toEmail = recipientEmail || detail?.agent_email || ''
    if (!toEmail) { flash('Enter recipient email to send'); return }
    setRejectionSending(true)
    try {
      const subject = `Group booking update — ${selected?.ond ?? selectedId}`
      await api.sendCounteroffer(selectedId, { to_email: toEmail, subject, body: rejectionDraft })
      setRejectionSent(true)
      flash(`Rejection email sent to ${toEmail}`)
    } catch (e) { flash(errMsg(e)) } finally { setRejectionSending(false) }
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

  const isRequestContext = activePage === 'requests' && !!selectedId

  async function ask(message: string) {
    if (!message.trim() || chatBusy) return
    setChatBusy(true); setAnswer('Thinking…')
    try {
      const payload = isRequestContext ? `[Request ID: ${selectedId}] ${message}` : message
      const r = await api.chat(payload, chatHistory)
      setAnswer(r.response); setChatHistory(r.history)
    } catch (e) { setAnswer(''); flash(errMsg(e)) } finally { setChatBusy(false) }
  }

  const recColor = score ? REC_COLORS[score.recommendation] : undefined

  function getWhyExplanation(s: typeof score, d: typeof detail): string {
    if (!s) return ''
    const rec = s.recommendation
    const p = s.p_convert_at_best
    const pStr = `${(p * 100).toFixed(1)}%`
    const fareRatio = d?.fare_ratio ?? null
    const lf = d?.load_factor ?? null
    const lfStr = lf != null ? `${Math.round(lf * 100)}%` : null
    if (rec === 'Accept') {
      if (p >= 0.5) return `Conversion probability is high at ${pStr} — well above our acceptance threshold. The expected contribution of ${aed(s.expected_contribution)} is positive and risk of displacement is ${s.displacement_cost > 0 ? `AED ${Math.round(s.displacement_cost).toLocaleString()}` : 'nil'}.`
      if (p >= 0.3) return `Decent conversion probability (${pStr}) with the agent quoting at or below the reference fare${fareRatio != null ? ` (${Math.round(fareRatio * 100)}% of ref)` : ''}. Expected contribution of ${aed(s.expected_contribution)} makes this a worthwhile deal.`
      if (fareRatio != null && fareRatio <= 0.85) return `Agent is offering a ${Math.round((1 - fareRatio) * 100)}% discount off the reference fare. Even at a moderate P(convert) of ${pStr}, the expected contribution (${aed(s.expected_contribution)}) is positive${lfStr && lf! < 0.7 ? ` and the flight is only ${lfStr} full — displacement risk is low` : ''}.`
      return `Expected contribution (${aed(s.expected_contribution)}) is positive and conversion probability (${pStr}) meets our acceptance threshold. ${s.lift_vs_baseline > 0 ? `AI pricing adds ${aed(s.lift_vs_baseline)} over the rule-based baseline.` : ''}`
    }
    if (rec === 'Counteroffer') {
      if (p < 0.1) return `Conversion probability is very low at ${pStr} at the agent's quoted fare. A revised offer at ${aed(s.best_fare)}/pax could significantly improve the chance of conversion${s.displacement_cost > 0 ? ` while accounting for a displacement cost of ${aed(s.displacement_cost)}` : ''}.`
      return `The agent's quoted fare produces suboptimal expected contribution. Countering at ${aed(s.best_fare)}/pax (P(convert) ${pStr}) maximises our expected return${lfStr ? ` on a ${lfStr} load-factor flight` : ''}.`
    }
    if (rec === 'Partial') {
      return `Only ${s.best_seats} of the ${pax} requested seats can be offered. ${lfStr ? `The flight is already ${lfStr} full — ` : ''}blocking more seats would displace too much expected individual demand (displacement cost ${aed(s.displacement_cost)}). A partial allocation at ${aed(s.best_fare)}/pax still generates ${aed(s.expected_contribution)}.`
    }
    if (rec === 'Reject') {
      if (s.expected_contribution <= 0) return `Expected contribution is negative (${aed(s.expected_contribution)}) — accepting this group would cost more than it earns after accounting for displaced individual bookings. Rejecting preserves capacity for higher-value demand.`
      return `Conversion probability (${pStr}) is below our minimum threshold. The probability-weighted expected contribution does not justify blocking ${pax} seats${lfStr ? ` on a ${lfStr} load-factor flight` : ''}.`
    }
    return `P(convert) = ${pStr} · Expected contribution = ${aed(s.expected_contribution)}.`
  }

  function onSidebarDragStart(e: React.MouseEvent) {
    e.preventDefault()
    sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragRef.current) return
      const delta = ev.clientX - sidebarDragRef.current.startX
      const next = Math.max(48, Math.min(400, sidebarDragRef.current.startWidth + delta))
      setSidebarWidth(next)
      setSidebarCollapsed(next < 100)
    }
    const onUp = () => {
      sidebarDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function onAgentDragStart(e: React.MouseEvent) {
    e.preventDefault()
    agentDragRef.current = { startX: e.clientX, startWidth: agentWidth }
    const onMove = (ev: MouseEvent) => {
      if (!agentDragRef.current) return
      const delta = agentDragRef.current.startX - ev.clientX
      const next = Math.max(40, Math.min(560, agentDragRef.current.startWidth + delta))
      setAgentWidth(next)
      setPanelOpen(next > 80)
    }
    const onUp = () => {
      agentDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Dynamic context-aware suggestions based on actual request data
  const suggestions = useMemo(() => {
    const s: { label: string; action: () => void }[] = []
    if (!isRequestContext || !score || !selected) {
      return [
        { label: 'What factors drive group booking conversion?', action: () => ask('What factors most influence whether a group booking agent converts a quote?') },
        { label: 'How does displacement cost work?', action: () => ask('Explain displacement cost and how it affects group booking decisions.') },
        { label: 'What is a good P(convert) for a group request?', action: () => ask('What P(convert) threshold should we use to decide whether to accept, counteroffer or reject a group request?') },
        { label: 'How does the AI recommendation differ from baseline?', action: () => ask('How does the AI optimizer recommendation differ from the rule-based baseline approach?') },
      ]
    }
    // 1. Recommendation-specific
    if (score.recommendation === 'Accept')
      s.push({ label: `Why accept at ${aed(score.best_fare)}/pax?`, action: () => ask(`Why are we recommending to accept this group at ${aed(score.best_fare)} per passenger?`) })
    else if (score.recommendation === 'Counteroffer')
      s.push({ label: `Why counter at ${aed(score.best_fare)} instead of accepting?`, action: () => ask(`Why should we counteroffer at ${aed(score.best_fare)} rather than accepting the agent's quoted fare?`) })
    else if (score.recommendation === 'Reject')
      s.push({ label: 'Why are we rejecting this request?', action: () => ask('Why is the AI recommending rejection for this group request? What would need to change to make it viable?') })
    else if (score.recommendation === 'Partial')
      s.push({ label: `Why only ${score.best_seats} of ${pax} seats?`, action: () => ask(`Why can we only offer ${score.best_seats} seats when the agent requested ${pax}?`) })
    // 2. Load factor / displacement
    if (detail?.load_factor && detail.load_factor > 0.75)
      s.push({ label: `Flight is ${Math.round(detail.load_factor * 100)}% full — displacement risk?`, action: () => ask(`The flight is at ${Math.round(detail.load_factor! * 100)}% load factor. What is the displacement risk of blocking seats for this group?`) })
    else if (score.displacement_cost === 0)
      s.push({ label: 'No displacement cost — safe to accept?', action: () => ask('The displacement cost is zero. Does this mean there is no risk to accepting this group?') })
    // 3. Conversion probability
    if (score.p_convert_at_best < 0.08)
      s.push({ label: `Only ${pct(score.p_convert_at_best)} conversion — what can improve it?`, action: () => ask(`The conversion probability is very low at ${pct(score.p_convert_at_best)}. What factors are driving this down and what could improve it?`) })
    else if (score.p_convert_at_best > 0.35)
      s.push({ label: `${pct(score.p_convert_at_best)} conversion — is this a priority deal?`, action: () => ask(`Conversion probability is high at ${pct(score.p_convert_at_best)}. Should we fast-track this request and what terms should we prioritise?`) })
    // 4. Fare vs reference
    if (detail?.fare_ratio && detail.fare_ratio < 0.85)
      s.push({ label: `Agent quoting ${Math.round(detail.fare_ratio * 100)}% of ref — good deal?`, action: () => ask(`The agent is quoting at only ${Math.round(detail.fare_ratio! * 100)}% of the reference fare. Is this a good deal for us?`) })
    // 5. Lift vs baseline
    if (score.lift_vs_baseline > 500)
      s.push({ label: `AI adds ${aed(score.lift_vs_baseline)} over baseline — how?`, action: () => ask(`The AI recommendation generates ${aed(score.lift_vs_baseline)} more than the rule-based baseline. How is it achieving this?`) })
    // 6. Always offer counteroffer
    s.push({ label: 'Draft a counteroffer email', action: draftCounteroffer })
    return s.slice(0, 4)
  }, [score, selected, detail, pax])

  return <main className={`app-shell${sidebarCollapsed ? ' sidebar-is-collapsed' : ''}`}>
    <aside className={`sidebar${sidebarCollapsed ? ' sidebar-collapsed' : ''}`} style={{ width: sidebarCollapsed ? 60 : sidebarWidth }}>
      <div className="sidebar-drag-handle" onMouseDown={onSidebarDragStart} title="Drag to resize"/>
      <a className="brand" href="#dashboard" aria-label="GroupLens home"><span className="brand-mark"><Plane size={18} strokeWidth={2.2}/></span>{!sidebarCollapsed && <span>GroupLens<span className="brand-sub">GROUP BOOKING AI</span></span>}</a>
      {!sidebarCollapsed && <div className="workspace-label">WORKSPACE <ChevronDown size={13}/></div>}
      <nav aria-label="Main navigation">
        <button type="button" className={`nav-item ${activePage === 'overview' ? 'active' : ''}`} onClick={() => setActivePage('overview')} title="Overview"><LayoutDashboard size={17}/>{!sidebarCollapsed && <> Overview</>}</button>
        <button type="button" className={`nav-item ${activePage === 'requests' ? 'active' : ''}`} onClick={() => setActivePage('requests')} title="Open requests"><FileText size={17}/>{!sidebarCollapsed && <> Open requests <span className="nav-count">{total}</span></>}{sidebarCollapsed && total > 0 && <span className="nav-count-dot"/>}</button>
        <button type="button" className={`nav-item ${activePage === 'all-requests' ? 'active' : ''}`} onClick={() => { setActivePage('all-requests'); setAllReqState((s) => s === 'error' ? 'idle' : s) }} title="All requests"><List size={17}/>{!sidebarCollapsed && <> All requests</>}</button>
        <button type="button" className={`nav-item ${activePage === 'audit' ? 'active' : ''}`} onClick={() => setActivePage('audit')} title="Decision log"><History size={17}/>{!sidebarCollapsed && <> Decision log</>}</button>
      </nav>
      <div className="sidebar-bottom">
        <button type="button" className="sidebar-collapse-btn" onClick={() => { const c = !sidebarCollapsed; setSidebarCollapsed(c); if (!c && sidebarWidth < 100) setSidebarWidth(224) }} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{sidebarCollapsed ? <ChevronRight size={15}/> : <ChevronLeft size={15}/>}</button>
        {!sidebarCollapsed && <div className="profile"><div className="avatar dark">RM</div><div><b>Revenue Manager</b><span>Group desk</span></div><ChevronDown size={15}/></div>}
      </div>
    </aside>

    <section className="main-content" id="dashboard">
      <header className="topbar"><div className="breadcrumb">Revenue management <span>/</span> <b>{PAGE_LABELS[activePage]}</b></div><div className="top-actions"><span className={`api-status ${listState === 'error' ? 'error' : ''}`}><span className="live-dot"/> {listState === 'error' ? 'API unreachable' : 'Live'}</span></div></header>
      <div className="page-content">
        {listState === 'error' && <div className="empty-state" role="alert">Cannot connect to server — {listError}. Check that the API is running and NEXT_PUBLIC_API_BASE_URL is correct.</div>}

        {/* ── OVERVIEW PAGE ─────────────────────────────────────────── */}
        {activePage === 'overview' && <><div className="heading-row"><div><div className="eyebrow">{today}</div><h1>{greeting} <span className="wave">✳</span></h1><p className="subheading">Here&apos;s your group booking performance at a glance.</p></div></div>
        <ExecutiveSummaryPanel data={summary} state={summaryState} error={summaryError} onRetry={() => setSummaryTick((n) => n + 1)}/>
        <OpportunitiesPanel data={oppData} state={oppState} error={oppError} onRetry={() => setSummaryTick((n) => n + 1)} onOpen={(id) => { setSelectedId(id); setQueueCollapsed(true); setActivePage('requests') }} onViewAll={() => setActivePage('requests')}/>
        <StrategyComparisonPanel data={comparison} state={comparisonState} error={comparisonError} onRetry={() => setSummaryTick((n) => n + 1)}/>
        </>}

        {/* ── OPEN REQUESTS PAGE ────────────────────────────────────── */}
        {activePage === 'requests' && <>

        {/* Queue panel — full width, collapses when a request is opened */}
        {!queueCollapsed && <section className="panel queue-panel" style={{marginBottom:14}}>
          <div className="panel-head">
            <div><div className="panel-title">Requests to review <span className="count-badge">{filtered.length === requests.length ? total : `${filtered.length} of ${requests.length}`}</span></div><div className="panel-caption">Open group requests</div></div>
            <div style={{display:'flex',gap:7,alignItems:'center'}}>
              <button type="button" className={`subtle-button filter-toggle ${statusFilter.length ? 'active' : ''}`} aria-expanded={filterOpen} onClick={() => setFilterOpen((o) => !o)}><Filter size={13}/> Filter{statusFilter.length > 0 && <span className="filter-badge">{statusFilter.length}</span>}</button>
              {hasFilters && <button type="button" className="filter-clear" onClick={clearFilters}>Clear</button>}
            </div>
          </div>
          {(filterOpen || statusFilter.length > 0) && <div className="filter-bar" role="group" aria-label="Filter by status">
            <span className="filter-label">STATUS</span>
            {statuses.map((st) => <button type="button" key={st} className={`filter-chip ${statusFilter.includes(st) ? 'on' : ''}`} aria-pressed={statusFilter.includes(st)} onClick={() => toggleStatus(st)}>{st} <i>{statusCounts[st]}</i></button>)}
            {statusFilter.length > 0 && <button type="button" className="filter-clear" onClick={() => setStatusFilter([])}>Clear</button>}
          </div>}
          <label className="search-box"><Search size={13}/><input ref={searchRef} aria-label="Search requests" placeholder="Search requests…" value={query} onChange={(e) => setQuery(e.target.value)}/><kbd>Ctrl K</kbd></label>
          <div className="prob-legend"><span className="prob-dot prob-high"/>High (&ge;15%)<span className="prob-dot prob-mid"/>Mid (4–15%)<span className="prob-dot prob-low"/>Low (&lt;4%)<span className="prob-dot prob-none"/>Not scored</div>
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
                  <span className={`status ${r.status.toLowerCase()}`}>{r.status}</span>
                  <span className="request-date"><Clock3 size={12}/>{daysLeft(r.departure_dt) ?? '—'}d left</span>
                  {p != null && <span className={`prob-badge ${pConvertClass(p)}`}>{pct(p)}</span>}
                </span>
              </button>
            })}
            {listState === 'loading' && Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton-row" aria-hidden="true"/>)}
            {listState === 'ready' && filtered.length === 0 && <div className="empty-state">No requests match{statusFilter.length ? ` ${statusFilter.join(' / ')}` : ''}{query ? ` "${query}"` : ''}. <button type="button" className="filter-clear" onClick={clearFilters}>Clear filters</button></div>}
          </div>
          {filtered.length > 0 && <nav className="pagination" aria-label="Requests pagination"><span className="page-info">{(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}</span><div className="page-controls"><button type="button" className="page-btn" aria-label="Previous page" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>&#8249;</button>{pageList(safePage, totalPages).map((n, i) => n === '…' ? <span key={`e${i}`} className="page-gap">…</span> : <button type="button" key={n} className={`page-btn ${n === safePage ? 'current' : ''}`} aria-current={n === safePage ? 'page' : undefined} onClick={() => setPage(n)}>{n}</button>)}<button type="button" className="page-btn" aria-label="Next page" disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>&#8250;</button></div><label className="page-size">Rows<select aria-label="Rows per page" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label></nav>}
        </section>}

        {/* Collapsed queue bar — click to return to list */}
        {queueCollapsed && <div className="queue-collapsed-bar" style={{marginBottom:12}}>
          <button type="button" className="subtle-button" onClick={() => setQueueCollapsed(false)}><ChevronLeft size={13}/> Back to requests</button>
          <span className="queue-collapsed-info">{filtered.length} request{filtered.length !== 1 ? 's' : ''} in queue{hasFilters && <> · <button type="button" className="filter-clear" onClick={clearFilters}>Clear filters</button></>}</span>
        </div>}

        {/* Request detail card — shown when queue collapsed */}
        {queueCollapsed && selectedId && selected && <section className="panel request-detail-card" style={{marginBottom:14}}>
          <div className="panel-head">
            <div>
              <div className="panel-title">{route(selected.ond)} <span className="request-id" style={{marginLeft:8}}>{selected.request_id}</span></div>
              <div className="panel-caption">{selected.flight_number} · Departs {fmtDate(selected.departure_dt)}{left != null ? ` · ${left}d left` : ''}</div>
            </div>
            <span className={`status ${selected.status.toLowerCase()}`}>{selected.status}</span>
          </div>
          <div className="detail-table-grid">
            <table className="detail-table">
              <tbody>
                <tr><td>Request ID</td><td><code>{selected.request_id}</code></td></tr>
                <tr><td>Group ID</td><td><code>{selected.group_request_id}</code></td></tr>
                <tr><td>Created</td><td>{fmtTs(selected.created_on)}</td></tr>
                <tr><td>Route</td><td>{route(selected.ond)}</td></tr>
                <tr><td>Flight</td><td>{selected.flight_number ?? '—'}</td></tr>
                <tr><td>Departure</td><td>{fmtDate(selected.departure_dt)}{left != null ? <span style={{marginLeft:6,color:'#ff0041',fontWeight:700}}>{left}d left</span> : ''}</td></tr>
                <tr><td>Trip type</td><td>{detail?.trip_type ?? (scoring ? '…' : '—')}</td></tr>
                <tr><td>Lead time</td><td>{detail?.lead_time != null ? `${Math.round(detail.lead_time)} days` : scoring ? '…' : '—'}</td></tr>
                <tr><td>No. of options</td><td>{detail?.num_options ?? (scoring ? '…' : '—')}</td></tr>
              </tbody>
            </table>
            <table className="detail-table">
              <tbody>
                <tr><td>Group size</td><td>{pax} pax</td></tr>
                <tr><td>Quoted fare</td><td>{aed(selected.quoted_fare_per_pax)} / pax</td></tr>
                <tr><td>Reference fare</td><td>{aed(refFare)} / pax</td></tr>
                <tr><td>Fare ratio</td><td>{detail?.fare_ratio != null ? `${(detail.fare_ratio * 100).toFixed(1)}% of ref` : scoring ? '…' : '—'}</td></tr>
                <tr><td>Competitor fare</td><td>{detail?.competitor_fare ? aed(detail.competitor_fare) : '—'}</td></tr>
                <tr><td>Load factor</td><td>{detail?.load_factor != null ? `${Math.round(detail.load_factor * 100)}%` : scoring ? '…' : '—'}</td></tr>
                <tr><td>Seats available</td><td>{detail?.seats_available ?? (scoring ? '…' : '—')}</td></tr>
                <tr><td>Agent</td><td>{detail?.agent_code ?? '—'}{detail?.agent_email ? <span style={{color:'#8a9199',marginLeft:6,fontWeight:400}}>{detail.agent_email}</span> : ''}</td></tr>
                <tr><td>Agent conv. rate</td><td>{detail ? pct(detail.agent_conv_rate) : '—'}<span style={{color:'#8a9199',marginLeft:6,fontWeight:400,fontSize:'.72rem'}}>({detail?.agent_prior_requests ?? '—'} prior requests)</span></td></tr>
                <tr><td>Route conv. rate</td><td>{detail ? pct(detail.route_conv_rate) : '—'}<span style={{color:'#8a9199',marginLeft:6,fontWeight:400,fontSize:'.72rem'}}>({detail?.route_prior_requests ?? '—'} on this route)</span></td></tr>
              </tbody>
            </table>
          </div>
          {detail?.load_factor != null && <><div style={{marginTop:10,marginBottom:3,fontSize:'.72rem',color:'#8a9199',fontWeight:600,textTransform:'uppercase',letterSpacing:'.05em'}}>Flight load</div><div className="capacity-bar"><span style={{ width: `${Math.round(detail.load_factor * 100)}%` }}/></div></>}
        </section>}

        {/* AI recommendation — full width below detail card */}
        {selectedId && queueCollapsed && <section className={`panel recommendation-panel${score ? ` rec-${score.recommendation.toLowerCase()}` : ''}`} style={{marginBottom:14}}>
          <div className="panel-head"><div><div className="panel-title">AI recommendation <span className="ai-tag"><Sparkles size={11}/> ASSIST</span></div><div className="panel-caption">{selected ? `${selected.request_id} · ${route(selected.ond)} · ${fmtDate(selected.departure_dt)}` : 'No request selected'}</div></div>
            <div style={{display:'flex',gap:6,alignItems:'center'}}>
              {scoring && <span className="scoring-badge">Scoring…</span>}
              {score && <span className={`prob-badge large ${pConvertClass(score.p_convert_at_best)}`}>{pct(score.p_convert_at_best)}</span>}
            </div>
          </div>
          {scoreError && <div className="empty-state" role="alert">{scoreError} <button className="subtle-button" onClick={() => setRetryTick((n) => n + 1)}>Retry</button></div>}
          {scoring && !score && <div className="empty-state">Scoring request…</div>}
          {score && <>
          <div className={`recommendation-banner rec-${score.recommendation.toLowerCase()}`}><div className="recommend-icon"><Sparkles size={17}/></div><div><div className="recommend-label">RECOMMENDED ACTION</div><strong>{REC_LABELS[score.recommendation] ?? score.recommendation}</strong></div><span className="confidence">{pct(score.p_convert_base)} base P(convert)</span></div>
          <div className="offer-grid"><Offer label="Proposed fare" value={aed(fare)} suffix={`/ pax · ref ${aed(refFare)}`}/><Offer label="Seat allocation" value={`${seats} of ${pax} seats`} suffix={seats < pax ? 'partial allocation' : 'full request met'}/><Offer label="Agent must confirm within" value={`${deadline} days`} suffix="of receiving this offer"/><Offer label="Conversion probability" value={pct(probability)} suffix="model estimate" highlight/></div>
          <div className="insight-breakdown">
            <div className="insight-row">
              <div className="insight-item"><span className="insight-label">Expected contribution</span><b className={`insight-value ${(contribution ?? 0) > 0 ? 'positive' : 'negative'}`}>{aed(contribution)}</b><small>if group converts</small></div>
              <div className="insight-item"><span className="insight-label">Rule-based baseline</span><b className="insight-value">{aed(score.baseline_contribution)}</b><small>historical avg for this route</small></div>
              <div className="insight-item"><span className="insight-label">Lift vs baseline</span><b className={`insight-value ${score.lift_vs_baseline >= 0 ? 'positive' : 'negative'}`}>{score.lift_vs_baseline >= 0 ? '+' : ''}{aed(score.lift_vs_baseline)}</b><small>AI vs rule-based gain</small></div>
              <div className="insight-item"><span className="insight-label">Displacement cost</span><b className={`insight-value ${score.displacement_cost > 0 ? 'negative' : ''}`}>{aed(score.displacement_cost)}</b><small>{score.displacement_cost > 0 ? 'demand displaced' : 'no demand displaced'}</small></div>
            </div>
          </div>
          {/* Why this recommendation — inline explanation from Claude */}
          {(() => {
            const whyMsg = chatHistory?.find((m) => m.role === 'assistant')
            const whyText = whyMsg ? (typeof whyMsg.content === 'string' ? whyMsg.content : null) : null
            return whyText ? (
              <div className="rec-why-box">
                <span className="rec-why-label"><Sparkles size={11}/> Why this recommendation</span>
                <p>{whyText}</p>
              </div>
            ) : chatBusy ? (
              <div className="rec-why-box rec-why-loading">
                <span className="rec-why-label"><Sparkles size={11}/> Analysing…</span>
              </div>
            ) : null
          })()}
          <div className="button-row"><button disabled={busy} className={`action-btn approve-btn ${decision && decision !== 'reject' ? 'is-approved' : ''}`} onClick={() => decide('approve')}><Check size={14}/> {decision && decision !== 'reject' ? 'Recorded' : offerChanged ? 'Approve Edit' : 'Approve'}</button><button disabled={busy} className="action-btn reject-btn" onClick={() => decide('reject')}><X size={14}/> {decision === 'reject' ? 'Rejected' : 'Reject'}</button><button className="action-btn counter-btn" onClick={draftCounteroffer}><FileText size={14}/> Counteroffer</button></div>
          </>}
        </section>}

        {/* Analysis panels */}
        {selectedId && queueCollapsed && <>
        <div className="analysis-grid">
          <section className="panel analysis-panel"><div className="panel-head"><div><div className="panel-title">Scenario analysis</div><div className="panel-caption">Adjust the offer to explore the trade-off</div></div><span className="model-tag"><span className="live-dot"/> MODEL-BASED</span></div>
            {score ? <>
            <div className="scenario-controls"><label>Confirmation deadline<select className="deadline-select" value={deadline} onChange={(e) => setDeadline(Number(e.target.value))}>{DEADLINES.map((d) => <option key={d} value={d}>{d} days — agent must confirm within {d} days of receiving offer</option>)}</select></label><label>Fare per passenger <strong>{aed(fare)}</strong><input aria-label="Fare per passenger" type="range" min={Math.round(fareMin)} max={Math.round(fareMax)} step="5" value={fare} onChange={(e) => setFare(Number(e.target.value))}/><span className="range-labels"><span>70% · {aed(fareMin)}</span><span>120% · {aed(fareMax)}</span></span></label><label>Seats to allocate <strong>{seats} seats</strong><input aria-label="Seats to allocate" type="range" min="1" max={Math.max(1, pax, score.best_seats)} step="1" value={seats} onChange={(e) => setSeats(Number(e.target.value))}/><span className="range-labels"><span>1 seat</span><span>{Math.max(pax, score.best_seats)} max</span></span></label></div>
            {scenario && <div className="scenario-result-row">
              <div className="scenario-result-item"><span>Group revenue</span><b className="positive">{aed(scenario.group_revenue)}</b></div>
              <div className="scenario-result-item"><span>Displacement cost</span><b className={scenario.displacement_cost > 0 ? 'negative' : ''}>{aed(scenario.displacement_cost)}</b></div>
              <div className="scenario-result-item"><span>P(convert)</span><b>{pct(scenario.p_convert)}</b></div>
              <div className="scenario-result-item"><span>Expected contribution</span><b className={scenario.expected_contribution > 0 ? 'positive' : 'negative'}>{aed(scenario.expected_contribution)}</b></div>
            </div>}
            <div className="chart-wrap">
              <div className="chart-top"><span>Fare response curve</span><span className="chart-legend"><i style={{background:'#ff0041'}}/> P(convert)</span></div>
              <div className="fare-line-legend">
                <span><i className="fare-swatch" style={{background:'#b0b8bd'}}/> Ref fare {aed(refFare)}</span>
                <span><i className="fare-swatch" style={{background:'#00b26e'}}/> AI best {aed(score.best_fare)}</span>
                <span><i className="fare-swatch" style={{background:'#e39c4e',borderStyle:'dashed'}}/> Selected {aed(fare)}</span>
              </div>
              <div className="curve-chart"><div className="y-labels">{yTicks.map((t) => <span key={t}>{t}</span>)}</div><div className="chart-plot"><div className="grid-line one"/><div className="grid-line two"/><div className="grid-line three"/><svg viewBox="0 0 500 160" preserveAspectRatio="none" role="img" aria-label="Conversion probability versus fare"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#ff0041" stopOpacity=".2"/><stop offset="100%" stopColor="#ff0041" stopOpacity="0"/></linearGradient></defs>{linePath && <><path d={`${linePath} L500,160 L0,160Z`} fill="url(#fill)"/><path d={linePath} fill="none" stroke="#ff0041" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/></>}<line x1={`${xPct(refFare)}%`} y1="0" x2={`${xPct(refFare)}%`} y2="100%" stroke="#b0b8bd" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/><line x1={`${xPct(score.best_fare)}%`} y1="0" x2={`${xPct(score.best_fare)}%`} y2="100%" stroke="#00b26e" strokeWidth="2" vectorEffect="non-scaling-stroke"/><line x1={`${xPct(fare)}%`} y1="0" x2={`${xPct(fare)}%`} y2="100%" stroke="#e39c4e" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"/></svg><div className="x-labels"><span>{Math.round(fareMin)} AED</span><span style={{color:'#00b26e',fontWeight:700}}>best {Math.round(score.best_fare)}</span><span>{Math.round(fareMax)} AED</span></div></div></div>
            </div>
            </> : <div className="empty-state">{scoring ? 'Waiting for score…' : 'Select a request'}</div>}
          </section>
          <section className="panel drivers-panel"><div className="panel-head"><div><div className="panel-title">What drives this decision?</div><div className="panel-caption">Why did the AI give this conversion probability?</div></div></div>
            {drivers.map((d) => <Driver key={d.feature} label={featureLabel(d.feature)} detail={d.shap_value >= 0 ? '↑ raises conversion' : '↓ lowers conversion'} value={`${d.shap_value >= 0 ? '+' : ''}${d.shap_value.toFixed(3)}`} positive={d.shap_value >= 0} negative={d.shap_value < 0} width={`${Math.max(4, (Math.abs(d.shap_value) / maxShap) * 100)}%`}/>)}
            {!drivers.length && <div className="empty-state">{scoring ? 'Waiting for score…' : 'No drivers yet'}</div>}
            <div className="confidence-note"><ShieldCheck size={15}/><span><b>How to read this:</b> each bar shows how much a factor pushes conversion probability up (green) or down (red). Longer bar = bigger impact.</span></div>
          </section>
        </div>
        <div className="bottom-grid">
          <section className="panel inventory-panel"><div className="panel-head"><div><div className="panel-title">Flight inventory</div><div className="panel-caption">{selected ? `${route(selected.ond)} · ${fmtDate(selected.departure_dt)} · ${selected.flight_number}` : '—'}</div></div></div><div className="inventory-stats"><div><span>Seats available</span><b>{detail?.seats_available ?? '—'}</b></div><div><span>Load factor</span><b>{detail?.load_factor != null ? `${Math.round(detail.load_factor * 100)}%` : '—'}</b></div><div><span>Departure</span><b>{fmtTime(selected?.departure_dt ?? null)} <small>{left != null ? `· ${left}d` : ''}</small></b></div><div><span>Reference fare</span><b>{aed(refFare)}</b></div></div>
            {detail?.load_factor != null && <div className="capacity-bar"><span style={{ width: `${Math.round(detail.load_factor * 100)}%` }}/></div>}
            <div className="classes"><span>Agent</span><b>{detail?.agent_code ?? '—'}</b><b>conv. <i>{detail ? pct(detail.agent_conv_rate) : '—'}</i></b><b>route conv. <i>{detail ? pct(detail.route_conv_rate) : '—'}</i></b></div></section>
          <section className="panel trend-panel"><div className="panel-head"><div><div className="panel-title">Fare × seats heat map</div><div className="panel-caption">Expected contribution — greener = more profitable · deadline {heatDeadline} days</div></div><select aria-label="Heat map deadline" className="subtle-button" value={heatDeadline} onChange={(e) => setHeatDeadline(Number(e.target.value))}>{DEADLINES.map((d) => <option key={d} value={d}>{d} days</option>)}</select></div>
            {heat.length ? <>
              <div className="heat-col-labels" style={{ gridTemplateColumns: `80px repeat(${heatFares.length}, 1fr)` }}>
                <span className="heat-col-corner">Seats ↓ · Fare →</span>
                {heatFares.map((f) => <span key={f} className="heat-col-header">
                  <b>{Math.round(f / refFare * 100)}%</b>
                  <small>{Math.round(f).toLocaleString()}</small>
                </span>)}
              </div>
              <div className="heat-grid" style={{ gridTemplateColumns: `80px repeat(${heatFares.length}, 1fr)` }}>
                {heatSeats.map((s) => <HeatRow key={s} seats={s} fares={heatFares} heat={heat} color={heatColor} bestFare={score?.best_fare ?? 0} bestSeats={score?.best_seats ?? 0} refFare={refFare}/>)}
              </div>
              <div className="heat-legend"><span className="heat-legend-label">Unprofitable</span><div className="heat-legend-bar"/><span className="heat-legend-label">Most profitable</span></div>
              <div className="heat-axis-label">Fare as % of reference fare (ref = {aed(refFare)}/pax)</div>
            </> : <div className="empty-state">{scoring ? 'Waiting for score…' : 'No data'}</div>}</section>
        </div>

        {/* ── FARE COMPARISON CHART ─────────────────────────────────── */}
        {score && <FareCompareChart quotedFare={detail?.quoted_fare_per_pax ?? selected?.quoted_fare_per_pax ?? 0} aiBestFare={score.best_fare} refFare={refFare} competitorFare={detail?.competitor_fare ?? selected?.competitor_fare ?? 0}/>}
        </>}
        </>}

        {/* ── ALL REQUESTS PAGE ─────────────────────────────────────── */}
        {activePage === 'all-requests' && <>
        <section className="panel queue-panel" style={{margin:'0 0 14px'}}>
          <div className="panel-head">
            <div><div className="panel-title">All requests <span className="count-badge">{allFiltered.length === allRequests.length ? allRequests.length : `${allFiltered.length} of ${allRequests.length}`}</span></div><div className="panel-caption">Complete history including closed and converted</div></div>
            <div style={{display:'flex',gap:7,alignItems:'center'}}>
              {allReqState === 'error' && <button className="subtle-button" onClick={() => setAllReqState('idle')}>Retry</button>}
              <button type="button" className={`subtle-button filter-toggle ${allStatusFilter.length ? 'active' : ''}`} aria-expanded={allFilterOpen} onClick={() => setAllFilterOpen((o) => !o)}><Filter size={13}/> Filter{allStatusFilter.length > 0 && <span className="filter-badge">{allStatusFilter.length}</span>}</button>
              {hasAllFilters && <button type="button" className="filter-clear" onClick={clearAllFilters}>Clear</button>}
            </div>
          </div>
          {(allFilterOpen || allStatusFilter.length > 0) && <div className="filter-bar" role="group" aria-label="Filter by status">
            <span className="filter-label">STATUS</span>
            {allStatuses.map((st) => <button type="button" key={st} className={`filter-chip ${allStatusFilter.includes(st) ? 'on' : ''}`} aria-pressed={allStatusFilter.includes(st)} onClick={() => toggleAllStatus(st)}>{st} <i>{allStatusCounts[st]}</i></button>)}
            {allStatusFilter.length > 0 && <button type="button" className="filter-clear" onClick={() => setAllStatusFilter([])}>Clear</button>}
          </div>}
          <label className="search-box"><Search size={13}/><input aria-label="Search all requests" placeholder="Search by route, request ID or group ID…" value={allQuery} onChange={(e) => setAllQuery(e.target.value)}/></label>
          <div className="request-list">
            {allReqState === 'loading' && Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton-row" aria-hidden="true"/>)}
            {allPageRows.map((r) => (
              <button key={r.request_id} className={`request-row ${selectedAllId === r.request_id ? 'selected' : ''}`} onClick={() => setSelectedAllId((id) => id === r.request_id ? null : r.request_id)}>
                <span className="request-avatar">{initials(r.ond)}</span>
                <span className="request-main">
                  <span className="request-route">{route(r.ond)}<span className="request-id">{r.request_id}</span></span>
                  <span className="request-meta">{r.group_size} pax · Created {fmtTs(r.created_on)}</span>
                </span>
                <span className="request-side">
                  <span className={`status ${r.status.toLowerCase()}`}>{r.status}</span>
                  {r.converted != null && <span className="request-date">{r.converted ? '✓ Converted' : '✗ Not converted'}</span>}
                </span>
              </button>
            ))}
            {allReqState === 'ready' && allFiltered.length === 0 && <div className="empty-state">No requests match{allStatusFilter.length ? ` ${allStatusFilter.join(' / ')}` : ''}{allQuery ? ` "${allQuery}"` : ''}. <button type="button" className="filter-clear" onClick={clearAllFilters}>Clear filters</button></div>}
          </div>
          {allFiltered.length > 0 && <nav className="pagination" aria-label="All requests pagination"><span className="page-info">{(allSafePage - 1) * allPageSize + 1}–{Math.min(allSafePage * allPageSize, allFiltered.length)} of {allFiltered.length}</span><div className="page-controls"><button type="button" className="page-btn" aria-label="Previous page" disabled={allSafePage === 1} onClick={() => setAllPage(allSafePage - 1)}>&#8249;</button>{pageList(allSafePage, allTotalPages).map((n, i) => n === '…' ? <span key={`e${i}`} className="page-gap">…</span> : <button type="button" key={n} className={`page-btn ${n === allSafePage ? 'current' : ''}`} aria-current={n === allSafePage ? 'page' : undefined} onClick={() => setAllPage(n as number)}>{n}</button>)}<button type="button" className="page-btn" aria-label="Next page" disabled={allSafePage === allTotalPages} onClick={() => setAllPage(allSafePage + 1)}>&#8250;</button></div><label className="page-size">Rows<select aria-label="Rows per page" value={allPageSize} onChange={(e) => setAllPageSize(Number(e.target.value))}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label></nav>}
        </section>

        {/* Detail card — shown when a row is clicked */}
        {selectedAllId && <section className="panel" style={{margin:'0 0 14px'}}>
          <div className="panel-head">
            <div><div className="panel-title">Request details <span className="request-id" style={{marginLeft:8}}>{selectedAllId}</span></div><div className="panel-caption">{allDetail ? `${route(allDetail.ond)} · ${allDetail.agent_code}` : '—'}</div></div>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              {allDetail && <span className={`status ${allDetail.status.toLowerCase()}`}>{allDetail.status}</span>}
              <button type="button" className="subtle-button" onClick={() => setSelectedAllId(null)}><X size={13}/></button>
            </div>
          </div>
          {allDetailLoading && <div className="empty-state">Loading…</div>}
          {allDetail && <div className="inventory-stats" style={{flexWrap:'wrap',gap:12}}>
            <div><span>Route</span><b>{route(allDetail.ond)}</b></div>
            <div><span>Flight</span><b>{allDetail.flight_number ?? '—'}</b></div>
            <div><span>Departure</span><b>{fmtDate(allDetail.departure_dt)}</b></div>
            <div><span>Created</span><b>{fmtTs(allDetail.created_on)}</b></div>
            <div><span>Group size</span><b>{allDetail.group_size ?? '—'} pax</b></div>
            <div><span>Trip type</span><b>{allDetail.trip_type}</b></div>
            <div><span>Agent</span><b>{allDetail.agent_code}</b></div>
            <div><span>Agent email</span><b>{allDetail.agent_email ?? '—'}</b></div>
            <div><span>Quoted fare/pax</span><b>{aed(allDetail.quoted_fare_per_pax)}</b></div>
            <div><span>Reference fare</span><b>{aed(allDetail.ref_fare)}</b></div>
            <div><span>Fare ratio</span><b>{allDetail.fare_ratio != null ? `${(allDetail.fare_ratio * 100).toFixed(1)}%` : '—'}</b></div>
            <div><span>Load factor</span><b>{allDetail.load_factor != null ? `${Math.round(allDetail.load_factor * 100)}%` : '—'}</b></div>
            <div><span>Seats available</span><b>{allDetail.seats_available ?? '—'}</b></div>
            <div><span>Lead time</span><b>{allDetail.lead_time != null ? `${Math.round(allDetail.lead_time)}d` : '—'}</b></div>
            <div><span>Agent conv. rate</span><b>{pct(allDetail.agent_conv_rate)}</b></div>
            <div><span>Route conv. rate</span><b>{pct(allDetail.route_conv_rate)}</b></div>
            <div><span>Converted</span><b>{allDetail.converted != null ? (allDetail.converted ? 'Yes' : 'No') : '—'}</b></div>
          </div>}
        </section>}
        </>}

        {/* ── DECISION LOG PAGE ─────────────────────────────────────── */}
        {activePage === 'audit' && <section className="panel audit-panel"><div className="panel-head"><div><div className="panel-title">Decision log</div><div className="panel-caption">Human approvals and rejections recorded by the API</div></div><ShieldCheck size={16} color="#ff0041"/></div>{audit.length ? <div className="audit-list">{audit.slice(0, 50).map((e, i) => <div className="audit-entry" key={`${e.timestamp}-${i}`}><span className="audit-dot"/><span>{fmtTs(e.timestamp)} · {e.action} · {e.request_id}{e.fare != null ? ` · ${e.seats ?? '?'} seats at ${aed(e.fare)}` : ''}{e.note ? ` · ${e.note}` : ''}</span></div>)}</div> : <div className="audit-empty">No decisions recorded yet. Approve or reject a recommendation to create an audit entry.</div>}</section>}

        <footer className="footer"><span>AI recommendations support decisions — all offers require human approval.</span></footer>
      </div>
    </section>
    <aside className={`agent-panel ${panelOpen ? '' : 'panel-collapsed'}`} style={{ width: panelOpen ? agentWidth : 40 }}>
      <div className="agent-drag-handle" onMouseDown={onAgentDragStart} title="Drag to resize"/>
      <button type="button" className="panel-toggle-btn" aria-label={panelOpen ? 'Collapse assistant' : 'Expand assistant'} onClick={() => { const open = !panelOpen; setPanelOpen(open); if (open && agentWidth < 160) setAgentWidth(300) }}>{panelOpen ? <ChevronRight size={16}/> : <ChevronLeft size={16}/>}</button>
      {panelOpen && <>
      {/* Header */}
      <div className="agent-head-new">
        <div className="agent-head-left"><div className="agent-icon-new"><Bot size={16}/></div><div><b>AI Assistant</b><span><i className="live-dot"/> Powered by Claude</span></div></div>
        {isRequestContext && score && <div className={`agent-rec-chip rec-${score.recommendation.toLowerCase()}`}>{score.recommendation}</div>}
      </div>

      {/* Request context card — only on requests page */}
      {isRequestContext && selected && <div className="agent-context-card">
        <div className="agent-context-route">{route(selected.ond)}<span className="agent-context-id">{selected.request_id}</span></div>
        <div className="agent-context-stats">
          <div><span>Group size</span><b>{pax} pax</b></div>
          <div><span>P(convert)</span><b className={score ? pConvertClass(score.p_convert_at_best) + '-text' : ''}>{score ? pct(score.p_convert_at_best) : '—'}</b></div>
          <div><span>Departure</span><b>{left != null ? `${left}d` : '—'}</b></div>
          <div><span>Load factor</span><b>{detail?.load_factor != null ? `${Math.round(detail.load_factor * 100)}%` : '—'}</b></div>
        </div>
      </div>}

      <div className="agent-body-new">
        {/* Chat thread or intro */}
        {chatHistory && chatHistory.length > 0 ? (
          <div className="chat-thread">
            {chatHistory.map((msg, i) => {
              const text = extractText(msg.content)
              if (!text) return null
              return (
                <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
                  {msg.role === 'assistant' && <div className="chat-avatar-sm"><Sparkles size={10}/></div>}
                  <div className="chat-bubble-content">
                    <article className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></article>
                  </div>
                </div>
              )
            })}
            {chatBusy && <div className="chat-msg chat-msg-assistant"><div className="chat-avatar-sm"><Sparkles size={10}/></div><div className="chat-typing"><span/><span/><span/></div></div>}
          </div>
        ) : (
          <>
            <div className="agent-intro-new">
              <div className="agent-spark-new"><Sparkles size={14}/></div>
              <b>Decision copilot</b>
              <p>{isRequestContext ? 'I analyse this request in real time. Ask me anything or pick a suggestion below.' : 'Ask me anything about group bookings, revenue management, or pricing strategy.'}</p>
            </div>
            {chatBusy && <div className="chat-msg chat-msg-assistant"><div className="chat-avatar-sm"><Sparkles size={10}/></div><div className="chat-typing"><span/><span/><span/></div></div>}
          </>
        )}

        {/* Context-aware suggestions */}
        {!chatBusy && <div className="suggestions-wrap">
          <div className="suggestions-label">SUGGESTED</div>
          {suggestions.map((s) => (
            <button key={s.label} className="suggestion-new" onClick={s.action}><Sparkles size={9}/>{s.label}</button>
          ))}
        </div>}

        {/* Counteroffer draft — only on requests page */}
        {isRequestContext && rejectionDraft && <section className="counteroffer-card rejection-card" aria-label="Rejection email draft">
          <div className="counteroffer-card-head"><div><b>Rejection email</b><span>{rejectionSent ? 'SENT' : 'DRAFT · NOT SENT'}</span></div><X size={15}/></div>
          <label className="sr-only" htmlFor="rejection-draft">Editable rejection message</label>
          <textarea id="rejection-draft" value={rejectionDraft} onChange={(e) => { setRejectionDraft(e.target.value); setRejectionSent(false) }}/>
          <div className="counteroffer-actions">
            <button type="button" className="copy-draft-button" onClick={async () => { try { await navigator.clipboard.writeText(rejectionDraft); flash('Rejection email copied') } catch { flash('Clipboard unavailable') } }}><Copy size={13}/> Copy</button>
            <div className="send-email-row">
              <input className="email-input" type="email" placeholder="Recipient email…" value={recipientEmail} onChange={(e) => { setRecipientEmail(e.target.value); setRejectionSent(false) }} aria-label="Recipient email address"/>
              <button type="button" className={`send-email-button ${rejectionSent ? 'is-sent' : ''}`} onClick={sendRejectionEmail} disabled={rejectionSending || !recipientEmail || rejectionSent}>{rejectionSent ? <><Check size={13}/> Sent</> : rejectionSending ? 'Sending…' : <><Send size={13}/> Send</>}</button>
            </div>
          </div>
          {detail?.agent_email && <p className="counteroffer-note agent-email-note"><Check size={10}/> Agent email: {detail.agent_email}</p>}
          <p className="counteroffer-note">Review before sending. Includes reason and actionable suggestions for the agent.</p>
        </section>}
        {isRequestContext && counterofferDraft && <section ref={draftRef} className="counteroffer-card" aria-label="Counteroffer draft">
          <div className="counteroffer-card-head"><div><b>Counteroffer email</b><span>{emailSent ? 'SENT' : 'DRAFT · NOT SENT'}</span></div><FileText size={15}/></div>
          <label className="sr-only" htmlFor="counteroffer-draft">Editable counteroffer message</label>
          <textarea id="counteroffer-draft" value={counterofferDraft} onChange={(event) => { setCounterofferDraft(event.target.value); setEmailSent(false) }}/>
          <div className="counteroffer-actions">
            <button type="button" className="copy-draft-button" onClick={copyCounteroffer}><Copy size={13}/> Copy</button>
            <div className="send-email-row">
              <input className="email-input" type="email" placeholder="Recipient email…" value={recipientEmail} onChange={(e) => { setRecipientEmail(e.target.value); setEmailSent(false) }} aria-label="Recipient email address"/>
              <button type="button" className={`send-email-button ${emailSent ? 'is-sent' : ''}`} onClick={sendEmail} disabled={emailSending || !recipientEmail || emailSent}>{emailSent ? <><Check size={13}/> Sent</> : emailSending ? 'Sending…' : <><Send size={13}/> Send</>}</button>
            </div>
          </div>
          {detail?.agent_email && <p className="counteroffer-note agent-email-note"><Check size={10}/> Recipient pre-filled from agent profile ({detail.agent_email})</p>}
          <p className="counteroffer-note">Review and edit before sending. All sends are logged to the audit trail.</p>
        </section>}
      </div>

      {/* Compose */}
      <div className="agent-compose-wrap">
        <form className="chat-compose-new" onSubmit={(e) => { e.preventDefault(); const m = chat; setChat(''); ask(m) }}>
          <input aria-label="Ask the booking assistant" value={chat} onChange={(e) => setChat(e.target.value)} placeholder={isRequestContext ? `Ask about ${selectedId}…` : 'Ask anything…'} disabled={chatBusy}/>
          <button aria-label="Send message" type="submit" disabled={chatBusy || !chat.trim()}><Send size={14}/></button>
        </form>
        <p className="agent-disclaimer">AI responses are based on model scenarios, not live PSS data.</p>
      </div>
      </>}
    </aside>
    {notice && <div className="toast" role="status"><Check size={15}/>{notice}</div>}
  </main>
}

/* ── Overview: executive summary ────────────────────────────────────────────── */
type KpiTone = 'brand' | 'positive' | 'negative' | 'neutral' | 'info'
function KpiCard({ icon, label, value, caption, detail, tone = 'brand', valueTone }: { icon: React.ReactNode; label: string; value: string; caption: string; detail?: React.ReactNode; tone?: KpiTone; valueTone?: 'positive' | 'negative' }) {
  return <article className="kpi-card" aria-label={label}><div className="kpi-head"><span className={`kpi-icon ${tone}`} aria-hidden="true">{icon}</span><h3 className="kpi-label">{label}</h3></div><div className={`kpi-value ${valueTone ?? ''} ${value === 'N/A' ? 'na' : ''}`}>{value}</div>{detail && <div className="kpi-detail">{detail}</div>}<p className="kpi-caption">{caption}</p></article>
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
  if (state === 'error' && !data) return <section className="exec" aria-labelledby="exec-title">{head}<SectionError message="Couldn't load the summary" error={error} onRetry={onRetry}/></section>
  if (!data) return null
  const empty = data.open_requests === 0; const noScore = !empty && data.ai_contribution == null
  const inc = data.incremental_contribution; const positive = inc != null && inc >= 0
  const pctText = data.improvement_pct == null ? null : `${data.improvement_pct >= 0 ? '+' : '−'}${fmtPct(Math.abs(data.improvement_pct))} vs baseline`
  return <section className="exec" aria-labelledby="exec-title">
    {head}
    <div className="kpi-grid">
      <KpiCard icon={<Wallet size={18}/>} label="Expected contribution" tone="brand" value={empty ? 'AED 0' : noScore ? 'N/A' : aed(data.ai_contribution)} caption="Across pending opportunities"/>
      <KpiCard icon={positive ? <TrendingUp size={18}/> : <TrendingDown size={18}/>} label="Incremental vs baseline" tone={inc == null ? 'neutral' : positive ? 'positive' : 'negative'} value={empty || inc == null ? 'N/A' : signedAed(inc)} valueTone={inc == null ? undefined : positive ? 'positive' : 'negative'} detail={inc != null && pctText && <span className={`kpi-pill ${positive ? 'positive' : 'negative'}`}>{pctText}</span>} caption="Compared with existing pricing rules"/>
      <KpiCard icon={<ClipboardList size={18}/>} label="Open requests" tone="info" value={data.open_requests.toLocaleString()} caption="Awaiting a decision"/>
      <KpiCard icon={<Armchair size={18}/>} label="Seats requested" tone="neutral" value={data.seats_requested.toLocaleString()} caption="Across pending requests"/>
    </div>
    {state === 'error' && <p className="exec-note">Showing the last loaded figures — refresh failed.</p>}
  </section>
}

/* ── Overview: revenue opportunities ────────────────────────────────────────── */
type OppFilter = '' | OpportunityCategory
const OPP_FILTERS: { key: OppFilter; label: string }[] = [{ key: '', label: 'All' }, { key: 'high_value', label: 'High value' }, { key: 'deadline_approaching', label: 'Deadline soon' }, { key: 'inventory_review', label: 'Inventory check' }]
const OPP_SORTS = [{ value: 'priority', label: 'Priority' }, { value: 'contribution', label: 'Expected contribution' }, { value: 'conversion', label: 'Conversion' }, { value: 'departure', label: 'Departure date' }, { value: 'deadline', label: 'Confirm-by date' }]
const OPP_STEP = 5
const fmtShort = (iso: string | null) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(+d) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) }
const inDays = (n: number | null) => (n == null ? '' : n < 1 ? 'today' : `in ${Math.round(n)}d`)
function OpportunityRow({ o, onOpen }: { o: Opportunity; onOpen: (id: string) => void }) {
  const urgent = o.urgency === 'critical' ? 'red' : o.urgency === 'soon' ? 'amber' : ''
  const flags: { text: string; tone: string }[] = []
  if (o.categories.includes('high_value')) flags.push({ text: 'High value', tone: 'green' })
  if (o.categories.includes('deadline_approaching') && o.days_to_latest_confirmation != null) flags.push({ text: `Cut-off ${inDays(o.days_to_latest_confirmation)}`, tone: o.urgency === 'critical' ? 'red' : 'amber' })
  if (o.categories.includes('inventory_review') && o.inventory_status !== 'unknown') flags.push({ text: 'Inventory risk', tone: 'amber' })
  return <button type="button" className="opp-row" onClick={() => onOpen(o.request_id)} aria-label={`Open request ${o.request_id}`}>
    <span className="opp-rank">{o.priority_rank}</span>
    <span className="opp-main"><b>{o.request_id}</b><span>{o.ond ? route(o.ond) : '—'}{o.flight_number ? ` · ${o.flight_number}` : ''}</span><small>{o.agent_code ?? 'Agent n/a'} · {o.requested_seats} pax · departs {fmtShort(o.departure_dt)}</small></span>
    <span className="opp-money"><b className={o.expected_contribution > 0 ? 'pos' : 'neg'}>{aed(o.expected_contribution)}</b><small>{o.recommended_fare_pct != null ? `${fmtPct(o.recommended_fare_pct, 0)} of normal fare` : '—'} · {o.recommended_seats} seats</small></span>
    <span className="opp-meta"><b>{pct(o.p_convert)}</b><small>est. conversion</small></span>
    <span className="opp-meta"><b className={urgent}>{fmtShort(o.effective_deadline_date)}</b><small>confirm by</small></span>
    <span className={`opp-action ${o.recommendation.toLowerCase()}`}>{o.recommendation.toUpperCase()}</span>
    {flags.length > 0 && <span className="opp-flags">{flags.map((f) => <i key={f.text} className={`opp-flag ${f.tone}`}>{f.text}</i>)}</span>}
  </button>
}
function OpportunitiesPanel({ data, state, error, onRetry, onOpen, onViewAll }: { data: OpportunityData | null; state: 'loading' | 'ready' | 'error'; error: string; onRetry: () => void; onOpen: (id: string) => void; onViewAll: () => void }) {
  const [filter, setFilter] = useState<OppFilter>(''); const [query, setQuery] = useState(''); const [sort, setSort] = useState('priority'); const [visible, setVisible] = useState(OPP_STEP)
  const all = data?.opportunities ?? []
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = all.filter((o) => (!filter || o.categories.includes(filter)) && (!q || o.request_id.toLowerCase().includes(q) || (o.agent_code ?? '').toLowerCase().includes(q)))
    const num = (v: number | null) => (v == null ? 1e9 : v)
    const by: Record<string, (a: Opportunity, b: Opportunity) => number> = { priority: (a, b) => a.priority_rank - b.priority_rank, contribution: (a, b) => b.expected_contribution - a.expected_contribution, conversion: (a, b) => b.p_convert - a.p_convert, departure: (a, b) => num(a.days_to_departure) - num(b.days_to_departure), deadline: (a, b) => num(a.days_to_latest_confirmation) - num(b.days_to_latest_confirmation) }
    return [...list].sort((a, b) => by[sort](a, b) || a.priority_rank - b.priority_rank)
  }, [all, filter, query, sort])
  useEffect(() => { setVisible(OPP_STEP) }, [filter, query, sort])
  const head = <SectionHead id="opp-title" title="Revenue Opportunities Requiring Attention" sub="Pending requests ranked by expected contribution, urgency and inventory risk" action={<button type="button" className="subtle-button" onClick={onViewAll}>All open requests <ChevronRight size={14}/></button>}/>
  if (state === 'loading' && !data) return <section className="exec opp" aria-labelledby="opp-title" aria-busy="true">{head}{Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton-row" style={{ height: 72 }} aria-hidden="true"/>)}</section>
  if (state === 'error' && !data) return <section className="exec opp" aria-labelledby="opp-title">{head}<SectionError message="Couldn't load revenue opportunities" error={error} onRetry={onRetry}/></section>
  if (!data) return null
  if (all.length === 0) return <section className="exec opp" aria-labelledby="opp-title">{head}<div className="empty-state">No pending group requests to prioritise right now.</div></section>
  const count = (k: OppFilter) => (k ? all.filter((o) => o.categories.includes(k)).length : all.length)
  const rows = shown.slice(0, visible); const clear = () => { setFilter(''); setQuery('') }
  return <section className="exec opp" aria-labelledby="opp-title">
    {head}
    <div className="opp-bar">
      <div className="opp-tabs" role="group" aria-label="Show opportunities">{OPP_FILTERS.map((f) => <button key={f.key || 'all'} type="button" className={`opp-tab ${filter === f.key ? 'on' : ''}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label} <i>{count(f.key)}</i></button>)}</div>
      <div className="opp-tools"><label className="search-box inline-search"><Search size={13}/><input aria-label="Search opportunities" placeholder="Search request or agent…" value={query} onChange={(e) => setQuery(e.target.value)}/></label><div className="filter-select-wrap"><span className="sort-label">Sort</span><select aria-label="Sort opportunities" value={sort} onChange={(e) => setSort(e.target.value)}>{OPP_SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div></div>
    </div>
    <div className="opp-list">{rows.map((o) => <OpportunityRow key={o.request_id} o={o} onOpen={onOpen}/>)}{shown.length === 0 && <div className="empty-state">No opportunities match. <button type="button" className="filter-clear" onClick={clear}>Clear filters</button></div>}</div>
    {shown.length > OPP_STEP && <div className="opp-more"><span>Showing {rows.length} of {shown.length}</span>{visible < shown.length && <button type="button" className="subtle-button" onClick={() => setVisible((v) => v + OPP_STEP)}>Show more</button>}{visible > OPP_STEP && <button type="button" className="subtle-button" onClick={() => setVisible(OPP_STEP)}>Show less</button>}</div>}
  </section>
}

/* ── Overview: AI vs traditional strategy ───────────────────────────────────── */
function BarRow({ label, caption, value, max, tone }: { label: string; caption: string; value: number; max: number; tone: 'ai' | 'base' }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (Math.max(value, 0) / max) * 100)) : 0
  return <div className="cmp-bar-row"><span className="cmp-bar-label">{label}<small>{caption}</small></span><div className="cmp-track" role="img" aria-label={`${label}: ${aed(value)}`}><i className={`cmp-fill ${tone}`} style={{ width: `${w}%` }}/></div><b className="cmp-bar-value">{aed(value)}</b></div>
}
function StrategyComparisonPanel({ data, state, error, onRetry }: { data: StrategyComparison | null; state: 'loading' | 'ready' | 'error'; error: string; onRetry: () => void }) {
  const head = <SectionHead id="cmp-title" title="AI vs Traditional Strategy" sub="Expected contribution with AI optimisation compared with the existing rules"/>
  if (state === 'loading' && !data) return <section className="exec cmp" aria-labelledby="cmp-title" aria-busy="true">{head}<div className="cmp-card kpi-skeleton" style={{ minHeight: 130 }} aria-hidden="true"><i/><b/><u/></div></section>
  if (state === 'error' && !data) return <section className="exec cmp" aria-labelledby="cmp-title">{head}<SectionError message="Couldn't load the comparison" error={error} onRetry={onRetry}/></section>
  if (!data) return null
  if (data.evaluated_requests === 0) return <section className="exec cmp" aria-labelledby="cmp-title">{head}<div className="empty-state">No pending requests could be evaluated yet.</div></section>
  const { ai, baseline: bl } = data; const inc = data.incremental_contribution ?? 0; const tone = inc > 0 ? 'positive' : inc < 0 ? 'negative' : 'neutral'
  const max = Math.max(ai.expected_contribution, bl.expected_contribution, 1); const pctText = data.improvement_pct == null ? '' : ` (${data.improvement_pct >= 0 ? '+' : '−'}${fmtPct(Math.abs(data.improvement_pct))})`
  return <section className="exec cmp" aria-labelledby="cmp-title">
    {head}
    <div className="cmp-card">
      <div className="cmp-bars">
        <BarRow label="AI optimizer" caption={`${data.evaluated_requests} requests · avg ${fmtPct(ai.avg_fare_pct_of_normal, 0)} of normal fare`} value={ai.expected_contribution} max={max} tone="ai"/>
        <BarRow label="Traditional rules" caption={`avg ${fmtPct(bl.avg_fare_pct_of_normal, 0)} of normal fare`} value={bl.expected_contribution} max={max} tone="base"/>
      </div>
      <p className={`cmp-result ${tone}`} role="status">{inc > 0 ? <TrendingUp size={18} aria-hidden="true"/> : inc < 0 ? <TrendingDown size={18} aria-hidden="true"/> : null}<span><b>{data.incremental_contribution == null ? 'N/A' : signedAed(inc)}</b>{pctText} {inc >= 0 ? 'more' : 'less'} expected contribution with AI optimisation</span></p>
    </div>
  </section>
}

function FareCompareChart({ quotedFare, aiBestFare, refFare, competitorFare }: { quotedFare: number; aiBestFare: number; refFare: number; competitorFare: number }) {
  const bars = [
    { label: 'Agent quoted', value: quotedFare, color: '#e39c4e' },
    { label: 'AI proposal', value: aiBestFare, color: '#00b26e' },
    { label: 'Reference fare', value: refFare, color: '#6b8fa0' },
    { label: 'Competitor', value: competitorFare, color: '#ff4466' },
  ].filter((b) => b.value > 0)

  if (bars.length < 2) return null

  const W = 500, H = 130
  const PAD = { l: 54, r: 12, t: 14, b: 32 }
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  const maxV = Math.max(...bars.map((b) => b.value)) * 1.18
  const slotW = plotW / bars.length
  const barW = Math.min(44, slotW * 0.55)
  const y = (v: number) => PAD.t + plotH * (1 - v / maxV)
  const ticks = [0.25, 0.5, 0.75, 1.0]

  return (
    <section className="panel fare-compare-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Fare comparison</div>
          <div className="panel-caption">Agent quoted · AI proposal · Reference · Competitor — per pax (AED)</div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Fare comparison bar chart">
        {/* grid + y-axis ticks */}
        {ticks.map((f) => {
          const yy = y(maxV * f)
          return <g key={f}>
            <line x1={PAD.l} y1={yy} x2={W - PAD.r} y2={yy} stroke="#f0f0f0" strokeWidth="1"/>
            <text x={PAD.l - 5} y={yy + 3} textAnchor="end" fontSize="7" fill="#c5c5c5">{Math.round(maxV * f / 100) * 100}</text>
          </g>
        })}
        {/* x-axis baseline */}
        <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="#e7e7e7" strokeWidth="1"/>
        {/* ref fare horizontal line */}
        {refFare > 0 && (
          <line x1={PAD.l} y1={y(refFare)} x2={W - PAD.r} y2={y(refFare)} stroke="#6b8fa0" strokeWidth="1" strokeDasharray="4 3" opacity="0.6"/>
        )}
        {/* bars */}
        {bars.map((b, i) => {
          const cx = PAD.l + slotW * i + slotW / 2
          const barY = y(b.value)
          const barH = H - PAD.b - barY
          return (
            <g key={b.label}>
              <rect x={cx - barW / 2} y={barY} width={barW} height={barH} rx="4" fill={b.color} opacity="0.85"/>
              <text x={cx} y={barY - 4} textAnchor="middle" fontSize="8" fontWeight="700" fill={b.color}>{Math.round(b.value).toLocaleString()}</text>
              <text x={cx} y={H - PAD.b + 13} textAnchor="middle" fontSize="7.5" fill="#6b777c">{b.label}</text>
            </g>
          )
        })}
      </svg>
    </section>
  )
}

function extractText(content: string | unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return (content as Array<{type: string; text?: string}>)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim()
  }
  return ''
}

function HeatRow({ seats, fares, heat, color, bestFare, bestSeats, refFare }: { seats: number; fares: number[]; heat: { fare: number; seats: number; expected_contribution: number }[]; color: (v: number) => string; bestFare: number; bestSeats: number; refFare: number }) {
  return <>
    <span className="heat-row-label"><b>{seats}</b><small> seats</small></span>
    {fares.map((f) => {
      const c = heat.find((h) => Math.round(h.fare) === Math.round(f) && h.seats === seats)
      const isBest = c && Math.round(f) === Math.round(bestFare) && seats === bestSeats
      const val = c ? c.expected_contribution : null
      const disp = val == null ? '' : val < 0 ? '—' : val < 100 ? '~0' : val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(Math.round(val))
      const textColor = val == null ? '' : val < 0 ? '#cc3300' : val < 100 ? '#9baab0' : '#1a4a2e'
      return <span key={f} className={`heat-cell${isBest ? ' heat-best' : ''}`}
        title={c ? `${seats} seats at AED ${Math.round(f).toLocaleString()}/pax (${Math.round(f/refFare*100)}% of ref) → expected contribution AED ${Math.round(c.expected_contribution).toLocaleString()}` : ''}
        style={{ background: c ? color(c.expected_contribution) : '#f7f7f7', color: textColor }}>
        {isBest ? '★' : disp}
      </span>
    })}
  </>
}
function Metric({label,value,change,icon,tone,positive}:{label:string;value:string;change:string;icon:React.ReactNode;tone:string;positive?:boolean}) { return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><span className="metric-label">{label}</span><strong>{value}</strong><span className={`metric-change ${positive?'up':''}`}>{positive && <ArrowUpRight size={13}/>} {change}</span></div> }
function Offer({label,value,suffix,highlight}:{label:string;value:string;suffix:string;highlight?:boolean}) {return <div className={`offer ${highlight?'highlight':''}`}><span>{label}</span><b>{value}</b><small>{suffix}</small></div>}
function Driver({label,detail,value,positive,negative,width}:{label:string;detail:string;value:string;positive?:boolean;negative?:boolean;width:string}) {return <div className="driver"><div className="driver-head"><span><b>{label}</b><small>{detail}</small></span><em className={positive?'driver-positive':negative?'driver-negative':''}>{value}</em></div><div className="driver-track"><i className={positive?'driver-fill-positive':negative?'driver-fill-negative':''} style={{width}}/></div></div>}
function DetailField({ label, value }: { label: string; value: string }) { return <div className="detail-field"><span>{label}</span><b>{value}</b></div> }
