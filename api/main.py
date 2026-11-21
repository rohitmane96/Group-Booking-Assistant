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


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_features() -> pd.DataFrame:
    cache = Path(__file__).parent.parent / "data" / "cache" / "features.parquet"
    if cache.exists():
        return pd.read_parquet(cache)
    from etl.features import build_features
    return build_features()


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
