"""
Optimizer and decision engine.
Grid search over fare × seats × deadline to maximise expected contribution.
Objective: P(f) × (k × attrition × f - displacement(k)) - (1-P(f)) × holding(k)
"""
from __future__ import annotations

import logging
from typing import Callable

import numpy as np
import pandas as pd
import yaml
from pathlib import Path

from engines.displacement import (
    compute_displacement_cost,
    compute_holding_cost,
    forecast_remaining_demand,
)

log = logging.getLogger(__name__)
POLICY_PATH = Path(__file__).parent.parent / "config" / "policy.yaml"


def _load_policy():
    with open(POLICY_PATH) as f:
        return yaml.safe_load(f)


def compute_expected_contribution(
    p_convert: float,
    fare_per_pax: float,
    k_seats: int,
    displacement_cost: float,
    holding_cost: float,
    attrition: float = 0.9,
) -> float:
    """
    E[contribution] = P × (k × attrition × f - displacement)
                    - (1-P) × holding
    """
    group_revenue  = k_seats * attrition * fare_per_pax
    ec = (p_convert  * (group_revenue - displacement_cost)
          - (1 - p_convert) * holding_cost)
    return float(ec)


def run_optimizer(
    request_features: dict,
    ref_fare: float,
    capacity: float,
    seats_allocated: float,
    ond: str,
    travel_month: int,
    lead_time: float,
    predict_fn: Callable[[pd.DataFrame], np.ndarray],
    policy: dict | None = None,
) -> dict:
    """
    Full grid search over fare × seats × deadline.

    Returns:
        result dict with:
        - recommendation: Accept / Counteroffer / Partial / Reject
        - best_fare, best_seats, best_deadline
        - expected_contribution, baseline_contribution
        - heat_map: DataFrame(fare, seats, ec) for UI
        - fare_curve: DataFrame from fare-response engine
    """
    if policy is None:
        policy = _load_policy()

    attrition        = policy.get("attrition", 0.9)
    fare_floor       = policy.get("fare_floor_pct", 0.70) * ref_fare
    fare_ceil        = policy.get("fare_ceiling_pct", 1.20) * ref_fare
    fare_steps       = policy.get("fare_grid_steps", 11)
    max_share        = policy.get("max_group_share_of_capacity", 0.40)
    max_seats        = int(min(
        policy.get("max_seats_per_group", 80),
        max_share * capacity
    ))
    deadlines_days   = policy.get("option_deadlines_days", [7, 14, 21])
    hold_cost_rate   = policy.get("holding_cost_per_seat_per_day", 0.0)
    min_ec           = policy.get("min_expected_contribution", 0)

    requested_seats = int(request_features.get("group_size", 20))

    fare_grid  = np.linspace(fare_floor, fare_ceil, fare_steps)
    # Never offer more seats than the agent requested — cap at requested_seats
    seats_grid = sorted(set([
        min(requested_seats, max_seats),
        min(int(0.75 * requested_seats), max_seats),
        min(int(0.50 * requested_seats), max_seats),
    ]))
    seats_grid = [s for s in seats_grid if s > 0]

    # Precompute P(convert) for each fare (fare-response curve)
    fare_rows = []
    for fare in fare_grid:
        feat = request_features.copy()
        feat["fare_ratio"]          = fare / ref_fare if ref_fare > 0 else 1.0
        feat["quoted_fare_per_pax"] = fare
        fare_rows.append(feat)

    X_fare = pd.DataFrame(fare_rows)
    p_fare = predict_fn(X_fare)
    # enforce monotone
    p_fare = np.minimum.accumulate(p_fare[::-1])[::-1]

    # remaining individual demand
    remaining_demand = forecast_remaining_demand(
        ond=ond,
        travel_month=travel_month,
        days_to_departure=lead_time,
        capacity=capacity,
    )

    best_ec    = -np.inf
    best_fare  = fare_grid[len(fare_grid)//2]
    best_seats = requested_seats
    best_dead  = deadlines_days[1] if len(deadlines_days) > 1 else 14

    heat_records = []

    for fi, (fare, p) in enumerate(zip(fare_grid, p_fare)):
        for k in seats_grid:
            for deadline in deadlines_days:
                disp_cost = compute_displacement_cost(
                    k_seats=k,
                    remaining_demand=remaining_demand,
                    capacity=capacity,
                    seats_already_allocated=seats_allocated,
                )
                hold_cost = compute_holding_cost(
                    k_seats=k,
                    days_to_option_deadline=deadline,
                    cost_per_seat_per_day=hold_cost_rate,
                )
                ec = compute_expected_contribution(
                    p_convert=float(p),
                    fare_per_pax=fare,
                    k_seats=k,
                    displacement_cost=disp_cost,
                    holding_cost=hold_cost,
                    attrition=attrition,
                )
                heat_records.append({
                    "fare": round(fare),
                    "seats": k,
                    "deadline": deadline,
                    "p_convert": round(float(p), 4),
                    "displacement_cost": round(disp_cost),
                    "expected_contribution": round(ec),
                })
                if ec > best_ec:
                    best_ec    = ec
                    best_fare  = fare
                    best_seats = k
                    best_dead  = deadline

    heat_df = pd.DataFrame(heat_records)

    # Fare-response curve (for UI)
    fare_curve = pd.DataFrame({
        "fare": fare_grid,
        "fare_pct": fare_grid / ref_fare * 100,
        "p_convert": p_fare,
    })

    # --- Decision mapping ---
    requested_fare = request_features.get("quoted_fare_per_pax", ref_fare)
    if requested_fare is None or np.isnan(float(requested_fare)):
        requested_fare = ref_fare

    # P(convert) at the actually quoted fare (not optimizer's best fare)
    p_at_requested = float(p_fare[np.argmin(np.abs(fare_grid - requested_fare))])
    fare_ratio_requested = requested_fare / max(ref_fare, 1)

    high_conf   = policy.get("high_confidence_accept_threshold", 0.50)   # always Accept
    medium_conf = policy.get("medium_confidence_accept_threshold", 0.30)  # Accept if already discounting
    low_conf    = policy.get("low_confidence_accept_threshold", 0.15)     # Accept if big discount

    if best_ec <= min_ec:
        recommendation = "Reject"
    elif best_seats >= requested_seats and requested_fare >= best_fare:
        # Agent quotes AT OR ABOVE our optimizer's best fare.
        # If P(convert) is decent, accept at their (higher) price — take the revenue.
        # If P(convert) is very low, counter at our best (lower) fare to improve conversion.
        if p_at_requested >= low_conf:
            recommendation = "Accept"
            best_fare  = requested_fare
            best_seats = requested_seats
        else:
            recommendation = "Counteroffer"
            # best_fare stays at optimizer's lower fare to improve conversion odds
            best_seats = requested_seats
    elif p_at_requested >= high_conf and best_seats >= requested_seats:
        # Very high confidence — accept at quoted fare regardless
        recommendation = "Accept"
        best_fare  = requested_fare
        best_seats = requested_seats
    elif p_at_requested >= medium_conf and fare_ratio_requested <= 1.0 and best_seats >= requested_seats:
        # Good confidence + agent already quoting at/below reference — take the deal
        recommendation = "Accept"
        best_fare  = requested_fare
        best_seats = requested_seats
    elif p_at_requested >= low_conf and fare_ratio_requested <= 0.85 and best_seats >= requested_seats:
        # Decent confidence + agent giving a significant discount — accept
        recommendation = "Accept"
        best_fare  = requested_fare
        best_seats = requested_seats
    elif best_seats >= requested_seats and abs(best_fare - requested_fare) / max(requested_fare, 1) < 0.05:
        recommendation = "Accept"
    elif best_seats >= requested_seats and best_fare > requested_fare * 1.02:
        recommendation = "Counteroffer"
    elif best_seats < requested_seats:
        recommendation = "Partial"
    else:
        recommendation = "Counteroffer"

    # --- Baseline contribution (historical per-OND accepted fare) ---
    from engines.baseline import baseline_decision
    bl = baseline_decision(
        group_size=requested_seats,
        load_factor=request_features.get("load_factor", 0.5),
        ref_fare=ref_fare,
        capacity=capacity,
        ond=ond,
        policy=policy,
    )
    baseline_ec = compute_expected_contribution(
        p_convert=bl["p_convert_estimate"],
        fare_per_pax=bl["quoted_fare"],
        k_seats=bl["recommended_seats"],
        displacement_cost=0.0,
        holding_cost=0.0,
        attrition=attrition,
    ) if bl["action"] != "Reject" else 0.0

    return {
        "recommendation":        recommendation,
        "best_fare":             round(best_fare),
        "best_seats":            best_seats,
        "best_deadline_days":    best_dead,
        "expected_contribution": round(best_ec),
        "baseline_contribution": round(baseline_ec),
        "lift_vs_baseline":      round(best_ec - baseline_ec),
        "p_convert_at_best":     round(float(p_fare[np.argmin(np.abs(fare_grid - best_fare))]), 4),
        "heat_map":              heat_df,
        "fare_curve":            fare_curve,
        "remaining_demand":      round(float(remaining_demand)) if remaining_demand == remaining_demand else 0,
        "displacement_cost":     round(compute_displacement_cost(
            best_seats, remaining_demand if remaining_demand == remaining_demand else 0.0, capacity, seats_allocated
        )),
    }
