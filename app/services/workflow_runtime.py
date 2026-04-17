from __future__ import annotations

import asyncio
import re
from collections import defaultdict, deque
from typing import Any

from app.models import AgentConfig, ModelSettings, WorkflowDefinition, WorkflowEdge
from app.services.agent_runtime import run_agent


def _ghost_agent(name: str) -> AgentConfig:
    return AgentConfig(
        name=name,
        instructions="This workflow node has no agent attached. Summarize the incoming context and describe what should happen next.",
        model=ModelSettings(provider="mock", model="gpt-4.1-mini"),
    )


def evaluate_condition(expression: str, text: str) -> bool:
    expr = (expression or "").strip()
    if not expr:
        return True

    haystack = text.lower()
    lowered = expr.lower()
    if lowered in {"default", "else", "true", "always"}:
        return True
    if lowered.startswith("contains:"):
        return lowered.split(":", 1)[1].strip() in haystack
    if lowered.startswith("not_contains:"):
        return lowered.split(":", 1)[1].strip() not in haystack
    if lowered.startswith("equals:"):
        return haystack.strip() == lowered.split(":", 1)[1].strip()
    if lowered.startswith("startswith:"):
        return haystack.strip().startswith(lowered.split(":", 1)[1].strip())
    if lowered.startswith("regex:"):
        return re.search(expr.split(":", 1)[1], text, re.IGNORECASE) is not None
    return lowered in haystack


def _to_var_name(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    return cleaned or "node"


def _ordered_nodes(workflow: WorkflowDefinition) -> list:
    if not workflow.nodes:
        return []
    node_map = {node.id: node for node in workflow.nodes}
    start_node_id = workflow.start_node_id or workflow.nodes[0].id
    ordered: list = []
    visited: set[str] = set()
    current = start_node_id
    while current and current in node_map and current not in visited:
        ordered.append(node_map[current])
        visited.add(current)
        direct = sorted(
            [edge for edge in workflow.edges if edge.source == current and edge.edge_type == "direct"],
            key=lambda item: item.priority,
        )
        current = next((edge.target for edge in direct if edge.target not in visited), None)
    ordered.extend([node for node in workflow.nodes if node.id not in visited])
    return ordered


def _resolve_agent(node, agents_by_id: dict[str, AgentConfig]) -> AgentConfig:
    return agents_by_id.get(node.agent_id or "") or _ghost_agent(node.title)


def generate_workflow_code(workflow: WorkflowDefinition, agents_by_id: dict[str, AgentConfig]) -> str:
    pattern = (workflow.pattern or "graph").strip().lower()
    node_vars = {node.id: _to_var_name(node.title or node.id) for node in workflow.nodes}
    ordered_nodes = _ordered_nodes(workflow)

    if pattern == "sequential":
        participant_vars = [node_vars.get(node.id, _to_var_name(node.id)) for node in ordered_nodes]
        lines = [
            "from agent_framework_orchestrations import SequentialBuilder",
            "",
            "# Agent instances are created elsewhere and referenced here by variable name.",
            "workflow = (",
            "    SequentialBuilder(",
            f"        participants=[{', '.join(participant_vars)}],",
            "    )",
            "    .build()",
            ")",
        ]
    elif pattern == "concurrent":
        participant_vars = [node_vars.get(node.id, _to_var_name(node.id)) for node in ordered_nodes]
        lines = [
            "from agent_framework_orchestrations import ConcurrentBuilder",
            "",
            "# Agent instances are created elsewhere and referenced here by variable name.",
            "workflow = (",
            "    ConcurrentBuilder(",
            f"        participants=[{', '.join(participant_vars)}],",
            "    )",
            "    .build()",
            ")",
        ]
    elif pattern == "group-chat":
        participant_vars = [node_vars.get(node.id, _to_var_name(node.id)) for node in ordered_nodes]
        lines = [
            "from agent_framework_orchestrations import GroupChatBuilder",
            "",
            "# Agent instances are created elsewhere and referenced here by variable name.",
            "workflow = (",
            "    GroupChatBuilder(",
            f"        participants=[{', '.join(participant_vars)}],",
            f"        max_rounds={max(1, min(workflow.max_rounds or 6, 30))},",
            "    )",
            "    .build()",
            ")",
        ]
    else:
        start_var = node_vars.get(workflow.start_node_id or (workflow.nodes[0].id if workflow.nodes else "start"), "start_executor")

        lines = [
            "from agent_framework import WorkflowBuilder, Case, Default",
            "",
            "# Agent instances are created elsewhere and referenced here by variable name.",
            f"workflow = (",
            f"    WorkflowBuilder(start_executor={start_var})",
        ]

        switch_sources: set[str] = set()
        multi_sources: set[str] = set()

        for edge in workflow.edges:
            source_var = node_vars.get(edge.source, _to_var_name(edge.source))
            target_var = node_vars.get(edge.target, _to_var_name(edge.target))
            if edge.edge_type == "direct":
                lines.append(f"    .add_edge({source_var}, {target_var})")
            elif edge.edge_type == "conditional":
                condition = edge.condition or edge.label or "contains:approve"
                lines.append(
                    f"    .add_edge({source_var}, {target_var}, condition=lambda msg: {condition!r}.split(':', 1)[-1].lower() in str(msg).lower())"
                )
            elif edge.edge_type == "switch-case":
                switch_sources.add(edge.source)
            elif edge.edge_type == "multi-selection":
                multi_sources.add(edge.source)

        for source in switch_sources:
            source_var = node_vars.get(source, _to_var_name(source))
            switch_edges = [edge for edge in workflow.edges if edge.source == source and edge.edge_type == "switch-case"]
            lines.append(f"    .add_switch_case_edge_group(")
            lines.append(f"        {source_var},")
            lines.append("        [")
            for edge in sorted(switch_edges, key=lambda item: item.priority):
                target_var = node_vars.get(edge.target, _to_var_name(edge.target))
                if not edge.condition:
                    lines.append(f"            Default(target={target_var}),")
                else:
                    token = (edge.condition.split(':', 1)[-1] or edge.label or target_var).lower()
                    lines.append(
                        f"            Case(condition=lambda msg: {token!r} in str(msg).lower(), target={target_var}),"
                    )
            lines.append("        ],")
            lines.append("    )")

        for source in multi_sources:
            source_var = node_vars.get(source, _to_var_name(source))
            multi_edges = [edge for edge in workflow.edges if edge.source == source and edge.edge_type == "multi-selection"]
            target_vars = [node_vars.get(edge.target, _to_var_name(edge.target)) for edge in multi_edges]
            lines.extend(
                [
                    f"    .add_multi_selection_edge_group(",
                    f"        {source_var},",
                    f"        [{', '.join(target_vars)}],",
                    "        selection_func=lambda msg, target_ids: [",
                ]
            )
            for index, edge in enumerate(multi_edges):
                token = (edge.condition.split(':', 1)[-1] if edge.condition else edge.label or "").lower()
                if token:
                    lines.append(f"            target_ids[{index}] if {token!r} in str(msg).lower() else None,")
                else:
                    lines.append(f"            target_ids[{index}],")
            lines.extend([
                "        ],",
                "    )",
            ])

        grouped_fan_in: dict[str, list[WorkflowEdge]] = defaultdict(list)
        for edge in workflow.edges:
            if edge.edge_type == "fan-in":
                grouped_fan_in[edge.target].append(edge)

        for target, edges in grouped_fan_in.items():
            target_var = node_vars.get(target, _to_var_name(target))
            source_vars = ", ".join(node_vars.get(edge.source, _to_var_name(edge.source)) for edge in edges)
            lines.append(f"    .add_fan_in_edges([{source_vars}], {target_var})")

        lines.append("    .build()")
        lines.append(")")

    if workflow.nodes:
        lines.append("")
        lines.append("# Node → attached agents")
        for node in workflow.nodes:
            agent = agents_by_id.get(node.agent_id or "")
            lines.append(f"# {node_vars[node.id]} = {agent.name if agent else 'unassigned agent'}")

    return "\n".join(lines)


async def _run_workflow_graph(workflow: WorkflowDefinition, agents_by_id: dict[str, AgentConfig], prompt: str) -> dict[str, Any]:
    node_map = {node.id: node for node in workflow.nodes}
    outgoing_by_source: dict[str, list[WorkflowEdge]] = defaultdict(list)
    fan_in_sources: dict[str, set[str]] = defaultdict(set)
    for edge in workflow.edges:
        outgoing_by_source[edge.source].append(edge)
        if edge.edge_type == "fan-in":
            fan_in_sources[edge.target].add(edge.source)

    start_node_id = workflow.start_node_id or workflow.nodes[0].id
    queue: deque[tuple[str, str, str | None]] = deque([(start_node_id, prompt, None)])
    fan_in_buffer: dict[str, dict[str, str]] = defaultdict(dict)
    trace: list[dict[str, Any]] = []
    outputs: list[str] = []
    step_count = 0

    while queue and step_count < 50:
        step_count += 1
        node_id, inbound_text, from_node = queue.popleft()
        node = node_map[node_id]
        agent = _resolve_agent(node, agents_by_id)
        prepared_prompt = (
            f"Workflow: {workflow.name}\n"
            f"Node: {node.title}\n"
            f"Incoming context from {from_node or 'user'}:\n{inbound_text}\n\n"
            f"Original user input:\n{prompt}"
        )
        result = await run_agent(agent, prepared_prompt)
        text = result["text"]
        trace.append(
            {
                "step": step_count,
                "node": node.title,
                "node_id": node.id,
                "agent": agent.name,
                "mode": result["mode"],
                "input": inbound_text,
                "output": text,
            }
        )

        outgoing = sorted(outgoing_by_source.get(node_id, []), key=lambda item: item.priority)
        routed = False

        def enqueue(edge: WorkflowEdge) -> None:
            nonlocal routed
            routed = True
            if edge.edge_type == "fan-in":
                fan_in_buffer[edge.target][edge.source] = text
                if fan_in_sources[edge.target].issubset(fan_in_buffer[edge.target].keys()):
                    combined = "\n\n".join(
                        f"From {node_map[source].title}:\n{fan_in_buffer[edge.target][source]}"
                        for source in sorted(fan_in_sources[edge.target])
                    )
                    fan_in_buffer[edge.target].clear()
                    queue.append((edge.target, combined, node.title))
            else:
                queue.append((edge.target, text, node.title))

        switch_edges = [edge for edge in outgoing if edge.edge_type == "switch-case"]
        if switch_edges:
            default_edge = next((edge for edge in switch_edges if not edge.condition), None)
            matched = next((edge for edge in switch_edges if edge.condition and evaluate_condition(edge.condition, text)), None)
            if matched or default_edge:
                enqueue(matched or default_edge)

        for edge in [edge for edge in outgoing if edge.edge_type == "direct"]:
            enqueue(edge)

        for edge in [edge for edge in outgoing if edge.edge_type == "conditional"]:
            if evaluate_condition(edge.condition, text):
                enqueue(edge)

        multi_edges = [edge for edge in outgoing if edge.edge_type == "multi-selection"]
        if multi_edges:
            selected = [edge for edge in multi_edges if evaluate_condition(edge.condition, text)]
            if not selected:
                selected = [edge for edge in multi_edges if not edge.condition][:1]
            for edge in selected:
                enqueue(edge)

        if not routed:
            outputs.append(text)

    if queue:
        outputs.append("Workflow stopped after reaching the safety iteration limit (50 steps).")

    return {"trace": trace, "outputs": outputs}


async def _run_workflow_sequential(workflow: WorkflowDefinition, agents_by_id: dict[str, AgentConfig], prompt: str) -> dict[str, Any]:
    ordered_nodes = _ordered_nodes(workflow)
    trace: list[dict[str, Any]] = []
    inbound = prompt
    from_node: str | None = None
    for step_count, node in enumerate(ordered_nodes, start=1):
        agent = _resolve_agent(node, agents_by_id)
        prepared_prompt = (
            f"Workflow: {workflow.name}\n"
            f"Node: {node.title}\n"
            f"Incoming context from {from_node or 'user'}:\n{inbound}\n\n"
            f"Original user input:\n{prompt}"
        )
        result = await run_agent(agent, prepared_prompt)
        text = result["text"]
        trace.append(
            {
                "step": step_count,
                "node": node.title,
                "node_id": node.id,
                "agent": agent.name,
                "mode": result["mode"],
                "input": inbound,
                "output": text,
            }
        )
        inbound = text
        from_node = node.title
    return {"trace": trace, "outputs": [inbound] if trace else []}


async def _run_workflow_concurrent(workflow: WorkflowDefinition, agents_by_id: dict[str, AgentConfig], prompt: str) -> dict[str, Any]:
    ordered_nodes = _ordered_nodes(workflow)

    async def run_one(node) -> tuple:
        agent = _resolve_agent(node, agents_by_id)
        prepared_prompt = (
            f"Workflow: {workflow.name}\n"
            f"Node: {node.title}\n"
            f"Incoming context from user:\n{prompt}\n\n"
            f"Original user input:\n{prompt}"
        )
        result = await run_agent(agent, prepared_prompt)
        return node, agent, result

    results = await asyncio.gather(*(run_one(node) for node in ordered_nodes))
    trace: list[dict[str, Any]] = []
    outputs: list[str] = []
    for step_count, (node, agent, result) in enumerate(results, start=1):
        text = result["text"]
        trace.append(
            {
                "step": step_count,
                "node": node.title,
                "node_id": node.id,
                "agent": agent.name,
                "mode": result["mode"],
                "input": prompt,
                "output": text,
            }
        )
        outputs.append(f"{node.title}: {text}")
    return {"trace": trace, "outputs": outputs}


async def _run_workflow_group_chat(workflow: WorkflowDefinition, agents_by_id: dict[str, AgentConfig], prompt: str) -> dict[str, Any]:
    ordered_nodes = _ordered_nodes(workflow)
    if not ordered_nodes:
        return {"trace": [], "outputs": []}

    trace: list[dict[str, Any]] = []
    max_rounds = max(1, min(workflow.max_rounds or 6, 30))
    conversation = f"User: {prompt}"
    for step_count in range(1, max_rounds + 1):
        node = ordered_nodes[(step_count - 1) % len(ordered_nodes)]
        prev_node = ordered_nodes[(step_count - 2) % len(ordered_nodes)] if step_count > 1 else None
        agent = _resolve_agent(node, agents_by_id)
        prepared_prompt = (
            f"Workflow: {workflow.name}\n"
            f"Node: {node.title}\n"
            f"Incoming context from {prev_node.title if prev_node else 'user'}:\n{conversation}\n\n"
            f"Original user input:\n{prompt}"
        )
        result = await run_agent(agent, prepared_prompt)
        text = result["text"]
        trace.append(
            {
                "step": step_count,
                "node": node.title,
                "node_id": node.id,
                "agent": agent.name,
                "mode": result["mode"],
                "input": conversation,
                "output": text,
            }
        )
        conversation += f"\n{node.title}: {text}"
    return {"trace": trace, "outputs": [conversation]}


async def run_workflow(workflow: WorkflowDefinition, agents_by_id: dict[str, AgentConfig], prompt: str) -> dict[str, Any]:
    if not workflow.nodes:
        return {
            "trace": [],
            "outputs": ["No workflow nodes have been added yet."],
            "generated_code": generate_workflow_code(workflow, agents_by_id),
        }

    pattern = (workflow.pattern or "graph").strip().lower()
    if pattern == "sequential":
        result = await _run_workflow_sequential(workflow, agents_by_id, prompt)
    elif pattern == "concurrent":
        result = await _run_workflow_concurrent(workflow, agents_by_id, prompt)
    elif pattern == "group-chat":
        result = await _run_workflow_group_chat(workflow, agents_by_id, prompt)
    else:
        result = await _run_workflow_graph(workflow, agents_by_id, prompt)

    return {
        "trace": result["trace"],
        "outputs": result["outputs"],
        "generated_code": generate_workflow_code(workflow, agents_by_id),
    }
