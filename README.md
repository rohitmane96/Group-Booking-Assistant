# UC02 · Intelligent Group Booking Assistant
**ISA Hackathon · Team 10 · 20 Nov 2026**

AI-powered pipeline that evaluates group booking requests for Air Arabia and recommends Accept / Counteroffer / Partial / Reject decisions. A human approves every decision — no PSS writes.

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
| API         | FastAPI                                |
| LLM         | Claude (claude-sonnet-4-6)             |
| UI          | Streamlit + Plotly                     |
| Deploy      | Docker Compose (restart: always)       |

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
│   └── baseline.py         # rule-based baseline for comparison
├── agent/
│   ├── tools.py            # LLM tool functions (get_request, score, etc.)
│   ├── prompts.py          # system prompt + templates
│   └── counteroffer.py     # agentic loop (Claude tool_use)
├── api/
│   └── main.py             # FastAPI (REST endpoints)
├── ui/
│   └── app.py              # Streamlit dashboard
├── config/
│   └── policy.yaml         # fare floors, deadlines, attrition, etc.
├── eval/                   # (pending) backtest notebook
├── Dockerfile
├── docker-compose.yml
├── startup.sh              # local quick-start
└── requirements.txt
```

---

## Quick Start (Local)

```bash
cd uc02-group-assistant

# 1. Set your Anthropic API key
cp .env.example .env
# edit .env → ANTHROPIC_API_KEY=sk-ant-...

# 2. Run everything
./startup.sh
```

- Dashboard: http://localhost:8501
- API docs: http://localhost:8000/docs

---

## Quick Start (Docker)

```bash
# 1. Set API key in .env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env

# 2. Build and start
docker compose up --build

# Services restart automatically on VM reboot (restart: always)
```

---

## Demo Script (5 min)

1. Open http://localhost:8501
2. Select an open SHJ request from the sidebar
3. See P(convert), SHAP drivers, and recommendation card
4. Slide fare in "Run Scenario" → watch P(convert) and contribution change
5. View fare × seats heat map
6. Ask what-if in Chat: "What if we offer 30 seats at AED 1,500?"
7. Click "Draft Counteroffer" → review email
8. Click "Approve Recommendation" → see audit log entry

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
- Falls back to elasticity simulation if model lacks fare variation

### 3. Displacement Engine
- Builds pickup curves from monthly booking data
- Forecasts remaining individual demand
- EMSR-style bid price for displaced seats

### 4. Optimizer
- 10 fares × 5 seat levels × 3 deadlines = 150 scenarios
- Objective: `P(f) × (k × attrition × f − displacement(k)) − (1−P(f)) × holding(k)`
- Decision: Accept / Counteroffer / Partial / Reject

### 5. LLM Agent (Claude)
- Tools: get_request, score_request, run_scenario, get_drivers, draft_counteroffer
- Chat: what-if questions run live tools
- Counteroffer email drafted in airline tone

---

## Policy Configuration

Edit `config/policy.yaml` to adjust:
- `fare_floor_pct`, `fare_ceiling_pct` — fare grid bounds
- `attrition` — expected no-show rate (default 0.9)
- `option_deadlines_days` — deadline options to evaluate
- `max_group_share_of_capacity` — max seats per group
- `baseline_fare_pct_of_reference` — rule-based benchmark

---

## Implementation Status

### ✅ Done (MVP)
- [x] ETL pipeline: Group Quote, Flight Inventory, fares_list, booking data
- [x] Feature engineering (quote-time snapshot, no leakage)
- [x] LightGBM conversion model with SHAP + isotonic calibration
- [x] Fare-response curve engine (monotone)
- [x] Displacement engine with pickup curves
- [x] Constrained optimizer (grid search)
- [x] Rule-based baseline
- [x] FastAPI backend (all endpoints)
- [x] Streamlit UI with charts, what-if, approval
- [x] Claude agent (tool_use loop)
- [x] Counteroffer email drafting
- [x] Audit log
- [x] Docker Compose with `restart: always`
- [x] policy.yaml for configurable business rules

### 🔄 Pending / Next Iteration
- [ ] **Backtest notebook** (`eval/backtest.ipynb`) — ROC-AUC, PR-AUC, Brier score vs baseline
- [ ] **Model calibration reliability plot** — visualise calibration in UI
- [ ] **New request form** — UI form to submit a new group request (currently uses existing data)
- [ ] **Flight inventory view tab** — show booking class ladder in UI
- [ ] **SHAP confidence band** — flag OOD requests (outside training distribution)
- [ ] **Synthetic agent history** — extend 4-agent dataset via simulation
- [ ] **Multi-leg trip support** — OND 2–5 not yet fully used in features
- [ ] **Fares with totals cleaning** — cap/drop ambiguous fares (likely group totals > AED 10k)
- [ ] **Authentication** — API key / SSO for the dashboard
- [ ] **VM deployment** — configure nginx reverse proxy, SSL, systemd or Docker on reboot
- [ ] **Email integration** — send counteroffer email via SMTP
- [ ] **Metrics slide** — automated model performance report

### ⚠️ Known Assumptions / Limitations
- Fare-response curve partly simulation-based (documented in UI)
- Only 4 agents: synthetic history labelled clearly
- No PSS integration: recommendations wait for human approval
- Competitor fares mostly 0 → feature excluded from model
- Final pax count not in data → attrition is configurable (default 0.9)

---

## API Endpoints

| Method | Path                             | Description                     |
|--------|----------------------------------|---------------------------------|
| GET    | `/health`                        | Health check                    |
| GET    | `/requests`                      | List open requests               |
| GET    | `/requests/all`                  | List all requests                |
| GET    | `/requests/{id}`                 | Get request + features           |
| POST   | `/requests/{id}/score`           | Run all engines                  |
| POST   | `/requests/{id}/scenario`        | What-if scenario                 |
| GET    | `/requests/{id}/drivers`         | SHAP drivers                     |
| POST   | `/requests/{id}/counteroffer`    | Draft counteroffer email         |
| POST   | `/requests/{id}/approve`         | Record human decision            |
| GET    | `/audit`                         | Audit log                        |
| POST   | `/chat`                          | Agentic chat (Claude)            |
| POST   | `/admin/rebuild`                 | Rebuild DB + retrain model       |

---

## VM Deployment Notes (TODO: add details when VM provided)

```bash
# On VM:
git clone <repo> uc02-group-assistant
cd uc02-group-assistant
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# Start (containers auto-restart on reboot)
docker compose up -d --build

# Check logs
docker compose logs -f
```

Docker `restart: always` ensures services come back after VM reboot.
