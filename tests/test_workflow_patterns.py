from __future__ import annotations

import asyncio

from app.models import AgentConfig, ModelSettings, NodePosition, WorkflowDefinition, WorkflowNode
from app.services import workflow_runtime


def _agent(agent_id: str, name: str) -> AgentConfig:
    return AgentConfig(id=agent_id, name=name, model=ModelSettings(provider="mock", model="gpt-4.1-mini"))


def _workflow(pattern: str, max_rounds: int = 6) -> WorkflowDefinition:
    return WorkflowDefinition(
        id="wf-pattern",
        name="Pattern Test",
        pattern=pattern,
        max_rounds=max_rounds,
        start_node_id="node-a",
        nodes=[
            WorkflowNode(id="node-a", title="Agent A", agent_id="agent-a", position=NodePosition(x=0, y=0)),
            WorkflowNode(id="node-b", title="Agent B", agent_id="agent-b", position=NodePosition(x=200, y=0)),
        ],
        edges=[],
    )


def test_generate_workflow_code_for_patterns():
    wf_seq = _workflow("sequential")
    wf_con = _workflow("concurrent")
    wf_gc = _workflow("group-chat", max_rounds=4)
    wf_graph = _workflow("graph")
    wf_graph.edges = []

    agents_by_id = {"agent-a": _agent("agent-a", "A"), "agent-b": _agent("agent-b", "B")}

    seq_code = workflow_runtime.generate_workflow_code(wf_seq, agents_by_id)
    con_code = workflow_runtime.generate_workflow_code(wf_con, agents_by_id)
    gc_code = workflow_runtime.generate_workflow_code(wf_gc, agents_by_id)
    graph_code = workflow_runtime.generate_workflow_code(wf_graph, agents_by_id)

    assert "SequentialBuilder" in seq_code
    assert "ConcurrentBuilder" in con_code
    assert "GroupChatBuilder" in gc_code
    assert "max_rounds=4" in gc_code
    assert "WorkflowBuilder" in graph_code


async def _fake_run_agent(agent: AgentConfig, prompt: str) -> dict[str, str]:
    incoming = prompt.split("Incoming context from", 1)[-1].strip().splitlines()[0]
    return {"text": f"{agent.name} -> {incoming}", "mode": "mock"}


def test_run_workflow_sequential(monkeypatch):
    monkeypatch.setattr(workflow_runtime, "run_agent", _fake_run_agent)
    wf = _workflow("sequential")
    result = asyncio.run(
        workflow_runtime.run_workflow(wf, {"agent-a": _agent("agent-a", "A"), "agent-b": _agent("agent-b", "B")}, "hello")
    )
    assert [step["node"] for step in result["trace"]] == ["Agent A", "Agent B"]
    assert len(result["outputs"]) == 1
    assert result["outputs"][0].startswith("B ->")


def test_run_workflow_concurrent(monkeypatch):
    monkeypatch.setattr(workflow_runtime, "run_agent", _fake_run_agent)
    wf = _workflow("concurrent")
    result = asyncio.run(
        workflow_runtime.run_workflow(wf, {"agent-a": _agent("agent-a", "A"), "agent-b": _agent("agent-b", "B")}, "hello")
    )
    assert [step["node"] for step in result["trace"]] == ["Agent A", "Agent B"]
    assert len(result["outputs"]) == 2
    assert all("-> user:" in item for item in result["outputs"])


def test_run_workflow_group_chat(monkeypatch):
    monkeypatch.setattr(workflow_runtime, "run_agent", _fake_run_agent)
    wf = _workflow("group-chat", max_rounds=3)
    result = asyncio.run(
        workflow_runtime.run_workflow(wf, {"agent-a": _agent("agent-a", "A"), "agent-b": _agent("agent-b", "B")}, "hello")
    )
    assert [step["node"] for step in result["trace"]] == ["Agent A", "Agent B", "Agent A"]
    assert len(result["outputs"]) == 1
    assert "User: hello" in result["outputs"][0]
