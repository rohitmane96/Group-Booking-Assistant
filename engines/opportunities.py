"""
Prioritisation of pending group requests for the Overview "Revenue Opportunities Requiring Attention".

Design rules
------------
* The optimizer stays the single source of truth for the commercial decision. Its recommendation,
  expected contribution, fare, seats, deadline and displacement cost are passed through unchanged.
* `priority_score` exists only to order the list. It is a separate number from the AI action and never
  changes it.
* Data that does not exist is not invented:
    - the dataset stores no confirmation deadline. Time pressure is derived from two real dates:
      the departure date and the policy's final release cut-off (`release_deadline_days` before
      departure). The optimizer's recommended option window (7/14/21 days) is shown as the
      recommended deadline and is truncated to that cut-off when the flight is close.
    - inventory is labelled "Unknown" when seats/capacity are missing; the optimizer's 50% load
      assumption is never presented as occupancy.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

import numpy as np

# Urgency thresholds, in days until the latest possible confirmation date.
CRITICAL_DAYS = 7
SOON_DAYS = 14
# Share of positive-contribution opportunities flagged "High Value" (top quartile).
HIGH_VALUE_QUANTILE = 0.75

# Weights for the ordering score only (sum to 1).
W_CONTRIBUTION, W_CONVERSION, W_URGENCY, W_INVENTORY = 0.50, 0.20, 0.20, 0.10

CATEGORY_HIGH_VALUE = "high_value"
CATEGORY_INVENTORY = "inventory_review"
CATEGORY_DEADLINE = "deadline_approaching"
CATEGORY_COUNTEROFFER = "counteroffer"


def deadline_info(
    now: datetime,
    departure: Optional[datetime],
    created: Optional[datetime],
    recommended_days: Optional[int],
    release_days: int,
) -> dict:
    """Time-pressure facts for one request, derived only from real dates and policy."""
    info: dict[str, Any] = {
        "days_to_departure": None,
        "latest_confirmation_date": None,
        "days_to_latest_confirmation": None,
        "recommended_deadline_days": recommended_days,
        "effective_deadline_date": None,
        "deadline_truncated": False,
        "age_days": None,
        "urgency": "unknown",
    }
    if created is not None:
        info["age_days"] = max(0, (now - created).days)
    if departure is None:
        return info

    latest = departure - timedelta(days=release_days)
    days_to_latest = (latest - now).total_seconds() / 86400
    info["days_to_departure"] = round((departure - now).total_seconds() / 86400, 1)
    info["latest_confirmation_date"] = latest.isoformat()
    info["days_to_latest_confirmation"] = round(days_to_latest, 1)

    if recommended_days is not None:
        proposed = now + timedelta(days=recommended_days)
        info["effective_deadline_date"] = min(proposed, latest).isoformat()
        info["deadline_truncated"] = latest < proposed

    if days_to_latest <= CRITICAL_DAYS:
        info["urgency"] = "critical"
    elif days_to_latest <= SOON_DAYS:
        info["urgency"] = "soon"
    else:
        info["urgency"] = "normal"
    return info


def inventory_assessment(
    inventory_known: bool,
    seats_available: Optional[float],
    recommended_seats: int,
    requested_seats: int,
    displacement_cost: float,
) -> dict:
    """Inventory / displacement risk. Unknown inventory is reported as Unknown, never as verified."""
    reasons: list[str] = []
    if displacement_cost and displacement_cost > 0:
        reasons.append("displacement")
    if recommended_seats < requested_seats:
        reasons.append("below_request")
    if inventory_known and seats_available is not None and seats_available < recommended_seats:
        reasons.append("shortage")
    if not inventory_known:
        reasons.append("unknown")

    if not inventory_known:
        risk = "unknown"
    elif "displacement" in reasons or "shortage" in reasons:
        risk = "high"
    elif "below_request" in reasons:
        risk = "medium"
    else:
        risk = "low"
    return {
        "inventory_status": "verified" if inventory_known else "unknown",
        "inventory_risk": risk,
        "inventory_reasons": reasons,
        "needs_inventory_review": bool(reasons),
    }


def build_opportunities(items: list[dict], now: datetime) -> list[dict]:
    """
    items: one flat dict per pending request with
      request_id, agent_code, ond, flight_number, departure_dt, created_on, status,
      requested_seats, ref_fare, recommendation, expected_contribution, p_convert,
      best_fare, best_seats, best_deadline_days, displacement_cost,
      inventory_known, seats_available, release_days
    Returns the items enriched with deadline/inventory facts, categories and a priority score,
    ordered by priority (highest first).
    """
    if not items:
        return []

    enriched: list[dict] = []
    for it in items:
        dl = deadline_info(now, it.get("departure_dt"), it.get("created_on"), it.get("best_deadline_days"), it["release_days"])
        inv = inventory_assessment(
            it["inventory_known"], it.get("seats_available"), it["best_seats"], it["requested_seats"], it["displacement_cost"],
        )
        enriched.append({**it, **dl, **inv})

    positives = [e["expected_contribution"] for e in enriched if e["expected_contribution"] > 0]
    hv_cut = float(np.quantile(positives, HIGH_VALUE_QUANTILE)) if positives else float("inf")
    max_ec = max(positives) if positives else 0.0
    max_p = max((e["p_convert"] or 0.0) for e in enriched) or 0.0

    for e in enriched:
        cats: list[str] = []
        if e["expected_contribution"] > 0 and e["expected_contribution"] >= hv_cut:
            cats.append(CATEGORY_HIGH_VALUE)
        if e["needs_inventory_review"]:
            cats.append(CATEGORY_INVENTORY)
        if e["urgency"] in ("critical", "soon"):
            cats.append(CATEGORY_DEADLINE)
        if e["recommendation"] == "Counteroffer":
            cats.append(CATEGORY_COUNTEROFFER)
        e["categories"] = cats

        ec_norm = max(e["expected_contribution"], 0.0) / max_ec if max_ec > 0 else 0.0
        p_norm = (e["p_convert"] or 0.0) / max_p if max_p > 0 else 0.0
        urgency = {"critical": 1.0, "soon": 0.5}.get(e["urgency"], 0.0)
        inventory = {"high": 1.0, "medium": 0.6, "unknown": 0.3}.get(e["inventory_risk"], 0.0)
        e["priority_score"] = round(
            100 * (W_CONTRIBUTION * ec_norm + W_CONVERSION * p_norm + W_URGENCY * urgency + W_INVENTORY * inventory), 1
        )

    enriched.sort(key=lambda e: (-e["priority_score"], -e["expected_contribution"], e["request_id"]))
    for i, e in enumerate(enriched, 1):
        e["priority_rank"] = i
    return enriched
