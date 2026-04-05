"""Handoff Orchestration runtime.

Each handoff session maintains:
- Which agent is currently active (current_agent_id).
- An AgentFramework AgentSession per participant agent so conversation history
  is preserved inside each agent across turns (via InMemoryHistoryProvider).
- A shared list of turns for display purposes.

On each user message:
1. The active agent responds via the real LLM (or local preview if no credentials).
2. The LLM response is checked for a routing marker ``[HANDOFF:agent_id]`` that
   the agent can emit when its injected routing instructions say so.
3. If a handoff is signalled the session switches to the target agent; the marker
   is stripped from the displayed text.
4. SSE events are streamed: active_agent, delta, (handoff), done.
"""
from __future__ import annotations

import asyncio
import json
import re
import textwrap
from collections.abc import AsyncIterator

from agent_framework import Agent, AgentSession as AFSession

from app.models import AgentConfig, HandoffDefinition, HandoffSession, HandoffChatTurn
from app.services.agent_runtime import (
    _build_mcp_tools,
    _close_resource,
    _mock_text,
    _resolve_client,
)
from app.services.skill_runner import build_skills_provider


# ── In-memory session store ─────────────────────────────────────────────────
_sessions: dict[str, HandoffSession] = {}

# Per-handoff-session, per-agent AgentFramework sessions so history is retained
# across turns within a single handoff session.
_af_sessions: dict[str, dict[str, AFSession]] = {}


# ── Session helpers ─────────────────────────────────────────────────────────

def get_or_create_session(
    handoff_id: str,
    session_id: str | None,
    start_agent_id: str | None,
) -> HandoffSession:
    if session_id and session_id in _sessions:
        return _sessions[session_id]
    sess = HandoffSession(
        handoff_id=handoff_id,
        current_agent_id=start_agent_id,
    )
    _sessions[sess.session_id] = sess
    _af_sessions[sess.session_id] = {}
    return sess


def _get_af_session(session_id: str, agent_id: str) -> AFSession:
    """Return (or lazily create) the AgentFramework session for a specific agent."""
    bucket = _af_sessions.setdefault(session_id, {})
    if agent_id not in bucket:
        bucket[agent_id] = AFSession()
    return bucket[agent_id]


def get_session(session_id: str) -> HandoffSession | None:
    return _sessions.get(session_id)


def clear_session(session_id: str) -> None:
    _sessions.pop(session_id, None)
    _af_sessions.pop(session_id, None)


# ── Customer context extraction helper ──────────────────────────────────────

def update_context_from_output(fn_output: str, ctx: dict) -> bool:
    """Parse *fn_output* (JSON string from a skill result) and update *ctx* in-place.

    Returns True if *ctx* was modified, False otherwise.
    Exported for unit-testing.
    """
    _PROFILE_KEYS = (
        "customer_id", "full_name", "age", "gender", "occupation",
        "annual_income", "prefecture", "phone", "email",
        "segment", "assigned_agent", "birth_date",
        # kept for backward compat
        "contract_id", "product_name",
    )

    def _extract_profile(src: dict) -> bool:
        nonlocal changed
        updated = False
        for key in _PROFILE_KEYS:
            if key in src and src[key] not in (None, ""):
                ctx[key] = src[key]
                updated = True
        # Compose full_name from last_name + first_name when available
        ln = src.get("last_name", "").strip()
        fn = src.get("first_name", "").strip()
        if ln or fn:
            ctx["full_name"] = f"{ln} {fn}".strip()
            updated = True
        if updated:
            changed = True
        return updated

    try:
        parsed = json.loads(fn_output)
        if isinstance(parsed, list) and parsed:
            parsed = parsed[0]
        if not isinstance(parsed, dict):
            return False
        changed = False

        # Flat profile fields
        _extract_profile(parsed)

        # customer{} nested object (profile_summary)
        if "customer" in parsed and isinstance(parsed["customer"], dict):
            _extract_profile(parsed["customer"])

        # contracts.items list (profile_summary)
        if "contracts" in parsed and isinstance(parsed["contracts"], dict):
            items = parsed["contracts"].get("items", [])
            if items and isinstance(items, list):
                ctx["contracts"] = items
                # backward-compat flat keys
                ctx.setdefault("contract_id", items[0].get("contract_id", ""))
                ctx.setdefault("product_name", items[0].get("product_name", ""))
                changed = True

        # recent_activities list (profile_summary)
        if "recent_activities" in parsed and isinstance(parsed["recent_activities"], list):
            if parsed["recent_activities"]:
                ctx["activities"] = parsed["recent_activities"]
                changed = True

        return changed
    except Exception:
        return False


# ── Handoff tool helpers ─────────────────────────────────────────────────────

class _HandoffRecorder:
    """
    Stateful object that creates transfer_to_<AgentName>() tool functions.
    When the LLM calls one of these tools the target agent_id is recorded here.
    This is more reliable than asking the LLM to emit a text marker.
    """
    __slots__ = ("target_agent_id", "handoff_reason")

    def __init__(self) -> None:
        self.target_agent_id: str | None = None
        self.handoff_reason: str = ""

    def make_tool(self, target: AgentConfig):
        """Return a callable tool that records a handoff to *target* when called."""
        recorder = self
        safe_name = re.sub(r"[^a-zA-Z0-9_]", "_", target.name)
        desc_part = f" — {target.description}" if target.description else ""

        def transfer_fn(reason: str = "") -> str:
            recorder.target_agent_id = target.id
            recorder.handoff_reason = reason
            return f"Handoff to {target.name} initiated successfully."

        transfer_fn.__name__ = f"transfer_to_{safe_name}"
        transfer_fn.__doc__ = (
            f"Route this conversation to {target.name}{desc_part}. "
            "Call this instead of answering when the user's need matches this specialist agent. "
            "REQUIRED: Pass 'reason' with customer_id, full_name, and the user's request. "
            "Example: reason='customer_id: C016, 氏名: 又吉 佑樹, 用件: 生命保険を解約したい'"
        )
        return transfer_fn


def _build_routing_instructions(
    handoff: HandoffDefinition,
    current_agent_id: str,
    agents_by_id: dict[str, AgentConfig],
    visited: set[str] | None = None,
) -> str:
    """
    Append routing instructions to the agent's system prompt, listing the
    available transfer_to_X functions and when to use them.
    Agents already in `visited` are excluded to prevent loops.
    """
    eligible_rules = [r for r in (handoff.rules or []) if r.source_agent_id == current_agent_id]
    if not eligible_rules:
        return ""

    lines: list[str] = []
    for rule in eligible_rules:
        for tid in (rule.target_agent_ids or []):
            if visited and tid in visited:
                continue  # skip already-visited agents
            target = agents_by_id.get(tid)
            if target:
                safe_name = re.sub(r"[^a-zA-Z0-9_]", "_", target.name)
                desc = f": {target.description}" if target.description else ""
                lines.append(f"- `transfer_to_{safe_name}`{desc}")

    if not lines:
        return ""

    fns = "\n".join(lines)
    return textwrap.dedent(f"""

    ---
    ## Routing instructions
    You have access to transfer functions for routing conversations to specialist agents.
    When the user's request is better handled by a specialist, call the appropriate
    transfer function instead of answering yourself.

    Available transfer functions:
    {fns}

    IMPORTANT: If the request clearly belongs to another agent's domain, call the
    transfer function. Do not answer questions that are outside your scope.
    ---
    """).rstrip()


# ── SSE helper ───────────────────────────────────────────────────────────────

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ── Main streaming function ──────────────────────────────────────────────────

async def stream_handoff_turn(
    handoff: HandoffDefinition,
    agents_by_id: dict[str, AgentConfig],
    session: HandoffSession,
    user_message: str,
) -> AsyncIterator[str]:
    """
    Async generator that yields SSE-formatted strings for one handoff turn.

    After a handoff is triggered, the new agent is automatically invoked in the
    same SSE stream (no extra round-trip from the user).  A visited-agent set
    prevents A→B→A infinite loops.

    Events:
    - active_agent  {agent_id, agent_name}
    - event         {type, title, detail}   — function call / result trace
    - delta         {text, agent_id, agent_name}
    - handoff       {from_agent_id, from_agent_name, to_agent_id, to_agent_name}
    - done          {agent_id, agent_name, text, session_id, current_agent_id, is_complete}
    - error         {detail}
    """
    # Record the user turn once for the whole chain
    session.history.append(HandoffChatTurn(role="user", text=user_message))

    visited: set[str] = set()          # agents already responded this turn
    current_id = session.current_agent_id or handoff.start_agent_id
    MAX_HOPS = 5                        # safety cap on handoff chain length
    # If we're already at a specialist agent (not the start agent), treat as post-handoff
    # so specialist agents never get routing tools on turns where they're already active.
    handoff_occurred = (current_id != handoff.start_agent_id)

    final_agent: AgentConfig | None = None
    final_text = ""

    for _hop in range(MAX_HOPS):
        current_agent = agents_by_id.get(current_id or "")
        if not current_agent:
            yield _sse("error", {"detail": "No active agent found. Configure a start agent and save the handoff."})
            return

        if current_agent.id in visited:
            yield _sse("error", {"detail": f"Handoff loop detected: {current_agent.name} has already responded in this turn."})
            break

        visited.add(current_agent.id)
        final_agent = current_agent

        # Emit active_agent as a connection-style event for the thinking trace
        yield _sse("active_agent", {"agent_id": current_agent.id, "agent_name": current_agent.name})
        # Also surface it as a trace event matching Agents-tab style
        yield _sse("event", {"type": "connection", "title": f"{current_agent.name} に接続中… (model: {current_agent.model.provider}/{current_agent.model.model})", "detail": ""})
        await asyncio.sleep(0.03)

        # Build system prompt (base + routing instructions)
        # After a handoff has occurred, don't give the receiving agent routing tools
        routing_addon = _build_routing_instructions(handoff, current_agent.id, agents_by_id, visited) if not handoff_occurred else ""
        effective_instructions = (current_agent.instructions or "") + routing_addon

        client, cleanup, issues = await _resolve_client(current_agent.model)
        af_session = _get_af_session(session.session_id, current_agent.id)
        recorder = _HandoffRecorder()
        full_text = ""

        try:
            if client is None:
                # ── Mock path ──────────────────────────────────────────
                mock_response = _mock_text(current_agent, user_message, issues)
                for i in range(0, len(mock_response), 8):
                    chunk = mock_response[i : i + 8]
                    full_text += chunk
                    yield _sse("delta", {"text": chunk, "agent_id": current_agent.id, "agent_name": current_agent.name})
                    await asyncio.sleep(0.015)
            else:
                # ── Live LLM path ──────────────────────────────────────
                skills_provider = build_skills_provider(current_agent.skill_ids)
                context_providers = [skills_provider] if skills_provider else None
                mcp_tools = _build_mcp_tools(current_agent.mcp_tools, client)

                # Build transfer_to_X tools — skip targets already visited
                # and skip entirely if this agent already received a handoff
                eligible_rules = [r for r in (handoff.rules or []) if r.source_agent_id == current_agent.id]
                handoff_tools: list = []
                if not handoff_occurred:
                    for rule in eligible_rules:
                        for tid in (rule.target_agent_ids or []):
                            if tid not in visited:           # ← loop prevention
                                tgt = agents_by_id.get(tid)
                                if tgt:
                                    handoff_tools.append(recorder.make_tool(tgt))

                all_tools = mcp_tools + handoff_tools

                runtime_agent = Agent(
                    client=client,
                    name=current_agent.name,
                    description=current_agent.description or None,
                    instructions=effective_instructions,
                    tools=all_tools or None,
                    context_providers=context_providers,
                )

                stream = runtime_agent.run(user_message, stream=True, session=af_session)
                pending_fn_name = ""
                pending_fn_args = ""
                async for update in stream:
                    # ── Function call / result trace ───────────────────
                    for content in (update.contents or []):
                        ctype = getattr(content, "type", "")
                        if ctype == "function_call":
                            fn_name = getattr(content, "name", "") or ""
                            fn_args = getattr(content, "arguments", "") or ""
                            if isinstance(fn_args, dict):
                                fn_args = json.dumps(fn_args, indent=2, ensure_ascii=False)
                            if fn_name:
                                if pending_fn_name:
                                    yield _sse("event", {"type": "function_call.complete", "title": f"Calling function_call({pending_fn_name})", "detail": pending_fn_args})
                                pending_fn_name = fn_name
                                pending_fn_args = str(fn_args)
                            else:
                                pending_fn_args += str(fn_args)
                        elif ctype == "function_result":
                            call_name = pending_fn_name
                            if pending_fn_name:
                                yield _sse("event", {"type": "function_call.complete", "title": f"Calling function_call({pending_fn_name})", "detail": pending_fn_args})
                                pending_fn_name = ""
                                pending_fn_args = ""
                            fn_output = (
                                getattr(content, "content", None)
                                or getattr(content, "output", None)
                                or getattr(content, "result", None)
                                or ""
                            )
                            if isinstance(fn_output, list):
                                fn_output = json.dumps(fn_output, ensure_ascii=False)
                            elif not isinstance(fn_output, str):
                                fn_output = str(fn_output) if fn_output else ""
                            # ── Auto-capture customer context from skill results ──
                            if update_context_from_output(fn_output, session.customer_context):
                                yield _sse("customer_context", dict(session.customer_context))
                            yield _sse("event", {"type": "function_result.complete", "title": f"Result: {call_name or 'function'}", "detail": fn_output[:300]})

                    # ── Text delta ─────────────────────────────────────
                    chunk = update.text or ""
                    if chunk:
                        if pending_fn_name:
                            yield _sse("event", {"type": "function_call.complete", "title": f"Calling function_call({pending_fn_name})", "detail": pending_fn_args})
                            pending_fn_name = ""
                            pending_fn_args = ""
                        full_text += chunk
                        yield _sse("delta", {"text": chunk, "agent_id": current_agent.id, "agent_name": current_agent.name})

                if pending_fn_name:
                    yield _sse("event", {"type": "function_call.complete", "title": f"Calling function_call({pending_fn_name})", "detail": pending_fn_args})

                try:
                    final = await stream.get_final_response()
                    if final.text and len(final.text) > len(full_text):
                        extra = final.text[len(full_text):]
                        full_text = final.text
                        yield _sse("delta", {"text": extra, "agent_id": current_agent.id, "agent_name": current_agent.name})
                except Exception:
                    pass

        except Exception as exc:
            err_text = f"\n[Error: {exc}]"
            full_text += err_text
            yield _sse("delta", {"text": err_text, "agent_id": current_agent.id, "agent_name": current_agent.name})
        finally:
            await asyncio.gather(*(_close_resource(r) for r in cleanup), return_exceptions=True)

        final_text = full_text

        # ── Validate handoff target ────────────────────────────────────
        handoff_target_id = recorder.target_agent_id
        handoff_target = agents_by_id.get(handoff_target_id or "") if handoff_target_id else None
        if handoff_target:
            eligible_rules = [r for r in (handoff.rules or []) if r.source_agent_id == current_agent.id]
            authorised_targets = {tid for r in eligible_rules for tid in (r.target_agent_ids or [])}
            if handoff_target.id not in authorised_targets or handoff_target.id in visited:
                handoff_target = None  # unauthorised or would cause loop

        # ── Record this agent's turn ───────────────────────────────────
        session.history.append(HandoffChatTurn(
            role="agent",
            agent_id=current_agent.id,
            agent_name=current_agent.name,
            text=full_text,
        ))

        if handoff_target:
            # Build effective reason: session.customer_context is authoritative (LLM may hallucinate "未確認")
            if session.customer_context:
                ctx = session.customer_context
                parts = []
                if "customer_id" in ctx:
                    parts.append(f"customer_id: {ctx['customer_id']}")
                if "full_name" in ctx:
                    parts.append(f"氏名: {ctx['full_name']}")
                if "contract_id" in ctx:
                    parts.append(f"契約ID: {ctx['contract_id']}")
                    if "product_name" in ctx:
                        parts.append(f"商品名: {ctx['product_name']}")
                parts.append(f"用件: {user_message}")
                effective_reason = "\n".join(parts)
            else:
                effective_reason = recorder.handoff_reason

            # Emit handoff SSE and continue the loop with the new agent
            yield _sse("handoff", {
                "from_agent_id": current_agent.id,
                "from_agent_name": current_agent.name,
                "to_agent_id": handoff_target.id,
                "to_agent_name": handoff_target.name,
            })
            yield _sse("event", {"type": "handoff_transition", "title": f"Handoff: {current_agent.name} \u2192 {handoff_target.name}", "detail": ""})
            current_id = handoff_target.id
            session.current_agent_id = handoff_target.id
            handoff_occurred = True
            # Reset the receiving agent's AFSession to avoid stale tool call history
            _af_sessions.setdefault(session.session_id, {})[handoff_target.id] = AFSession()
            # Prepend context for the receiving agent
            if effective_reason:
                user_message = f"[引き継ぎ情報]\n{effective_reason}\n\n[顧客メッセージ]\n{user_message}"
        else:
            # No handoff — this agent gave the final answer
            yield _sse("event", {"type": "response_complete", "title": "応答完了", "detail": ""})
            session.current_agent_id = current_agent.id
            break

    # ── Termination check ────────────────────────────────────────────────────
    if handoff.termination_keyword and handoff.termination_keyword.lower() in user_message.lower():
        session.is_complete = True

    # ── Emit single done event ───────────────────────────────────────────────
    yield _sse("done", {
        "agent_id": final_agent.id if final_agent else "",
        "agent_name": final_agent.name if final_agent else "",
        "text": final_text,
        "session_id": session.session_id,
        "current_agent_id": session.current_agent_id,
        "is_complete": session.is_complete,
        "customer_context": dict(session.customer_context),
    })
