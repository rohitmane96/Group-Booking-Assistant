"""
Feature engineering: build quote-time snapshot for each Request ID.
No future-leaking fields (Status, Last Updated, Remark excluded).
Vectorized rewrite: inventory via merge/groupby, fares via OND-grouped
cross-join — reduces runtime from ~120s to ~10s.
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
_LADDER_POS = {bc: i for i, bc in enumerate(BC_LADDER)}
_LOW_BCS = set(BC_LADDER[:3])


# ── Vectorized inventory helpers ───────────────────────────────────────────

def _build_inventory_features(gq: pd.DataFrame, fi: pd.DataFrame) -> pd.DataFrame:
    """Merge gq with fi on (flight_number, departure_date), aggregate per request."""
    fi = fi.copy()
    fi["departure_date"] = pd.to_datetime(fi["departure_date"], errors="coerce").dt.date
    gq = gq.copy()
    gq["_dep_date"] = pd.to_datetime(gq["primary_departure"], errors="coerce").dt.date

    merged = gq[["Request ID", "primary_flight_number", "_dep_date"]].merge(
        fi[["flight_number", "departure_date", "adult_capacity",
            "available_seats", "allocated_seats", "bc_code"]],
        left_on=["primary_flight_number", "_dep_date"],
        right_on=["flight_number", "departure_date"],
        how="left",
    )

    agg = merged.groupby("Request ID").agg(
        total_capacity=("adult_capacity", "max"),
        seats_available=("available_seats", "sum"),
        seats_allocated=("allocated_seats", "sum"),
    )
    agg["load_factor"] = np.where(
        agg["total_capacity"] > 0,
        agg["seats_allocated"] / agg["total_capacity"],
        np.nan,
    )

    low_bc = (
        merged[merged["bc_code"].isin(_LOW_BCS)]
        .groupby("Request ID")["available_seats"]
        .sum()
        .rename("low_bc_seats_avail")
    )
    agg = agg.join(low_bc)

    avail = merged[merged["available_seats"] > 0].copy()
    if not avail.empty:
        avail["_bc_rank"] = avail["bc_code"].map(lambda x: _LADDER_POS.get(x, 999))
        lowest_bc = (
            avail.sort_values("_bc_rank")
            .groupby("Request ID")["bc_code"]
            .first()
            .rename("lowest_bc")
        )
        agg = agg.join(lowest_bc)
    else:
        agg["lowest_bc"] = np.nan

    return agg


# ── Vectorized fares helper ────────────────────────────────────────────────

def _ond_fl_indices(fl: pd.DataFrame, ond: str) -> pd.Index:
    """Return fl row indices matching ond (exact → reversed → startswith)."""
    ond_rev = "/".join(reversed(ond.split("/"))) if "/" in ond else ond
    mask = fl["ond_labels"].isin([ond, ond_rev])
    if not mask.any():
        mask = (
            fl["ond_labels"].str.startswith(ond, na=False)
            | fl["ond_labels"].str.startswith(ond_rev, na=False)
        )
    return fl.index[mask]


def _build_fare_features(
    gq: pd.DataFrame,
    fl: pd.DataFrame,
    inv_agg: pd.DataFrame,
) -> pd.Series:
    """
    For each Request ID return ref_fare.
    Groups by unique OND so each OND scans fl only once.
    """
    fl_cols = fl[["ond_labels", "booking_class_id",
                  "sale_valid_from", "sale_valid_to", "adult_value"]]

    req_fare = gq[["Request ID", "OND 1", "_created_ts"]].copy()
    req_fare = req_fare.join(inv_agg[["lowest_bc"]], on="Request ID")
    req_fare = req_fare.dropna(subset=["OND 1", "_created_ts"])

    ref_fares: dict[str, float] = {}

    for ond, grp in req_fare.groupby("OND 1"):
        fl_idx = _ond_fl_indices(fl_cols, ond)
        if fl_idx.empty:
            continue
        fl_ond = fl_cols.loc[fl_idx].reset_index(drop=True)

        grp = grp.reset_index(drop=True)
        grp["_key"] = 1
        fl_ond["_key"] = 1
        cross = grp.merge(fl_ond, on="_key").drop(columns="_key")

        valid_from_ok = cross["sale_valid_from"].isna() | (cross["sale_valid_from"] <= cross["_created_ts"])
        valid_to_ok   = cross["sale_valid_to"].isna()   | (cross["sale_valid_to"]   >= cross["_created_ts"])
        cross["_valid"] = valid_from_ok & valid_to_ok
        cross["_bc_match"] = cross["booking_class_id"] == cross["lowest_bc"]

        for rid, rgrp in cross.groupby("Request ID"):
            bc_valid = rgrp[rgrp["_bc_match"] & rgrp["_valid"]]
            if not bc_valid.empty:
                ref_fares[rid] = float(bc_valid["adult_value"].median())
                continue
            bc_only = rgrp[rgrp["_bc_match"]]
            if not bc_only.empty:
                ref_fares[rid] = float(bc_only["adult_value"].median())
                continue
            valid_only = rgrp[rgrp["_valid"]]
            if not valid_only.empty:
                ref_fares[rid] = float(valid_only["adult_value"].median())
                continue
            ref_fares[rid] = float(rgrp["adult_value"].median())

    return pd.Series(ref_fares, name="ref_fare")


# ── Main build function ────────────────────────────────────────────────────

def build_features(
    con: Optional[duckdb.DuckDBPyConnection] = None,
    use_cache: bool = True,
) -> pd.DataFrame:
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

    gq["_created_ts"] = pd.to_datetime(gq["Created On"], errors="coerce")
    dep_ts = pd.to_datetime(gq["primary_departure"], errors="coerce")

    log.info("Building inventory features …")
    inv_agg = _build_inventory_features(gq, fi)

    log.info("Building fare features …")
    ref_fare_series = _build_fare_features(gq, fl, inv_agg)

    feat = pd.DataFrame({
        "request_id":          gq["Request ID"],
        "group_request_id":    gq["Group Request ID"],
        "created_on":          gq["Created On"],
        "status":              gq.get("Status"),
        "is_live":             gq.get("is_live", False),
        "converted":           gq.get("converted", np.nan),
        "group_size":          gq["Passengers"],
        "ond":                 gq["OND 1"],
        "trip_type":           gq.get("Trip Type"),
        "agent_code":          gq.get("Agent Code"),
        "num_options":         gq.get("num_options_per_group", 1),
        "quoted_fare_per_pax": gq["Airline Quoted Fare"],
        "competitor_fare":     gq.get("Competitor Fare", np.nan),
        "lead_time":           (dep_ts - gq["_created_ts"]).dt.days,
        "dow_travel":          dep_ts.dt.dayofweek,
        "month_travel":        dep_ts.dt.month,
        "created_month":       gq["_created_ts"].dt.month,
        "flight_number":       gq["primary_flight_number"],
        "departure_dt":        gq["primary_departure"],
    }).set_index("request_id")

    feat = feat.join(inv_agg[["total_capacity", "seats_available",
                               "load_factor", "low_bc_seats_avail"]])
    feat = feat.join(ref_fare_series)

    q = feat["quoted_fare_per_pax"]
    r = feat["ref_fare"]
    feat["fare_ratio"] = np.where(
        q.notna() & r.notna() & (r > 0) & (q > 0), q / r, np.nan,
    )

    feat = feat.reset_index()

    # ── agent history (sequential as-of join) ─────────────────────
    feat = feat.sort_values("created_on").reset_index(drop=True)
    agent_prior_req, agent_prior_conv, agent_conv_rate = [], [], []
    agent_requests: dict = {}
    agent_converted: dict = {}

    for _, row in feat.iterrows():
        agent = row["agent_code"]
        if pd.notna(agent):
            pr = agent_requests.get(agent, 0)
            pc = agent_converted.get(agent, 0)
            agent_prior_req.append(pr)
            agent_prior_conv.append(pc)
            agent_conv_rate.append(pc / pr if pr > 0 else 0.0)
            agent_requests[agent] = pr + 1
            if row["converted"] == 1:
                agent_converted[agent] = pc + 1
        else:
            agent_prior_req.append(0)
            agent_prior_conv.append(0)
            agent_conv_rate.append(0.0)

    feat["agent_prior_requests"]  = agent_prior_req
    feat["agent_prior_converted"] = agent_prior_conv
    feat["agent_conv_rate"]       = agent_conv_rate

    # ── route history (sequential as-of join) ─────────────────────
    route_prior_req, route_prior_conv, route_conv_rate = [], [], []
    route_requests: dict = {}
    route_converted: dict = {}

    for _, row in feat.iterrows():
        ond_key = row["ond"]
        if pd.notna(ond_key):
            pr = route_requests.get(ond_key, 0)
            pc = route_converted.get(ond_key, 0)
            route_prior_req.append(pr)
            route_prior_conv.append(pc)
            route_conv_rate.append(pc / pr if pr > 0 else 0.0)
            route_requests[ond_key] = pr + 1
            if row["converted"] == 1:
                route_converted[ond_key] = pc + 1
        else:
            route_prior_req.append(0)
            route_prior_conv.append(0)
            route_conv_rate.append(0.0)

    feat["route_prior_requests"]  = route_prior_req
    feat["route_prior_converted"] = route_prior_conv
    feat["route_conv_rate"]       = route_conv_rate

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

    df["trip_type_enc"] = (df["trip_type"] == "ONE_WAY").astype(float)

    num_cols = FEATURE_COLS + ["trip_type_enc"]
    X = df[num_cols].copy()
    y = df["converted"].astype(int)
    return X, y


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)
    force = "--rebuild" in sys.argv
    feat = build_features(use_cache=not force)
    print(feat.head())
