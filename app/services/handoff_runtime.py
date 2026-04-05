"""Handoff Orchestration runtime — uses agent_framework HandoffBuilder.

Key behaviour (matching the original MAF design in _handoff.py):
- Uses HandoffBuilder which calls clean_conversation_for_handoff() before
  broadcasting each agent's response to other agents.
- Tool Call results (function_call / function_result) are stripped from the
  shared conversation thread; each agent only has its own tool artefacts.
- Agent A's *text* responses ARE visible to subsequent agents in the chain.

Session flow (stateful workflow object per session):
  Turn 1:   workflow.run(user_message, stream=True)
  Turn N+1: workflow.run(responses={request_id: messages}, stream=True)

The HandoffBuilder emits WorkflowEvent objects which are translated here into
our existing SSE format (active_agent / event / delta / handoff / done /
customer_context).
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from agent_framework import Agent, ContextProvider
from agent_framework.orchestrations import (
    HandoffAgentUserRequest,
    HandoffBuilder,
    HandoffSentEvent,
)
from agent_framework._types import AgentResponseUpdate

from app.models import AgentConfig, HandoffDefinition, HandoffSession, HandoffChatTurn
from app.services.agent_runtime import (
    _close_resource,
    _mock_text,
    _resolve_client,
)
from app.services.skill_runner import build_skills_provider


# -- Customer context state injector -------------------------------------------

_CTX_KEY_LABELS: dict[str, str] = {
    "customer_id": "customer_id",
    "full_name": "氏名",
    "age": "年齢",
    "gender": "性別",
    "occupation": "職業",
    "annual_income": "年収",
    "prefecture": "都道府県",
    "segment": "セグメント",
}


class _CustomerContextProvider(ContextProvider):
    """Injects HandoffSession.customer_context into each agent's instructions before run.

    Holds a *live reference* to the session's customer_context dict so that
    context accumulated by any skill at any hop is automatically visible to
    every subsequent agent invocation — enabling reliable multi-hop state passing.
    """

    def __init__(self, customer_context: dict) -> None:
        super().__init__(source_id="customer_context_state")
        self._ctx = customer_context  # reference — updated in-place by stream_handoff_turn

    async def before_run(self, *, agent: Any, session: Any, context: Any, state: dict) -> None:
        lines = [
            f"- {label}: {self._ctx[key]}"
            for key, label in _CTX_KEY_LABELS.items()
            if self._ctx.get(key) not in (None, "")
        ]
        if lines:
            context.extend_instructions(
                self.source_id,
                "【引き継ぎ状態】\n" + "\n".join(lines),
            )


# -- Internal workflow state (not exposed to API) ------------------------------

@dataclass
class _WorkflowState:
    """Per-session state: holds the Workflow object and auxilary metadata."""
    workflow: Any                              # agent_framework Workflow
    pending_request_id: str | None = None      # request_id waiting for next user input
    name_to_config: dict[str, AgentConfig] = field(default_factory=dict)
    cleanups: list[Any] = field(default_factory=list)
    is_mock: bool = False                      # True when falling back to mock mode
    mock_start_config: AgentConfig | None = None


# -- In-memory stores ----------------------------------------------------------

_sessions: dict[str, HandoffSession] = {}
_workflow_states: dict[str, _WorkflowState] = {}


# -- Session helpers -----------------------------------------------------------

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
    return sess


def get_session(session_id: str) -> HandoffSession | None:
    return _sessions.get(session_id)


def clear_session(session_id: str) -> None:
    _sessions.pop(session_id, None)
    # Pop workflow state; cleanup is best-effort (clients GC'd if not closed)
    _workflow_states.pop(session_id, None)


# -- Customer context extraction helper ----------------------------------------

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


# -- SSE helper ----------------------------------------------------------------

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# -- Build workflow state for a new session ------------------------------------

async def _build_workflow_state(
    handoff: HandoffDefinition,
    agents_by_id: dict[str, AgentConfig],
    customer_context: dict,
) -> _WorkflowState:
    """Build HandoffBuilder Workflow. Raises ValueError if no real clients available."""
    af_agents: list[Agent] = []
    name_to_config: dict[str, AgentConfig] = {}
    all_cleanups: list[Any] = []

    # Shared provider injecting the live customer_context into every agent's instructions
    ctx_provider = _CustomerContextProvider(customer_context)

    for agent_id in handoff.participant_agent_ids:
        agent_config = agents_by_id.get(agent_id)
        if not agent_config:
            continue
        client, cleanup, _issues = await _resolve_client(agent_config.model)
        all_cleanups.extend(cleanup)
        if client is None:
            # HandoffBuilder requires real clients; skip mock agents
            continue

        skills_provider = build_skills_provider(agent_config.skill_ids)
        providers = [ctx_provider, skills_provider] if skills_provider else [ctx_provider]
        af_agent = Agent(
            client=client,
            name=agent_config.name,
            description=agent_config.description or None,
            instructions=agent_config.instructions or "",
            context_providers=providers,
        )
        af_agents.append(af_agent)
        name_to_config[agent_config.name] = agent_config

    if not af_agents:
        raise ValueError("HandoffBuilder requires at least one agent with valid credentials.")

    builder = HandoffBuilder()
    builder.participants(af_agents)

    # Configure handoff routing from HandoffDefinition.rules
    if handoff.rules:
        config_id_to_name = {cfg.id: name for name, cfg in name_to_config.items()}
        name_to_af = {a.name: a for a in af_agents}
        for rule in handoff.rules:
            src_name = config_id_to_name.get(rule.source_agent_id)
            if not src_name or src_name not in name_to_af:
                continue
            src_af = name_to_af[src_name]
            tgt_af = [
                name_to_af[config_id_to_name[tid]]
                for tid in rule.target_agent_ids
                if config_id_to_name.get(tid) in name_to_af
            ]
            if tgt_af:
                builder.add_handoff(src_af, tgt_af)

    # Set start agent
    name_to_af = {a.name: a for a in af_agents}
    start_config = agents_by_id.get(handoff.start_agent_id or "")
    if start_config and start_config.name in name_to_af:
        builder.with_start_agent(name_to_af[start_config.name])
    else:
        builder.with_start_agent(af_agents[0])

    workflow = builder.build()
    return _WorkflowState(
        workflow=workflow,
        name_to_config=name_to_config,
        cleanups=all_cleanups,
    )


# -- Main streaming function ---------------------------------------------------

async def stream_handoff_turn(
    handoff: HandoffDefinition,
    agents_by_id: dict[str, AgentConfig],
    session: HandoffSession,
    user_message: str,
) -> AsyncIterator[str]:
    """Async generator that yields SSE-formatted strings for one handoff turn.

    Events:
    - active_agent  {agent_id, agent_name}
    - event         {type, title, detail}   -- function call / result trace
    - delta         {text, agent_id, agent_name}
    - handoff       {from_agent_id, from_agent_name, to_agent_id, to_agent_name}
    - customer_context {...}
    - done          {agent_id, agent_name, text, session_id, current_agent_id,
                     is_complete, customer_context}
    - error         {detail}
    """
    session.history.append(HandoffChatTurn(role="user", text=user_message))

    # -- Lazy-build workflow state on first turn --------------------------------
    if session.session_id not in _workflow_states:
        try:
            ws = await _build_workflow_state(handoff, agents_by_id, session.customer_context)
            _workflow_states[session.session_id] = ws
        except ValueError:
            # Fall back to mock mode using start agent
            start_config = agents_by_id.get(handoff.start_agent_id or "")
            if not start_config and handoff.participant_agent_ids:
                start_config = agents_by_id.get(handoff.participant_agent_ids[0])
            ws = _WorkflowState(
                workflow=None,
                is_mock=True,
                mock_start_config=start_config,
            )
            _workflow_states[session.session_id] = ws

    ws = _workflow_states[session.session_id]

    # -- Mock path (no real LLM credentials) -----------------------------------
    if ws.is_mock:
        agent = ws.mock_start_config
        if not agent:
            yield _sse("error", {"detail": "No agent configured."})
            return

        session.current_agent_id = agent.id
        yield _sse("active_agent", {"agent_id": agent.id, "agent_name": agent.name})
        yield _sse("event", {
            "type": "connection",
            "title": f"{agent.name} に接続中… (model: {agent.model.provider}/{agent.model.model})",
            "detail": "",
        })
        await asyncio.sleep(0.03)

        mock_text = _mock_text(agent, user_message, ["Mock provider selected — no LLM credentials."])
        for i in range(0, len(mock_text), 8):
            chunk = mock_text[i: i + 8]
            yield _sse("delta", {"text": chunk, "agent_id": agent.id, "agent_name": agent.name})
            await asyncio.sleep(0.015)

        session.history.append(HandoffChatTurn(
            role="agent", agent_id=agent.id, agent_name=agent.name, text=mock_text,
        ))
        if handoff.termination_keyword and handoff.termination_keyword.lower() in user_message.lower():
            session.is_complete = True
        yield _sse("event", {"type": "response_complete", "title": "応答完了", "detail": ""})
        yield _sse("done", {
            "agent_id": agent.id, "agent_name": agent.name, "text": mock_text,
            "session_id": session.session_id, "current_agent_id": session.current_agent_id,
            "is_complete": session.is_complete, "customer_context": dict(session.customer_context),
        })
        return

    # -- Live HandoffBuilder path -----------------------------------------------

    # Determine how to invoke the workflow this turn
    if ws.pending_request_id:
        # Resume: respond to the pending request_info from the previous turn
        is_terminating = (
            handoff.termination_keyword
            and handoff.termination_keyword.lower() in user_message.lower()
        )
        response_messages = (
            HandoffAgentUserRequest.terminate()
            if is_terminating
            else HandoffAgentUserRequest.create_response(user_message)
        )
        wf_stream = ws.workflow.run(
            responses={ws.pending_request_id: response_messages},
            stream=True,
        )
    else:
        # First turn: start fresh
        wf_stream = ws.workflow.run(user_message, stream=True)

    ws.pending_request_id = None  # reset; will be set again if workflow pauses

    current_executor_id: str | None = None
    current_agent_text: str = ""
    final_text: str = ""
    final_agent_config: AgentConfig | None = None
    pending_fn_name: str = ""
    pending_fn_args: str = ""

    try:
        async for event in wf_stream:
            if event.type == "output":
                update = event.data
                if not isinstance(update, AgentResponseUpdate):
                    continue

                exec_id = event.executor_id or ""

                # -- Agent change -----------------------------------------------
                if exec_id and exec_id != current_executor_id:
                    if pending_fn_name:
                        yield _sse("event", {
                            "type": "function_call.complete",
                            "title": f"Calling function_call({pending_fn_name})",
                            "detail": pending_fn_args,
                        })
                        pending_fn_name = ""
                        pending_fn_args = ""

                    current_executor_id = exec_id
                    current_agent_text = ""
                    agent_config = ws.name_to_config.get(exec_id)
                    final_agent_config = agent_config
                    session.current_agent_id = agent_config.id if agent_config else exec_id
                    model_info = (
                        f"{agent_config.model.provider}/{agent_config.model.model}"
                        if agent_config else ""
                    )
                    yield _sse("active_agent", {
                        "agent_id": session.current_agent_id,
                        "agent_name": exec_id,
                    })
                    yield _sse("event", {
                        "type": "connection",
                        "title": f"{exec_id} に接続中… (model: {model_info})",
                        "detail": "",
                    })
                    await asyncio.sleep(0.03)

                # -- Function call / result contents ----------------------------
                for content in (update.contents or []):
                    ctype = getattr(content, "type", "")
                    if ctype == "function_call":
                        fn_name = getattr(content, "name", "") or ""
                        fn_args = getattr(content, "arguments", "") or ""
                        if isinstance(fn_args, dict):
                            fn_args = json.dumps(fn_args, indent=2, ensure_ascii=False)
                        if fn_name:
                            if pending_fn_name:
                                yield _sse("event", {
                                    "type": "function_call.complete",
                                    "title": f"Calling function_call({pending_fn_name})",
                                    "detail": pending_fn_args,
                                })
                            # Discard any pre-tool preamble text the LLM emitted before this call
                            if current_agent_text:
                                current_agent_text = ""
                                final_text = ""
                                yield _sse("clear_text", {
                                    "agent_id": session.current_agent_id or "",
                                })
                            pending_fn_name = fn_name
                            pending_fn_args = str(fn_args)
                        else:
                            pending_fn_args += str(fn_args)

                    elif ctype == "function_result":
                        call_name = pending_fn_name
                        if pending_fn_name:
                            yield _sse("event", {
                                "type": "function_call.complete",
                                "title": f"Calling function_call({pending_fn_name})",
                                "detail": pending_fn_args,
                            })
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
                        if update_context_from_output(fn_output, session.customer_context):
                            yield _sse("customer_context", dict(session.customer_context))
                        yield _sse("event", {
                            "type": "function_result.complete",
                            "title": f"Result: {call_name or 'function'}",
                            "detail": fn_output[:300],
                        })

                # -- Text delta ------------------------------------------------
                chunk = update.text or ""
                if chunk:
                    if pending_fn_name:
                        yield _sse("event", {
                            "type": "function_call.complete",
                            "title": f"Calling function_call({pending_fn_name})",
                            "detail": pending_fn_args,
                        })
                        pending_fn_name = ""
                        pending_fn_args = ""
                    current_agent_text += chunk
                    final_text = current_agent_text
                    yield _sse("delta", {
                        "text": chunk,
                        "agent_id": session.current_agent_id or "",
                        "agent_name": exec_id,
                    })

            elif event.type == "handoff_sent":
                sent: HandoffSentEvent = event.data
                from_cfg = ws.name_to_config.get(sent.source)
                to_cfg = ws.name_to_config.get(sent.target)
                yield _sse("handoff", {
                    "from_agent_id": from_cfg.id if from_cfg else sent.source,
                    "from_agent_name": sent.source,
                    "to_agent_id": to_cfg.id if to_cfg else sent.target,
                    "to_agent_name": sent.target,
                })
                yield _sse("event", {
                    "type": "handoff_transition",
                    "title": f"Handoff: {sent.source} -> {sent.target}",
                    "detail": "",
                })

            elif event.type == "request_info":
                # Workflow paused -- save request_id for the next user turn
                ws.pending_request_id = event._request_id  # type: ignore[attr-defined]

            elif event.type == "failed":
                err_msg = (
                    event.details.message  # type: ignore[union-attr]
                    if event.details else "Unknown workflow error"
                )
                yield _sse("event", {"type": "error", "title": "Error", "detail": err_msg})

        # Flush any dangling function call trace
        if pending_fn_name:
            yield _sse("event", {
                "type": "function_call.complete",
                "title": f"Calling function_call({pending_fn_name})",
                "detail": pending_fn_args,
            })

    except Exception as exc:
        err_text = f"\n[Error: {exc}]"
        final_text += err_text
        yield _sse("delta", {
            "text": err_text,
            "agent_id": session.current_agent_id or "",
            "agent_name": current_executor_id or "",
        })

    # -- Record agent turn ------------------------------------------------------
    if final_text:
        session.history.append(HandoffChatTurn(
            role="agent",
            agent_id=session.current_agent_id,
            agent_name=current_executor_id,
            text=final_text,
        ))

    # -- Completion check -------------------------------------------------------
    if ws.pending_request_id is None:
        # Workflow ended without requesting more input -> conversation complete
        session.is_complete = True
    elif handoff.termination_keyword and handoff.termination_keyword.lower() in user_message.lower():
        session.is_complete = True

    yield _sse("event", {"type": "response_complete", "title": "応答完了", "detail": ""})
    # Deduplicate: if second half == first half, keep only the first half
    _n = len(final_text)
    if _n >= 20:
        _mid = _n // 2
        if final_text[_mid:] == final_text[:_mid]:
            final_text = final_text[:_mid]
    yield _sse("done", {
        "agent_id": final_agent_config.id if final_agent_config else (session.current_agent_id or ""),
        "agent_name": current_executor_id or "",
        "text": final_text,
        "session_id": session.session_id,
        "current_agent_id": session.current_agent_id,
        "is_complete": session.is_complete,
        "customer_context": dict(session.customer_context),
    })
