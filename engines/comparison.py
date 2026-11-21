"""
Like-for-like comparison of the AI optimizer against the rule-based baseline.

Why this module exists
----------------------
`engines.baseline.baseline_decision` returns the baseline *decision* (fare, seats, accept/reject)
together with a flat 3% conversion estimate. `run_optimizer` multiplies that flat 3% by the
baseline fare and ignores displacement/holding cost, while the AI side uses the model's
fare-response curve and subtracts displacement cost. Comparing those two numbers mixes a
different conversion assumption and a different contribution definition into the "lift".

This module re-evaluates the *same baseline decision* (same fare, same seats, same
accept/reject rule) under the *same* contribution model the optimizer uses:

  * P(convert): the optimizer's monotone fare-response curve, interpolated at the baseline fare
  * displacement cost: `compute_displacement_cost` for the baseline seat count
  * holding cost: `compute_holding_cost` at the optimizer's default deadline (the baseline has
    no deadline logic)
  * attrition (no-show) and seat caps: from `config/policy.yaml`, identical for both sides

No business rule is changed; the optimizer and the baseline decision logic are untouched.
"""
from __future__ import annotations

import numpy as np

from engines.baseline import baseline_decision
from engines.displacement import (
    compute_displacement_cost,
    compute_holding_cost,
    forecast_remaining_demand,
)
from engines.optimizer import _load_policy, compute_expected_contribution


def _evaluate(
    curve_fares: np.ndarray,
    curve_p: np.ndarray,
    fare: float,
    seats: int,
    deadline_days: int,
    *,
    remaining_demand: float,
    capacity: float,
    seats_allocated: float,
    hold_rate: float,
    attrition: float,
) -> tuple[float, float, float]:
    """Expected contribution of (fare, seats, deadline) on the shared fare-response curve."""
    p = float(np.interp(fare, curve_fares, curve_p))
    disp = compute_displacement_cost(
        k_seats=seats,
        remaining_demand=remaining_demand,
        capacity=capacity,
        seats_already_allocated=seats_allocated,
    )
    hold = compute_holding_cost(
        k_seats=seats,
        days_to_option_deadline=deadline_days,
        cost_per_seat_per_day=hold_rate,
    )
    ec = compute_expected_contribution(
        p_convert=p,
        fare_per_pax=fare,
        k_seats=seats,
        displacement_cost=disp,
        holding_cost=hold,
        attrition=attrition,
    )
    return float(ec), p, float(disp)


def evaluate_strategies(
    *,
    request_features: dict,
    ref_fare: float,
    capacity: float,
    seats_allocated: float,
    ond: str,
    travel_month: int,
    lead_time: float,
    ai_result: dict,
    policy: dict | None = None,
) -> dict:
    """
    Compare AI vs baseline for ONE request on identical assumptions.

    `ai_result` is the dict returned by `run_optimizer` for the same request.

    Returns per-strategy decision/contribution plus a step-wise attribution of the difference:
      fare        change from the baseline fare to the AI fare (baseline seats, baseline deadline)
      seats       change from the baseline seat count to the AI seat count
      deadline    change from the baseline deadline to the AI deadline (absorbs rounding of the
                  AI headline figure)
      opportunity requests where exactly one strategy declines the request entirely
    The four effects always sum to ai.expected_contribution - baseline.expected_contribution.
    """
    if policy is None:
        policy = _load_policy()

    attrition = policy.get("attrition", 0.9)
    hold_rate = policy.get("holding_cost_per_seat_per_day", 0.0)
    max_share = policy.get("max_group_share_of_capacity", 0.40)
    max_seats = int(min(policy.get("max_seats_per_group", 80), max_share * capacity))
    deadlines = policy.get("option_deadlines_days", [7, 14, 21])
    baseline_deadline = deadlines[1] if len(deadlines) > 1 else deadlines[0]
    requested = int(request_features.get("group_size", 20))

    curve = ai_result["fare_curve"]
    fares = curve["fare"].to_numpy(dtype=float)
    probs = curve["p_convert"].to_numpy(dtype=float)

    remaining = forecast_remaining_demand(
        ond=ond, travel_month=travel_month, days_to_departure=lead_time, capacity=capacity
    )
    common = dict(
        remaining_demand=remaining, capacity=capacity, seats_allocated=seats_allocated,
        hold_rate=hold_rate, attrition=attrition,
    )

    # ── baseline: same decision rule as engines.baseline, same seat cap as the optimizer ──
    bl = baseline_decision(
        group_size=requested,
        load_factor=request_features.get("load_factor", 0.5),
        ref_fare=ref_fare,
        capacity=capacity,
        ond=ond,
        policy=policy,
    )
    b_action = bl["action"]
    b_fare = float(bl["quoted_fare"])
    b_seats = 0 if b_action == "Reject" else min(int(bl["recommended_seats"]), max_seats)
    if b_action != "Reject" and b_seats < requested:
        b_action = "Partial"

    if b_action == "Reject" or b_seats <= 0:
        b_ec, b_p, b_disp = 0.0, 0.0, 0.0
    else:
        b_ec, b_p, b_disp = _evaluate(fares, probs, b_fare, b_seats, baseline_deadline, **common)

    # ── AI: the optimizer's own recommendation (a rejected request is not pursued → AED 0) ──
    a_decision = ai_result["recommendation"]
    a_fare = float(ai_result["best_fare"])
    a_seats = int(ai_result["best_seats"])
    a_deadline = int(ai_result["best_deadline_days"])
    a_raw = float(ai_result["expected_contribution"])
    a_pursued = a_decision != "Reject"
    a_ec = a_raw if a_pursued else 0.0
    a_p = float(ai_result["p_convert_at_best"]) if a_pursued else 0.0
    a_disp = float(ai_result["displacement_cost"]) if a_pursued else 0.0

    # ── attribution of the difference ──
    effects = {"fare": 0.0, "seats": 0.0, "deadline": 0.0, "opportunity": 0.0}
    b_pursued = b_action != "Reject" and b_seats > 0
    if b_pursued and a_pursued:
        ec1, _, _ = _evaluate(fares, probs, a_fare, b_seats, baseline_deadline, **common)
        ec2, _, _ = _evaluate(fares, probs, a_fare, a_seats, baseline_deadline, **common)
        effects["fare"] = ec1 - b_ec
        effects["seats"] = ec2 - ec1
        effects["deadline"] = a_ec - ec2
    else:
        effects["opportunity"] = a_ec - b_ec

    return {
        "requested_seats": requested,
        "ai": {
            "decision": a_decision,
            "expected_contribution": a_ec,
            "fare": a_fare,
            "fare_pct": a_fare / ref_fare * 100 if ref_fare > 0 else None,
            "seats": a_seats if a_pursued else 0,
            "deadline_days": a_deadline,
            "p_convert": a_p,
            "displacement_cost": a_disp,
        },
        "baseline": {
            "decision": b_action,
            "expected_contribution": b_ec,
            "fare": b_fare,
            "fare_pct": b_fare / ref_fare * 100 if ref_fare > 0 else None,
            "seats": b_seats,
            "deadline_days": baseline_deadline,
            "p_convert": b_p,
            "displacement_cost": b_disp,
            "fare_ratio_source": bl.get("fare_ratio_source"),
            "load_factor_known": request_features.get("load_factor") is not None
            and not (isinstance(request_features.get("load_factor"), float) and np.isnan(request_features.get("load_factor"))),
        },
        "effects": effects,
        "incremental": a_ec - b_ec,
    }
