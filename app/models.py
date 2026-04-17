from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

EdgeType = Literal["direct", "conditional", "switch-case", "multi-selection", "fan-in"]
WorkflowPatternType = Literal["graph", "sequential", "concurrent", "group-chat"]
ProviderType = Literal["mock", "openai", "azure-openai", "foundry"]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ModelSettings(BaseModel):
    provider: ProviderType = "mock"
    model: str = "gpt-4.1-mini"
    temperature: float = 0.2
    api_key_env: str = "OPENAI_API_KEY"
    base_url: str | None = None
    api_version: str | None = None
    azure_endpoint_env: str = "AZURE_OPENAI_ENDPOINT"
    project_endpoint_env: str = "AZURE_AI_PROJECT_ENDPOINT"


class MCPToolConfig(BaseModel):
    id: str = Field(default_factory=lambda: f"mcp-{uuid4().hex[:8]}")
    name: str = "Microsoft Learn MCP"
    url: str = ""
    approval_mode: Literal["always_require", "never_require"] = "never_require"
    description: str = ""
    allowed_tools: list[str] = Field(default_factory=list)
    headers: dict[str, str] = Field(default_factory=dict)


class SkillScriptInfo(BaseModel):
    name: str
    path: str


class SkillRecord(BaseModel):
    id: str
    name: str
    description: str = ""
    path: str
    source_type: Literal["folder", "files", "sample"] = "folder"
    uploaded_at: str = Field(default_factory=utc_now)
    has_skill_md: bool = True
    scripts: list[SkillScriptInfo] = Field(default_factory=list)
    resources: list[str] = Field(default_factory=list)


class AgentConfig(BaseModel):
    id: str = Field(default_factory=lambda: f"agent-{uuid4().hex[:8]}")
    name: str = "New Agent"
    description: str = ""
    instructions: str = "You are a helpful Microsoft Agent Framework assistant."
    model: ModelSettings = Field(default_factory=ModelSettings)
    mcp_tools: list[MCPToolConfig] = Field(default_factory=list)
    skill_ids: list[str] = Field(default_factory=list)
    default_prompt: str = "Summarize the current plan and propose next actions."
    created_at: str = Field(default_factory=utc_now)


class NodePosition(BaseModel):
    x: float = 80
    y: float = 80


class WorkflowNode(BaseModel):
    id: str = Field(default_factory=lambda: f"node-{uuid4().hex[:8]}")
    title: str = "Agent Node"
    agent_id: str | None = None
    position: NodePosition = Field(default_factory=NodePosition)


class WorkflowEdge(BaseModel):
    id: str = Field(default_factory=lambda: f"edge-{uuid4().hex[:8]}")
    source: str
    target: str
    edge_type: EdgeType = "direct"
    label: str = ""
    condition: str = ""
    priority: int = 0


class WorkflowDefinition(BaseModel):
    id: str = Field(default_factory=lambda: f"wf-{uuid4().hex[:8]}")
    name: str = "New Workflow"
    description: str = ""
    input_text: str = "Review the proposal and return a concise decision."
    pattern: WorkflowPatternType = "graph"
    max_rounds: int = 6
    start_node_id: str | None = None
    nodes: list[WorkflowNode] = Field(default_factory=list)
    edges: list[WorkflowEdge] = Field(default_factory=list)
    created_at: str = Field(default_factory=utc_now)


class StudioState(BaseModel):
    agents: list[AgentConfig] = Field(default_factory=list)
    workflows: list[WorkflowDefinition] = Field(default_factory=list)
    skills: list[SkillRecord] = Field(default_factory=list)
    handoffs: list[HandoffDefinition] = Field(default_factory=list)


class AgentTestRequest(BaseModel):
    agent: AgentConfig
    prompt: str


class SkillRunRequest(BaseModel):
    script_name: str
    args: dict[str, Any] = Field(default_factory=dict)


class WorkflowTestRequest(BaseModel):
    workflow: WorkflowDefinition
    prompt: str


# ── Handoff Orchestration ────────────────────────────────────


class HandoffRule(BaseModel):
    """A single directional handoff rule: source agent can hand off to target agents."""
    source_agent_id: str
    target_agent_ids: list[str] = Field(default_factory=list)


class HandoffDefinition(BaseModel):
    id: str = Field(default_factory=lambda: f"handoff-{uuid4().hex[:8]}")
    name: str = "New Handoff Workflow"
    description: str = ""
    participant_agent_ids: list[str] = Field(default_factory=list)
    start_agent_id: str | None = None
    rules: list[HandoffRule] = Field(default_factory=list)
    termination_keyword: str = "goodbye"
    autonomous_mode: bool = False
    created_at: str = Field(default_factory=utc_now)


class HandoffChatRequest(BaseModel):
    handoff_id: str
    message: str
    session_id: str | None = None


class HandoffChatTurn(BaseModel):
    role: str  # "user" | "agent"
    agent_id: str | None = None
    agent_name: str | None = None
    text: str
    timestamp: str = Field(default_factory=utc_now)


class HandoffSession(BaseModel):
    session_id: str = Field(default_factory=lambda: f"hs-{uuid4().hex[:12]}")
    handoff_id: str
    current_agent_id: str | None = None
    history: list[HandoffChatTurn] = Field(default_factory=list)
    is_complete: bool = False
    created_at: str = Field(default_factory=utc_now)
    # Persistent context shared across all turns and agents
    customer_context: dict = Field(default_factory=dict)
