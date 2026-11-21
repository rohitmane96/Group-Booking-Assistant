"""
Fare-response curve engine.
Scores the same request at a grid of fares (70%–120% of reference fare, 5% steps).
Monotone constraint ensures P(convert) always falls as fare rises.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import yaml
from pathlib import Path

POLICY_PATH = Path(__file__).parent.parent / "config" / "policy.yaml"


def _load_policy():
    with open(POLICY_PATH) as f:
        return yaml.safe_load(f)


def compute_fare_curve(
    base_features: dict,
    ref_fare: float,
    predict_fn,                   # callable(X: pd.DataFrame) → np.ndarray of probabilities
    policy: dict | None = None,
) -> pd.DataFrame:
    """
    Returns a DataFrame with columns: fare, fare_pct, p_convert.
    base_features: feature dict for the request (all features except fare_ratio).
    ref_fare: reference individual fare (AED).
    predict_fn: calibrated model predict function.
    """
    if policy is None:
        policy = _load_policy()

    floor = policy.get("fare_floor_pct", 0.70)
    ceil_ = policy.get("fare_ceiling_pct", 1.20)
    steps = policy.get("fare_grid_steps", 11)

    pct_grid = np.linspace(floor, ceil_, steps)
    fare_grid = pct_grid * ref_fare

    rows = []
    for pct, fare in zip(pct_grid, fare_grid):
        feat = base_features.copy()
        feat["fare_ratio"] = pct          # pct is relative to reference fare
        feat["quoted_fare_per_pax"] = fare
        rows.append(feat)

    X = pd.DataFrame(rows)
    probs = predict_fn(X)

    # enforce strict monotone decrease (higher fare → lower P)
    probs_mono = np.minimum.accumulate(probs[::-1])[::-1]

    result = pd.DataFrame({
        "fare":     fare_grid,
        "fare_pct": pct_grid * 100,
        "p_convert": probs_mono,
    })
    return result


def elasticity_curve(
    base_p: float,
    ref_fare: float,
    elasticity: float = -1.5,
    policy: dict | None = None,
) -> pd.DataFrame:
    """
    Fallback: purely simulation-based fare curve using elasticity assumption.
    Used when model has insufficient fare variation.
    """
    if policy is None:
        policy = _load_policy()

    floor = policy.get("fare_floor_pct", 0.70)
    ceil_ = policy.get("fare_ceiling_pct", 1.20)
    steps = policy.get("fare_grid_steps", 11)

    pct_grid = np.linspace(floor, ceil_, steps)
    fare_grid = pct_grid * ref_fare

    # P(f) = P(ref) * (f / ref)^elasticity
    # capped at [0, 1]
    probs = base_p * (pct_grid ** elasticity)
    probs = np.clip(probs, 0.0, 1.0)
    probs = np.minimum.accumulate(probs[::-1])[::-1]  # enforce monotone

    return pd.DataFrame({
        "fare":     fare_grid,
        "fare_pct": pct_grid * 100,
        "p_convert": probs,
        "is_simulated": True,
    })
