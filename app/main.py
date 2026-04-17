from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.core.config import APP_NAME, BASE_DIR
from app.models import AgentConfig, AgentTestRequest, HandoffChatRequest, HandoffDefinition, SkillRunRequest, StudioState, WorkflowDefinition, WorkflowTestRequest
from app.services.agent_runtime import run_agent, stream_agent
from app.services.customer_service import get_customer_profile
from app.services.handoff_runtime import clear_session, get_or_create_session, get_session, stream_handoff_turn
from app.services.skill_runner import discover_skills, run_local_skill_script, save_uploaded_skill
from app.services.storage import StudioRepository
from app.services.workflow_runtime import generate_workflow_code, run_workflow

logger = logging.getLogger(__name__)

app = FastAPI(title=APP_NAME)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "app" / "static"), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "app" / "templates"))
repo = StudioRepository()


@app.on_event("startup")
async def startup() -> None:
    repo.load_state()


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"title": APP_NAME},
    )


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/state")
async def get_state() -> dict[str, object]:
    state = repo.load_state()
    return {
        "state": state.model_dump(mode="json"),
        "edgeTypes": ["direct", "conditional", "switch-case", "multi-selection", "fan-in"],
        "workflowPatterns": ["graph", "sequential", "concurrent", "group-chat"],
        "tips": [
            "Use folder upload for complete file-based skills (SKILL.md + scripts + references).",
            "Set provider env vars to switch agent tests from mock preview to live model execution.",
            "Workflow code preview shows the Agent Framework edge APIs that match the canvas graph.",
        ],
    }


@app.get("/api/models/azure")
async def list_azure_models() -> dict[str, object]:
    """List deployments from the configured Azure OpenAI resource using az login / DefaultAzureCredential.

    Uses the Azure Management plane (Resource Graph + ARM) because the
    data-plane does not expose a list-deployments endpoint in stable API
    versions.
    """
    import re

    raw_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
    if not raw_endpoint:
        raise HTTPException(status_code=400, detail="AZURE_OPENAI_ENDPOINT is not set in .env")

    # Extract account name from endpoint (e.g. https://MY-RESOURCE.openai.azure.com/...)
    m = re.search(r"https://([^.]+)\.openai\.azure\.com", raw_endpoint, re.IGNORECASE)
    if not m:
        raise HTTPException(status_code=400, detail=f"Cannot parse account name from endpoint: {raw_endpoint}")
    account_name = m.group(1)

    try:
        from azure.identity import DefaultAzureCredential

        credential = DefaultAzureCredential()
        mgmt_token = credential.get_token("https://management.azure.com/.default")
    except Exception as exc:
        logger.warning("DefaultAzureCredential failed: %s", exc)
        raise HTTPException(
            status_code=401,
            detail=f"Azure credential error – run 'az login' first. ({exc})",
        ) from exc

    headers = {"Authorization": f"Bearer {mgmt_token.token}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=20) as client:
        # Step 1: Find the resource via Azure Resource Graph
        graph_body = {
            "query": (
                "Resources "
                "| where type =~ 'microsoft.cognitiveservices/accounts' "
                f"| where name =~ '{account_name}' "
                "| project id, name, resourceGroup, subscriptionId"
            ),
        }
        graph_resp = await client.post(
            "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01",
            headers=headers,
            json=graph_body,
        )
        if graph_resp.status_code != 200:
            raise HTTPException(status_code=graph_resp.status_code, detail=f"Resource Graph error: {graph_resp.text[:500]}")

        rows = graph_resp.json().get("data", [])
        if not rows:
            raise HTTPException(status_code=404, detail=f"Azure OpenAI resource '{account_name}' not found via Resource Graph")

        resource_id = rows[0]["id"]

        # Step 2: List deployments via ARM
        deploy_url = f"https://management.azure.com{resource_id}/deployments?api-version=2024-10-01"
        deploy_resp = await client.get(deploy_url, headers=headers)
        if deploy_resp.status_code != 200:
            raise HTTPException(status_code=deploy_resp.status_code, detail=f"ARM deployments error: {deploy_resp.text[:500]}")

        raw_deployments = deploy_resp.json().get("value", [])

    deployments = []
    for d in raw_deployments:
        props = d.get("properties", {})
        model_obj = props.get("model", {})
        model_name = model_obj.get("name", "") if isinstance(model_obj, dict) else str(model_obj)
        model_version = model_obj.get("version", "") if isinstance(model_obj, dict) else ""
        deployments.append({
            "id": d.get("name", ""),
            "deployment_name": d.get("name", ""),
            "model": model_name,
            "model_version": model_version,
            "status": props.get("provisioningState", ""),
        })

    return {"endpoint": raw_endpoint, "account": account_name, "deployments": deployments}


@app.post("/api/agents")
async def save_agent(agent: AgentConfig) -> dict[str, object]:
    state = repo.upsert_agent(agent)
    return {"message": f"Saved agent '{agent.name}'.", "state": state.model_dump(mode="json")}


@app.delete("/api/agents/{agent_id}")
async def delete_agent(agent_id: str) -> dict[str, object]:
    state = repo.delete_agent(agent_id)
    return {"message": "Agent deleted.", "state": state.model_dump(mode="json")}


@app.post("/api/agents/test")
async def test_agent(payload: AgentTestRequest) -> dict[str, object]:
    state = repo.upsert_agent(payload.agent)
    result = await run_agent(payload.agent, payload.prompt)
    return {
        "message": f"Executed agent '{payload.agent.name}' in {result['mode']} mode.",
        "result": result,
        "state": state.model_dump(mode="json"),
    }


@app.post("/api/agents/stream")
async def stream_agent_endpoint(payload: AgentTestRequest) -> StreamingResponse:
    """SSE streaming endpoint for agent execution."""
    repo.upsert_agent(payload.agent)
    return StreamingResponse(
        stream_agent(payload.agent, payload.prompt),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/workflows")
async def save_workflow(workflow: WorkflowDefinition) -> dict[str, object]:
    state = repo.upsert_workflow(workflow)
    return {
        "message": f"Saved workflow '{workflow.name}'.",
        "generated_code": generate_workflow_code(workflow, {agent.id: agent for agent in state.agents}),
        "state": state.model_dump(mode="json"),
    }


@app.get("/api/workflows/{workflow_id}/python")
async def preview_workflow_code(workflow_id: str) -> dict[str, str]:
    workflow = repo.get_workflow(workflow_id)
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    state = repo.load_state()
    return {"code": generate_workflow_code(workflow, {agent.id: agent for agent in state.agents})}


@app.post("/api/workflows/test")
async def test_workflow(payload: WorkflowTestRequest) -> dict[str, object]:
    state = repo.upsert_workflow(payload.workflow)
    agents_by_id = {agent.id: agent for agent in state.agents}
    result = await run_workflow(payload.workflow, agents_by_id, payload.prompt)
    return {
        "message": f"Executed workflow '{payload.workflow.name}'.",
        "result": result,
        "state": state.model_dump(mode="json"),
    }


@app.post("/api/skills/upload")
async def upload_skill(
    skill_name: str = Form(...),
    source_type: str = Form("files"),
    relative_paths_json: str = Form("[]"),
    files: list[UploadFile] = File(...),
) -> dict[str, object]:
    try:
        relative_paths = json.loads(relative_paths_json or "[]")
        record = await save_uploaded_skill(skill_name, files, relative_paths, source_type=source_type)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    state = repo.load_state()
    state.skills = discover_skills()
    repo.save_state(state)
    return {
        "message": f"Imported skill '{record.name}'.",
        "skill": record.model_dump(mode="json"),
        "state": repo.load_state().model_dump(mode="json"),
    }


@app.post("/api/skills/{skill_id}/run")
async def run_skill(skill_id: str, payload: SkillRunRequest) -> dict[str, object]:
    try:
        result = run_local_skill_script(skill_id, payload.script_name, payload.args)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "message": f"Executed script '{payload.script_name}' from skill '{skill_id}'.",
        "result": {
            "skill": result["skill"].model_dump(mode="json"),
            "script": result["script"].model_dump(mode="json"),
            "output": result["output"],
            "json": result["json"],
        },
    }


@app.get("/api/skills/{skill_id}/content")
async def get_skill_content(skill_id: str) -> dict[str, object]:
    """Return SKILL.md content and metadata for a skill."""
    from app.services.skill_runner import safe_slug, scan_skill_dir
    from app.core.config import SKILLS_DIR
    skill_dir = SKILLS_DIR / safe_slug(skill_id)
    record = scan_skill_dir(skill_dir)
    if not record:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found.")
    skill_md = skill_dir / "SKILL.md"
    content = skill_md.read_text(encoding="utf-8") if skill_md.exists() else ""
    return {"skill": record.model_dump(mode="json"), "content": content}


@app.put("/api/skills/{skill_id}/content")
async def update_skill_content(skill_id: str, payload: dict) -> dict[str, object]:
    """Overwrite SKILL.md content for a skill."""
    from app.services.skill_runner import safe_slug
    from app.core.config import SKILLS_DIR
    skill_dir = SKILLS_DIR / safe_slug(skill_id)
    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found.")
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text(payload.get("content", ""), encoding="utf-8")
    state = repo.load_state()
    state.skills = discover_skills()
    repo.save_state(state)
    return {"message": "Skill updated.", "state": state.model_dump(mode="json")}


@app.delete("/api/skills/{skill_id}")
async def delete_skill(skill_id: str) -> dict[str, object]:
    """Delete a skill folder from the skills directory."""
    import shutil
    from app.services.skill_runner import safe_slug
    from app.core.config import SKILLS_DIR
    skill_dir = SKILLS_DIR / safe_slug(skill_id)
    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found.")
    shutil.rmtree(skill_dir)
    state = repo.load_state()
    state.skills = discover_skills()
    repo.save_state(state)
    return {"message": f"Skill '{skill_id}' deleted.", "state": state.model_dump(mode="json")}


@app.get("/api/skills/{skill_id}/files")
async def list_skill_files(skill_id: str) -> dict[str, object]:
    """List all files inside a skill directory."""
    from app.services.skill_runner import safe_slug
    from app.core.config import SKILLS_DIR
    skill_dir = SKILLS_DIR / safe_slug(skill_id)
    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found.")
    files = []
    for f in sorted(skill_dir.rglob("*")):
        if f.is_file():
            files.append({"path": f.relative_to(skill_dir).as_posix(), "size": f.stat().st_size})
    return {"files": files}


@app.get("/api/skills/{skill_id}/files/{file_path:path}")
async def get_skill_file(skill_id: str, file_path: str) -> dict[str, object]:
    """Return the content of a specific file within a skill directory."""
    from app.services.skill_runner import safe_slug
    from app.core.config import SKILLS_DIR
    skill_dir = SKILLS_DIR / safe_slug(skill_id)
    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found.")
    target = (skill_dir / file_path).resolve()
    try:
        target.relative_to(skill_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path.")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"File '{file_path}' not found.")
    content = target.read_text(encoding="utf-8", errors="replace")
    return {"path": file_path, "content": content}


@app.put("/api/skills/{skill_id}/files/{file_path:path}")
async def update_skill_file(skill_id: str, file_path: str, payload: dict) -> dict[str, object]:
    """Create or overwrite a specific file within a skill directory."""
    from app.services.skill_runner import safe_slug
    from app.core.config import SKILLS_DIR
    skill_dir = SKILLS_DIR / safe_slug(skill_id)
    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found.")
    target = (skill_dir / file_path).resolve()
    try:
        target.relative_to(skill_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(payload.get("content", ""), encoding="utf-8")
    if file_path == "SKILL.md":
        state = repo.load_state()
        state.skills = discover_skills()
        repo.save_state(state)
        return {"message": "File updated.", "state": state.model_dump(mode="json")}
    return {"message": "File updated."}


@app.delete("/api/skills/{skill_id}/files/{file_path:path}")
async def delete_skill_file(skill_id: str, file_path: str) -> dict[str, object]:
    """Delete a specific file within a skill directory (cannot delete SKILL.md)."""
    from app.services.skill_runner import safe_slug
    from app.core.config import SKILLS_DIR
    skill_dir = SKILLS_DIR / safe_slug(skill_id)
    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found.")
    if file_path == "SKILL.md":
        raise HTTPException(status_code=400, detail="SKILL.md は削除できません。スキル全体を削除してください。")
    target = (skill_dir / file_path).resolve()
    try:
        target.relative_to(skill_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path.")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"File '{file_path}' not found.")
    target.unlink()
    # Remove empty parent directories up to (but not including) skill_dir
    parent = target.parent
    while parent != skill_dir.resolve() and parent.is_dir() and not any(parent.iterdir()):
        parent.rmdir()
        parent = parent.parent
    return {"message": f"File '{file_path}' deleted."}


# ── Handoff Orchestration endpoints ─────────────────────────


@app.post("/api/handoffs")
async def save_handoff(handoff: HandoffDefinition) -> dict[str, object]:
    state = repo.upsert_handoff(handoff)
    return {"message": f"Saved handoff '{handoff.name}'.", "state": state.model_dump(mode="json")}


@app.delete("/api/handoffs/{handoff_id}")
async def delete_handoff(handoff_id: str) -> dict[str, object]:
    state = repo.delete_handoff(handoff_id)
    return {"message": "Handoff deleted.", "state": state.model_dump(mode="json")}


@app.post("/api/handoffs/chat/stream")
async def handoff_chat_stream(payload: HandoffChatRequest) -> StreamingResponse:
    """SSE streaming endpoint for a single handoff chat turn."""
    handoff = repo.get_handoff(payload.handoff_id)
    if not handoff:
        raise HTTPException(status_code=404, detail="Handoff not found")

    state = repo.load_state()
    agents_by_id = {a.id: a for a in state.agents}

    session = get_or_create_session(
        handoff_id=handoff.id,
        session_id=payload.session_id,
        start_agent_id=handoff.start_agent_id,
    )

    async def generate():
        async for chunk in stream_handoff_turn(handoff, agents_by_id, session, payload.message):
            yield chunk

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/handoffs/sessions/{session_id}")
async def delete_handoff_session(session_id: str) -> dict[str, str]:
    clear_session(session_id)
    return {"message": "Session cleared."}


@app.get("/api/customers/{customer_id}")
async def get_customer(customer_id: str) -> dict[str, object]:
    """Return full customer profile (customer info + contracts + activities)."""
    profile = get_customer_profile(customer_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Customer '{customer_id}' not found")
    return profile


@app.post("/api/demo/reset")
async def demo_reset() -> dict[str, str]:
    """Reset demo CSV data (contracts, activities) to initial snapshots."""
    import shutil
    data_dir = BASE_DIR / "demo_app" / "data"
    initial_dir = data_dir / "_initial"
    for name in ("contracts.csv", "activities.csv"):
        src = initial_dir / name
        dst = data_dir / name
        if src.exists():
            shutil.copy2(src, dst)
    return {"status": "ok"}


@app.get("/api/agents/{agent_id}/skill-preview")
async def agent_skill_preview(agent_id: str) -> dict[str, object]:
    """Return the agent's base instructions plus simulated SkillsProvider advertise block.

    Used by the Skill Visualization tab to show how skills augment the system prompt.
    """
    from app.services.skill_runner import scan_skill_dir, safe_slug
    from app.core.config import SKILLS_DIR

    state = repo.load_state()
    agent = next((a for a in state.agents if a.id == agent_id), None)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    skills_data: list[dict[str, object]] = []
    for skill_id in (agent.skill_ids or []):
        skill_dir = SKILLS_DIR / safe_slug(skill_id)
        record = scan_skill_dir(skill_dir)
        if record:
            skill_md_path = skill_dir / "SKILL.md"
            content = skill_md_path.read_text(encoding="utf-8") if skill_md_path.exists() else ""
            skills_data.append({
                "id": record.id,
                "name": record.name,
                "description": record.description or "",
                "content": content,
                "scripts": [{"name": s.name, "path": s.path} for s in record.scripts],
                "resources": record.resources,
            })

    # Build a simulated SkillsProvider advertise block
    advertise_block = ""
    if skills_data:
        skill_lines = "\n".join(
            f'  <skill name="{s["name"]}">\n    <description>{s["description"]}</description>\n'
            + (
                "    <scripts>" + ", ".join(sc["name"] for sc in s["scripts"]) + "</scripts>\n"
                if s["scripts"] else ""
            )
            + "  </skill>"
            for s in skills_data
        )
        advertise_block = (
            "あなたはドメイン固有の知識と機能を持つスキルにアクセスできます。\n"
            "各スキルは特定のタスクに対応した専門的な手順、参考ドキュメント、およびアセットを提供します。\n\n"
            "<available_skills>\n"
            f"{skill_lines}\n"
            "</available_skills>\n\n"
            "タスクがスキルのドメインと一致する場合、以下の手順を正確な順番で実行してください:\n"
            "- `load_skill` を使用してスキルの手順を取得してください。\n"
            "- 提供されたガイダンスに従ってください。\n"
            "- `read_skill_resource` を使用して参照されているリソースを読み込んでください。\n"
            "- `run_skill_script` を使用して参照されているスクリプトを実行してください。\n"
            "必要なものだけを、必要なときに読み込んでください。"
        )

    return {
        "agent_id": agent_id,
        "agent_name": agent.name,
        "base_instructions": agent.instructions or "",
        "advertise_block": advertise_block,
        "skills": skills_data,
    }
