# UC02 · Intelligent Group Booking Assistant
**ISA Hackathon · Team 10 · November 2026**

AI-powered pipeline that evaluates group booking requests for Air Arabia and recommends Accept / Counteroffer / Partial / Reject decisions. A human approves every decision — no PSS writes.

**Live:** http://130.61.32.35:8080  |  **API docs:** http://130.61.32.35:8888/docs

---

## Architecture

```
New Request → Data & Feature Layer → [Conversion Model + Fare Curve + Displacement Engine]
           → Optimizer → LLM Agent (Claude) → Dashboard → Human Approval → Audit Log
```

| Layer       | Stack                                  |
|-------------|----------------------------------------|
| Data store  | DuckDB + Pandas + Parquet cache        |
| ML model    | LightGBM + isotonic calibration + SHAP |
| Optimizer   | NumPy grid search (150 scenarios)      |
| API         | FastAPI (port 8888)                    |
| LLM         | Claude (claude-sonnet-4-6)             |
| UI          | Next.js 16 (served by FastAPI, port 8080) |
| Deploy      | Docker Compose on Oracle Cloud VM      |

---

## Datasets

| File                            | Rows      | Used for                          |
|---------------------------------|-----------|-----------------------------------|
| `Group Quote.csv`               | 4,463     | Conversion model labels + features |
| `Flight Inventory.csv`          | 368,874   | Load factor, seat availability     |
| `fares_list.csv.zip`            | 1.46 M    | Reference fare, fare ratio feature |
| `Past & Future Booking Data.zip`| ~15 months| Pickup curves (displacement engine)|

---

## Project Structure

```
uc02-group-assistant/
├── data/                  # raw CSVs + parquet cache (git-ignored)
├── etl/
│   ├── build_snapshots.py # load CSVs → DuckDB + parquet cache
│   └── features.py        # feature engineering (quote-time snapshot)
├── models/
│   ├── train_conversion.py # LightGBM + isotonic calibration
│   └── artifacts/          # saved model files (git-ignored)
├── engines/
│   ├── fare_curve.py       # fare-response curve (70–120% of ref fare)
│   ├── displacement.py     # pickup curves + EMSR displacement cost
│   ├── optimizer.py        # grid search: fare × seats × deadline
│   ├── baseline.py         # rule-based baseline for comparison
│   ├── comparison.py       # AI vs baseline like-for-like evaluation
│   └── opportunities.py    # revenue opportunity prioritisation
├── agent/
│   ├── tools.py            # LLM tool functions (get_request, score, etc.)
│   ├── prompts.py          # system prompt + templates
│   └── counteroffer.py     # agentic loop (Claude tool_use)
├── api/
│   └── main.py             # FastAPI (REST endpoints + static UI serving)
├── frontend/               # Next.js 16 dashboard
│   ├── app/
│   ├── components/
│   │   └── group-booking-dashboard.tsx  # main single-page dashboard
│   └── lib/api.ts          # typed API client
├── config/
│   └── policy.yaml         # fare floors, deadlines, attrition, etc.
├── nginx/
│   └── nginx.conf          # reverse proxy (port 8080 → 8888)
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

---

## Quick Start (Docker)

```bash
# 1. Set API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 2. Build and start
docker compose up --build -d

# Dashboard: http://localhost:8080
# API docs:  http://localhost:8888/docs
```

---

## Dashboard Pages

| Page             | Description                                                   |
|------------------|---------------------------------------------------------------|
| **Overview**     | Executive KPI summary (open requests, AI vs baseline contribution, improvement %) · Revenue Opportunities list (filterable by urgency/category) · AI vs Traditional strategy comparison |
| **Open Requests**| Filterable queue of active requests · Collapse/expand detail view · AI scoring (P(convert), SHAP drivers, fare curve, heat map) · What-if scenario tool · Counteroffer email drafting · Human approve/edit/reject |
| **All Requests** | Full history (all statuses) with same search/filter/pagination as open requests · Read-only detail card |
| **Audit Log**    | Timeline of all human decisions (approve / edit / reject)     |

**AI Assistant (right panel)** — Claude-powered chat answers what-if questions using live tools. Automatically explains each AI recommendation in plain English when a request is selected.

---

## Engines

### 1. Conversion Model
- **LightGBM** with class weights (3% imbalance handled)
- Features: group_size, fare_ratio, load_factor, lead_time, DOW, month, num_options, agent/route history
- **Isotonic calibration** on Oct validation set
- **SHAP** values per request
- Time split: Jun–Sep train | Oct validate | Nov holdout

### 2. Fare-Response Curve
- Scores request at 11 fare points (70%–120% of reference fare, 5% steps)
- Monotone constraint: P(convert) always decreases as fare rises

### 3. Displacement Engine
- Builds pickup curves from monthly booking data
- Forecasts remaining individual demand
- EMSR-style bid price for displaced seats

### 4. Optimizer
- 10 fares × 5 seat levels × 3 deadlines = 150 scenarios
- Objective: `P(f) × (k × attrition × f − displacement(k)) − (1−P(f)) × holding(k)`
- Decision: Accept / Counteroffer / Partial / Reject

### 5. Baseline (Rule-Based)
- Quotes at 90% of reference fare; accepts if load factor < 75%
- Used as a like-for-like benchmark against the AI optimizer

### 6. Strategy Comparison (engines/comparison.py)
- Evaluates AI and baseline on identical assumptions for every pending request
- Powers the "AI vs Traditional" panel on the Overview page

### 7. Revenue Opportunities (engines/opportunities.py)
- Ranks pending requests by urgency (critical <7d, soon <14d), inventory risk, and expected contribution
- Powers the "Revenue Opportunities" list on the Overview page

### 8. LLM Agent (Claude)
- Tools: get_request, score_request, run_scenario, get_drivers, draft_counteroffer
- Chat: what-if questions run live tools
- Auto-explanation: fires when a request is selected with no active chat history

---

## API Endpoints

| Method | Path                             | Description                     |
|--------|----------------------------------|---------------------------------|
| GET    | `/health`                        | Health check                    |
| GET    | `/requests`                      | List open requests               |
| GET    | `/requests/all`                  | List all requests (all statuses) |
| GET    | `/requests/{id}`                 | Get request + features           |
| POST   | `/requests/{id}/score`           | Run all engines + comparison     |
| POST   | `/requests/{id}/scenario`        | What-if scenario                 |
| GET    | `/requests/{id}/drivers`         | SHAP drivers                     |
| POST   | `/requests/{id}/counteroffer`    | Draft counteroffer email         |
| POST   | `/requests/{id}/rejection`       | Draft rejection email            |
| POST   | `/requests/{id}/send-counteroffer` | Send counteroffer / rejection email |
| POST   | `/requests/{id}/approve`         | Record human decision            |
| GET    | `/audit`                         | Audit log                        |
| POST   | `/chat`                          | Agentic chat (Claude)            |
| GET    | `/summary/executive`             | Executive KPI summary            |
| GET    | `/summary/strategy-comparison`   | AI vs baseline comparison        |
| GET    | `/summary/opportunities`         | Prioritised revenue opportunities|
| POST   | `/admin/rebuild`                 | Rebuild DB + retrain model       |

---

## Policy Configuration

Edit `config/policy.yaml` to adjust:
- `fare_floor_pct`, `fare_ceiling_pct` — fare grid bounds (default 70%–120%)
- `attrition` — expected no-show rate (default 0.9)
- `option_deadlines_days` — deadline options to evaluate (default [3, 7, 14])
- `max_group_share_of_capacity` — max seats per group (default 40%)
- `baseline_fare_pct_of_reference` — rule-based benchmark fare (default 90%)
- `baseline_max_load_factor` — baseline load factor threshold (default 75%)

---

## Deployment (VM)

- **VM:** Oracle Cloud · `opc@130.61.32.35`
- **Dashboard:** http://130.61.32.35:8080
- **API:** http://130.61.32.35:8888

```bash
# Deploy changes (never overwrites .env on VM)
rsync -az --exclude='.git' --exclude='node_modules' --exclude='.next' \
      --exclude='data/' --exclude='.env' --exclude='__pycache__' \
      ./ opc@130.61.32.35:~/uc02-group-assistant/ \
      -e "ssh -i <key>"

# Rebuild and restart (restart alone does NOT reload env_file)
docker compose build --no-cache
docker compose up -d --force-recreate api nginx
```

Init container runs ETL + feature build + model training once on first start (skips if data already present).

---

## Implementation Status

### ✅ Done
- ETL pipeline: Group Quote, Flight Inventory, fares_list, booking data
- Feature engineering (quote-time snapshot, no leakage)
- LightGBM conversion model with SHAP + isotonic calibration
- Fare-response curve engine (monotone)
- Displacement engine with pickup curves
- Constrained optimizer (grid search, 150 scenarios)
- Rule-based baseline + strategy comparison engine
- Revenue opportunities prioritisation engine
- FastAPI backend (all endpoints including /summary/*)
- Next.js 16 dashboard (Overview, Open Requests, All Requests, Audit Log)
- Claude agent (tool_use loop) with inline "why this recommendation" explanation
- Counteroffer email drafting + rejection email drafting (templated, engine-driven)
- Decision locking — once approved/rejected, action buttons replaced by status banner
- Confirmation dialog before recording any human decision
- Audit log
- SMTP email sending (Gmail app password via env)
- Docker Compose on Oracle Cloud VM with nginx

### ⚠️ Known Assumptions / Limitations
- Fare-response curve partly simulation-based (documented in UI)
- Only 4 agents with real history; synthetic requests labelled clearly
- No PSS integration: recommendations wait for human approval
- Competitor fares mostly 0 → feature excluded from model
- Final pax count not in data → attrition is configurable (default 0.9)
