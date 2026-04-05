from __future__ import annotations

import asyncio
import inspect
import json
import os
import textwrap
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import Any

from dotenv import load_dotenv
from agent_framework import Agent, MCPStreamableHTTPTool
from agent_framework.openai import OpenAIChatClient, OpenAIChatCompletionClient
from azure.identity.aio import DefaultAzureCredential

from app.models import AgentConfig, MCPToolConfig, ModelSettings
from app.services.skill_runner import build_skills_provider

load_dotenv(override=False)


async def _close_resource(resource: Any) -> None:
    close_method = getattr(resource, "close", None)
    if close_method is None:
        return
    result = close_method()
    if inspect.isawaitable(result):
        await result


async def _resolve_client(settings: ModelSettings) -> tuple[Any | None, list[Any], list[str]]:
    cleanup: list[Any] = []
    issues: list[str] = []

    if settings.provider == "mock":
        issues.append("Mock provider selected — using local preview mode.")
        return None, cleanup, issues

    if settings.provider == "openai":
        api_key = os.getenv(settings.api_key_env)
        if not api_key:
            issues.append(f"Environment variable '{settings.api_key_env}' is not set.")
            return None, cleanup, issues
        client = OpenAIChatClient(
            model=settings.model,
            api_key=api_key,
            base_url=settings.base_url or None,
        )
        cleanup.append(client)
        return client, cleanup, issues

    if settings.provider == "azure-openai":
        import re as _re

        endpoint = settings.base_url or os.getenv(settings.azure_endpoint_env) or ""
        # Strip /openai/v1 suffix — OpenAIChatCompletionClient expects the base endpoint
        azure_endpoint = _re.sub(r"/openai(/v\d+)?/?$", "", endpoint.rstrip("/"))
        if not azure_endpoint:
            issues.append(f"Azure OpenAI requires endpoint ('{settings.azure_endpoint_env}').")
            return None, cleanup, issues
        api_key = os.getenv(settings.api_key_env or "AZURE_OPENAI_API_KEY") or None
        api_version = settings.api_version or os.getenv("AZURE_OPENAI_API_VERSION") or None
        if api_key:
            client = OpenAIChatCompletionClient(
                model=settings.model,
                api_key=api_key,
                azure_endpoint=azure_endpoint,
                api_version=api_version,
            )
        else:
            # Use DefaultAzureCredential (az login) when no API key is set
            credential = DefaultAzureCredential()
            cleanup.append(credential)
            client = OpenAIChatCompletionClient(
                model=settings.model,
                credential=credential,
                azure_endpoint=azure_endpoint,
                api_version=api_version,
            )
            issues.append("Using DefaultAzureCredential (az login) for authentication.")
        cleanup.append(client)
        return client, cleanup, issues

    if settings.provider == "foundry":
        project_endpoint = settings.base_url or os.getenv(settings.project_endpoint_env)
        if not project_endpoint:
            issues.append(f"Foundry requires project endpoint env '{settings.project_endpoint_env}'.")
            return None, cleanup, issues
        try:
            from agent_framework.azure import AzureAIClient  # type: ignore[attr-defined]
        except (ImportError, AttributeError):
            issues.append("AzureAIClient not available in this version of agent-framework-core.")
            return None, cleanup, issues
        credential = DefaultAzureCredential()
        cleanup.append(credential)
        client = AzureAIClient(
            project_endpoint=project_endpoint,
            model_deployment_name=settings.model,
            credential=credential,
        )
        cleanup.append(client)
        return client, cleanup, issues

    issues.append(f"Unknown provider: {settings.provider}")
    return None, cleanup, issues


def _build_mcp_tools(mcp_tools: list[MCPToolConfig], client: Any | None) -> list[Any]:
    tools: list[Any] = []
    for item in mcp_tools:
        if not item.url.strip():
            continue
        tools.append(
            MCPStreamableHTTPTool(
                name=item.name,
                url=item.url,
                description=item.description or None,
                approval_mode=item.approval_mode,
                allowed_tools=item.allowed_tools or None,
                headers=item.headers or None,
                client=client,
            )
        )
    return tools


def _mock_text(agent: AgentConfig, prompt: str, issues: list[str], error: str | None = None) -> str:
    skill_text = ", ".join(agent.skill_ids) if agent.skill_ids else "none"
    mcp_text = ", ".join(item.name for item in agent.mcp_tools if item.url.strip()) or "none"
    status_lines = issues[:] or ["Using local preview mode."]
    if error:
        status_lines.append(f"Fell back after error: {error}")
    notes = "\n".join(f"- {line}" for line in status_lines)

    return textwrap.dedent(
        f"""
        [Local agent preview]
        Agent: {agent.name}
        Provider: {agent.model.provider}
        Model: {agent.model.model}
        Skills: {skill_text}
        MCP tools: {mcp_text}

        Instructions summary:
        {agent.instructions.strip()[:500]}

        Prompt:
        {prompt.strip()}

        Runtime notes:
        {notes}
        """
    ).strip()


def _build_mock_events(agent: AgentConfig, prompt: str, issues: list[str], error: str | None = None) -> list[dict[str, Any]]:
    """Build structured trace events for the mock provider."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    ts = now.strftime("%I:%M:%S %p")
    events: list[dict[str, Any]] = []

    # Connection
    provider_label = {
        "mock": "Mock preview",
        "openai": "OpenAI",
        "azure-openai": "Azure OpenAI",
        "foundry": "Azure AI Foundry",
    }.get(agent.model.provider, agent.model.provider)
    events.append({
        "timestamp": ts,
        "type": "connection",
        "title": f"{provider_label} に接続中… (model: {agent.model.model})",
        "detail": "",
    })

    # Available skills
    skill_names = ", ".join(agent.skill_ids) if agent.skill_ids else None
    if skill_names:
        events.append({
            "timestamp": ts,
            "type": "skills_available",
            "title": f"利用可能な Skills: {skill_names}",
            "detail": "",
        })

    # Available MCP tools
    mcp_names = ", ".join(t.name for t in agent.mcp_tools if t.url.strip())
    if mcp_names:
        events.append({
            "timestamp": ts,
            "type": "mcp_available",
            "title": f"利用可能な MCP: {mcp_names}",
            "detail": "",
        })

    for tool in agent.mcp_tools:
        if tool.url.strip():
            events.append({
                "timestamp": ts,
                "type": "function_call.complete",
                "title": f"Calling function_call({tool.name})",
                "detail": json.dumps({"tool": tool.name, "url": tool.url}, indent=2),
            })

    for sid in agent.skill_ids:
        events.append({
            "timestamp": ts,
            "type": "skill_load",
            "title": f"load_skill: {sid}",
            "detail": json.dumps({"skill_id": sid}, indent=2),
        })

    if error:
        events.append({
            "timestamp": ts,
            "type": "error",
            "title": f"Error: {error}",
            "detail": "",
        })

    events.append({
        "timestamp": ts,
        "type": "response_complete",
        "title": "応答完了",
        "detail": "",
    })

    return events


async def run_agent(agent: AgentConfig, prompt: str) -> dict[str, Any]:
    client, cleanup, issues = await _resolve_client(agent.model)
    if client is None:
        text = _mock_text(agent, prompt, issues)
        return {
            "mode": "mock",
            "text": text,
            "issues": issues,
            "events": _build_mock_events(agent, prompt, issues),
        }

    skills_provider = build_skills_provider(agent.skill_ids)
    context_providers = [skills_provider] if skills_provider else None
    tools = _build_mcp_tools(agent.mcp_tools, client)

    try:
        runtime_agent = Agent(
            client=client,
            name=agent.name,
            description=agent.description or None,
            instructions=agent.instructions,
            tools=tools or None,
            context_providers=context_providers,
        )
        result = await runtime_agent.run(prompt)
        text = result.text if result.text else str(result)

        # Build live trace events from the actual response messages
        live_events = _build_live_events(agent, result, issues)

        return {
            "mode": "live",
            "text": text,
            "issues": issues,
            "events": live_events,
        }
    except Exception as exc:  # pragma: no cover - handled at runtime
        text = _mock_text(agent, prompt, issues, error=str(exc))
        return {
            "mode": "fallback",
            "text": text,
            "issues": issues + [str(exc)],
            "error": str(exc),
            "events": _build_mock_events(agent, prompt, issues, error=str(exc)),
        }
    finally:
        await asyncio.gather(*(_close_resource(resource) for resource in cleanup), return_exceptions=True)


# ------------------------------------------------------------------
#  SSE Streaming
# ------------------------------------------------------------------

def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%I:%M:%S %p")


def _sse(event: str, data: dict) -> str:
    """Format a single SSE message."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


async def stream_agent(agent: AgentConfig, prompt: str) -> AsyncGenerator[str, None]:
    """Run agent in streaming mode, yielding SSE messages."""
    client, cleanup, issues = await _resolve_client(agent.model)

    if client is None:
        # Mock mode — emit mock events + full text at once
        mock_text = _mock_text(agent, prompt, issues)
        for ev in _build_mock_events(agent, prompt, issues):
            yield _sse("event", ev)
        yield _sse("delta", {"text": mock_text})
        yield _sse("done", {"mode": "mock", "text": mock_text, "issues": issues})
        return

    skills_provider = build_skills_provider(agent.skill_ids)
    context_providers = [skills_provider] if skills_provider else None
    tools = _build_mcp_tools(agent.mcp_tools, client)

    try:
        runtime_agent = Agent(
            client=client,
            name=agent.name,
            description=agent.description or None,
            instructions=agent.instructions,
            tools=tools or None,
            context_providers=context_providers,
        )

        # Emit initial connection event
        provider_label = {
            "mock": "Mock preview",
            "openai": "OpenAI",
            "azure-openai": "Azure OpenAI",
            "foundry": "Azure AI Foundry",
        }.get(agent.model.provider, agent.model.provider)
        yield _sse("event", {
            "timestamp": _ts(), "type": "connection",
            "title": f"{provider_label} に接続中… (model: {agent.model.model})",
            "detail": "",
        })

        # Emit available skills
        skill_names = ", ".join(agent.skill_ids) if agent.skill_ids else None
        if skill_names:
            yield _sse("event", {
                "timestamp": _ts(), "type": "skills_available",
                "title": f"利用可能な Skills: {skill_names}",
                "detail": "",
            })

        # Emit available MCP tools
        mcp_names = ", ".join(t.name for t in agent.mcp_tools if t.url.strip())
        if mcp_names:
            yield _sse("event", {
                "timestamp": _ts(), "type": "mcp_available",
                "title": f"利用可能な MCP: {mcp_names}",
                "detail": "",
            })

        # Stream the agent response
        full_text = ""
        pending_fn_name = ""
        pending_fn_args = ""
        stream = runtime_agent.run(prompt, stream=True)
        async for update in stream:
            # Check for function call / tool use in contents
            for content in (update.contents or []):
                ctype = getattr(content, "type", "")
                if ctype == "function_call":
                    fn_name = getattr(content, "name", "") or ""
                    fn_args = getattr(content, "arguments", "") or ""
                    if isinstance(fn_args, dict):
                        fn_args = json.dumps(fn_args, indent=2, default=str)
                    # During streaming, function calls may arrive in chunks.
                    # Accumulate — only a chunk with a name starts a new call.
                    if fn_name:
                        # Emit any previously pending call
                        if pending_fn_name:
                            yield _sse("event", {
                                "timestamp": _ts(), "type": "function_call.complete",
                                "title": f"Calling function_call({pending_fn_name})",
                                "detail": pending_fn_args,
                            })
                        pending_fn_name = fn_name
                        pending_fn_args = str(fn_args)
                    else:
                        # Continuation chunk — accumulate args
                        pending_fn_args += str(fn_args)
                elif ctype == "function_result":
                    # Flush any pending call before result
                    if pending_fn_name:
                        yield _sse("event", {
                            "timestamp": _ts(), "type": "function_call.complete",
                            "title": f"Calling function_call({pending_fn_name})",
                            "detail": pending_fn_args,
                        })
                        pending_fn_name = ""
                        pending_fn_args = ""

            # Text delta
            chunk = update.text or ""
            if chunk:
                # Flush any pending function call before text starts
                if pending_fn_name:
                    yield _sse("event", {
                        "timestamp": _ts(), "type": "function_call.complete",
                        "title": f"Calling function_call({pending_fn_name})",
                        "detail": pending_fn_args,
                    })
                    pending_fn_name = ""
                    pending_fn_args = ""
                full_text += chunk
                yield _sse("delta", {"text": chunk})

        # Flush any remaining pending function call
        if pending_fn_name:
            yield _sse("event", {
                "timestamp": _ts(), "type": "function_call.complete",
                "title": f"Calling function_call({pending_fn_name})",
                "detail": pending_fn_args,
            })
            pending_fn_name = ""
            pending_fn_args = ""

        # Get final response
        final = await stream.get_final_response()
        final_text = final.text if final.text else full_text

        # If we accumulated no text via streaming deltas, send the full text
        if not full_text and final_text:
            yield _sse("delta", {"text": final_text})
            full_text = final_text

        # Build events from final response messages
        live_events = _build_live_events(agent, final, [])
        # Emit any events we haven't already streamed (e.g., tool calls from messages)
        for ev in live_events:
            yield _sse("event", ev)

        # Emit response complete
        yield _sse("event", {
            "timestamp": _ts(), "type": "response_complete",
            "title": "応答完了",
            "detail": "",
        })

        yield _sse("done", {"mode": "live", "text": full_text, "issues": issues})

    except Exception as exc:
        yield _sse("event", {
            "timestamp": _ts(), "type": "error",
            "title": f"Error: {exc}", "detail": str(exc),
        })
        mock_text = _mock_text(agent, prompt, issues, error=str(exc))
        yield _sse("delta", {"text": mock_text})
        yield _sse("done", {"mode": "fallback", "text": mock_text, "issues": issues + [str(exc)]})
    finally:
        await asyncio.gather(*(_close_resource(resource) for resource in cleanup), return_exceptions=True)


def _build_live_events(agent: AgentConfig, result: Any, issues: list[str]) -> list[dict[str, Any]]:
    """Build trace events from a real AgentResponse."""
    ts = _ts()
    events: list[dict[str, Any]] = []

    # Extract events from response messages
    messages = getattr(result, "messages", []) or []

    # First pass: build a map of tool_call_id → function name from assistant messages
    tool_call_names: dict[str, str] = {}
    for msg in messages:
        raw = getattr(msg, "raw_representation", None)
        if raw:
            tool_calls = getattr(raw, "tool_calls", None)
            if not tool_calls and isinstance(raw, dict):
                tool_calls = raw.get("tool_calls")
            if tool_calls:
                for tc in tool_calls:
                    tc_id = getattr(tc, "id", None) or (tc.get("id") if isinstance(tc, dict) else None) or ""
                    tc_fn = getattr(tc, "function", None)
                    if tc_fn:
                        tc_name = getattr(tc_fn, "name", "")
                        tc_args = getattr(tc_fn, "arguments", "")
                    elif isinstance(tc, dict) and tc.get("function"):
                        tc_name = tc["function"].get("name", "")
                        tc_args = tc["function"].get("arguments", "")
                    else:
                        tc_name = getattr(tc, "name", "") or (tc.get("name", "") if isinstance(tc, dict) else "")
                        tc_args = ""
                    if tc_id:
                        tool_call_names[tc_id] = tc_name

    # Second pass: emit events
    for msg in messages:
        role = getattr(msg, "role", "unknown")
        author = getattr(msg, "author_name", None) or ""
        additional = getattr(msg, "additional_properties", {}) or {}
        raw = getattr(msg, "raw_representation", None)

        if role == "tool":
            # Skip tool results — these are shown via streaming events
            pass
        elif role == "assistant":
            msg_text = msg.text if hasattr(msg, "text") else str(msg)
            has_tool_calls = False

            if raw:
                tool_calls = getattr(raw, "tool_calls", None)
                if not tool_calls and isinstance(raw, dict):
                    tool_calls = raw.get("tool_calls")

                if tool_calls:
                    has_tool_calls = True
                    for tc in tool_calls:
                        tc_fn = getattr(tc, "function", None)
                        if tc_fn:
                            tc_name = getattr(tc_fn, "name", "")
                            tc_args = getattr(tc_fn, "arguments", "")
                        elif isinstance(tc, dict) and tc.get("function"):
                            tc_name = tc["function"].get("name", "")
                            tc_args = tc["function"].get("arguments", "")
                        else:
                            tc_name = getattr(tc, "name", "") or (tc.get("name", "") if isinstance(tc, dict) else "")
                            tc_args = ""

                        events.append({
                            "timestamp": ts,
                            "type": "function_call.complete",
                            "title": f"Calling function_call({tc_name})",
                            "detail": tc_args if isinstance(tc_args, str) else json.dumps(tc_args, indent=2, default=str),
                        })

            # Skip assistant text messages — already shown via streaming
            pass

    return events
