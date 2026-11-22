"""
System prompts and templates for the LLM agent (Claude).
The LLM explains, drafts counteroffers and answers what-if questions.
Every number is computed by deterministic engines — the LLM only explains.
"""

SYSTEM_PROMPT = """You are the Intelligent Group Booking Assistant for Air Arabia Group Desk.
You help revenue managers evaluate and respond to group booking requests.

Your role:
1. EXPLAIN the AI recommendation using SHAP drivers — say what pushed the decision up or down.
2. ANSWER what-if questions ("what if we offer 30 seats at AED 1,500?") by calling the run_scenario tool.
3. DRAFT professional counteroffer emails in a neutral, airline tone.
4. NEVER invent numbers — every fare, seat count, probability, and contribution figure
   must come from a tool call result.
5. Keep explanations concise: 3–5 bullet points for drivers, 1 paragraph for rationale.

Tone: professional, factual, brief. Do not use marketing language.

RESPONSE FORMAT (the reply is shown in a narrow chat panel to a revenue manager, rendered as Markdown):
- Start with a one-line **bottom line** that answers the question directly (e.g. "**Counteroffer** - offer 80 seats at AED 1,561.").
- Then use short sections with bold labels, such as **Why**, **Numbers**, **Risks**, **Next step**, only where relevant.
- Use bullet points of one short line each (max 5). No long paragraphs, no tables, no headings with #.
- Translate model jargon into plain business language: say "agent's past conversion rate is low (6.7%)" instead of "agent_conv_rate SHAP +0.87". Mention a SHAP value only if the manager asks for it.
- Format money as AED 1,561, probabilities as 5.3%, and always say what a number is compared against (for example, "AED 2,459 above the rule-based baseline").
- If data is missing (for example no inventory data for the flight), say so plainly in one line and note it limits confidence.
- Keep the whole reply under about 120 words unless the manager asks for detail.

When a manager asks a what-if question, call run_scenario first, then answer based on its output.
When asked to draft a counteroffer, call draft_counteroffer and present the result.
"""

DRIVER_EXPLANATION_TEMPLATE = """
Based on the SHAP analysis, the top factors driving this recommendation are:

{driver_bullets}

Overall conversion probability: **{p_convert:.1%}** (calibrated).
Recommended action: **{recommendation}**.
Expected contribution vs rule-based baseline: **AED {lift:+,}**.
"""

COUNTEROFFER_TEMPLATE = """
Dear Travel Partner,

Thank you for your group booking inquiry with Air Arabia. We have reviewed your request and are pleased to present the following offer:

    Route:                  {ond}
    Flight:                 {flight_number}
    Travel Date:            {departure_date}
    Group Size:             {seats} passengers
    Fare (per passenger):   AED {fare:,.0f}
    Option Expiry:          {deadline_date}

Terms & Conditions:
  1. This offer is valid for acceptance until {option_deadline}.
  2. Full passenger name list is required no later than {release_days} days prior to departure.
  3. Full payment is due upon booking confirmation.
  4. This fare is subject to availability and may be revised if group size changes.

To confirm this offer, please reply to this email or contact your dedicated Air Arabia Group Desk representative.

We look forward to welcoming your group on board.

Warm regards,

Air Arabia Group Desk
groupbookings@airarabia.com
"""


REJECTION_TEMPLATE = """
Dear Travel Partner,

Thank you for your group booking inquiry with Air Arabia. We have carefully reviewed your request and regret to inform you that we are unable to accommodate it under the current terms.

    Route:               {ond}
    Flight:              {flight_number}
    Travel Date:         {departure_date}
    Requested Pax:       {seats} passengers
    Quoted Fare:         AED {quoted_fare:,.0f} per passenger

Reason for Rejection:
{rejection_reason}

Recommendation:
{suggestion}

We value your partnership and look forward to exploring future opportunities together. Please do not hesitate to reach out with revised requirements or for assistance with alternative travel dates.

Warm regards,

Air Arabia Group Desk
groupbookings@airarabia.com
"""


def format_drivers(shap_values: list[dict], top_n: int = 5) -> str:
    """Format SHAP drivers as bullet points."""
    sorted_drivers = sorted(shap_values, key=lambda x: abs(x["shap_value"]), reverse=True)[:top_n]
    bullets = []
    for d in sorted_drivers:
        direction = "↑ increases" if d["shap_value"] > 0 else "↓ decreases"
        bullets.append(
            f"• **{d['feature']}** = {d['value']:.2g} → {direction} conversion probability "
            f"(SHAP: {d['shap_value']:+.3f})"
        )
    return "\n".join(bullets)
