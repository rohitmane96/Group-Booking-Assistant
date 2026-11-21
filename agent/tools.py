"""
LLM tool definitions: functions the Claude agent can call.
Each tool wraps a deterministic engine call.
All tools are also exposed as FastAPI endpoints.
"""
from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd
import shap as shap_lib
import joblib

from pathlib import Path

log = logging.getLogger(__name__)

ARTIFACTS = Path(__file__).parent.parent / "models" / "artifacts"

# ── lazy-loaded singletons ────────────────────────────────────────────────────
_model      = None
_calibrator = None
_explainer  = None
_feat_names = None
_feature_df: pd.DataFrame | None = None


def _load_artifacts():
    global _model, _calibrator, _explainer, _feat_names
    if _model is None:
        from models.train_conversion import load_model
        _model, _calibrator, _explainer, _feat_names = load_model()


_DATA_DIR  = Path(__file__).parent.parent / "data" / "cache"
_LIVE_PATH = _DATA_DIR / "live_requests.parquet"


def _load_features(force_reload: bool = False) -> pd.DataFrame:
    """Load historical features, merging in any live submitted requests."""
    global _feature_df
    if _feature_df is None or force_reload or _LIVE_PATH.exists():
        cache = _DATA_DIR / "features.parquet"
        df = pd.read_parquet(cache) if cache.exists() else __import__("etl.features", fromlist=["build_features"]).build_features()
        if _LIVE_PATH.exists():
            live = pd.read_parquet(_LIVE_PATH)
            df = pd.concat([df, live], ignore_index=True)
        _feature_df = df
    return _feature_df


def _predict(X: pd.DataFrame) -> np.ndarray:
    _load_artifacts()
    from models.train_conversion import predict_proba
    return predict_proba(X, model=_model, calibrator=_calibrator, feature_names=_feat_names)


# ── Tool: get_request ─────────────────────────────────────────────────────────

def get_request(request_id: str) -> dict:
    """Fetch a group request with its computed features."""
    feat = _load_features()
    row = feat[feat["request_id"] == request_id]
    if row.empty:
        return {"error": f"Request {request_id} not found"}
    r = row.iloc[0].to_dict()
    # clean NaN for JSON
    return {k: (None if isinstance(v, float) and np.isnan(v) else v)
            for k, v in r.items()}


# ── Tool: score_request ───────────────────────────────────────────────────────

def score_request(request_id: str, light: bool = False) -> dict:
    """
    Run all engines for a request:
    conversion probability, fare-response curve, displacement, optimizer.

    light=True skips the SHAP drivers and the chart payloads (fare curve, heat map).
    The optimizer and baseline numbers are identical; it is used for portfolio-level
    aggregation where only the contribution figures are needed.
    """
    feat = _load_features()
    row = feat[feat["request_id"] == request_id]
    if row.empty:
        return {"error": f"Request {request_id} not found"}

    r = row.iloc[0]
    _load_artifacts()

    # feature vector for prediction
    from etl.features import FEATURE_COLS
    feat_dict = {}
    for col in FEATURE_COLS:
        val = r.get(col, np.nan)
        feat_dict[col] = float(val) if pd.notna(val) else np.nan
    feat_dict["trip_type_enc"] = 1.0 if r.get("trip_type") == "ONE_WAY" else 0.0

    X = pd.DataFrame([feat_dict])
    p_base = float(_predict(X)[0])

    ref_fare = r.get("ref_fare", np.nan)
    if pd.isna(ref_fare) or ref_fare <= 0:
        ref_fare = r.get("quoted_fare_per_pax", 1000) or 1000

    # SHAP drivers
    drivers = [] if light else get_drivers(request_id, feat_dict)

    # optimizer
    from engines.optimizer import run_optimizer
    capacity       = r.get("total_capacity", 174) or 174
    seats_alloc    = capacity - (r.get("seats_available", 100) or 100)
    travel_month   = int(r.get("month_travel", 6) or 6)
    lead_time      = float(r.get("lead_time", 30) or 30)
    ond            = str(r.get("ond", "SHJ/DEL") or "SHJ/DEL")

    result = run_optimizer(
        request_features=feat_dict,
        ref_fare=float(ref_fare),
        capacity=float(capacity),
        seats_allocated=float(seats_alloc),
        ond=ond,
        travel_month=travel_month,
        lead_time=lead_time,
        predict_fn=_predict,
    )

    from engines.comparison import evaluate_strategies
    comparison = evaluate_strategies(
        request_features=feat_dict,
        ref_fare=float(ref_fare),
        capacity=float(capacity),
        seats_allocated=float(seats_alloc),
        ond=ond,
        travel_month=travel_month,
        lead_time=lead_time,
        ai_result=result,
    )

    return {
        "request_id":          request_id,
        "p_convert_base":      round(p_base, 4),
        "recommendation":      result["recommendation"],
        "best_fare":           result["best_fare"],
        "best_seats":          result["best_seats"],
        "best_deadline_days":  result["best_deadline_days"],
        "expected_contribution": result["expected_contribution"],
        "baseline_contribution": result["baseline_contribution"],
        "lift_vs_baseline":    result["lift_vs_baseline"],
        "p_convert_at_best":   result["p_convert_at_best"],
        "displacement_cost":   result["displacement_cost"],
        "remaining_demand":    result["remaining_demand"],
        "ref_fare":            round(float(ref_fare)),
        "strategy_comparison": comparison,
        "drivers":             drivers,
        "fare_curve":          [] if light else result["fare_curve"].to_dict(orient="records"),
        "heat_map":            [] if light else result["heat_map"].to_dict(orient="records"),
    }


# ── Tool: run_scenario ────────────────────────────────────────────────────────

def run_scenario(request_id: str, fare: float, seats: int, deadline_days: int) -> dict:
    """What-if: score a specific fare × seats × deadline combination."""
    feat = _load_features()
    row = feat[feat["request_id"] == request_id]
    if row.empty:
        return {"error": f"Request {request_id} not found"}

    r = row.iloc[0]
    _load_artifacts()

    from etl.features import FEATURE_COLS
    feat_dict = {}
    for col in FEATURE_COLS:
        val = r.get(col, np.nan)
        feat_dict[col] = float(val) if pd.notna(val) else np.nan
    feat_dict["trip_type_enc"] = 1.0 if r.get("trip_type") == "ONE_WAY" else 0.0

    ref_fare = r.get("ref_fare", np.nan)
    if pd.isna(ref_fare) or ref_fare <= 0:
        ref_fare = r.get("quoted_fare_per_pax", 1000) or 1000

    feat_dict["fare_ratio"]          = fare / float(ref_fare)
    feat_dict["quoted_fare_per_pax"] = fare

    X = pd.DataFrame([feat_dict])
    p_convert = float(_predict(X)[0])

    capacity     = float(r.get("total_capacity", 174) or 174)
    seats_alloc  = capacity - float(r.get("seats_available", 100) or 100)
    ond          = str(r.get("ond", "SHJ/DEL") or "SHJ/DEL")
    travel_month = int(r.get("month_travel", 6) or 6)
    lead_time    = float(r.get("lead_time", 30) or 30)

    from engines.displacement import (
        forecast_remaining_demand, compute_displacement_cost, compute_holding_cost
    )
    import yaml
    with open(Path(__file__).parent.parent / "config" / "policy.yaml") as f:
        policy = yaml.safe_load(f)

    remaining_demand = forecast_remaining_demand(ond, travel_month, lead_time, capacity)
    disp_cost = compute_displacement_cost(seats, remaining_demand, capacity, seats_alloc)
    hold_cost = compute_holding_cost(seats, deadline_days, policy.get("holding_cost_per_seat_per_day", 0))

    from engines.optimizer import compute_expected_contribution
    ec = compute_expected_contribution(
        p_convert=p_convert,
        fare_per_pax=fare,
        k_seats=seats,
        displacement_cost=disp_cost,
        holding_cost=hold_cost,
        attrition=policy.get("attrition", 0.9),
    )

    return {
        "scenario": {"fare": fare, "seats": seats, "deadline_days": deadline_days},
        "p_convert": round(p_convert, 4),
        "expected_contribution": round(ec),
        "displacement_cost": round(disp_cost),
        "holding_cost": round(hold_cost),
        "group_revenue": round(seats * policy.get("attrition", 0.9) * fare),
    }


# ── Tool: get_drivers ─────────────────────────────────────────────────────────

def get_drivers(request_id: str, feat_dict: dict | None = None) -> list[dict]:
    """Return SHAP top-10 feature drivers for a request."""
    _load_artifacts()
    if feat_dict is None:
        feat = _load_features()
        row = feat[feat["request_id"] == request_id]
        if row.empty:
            return []
        r = row.iloc[0]
        from etl.features import FEATURE_COLS
        feat_dict = {}
        for col in FEATURE_COLS:
            val = r.get(col, np.nan)
            feat_dict[col] = float(val) if pd.notna(val) else np.nan
        feat_dict["trip_type_enc"] = 1.0 if r.get("trip_type") == "ONE_WAY" else 0.0

    X = pd.DataFrame([feat_dict])
    X_filled = X.reindex(columns=_feat_names).fillna(-1)

    shap_vals = _explainer.shap_values(X_filled)
    if isinstance(shap_vals, list):
        shap_vals = shap_vals[1]  # positive class

    drivers = []
    for i, name in enumerate(_feat_names):
        drivers.append({
            "feature":    name,
            "value":      round(float(X_filled.iloc[0, i]), 4),
            "shap_value": round(float(shap_vals[0, i]), 4),
        })

    return sorted(drivers, key=lambda x: abs(x["shap_value"]), reverse=True)[:10]


# ── Tool: draft_counteroffer ──────────────────────────────────────────────────

def draft_counteroffer(request_id: str, fare: float, seats: int, deadline_days: int) -> dict:
    """Draft a counteroffer email from the standard template."""
    import os
    from agent.prompts import COUNTEROFFER_TEMPLATE
    import datetime

    req = get_request(request_id)
    if "error" in req:
        return req

    # fill template fields
    departure_dt = req.get("departure_dt")
    if departure_dt:
        try:
            dep_date = pd.to_datetime(departure_dt).strftime("%d %b %Y")
            option_dl = (pd.to_datetime(departure_dt) - pd.Timedelta(days=deadline_days)).strftime("%d %b %Y")
        except Exception:
            dep_date  = str(departure_dt)
            option_dl = "TBD"
    else:
        dep_date  = "TBD"
        option_dl = "TBD"

    ond_display = req.get("ond", "").replace("/", " – ")
    filled = COUNTEROFFER_TEMPLATE.format(
        ond          = ond_display,
        flight_number= req.get("flight_number", "TBD"),
        departure_date=dep_date,
        seats        = seats,
        fare         = fare,
        deadline_date= option_dl,
        option_deadline=option_dl,
        release_days = 3,
    )

    polished = filled

    return {
        "request_id":    request_id,
        "counteroffer_email": polished,
        "fare": fare,
        "seats": seats,
        "deadline_days": deadline_days,
    }


# ── Tool definitions for Anthropic tool_use API ───────────────────────────────

TOOL_DEFINITIONS = [
    {
        "name": "get_request",
        "description": "Fetch a group booking request and its computed features.",
        "input_schema": {
            "type": "object",
            "properties": {
                "request_id": {"type": "string", "description": "The Request ID (e.g. T1234)"}
            },
            "required": ["request_id"],
        },
    },
    {
        "name": "score_request",
        "description": "Run all engines (conversion model, fare curve, displacement, optimizer) for a request. Returns recommendation, P(convert), expected contribution vs baseline, SHAP drivers, fare curve and heat map.",
        "input_schema": {
            "type": "object",
            "properties": {
                "request_id": {"type": "string"}
            },
            "required": ["request_id"],
        },
    },
    {
        "name": "run_scenario",
        "description": "What-if analysis: score a specific fare × seats × deadline combination for a request.",
        "input_schema": {
            "type": "object",
            "properties": {
                "request_id":    {"type": "string"},
                "fare":          {"type": "number", "description": "Fare per passenger in AED"},
                "seats":         {"type": "integer"},
                "deadline_days": {"type": "integer", "description": "Days before departure for confirmation"},
            },
            "required": ["request_id", "fare", "seats", "deadline_days"],
        },
    },
    {
        "name": "get_drivers",
        "description": "Get SHAP feature importance drivers for a request.",
        "input_schema": {
            "type": "object",
            "properties": {
                "request_id": {"type": "string"}
            },
            "required": ["request_id"],
        },
    },
    {
        "name": "draft_counteroffer",
        "description": "Draft a professional counteroffer email for the agent.",
        "input_schema": {
            "type": "object",
            "properties": {
                "request_id":    {"type": "string"},
                "fare":          {"type": "number"},
                "seats":         {"type": "integer"},
                "deadline_days": {"type": "integer"},
            },
            "required": ["request_id", "fare", "seats", "deadline_days"],
        },
    },
]

TOOL_REGISTRY = {
    "get_request":        get_request,
    "score_request":      score_request,
    "run_scenario":       run_scenario,
    "get_drivers":        get_drivers,
    "draft_counteroffer": draft_counteroffer,
}
