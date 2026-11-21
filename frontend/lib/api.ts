// Typed client for the FastAPI backend. Schemas follow FRONTEND_CONTRACT.md §3.

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8888').replace(/\/$/, '')

export interface RequestSummary {
  request_id: string
  group_request_id: string
  created_on: string
  status: string
  ond: string
  group_size: number
  quoted_fare_per_pax: number
  ref_fare: number
  flight_number: string
  departure_dt: string | null
}
export interface RequestListResponse { requests: RequestSummary[]; total: number }

export interface RequestDetail {
  request_id: string
  group_request_id: string
  created_on: string
  status: string
  is_live: boolean
  converted: number | null
  group_size: number | null
  ond: string
  trip_type: string
  agent_code: string
  num_options: number
  quoted_fare_per_pax: number | null
  ref_fare: number | null
  fare_ratio: number | null
  competitor_fare: number | null
  load_factor: number | null
  seats_available: number | null
  lead_time: number | null
  dow_travel: number | null
  month_travel: number | null
  flight_number: string | null
  departure_dt: string | null
  agent_prior_requests: number
  agent_conv_rate: number
  route_prior_requests: number
  route_conv_rate: number
}

export interface Driver { feature: string; value: number; shap_value: number }
export interface FareCurvePoint { fare: number; fare_pct: number; p_convert: number }
export interface HeatMapCell { fare: number; seats: number; deadline: number; p_convert: number; displacement_cost: number; expected_contribution: number }
export type Recommendation = 'Accept' | 'Counteroffer' | 'Partial' | 'Reject'

export interface ScoreResponse {
  request_id: string
  p_convert_base: number
  recommendation: Recommendation
  best_fare: number
  best_seats: number
  best_deadline_days: number
  expected_contribution: number
  baseline_contribution: number
  lift_vs_baseline: number
  p_convert_at_best: number
  displacement_cost: number
  remaining_demand: number
  ref_fare: number
  drivers: Driver[]
  fare_curve: FareCurvePoint[]
  heat_map: HeatMapCell[]
}

export interface OfferParams { fare: number; seats: number; deadline_days: number }
export interface ScenarioResponse {
  scenario: OfferParams
  p_convert: number
  expected_contribution: number
  displacement_cost: number
  holding_cost: number
  group_revenue: number
}
export interface CounterOfferResponse { request_id: string; counteroffer_email: string; fare: number; seats: number; deadline_days: number }

export interface ApprovalRequest { action: 'approve' | 'edit' | 'reject'; fare?: number; seats?: number; note?: string }
export interface SendCounterOfferRequest { to_email: string; subject: string; body: string }
export interface SendCounterOfferResponse { status: 'sent'; to: string }
export interface AuditEntry { timestamp: string; request_id: string; action: 'approve' | 'edit' | 'reject'; fare: number | null; seats: number | null; note: string | null; source: string }
export interface ChatMessage { role: 'user' | 'assistant'; content: string | object[] }
export interface ChatResponse { response: string; history: ChatMessage[] }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new ApiError(0, 'Cannot connect to server')
  }
  if (!res.ok) {
    let detail = res.status === 404 ? 'Request not found' : 'Service temporarily unavailable'
    try { const body = await res.json(); if (typeof body?.detail === 'string') detail = body.detail } catch {}
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

const post = <T,>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const enc = encodeURIComponent

export const api = {
  health: () => call<{ status: string }>('/health'),
  listRequests: () => call<RequestListResponse>('/requests'),
  getRequest: (id: string) => call<RequestDetail>(`/requests/${enc(id)}`),
  score: (id: string) => post<ScoreResponse>(`/requests/${enc(id)}/score`),
  scenario: (id: string, p: OfferParams) => post<ScenarioResponse>(`/requests/${enc(id)}/scenario`, p),
  counteroffer: (id: string, p: OfferParams) => post<CounterOfferResponse>(`/requests/${enc(id)}/counteroffer`, p),
  sendCounteroffer: (id: string, b: SendCounterOfferRequest) => post<SendCounterOfferResponse>(`/requests/${enc(id)}/send-counteroffer`, b),
  approve: (id: string, b: ApprovalRequest) => post<{ status: 'recorded'; entry: AuditEntry }>(`/requests/${enc(id)}/approve`, b),
  audit: () => call<{ entries: AuditEntry[] }>('/audit'),
  chat: (message: string, history: ChatMessage[] | null) => post<ChatResponse>('/chat', { message, history }),
}
