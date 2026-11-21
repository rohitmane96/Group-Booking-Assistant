"""
Streamlit UI for the Group Booking Assistant.
Connects to the FastAPI backend at API_BASE_URL.
"""
import os
import json
import requests
import pandas as pd
import numpy as np
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
from datetime import datetime

API_BASE = os.getenv("API_BASE_URL", "http://localhost:8000")

st.set_page_config(
    page_title="Air Arabia · Group Booking Assistant",
    page_icon="✈️",
    layout="wide",
)

# ── helpers ───────────────────────────────────────────────────────────────────

def api(path: str, method: str = "GET", body: dict = None):
    url = f"{API_BASE}{path}"
    try:
        if method == "GET":
            r = requests.get(url, timeout=60)
        else:
            r = requests.post(url, json=body, timeout=120)
        r.raise_for_status()
        return r.json()
    except requests.exceptions.ConnectionError:
        st.error("Cannot reach API server. Make sure it is running.")
        return None
    except Exception as e:
        st.error(f"API error: {e}")
        return None


ACTION_COLOR = {
    "Accept":       "#22c55e",
    "Counteroffer": "#f59e0b",
    "Partial":      "#3b82f6",
    "Reject":       "#ef4444",
}


# ── sidebar ───────────────────────────────────────────────────────────────────

st.sidebar.image(
    "https://upload.wikimedia.org/wikipedia/commons/thumb/5/51/Air_Arabia_logo.svg/320px-Air_Arabia_logo.svg.png",
    width=160,
)
st.sidebar.title("Group Booking Queue")

view = st.sidebar.radio("View", ["Open Requests", "All Requests", "Submit New Request", "Audit Log"], index=0)

if view == "Open Requests":
    data = api("/requests")
elif view == "All Requests":
    data = api("/requests/all")
elif view == "Submit New Request":
    data = None
else:
    data = None

if data and "requests" in data and data["requests"]:
    df_q = pd.DataFrame(data["requests"])
    request_ids = df_q["request_id"].tolist()
    labels = [
        f"{r['request_id']} | {r.get('ond','?')} | {r.get('group_size','?')} pax"
        for _, r in df_q.iterrows()
    ]
    sel_idx = st.sidebar.selectbox("Select Request", range(len(request_ids)), format_func=lambda i: labels[i])
    selected_id = request_ids[sel_idx]
    st.sidebar.caption(f"Total: {data['total']} requests")
elif view != "Audit Log":
    st.sidebar.info("No requests found.")
    selected_id = None
    df_q = pd.DataFrame()
else:
    selected_id = None
    df_q = pd.DataFrame()

# ── audit log view ─────────────────────────────────────────────────────────────

if view == "Audit Log":
    st.title("📋 Audit Log")
    audit_data = api("/audit")
    if audit_data and audit_data.get("entries"):
        df_audit = pd.DataFrame(audit_data["entries"])
        st.dataframe(df_audit, use_container_width=True)
    else:
        st.info("No audit entries yet.")
    st.stop()

# ── submit new request view ────────────────────────────────────────────────────

if view == "Submit New Request":
    st.title("✈️ Submit New Group Booking Request")
    st.caption("Enter the details of the incoming group enquiry to get an instant AI recommendation.")

    with st.form("submit_form"):
        st.subheader("Flight & Route")
        f1, f2, f3 = st.columns(3)
        with f1:
            ond = st.text_input("OND (e.g. SHJ/MAA)", placeholder="SHJ/MAA")
        with f2:
            departure_date = st.date_input("Departure Date")
        with f3:
            flight_number = st.text_input("Flight Number (optional)", placeholder="G9068")

        st.subheader("Group Details")
        g1, g2, g3 = st.columns(3)
        with g1:
            group_size = st.number_input("Passengers", min_value=10, max_value=300, value=30, step=1)
        with g2:
            trip_type = st.selectbox("Trip Type", ["ONE_WAY", "ROUND_TRIP"])
        with g3:
            agent_code = st.text_input("Agent Code (optional)", placeholder="AG001")

        st.subheader("Fare Details")
        p1, p2 = st.columns(2)
        with p1:
            airline_quoted_fare = st.number_input("Airline Quoted Fare / Pax (AED)", min_value=100, max_value=20000, value=1500, step=50)
        with p2:
            competitor_fare = st.number_input("Competitor Fare / Pax (AED, optional — 0 = not provided)", min_value=0, max_value=20000, value=0, step=50)

        submitted = st.form_submit_button("🚀 Submit & Score", type="primary", use_container_width=True)

    if submitted:
        if not ond:
            st.error("OND is required (e.g. SHJ/MAA)")
        else:
            payload = {
                "ond": ond.strip().upper(),
                "group_size": int(group_size),
                "trip_type": trip_type,
                "departure_date": str(departure_date),
                "airline_quoted_fare": float(airline_quoted_fare),
                "agent_code": agent_code.strip() or None,
                "flight_number": flight_number.strip().upper() or None,
                "competitor_fare": float(competitor_fare) if competitor_fare > 0 else None,
            }
            with st.spinner("Submitting request and scoring …"):
                result = api("/requests", method="POST", body=payload)

            if result:
                new_id = result["request_id"]
                st.success(f"Request **{new_id}** created successfully!")

                # auto-score and show recommendation inline
                with st.spinner("Running recommendation engines …"):
                    scored = api(f"/requests/{new_id}/score", method="POST")

                if scored:
                    rec   = scored.get("recommendation", "?")
                    color = ACTION_COLOR.get(rec, "#6b7280")

                    st.markdown(f"### Recommendation: **:{color.replace('#','')} {rec}**")
                    m1, m2, m3, m4, m5 = st.columns(5)
                    m1.metric("Action", rec)
                    m2.metric("Best Fare / Pax", f"AED {scored.get('best_fare', 0):,}")
                    m3.metric("Seats", scored.get("best_seats", 0))
                    m4.metric("P(Convert)", f"{scored.get('p_convert_at_best', 0):.1%}")
                    m5.metric("Option Deadline", f"{scored.get('best_deadline_days', 14)} days")

                    ec = scored.get("expected_contribution", 0)
                    bl = scored.get("baseline_contribution", 0)
                    st.markdown(
                        f"""<div style='background:{color}20;border-left:4px solid {color};
                        padding:12px 16px;border-radius:4px;margin:8px 0'>
                        <b style='color:{color};font-size:1.1em'>{rec}</b> &nbsp;|&nbsp;
                        Expected contribution: <b>AED {ec:,}</b> &nbsp;|&nbsp;
                        Baseline: <b>AED {bl:,}</b> &nbsp;|&nbsp;
                        Lift: <b>AED {scored.get('lift_vs_baseline', 0):+,}</b>
                        </div>""",
                        unsafe_allow_html=True,
                    )

                    fare_curve = scored.get("fare_curve", [])
                    if fare_curve:
                        df_fc = pd.DataFrame(fare_curve)
                        fig = px.line(
                            df_fc, x="fare", y="p_convert",
                            labels={"fare": "Fare / Pax (AED)", "p_convert": "P(Convert)"},
                            title="Fare-Response Curve",
                            markers=True,
                        )
                        fig.add_vline(x=scored.get("best_fare", 0), line_dash="dash",
                                      line_color=color, annotation_text="Recommended")
                        fig.update_layout(yaxis_tickformat=".0%", height=320)
                        st.plotly_chart(fig, use_container_width=True)

                    st.info(f"💡 To explore further, select **{new_id}** from the sidebar under Open Requests.")
    st.stop()

# ── main panel ─────────────────────────────────────────────────────────────────

if not selected_id:
    st.title("✈️ Air Arabia · Group Booking Assistant")
    st.info("Select a request from the sidebar to begin.")
    st.stop()

st.title(f"✈️ Group Request: {selected_id}")

# --- Fetch and score request ---
col_spin, _ = st.columns([1, 5])
with col_spin:
    with st.spinner("Scoring request …"):
        scored = api(f"/requests/{selected_id}/score", method="POST")

if not scored:
    st.stop()

# ── Recommendation card ────────────────────────────────────────────────────────

rec   = scored.get("recommendation", "?")
color = ACTION_COLOR.get(rec, "#6b7280")

c1, c2, c3, c4, c5 = st.columns(5)
c1.metric("Recommendation", rec)
c2.metric("Best Fare / Pax", f"AED {scored.get('best_fare', 0):,}")
c3.metric("Seats", scored.get("best_seats", 0))
c4.metric("P(Convert)", f"{scored.get('p_convert_at_best', 0):.1%}")
c5.metric("Option Deadline", f"{scored.get('best_deadline_days', 14)} days")

ec  = scored.get("expected_contribution", 0)
bl  = scored.get("baseline_contribution", 0)
lift = scored.get("lift_vs_baseline", 0)
st.markdown(
    f"""
    <div style='background:{color}20;border-left:4px solid {color};padding:12px 16px;border-radius:4px;margin:8px 0'>
    <b style='color:{color};font-size:1.1em'>{rec}</b> &nbsp;|&nbsp;
    Expected contribution: <b>AED {ec:,}</b> &nbsp;|&nbsp;
    Baseline: <b>AED {bl:,}</b> &nbsp;|&nbsp;
    Lift: <b>AED {lift:+,}</b> &nbsp;|&nbsp;
    Displacement cost: <b>AED {scored.get('displacement_cost', 0):,}</b>
    </div>
    """,
    unsafe_allow_html=True,
)

# ── Request details ────────────────────────────────────────────────────────────

req_detail = api(f"/requests/{selected_id}")
if req_detail:
    with st.expander("Request Details", expanded=False):
        dc1, dc2, dc3 = st.columns(3)
        dc1.write(f"**OND:** {req_detail.get('ond','?')}")
        dc1.write(f"**Trip Type:** {req_detail.get('trip_type','?')}")
        dc1.write(f"**Group Size:** {req_detail.get('group_size','?')} pax")
        dc2.write(f"**Agent:** {req_detail.get('agent_code','?')}")
        dc2.write(f"**Status:** {req_detail.get('status','?')}")
        dc2.write(f"**Created:** {str(req_detail.get('created_on','?'))[:16]}")
        dc3.write(f"**Quoted Fare/Pax:** AED {req_detail.get('quoted_fare_per_pax') or 'N/A'}")
        dc3.write(f"**Reference Fare:** AED {req_detail.get('ref_fare') or 'N/A'}")
        dc3.write(f"**Load Factor:** {(req_detail.get('load_factor') or 0):.1%}")

# ── Charts ─────────────────────────────────────────────────────────────────────

tab1, tab2, tab3, tab4 = st.tabs(["Fare-Response Curve", "Heat Map", "SHAP Drivers", "Chat"])

with tab1:
    fare_curve = scored.get("fare_curve", [])
    if fare_curve:
        df_fc = pd.DataFrame(fare_curve)
        fig = px.line(
            df_fc, x="fare", y="p_convert",
            labels={"fare": "Fare per Pax (AED)", "p_convert": "P(Convert)"},
            title="Fare-Response Curve",
            markers=True,
        )
        fig.add_vline(x=scored.get("best_fare", 0), line_dash="dash",
                      line_color=color, annotation_text="Recommended")
        ref = req_detail.get("ref_fare") if req_detail else None
        if ref:
            fig.add_vline(x=ref, line_dash="dot", line_color="gray",
                          annotation_text="Ref Fare")
        fig.update_layout(yaxis_tickformat=".0%", height=350)
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info("Fare curve not available.")

with tab2:
    heat_map = scored.get("heat_map", [])
    if heat_map:
        df_hm = pd.DataFrame(heat_map)
        # pivot on fare × seats for one deadline
        dl = scored.get("best_deadline_days", 14)
        df_pivot = df_hm[df_hm["deadline"] == dl].pivot_table(
            index="seats", columns="fare", values="expected_contribution", aggfunc="mean"
        )
        if not df_pivot.empty:
            fig2 = px.imshow(
                df_pivot,
                labels=dict(x="Fare / Pax (AED)", y="Seats", color="Exp. Contribution"),
                title=f"Expected Contribution Heat Map (deadline={dl}d)",
                color_continuous_scale="RdYlGn",
                aspect="auto",
            )
            fig2.update_layout(height=350)
            st.plotly_chart(fig2, use_container_width=True)
        else:
            st.dataframe(df_hm, use_container_width=True)
    else:
        st.info("Heat map not available.")

with tab3:
    drivers = scored.get("drivers", [])
    if drivers:
        df_d = pd.DataFrame(drivers[:10])
        df_d["color"] = df_d["shap_value"].apply(lambda x: "positive" if x > 0 else "negative")
        fig3 = px.bar(
            df_d, x="shap_value", y="feature", orientation="h",
            color="color",
            color_discrete_map={"positive": "#22c55e", "negative": "#ef4444"},
            title="SHAP Feature Drivers (top 10)",
            labels={"shap_value": "SHAP Value", "feature": "Feature"},
        )
        fig3.update_layout(showlegend=False, height=350, yaxis={"autorange": "reversed"})
        st.plotly_chart(fig3, use_container_width=True)

        with st.expander("Driver Details"):
            st.dataframe(df_d[["feature", "value", "shap_value"]], use_container_width=True)
    else:
        st.info("SHAP drivers not available.")

with tab4:
    st.subheader("Ask the Assistant")
    if "chat_history" not in st.session_state:
        st.session_state.chat_history = []
    if "chat_messages" not in st.session_state:
        st.session_state.chat_messages = []

    # display chat
    for msg in st.session_state.chat_messages:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])

    prompt = st.chat_input("Ask a what-if question, e.g. 'What if we offer 30 seats at AED 1,500?'")
    if prompt:
        st.session_state.chat_messages.append({"role": "user", "content": prompt})
        with st.chat_message("user"):
            st.markdown(prompt)

        # prepend context
        ctx_prompt = f"[Request ID: {selected_id}] {prompt}"
        with st.spinner("Thinking …"):
            resp = api("/chat", method="POST", body={
                "message": ctx_prompt,
                "history": st.session_state.chat_history,
            })

        if resp:
            assistant_text = resp.get("response", "No response.")
            st.session_state.chat_history = resp.get("history", [])
            st.session_state.chat_messages.append({"role": "assistant", "content": assistant_text})
            with st.chat_message("assistant"):
                st.markdown(assistant_text)

# ── What-if scenario tool ──────────────────────────────────────────────────────

st.markdown("---")
st.subheader("Run Scenario")
sc1, sc2, sc3 = st.columns(3)
with sc1:
    sc_fare = st.number_input("Fare / Pax (AED)", value=int(scored.get("best_fare", 1000)), step=50)
with sc2:
    sc_seats = st.number_input("Seats", value=int(scored.get("best_seats", 20)), step=1)
with sc3:
    sc_deadline = st.selectbox("Deadline (days)", [7, 14, 21], index=1)

if st.button("Run Scenario"):
    with st.spinner("Running …"):
        sc_result = api(f"/requests/{selected_id}/scenario", method="POST", body={
            "fare": sc_fare, "seats": sc_seats, "deadline_days": sc_deadline
        })
    if sc_result:
        r1, r2, r3, r4 = st.columns(4)
        r1.metric("P(Convert)", f"{sc_result.get('p_convert', 0):.1%}")
        r2.metric("Group Revenue", f"AED {sc_result.get('group_revenue', 0):,}")
        r3.metric("Displacement Cost", f"AED {sc_result.get('displacement_cost', 0):,}")
        r4.metric("Expected Contribution", f"AED {sc_result.get('expected_contribution', 0):,}")

# ── Approval ───────────────────────────────────────────────────────────────────

st.markdown("---")
st.subheader("Decision")
ap1, ap2, ap3 = st.columns(3)

with ap1:
    if st.button("✅ Approve Recommendation", type="primary", use_container_width=True):
        result = api(f"/requests/{selected_id}/approve", method="POST", body={
            "action": "approve",
            "fare": scored.get("best_fare"),
            "seats": scored.get("best_seats"),
            "note": "Approved via UI",
        })
        if result:
            st.success("Decision recorded in audit log.")

with ap2:
    if st.button("✏️ Draft Counteroffer", use_container_width=True):
        with st.spinner("Drafting …"):
            co = api(f"/requests/{selected_id}/counteroffer", method="POST", body={
                "fare": sc_fare,
                "seats": sc_seats,
                "deadline_days": sc_deadline,
            })
        if co:
            st.text_area("Counteroffer Email", value=co.get("counteroffer_email", ""), height=250)

with ap3:
    if st.button("❌ Reject", use_container_width=True):
        result = api(f"/requests/{selected_id}/approve", method="POST", body={
            "action": "reject",
            "note": "Rejected via UI",
        })
        if result:
            st.warning("Rejection recorded in audit log.")
