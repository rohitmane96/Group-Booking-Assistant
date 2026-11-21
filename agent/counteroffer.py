"""
Agentic loop: drives a multi-turn Claude conversation with tool use.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import anthropic

from agent.prompts import SYSTEM_PROMPT
from agent.tools import TOOL_DEFINITIONS, TOOL_REGISTRY

log = logging.getLogger(__name__)


def run_agent(user_message: str, history: list[dict] | None = None) -> tuple[str, list[dict]]:
    """
    Run one turn of the agent loop with tool use.
    Returns (assistant_text, updated_history).
    history: list of {"role": "user"/"assistant", "content": ...}
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        return "ANTHROPIC_API_KEY not configured. Please set it in .env.", history or []

    client = anthropic.Anthropic(api_key=api_key)

    if history is None:
        history = []

    messages = history + [{"role": "user", "content": user_message}]

    # agentic loop
    final_text = ""
    for _ in range(10):   # max 10 tool-use rounds
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=TOOL_DEFINITIONS,
            messages=messages,
        )

        # collect text
        text_parts = [b.text for b in response.content if hasattr(b, "text")]
        final_text = " ".join(text_parts)

        # append assistant message
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            break

        # process tool calls
        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                tool_name  = block.name
                tool_input = block.input
                log.info("Tool call: %s(%s)", tool_name, tool_input)
                try:
                    fn     = TOOL_REGISTRY[tool_name]
                    result = fn(**tool_input)
                except Exception as e:
                    result = {"error": str(e)}

                tool_results.append({
                    "type":        "tool_result",
                    "tool_use_id": block.id,
                    "content":     json.dumps(result, default=str),
                })

        messages.append({"role": "user", "content": tool_results})

    return final_text, messages
