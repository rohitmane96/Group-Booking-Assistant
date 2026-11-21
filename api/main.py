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


class SubmitRequest(BaseModel):
    ond: str
    group_size: int
    trip_type: str                     # ONE_WAY | ROUND_TRIP
    departure_date: str                # YYYY-MM-DD
    airline_quoted_fare: float
    agent_code: Optional[str] = None
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
