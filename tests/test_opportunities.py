"""
Checks for the opportunity prioritisation (engines/opportunities.py).

Run inside the API container:
    docker compose exec -T api python -m tests.test_opportunities
"""
from __future__ import annotations

from datetime import datetime, timedelta

from engines import opportunities as opp

NOW = datetime(2026, 11, 21, 12, 0, 0)


def _item(rid, ec, p=0.05, rec="Counteroffer", dep_days=60, seats=30, requested=30, disp=0.0, known=False, avail=None, dl=7):
    return {
        "request_id": rid, "agent_code": "AG1", "ond": "SHJ/DEL", "flight_number": "G9001",
        "departure_dt": NOW + timedelta(days=dep_days), "created_on": NOW - timedelta(days=5), "status": "Quoted",
        "requested_seats": requested, "ref_fare": 1000.0, "recommendation": rec,
        "expected_contribution": ec, "p_convert": p, "best_fare": 1100, "best_seats": seats,
        "best_deadline_days": dl, "displacement_cost": disp, "inventory_known": known,
        "seats_available": avail, "release_days": 3,
    }


def _by_id(rows):
    return {r["request_id"]: r for r in rows}


def test_deadline_is_derived_from_real_dates_and_policy_cutoff():
    d = opp.deadline_info(NOW, NOW + timedelta(days=10), NOW - timedelta(days=2), 21, release_days=3)
    assert d["days_to_latest_confirmation"] == 7.0          # departure - 3 days
    assert d["deadline_truncated"] is True                  # a 21-day window does not fit before the cut-off
    assert d["effective_deadline_date"] == (NOW + timedelta(days=7)).isoformat()
    assert d["urgency"] == "critical"
    far = opp.deadline_info(NOW, NOW + timedelta(days=90), None, 7, release_days=3)
    assert far["urgency"] == "normal" and far["deadline_truncated"] is False


def test_urgency_thresholds():
    soon = opp.deadline_info(NOW, NOW + timedelta(days=3 + opp.SOON_DAYS), None, 7, 3)
    normal = opp.deadline_info(NOW, NOW + timedelta(days=3 + opp.SOON_DAYS + 1), None, 7, 3)
    assert soon["urgency"] == "soon" and normal["urgency"] == "normal"


def test_missing_departure_is_unknown_not_invented():
    d = opp.deadline_info(NOW, None, None, 7, 3)
    assert d["urgency"] == "unknown" and d["latest_confirmation_date"] is None


def test_unknown_inventory_is_never_reported_as_verified():
    a = opp.inventory_assessment(False, None, 30, 30, 0.0)
    assert a["inventory_status"] == "unknown" and a["inventory_risk"] == "unknown" and a["needs_inventory_review"]
    v = opp.inventory_assessment(True, 100, 30, 30, 0.0)
    assert v["inventory_status"] == "verified" and v["inventory_risk"] == "low" and not v["needs_inventory_review"]


def test_inventory_risk_signals():
    assert opp.inventory_assessment(True, 100, 30, 30, 500.0)["inventory_risk"] == "high"        # displacement
    assert opp.inventory_assessment(True, 20, 30, 30, 0.0)["inventory_risk"] == "high"           # shortage
    assert opp.inventory_assessment(True, 100, 20, 30, 0.0)["inventory_risk"] == "medium"        # below request


def test_high_value_requires_positive_contribution_and_top_quartile():
    items = [_item(f"R{i}", ec) for i, ec in enumerate([100, 200, 300, 400, 5000, -50, 0])]
    rows = _by_id(opp.build_opportunities(items, NOW))
    assert opp.CATEGORY_HIGH_VALUE in rows["R4"]["categories"]
    assert opp.CATEGORY_HIGH_VALUE not in rows["R0"]["categories"]
    assert opp.CATEGORY_HIGH_VALUE not in rows["R5"]["categories"]   # negative
    assert opp.CATEGORY_HIGH_VALUE not in rows["R6"]["categories"]   # zero


def test_categories_follow_optimizer_recommendation_and_dates():
    items = [
        _item("CO", 500, rec="Counteroffer"),
        _item("AC", 500, rec="Accept"),
        _item("URG", 500, dep_days=8),                    # latest confirmation in 5 days -> critical
        _item("INV", 500, known=True, avail=100, seats=20, requested=30),
    ]
    rows = _by_id(opp.build_opportunities(items, NOW))
    assert opp.CATEGORY_COUNTEROFFER in rows["CO"]["categories"]
    assert opp.CATEGORY_COUNTEROFFER not in rows["AC"]["categories"]
    assert opp.CATEGORY_DEADLINE in rows["URG"]["categories"] and rows["URG"]["urgency"] == "critical"
    assert opp.CATEGORY_INVENTORY in rows["INV"]["categories"]
    assert opp.CATEGORY_DEADLINE not in rows["AC"]["categories"]


def test_priority_does_not_depend_on_conversion_alone():
    """A lower-probability request with a much higher contribution must outrank a high-probability, low-value one."""
    items = [_item("HIGHP", ec=100, p=0.40), _item("HIGHEC", ec=9000, p=0.04)]
    ranked = opp.build_opportunities(items, NOW)
    assert ranked[0]["request_id"] == "HIGHEC"
    assert [r["priority_rank"] for r in ranked] == [1, 2]


def test_priority_score_never_changes_optimizer_fields():
    items = [_item("A", 700, rec="Partial", seats=12, requested=30), _item("B", 100, rec="Reject")]
    before = {i["request_id"]: (i["recommendation"], i["expected_contribution"], i["best_fare"], i["best_seats"]) for i in items}
    after = {r["request_id"]: (r["recommendation"], r["expected_contribution"], r["best_fare"], r["best_seats"])
             for r in opp.build_opportunities([dict(i) for i in items], NOW)}
    assert before == after


def test_weights_sum_to_one():
    assert abs(opp.W_CONTRIBUTION + opp.W_CONVERSION + opp.W_URGENCY + opp.W_INVENTORY - 1) < 1e-9


def test_empty_portfolio():
    assert opp.build_opportunities([], NOW) == []


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("PASS", t.__name__)
    print(f"{len(tests)} passed")
