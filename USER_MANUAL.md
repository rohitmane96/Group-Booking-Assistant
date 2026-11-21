# UC02 · Intelligent Group Booking Assistant
## User Manual — Revenue Manager & Agent Guide

**Version 1.0 · Air Arabia Group Desk · ISA Hackathon Team 10**

---

## Table of Contents
1. [What This System Does](#1-what-this-system-does)
2. [Who Uses It](#2-who-uses-it)
3. [What We Expect from the User](#3-what-we-expect-from-the-user)
4. [How the Assistant Recommends](#4-how-the-assistant-recommends)
5. [Using the Dashboard — Step by Step](#5-using-the-dashboard--step-by-step)
6. [Understanding the Recommendation Card](#6-understanding-the-recommendation-card)
7. [Reading the Charts](#7-reading-the-charts)
8. [Chat: Asking What-If Questions](#8-chat-asking-what-if-questions)
9. [Approving, Editing, or Rejecting](#9-approving-editing-or-rejecting)
10. [How the Bot Responds — Interaction Guide](#10-how-the-bot-responds--interaction-guide)
11. [Policy Rules the Bot Follows](#11-policy-rules-the-bot-follows)
12. [What the Bot Will Never Do](#12-what-the-bot-will-never-do)
13. [Glossary](#13-glossary)

---

## 1. What This System Does

The **Intelligent Group Booking Assistant** is an AI-powered decision support tool for the Air Arabia Group Desk. When a travel agent submits a group booking request (10+ passengers), the system automatically:

1. **Scores** the request — estimates the probability that the agent will confirm the booking.
2. **Prices** the optimal fare — finds the fare that maximises Air Arabia's expected revenue.
3. **Checks inventory** — accounts for the displacement cost of blocking seats for the group.
4. **Recommends a decision** — Accept, Counteroffer, Partial allocation, or Reject.
5. **Explains why** — using SHAP drivers, the assistant tells you which factors drove the recommendation.
6. **Drafts a reply** — generates a professional counteroffer email ready to send.

> **Important:** Every decision requires human approval. The assistant recommends; the revenue manager decides. Nothing is written to the PSS automatically.

---

## 2. Who Uses It

| Role | What They Do in This System |
|------|----------------------------|
| **Revenue Manager** | Reviews AI recommendations, approves/edits/rejects, asks what-if questions via chat |
| **Group Desk Agent** | Submits requests (via existing process); views counteroffer emails drafted by the assistant |
| **Commercial Manager** | Reviews audit log, adjusts policy rules in `config/policy.yaml` |

---

## 3. What We Expect from the User

### 3.1 When Reviewing a Request

The revenue manager should:

| Input | What to Check |
|-------|--------------|
| **Route (OND)** | Confirm it matches the agent's request; note if it's a high-demand route |
| **Group size** | Verify the pax count is realistic; note very large groups (60+) |
| **Departure date** | Check how close to departure (lead time); short lead = higher displacement risk |
| **Quoted fare** | Compare against the reference fare shown; is the agent asking for a large discount? |
| **P(convert)** | Is the bot confident this agent will confirm? Use SHAP drivers to understand why |

### 3.2 When Running a What-If Scenario

Provide:
- A specific **fare per pax** (AED)
- A specific **number of seats**
- A **confirmation deadline** (7, 14, or 21 days before departure)

Example: *"What if we offer 25 seats at AED 1,400 with a 14-day deadline?"*

### 3.3 When Approving a Decision

Before clicking Approve:
- Read the rationale from SHAP drivers
- Check the expected contribution vs baseline
- If counteroffering, review the draft email before sending

### 3.4 What You Do NOT Need to Do

- You do **not** need to calculate fares manually.
- You do **not** need to check inventory in another system (the bot reads it).
- You do **not** need to write counteroffer emails from scratch.
- You do **not** push anything to the PSS — the bot has no write access.

---

## 4. How the Assistant Recommends

The recommendation is produced by four engines running in sequence:

```
Request
   │
   ▼
[1] Data & Feature Layer
    Quote-time snapshot: fare ratio, lead time, load factor,
    agent history, route history, group size, number of options
   │
   ▼
[2] Conversion Model (LightGBM)
    Estimates P(agent confirms) from historical patterns.
    Calibrated so "60% confident" really means 60% of the time.
   │
   ▼
[3] Fare-Response Curve
    How does P(confirm) change as fare goes from 70% to 120%
    of the reference individual fare?
   │
   ▼
[4] Displacement Engine
    How many individual seats does this group displace?
    What is the revenue cost of those displaced bookings?
   │
   ▼
[5] Optimizer
    Grid search: 10 fare levels × 5 seat counts × 3 deadlines
    Finds the combination that maximises expected contribution:
    P(f) × (seats × attrition × fare − displacement) − (1−P(f)) × holding_cost
   │
   ▼
[6] Decision
    Accept / Counteroffer / Partial / Reject
   │
   ▼
[7] LLM Agent (Claude)
    Explains the numbers in plain English.
    Answers your what-if questions using live tool calls.
    Drafts the counteroffer email.
```

### Decision Rules

| Outcome | When it happens |
|---------|----------------|
| **Accept** | Full seats available at (or near) requested fare and expected contribution > 0 |
| **Counteroffer** | Group can be accommodated but at a higher fare than requested |
| **Partial** | Fewer seats than requested; best allocation found by optimizer |
| **Reject** | Expected contribution ≤ 0, flight too full, or policy floor breached |

> The rule-based **baseline** (fix 90% of reference fare, accept if load factor < 75%) is shown alongside for comparison. The AI recommendation should beat it on expected contribution.

---

## 5. Using the Dashboard — Step by Step

### Step 1 — Open the Dashboard
Navigate to: **http://130.61.32.35:8080**

### Step 2 — Select a Request
In the left sidebar, choose **"Open Requests"** to see all pending Quoted/Submitted requests.
Each entry shows: Request ID | Route | Pax count.

Click a request to load it.

### Step 3 — Read the Recommendation Card
The top of the page shows five key numbers at a glance (see Section 6).

### Step 4 — Explore the Charts
Four tabs show deeper analysis:
- **Fare-Response Curve** — how conversion probability changes with price
- **Heat Map** — expected contribution across fare × seats combinations
- **SHAP Drivers** — what factors pushed the recommendation
- **Chat** — ask the assistant anything

### Step 5 — Run a Scenario (optional)
In the "Run Scenario" panel, enter a custom fare, seat count, and deadline.
Click **Run Scenario** to see P(convert), expected contribution, and displacement cost instantly.

### Step 6 — Make a Decision
- ✅ **Approve Recommendation** — accept the AI's best suggestion
- ✏️ **Draft Counteroffer** — generate a reply email (uses the scenario values)
- ❌ **Reject** — decline the request

Every action is written to the **Audit Log** (Sidebar → Audit Log).

---

## 6. Understanding the Recommendation Card

```
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│ Recommendation│ Best Fare/Pax│    Seats     │ P(Convert)   │   Deadline   │
│ Counteroffer  │  AED 1,561   │     80       │   5.3%       │   7 days     │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘

COUNTEROFFER  |  Expected contribution: AED 5,937  |  Baseline: AED 3,478  |  Lift: +AED 2,459
```

| Field | Meaning |
|-------|---------|
| **Recommendation** | Accept / Counteroffer / Partial / Reject |
| **Best Fare/Pax** | Optimal fare per passenger in AED |
| **Seats** | Optimal number of seats to offer |
| **P(Convert)** | Calibrated probability the agent confirms (at the recommended fare) |
| **Deadline** | Suggested option confirmation deadline (days before departure) |
| **Expected Contribution** | AI-optimised expected net revenue (probability-weighted) |
| **Baseline** | What the rule-based approach would earn |
| **Lift** | How much more the AI recommendation earns vs the rule |

> **P(Convert) of 5% is not bad.** At 3% base rate, 5% means this agent/route is more likely to confirm than average. With 80 seats × AED 1,561, even a 5% chance means AED 5,937 in expected contribution — better than the baseline.

---

## 7. Reading the Charts

### 7.1 Fare-Response Curve
- **X-axis**: Fare per pax (AED), from 70% to 120% of reference fare
- **Y-axis**: P(Convert) — conversion probability
- **Dashed vertical line**: AI-recommended fare
- **Dotted line**: Reference individual fare

**How to read it**: Moving left (lower fare) increases conversion probability but reduces revenue per pax. The optimizer has already found the sweet spot. If your commercial judgement says move left or right, use the Scenario tool.

> ⚠️ Note: The curve is partly model-based and partly simulation-based (documented in the chart). The monotone constraint ensures P always decreases as fare rises.

### 7.2 Fare × Seats Heat Map
- **X-axis**: Fare per pax (AED)
- **Y-axis**: Number of seats
- **Colour**: Expected contribution (AED) — green = higher, red = lower/negative

**How to read it**: The darkest green cell is roughly where the optimizer placed its recommendation. Yellow/orange zones are acceptable alternatives. Red zones lose money.

### 7.3 SHAP Drivers (Feature Importance)
Each bar shows how much a feature **pushed** the conversion probability up (green, positive) or down (red, negative) for this specific request.

| Feature | What it means |
|---------|---------------|
| `fare_ratio` | Quoted fare ÷ reference fare. Below 1 = agent asking for discount |
| `agent_conv_rate` | This agent's historical conversion rate (prior requests only) |
| `route_prior_requests` | How many times this route has had group requests |
| `lead_time` | Days between request and departure. Very short = higher risk |
| `group_size` | Number of passengers. Very large groups = higher displacement |
| `load_factor` | Fraction of seats already booked on the flight |
| `month_travel` | Travel month — some months have naturally higher demand |

---

## 8. Chat: Asking What-If Questions

The **Chat tab** connects directly to the AI assistant (Claude). The assistant has access to all the engines and can answer questions instantly.

### Good questions to ask

| Your question | What the bot does |
|---------------|-------------------|
| *"What if we offer 30 seats at AED 1,400 with a 14-day deadline?"* | Runs `run_scenario` tool, returns P(convert), contribution, displacement cost |
| *"Why is the conversion probability so low?"* | Reads SHAP drivers and explains in plain English |
| *"What's the minimum fare we can offer profitably?"* | Looks at fare curve, finds breakeven point |
| *"Draft a counteroffer for 25 seats at AED 1,500"* | Calls `draft_counteroffer`, returns a formatted email |
| *"How does this compare to the baseline?"* | Retrieves both and explains the difference |
| *"What's the displacement cost if we give 40 seats?"* | Calls `run_scenario(seats=40)` and explains |

### How the bot answers

The assistant **always calls a tool first** before answering numbers. It never invents figures. If you ask for a P(convert) at a specific fare, the bot runs the model and quotes the result.

**Example exchange:**

> **You**: What if we offer 20 seats at AED 1,200?
>
> **Assistant**: I ran the scenario for 20 seats at AED 1,200 with a 14-day deadline:
> - **P(Convert)**: 7.2%
> - **Group revenue**: AED 21,600
> - **Displacement cost**: AED 0 (no individual bookings displaced)
> - **Expected contribution**: AED 1,555
>
> At AED 1,200 (92% of reference fare), conversion probability rises to 7.2% but the lower fare reduces contribution to AED 1,555 — below the AED 5,937 at our recommended AED 1,561. The recommended fare still wins unless you have strong reason to believe this agent will walk away at AED 1,561.

---

## 9. Approving, Editing, or Rejecting

### ✅ Approve Recommendation
Clicks **"Approve Recommendation"**. Records to audit log:
```json
{
  "timestamp": "2026-11-21T10:30:00",
  "request_id": "T4463",
  "action": "approve",
  "fare": 1561,
  "seats": 80,
  "note": "Approved via UI"
}
```
Then: revenue manager manually updates the PSS / sends the reply email.

### ✏️ Draft Counteroffer
1. Set your desired fare, seats, and deadline in the **Run Scenario** panel.
2. Click **"Draft Counteroffer"**.
3. A professional email is generated. Review and copy it.
4. Send via your normal email system.

**Example output:**
```
Dear ABYSHJ1547,

Thank you for your group booking inquiry with Air Arabia.

We are pleased to provide the following offer:
  Route:    DEL/SHJ
  Flight:   G9464
  Date:     04 Dec 2026
  Pax:      33
  Fare/pax: AED 1,561
  Deadline: 27 Nov 2026

Please confirm by 27 Nov 2026. Names required 3 days before departure.

Best regards,
Air Arabia Group Desk
```

### ❌ Reject
Clicks **"Reject"**. Records to audit log with action = "reject". Revenue manager sends a standard decline to the agent.

---

## 10. How the Bot Responds — Interaction Guide

### The bot's role
The assistant **explains and executes, never decides**. Its outputs are:

| Bot output | What it means for you |
|------------|----------------------|
| Recommendation card | AI's best answer — a starting point, not a mandate |
| SHAP explanation | Tells you *why*, so you can agree or override intelligently |
| What-if results | Numbers from live engines — always accurate |
| Counteroffer email | A draft — review before sending |
| Chat answer | Based on tool results only — never invented |

### Bot tone and boundaries

✅ **The bot will:**
- State probabilities with confidence bands ("~5%, low confidence — this route has limited history")
- Flag when a request is outside its training range
- Tell you when fare-response is partly simulation-based
- Compare AI recommendation vs rule-based baseline explicitly
- Answer in concise bullet points + one paragraph

❌ **The bot will NOT:**
- Invent fare or seat numbers without calling an engine
- Promise the agent will convert
- Write to the PSS or send emails directly
- Override policy floors without flagging it
- Pretend certainty when the model is uncertain

### When the bot flags uncertainty

The bot uses these signals:
- **"Low confidence"** — fewer than 5 historical requests for this route/agent
- **"Outside training range"** — the request's features (e.g. very large group, unusual lead time) don't match training data
- **"Partly simulated"** — fare-response curve uses elasticity assumption because model has limited fare variation on this route

In these cases, **trust your commercial judgement** over the model number.

---

## 11. Policy Rules the Bot Follows

Defined in `config/policy.yaml` — editable by commercial managers:

| Rule | Default | What it controls |
|------|---------|-----------------|
| `fare_floor_pct` | 70% | Never quote below 70% of reference individual fare |
| `fare_ceiling_pct` | 120% | Upper bound of fare grid |
| `attrition` | 0.9 | Assumed 10% no-show rate in revenue calculation |
| `max_group_share_of_capacity` | 40% | Max % of flight seats one group can take (e.g. 70 seats on A320-174) |
| `min_group_size` | 10 | Minimum pax to qualify as a group |
| `option_deadlines_days` | 7, 14, 21 | Deadline options evaluated by optimizer |
| `baseline_fare_pct_of_reference` | 90% | Baseline rule quotes at 90% of reference fare |
| `baseline_max_load_factor` | 75% | Baseline rejects if flight is >75% full |

> To change a rule: edit `config/policy.yaml` on the server and restart the API (`docker compose restart api`).

---

## 12. What the Bot Will Never Do

| Never | Why |
|-------|-----|
| Write to PSS / GDS | No integration, by design — human must action |
| Send emails to agents | No SMTP integration in MVP |
| Approve its own recommendation | Human approval required for every decision |
| Use data from after the quote date | Leakage prevention — only quote-time features |
| Quote fares below the policy floor | Hard policy constraint in optimizer |
| Accept a group that breaches seat cap | Hard policy constraint |

---

## 13. Glossary

| Term | Definition |
|------|-----------|
| **OND** | Origin-Destination (e.g. SHJ/TBS = Sharjah to Tbilisi) |
| **Reference fare** | The lowest available individual booking fare on that flight on that date |
| **Fare ratio** | Quoted group fare ÷ reference individual fare. 0.9 = 10% discount |
| **P(Convert)** | Calibrated probability that the agent confirms (pays deposit or names pax) |
| **Displacement cost** | Revenue lost because individual bookings were crowded out by the group |
| **Holding cost** | Cost of blocking seats that may be released unsold if group doesn't confirm |
| **Expected contribution** | P(confirm) × (group revenue − displacement) − (1−P) × holding cost |
| **Attrition** | Fraction of booked group pax who actually travel (default 0.9) |
| **SHAP value** | Shapley Additive exPlanations — how much each feature pushed the prediction |
| **Baseline** | Rule-based benchmark: quote 90% of ref fare, accept if load factor < 75% |
| **Audit log** | Append-only record of every human decision (approve/reject/edit) |
| **Lead time** | Days between quote date and flight departure |
| **Load factor** | Fraction of seats already sold (allocated ÷ capacity) |
| **PSS** | Passenger Service System (e.g. Amadeus, Sabre) — no auto-writes from this tool |

---

## Quick Reference Card

```
OPEN DASHBOARD      →  http://130.61.32.35:8080
API DOCS            →  http://130.61.32.35:8888/docs

TYPICAL WORKFLOW:
  1. Sidebar → Open Requests → select a request
  2. Read Recommendation Card (top of page)
  3. Check SHAP Drivers tab to understand why
  4. Optionally run a Scenario with custom fare/seats
  5. Chat with assistant for what-if analysis
  6. Click Approve / Draft Counteroffer / Reject
  7. Audit Log records every decision automatically

KEY RULES:
  • Fare floor: 70% of reference fare
  • Max seats per group: 40% of capacity (~70 on A320)
  • Deadlines: 7, 14 or 21 days before departure
  • Attrition assumed: 10% (configurable)
  • Every recommendation needs human approval before action
```

---

*For technical issues or to adjust policy rules, contact the Group Desk system administrator.*
*Model performance: ROC-AUC 0.583 on November holdout (3% base rate). Beats random baseline.*
