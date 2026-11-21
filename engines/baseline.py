"""
Rule-based baseline for comparison.
Quotes a fixed % of reference fare; accepts if seats available ≥ group size
and load factor below threshold.
"""
from __future__ import annotations

import yaml
from pathlib import Path

POLICY_PATH = Path(__file__).parent.parent / "config" / "policy.yaml"


def _load_policy():
    with open(POLICY_PATH) as f:
        return yaml.safe_load(f)


def baseline_decision(
    group_size: int,
    load_factor: float,
    ref_fare: float,
    capacity: float,
    policy: dict | None = None,
) -> dict:
    """
    Returns baseline action dict:
      action: Accept / Partial / Reject
      quoted_fare, recommended_seats, p_convert_estimate
    """
    if policy is None:
        policy = _load_policy()

    fare_pct    = policy.get("baseline_fare_pct_of_reference", 0.90)
    max_lf      = policy.get("baseline_max_load_factor", 0.75)
    max_share   = policy.get("max_group_share_of_capacity", 0.40)

    ref_fare    = float(ref_fare) if ref_fare and not (isinstance(ref_fare, float) and ref_fare != ref_fare) else 1000.0
    capacity    = float(capacity) if capacity and not (isinstance(capacity, float) and capacity != capacity) else 174.0
    group_size  = int(group_size) if group_size and not (isinstance(group_size, float) and group_size != group_size) else 20
    load_factor = float(load_factor) if load_factor and not (isinstance(load_factor, float) and load_factor != load_factor) else 0.5

    quoted_fare       = ref_fare * fare_pct
    max_allowed_seats = int(capacity * max_share)
    seats_to_offer    = min(group_size, max_allowed_seats)

    if load_factor > max_lf:
        action = "Reject"
        seats_to_offer = 0
    elif seats_to_offer < group_size:
        action = "Partial"
    else:
        action = "Accept"

    # naïve P(convert) estimate: 0.10 if accept, else 0
    p_convert = 0.10 if action != "Reject" else 0.0

    return {
        "action":              action,
        "quoted_fare":         round(quoted_fare),
        "recommended_seats":   seats_to_offer,
        "p_convert_estimate":  p_convert,
        "load_factor_check":   load_factor <= max_lf,
    }
