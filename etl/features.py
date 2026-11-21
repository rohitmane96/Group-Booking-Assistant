"""
Feature engineering: build quote-time snapshot for each Request ID.
No future-leaking fields (Status, Last Updated, Remark excluded).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import duckdb
import numpy as np
import pandas as pd

from etl.build_snapshots import get_connection, DATA_DIR

log = logging.getLogger(__name__)

CACHE = DATA_DIR / "cache"

# Full E-class ladder (E1 → E70, then DT). Built dynamically.
def _build_bc_ladder() -> list[str]:
    """Return E-class booking codes sorted cheapest→premium."""
    return [f"E{i}" for i in range(1, 71)] + ["DT"]

BC_LADDER = _build_bc_ladder()


def _lowest_open_bc(inv_rows: pd.DataFrame) -> Optional[str]:
    """Return the lowest booking class with available_seats > 0."""
    avail = inv_rows[inv_rows["available_seats"] > 0]["bc_code"].tolist()
    # sort by ladder position
    ladder_pos = {bc: i for i, bc in enumerate(BC_LADDER)}
    avail_sorted = sorted(avail, key=lambda bc: ladder_pos.get(bc, 999))
    return avail_sorted[0] if avail_sorted else None


def build_features(con: Optional[duckdb.DuckDBPyConnection] = None,
                   use_cache: bool = True) -> pd.DataFrame:
    """Return feature matrix for all Request IDs (non-live rows get labels)."""

    cache_path = CACHE / "features.parquet"
    if use_cache and cache_path.exists():
        log.info("Loading features from cache …")
        return pd.read_parquet(cache_path)

    if con is None:
        con = get_connection()

    log.info("Building feature matrix …")

    gq = con.execute("SELECT * FROM group_quote").df()
    fi = con.execute("SELECT * FROM flight_inventory").df()
    fl = con.execute("SELECT * FROM fares_list").df()

    fi["departure_date"] = pd.to_datetime(fi["departure_date"]).dt.date

    rows = []
    for _, req in gq.iterrows():
        flight_num  = req.get("primary_flight_number")
        dep_dt      = req.get("primary_departure")
        created_on  = req.get("Created On")

        # --- inventory features ---
        inv = pd.DataFrame()
        if flight_num and pd.notna(dep_dt):
            dep_date = pd.to_datetime(dep_dt).date()
            inv = fi[
                (fi["flight_number"] == flight_num) &
                (fi["departure_date"] == dep_date)
            ]

        total_capacity   = inv["adult_capacity"].max() if not inv.empty else np.nan
        seats_available  = inv["available_seats"].sum() if not inv.empty else np.nan
        seats_allocated  = inv["allocated_seats"].sum() if not inv.empty else np.nan
        load_factor      = (
            seats_allocated / total_capacity
            if (total_capacity and total_capacity > 0)
            else np.nan
        )

        # seats available in lowest 3 booking classes
        low_bc_avail = np.nan
        if not inv.empty:
            low_bcs = inv[inv["bc_code"].isin(BC_LADDER[:3])]["available_seats"].sum()
            low_bc_avail = float(low_bcs)

        lowest_bc = _lowest_open_bc(inv) if not inv.empty else None

        # --- reference fare from fares_list ---
        ref_fare = np.nan
        ond = req.get("OND 1", "")
        if ond and pd.notna(ond) and pd.notna(created_on):
            ond_rev = "/".join(reversed(ond.split("/"))) if "/" in ond else ond
            created_ts = pd.to_datetime(created_on)

            # filter by OND (try exact match first, then partial)
            fl_ond = fl[fl["ond_labels"].isin([ond, ond_rev])]
            if fl_ond.empty:
                fl_ond = fl[fl["ond_labels"].str.startswith(ond, na=False) |
                            fl["ond_labels"].str.startswith(ond_rev, na=False)]

            if not fl_ond.empty:
                # filter by booking class if found, else use all classes for OND
                if lowest_bc:
                    fl_bc = fl_ond[fl_ond["booking_class_id"] == lowest_bc]
                    if fl_bc.empty:
                        fl_bc = fl_ond  # fallback: use any class
                else:
                    fl_bc = fl_ond

                # filter by sale validity, allowing NaT (treat NaT as "always valid")
                valid_from_ok = fl_bc["sale_valid_from"].isna() | (fl_bc["sale_valid_from"] <= created_ts)
                valid_to_ok   = fl_bc["sale_valid_to"].isna()   | (fl_bc["sale_valid_to"]   >= created_ts)
                fl_match = fl_bc[valid_from_ok & valid_to_ok]

                if not fl_match.empty:
                    ref_fare = fl_match["adult_value"].median()
                elif not fl_bc.empty:
                    ref_fare = fl_bc["adult_value"].median()  # ignore date filter

        # --- fare features ---
        # Airline Quoted Fare is ALREADY per passenger in the source data
        passengers      = req.get("Passengers", np.nan)
        airline_quoted  = req.get("Airline Quoted Fare", np.nan)
        quoted_per_pax  = airline_quoted   # per-pax value directly

        fare_ratio = (
            quoted_per_pax / ref_fare
            if (pd.notna(quoted_per_pax) and pd.notna(ref_fare) and ref_fare > 0
                and quoted_per_pax > 0)
            else np.nan
        )

        # --- temporal features ---
        lead_time = np.nan
        dow_travel = np.nan
        month_travel = np.nan
        if pd.notna(dep_dt) and pd.notna(created_on):
            dep_dt_ts = pd.to_datetime(dep_dt)
            created_ts = pd.to_datetime(created_on)
            lead_time  = (dep_dt_ts - created_ts).days
            dow_travel = dep_dt_ts.dayofweek
            month_travel = dep_dt_ts.month

        rows.append({
            "request_id":           req["Request ID"],
            "group_request_id":     req["Group Request ID"],
            "created_on":           created_on,
            "status":               req.get("Status"),
            "is_live":              req.get("is_live", False),
            "converted":            req.get("converted", np.nan),
            # group features
            "group_size":           passengers,
            "ond":                  ond,
            "trip_type":            req.get("Trip Type"),
            "agent_code":           req.get("Agent Code"),
            "num_options":          req.get("num_options_per_group", 1),
            # fare features
            "quoted_fare_per_pax":  quoted_per_pax,
            "ref_fare":             ref_fare,
            "fare_ratio":           fare_ratio,
            "competitor_fare":      req.get("Competitor Fare", np.nan),
            # inventory features
            "load_factor":          load_factor,
            "seats_available":      seats_available,
            "low_bc_seats_avail":   low_bc_avail,
            "total_capacity":       total_capacity,
            # temporal
            "lead_time":            lead_time,
            "dow_travel":           dow_travel,
            "month_travel":         month_travel,
            "created_month":        pd.to_datetime(created_on).month if pd.notna(created_on) else np.nan,
            # flight
            "flight_number":        flight_num,
            "departure_dt":         dep_dt,
        })

    feat = pd.DataFrame(rows)

    # --- agent history (as-of join: earlier requests only) ---
    feat = feat.sort_values("created_on")
    feat["agent_prior_requests"]   = 0
    feat["agent_prior_converted"]  = 0
    feat["agent_conv_rate"]        = 0.0

    agent_requests  = {}
    agent_converted = {}
    for idx, row in feat.iterrows():
        agent = row["agent_code"]
        if pd.notna(agent):
            feat.at[idx, "agent_prior_requests"]  = agent_requests.get(agent, 0)
            feat.at[idx, "agent_prior_converted"] = agent_converted.get(agent, 0)
            prior_req = agent_requests.get(agent, 0)
            feat.at[idx, "agent_conv_rate"] = (
                agent_converted.get(agent, 0) / prior_req if prior_req > 0 else 0.0
            )
            agent_requests[agent]  = agent_requests.get(agent, 0) + 1
            if row["converted"] == 1:
                agent_converted[agent] = agent_converted.get(agent, 0) + 1

    # --- route history (as-of) ---
    feat["route_prior_requests"]  = 0
    feat["route_prior_converted"] = 0
    feat["route_conv_rate"]       = 0.0

    route_requests  = {}
    route_converted = {}
    for idx, row in feat.iterrows():
        ond_key = row["ond"]
        if pd.notna(ond_key):
            feat.at[idx, "route_prior_requests"]  = route_requests.get(ond_key, 0)
            feat.at[idx, "route_prior_converted"] = route_converted.get(ond_key, 0)
            prior_req = route_requests.get(ond_key, 0)
            feat.at[idx, "route_conv_rate"] = (
                route_converted.get(ond_key, 0) / prior_req if prior_req > 0 else 0.0
            )
            route_requests[ond_key]  = route_requests.get(ond_key, 0) + 1
            if row["converted"] == 1:
                route_converted[ond_key] = route_converted.get(ond_key, 0) + 1

    CACHE.mkdir(exist_ok=True)
    feat.to_parquet(cache_path, index=False)
    log.info("Feature matrix: %d rows, %d converted", len(feat), feat["converted"].sum())
    return feat


FEATURE_COLS = [
    "group_size", "num_options", "fare_ratio", "load_factor",
    "seats_available", "low_bc_seats_avail", "lead_time",
    "dow_travel", "month_travel", "created_month",
    "agent_prior_requests", "agent_conv_rate",
    "route_prior_requests", "route_conv_rate",
]

CATEGORICAL_COLS = ["trip_type", "agent_code"]


def get_X_y(feat: pd.DataFrame, exclude_live: bool = True):
    """Return (X, y) for model training."""
    df = feat.copy()
    if exclude_live:
        df = df[~df["is_live"].fillna(False)]
    df = df.dropna(subset=["converted"])

    # encode categoricals
    df["trip_type_enc"] = (df["trip_type"] == "ONE_WAY").astype(float)

    num_cols = FEATURE_COLS + ["trip_type_enc"]
    X = df[num_cols].copy()
    y = df["converted"].astype(int)
    return X, y


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    feat = build_features(use_cache=False)
    print(feat.head())
