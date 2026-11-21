"""
ETL: load raw CSVs into DuckDB, build parquet caches.
Run once before training or serving: python -m etl.build_snapshots
"""
import os
import re
import io
import zipfile
import logging
from pathlib import Path

import duckdb
import pandas as pd
import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data"
DB_PATH  = DATA_DIR / "group_booking.duckdb"

# ── helpers ──────────────────────────────────────────────────────────────────

def _strip_aed(val):
    """'1,650 AED' → 1650.0, '0 AED' → 0.0, NaN → NaN"""
    if pd.isna(val):
        return np.nan
    s = str(val).replace("AED", "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return np.nan


_SECTOR_RE = re.compile(
    r"(?P<ond>[A-Z]{3}/[A-Z]{3}):\s*(?P<flight>[A-Z0-9]+):\s*"
    r"(?P<dep>\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2})\s*-\s*"
    r"(?P<arr>\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2})"
)

def _parse_sector(sector_str):
    """Return (flight_number, departure_datetime) or (None, None)."""
    if not sector_str or pd.isna(sector_str):
        return None, None
    m = _SECTOR_RE.search(str(sector_str))
    if not m:
        return None, None
    try:
        dep = pd.to_datetime(m.group("dep"), format="%d/%m/%Y %H:%M")
    except Exception:
        dep = None
    return m.group("flight"), dep


# ── Group Quote ───────────────────────────────────────────────────────────────

def load_group_quote() -> pd.DataFrame:
    log.info("Loading Group Quote …")
    gq_path = DATA_DIR / "Group Quote.csv"
    df = pd.read_csv(gq_path, low_memory=False)

    # clean fare columns
    fare_cols = [
        "Agent Proposed Fare", "Airline Quoted Fare", "Handling Fee",
        "Proposed Fare", "Quoted Fare", "Competitor Fare",
    ]
    for col in fare_cols:
        if col in df.columns:
            df[col] = df[col].apply(_strip_aed)

    # parse dates
    for dc in ["Created On", "Last Updated"]:
        if dc in df.columns:
            df[dc] = pd.to_datetime(df[dc], format="%d/%m/%Y %H:%M", errors="coerce")

    # extract primary flight number and departure date from Sector Details 1
    df[["primary_flight_number", "primary_departure"]] = df["Sector Details 1"].apply(
        lambda x: pd.Series(_parse_sector(x))
    )

    # count non-empty options
    ond_cols = [c for c in df.columns if c.startswith("OND ")]
    df["num_options_per_group"] = df[ond_cols].notna().sum(axis=1)
    df["num_options_per_group"] = df["num_options_per_group"].clip(lower=1)

    # label
    converted_statuses = {"PNR", "Remaining Payment", "Advance Down-Payment"}
    df["converted"] = df["Status"].isin(converted_statuses).astype(int)

    # drop leaky rows from training (Quoted / Submitted = live, never train)
    df["is_live"] = df["Status"].isin({"Quoted", "Submitted"})

    log.info("  Group Quote: %d rows, %d groups, %d converted",
             len(df), df["Group Request ID"].nunique(), df["converted"].sum())
    return df


# ── Flight Inventory ──────────────────────────────────────────────────────────

def load_flight_inventory() -> pd.DataFrame:
    log.info("Loading Flight Inventory …")
    fi_path = DATA_DIR / "Flight Inventory.csv"
    df = pd.read_csv(fi_path, low_memory=False)
    df["departure_date_time_local"] = pd.to_datetime(
        df["departure_date_time_local"], errors="coerce"
    )
    df["departure_date"] = df["departure_date_time_local"].dt.date
    # derive OND from flight number if not present
    # (inventory doesn't have OND – will be joined via Group Quote flight number)
    log.info("  Flight Inventory: %d rows, %d flights, %d departures",
             len(df), df["flight_number"].nunique(),
             df[["flight_number","departure_date"]].drop_duplicates().shape[0])
    return df


# ── Fares list ────────────────────────────────────────────────────────────────

def load_fares_list() -> pd.DataFrame:
    log.info("Loading fares_list …")
    fz_path = DATA_DIR / "fares_list.csv.zip"
    with zipfile.ZipFile(fz_path) as z:
        csv_name = next(n for n in z.namelist() if n.endswith(".csv"))
        with z.open(csv_name) as f:
            df = pd.read_csv(f, low_memory=False)

    # keep only active fares
    df = df[df["status"] == "A"].copy()

    # vectorised validity parsing: "2025-06-11T11:49~2025-08-31T23:59"
    # split on "~" and parse each part — 100x faster than apply()
    def _split_validity(series: pd.Series, part: int) -> pd.Series:
        return pd.to_datetime(
            series.str.split("~").str[part].str.strip(),
            errors="coerce",
        )

    df["sale_valid_from"] = _split_validity(df["sale_validities"], 0)
    df["sale_valid_to"]   = _split_validity(df["sale_validities"], 1)
    df["flight_valid_from"] = _split_validity(df["outbound_flight_validities"], 0)
    df["flight_valid_to"]   = _split_validity(df["outbound_flight_validities"], 1)

    log.info("  fares_list: %d active rows, %d ONDs",
             len(df), df["ond_labels"].nunique())
    return df


# ── Booking data (sample for pickup curves) ───────────────────────────────────

def load_booking_data(max_months: int = 6) -> pd.DataFrame:
    """Load a sample of monthly booking CSVs for pickup curve computation."""
    log.info("Loading booking data (up to %d months) …", max_months)
    bz_path = DATA_DIR / "Past & Future Booking Data.zip"
    frames = []
    with zipfile.ZipFile(bz_path) as outer:
        inner_zips = sorted(
            [n for n in outer.namelist() if n.endswith(".csv.zip") and "__MACOSX" not in n]
        )[:max_months]
        for inner_name in inner_zips:
            log.info("  Loading %s …", inner_name)
            with outer.open(inner_name) as inner_bytes:
                with zipfile.ZipFile(io.BytesIO(inner_bytes.read())) as inner:
                    csv_name = next(n for n in inner.namelist() if n.endswith(".csv"))
                    with inner.open(csv_name) as f:
                        chunk = pd.read_csv(
                            f, low_memory=False,
                            on_bad_lines="skip",
                            encoding="latin-1",
                        )
                        frames.append(chunk)

    if not frames:
        return pd.DataFrame()

    df = pd.concat(frames, ignore_index=True)
    df["BOOKING_TIMESTAMP"] = pd.to_datetime(df["BOOKING_TIMESTAMP"], errors="coerce")
    df["EST_TIME_DEPARTURE_ZULU"] = pd.to_datetime(df["EST_TIME_DEPARTURE_ZULU"], errors="coerce")
    df["days_before_departure"] = (
        df["EST_TIME_DEPARTURE_ZULU"].dt.normalize() -
        df["BOOKING_TIMESTAMP"].dt.normalize()
    ).dt.days
    df["departure_date"] = df["EST_TIME_DEPARTURE_ZULU"].dt.date
    df["booking_month"]  = df["BOOKING_TIMESTAMP"].dt.to_period("M").astype(str)

    log.info("  Booking data: %d rows loaded", len(df))
    return df


# ── DuckDB ingest ─────────────────────────────────────────────────────────────

def build_database(reload: bool = False):
    if DB_PATH.exists() and not reload:
        log.info("Database already exists at %s. Use reload=True to rebuild.", DB_PATH)
        return

    log.info("Building DuckDB at %s …", DB_PATH)
    cache_dir = DATA_DIR / "cache"
    cache_dir.mkdir(exist_ok=True)

    con = duckdb.connect(str(DB_PATH))
    con.execute("DROP TABLE IF EXISTS group_quote")
    con.execute("DROP TABLE IF EXISTS flight_inventory")
    con.execute("DROP TABLE IF EXISTS fares_list")
    con.execute("DROP TABLE IF EXISTS pickup_curves")

    # --- Group Quote ---
    gq = load_group_quote()
    con.register("gq_df", gq)
    con.execute("CREATE TABLE group_quote AS SELECT * FROM gq_df")
    gq.to_parquet(cache_dir / "group_quote.parquet", index=False)
    del gq

    # --- Flight Inventory ---
    fi = load_flight_inventory()
    con.register("fi_df", fi)
    con.execute("CREATE TABLE flight_inventory AS SELECT * FROM fi_df")
    fi.to_parquet(cache_dir / "flight_inventory.parquet", index=False)
    del fi

    # --- Fares list ---
    fl = load_fares_list()
    con.register("fl_df", fl)
    con.execute("CREATE TABLE fares_list AS SELECT * FROM fl_df")
    fl.to_parquet(cache_dir / "fares_list.parquet", index=False)
    del fl

    # --- Booking data: load 2 months only, compute pickup curves, store aggregated ---
    bk = load_booking_data(max_months=2)
    if not bk.empty:
        # compute aggregated pickup curves (much smaller than raw data)
        pc = _compute_pickup_curves(bk)
        del bk
        con.register("pc_df", pc)
        con.execute("CREATE TABLE pickup_curves AS SELECT * FROM pc_df")
        pc.to_parquet(cache_dir / "pickup_curves.parquet", index=False)
        del pc
    else:
        log.warning("No booking data loaded; pickup curves will use defaults.")

    log.info("Database built successfully.")
    con.close()


def _compute_pickup_curves(bk: pd.DataFrame) -> pd.DataFrame:
    """Aggregate booking data into pickup curves for displacement engine."""
    bk["departure_month"] = pd.to_datetime(
        bk["EST_TIME_DEPARTURE_ZULU"], errors="coerce"
    ).dt.month
    bk["ond"] = bk["SEGMENT_CODE"]

    pickup = (
        bk[bk["days_before_departure"].fillna(-1) >= 0]
        .groupby(["ond", "departure_month", "departure_date", "days_before_departure"])
        .size()
        .reset_index(name="pax_booked")
    )
    pickup = pickup.sort_values("days_before_departure", ascending=False)
    pickup["cumulative_booked"] = pickup.groupby(
        ["ond", "departure_month", "departure_date"]
    )["pax_booked"].cumsum()

    mean_curve = (
        pickup.groupby(["ond", "departure_month", "days_before_departure"])
        ["cumulative_booked"]
        .mean()
        .reset_index()
    )
    log.info("  Pickup curves: %d (ond, month, day) rows", len(mean_curve))
    return mean_curve


def get_connection() -> duckdb.DuckDBPyConnection:
    if not DB_PATH.exists():
        build_database()
    return duckdb.connect(str(DB_PATH), read_only=True)


if __name__ == "__main__":
    import sys
    reload = "--reload" in sys.argv
    build_database(reload=reload)
