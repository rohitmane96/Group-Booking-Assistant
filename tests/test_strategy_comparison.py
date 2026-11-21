"""
Checks for the AI-vs-baseline comparison (engines/comparison.py).

Run inside the API container:
    docker compose exec -T api python -m tests.test_strategy_comparison
or with pytest if installed:
    pytest tests/test_strategy_comparison.py
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from engines.comparison import evaluate_strategies
from engines.displacement import compute_displacement_cost, compute_holding_cost
from engines.optimizer import compute_expected_contribution, run_optimizer, _load_policy


def _flat_predict(p: float):
    return lambda X: np.full(len(X), p, dtype=float)


def _declining_predict(X: pd.DataFrame) -> np.ndarray:
    # conversion falls as the fare ratio rises, like a real fare-response curve
    return np.clip(0.12 - 0.08 * (X["fare_ratio"].to_numpy() - 0.7), 0.01, 0.2)


def _run(predict_fn, group_size=30, load_factor=0.5, ref_fare=1000.0, capacity=174.0, allocated=80.0):
    feats = {"group_size": group_size, "load_factor": load_factor, "quoted_fare_per_pax": ref_fare}
    result = run_optimizer(
        request_features=feats, ref_fare=ref_fare, capacity=capacity, seats_allocated=allocated,
        ond="SHJ/DEL", travel_month=12, lead_time=20, predict_fn=predict_fn,
    )
    cmp = evaluate_strategies(
        request_features=feats, ref_fare=ref_fare, capacity=capacity, seats_allocated=allocated,
        ond="SHJ/DEL", travel_month=12, lead_time=20, ai_result=result,
    )
    return feats, result, cmp


def test_effects_sum_to_incremental():
    for predict in (_flat_predict(0.05), _declining_predict):
        for lf in (0.5, 0.9):  # 0.9 > 75% → baseline rejects
            _, _, cmp = _run(predict, load_factor=lf)
            assert math.isclose(sum(cmp["effects"].values()), cmp["incremental"], abs_tol=1e-6)
            assert math.isclose(
                cmp["incremental"], cmp["ai"]["expected_contribution"] - cmp["baseline"]["expected_contribution"], abs_tol=1e-6
            )


def test_baseline_uses_same_conversion_curve_as_ai():
    """With a flat curve, P(convert) must be identical for both strategies (no hidden 3% assumption)."""
    _, _, cmp = _run(_flat_predict(0.07))
    assert math.isclose(cmp["baseline"]["p_convert"], 0.07, abs_tol=1e-9)
    assert math.isclose(cmp["ai"]["p_convert"], 0.07, abs_tol=1e-3)


def test_baseline_contribution_matches_optimizer_formula():
    feats, result, cmp = _run(_declining_predict)
    policy = _load_policy()
    b = cmp["baseline"]
    disp = compute_displacement_cost(
        k_seats=b["seats"], remaining_demand=__import__("engines.displacement", fromlist=["x"]).forecast_remaining_demand(
            ond="SHJ/DEL", travel_month=12, days_to_departure=20, capacity=174.0),
        capacity=174.0, seats_already_allocated=80.0)
    hold = compute_holding_cost(k_seats=b["seats"], days_to_option_deadline=b["deadline_days"],
                                cost_per_seat_per_day=policy.get("holding_cost_per_seat_per_day", 0.0))
    expected = compute_expected_contribution(b["p_convert"], b["fare"], b["seats"], disp, hold, policy.get("attrition", 0.9))
    assert math.isclose(b["expected_contribution"], expected, rel_tol=1e-9, abs_tol=1e-6)


def test_baseline_rejects_above_load_factor_threshold():
    _, _, cmp = _run(_declining_predict, load_factor=0.9)
    assert cmp["baseline"]["decision"] == "Reject"
    assert cmp["baseline"]["expected_contribution"] == 0.0
    assert cmp["baseline"]["seats"] == 0
    # the whole difference is then attributed to the opportunity the baseline walked away from
    assert math.isclose(cmp["effects"]["opportunity"], cmp["incremental"], abs_tol=1e-6)


def test_ai_never_scores_below_zero_when_it_declines():
    _, _, cmp = _run(_flat_predict(0.0), group_size=30)
    if cmp["ai"]["decision"] == "Reject":
        assert cmp["ai"]["expected_contribution"] == 0.0


def test_same_seat_cap_for_both_strategies():
    _, _, cmp = _run(_declining_predict, group_size=200, capacity=174.0)
    cap = int(min(_load_policy().get("max_seats_per_group", 80), _load_policy().get("max_group_share_of_capacity", 0.4) * 174.0))
    assert cmp["baseline"]["seats"] <= cap and cmp["ai"]["seats"] <= cap


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("PASS", t.__name__)
    print(f"{len(tests)} passed")
