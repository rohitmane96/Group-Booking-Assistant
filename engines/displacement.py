"""
Displacement and inventory engine.
Estimates the cost of blocking k seats for a group by displacing individual demand.
Uses pickup curves from booking_data to forecast remaining individual sales.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data"
CACHE    = DATA_DIR / "cache"

# Booking class → approximate individual fare AED (median estimates from fares_list)
# These are fallback values when live fares_list lookup fails
_BC_FARE_FALLBACK = {
    "E18": 345,
    "E28": 500,
    "E35": 650,
    "E42": 800,
    "E49": 950,
    "E54": 1100,
    "E60": 1300,
    "E70": 1650,
    "DT":  2200,
}
BC_LADDER = list(_BC_FARE_FALLBACK.keys())


def _load_pickup_curves() -> Optional[pd.DataFrame]:
    """Load pre-aggregated pickup curves from parquet cache."""
    pc_path = CACHE / "pickup_curves.parquet"
    if not pc_path.exists():
        log.warning("Pickup curves cache not found; using default demand estimate.")
        return None
    return pd.read_parquet(pc_path)


_PICKUP_CURVES: Optional[pd.DataFrame] = None


def _get_curves():
    global _PICKUP_CURVES
    if _PICKUP_CURVES is None:
        _PICKUP_CURVES = _load_pickup_curves()
    return _PICKUP_CURVES


def forecast_remaining_demand(
    ond: str,
    travel_month: int,
    days_to_departure: int,
    capacity: float = 174.0,
) -> float:
    """
    Estimate remaining individual pax demand between now and departure.
    Returns expected number of additional individual bookings.
    """
    curves = _get_curves()
    if curves is None or days_to_departure is None or np.isnan(days_to_departure):
        # default: 20% of capacity still sells within 30 days of departure
        return 0.20 * capacity

    # match OND (try both directions)
    ond_rev = "/".join(reversed(ond.split("/"))) if "/" in ond else ond
    sub = curves[
        (curves["ond"].isin([ond, ond_rev])) &
        (curves["departure_month"] == travel_month)
    ]
    if sub.empty:
        return 0.20 * capacity

    # cumulative_booked is highest at days_before_departure=0 (departure day)
    # and lowest at the furthest out day — pick the row AT current lead time
    beyond = sub[sub["days_before_departure"] >= days_to_departure]
    if beyond.empty:
        # already past most of the booking window
        at_now = float(sub.loc[sub["days_before_departure"].idxmin(), "cumulative_booked"])
    else:
        idx = (beyond["days_before_departure"] - days_to_departure).abs().idxmin()
        at_now = float(beyond.loc[idx, "cumulative_booked"])

    # total bookings expected by departure (minimum days_before_departure ≈ 0)
    at_dep = float(sub.loc[sub["days_before_departure"].idxmin(), "cumulative_booked"])

    if pd.isna(at_now) or pd.isna(at_dep):
        return 0.20 * capacity

    return max(0.0, float(at_dep - at_now))


def compute_displacement_cost(
    k_seats: int,
    remaining_demand: float,
    capacity: float,
    seats_already_allocated: float,
    bc_fares: dict | None = None,
) -> float:
    """
    Displacement cost of blocking k seats for a group.

    Displaced = max(0, k + forecast_demand - remaining_capacity)
    Each displaced seat valued at EMSR-style bid price of the class that closes.

    Returns total displacement cost in AED.
    """
    if bc_fares is None:
        bc_fares = _BC_FARE_FALLBACK

    remaining_capacity = max(0.0, capacity - seats_already_allocated - k_seats)
    displaced = max(0.0, remaining_demand - remaining_capacity)
    displaced = min(displaced, k_seats)   # can't displace more than group takes

    # bid price: approximately the median fare of the closing booking class
    # simplification: use median of BC_LADDER fares weighted by displaced fraction
    if displaced == 0:
        return 0.0

    # estimate closing fare as average of top-half booking classes
    top_half_bcs = BC_LADDER[len(BC_LADDER)//2:]
    avg_bid = np.mean([bc_fares.get(bc, _BC_FARE_FALLBACK.get(bc, 1000)) for bc in top_half_bcs])

    return float(displaced * avg_bid)


def compute_holding_cost(
    k_seats: int,
    days_to_option_deadline: float,
    cost_per_seat_per_day: float = 0.0,
) -> float:
    """
    Cost of holding k seats blocked until option deadline (may be released unsold).
    Default = 0 (no explicit holding charge), but set in policy if desired.
    """
    return float(k_seats * days_to_option_deadline * cost_per_seat_per_day)
