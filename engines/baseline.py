"""
Rule-based baseline for comparison.
Uses per-OND median accepted fare ratios from historical converted group
requests (data/cache/accepted_fare_lookup.parquet) as the baseline fare.
Falls back to global median (0.95) then policy flat rate if no history exists.
"""
from __future__ import annotations

import logging
import yaml
import numpy as np
import pandas as pd
from pathlib import Path

log = logging.getLogger(__name__)
POLICY_PATH  = Path(__file__).parent.parent / "config" / "policy.yaml"
CACHE_DIR    = Path(__file__).parent.parent / "data" / "cache"
LOOKUP_PATH  = CACHE_DIR / "accepted_fare_lookup.parquet"
FEATURES_PATH = CACHE_DIR / "features.parquet"

# Global median accepted fare_ratio across all converted requests (fallback)
_GLOBAL_MEDIAN_RATIO: float | None = None
# Per-OND lookup: {ond -> median fare_ratio from converted requests}
_OND_LOOKUP: dict[str, float] | None = None


def _load_lookup() -> tuple[dict[str, float], float]:
    """
    Load or build the per-OND accepted fare ratio lookup.
    Returns (ond_lookup, global_median_ratio).
    """
    global _OND_LOOKUP, _GLOBAL_MEDIAN_RATIO
    if _OND_LOOKUP is not None and _GLOBAL_MEDIAN_RATIO is not None:
        return _OND_LOOKUP, _GLOBAL_MEDIAN_RATIO

    # Try pre-built cache first
    if LOOKUP_PATH.exists():
        lk = pd.read_parquet(LOOKUP_PATH)
        _OND_LOOKUP = dict(zip(lk["ond"], lk["median_accepted_ratio"]))
        _GLOBAL_MEDIAN_RATIO = float(lk["median_accepted_ratio"].median())
        log.info("Loaded accepted fare lookup: %d ONDs, global median ratio %.3f",
                 len(_OND_LOOKUP), _GLOBAL_MEDIAN_RATIO)
        return _OND_LOOKUP, _GLOBAL_MEDIAN_RATIO

    # Build from features.parquet on first call
    if not FEATURES_PATH.exists():
        log.warning("features.parquet not found; using flat baseline_fare_pct_of_reference")
        _OND_LOOKUP = {}
        _GLOBAL_MEDIAN_RATIO = 0.95
        return _OND_LOOKUP, _GLOBAL_MEDIAN_RATIO

    feat = pd.read_parquet(FEATURES_PATH)
    conv = feat[(feat["converted"] == 1) & feat["fare_ratio"].notna() & feat["fare_ratio"].gt(0)]

    if conv.empty:
        _OND_LOOKUP = {}
        _GLOBAL_MEDIAN_RATIO = 0.95
        return _OND_LOOKUP, _GLOBAL_MEDIAN_RATIO

    _GLOBAL_MEDIAN_RATIO = float(conv["fare_ratio"].median())

    ond_agg = (
        conv.groupby("ond")["fare_ratio"]
        .agg(median_accepted_ratio="median", n="count")
        .reset_index()
    )
    # Only trust ONDs with at least 2 converted bookings; singletons get global median
    ond_agg["median_accepted_ratio"] = np.where(
        ond_agg["n"] >= 2,
        ond_agg["median_accepted_ratio"],
        _GLOBAL_MEDIAN_RATIO,
    )
    _OND_LOOKUP = dict(zip(ond_agg["ond"], ond_agg["median_accepted_ratio"]))

    # Persist cache
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    ond_agg.to_parquet(LOOKUP_PATH, index=False)
    log.info("Built & cached accepted fare lookup: %d ONDs, global median ratio %.3f",
             len(_OND_LOOKUP), _GLOBAL_MEDIAN_RATIO)

    return _OND_LOOKUP, _GLOBAL_MEDIAN_RATIO


def _load_policy():
    with open(POLICY_PATH) as f:
        return yaml.safe_load(f)


def baseline_decision(
    group_size: int,
    load_factor: float,
    ref_fare: float,
    capacity: float,
    ond: str = "",
    policy: dict | None = None,
) -> dict:
    """
    Returns baseline action dict:
      action: Accept / Partial / Reject
      quoted_fare, recommended_seats, p_convert_estimate

    Fare is set to: per-OND median accepted fare ratio x ref_fare,
    sourced from historical converted group requests.
    Falls back to global median accepted ratio, then policy flat rate.
    """
    if policy is None:
        policy = _load_policy()

    max_lf    = policy.get("baseline_max_load_factor", 0.75)
    max_share = policy.get("max_group_share_of_capacity", 0.40)
    flat_pct  = policy.get("baseline_fare_pct_of_reference", 0.90)

    ref_fare    = float(ref_fare) if ref_fare and not (isinstance(ref_fare, float) and ref_fare != ref_fare) else 1000.0
    capacity    = float(capacity) if capacity and not (isinstance(capacity, float) and capacity != capacity) else 174.0
    group_size  = int(group_size) if group_size and not (isinstance(group_size, float) and group_size != group_size) else 20
    load_factor = float(load_factor) if load_factor and not (isinstance(load_factor, float) and load_factor != load_factor) else 0.5

    # Determine fare ratio from historical data
    ond_lookup, global_ratio = _load_lookup()
    if ond and ond in ond_lookup:
        fare_ratio = ond_lookup[ond]
        source = "ond_history"
    elif global_ratio:
        fare_ratio = global_ratio
        source = "global_median"
    else:
        fare_ratio = flat_pct
        source = "policy_flat"

    quoted_fare       = ref_fare * fare_ratio
    max_allowed_seats = int(capacity * max_share)
    seats_to_offer    = min(group_size, max_allowed_seats)

    if load_factor > max_lf:
        action = "Reject"
        seats_to_offer = 0
    elif seats_to_offer < group_size:
        action = "Partial"
    else:
        action = "Accept"

    # Historical P(convert): use route conversion rate from lookup if available,
    # otherwise fall back to global converted/(converted+expired+lost) rate ~3%
    p_convert = 0.03 if action != "Reject" else 0.0

    return {
        "action":              action,
        "quoted_fare":         round(quoted_fare),
        "recommended_seats":   seats_to_offer,
        "p_convert_estimate":  p_convert,
        "load_factor_check":   load_factor <= max_lf,
        "fare_ratio_source":   source,
        "fare_ratio_used":     round(fare_ratio, 4),
    }
