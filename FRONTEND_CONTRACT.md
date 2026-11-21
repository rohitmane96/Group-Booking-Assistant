# Frontend ↔ Backend Contract
## UC02 Intelligent Group Booking Assistant

> **For the frontend developer** — everything you need to build the UI without touching backend code.
> Backend is FastAPI running at `http://130.61.32.35:8888` (or `http://localhost:8888` locally).
> Live API docs (Swagger): **http://130.61.32.35:8888/docs**

---

## Table of Contents
1. [Base URL & Auth](#1-base-url--auth)
2. [All Endpoints](#2-all-endpoints)
3. [Data Schemas (TypeScript)](#3-data-schemas-typescript)
4. [Endpoint Details with Examples](#4-endpoint-details-with-examples)
5. [UI Page → API Mapping](#5-ui-page--api-mapping)
6. [What the Frontend Must NOT Do](#6-what-the-frontend-must-not-do)
7. [Error Handling](#7-error-handling)
8. [Environment Variables](#8-environment-variables)
9. [Development Checklist](#9-development-checklist)

---

## 1. Base URL & Auth

```
Base URL:   http://130.61.32.35:8888   (production)
            http://localhost:8888       (local dev)

Auth:       None for MVP (open API, internal network only)
CORS:       All origins allowed
Content-Type: application/json
```

---

## 2. All Endpoints

| Method | Path | Purpose | Used on |
|--------|------|---------|---------|
| `GET` | `/health` | API alive check | App startup |
| `GET` | `/requests` | List open (Quoted/Submitted) requests | Sidebar queue |
| `GET` | `/requests/all` | List all requests including historical | History page |
| `GET` | `/requests/{id}` | Full request details + features | Request detail panel |
| `POST` | `/requests/{id}/score` | Run all engines → recommendation | Main recommendation card |
| `POST` | `/requests/{id}/scenario` | What-if: custom fare×seats×deadline | Scenario tool |
| `GET` | `/requests/{id}/drivers` | SHAP feature importance | Drivers chart |
| `POST` | `/requests/{id}/counteroffer` | Draft counteroffer email via LLM | Email draft panel |
| `POST` | `/requests/{id}/approve` | Record human decision to audit log | Approve/Reject buttons |
| `GET` | `/audit` | Recent audit log entries | Audit log page |
| `POST` | `/chat` | Agentic chat with Claude | Chat panel |
| `POST` | `/admin/rebuild` | Rebuild DB + retrain (admin only) | Admin page |

---

## 3. Data Schemas (TypeScript)

```typescript
// ── Requests list ────────────────────────────────────────────────────────────

interface RequestSummary {
  request_id: string;           // "T4463"
  group_request_id: string;     // "G3390"
  created_on: string;           // "2026-11-19 20:47:00"
  status: string;               // "Submitted" | "Quoted" | "PNR" | "Closed as Lost" | ...
  ond: string;                  // "DEL/SHJ"
  group_size: number;           // 33
  quoted_fare_per_pax: number;  // 0.0  (agent's proposed fare, 0 if not yet quoted)
  ref_fare: number;             // 1300.6  (reference individual fare AED)
  flight_number: string;        // "G9464"
  departure_dt: string | null;  // "2026-12-04 03:20:00"
}

interface RequestListResponse {
  requests: RequestSummary[];
  total: number;
}

// ── Request detail ───────────────────────────────────────────────────────────

interface RequestDetail {
  request_id: string;
  group_request_id: string;
  created_on: string;
  status: string;
  is_live: boolean;
  converted: number | null;      // 1 | 0 | null (null for live/open)
  group_size: number | null;
  ond: string;
  trip_type: string;             // "ONE_WAY" | "RETURN"
  agent_code: string;            // "ABYSHJ1547"
  num_options: number;           // how many flight options offered
  quoted_fare_per_pax: number | null;
  ref_fare: number | null;
  fare_ratio: number | null;     // quoted_fare / ref_fare  (e.g. 0.95)
  competitor_fare: number | null;
  load_factor: number | null;    // 0.0–1.0
  seats_available: number | null;
  lead_time: number | null;      // days before departure
  dow_travel: number | null;     // 0=Mon … 6=Sun
  month_travel: number | null;   // 1–12
  flight_number: string | null;
  departure_dt: string | null;
  agent_prior_requests: number;
  agent_conv_rate: number;       // 0.0–1.0
  route_prior_requests: number;
  route_conv_rate: number;
}

// ── Score / Recommendation ───────────────────────────────────────────────────

interface Driver {
  feature: string;       // "agent_conv_rate"
  value: number;         // 0.067
  shap_value: number;    // +0.867 (positive = increases P(convert))
}

interface FareCurvePoint {
  fare: number;          // AED per pax
  fare_pct: number;      // % of reference fare (70–120)
  p_convert: number;     // 0.0–1.0
}

interface HeatMapCell {
  fare: number;
  seats: number;
  deadline: number;      // days before departure
  p_convert: number;
  displacement_cost: number;
  expected_contribution: number;
}

interface ScoreResponse {
  request_id: string;
  p_convert_base: number;          // base P(convert) at requested fare
  recommendation: "Accept" | "Counteroffer" | "Partial" | "Reject";
  best_fare: number;               // AED per pax
  best_seats: number;
  best_deadline_days: number;      // 7 | 14 | 21
  expected_contribution: number;   // AED
  baseline_contribution: number;   // AED (rule-based baseline)
  lift_vs_baseline: number;        // AED difference (positive = AI beats baseline)
  p_convert_at_best: number;
  displacement_cost: number;       // AED
  remaining_demand: number;        // estimated individual pax demand remaining
  ref_fare: number;
  drivers: Driver[];               // top 10, sorted by |shap_value| desc
  fare_curve: FareCurvePoint[];    // 11 points from 70% to 120% of ref fare
  heat_map: HeatMapCell[];         // ~165 cells (10 fares × 5 seats × 3 deadlines)
}

// ── Scenario (what-if) ───────────────────────────────────────────────────────

interface ScenarioRequest {
  fare: number;
  seats: number;
  deadline_days: number;
}

interface ScenarioResponse {
  scenario: { fare: number; seats: number; deadline_days: number };
  p_convert: number;
  expected_contribution: number;
  displacement_cost: number;
  holding_cost: number;
  group_revenue: number;
}

// ── Counteroffer ─────────────────────────────────────────────────────────────

interface CounterOfferRequest {
  fare: number;
  seats: number;
  deadline_days: number;
}

interface CounterOfferResponse {
  request_id: string;
  counteroffer_email: string;   // full email text, ready to display/copy
  fare: number;
  seats: number;
  deadline_days: number;
}

// ── Approval ─────────────────────────────────────────────────────────────────

interface ApprovalRequest {
  action: "approve" | "edit" | "reject";
  fare?: number;
  seats?: number;
  note?: string;
}

interface ApprovalResponse {
  status: "recorded";
  entry: {
    timestamp: string;
    request_id: string;
    action: string;
    fare: number | null;
    seats: number | null;
    note: string | null;
    source: "human_approval";
  };
}

// ── Audit log ────────────────────────────────────────────────────────────────

interface AuditEntry {
  timestamp: string;
  request_id: string;
  action: "approve" | "edit" | "reject";
  fare: number | null;
  seats: number | null;
  note: string | null;
  source: string;
}

interface AuditLogResponse {
  entries: AuditEntry[];
}

// ── Chat ─────────────────────────────────────────────────────────────────────

interface ChatRequest {
  message: string;
  history: ChatMessage[] | null;   // pass back the history array from previous response
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string | object[];      // object[] when tool_use involved (backend handles this)
}

interface ChatResponse {
  response: string;                // assistant's plain-text reply
  history: ChatMessage[];          // updated history — store and pass back next turn
}

// ── SHAP drivers (standalone) ────────────────────────────────────────────────

interface DriversResponse {
  drivers: Driver[];
}
```

---

## 4. Endpoint Details with Examples

### `GET /requests`
**Returns open requests** (status = Quoted or Submitted). Use for the main sidebar queue.

```bash
GET http://130.61.32.35:8888/requests

# Optional query params:
?status=PNR      # filter by specific status
?limit=50        # default 50
```

```json
{
  "requests": [
    {
      "request_id": "T4463",
      "group_request_id": "G3390",
      "created_on": "2026-11-19 20:47:00",
      "status": "Submitted",
      "ond": "DEL/SHJ",
      "group_size": 33,
      "quoted_fare_per_pax": 0.0,
      "ref_fare": 1300.6,
      "flight_number": "G9464",
      "departure_dt": "2026-12-04 03:20:00"
    }
  ],
  "total": 35
}
```

---

### `POST /requests/{id}/score`
**Main call** — runs all engines. Call this when user selects a request. May take 2–5 seconds.

```bash
POST http://130.61.32.35:8888/requests/T4463/score
# No request body needed
```

```json
{
  "request_id": "T4463",
  "p_convert_base": 0.0528,
  "recommendation": "Counteroffer",
  "best_fare": 1561,
  "best_seats": 80,
  "best_deadline_days": 7,
  "expected_contribution": 5937,
  "baseline_contribution": 3478,
  "lift_vs_baseline": 2459,
  "p_convert_at_best": 0.0528,
  "displacement_cost": 0,
  "remaining_demand": 0,
  "ref_fare": 1301,
  "drivers": [
    { "feature": "agent_conv_rate", "value": 0.067, "shap_value": 0.867 },
    { "feature": "route_prior_requests", "value": 71.0, "shap_value": 0.509 },
    { "feature": "lead_time", "value": 14.0, "shap_value": 0.068 }
  ],
  "fare_curve": [
    { "fare": 910.42, "fare_pct": 70.0, "p_convert": 0.0612 },
    { "fare": 975.45, "fare_pct": 75.0, "p_convert": 0.0581 }
  ],
  "heat_map": [
    { "fare": 910, "seats": 25, "deadline": 7, "p_convert": 0.0612,
      "displacement_cost": 0, "expected_contribution": 1253 }
  ]
}
```

---

### `POST /requests/{id}/scenario`

```bash
POST http://130.61.32.35:8888/requests/T4463/scenario
Content-Type: application/json

{ "fare": 1400, "seats": 25, "deadline_days": 14 }
```

```json
{
  "scenario": { "fare": 1400, "seats": 25, "deadline_days": 14 },
  "p_convert": 0.0574,
  "expected_contribution": 1835,
  "displacement_cost": 0,
  "holding_cost": 0,
  "group_revenue": 31500
}
```

---

### `POST /requests/{id}/counteroffer`

```bash
POST http://130.61.32.35:8888/requests/T4463/counteroffer
Content-Type: application/json

{ "fare": 1561, "seats": 33, "deadline_days": 7 }
```

```json
{
  "request_id": "T4463",
  "counteroffer_email": "Dear ABYSHJ1547,\n\nThank you for your group booking inquiry...",
  "fare": 1561,
  "seats": 33,
  "deadline_days": 7
}
```

---

### `POST /requests/{id}/approve`

```bash
POST http://130.61.32.35:8888/requests/T4463/approve
Content-Type: application/json

{ "action": "approve", "fare": 1561, "seats": 33, "note": "Approved by manager" }
# or
{ "action": "reject", "note": "Flight too full" }
```

```json
{ "status": "recorded", "entry": { "timestamp": "...", "action": "approve", ... } }
```

---

### `POST /chat`

```bash
POST http://130.61.32.35:8888/chat
Content-Type: application/json

{
  "message": "[Request ID: T4463] What if we offer 25 seats at AED 1,400?",
  "history": null   // null for first message, then pass back what you receive
}
```

```json
{
  "response": "I ran the scenario for 25 seats at AED 1,400 (14-day deadline):\n- P(Convert): 5.7%\n- Expected contribution: AED 1,835\n...",
  "history": [ ... ]   // store this, pass as `history` in next message
}
```

> **Important for chat**: The `history` array must be passed back on every subsequent message in the same conversation. Store it in component state. Clear it when user starts a new request.

---

## 5. UI Page → API Mapping

```
Page / Component                API calls
─────────────────────────────── ───────────────────────────────────────────
Sidebar queue                   GET /requests  (poll every 60s or on load)
Request detail panel            GET /requests/{id}
Recommendation card             POST /requests/{id}/score  ← main call
Fare-response curve chart       uses fare_curve[] from score response
Heat map chart                  uses heat_map[] from score response
SHAP drivers chart              uses drivers[] from score response
Scenario tool                   POST /requests/{id}/scenario
Chat panel                      POST /chat  (with history)
Counteroffer email panel        POST /requests/{id}/counteroffer
Approve button                  POST /requests/{id}/approve  {action: "approve"}
Reject button                   POST /requests/{id}/approve  {action: "reject"}
Audit log page                  GET /audit
History page                    GET /requests/all
```

---

## 6. What the Frontend Must NOT Do

| ❌ Don't | ✅ Do instead |
|----------|--------------|
| Calculate P(convert) on the frontend | Always call `/score` and use the returned value |
| Hardcode fare floors or seat limits | These come from the backend via the score response |
| Cache score results for more than the session | Re-call `/score` on each request selection |
| Modify `history[]` array structure before sending to `/chat` | Pass it back exactly as received |
| Show recommendation before `/score` completes | Show a loading state |
| Compute expected contribution yourself | Use `expected_contribution` from score response |
| Store the Anthropic API key anywhere | Backend handles all LLM calls |

---

## 7. Error Handling

| HTTP Status | Meaning | Frontend action |
|-------------|---------|----------------|
| `200` | Success | Render the data |
| `404` | Request ID not found | Show "Request not found" message |
| `500` | Server error (model not trained, DB issue) | Show "Service temporarily unavailable", retry |
| Network error | API unreachable | Show "Cannot connect to server" banner |

All errors return:
```json
{ "detail": "Human-readable error message here" }
```

The `/score` and `/chat` endpoints may take **3–10 seconds** — always show a loading spinner.

---

## 8. Environment Variables

Frontend needs only one env var:

```env
VITE_API_BASE_URL=http://130.61.32.35:8888    # production
VITE_API_BASE_URL=http://localhost:8888        # local dev
```

If using Next.js:
```env
NEXT_PUBLIC_API_BASE_URL=http://130.61.32.35:8888
```

---

## 9. Development Checklist

Before calling yourself done on any page, verify:

### Request Queue (Sidebar)
- [ ] Calls `GET /requests` on load
- [ ] Shows: Request ID, OND, group size, departure date, status badge
- [ ] Clicking a request triggers `POST /requests/{id}/score`
- [ ] Loading spinner during score call

### Recommendation Card
- [ ] Shows all 5 metrics: recommendation, fare, seats, P(convert), deadline
- [ ] Recommendation label is colour-coded: Accept=green, Counteroffer=amber, Partial=blue, Reject=red
- [ ] Shows expected contribution, baseline, and lift (+ or -)
- [ ] Uses data from `/score` response — no computed values

### Fare-Response Curve
- [ ] X = `fare`, Y = `p_convert` from `fare_curve[]` array
- [ ] Vertical line at `best_fare` (recommended fare)
- [ ] Vertical dotted line at `ref_fare`
- [ ] Y-axis formatted as percentage

### Heat Map
- [ ] X = fare, Y = seats, colour = `expected_contribution`
- [ ] Filter by `deadline` (show one deadline at a time, let user switch)
- [ ] Green = high contribution, Red = negative/low

### SHAP Drivers
- [ ] Horizontal bar chart
- [ ] Positive SHAP = green (increases P(convert))
- [ ] Negative SHAP = red (decreases P(convert))
- [ ] Shows feature name and actual value

### Scenario Tool
- [ ] Fare input (AED, number), seats input (integer), deadline dropdown (7/14/21)
- [ ] Calls `POST /requests/{id}/scenario` on submit
- [ ] Shows: P(convert), group revenue, displacement cost, expected contribution

### Chat
- [ ] Input field + send button
- [ ] Prepends `[Request ID: {id}]` to message before sending
- [ ] Passes `history` back on every subsequent message
- [ ] Clears `history` when switching to a different request
- [ ] Loading spinner while waiting (can take 5–10s)

### Approve / Reject
- [ ] Approve sends `{action: "approve", fare: best_fare, seats: best_seats}`
- [ ] Reject sends `{action: "reject"}`
- [ ] Show success confirmation after recording

### Counteroffer Email
- [ ] Uses scenario values (fare/seats/deadline from scenario tool)
- [ ] Calls `POST /requests/{id}/counteroffer`
- [ ] Displays email in a copy-able text area
- [ ] "Copy to clipboard" button

### Audit Log
- [ ] Calls `GET /audit`
- [ ] Shows: timestamp, request ID, action, fare, seats, note

---

## Key Numbers to Know

| Thing | Value |
|-------|-------|
| Typical P(convert) range | 2% – 15% (base rate is 3%) |
| Fare grid | 70% to 120% of reference fare, 11 steps |
| Seat options in optimizer | 5 levels around requested group size |
| Deadline options | 7, 14, 21 days before departure |
| Heat map cells | ~165 per request (10×5×3) |
| Score response time | 2–8 seconds |
| Chat response time | 5–15 seconds |
| Open requests (live) | ~35 at any time |
