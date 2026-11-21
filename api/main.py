"""
FastAPI backend for the Group Booking Assistant.
Serves both the Streamlit UI and the LLM agent tools.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import pandas as pd
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

log = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="UC02 Intelligent Group Booking Assistant",
    description="AI-powered group booking recommendation engine for Air Arabia",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

AUDIT_LOG = Path(__file__).parent.parent / "data" / "audit_log.jsonl"


# ── Startup ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    log.info("Starting Group Booking API …")
    # Ensure DB and features exist
    try:
        from etl.build_snapshots import build_database
        build_database(reload=False)
        from etl.features import build_features
        build_features(use_cache=True)
    except Exception as e:
        log.error("Startup data init failed: %s", e)


# ── Schemas ───────────────────────────────────────────────────────────────────

class ScenarioRequest(BaseModel):
    fare: float
    seats: int
    deadline_days: int


class ApprovalRequest(BaseModel):
    action: str           # "approve" | "edit" | "reject"
    fare: Optional[float] = None
    seats: Optional[int] = None
    note: Optional[str] = None


class ChatRequest(BaseModel):
    message: str
    history: Optional[list] = None


class CounterOfferRequest(BaseModel):
    fare: float
    seats: int
    deadline_days: int


class SendCounterOfferRequest(BaseModel):
    to_email: str
    subject: str
    body: str


class SubmitRequest(BaseModel):
    ond: str
    group_size: int
    trip_type: str                     # ONE_WAY | ROUND_TRIP
    departure_date: str                # YYYY-MM-DD
    airline_quoted_fare: float
    agent_code: Optional[str] = None
    agent_email: Optional[str] = None
    flight_number: Optional[str] = None
    competitor_fare: Optional[float] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

_DATA_DIR = Path(__file__).parent.parent / "data"
_LIVE_PATH = _DATA_DIR / "cache" / "live_requests.parquet"


def _load_features() -> pd.DataFrame:
    cache = _DATA_DIR / "cache" / "features.parquet"
    df = pd.read_parquet(cache) if cache.exists() else __import__("etl.features", fromlist=["build_features"]).build_features()
    if _LIVE_PATH.exists():
        live = pd.read_parquet(_LIVE_PATH)
        df = pd.concat([df, live], ignore_index=True)
    return df


def _save_live(row: dict):
    new_df = pd.DataFrame([row])
    if _LIVE_PATH.exists():
        existing = pd.read_parquet(_LIVE_PATH)
        new_df = pd.concat([existing, new_df], ignore_index=True)
    _LIVE_PATH.parent.mkdir(exist_ok=True)
    new_df.to_parquet(_LIVE_PATH, index=False)


def _compute_live_features(req: SubmitRequest) -> dict:
    import uuid
    from etl.features import _ond_fl_indices, _LADDER_POS, _LOW_BCS
    from etl.build_snapshots import get_connection

    con = get_connection()
    fi = con.execute("SELECT * FROM flight_inventory").df()
    fl = con.execute("SELECT * FROM fares_list").df()

    fi["departure_date"] = pd.to_datetime(fi["departure_date"], errors="coerce").dt.date
    dep_date = pd.to_datetime(req.departure_date).date()
    created_ts = datetime.utcnow()
    request_id = f"LIVE-{str(uuid.uuid4())[:8].upper()}"

    inv = fi[(fi["flight_number"] == req.flight_number) & (fi["departure_date"] == dep_date)] if req.flight_number else pd.DataFrame()
    total_capacity  = float(inv["adult_capacity"].max()) if not inv.empty else float("nan")
    seats_available = float(inv["available_seats"].sum()) if not inv.empty else float("nan")
    seats_allocated = float(inv["allocated_seats"].sum()) if not inv.empty else float("nan")
    load_factor     = seats_allocated / total_capacity if (not inv.empty and total_capacity > 0) else float("nan")
    low_bc_avail    = float(inv[inv["bc_code"].isin(_LOW_BCS)]["available_seats"].sum()) if not inv.empty else float("nan")

    avail_inv = inv[inv["available_seats"] > 0] if not inv.empty else pd.DataFrame()
    if not avail_inv.empty:
        avail_inv = avail_inv.copy()
        avail_inv["_rank"] = avail_inv["bc_code"].map(lambda x: _LADDER_POS.get(x, 999))
        lowest_bc = avail_inv.sort_values("_rank")["bc_code"].iloc[0]
    else:
        lowest_bc = None

    ref_fare = float("nan")
    fl_idx = _ond_fl_indices(fl, req.ond)
    if not fl_idx.empty:
        fl_ond = fl.loc[fl_idx]
        fl_bc = fl_ond[fl_ond["booking_class_id"] == lowest_bc] if lowest_bc else fl_ond
        if fl_bc.empty:
            fl_bc = fl_ond
        vf = fl_bc["sale_valid_from"].isna() | (fl_bc["sale_valid_from"] <= pd.Timestamp(created_ts))
        vt = fl_bc["sale_valid_to"].isna()   | (fl_bc["sale_valid_to"]   >= pd.Timestamp(created_ts))
        matched = fl_bc[vf & vt]
        ref_fare = float(matched["adult_value"].median()) if not matched.empty else float(fl_bc["adult_value"].median())

    dep_ts = pd.Timestamp(req.departure_date)
    lead_time = (dep_ts - pd.Timestamp(created_ts)).days
    fare_ratio = req.airline_quoted_fare / ref_fare if (not pd.isna(ref_fare) and ref_fare > 0) else float("nan")

    feat_cache = _DATA_DIR / "cache" / "features.parquet"
    agent_pr, agent_pc, agent_cr = 0, 0, 0.0
    route_pr, route_pc, route_cr = 0, 0, 0.0
    if feat_cache.exists() and req.agent_code:
        hist = pd.read_parquet(feat_cache)
        a = hist[hist["agent_code"] == req.agent_code]
        agent_pr = int(len(a))
        agent_pc = int(a["converted"].sum()) if "converted" in a.columns else 0
        agent_cr = agent_pc / agent_pr if agent_pr > 0 else 0.0
        r = hist[hist["ond"] == req.ond]
        route_pr = int(len(r))
        route_pc = int(r["converted"].sum()) if "converted" in r.columns else 0
        route_cr = route_pc / route_pr if route_pr > 0 else 0.0

    return {
        "request_id":           request_id,
        "group_request_id":     request_id,
        "created_on":           created_ts.isoformat(),
        "status":               "Submitted",
        "is_live":              True,
        "converted":            float("nan"),
        "group_size":           float(req.group_size),
        "ond":                  req.ond,
        "trip_type":            req.trip_type,
        "agent_code":           req.agent_code,
        "agent_email":          req.agent_email,
        "num_options":          1.0,
        "quoted_fare_per_pax":  float(req.airline_quoted_fare),
        "ref_fare":             ref_fare,
        "fare_ratio":           fare_ratio,
        "competitor_fare":      float(req.competitor_fare) if req.competitor_fare else float("nan"),
        "load_factor":          load_factor,
        "seats_available":      seats_available,
        "low_bc_seats_avail":   low_bc_avail,
        "total_capacity":       total_capacity,
        "lead_time":            float(lead_time),
        "dow_travel":           float(dep_ts.dayofweek),
        "month_travel":         float(dep_ts.month),
        "created_month":        float(created_ts.month),
        "flight_number":        req.flight_number,
        "departure_dt":         req.departure_date,
        "agent_prior_requests": float(agent_pr),
        "agent_prior_converted":float(agent_pc),
        "agent_conv_rate":      agent_cr,
        "route_prior_requests": float(route_pr),
        "route_prior_converted":float(route_pc),
        "route_conv_rate":      route_cr,
    }


def _write_audit(entry: dict):
    AUDIT_LOG.parent.mkdir(exist_ok=True)
    with open(AUDIT_LOG, "a") as f:
        f.write(json.dumps(entry, default=str) + "\n")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


@app.get("/requests")
def list_requests(status: Optional[str] = None, limit: int = 50):
    """List group requests. Default: open (Quoted + Submitted)."""
    feat = _load_features()
    if status:
        df = feat[feat["status"] == status]
    else:
        df = feat[feat["is_live"].fillna(False)]

    df = df.sort_values("created_on", ascending=False).head(limit)

    def _safe(v):
        if pd.isna(v) if not isinstance(v, (list, dict)) else False:
            return None
        if hasattr(v, "item"):   # numpy scalar → python native
            return v.item()
        return v

    records = []
    for _, r in df.iterrows():
        records.append({
            "request_id":        _safe(r["request_id"]),
            "group_request_id":  _safe(r["group_request_id"]),
            "created_on":        str(r["created_on"]),
            "status":            _safe(r["status"]),
            "ond":               _safe(r["ond"]),
            "group_size":        _safe(r["group_size"]),
            "quoted_fare_per_pax": _safe(r["quoted_fare_per_pax"]),
            "ref_fare":          _safe(r["ref_fare"]),
            "flight_number":     _safe(r["flight_number"]),
            "departure_dt": str(r["departure_dt"]) if pd.notna(r.get("departure_dt")) else None,
        })
    return {"requests": records, "total": len(records)}


@app.get("/requests/all")
def list_all_requests(limit: int = 200):
    """List all requests including historical."""
    feat = _load_features()
    df   = feat.sort_values("created_on", ascending=False).head(limit)
    def _safe(v):
        if not isinstance(v, (list, dict)) and pd.isna(v):
            return None
        if hasattr(v, "item"):
            return v.item()
        return v

    records = []
    for _, r in df.iterrows():
        records.append({
            "request_id":        _safe(r["request_id"]),
            "group_request_id":  _safe(r["group_request_id"]),
            "created_on":        str(r["created_on"]),
            "status":            _safe(r["status"]),
            "ond":               _safe(r["ond"]),
            "group_size":        _safe(r["group_size"]),
            "converted": int(r["converted"]) if pd.notna(r.get("converted")) else None,
        })
    return {"requests": records, "total": len(records)}


@app.post("/requests")
def submit_request(body: SubmitRequest):
    """Submit a new live group booking request and compute its features."""
    row = _compute_live_features(body)
    _save_live(row)
    _write_audit({
        "timestamp":  datetime.utcnow().isoformat(),
        "request_id": row["request_id"],
        "action":     "submitted",
        "note":       f"New request: {body.ond} {body.group_size}pax @ AED{body.airline_quoted_fare}",
        "source":     "ui_form",
    })
    return {"request_id": row["request_id"], "status": "created", "features": row}


@app.get("/requests/{request_id}")
def get_request(request_id: str):
    """Get full request details with features."""
    from agent.tools import get_request as _get
    result = _get(request_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.post("/requests/{request_id}/score")
def score_request(request_id: str):
    """Run all engines and return recommendation."""
    from agent.tools import score_request as _score
    result = _score(request_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.post("/requests/{request_id}/scenario")
def run_scenario(request_id: str, body: ScenarioRequest):
    """What-if scenario: score specific fare × seats × deadline."""
    from agent.tools import run_scenario as _run
    result = _run(request_id, body.fare, body.seats, body.deadline_days)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.get("/requests/{request_id}/drivers")
def get_drivers(request_id: str):
    """Get SHAP drivers for a request."""
    from agent.tools import get_drivers as _drivers
    result = _drivers(request_id)
    return {"drivers": result}


@app.post("/requests/{request_id}/counteroffer")
def draft_counteroffer(request_id: str, body: CounterOfferRequest):
    """Draft a counteroffer email via LLM."""
    from agent.tools import draft_counteroffer as _draft
    result = _draft(request_id, body.fare, body.seats, body.deadline_days)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.post("/requests/{request_id}/send-counteroffer")
def send_counteroffer(request_id: str, body: SendCounterOfferRequest):
    """Send a counteroffer email via SMTP. Requires SMTP_* env vars."""
    import smtplib
    import ssl
    from email.mime.text import MIMEText

    host = os.getenv("SMTP_HOST", "")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER", "")
    password = os.getenv("SMTP_PASSWORD", "")
    from_addr = os.getenv("SMTP_FROM", user)

    if not host or not user or not password:
        raise HTTPException(
            status_code=503,
            detail="SMTP not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in .env",
        )

    msg = MIMEText(body.body, "plain")
    msg["Subject"] = body.subject
    msg["From"] = from_addr
    msg["To"] = body.to_email

    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP(host, port) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ctx)
            smtp.login(user, password)
            smtp.sendmail(from_addr, [body.to_email], msg.as_string())
    except Exception as e:
        log.error("SMTP send failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Failed to send email: {e}")

    _write_audit({
        "timestamp":  datetime.utcnow().isoformat(),
        "request_id": request_id,
        "action":     "counteroffer_sent",
        "note":       f"Counteroffer emailed to {body.to_email}",
        "source":     "ui_send",
    })
    return {"status": "sent", "to": body.to_email}


@app.post("/requests/{request_id}/approve")
def approve_request(request_id: str, body: ApprovalRequest, background_tasks: BackgroundTasks):
    """Record a human approval/rejection decision to the audit log."""
    entry = {
        "timestamp":   datetime.utcnow().isoformat(),
        "request_id":  request_id,
        "action":      body.action,
        "fare":        body.fare,
        "seats":       body.seats,
        "note":        body.note,
        "source":      "human_approval",
    }
    background_tasks.add_task(_write_audit, entry)
    return {"status": "recorded", "entry": entry}


@app.get("/audit")
def get_audit_log(limit: int = 100):
    """Return recent audit log entries."""
    if not AUDIT_LOG.exists():
        return {"entries": []}
    entries = []
    with open(AUDIT_LOG) as f:
        for line in f:
            try:
                entries.append(json.loads(line))
            except Exception:
                pass
    return {"entries": entries[-limit:]}


@app.post("/chat")
def chat(body: ChatRequest):
    """Agentic chat endpoint: runs Claude with tool use."""
    from agent.counteroffer import run_agent
    text, updated_history = run_agent(body.message, body.history)
    return {"response": text, "history": updated_history}


@app.post("/admin/rebuild")
def rebuild_db():
    """Rebuild database and feature cache (admin use)."""
    from etl.build_snapshots import build_database
    from etl.features import build_features
    build_database(reload=True)
    build_features(use_cache=False)
    from models.train_conversion import train
    train()
    return {"status": "rebuild complete"}


_PORTFOLIO_CACHE: dict = {"key": None, "ts": 0.0, "data": None}
_PORTFOLIO_TTL_S = 120  # 2-minute TTL


def _decided_request_ids() -> set:
    """Requests that already have a recorded human decision (approve / edit / reject)."""
    ids: set = set()
    if AUDIT_LOG.exists():
        with open(AUDIT_LOG) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("action") in ("approve", "edit", "reject") and e.get("request_id"):
                    ids.add(e["request_id"])
    return ids


def _portfolio(refresh: bool = False) -> dict:
    """
    Score every request that is genuinely awaiting a commercial decision (open Quoted/Submitted
    and without a recorded human decision) ONCE, and cache the result. Both Overview summary
    endpoints read from this so nothing is calculated twice.

    Each row carries engines.comparison.evaluate_strategies output: AI and baseline are evaluated
    on the same fare-response curve, displacement/holding cost, attrition and seat caps.
    """
    import time
    from agent.tools import score_request as _score

    feat = _load_features()
    open_df = feat[feat["is_live"].fillna(False)]
    decided = _decided_request_ids()
    pending = open_df[~open_df["request_id"].isin(decided)]
    # a request whose flight has already departed can no longer be actioned, so it is not pending
    dep_ts = pd.to_datetime(pending["departure_dt"], errors="coerce")
    departed = dep_ts.notna() & (dep_ts < pd.Timestamp.now())
    departed_excluded = int(departed.sum())
    pending = pending[~departed]

    def _mtime(p: Path) -> float:
        return p.stat().st_mtime if p.exists() else 0.0

    key = (
        tuple(sorted(pending["request_id"].tolist())),
        _mtime(_DATA_DIR / "cache" / "features.parquet"),
        _mtime(_LIVE_PATH),
        _mtime(Path(__file__).parent.parent / "config" / "policy.yaml"),
    )
    now = time.time()
    if (not refresh and _PORTFOLIO_CACHE["key"] == key
            and now - _PORTFOLIO_CACHE["ts"] < _PORTFOLIO_TTL_S):
        return _PORTFOLIO_CACHE["data"]

    rows: list = []
    failed = inventory_missing = 0
    for _, r in pending.iterrows():
        if pd.isna(r.get("seats_available")) or pd.isna(r.get("total_capacity")):
            inventory_missing += 1
        try:
            res = _score(r["request_id"], light=True)
        except Exception as exc:  # one bad request must not break the dashboard
            log.warning("overview summary: could not score %s: %s", r["request_id"], exc)
            failed += 1
            continue
        if "error" in res:
            failed += 1
            continue
        def _num(v):
            return None if pd.isna(v) else float(v)

        dep, created = r.get("departure_dt"), r.get("created_on")
        inv_known = bool(pd.notna(r.get("seats_available")) and pd.notna(r.get("total_capacity")))
        item = {
            "request_id":          r["request_id"],
            "agent_code":          None if pd.isna(r.get("agent_code")) else str(r.get("agent_code")),
            "ond":                 None if pd.isna(r.get("ond")) else str(r.get("ond")),
            "flight_number":       None if pd.isna(r.get("flight_number")) else str(r.get("flight_number")),
            "departure_dt":        pd.Timestamp(dep).to_pydatetime() if pd.notna(dep) else None,
            "created_on":          pd.Timestamp(created).to_pydatetime() if pd.notna(created) else None,
            "status":              r.get("status"),
            "requested_seats":     int(r["group_size"]) if pd.notna(r.get("group_size")) else 0,
            "ref_fare":            res["ref_fare"],
            "recommendation":      res["recommendation"],
            "expected_contribution": float(res["expected_contribution"]),
            "p_convert":           float(res["p_convert_at_best"]),
            "best_fare":           res["best_fare"],
            "best_seats":          int(res["best_seats"]),
            "best_deadline_days":  int(res["best_deadline_days"]),
            "displacement_cost":   float(res["displacement_cost"]),
            "inventory_known":     inv_known,
            "seats_available":     _num(r.get("seats_available")) if inv_known else None,
            "release_days":        int(_load_policy_yaml().get("release_deadline_days", 3)),
        }
        rows.append({**res["strategy_comparison"], "item": item})

    data = {
        "open_requests":     int(len(pending)),
        "seats_requested":   int(pending["group_size"].fillna(0).sum()),
        "decided_excluded":  int(open_df["request_id"].isin(decided).sum()),
        "departed_excluded": departed_excluded,
        "failed":            failed,
        "inventory_missing": inventory_missing,
        "rows":              rows,
        "generated_at":      datetime.utcnow().isoformat() + "Z",
    }
    _PORTFOLIO_CACHE.update({"key": key, "ts": now, "data": data})
    return data


@app.get("/summary/executive")
def executive_summary(refresh: bool = False):
    """
    Overview KPIs across requests awaiting a commercial decision.

    AI and baseline contribution are evaluated on identical assumptions (see
    engines/comparison.py). A request the AI would reject contributes AED 0 (it is not pursued);
    a request the baseline rejects also contributes AED 0.
    These are model estimates of expected contribution, not realised revenue.
    """
    p = _portfolio(refresh)
    rows = p["rows"]
    have = len(rows) > 0
    ai_total = sum(r["ai"]["expected_contribution"] for r in rows)
    base_total = sum(r["baseline"]["expected_contribution"] for r in rows)
    incremental = ai_total - base_total
    return {
        "open_requests":              p["open_requests"],
        "seats_requested":            p["seats_requested"],
        "scored_requests":            len(rows),
        "unscored_requests":          p["failed"],
        "ai_contribution":            round(ai_total) if have else None,
        "baseline_contribution":      round(base_total) if have else None,
        "incremental_contribution":   round(incremental) if have else None,
        "improvement_pct":            round(incremental / base_total * 100, 1) if have and base_total > 0 else None,
        "ai_rejected_requests":       sum(1 for r in rows if r["ai"]["decision"] == "Reject"),
        "inventory_missing_requests": p["inventory_missing"],
        "decided_excluded":           p["decided_excluded"],
        "departed_excluded":          p["departed_excluded"],
        "generated_at":               p["generated_at"],
    }


@app.get("/summary/strategy-comparison")
def strategy_comparison(refresh: bool = False):
    """
    AI optimizer vs the existing rule-based baseline over the same portfolio of pending requests.
    Both are scored with the same conversion curve, displacement/holding cost, no-show rate and seat
    caps, so the difference reflects decisions (fare, seats, deadline, accept/reject), not assumptions.
    """
    from collections import Counter
    import yaml

    p = _portfolio(refresh)
    rows = p["rows"]
    n = len(rows)

    policy_path = Path(__file__).parent.parent / "config" / "policy.yaml"
    policy = yaml.safe_load(open(policy_path)) if policy_path.exists() else {}

    def _mean(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    ai_total = sum(r["ai"]["expected_contribution"] for r in rows)
    base_total = sum(r["baseline"]["expected_contribution"] for r in rows)
    incremental = ai_total - base_total
    ai_pursued = [r for r in rows if r["ai"]["decision"] != "Reject"]
    base_pursued = [r for r in rows if r["baseline"]["decision"] != "Reject"]

    def _decisions(key, labels):
        c = Counter(r[key]["decision"] for r in rows)
        return {label: c.get(label, 0) for label in labels}

    effects = {k: round(sum(r["effects"][k] for r in rows)) for k in ("fare", "seats", "deadline", "opportunity")}

    return {
        "evaluated_requests":         n,
        "unscored_requests":          p["failed"],
        "open_requests":              p["open_requests"],
        "decided_excluded":           p["decided_excluded"],
        "departed_excluded":          p["departed_excluded"],
        "inventory_missing_requests": p["inventory_missing"],
        "ai": {
            "expected_contribution":   round(ai_total),
            "contribution_per_request": round(ai_total / n) if n else None,
            "avg_fare_pct_of_normal":  _mean([r["ai"]["fare_pct"] for r in ai_pursued]),
            "seats_offered":           int(sum(r["ai"]["seats"] for r in rows)),
            "seats_above_requested":   int(sum(max(0, r["ai"]["seats"] - r["requested_seats"]) for r in rows)),
            "requests_above_requested": sum(1 for r in rows if r["ai"]["seats"] > r["requested_seats"]),
            "at_fare_ceiling":         sum(1 for r in ai_pursued if (r["ai"]["fare_pct"] or 0) >= policy.get("fare_ceiling_pct", 1.2) * 100 - 0.5),
            "displacement_cost":       round(sum(r["ai"]["displacement_cost"] for r in rows)),
            "decisions":               _decisions("ai", ["Accept", "Counteroffer", "Partial", "Reject"]),
        },
        "baseline": {
            "expected_contribution":   round(base_total),
            "contribution_per_request": round(base_total / n) if n else None,
            "avg_fare_pct_of_normal":  _mean([r["baseline"]["fare_pct"] for r in base_pursued]),
            "seats_offered":           int(sum(r["baseline"]["seats"] for r in rows)),
            "displacement_cost":       round(sum(r["baseline"]["displacement_cost"] for r in rows)),
            "decisions":               _decisions("baseline", ["Accept", "Partial", "Reject"]),
            "load_factor_rejections":  sum(1 for r in rows if r["baseline"]["decision"] == "Reject"),
            "load_factor_unknown_requests": sum(1 for r in rows if not r["baseline"]["load_factor_known"]),
            "load_factor_threshold_pct": round(policy.get("baseline_max_load_factor", 0.75) * 100),
            "fare_rule":               "historical accepted fare ratio per route",
        },
        "requested_seats_total":      int(sum(r["requested_seats"] for r in rows)),
        "incremental_contribution":   round(incremental) if n else None,
        "improvement_pct":            round(incremental / base_total * 100, 1) if n and base_total > 0 else None,
        "requests_ai_higher":         sum(1 for r in rows if r["incremental"] > 0.5),
        "requests_ai_lower":          sum(1 for r in rows if r["incremental"] < -0.5),
        "effects":                    effects,
        "assumptions": {
            "attrition_pct":          round((1 - policy.get("attrition", 0.9)) * 100),
            "fare_floor_pct":         round(policy.get("fare_floor_pct", 0.7) * 100),
            "fare_ceiling_pct":       round(policy.get("fare_ceiling_pct", 1.2) * 100),
            "deadline_options_days":  policy.get("option_deadlines_days", [7, 14, 21]),
            "baseline_deadline_days": (policy.get("option_deadlines_days") or [7, 14, 21])[1 if len(policy.get("option_deadlines_days") or [7, 14, 21]) > 1 else 0],
        },
        "generated_at":               p["generated_at"],
    }


def _load_policy_yaml() -> dict:
    import yaml
    p = Path(__file__).parent.parent / "config" / "policy.yaml"
    return yaml.safe_load(open(p)) if p.exists() else {}


@app.get("/summary/opportunities")
def revenue_opportunities(refresh: bool = False):
    """
    Pending group requests ranked for attention. Every commercial figure (action, expected
    contribution, fare, seats, deadline window, displacement cost) is the optimizer's own output
    from the cached portfolio; engines.opportunities only adds categories, urgency and an ordering
    score that never alters the AI recommendation.
    """
    from engines import opportunities as opp

    p = _portfolio(refresh)
    now = datetime.now()
    ranked = opp.build_opportunities([r["item"] for r in p["rows"]], now)

    def _iso(v):
        return v.isoformat() if v is not None and hasattr(v, "isoformat") else v

    out = []
    for e in ranked:
        ref = e["ref_fare"] or 0
        out.append({
            "request_id":                  e["request_id"],
            "agent_code":                  e["agent_code"],
            "ond":                         e["ond"],
            "flight_number":               e["flight_number"],
            "departure_dt":                _iso(e["departure_dt"]),
            "created_on":                  _iso(e["created_on"]),
            "status":                      e["status"],
            "requested_seats":             e["requested_seats"],
            "recommendation":              e["recommendation"],
            "p_convert":                   e["p_convert"],
            "expected_contribution":       round(e["expected_contribution"]),
            "recommended_fare":            e["best_fare"],
            "recommended_fare_pct":        round(e["best_fare"] / ref * 100, 1) if ref > 0 else None,
            "recommended_seats":           e["best_seats"],
            "recommended_deadline_days":   e["best_deadline_days"],
            "effective_deadline_date":     e["effective_deadline_date"],
            "deadline_truncated":          e["deadline_truncated"],
            "latest_confirmation_date":    e["latest_confirmation_date"],
            "days_to_departure":           e["days_to_departure"],
            "days_to_latest_confirmation": e["days_to_latest_confirmation"],
            "age_days":                    e["age_days"],
            "urgency":                     e["urgency"],
            "inventory_status":            e["inventory_status"],
            "inventory_risk":              e["inventory_risk"],
            "inventory_reasons":           e["inventory_reasons"],
            "displacement_cost":           round(e["displacement_cost"]),
            "categories":                  e["categories"],
            "priority_score":              e["priority_score"],
            "priority_rank":               e["priority_rank"],
        })
    return {
        "opportunities":     out,
        "evaluated":         len(out),
        "unscored":          p["failed"],
        "open_requests":     p["open_requests"],
        "decided_excluded":  p["decided_excluded"],
        "departed_excluded": p["departed_excluded"],
        "inventory_unknown": sum(1 for o in out if o["inventory_status"] == "unknown"),
        "thresholds": {
            "critical_days":       opp.CRITICAL_DAYS,
            "soon_days":           opp.SOON_DAYS,
            "high_value_quantile": opp.HIGH_VALUE_QUANTILE,
            "weights": {
                "contribution": opp.W_CONTRIBUTION, "conversion": opp.W_CONVERSION,
                "urgency": opp.W_URGENCY, "inventory": opp.W_INVENTORY,
            },
        },
        "generated_at":      p["generated_at"],
    }


# ── Web UI (static Next.js export) ────────────────────────────────────────────
# Must be mounted LAST so the API routes above take precedence.
# Build with:  cd frontend && npm ci && npm run build   (produces frontend/out)
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", Path(__file__).parent.parent / "frontend" / "out"))
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:
    log.warning("Frontend build not found at %s - serving API only", FRONTEND_DIR)


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO)
    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=False)
