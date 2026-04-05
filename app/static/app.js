/* =================================================================
   MAF Workflow Studio — SPA Router + Page Logic
   ================================================================= */

const studio = {
  state: { agents: [], skills: [], workflows: [], handoffs: [] },
  currentWorkflow: null,
  selectedAgentId: null,
  chatMessages: [],
  traceEvents: [],
  // Handoffs
  currentHandoffId: null,
  handoffSessionId: null,
  handoffCurrentAgentId: null,
  handoffFlashEdgeKey: null,   // { from, to } — active only during transition flash
  handoffChatMessages: [],
  hoParticipantIds: [],
  hoRules: [],
  hoNodePositions: {},
  hoZoom: 1.0,
  hoPanX: 0,
  hoPanY: 0,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ── Logging ─────────────────────────────────────────────── */
function log(message, data) {
  const el = $("#activity-console");
  const ts = new Date().toLocaleTimeString();
  const detail = data ? `\n${JSON.stringify(data, null, 2)}` : "";
  el.textContent = `[${ts}] ${message}${detail}\n\n${el.textContent}`.slice(0, 50000);
}

/* ── API helper ──────────────────────────────────────────── */
async function api(url, options = {}) {
  const cfg = { ...options };
  cfg.headers = cfg.headers || {};
  if (cfg.body && !(cfg.body instanceof FormData) && !cfg.headers["Content-Type"]) {
    cfg.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, cfg);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.detail || json.message || `HTTP ${res.status}`);
  return json;
}

/* ── ID ──────────────────────────────────────────────────── */
function createId(prefix) {
  return `${prefix}-${(crypto.randomUUID?.() || String(Date.now())).slice(0, 8)}`;
}

function createBlankWorkflow() {
  return {
    id: createId("wf"), name: "New Workflow",
    description: "Compose multiple Agent Framework agents into a deterministic workflow.",
    input_text: "Review the proposal and produce a final recommendation.",
    start_node_id: null, nodes: [], edges: [],
  };
}

/* ==============================================================
   ROUTER
   ============================================================== */
const PAGE_META = {
  agents:    { title: "Agents",    subtitle: "Create and test Agent Framework agents with model, instructions, MCP tools, and file-based skills." },
  skills:    { title: "Skills",    subtitle: "Manage file-based skills — upload folders or files, and run Python scripts via local subprocess." },
  workflows: { title: "Workflows", subtitle: "Build deterministic workflows with multiple agents and diverse edge types." },
  handoffs:  { title: "Handoffs",  subtitle: "Build HandoffBuilder orchestrations — select participants, define routing rules, visualize the mesh, and test interactively." },
  skillviz:  { title: "Skill Visualization", subtitle: "Dashboard: watch Agent Skills advertise, load, and execute in real time — alongside the live handoff orchestration graph." },
  console:   { title: "Console",   subtitle: "Activity log, runtime tips, and status information." },
};

function navigate(page) {
  if (!PAGE_META[page]) page = "agents";
  // Nav highlight
  $$(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.page === page));
  // Page visibility
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  // Header
  const meta = PAGE_META[page];
  $("#page-title").textContent = meta.title;
  $("#page-subtitle").textContent = meta.subtitle;
}

function initRouter() {
  $$(".nav-item[data-page]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const page = a.dataset.page;
      window.location.hash = page;
      navigate(page);
    });
  });
  const initial = window.location.hash.replace("#", "") || "agents";
  navigate(initial);
  window.addEventListener("hashchange", () => navigate(window.location.hash.replace("#", "") || "agents"));
}

/* ==============================================================
   MCP ROW BUILDER
   ============================================================== */
function buildMcpRow(tool = {}) {
  const row = document.createElement("div");
  row.className = "mcp-row";
  row.innerHTML = `
    <div class="field-row two-col">
      <div class="field"><label>Name</label><input class="mcp-name" type="text" value="${tool.name || ""}" placeholder="GitHub MCP" /></div>
      <div class="field"><label>Approval</label>
        <select class="mcp-approval">
          <option value="never_require" ${tool.approval_mode === "never_require" ? "selected" : ""}>never_require</option>
          <option value="always_require" ${tool.approval_mode === "always_require" ? "selected" : ""}>always_require</option>
        </select>
      </div>
    </div>
    <div class="field"><label>URL</label><input class="mcp-url" type="text" value="${tool.url || ""}" placeholder="https://learn.microsoft.com/api/mcp" /></div>
    <div class="field"><label>Description</label><input class="mcp-description" type="text" value="${tool.description || ""}" placeholder="Optional description" /></div>
  `;
  return row;
}

/* ==============================================================
   POPULATE UI
   ============================================================== */
function populateAgentList() {
  const sel = $("#agent-select");
  if (!sel) return;
  const currentId = studio.selectedAgentId;
  sel.innerHTML = '<option value="">— Select Agent —</option>' +
    studio.state.agents.map((a) =>
      `<option value="${esc(a.id)}"${a.id === currentId ? " selected" : ""}>${esc(a.name)}</option>`
    ).join("");
}

function populateSkillList() {
  // Refresh agent filter options
  const agentSel = $("#skill-agent-filter");
  if (agentSel) {
    const currentVal = agentSel.value;
    agentSel.innerHTML = '<option value="">すべてのエージェント</option>' +
      studio.state.agents
        .filter(a => a.skill_ids && a.skill_ids.length > 0)
        .map(a => `<option value="${esc(a.id)}"${a.id === currentVal ? ' selected' : ''}>${esc(a.name)}</option>`)
        .join("");
  }

  const query = (($("#skill-search")?.value) || "").trim().toLowerCase();
  const agentId = agentSel?.value || "";

  // Show/hide clear button
  const clearBtn = $("#skill-search-clear");
  if (clearBtn) clearBtn.style.display = query ? "" : "none";

  // Determine visible skill IDs for agent filter
  let agentSkillIds = null;
  if (agentId) {
    const agent = studio.state.agents.find(a => a.id === agentId);
    agentSkillIds = agent?.skill_ids || [];
  }

  const c = $("#skill-list");
  c.innerHTML = "";
  const empty = $("#skills-empty");

  let skills = studio.state.skills;
  if (agentSkillIds !== null) {
    skills = skills.filter(s => agentSkillIds.includes(s.id));
  }
  if (query) {
    skills = skills.filter(s =>
      s.name.toLowerCase().includes(query) ||
      (s.description || "").toLowerCase().includes(query) ||
      s.id.toLowerCase().includes(query)
    );
  }

  // Update count badge
  const badge = $("#skill-count-badge");
  if (badge) {
    const total = studio.state.skills.length;
    badge.textContent = skills.length < total ? `${skills.length} / ${total}` : `${total}`;
    badge.style.display = total > 0 ? "" : "none";
  }

  if (!skills.length) { empty.style.display = ""; return; }
  empty.style.display = "none";

  skills.forEach((s) => {
    const isAgentSkill = agentSkillIds !== null && agentSkillIds.includes(s.id);
    const card = document.createElement("div");
    card.className = "skill-card" + (isAgentSkill ? " skill-card--agent" : "");
    card.innerHTML = `<strong>${esc(s.name)}</strong><div class="meta">${esc(s.description || "No description")}</div><span class="skill-chip">scripts: ${s.scripts.length}</span>`;
    card.addEventListener("click", () => openSkillModal(s.id));
    c.appendChild(card);
  });
}

function clearSkillSearch() {
  const el = $("#skill-search");
  if (el) { el.value = ""; el.focus(); }
  populateSkillList();
}

/* ── Skill Modal ─────────────────────────────────────────── */
let _skillModalId = null;
let _skillModalFiles = [];
let _skillModalCurrentFile = null;

async function openSkillModal(skillId) {
  _skillModalId = skillId;
  _skillModalFiles = [];
  _skillModalCurrentFile = null;
  const overlay = $("#skill-modal-overlay");
  $("#skill-modal-title").textContent = skillId;
  $("#skill-modal-file-list").innerHTML = "<div style='padding:10px 12px;font-size:0.78rem;color:var(--text-secondary)'>読み込み中...</div>";
  $("#skill-modal-content").textContent = "";
  $("#skill-modal-view").style.display = "";
  $("#skill-modal-edit").style.display = "none";
  overlay.classList.add("open");

  try {
    // Load file list and skill metadata in parallel
    const [filesRes, metaRes] = await Promise.all([
      fetch(`/api/skills/${encodeURIComponent(skillId)}/files`),
      fetch(`/api/skills/${encodeURIComponent(skillId)}/content`),
    ]);
    if (!filesRes.ok) throw new Error(await filesRes.text());
    const filesData = await filesRes.json();
    _skillModalFiles = filesData.files;
    if (metaRes.ok) {
      const metaData = await metaRes.json();
      $("#skill-modal-title").textContent = metaData.skill.name;
    }
    renderSkillFileList();
    // Auto-select SKILL.md first
    const defaultFile = _skillModalFiles.find(f => f.path === "SKILL.md") || _skillModalFiles[0];
    if (defaultFile) await selectSkillFile(defaultFile.path);
  } catch (e) {
    $("#skill-modal-file-list").textContent = "";
    $("#skill-modal-content").textContent = `Error: ${e.message}`;
  }
}

function renderSkillFileList() {
  const container = $("#skill-modal-file-list");
  container.innerHTML = "";
  // Group by top-level directory
  const groups = {};
  _skillModalFiles.forEach(f => {
    const slash = f.path.indexOf("/");
    const dir = slash === -1 ? "" : f.path.slice(0, slash);
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(f);
  });
  const dirs = Object.keys(groups).sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });
  const extIcon = { md: "📄", py: "🐍", txt: "📝", json: "{}", sh: "⚙", csv: "📊" };
  dirs.forEach(dir => {
    if (dir !== "") {
      const lbl = document.createElement("div");
      lbl.className = "skill-modal-file-group";
      lbl.textContent = dir + "/";
      container.appendChild(lbl);
    }
    groups[dir].forEach(f => {
      const item = document.createElement("div");
      item.className = "skill-modal-file-item" + (f.path === _skillModalCurrentFile ? " active" : "");
      item.dataset.path = f.path;
      const name = f.path.includes("/") ? f.path.split("/").pop() : f.path;
      const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
      const icon = extIcon[ext] || "📄";
      item.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${esc(name)}</span>`;
      item.addEventListener("click", () => selectSkillFile(f.path));
      container.appendChild(item);
    });
  });
}

async function selectSkillFile(filePath) {
  _skillModalCurrentFile = filePath;
  // Update sidebar active state
  document.querySelectorAll(".skill-modal-file-item").forEach(el => {
    el.classList.toggle("active", el.dataset.path === filePath);
  });
  // Cancel any pending edit
  cancelEditSkillFile();
  // Update file bar
  $("#skill-modal-file-path").textContent = filePath;
  // Show/hide delete-file button (SKILL.md cannot be deleted)
  const delBtn = $("#skill-modal-file-delete-btn");
  if (delBtn) delBtn.style.display = filePath === "SKILL.md" ? "none" : "";
  $("#skill-modal-content").textContent = "読み込み中...";
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(_skillModalId)}/files/${filePath}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    $("#skill-modal-content").textContent = data.content || "(empty)";
  } catch (e) {
    $("#skill-modal-content").textContent = `Error: ${e.message}`;
  }
}

function closeSkillModal(e) {
  if (e && e.target !== e.currentTarget) return;
  $("#skill-modal-overlay").classList.remove("open");
  _skillModalId = null;
  _skillModalCurrentFile = null;
}

function startEditSkillFile() {
  const content = $("#skill-modal-content").textContent;
  $("#skill-modal-textarea").value = content === "(empty)" ? "" : content;
  $("#skill-modal-edit-path").textContent = _skillModalCurrentFile || "";
  $("#skill-modal-view").style.display = "none";
  $("#skill-modal-edit").style.display = "";
  $("#skill-modal-textarea").focus();
}

function cancelEditSkillFile() {
  $("#skill-modal-view").style.display = "";
  $("#skill-modal-edit").style.display = "none";
}

async function saveEditSkillFile() {
  if (!_skillModalId || !_skillModalCurrentFile) return;
  const content = $("#skill-modal-textarea").value;
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(_skillModalId)}/files/${_skillModalCurrentFile}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (data.state) {
      studio.state = data.state;
      populateSkillList();
      populateAgentSkillSection(studio.currentAgent?.skill_ids || []);
    }
    $("#skill-modal-content").textContent = content || "(empty)";
    cancelEditSkillFile();
  } catch (e) {
    alert(`保存失敗: ${e.message}`);
  }
}

async function confirmDeleteSkillFile() {
  if (!_skillModalId || !_skillModalCurrentFile) return;
  if (!confirm(`ファイル「${_skillModalCurrentFile}」を削除しますか？`)) return;
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(_skillModalId)}/files/${_skillModalCurrentFile}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(await res.text());
    _skillModalFiles = _skillModalFiles.filter(f => f.path !== _skillModalCurrentFile);
    _skillModalCurrentFile = null;
    renderSkillFileList();
    $("#skill-modal-file-path").textContent = "";
    $("#skill-modal-content").textContent = "";
    if (_skillModalFiles.length > 0) await selectSkillFile(_skillModalFiles[0].path);
  } catch (e) {
    alert(`削除失敗: ${e.message}`);
  }
}

async function confirmDeleteSkill() {
  if (!_skillModalId) return;
  if (!confirm(`スキル「${_skillModalId}」を削除しますか？この操作は元に戻せません。`)) return;
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(_skillModalId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    studio.state = data.state;
    populateSkillList();
    populateAgentSkillSection(studio.currentAgent?.skill_ids || []);
    closeSkillModal();
  } catch (e) {
    alert(`削除失敗: ${e.message}`);
  }
}

async function promptNewSkillFile() {
  if (!_skillModalId) return;
  const input = prompt(
    "新規ファイルのパスを入力してください\n(例: references/new-rules.md  /  scripts/helper.py)"
  );
  if (!input || !input.trim()) return;
  const filePath = input.trim().replace(/^\/+/, "");
  if (filePath.includes("..")) { alert("不正なパスです。"); return; }
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(_skillModalId)}/files/${filePath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    if (!res.ok) throw new Error(await res.text());
    if (!_skillModalFiles.find(f => f.path === filePath)) {
      _skillModalFiles.push({ path: filePath, size: 0 });
      _skillModalFiles.sort((a, b) => a.path.localeCompare(b.path));
    }
    renderSkillFileList();
    await selectSkillFile(filePath);
    startEditSkillFile();
  } catch (e) {
    alert(`ファイル作成失敗: ${e.message}`);
  }
}

function populateAgentSkillSection(selected = []) {
  // ── Added skill list ──
  const list = $("#agent-skill-list");
  list.innerHTML = "";
  const validSelected = selected.filter((id) => studio.state.skills.find((s) => s.id === id));
  if (validSelected.length) {
    validSelected.forEach((id) => {
      const skill = studio.state.skills.find((s) => s.id === id);
      const item = document.createElement("div");
      item.className = "agent-skill-item";
      item.dataset.skillId = esc(id);
      item.innerHTML = `
        <div class="agent-skill-item-info">
          <strong>${esc(skill.name)}</strong>
          <div class="agent-skill-item-meta">${esc(skill.description || "説明なし")}</div>
        </div>
        <div class="agent-skill-item-actions">
          <button class="agent-skill-remove-btn" title="削除" data-skill-id="${esc(id)}">✕</button>
        </div>`;
      list.appendChild(item);
    });
  } else {
    list.innerHTML = `<div class="agent-skill-empty">スキルが追加されていません</div>`;
  }

  // ── Custom picker: un-added skills only ──
  const unselected = studio.state.skills.filter((s) => !validSelected.includes(s.id));
  const opts = $("#skill-picker-options");
  const trigger = $("#skill-picker-trigger");
  opts.innerHTML = unselected.length
    ? unselected.map((s) => `
        <label class="skill-picker-option">
          <input type="checkbox" value="${esc(s.id)}" />
          <div class="skill-picker-option-info">
            <span class="skill-picker-option-name">${esc(s.name)}</span>
            <span class="skill-picker-option-meta">${esc(s.description || "説明なし")}</span>
          </div>
        </label>`).join("")
    : `<div class="skill-picker-empty">No skills available to add</div>`;
  trigger.disabled = !unselected.length;
  $("#agent-skill-add-btn").disabled = true; // reset until user checks something
  // update label + add button when checkboxes change
  opts.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", _updateSkillPickerState);
  });
  _updateSkillPickerState();
}

function _updateSkillPickerState() {
  const checked = Array.from($$("#skill-picker-options input:checked"));
  const label = $("#skill-picker-label");
  const addBtn = $("#agent-skill-add-btn");
  if (!label) return;
  if (checked.length === 0) {
    label.textContent = "Select skills...";
  } else {
    label.textContent = `${checked.length} selected`;
  }
  addBtn.disabled = checked.length === 0;
}

function populateScriptSelectors() {
  const sel = $("#script-skill-select");
  sel.innerHTML = studio.state.skills.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  updateScriptNames();
}

function updateScriptNames() {
  const skill = studio.state.skills.find((s) => s.id === $("#script-skill-select").value);
  const sel = $("#script-name-select");
  sel.innerHTML = (skill?.scripts || []).map((sc) => `<option value="${sc.name}">${esc(sc.name)} (${esc(sc.path)})</option>`).join("");
}

function populateNodeAgentSelect() {
  $("#node-agent-select").innerHTML = studio.state.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
}

function populateWorkflowSelects() {
  const opts = studio.currentWorkflow.nodes.map((n) => `<option value="${n.id}">${esc(n.title)}</option>`).join("");
  ["#workflow-start", "#edge-source", "#edge-target"].forEach((sel) => {
    const el = $(sel);
    el.innerHTML = opts;
    if (sel === "#workflow-start" && studio.currentWorkflow.start_node_id) el.value = studio.currentWorkflow.start_node_id;
  });
}

function populateTips(tips) {
  const c = $("#tips");
  c.innerHTML = "";
  tips.forEach((t) => {
    const d = document.createElement("div");
    d.className = "tip-card";
    d.textContent = t;
    c.appendChild(d);
  });
}

/* ── Escape HTML ─────────────────────────────────────────── */
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

/* ==============================================================
   AGENT FORM
   ============================================================== */
function loadAgent(agent) {
  studio.selectedAgentId = agent.id;
  $("#agent-name").value = agent.name || "";
  $("#agent-description").value = agent.description || "";
  $("#provider").value = agent.model.provider || "mock";
  // Set model select – add option if not present
  const modelSel = $("#model-name");
  const modelVal = agent.model.model || "gpt-4.1-mini";
  if (!Array.from(modelSel.options).some((o) => o.value === modelVal)) {
    const opt = document.createElement("option");
    opt.value = modelVal;
    opt.textContent = modelVal + " (manual)";
    const customOpt = modelSel.querySelector('[value="__custom__"]');
    if (customOpt) modelSel.insertBefore(opt, customOpt);
    else modelSel.appendChild(opt);
  }
  modelSel.value = modelVal;
  $("#api-key-env").value = agent.model.api_key_env || "OPENAI_API_KEY";
  $("#base-url").value = agent.model.base_url || "";
  $("#api-version").value = agent.model.api_version || "";
  $("#instructions").value = agent.instructions || "";

  const mc = $("#mcp-container");
  mc.innerHTML = "";
  (agent.mcp_tools || []).forEach((t) => mc.appendChild(buildMcpRow(t)));
  if (!mc.children.length) mc.appendChild(buildMcpRow());

  populateAgentSkillSection(agent.skill_ids || []);
  populateAgentList();
  updateAgentHeader(agent);
  updateToolsList(agent);

  // Update chat panel agent info
  $("#chat-agent-name").textContent = agent.name || "Agent";
  $("#chat-agent-desc").textContent = agent.description || agent.instructions?.slice(0, 120) || "A helpful Microsoft Agent Framework assistant.";

  setStatus("#agent-status", `Loaded ${agent.name}`);
}

/* ── Update agent header bar ─────────────────────────────── */
function updateAgentHeader(agent) {
  if (!agent) agent = collectAgentForm();
  const toolCount = (agent.mcp_tools || []).filter((t) => t.url?.trim()).length + (agent.skill_ids || []).length;
  $("#agent-header-name").textContent = agent.name || "New Agent";
  $("#agent-header-tools").textContent = `${toolCount} tool${toolCount !== 1 ? "s" : ""}`;
}

function collectAgentForm() {
  const skillIds = Array.from($$("#agent-skill-list .agent-skill-item")).map((el) => el.dataset.skillId);
  const mcpTools = Array.from($$("#mcp-container .mcp-row"))
    .map((r) => ({
      id: createId("mcp"),
      name: r.querySelector(".mcp-name").value.trim(),
      url: r.querySelector(".mcp-url").value.trim(),
      description: r.querySelector(".mcp-description").value.trim(),
      approval_mode: r.querySelector(".mcp-approval").value,
      allowed_tools: [], headers: {},
    }))
    .filter((t) => t.name || t.url);

  return {
    id: studio.selectedAgentId || createId("agent"),
    name: $("#agent-name").value.trim() || "New Agent",
    description: $("#agent-description").value.trim(),
    instructions: $("#instructions").value.trim(),
    default_prompt: "",
    skill_ids: skillIds,
    mcp_tools: mcpTools,
    model: {
      provider: $("#provider").value,
      model: $("#model-name").value.trim(),
      api_key_env: $("#api-key-env").value.trim() || "OPENAI_API_KEY",
      base_url: $("#base-url").value.trim() || null,
      api_version: $("#api-version").value.trim() || null,
      azure_endpoint_env: "AZURE_OPENAI_ENDPOINT",
      project_endpoint_env: "AZURE_AI_PROJECT_ENDPOINT",
      temperature: 0.2,
    },
  };
}

/* ==============================================================
   WORKFLOW CANVAS
   ============================================================== */
function loadWorkflow(wf) {
  studio.currentWorkflow = JSON.parse(JSON.stringify(wf));
  $("#workflow-name").value = wf.name || "New Workflow";
  $("#workflow-description").value = wf.description || "";
  $("#workflow-prompt").value = wf.input_text || "";
  populateWorkflowSelects();
  renderWorkflowCanvas();
}

const EDGE_COLORS = {
  direct: "#5ea2ff",
  conditional: "#fbbf24",
  "switch-case": "#a78bfa",
  "multi-selection": "#34d399",
  "fan-in": "#fb7185",
};

function renderWorkflowCanvas() {
  const canvas = $("#workflow-canvas");
  const svg = $("#edge-layer");
  canvas.innerHTML = "";
  svg.innerHTML = `<defs>
    <marker id="arrow-direct" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#5ea2ff"/></marker>
    <marker id="arrow-conditional" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#fbbf24"/></marker>
    <marker id="arrow-switch-case" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#a78bfa"/></marker>
    <marker id="arrow-multi-selection" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#34d399"/></marker>
    <marker id="arrow-fan-in" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#fb7185"/></marker>
  </defs>`;

  const nodeMap = new Map(studio.currentWorkflow.nodes.map((n) => [n.id, n]));

  studio.currentWorkflow.nodes.forEach((node) => {
    const agent = studio.state.agents.find((a) => a.id === node.agent_id);
    const isStart = node.id === studio.currentWorkflow.start_node_id;
    const el = document.createElement("div");
    el.className = "wf-node";
    el.style.left = `${node.position.x}px`;
    el.style.top = `${node.position.y}px`;
    el.innerHTML = `<strong>${esc(node.title)}</strong><div class="node-meta">${esc(agent?.name || "Unassigned")}</div>${isStart ? '<span class="node-badge">START</span>' : ""}`;

    let ox = 0, oy = 0, dragging = false;
    el.addEventListener("pointerdown", (e) => {
      dragging = true;
      const r = canvas.getBoundingClientRect();
      ox = e.clientX - r.left - node.position.x;
      oy = e.clientY - r.top - node.position.y;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      node.position.x = Math.max(0, e.clientX - r.left - ox);
      node.position.y = Math.max(0, e.clientY - r.top - oy);
      el.style.left = `${node.position.x}px`;
      el.style.top = `${node.position.y}px`;
      drawEdges(svg, nodeMap);
    });
    el.addEventListener("pointerup", () => { dragging = false; });

    canvas.appendChild(el);
  });

  drawEdges(svg, nodeMap);
  populateWorkflowSelects();
}

function drawEdges(svg, nodeMap) {
  // preserve <defs>
  const defs = svg.querySelector("defs");
  while (svg.children.length > 1) svg.removeChild(svg.lastChild);

  studio.currentWorkflow.edges.forEach((edge) => {
    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    if (!src || !tgt) return;

    const x1 = src.position.x + 190, y1 = src.position.y + 36;
    const x2 = tgt.position.x, y2 = tgt.position.y + 36;
    const color = EDGE_COLORS[edge.edge_type] || "#5ea2ff";

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const cx1 = x1 + 50, cy1 = y1, cx2 = x2 - 50, cy2 = y2;
    line.setAttribute("d", `M${x1},${y1} C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}`);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "2");
    line.setAttribute("marker-end", `url(#arrow-${edge.edge_type})`);
    svg.appendChild(line);

    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 10;
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", mx);
    text.setAttribute("y", my);
    text.setAttribute("fill", color);
    text.setAttribute("font-size", "11");
    text.setAttribute("font-family", "DM Sans, sans-serif");
    text.setAttribute("text-anchor", "middle");
    text.textContent = `${edge.edge_type}${edge.label ? ` · ${edge.label}` : ""}`;
    svg.appendChild(text);
  });
}

/* ==============================================================
   TOAST NOTIFICATION
   ============================================================== */
let _toastTimer = null;
function showToast(message, type = "success") {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.className = `toast toast--${type} toast--show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove("toast--show"); }, 2800);
}

/* ==============================================================
   HANDOFF DIRTY STATE
   ============================================================== */
function markHandoffDirty() {
  const badge = $("#handoff-dirty-badge");
  if (badge) badge.style.display = "";
}
function clearHandoffDirty() {
  const badge = $("#handoff-dirty-badge");
  if (badge) badge.style.display = "none";
}

/* ==============================================================
   STATE MANAGEMENT
   ============================================================== */
function populateState(state) {
  studio.state = state;
  populateAgentList();
  populateSkillList();
  populateScriptSelectors();
  populateNodeAgentSelect();

  if (!studio.selectedAgentId && state.agents[0]) {
    loadAgent(state.agents[0]);
  } else if (studio.selectedAgentId) {
    const a = state.agents.find((x) => x.id === studio.selectedAgentId);
    if (a) loadAgent(a);
  }

  if (!studio.currentWorkflow) {
    loadWorkflow(state.workflows[0] || createBlankWorkflow());
  }

  // Handoffs
  populateHandoffList();
  if (!studio.currentHandoffId && state.handoffs?.length) {
    loadHandoff(state.handoffs[0]);
  } else if (!studio.currentHandoffId) {
    newHandoff();
  }

  // Skill Viz — keep selector in sync
  populateSvHandoffSelect();
}

async function refreshState() {
  const payload = await api("/api/state");
  populateState(payload.state);
  populateTips(payload.tips || []);
  log("State refreshed.", { agents: payload.state.agents.length, skills: payload.state.skills.length, workflows: payload.state.workflows.length });
}

/* ==============================================================
   STATUS HELPERS
   ============================================================== */
function setStatus(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
}

/* ==============================================================
   ACTIONS
   ============================================================== */
async function saveAgent() {
  try {
    const agent = collectAgentForm();
    const p = await api("/api/agents", { method: "POST", body: JSON.stringify(agent) });
    studio.selectedAgentId = agent.id;
    populateState(p.state);
    setStatus("#agent-status", p.message);
    log(p.message, agent);
  } catch (e) {
    setStatus("#agent-status", e.message);
    log("Failed to save agent", { error: e.message });
  }
}

async function deleteAgent() {
  if (!studio.selectedAgentId) return;
  const agent = studio.state.agents.find((a) => a.id === studio.selectedAgentId);
  const name = agent?.name || studio.selectedAgentId;
  if (!confirm(`Delete agent "${name}"?`)) return;
  try {
    const p = await api(`/api/agents/${encodeURIComponent(studio.selectedAgentId)}`, { method: "DELETE" });
    studio.selectedAgentId = null;
    populateState(p.state);
    // Load first agent or reset form
    if (p.state.agents.length) {
      loadAgent(p.state.agents[0]);
    } else {
      newAgent();
    }
    setStatus("#agent-status", p.message);
    log(p.message);
  } catch (e) {
    setStatus("#agent-status", e.message);
    log("Failed to delete agent", { error: e.message });
  }
}

async function testAgent() {
  const prompt = $("#chat-input").value.trim();
  if (!prompt) return;
  try {
    // Add user message
    addChatMessage("user", prompt);
    $("#chat-input").value = "";
    setStatus("#agent-status", "Running...");

    const agent = collectAgentForm();

    // Create a placeholder assistant message for streaming
    const msgIndex = studio.chatMessages.length;
    addChatMessage("assistant", "");
    const msgEl = $("#chat-messages").lastElementChild;
    const textEl = msgEl?.querySelector(".chat-msg-text");

    // Use SSE streaming via fetch
    const body = JSON.stringify({ agent, prompt });
    const res = await fetch("/api/agents/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE messages from the buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete line

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          eventData = line.slice(6);
          // Process complete SSE message
          if (eventType && eventData) {
            try {
              const data = JSON.parse(eventData);
              handleSSEMessage(eventType, data, textEl, msgIndex);
              if (eventType === "delta") {
                fullText += data.text || "";
              } else if (eventType === "done") {
                // Use full text from done event if we didn't get streaming deltas
                if (!fullText && data.text) {
                  fullText = data.text;
                  if (textEl) textEl.innerHTML = renderMarkdown(fullText);
                }
                studio.chatMessages[msgIndex].text = fullText || data.text || "";
                setStatus("#agent-status", `${data.mode} mode`);
              }
            } catch (e) { /* skip malformed */ }
          }
          eventType = "";
          eventData = "";
        } else if (line === "") {
          // empty line separates events — reset
          eventType = "";
          eventData = "";
        }
      }
    }

    updateAgentHeader(agent);
    log(`Agent '${agent.name}' executed.`);
    // Refresh state in background
    refreshState();
  } catch (e) {
    addChatMessage("assistant", `Error: ${e.message}`);
    setStatus("#agent-status", e.message);
    log("Agent test failed", { error: e.message });
  }
}

function handleSSEMessage(type, data, textEl, msgIndex) {
  if (type === "delta") {
    // Append text chunk to the assistant message
    const current = studio.chatMessages[msgIndex]?.text || "";
    const newText = current + (data.text || "");
    studio.chatMessages[msgIndex].text = newText;
    if (textEl) textEl.innerHTML = renderMarkdown(newText);
    // Scroll chat to bottom
    const container = $("#chat-messages");
    container.scrollTop = container.scrollHeight;
  } else if (type === "event") {
    // Add to trace events and render in inspector
    studio.traceEvents.push(data);
    renderSingleEvent(data, "#event-list");
    if (data.type === "trace.complete") {
      renderSingleEvent(data, "#trace-list");
    }
    // Update event count
    const total = $$("#event-list .event-item").length;
    $("#event-count").textContent = `${total}`;

    // Add event to the current assistant message's thinking process
    if (studio.chatMessages[msgIndex]) {
      if (!studio.chatMessages[msgIndex].events) studio.chatMessages[msgIndex].events = [];
      studio.chatMessages[msgIndex].events.push(data);
      updateThinkingProcessInPlace(msgIndex);
    }
  }
}

/* ── Simple markdown rendering ───────────────────────────── */
function renderMarkdown(text) {
  if (!text) return "";

  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    // --- Table detection: look for separator row (---|---|---)
    if (i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const headerCells = lines[i].split("|").map(c => c.trim()).filter((c, idx, arr) => idx > 0 || c !== "" || arr.length > 2 ? true : false);
      const cleanHeader = headerCells.filter(c => c !== "");
      i += 2; // skip header + separator
      const bodyRows = [];
      while (i < lines.length && lines[i].includes("|")) {
        const cells = lines[i].split("|").map(c => c.trim());
        const cleanCells = cells.filter((c, idx) => !(idx === 0 && c === "") && !(idx === cells.length - 1 && c === ""));
        bodyRows.push(cleanCells);
        i++;
      }
      const thHtml = cleanHeader.map(c => `<th>${inlineMarkdown(c)}</th>`).join("");
      const trHtml = bodyRows.map(row =>
        `<tr>${row.map(c => `<td>${inlineMarkdown(c)}</td>`).join("")}</tr>`
      ).join("");
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${thHtml}</tr></thead><tbody>${trHtml}</tbody></table></div>`);
      continue;
    }

    // --- Heading
    const hMatch = lines[i].match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level} class="md-h${level}">${inlineMarkdown(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // --- Bullet list item
    if (/^\s*[-*]\s+/.test(lines[i])) {
      out.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }

    // --- Blank line
    if (lines[i].trim() === "") {
      out.push("<br>");
      i++;
      continue;
    }

    // --- Normal paragraph line
    out.push(inlineMarkdown(lines[i]) + "<br>");
    i++;
  }

  return out.join("");
}

function inlineMarkdown(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/* ==============================================================
   CHAT + INSPECTOR (DevUI-style)
   ============================================================== */

function addChatMessage(role, text) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  studio.chatMessages.push({ role, text, time, events: [] });
  renderChatMessages();
}

function renderChatMessages() {
  const container = $("#chat-messages");
  container.innerHTML = "";
  studio.chatMessages.forEach((msg, idx) => {
    // Render thinking process as a separate block before the assistant message
    if (msg.role === "assistant" && msg.events && msg.events.length > 0) {
      const thinkingEl = document.createElement("div");
      thinkingEl.className = "thinking-block";
      thinkingEl.dataset.msgIdx = idx;
      thinkingEl.innerHTML = buildThinkingProcessHtml(msg.events, idx);
      bindThinkingToggle(thinkingEl);
      container.appendChild(thinkingEl);
    }

    const el = document.createElement("div");
    el.className = "chat-msg";
    el.dataset.msgIdx = idx;
    const avatarClass = msg.role === "user" ? "user" : "assistant";
    const avatarLabel = msg.role === "user" ? "U" : "AI";

    el.innerHTML = `
      <div class="chat-msg-avatar ${avatarClass}">${avatarLabel}</div>
      <div class="chat-msg-body">
        <div class="chat-msg-text">${msg.role === "assistant" ? renderMarkdown(msg.text) : esc(msg.text)}</div>
      </div>
      <span class="chat-msg-time">${esc(msg.time)}</span>
    `;

    container.appendChild(el);
  });
  container.scrollTop = container.scrollHeight;
}

function bindThinkingToggle(el) {
  const toggle = el.querySelector(".thinking-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const content = el.querySelector(".thinking-steps");
      const arrow = el.querySelector(".thinking-arrow");
      if (content) {
        const isOpen = content.classList.toggle("open");
        if (arrow) arrow.classList.toggle("open", isOpen);
      }
    });
  }
}

function buildThinkingStepHtml(ev) {
  const dotClass = getThinkingDotClass(ev.type);
  const isFnCall = ev.type === "function_call.complete" || ev.type === "function_result.complete";
  const stepClass = isFnCall ? "thinking-step fn-call" : "thinking-step";
  const icon = isFnCall
    ? '<span class="thinking-fn-icon">&#9881;</span>'
    : `<span class="thinking-dot ${dotClass}"></span>`;

  let bodyContent = `<span class="thinking-step-text">${esc(ev.title)}</span>`;

  if (ev.type === "function_call.complete" && ev.detail) {
    let argsText = ev.detail;
    try { const p = JSON.parse(ev.detail); argsText = JSON.stringify(p, null, 2); } catch {}
    bodyContent += `<pre class="thinking-fn-args">${esc(argsText)}</pre>`;
  }
  if (ev.type === "function_result.complete" && ev.detail) {
    bodyContent += `<pre class="thinking-fn-result"><span class="thinking-fn-result-label">result:</span> ${esc(ev.detail)}</pre>`;
  }

  return `<div class="${stepClass}">${icon}<div class="thinking-step-body">${bodyContent}</div></div>`;
}

function buildThinkingProcessHtml(events, msgIdx) {
  const steps = events.map((ev) => buildThinkingStepHtml(ev)).join("");
  return `
    <div class="thinking-process">
      <div class="thinking-toggle">
        <span class="thinking-arrow">&#9654;</span>
        <span class="thinking-label">Thinking process (${events.length} steps)</span>
      </div>
      <div class="thinking-steps">${steps}</div>
    </div>
  `;
}

function getThinkingDotClass(eventType) {
  switch (eventType) {
    case "connection": return "dot-purple";
    case "skills_available": return "dot-purple";
    case "mcp_available": return "dot-purple";
    case "prompt_start": return "dot-purple";
    case "skill_load": return "dot-amber";
    case "function_call.complete": return "dot-amber";
    case "function_result.complete": return "dot-amber";
    case "read_skill_resource": return "dot-amber";
    case "response_complete": return "dot-green";
    case "handoff_transition": return "dot-amber";
    case "error": return "dot-red";
    case "info": return "dot-purple";
    default: return "dot-purple";
  }
}

/** Re-render only the thinking process of the latest assistant message (for streaming updates). */
function updateThinkingProcessInPlace(msgIdx) {
  const msg = studio.chatMessages[msgIdx];
  if (!msg || !msg.events || !msg.events.length) return;

  // Find the thinking-block for this message index
  let thinkingEl = $(`.thinking-block[data-msg-idx="${msgIdx}"]`);
  if (!thinkingEl) {
    // Insert a thinking-block before the assistant message element
    const msgEl = $(`.chat-msg[data-msg-idx="${msgIdx}"]`);
    if (!msgEl) return;
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking-block";
    thinkingEl.dataset.msgIdx = msgIdx;
    msgEl.parentNode.insertBefore(thinkingEl, msgEl);
  }

  const wasOpen = thinkingEl.querySelector(".thinking-steps.open") !== null;
  const steps = msg.events.map((ev) => buildThinkingStepHtml(ev)).join("");

  thinkingEl.innerHTML = `
    <div class="thinking-process">
      <div class="thinking-toggle">
        <span class="thinking-arrow${wasOpen ? " open" : ""}">&#9654;</span>
        <span class="thinking-label">Thinking process (${msg.events.length} steps)</span>
      </div>
      <div class="thinking-steps${wasOpen ? " open" : ""}">${steps}</div>
    </div>
  `;

  bindThinkingToggle(thinkingEl);
}

function clearChat() {
  studio.chatMessages = [];
  studio.traceEvents = [];
  renderChatMessages();
  clearInspector();
}

function clearInspector() {
  $("#event-list").innerHTML = '<div class="inspector-empty">Run the agent to see events here.</div>';
  $("#trace-list").innerHTML = '<div class="inspector-empty">No traces yet.</div>';
  $("#event-count").textContent = "0";
}

function renderSingleEvent(ev, containerSel) {
  const container = $(containerSel);
  // Remove empty state on first event
  const empty = container.querySelector(".inspector-empty");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = "event-item";
  const iconClass = ev.type.startsWith("function_call") ? "fn"
    : ev.type === "trace.complete" ? "trace"
    : ev.type === "message.complete" ? "msg"
    : ev.type === "error" ? "err" : "info";
  const iconLabel = iconClass === "fn" ? "F" : iconClass === "trace" ? "T" : iconClass === "msg" ? "M" : iconClass === "err" ? "!" : "i";

  item.innerHTML = `
    <div class="event-item-header">
      <div class="event-type-icon ${iconClass}">${iconLabel}</div>
      <span class="event-item-time">${esc(ev.timestamp)}</span>
      <span class="event-item-type">${esc(ev.type)}</span>
    </div>
    <div class="event-item-title">${esc(ev.title)}</div>
  `;
  item.addEventListener("click", () => showEventDetailPopup(ev));
  container.appendChild(item);
  container.scrollTop = container.scrollHeight;
}

function renderEvents(events) {
  events.forEach((ev) => renderSingleEvent(ev, "#event-list"));
  const total = $$("#event-list .event-item").length;
  $("#event-count").textContent = `${total}`;
}

function renderTraces(traceEvents) {
  traceEvents.forEach((ev) => renderSingleEvent(ev, "#trace-list"));
}

/* ── Event Detail Popup ──────────────────────────────────── */
function showEventDetailPopup(ev) {
  // Remove existing popup if any
  const existing = $(".event-popup-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "event-popup-overlay";

  const iconClass = ev.type.startsWith("function_call") ? "fn"
    : ev.type === "trace.complete" ? "trace"
    : ev.type === "message.complete" ? "msg"
    : ev.type === "error" ? "err" : "info";

  let detailHtml = "";
  if (ev.detail) {
    // Try to format as JSON, otherwise show as text
    let formatted = ev.detail;
    try {
      const parsed = JSON.parse(ev.detail);
      formatted = JSON.stringify(parsed, null, 2);
    } catch { /* not JSON, keep as is */ }
    detailHtml = `<pre class="popup-detail-pre">${esc(formatted)}</pre>`;
  }

  overlay.innerHTML = `
    <div class="event-popup">
      <div class="popup-header">
        <div class="popup-header-left">
          <div class="event-type-icon ${iconClass}" style="width:28px;height:28px;font-size:13px;">
            ${iconClass === "fn" ? "F" : iconClass === "trace" ? "T" : iconClass === "msg" ? "M" : iconClass === "err" ? "!" : "i"}
          </div>
          <div>
            <div class="popup-type">${esc(ev.type)}</div>
            <div class="popup-time">${esc(ev.timestamp)}</div>
          </div>
        </div>
        <button class="popup-close" title="Close">&times;</button>
      </div>
      <div class="popup-body">
        <div class="popup-title">${esc(ev.title)}</div>
        ${detailHtml}
      </div>
    </div>
  `;

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector(".popup-close").addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);

  // Close on Escape
  const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
}

function updateToolsList(agent) {
  const container = $("#tools-list");
  container.innerHTML = "";
  const tools = [];
  (agent.mcp_tools || []).forEach((t) => {
    if (t.url?.trim()) tools.push({ name: t.name || "MCP Tool", type: "MCP", detail: t.url });
  });
  (agent.skill_ids || []).forEach((sid) => {
    const skill = studio.state.skills.find((s) => s.id === sid);
    if (skill) tools.push({ name: skill.name, type: "Skill", detail: `${skill.scripts.length} scripts` });
  });

  if (!tools.length) {
    container.innerHTML = '<div class="inspector-empty">No tools configured.</div>';
    return;
  }
  tools.forEach((t) => {
    const card = document.createElement("div");
    card.className = "tool-card";
    card.innerHTML = `<strong>${esc(t.name)}</strong><div class="meta">${esc(t.type)} · ${esc(t.detail)}</div>`;
    container.appendChild(card);
  });
}

/* ── Tab switching for agent tabs ────────────────────────── */
function initAgentTabs() {
  $$(".agent-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".agent-tab").forEach((t) => t.classList.remove("active"));
      $$(".agent-tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.tab;
      $(`#tab-${target}`).classList.add("active");
    });
  });
}

function initInspectorTabs() {
  $$(".inspector-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".inspector-tab").forEach((t) => t.classList.remove("active"));
      $$(".inspector-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.inspector;
      $(`#inspector-${target}`).classList.add("active");
    });
  });
}

function initInspectorToggle() {
  const btn = $("#inspector-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const panel = document.querySelector(".inspector-panel");
    const layout = document.querySelector(".playground-layout");
    const isCollapsed = panel.classList.toggle("collapsed");
    layout.classList.toggle("inspector-collapsed", isCollapsed);
    btn.innerHTML = isCollapsed ? "&#9654;" : "&#9664;";
    btn.title = isCollapsed ? "パネルを開く" : "パネルを閉じる";
  });
}

async function uploadSkill() {
  const folderFiles = Array.from($("#skill-folder").files || []);
  const looseFiles = Array.from($("#skill-files").files || []);
  const files = folderFiles.length ? folderFiles : looseFiles;
  if (!files.length) { log("Select a folder or files before importing."); return; }

  const fd = new FormData();
  fd.append("skill_name", $("#skill-name").value.trim() || "uploaded-skill");
  fd.append("source_type", folderFiles.length ? "folder" : "files");
  fd.append("relative_paths_json", JSON.stringify(files.map((f) => f.webkitRelativePath || f.name)));
  files.forEach((f) => fd.append("files", f));

  try {
    const p = await api("/api/skills/upload", { method: "POST", body: fd });
    populateState(p.state);
    log(p.message, p.skill);
  } catch (e) {
    log("Skill import failed", { error: e.message });
  }
}

async function runSelectedScript() {
  const skillId = $("#script-skill-select").value;
  const scriptName = $("#script-name-select").value;
  let args = {};
  try { args = JSON.parse($("#script-args").value || "{}"); }
  catch (e) { log("Invalid JSON in script args.", { error: e.message }); return; }

  try {
    const p = await api(`/api/skills/${skillId}/run`, { method: "POST", body: JSON.stringify({ script_name: scriptName, args }) });
    $("#script-output").textContent = p.result.output;
    // Also show in agent output if on agents page
    if ($("#page-agents").classList.contains("active")) {
      $("#agent-output").textContent = p.result.output;
    }
    log(p.message, p.result);
  } catch (e) {
    log("Script execution failed", { error: e.message });
  }
}

function addNode() {
  const agentId = $("#node-agent-select").value;
  const agent = studio.state.agents.find((a) => a.id === agentId);
  if (!agent) return;
  const n = studio.currentWorkflow.nodes.length;
  studio.currentWorkflow.nodes.push({
    id: createId("node"),
    title: agent.name,
    agent_id: agent.id,
    position: { x: 40 + (n % 3) * 230, y: 40 + Math.floor(n / 3) * 130 },
  });
  if (!studio.currentWorkflow.start_node_id) studio.currentWorkflow.start_node_id = studio.currentWorkflow.nodes[0].id;
  renderWorkflowCanvas();
  log("Added workflow node.", { agent: agent.name });
}

function addEdge() {
  const source = $("#edge-source").value;
  const target = $("#edge-target").value;
  if (!source || !target || source === target) { log("Choose two different nodes."); return; }
  studio.currentWorkflow.edges.push({
    id: createId("edge"), source, target,
    edge_type: $("#edge-type").value,
    label: $("#edge-label").value.trim(),
    condition: $("#edge-condition").value.trim(),
    priority: studio.currentWorkflow.edges.length,
  });
  renderWorkflowCanvas();
  log("Added edge.", studio.currentWorkflow.edges.at(-1));
}

function collectWorkflow() {
  return {
    ...studio.currentWorkflow,
    name: $("#workflow-name").value.trim() || "New Workflow",
    description: $("#workflow-description").value.trim(),
    input_text: $("#workflow-prompt").value.trim(),
    start_node_id: $("#workflow-start").value || studio.currentWorkflow.start_node_id,
  };
}

async function saveWorkflow() {
  try {
    const wf = collectWorkflow();
    const p = await api("/api/workflows", { method: "POST", body: JSON.stringify(wf) });
    studio.currentWorkflow = wf;
    populateState(p.state);
    $("#workflow-code").textContent = p.generated_code;
    setStatus("#workflow-status", p.message);
    log(p.message, wf);
  } catch (e) {
    setStatus("#workflow-status", e.message);
    log("Failed to save workflow", { error: e.message });
  }
}

async function testWorkflow() {
  try {
    setStatus("#workflow-status", "Running...");
    const wf = collectWorkflow();
    const prompt = $("#workflow-prompt").value.trim();
    const p = await api("/api/workflows/test", { method: "POST", body: JSON.stringify({ workflow: wf, prompt }) });
    studio.currentWorkflow = wf;
    populateState(p.state);
    $("#workflow-code").textContent = p.result.generated_code;
    $("#workflow-output").textContent =
      `${p.result.outputs.join("\n\n")}\n\n── Trace ──\n${p.result.trace.map((t) => `${t.step}. ${t.node} (${t.mode})\n${t.output}`).join("\n\n")}`;
    setStatus("#workflow-status", p.message);
    log(p.message, p.result);
  } catch (e) {
    setStatus("#workflow-status", e.message);
    $("#workflow-output").textContent = e.message;
    log("Workflow test failed", { error: e.message });
  }
}

function newAgent() {
  studio.selectedAgentId = null;
  $("#agent-name").value = "";
  $("#agent-description").value = "";
  $("#provider").value = "mock";
  // Reset model select
  const modelSel = $("#model-name");
  if (!Array.from(modelSel.options).some((o) => o.value === "gpt-4.1-mini")) {
    modelSel.innerHTML = '<option value="gpt-4.1-mini">gpt-4.1-mini (manual)</option>';
  }
  modelSel.value = "gpt-4.1-mini";
  $("#api-key-env").value = "OPENAI_API_KEY";
  $("#base-url").value = "";
  $("#api-version").value = "";
  $("#instructions").value = "";
  const mc = $("#mcp-container");
  mc.innerHTML = "";
  mc.appendChild(buildMcpRow());
  populateAgentSkillSection([]);
  populateAgentList();
  updateAgentHeader({ name: "New Agent", mcp_tools: [], skill_ids: [] });
  clearChat();
  updateToolsList({ mcp_tools: [], skill_ids: [] });
  // Update chat header
  $("#chat-agent-name").textContent = "New Agent";
  $("#chat-agent-desc").textContent = "A helpful Microsoft Agent Framework assistant.";
  setStatus("#agent-status", "New agent");
}

/* ==============================================================
   AZURE MODEL FETCHER
   ============================================================== */
async function fetchAzureModels() {
  const btn = $("#btn-fetch-models");
  const sel = $("#model-name");
  const prevValue = sel.value;

  btn.disabled = true;
  btn.classList.add("spin");
  try {
    const data = await api("/api/models/azure");
    const deployments = data.deployments || [];
    if (!deployments.length) {
      setStatus("#agent-status", "No deployments found on endpoint.");
      return;
    }
    // Preserve any existing manual options that are not from Azure
    sel.innerHTML = "";

    deployments.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.deployment_name;
      const ver = d.model_version ? ` v${d.model_version}` : "";
      opt.textContent = `${d.deployment_name}  (${d.model || "?"}${ver})`;
      sel.appendChild(opt);
    });

    // Add a manual-entry option at the end
    const custom = document.createElement("option");
    custom.value = "__custom__";
    custom.textContent = "+ Enter manually…";
    sel.appendChild(custom);

    // Restore previous selection if it exists
    const exists = Array.from(sel.options).some((o) => o.value === prevValue);
    if (exists) sel.value = prevValue;

    setStatus("#agent-status", `Loaded ${deployments.length} Azure deployment(s)`);
    log(`Fetched ${deployments.length} Azure OpenAI deployments`, deployments.map((d) => d.deployment_name));
  } catch (e) {
    setStatus("#agent-status", `Model fetch failed: ${e.message}`);
    log("Azure model fetch failed", { error: e.message });
  } finally {
    btn.disabled = false;
    btn.classList.remove("spin");
  }
}

function handleModelSelectChange() {
  const sel = $("#model-name");
  if (sel.value === "__custom__") {
    const name = prompt("Enter model/deployment name:");
    if (name && name.trim()) {
      const opt = document.createElement("option");
      opt.value = name.trim();
      opt.textContent = name.trim() + " (manual)";
      sel.insertBefore(opt, sel.querySelector('[value="__custom__"]'));
      sel.value = name.trim();
    } else {
      sel.selectedIndex = 0;
    }
  }
}

/* ==============================================================
   HANDOFFS
   ============================================================== */

/* ── Blank handoff factory ──────────────────────────────── */
function createBlankHandoff() {
  return {
    id: `handoff-${(crypto.randomUUID?.() || String(Date.now())).slice(0, 8)}`,
    name: "New Handoff Workflow",
    description: "",
    participant_agent_ids: [],
    start_agent_id: null,
    rules: [],
    termination_keyword: "goodbye",
    autonomous_mode: false,
  };
}

/* ── Populate handoff list sidebar ─────────────────────── */
function populateHandoffList() {
  const sel = $("#handoff-select");
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select Workflow —</option>' +
    (studio.state.handoffs || []).map(h =>
      `<option value="${esc(h.id)}"${h.id === studio.currentHandoffId ? " selected" : ""}>${esc(h.name)}</option>`
    ).join("");
}

/* ── Participant management ─────────────────────────────── */
function populateParticipantAddSelect() {
  const container = $("#handoff-participant-checks");
  if (!container) return;
  const used = new Set(studio.hoParticipantIds || []);
  const available = studio.state.agents.filter((a) => !used.has(a.id));
  container.innerHTML = "";
  if (!available.length) {
    container.innerHTML = '<span class="ho-participant-empty">追加できるエージェントがありません</span>';
    return;
  }
  available.forEach((a) => {
    const label = document.createElement("label");
    label.className = "ho-tgt-check";
    label.innerHTML = `<input type="checkbox" value="${esc(a.id)}" /><span>${esc(a.name)}</span>`;
    container.appendChild(label);
  });
}

function renderParticipantChips() {
  const list = $("#handoff-participants-list");
  list.innerHTML = "";
  (studio.hoParticipantIds || []).forEach((agentId) => {
    const agent = studio.state.agents.find((a) => a.id === agentId);
    if (!agent) return;
    const chip = document.createElement("div");
    chip.className = "ho-chip";
    chip.innerHTML = `<span class="ho-chip-name">${esc(agent.name)}</span><button class="ho-chip-remove" title="Remove" data-agent-id="${agentId}">✕</button>`;
    chip.querySelector(".ho-chip-remove").addEventListener("click", () => removeHandoffParticipant(agentId));
    list.appendChild(chip);
  });
  populateParticipantAddSelect();
  populateHandoffStartAgentSelect($("#handoff-start-agent").value, studio.hoParticipantIds);
  populateRuleDropdowns();
  const h = hoFormSnapshot();
  renderHandoffGraph(h);
  updateHandoffAgentStrip(h);
}

function addHandoffParticipant() {
  const container = $("#handoff-participant-checks");
  if (!container) return;
  const checked = [...container.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
  if (!checked.length) return;
  const existing = new Set(studio.hoParticipantIds || []);
  checked.forEach(id => existing.add(id));
  studio.hoParticipantIds = [...existing];
  renderParticipantChips();
  markHandoffDirty();
}

function removeHandoffParticipant(agentId) {
  studio.hoParticipantIds = (studio.hoParticipantIds || []).filter((id) => id !== agentId);
  studio.hoRules = (studio.hoRules || []).filter(
    (r) => r.source_agent_id !== agentId && !(r.target_agent_ids || []).includes(agentId)
  );
  renderParticipantChips();
  renderHandoffRules();
  markHandoffDirty();
}

/* ── Start-agent select ─────────────────────────────────── */
function populateHandoffStartAgentSelect(currentId = null, participantIds = []) {
  const sel = $("#handoff-start-agent");
  const agents = participantIds.length
    ? studio.state.agents.filter((a) => participantIds.includes(a.id))
    : studio.state.agents;
  sel.innerHTML = '<option value="">— Select start agent —</option>' +
    agents.map((a) => `<option value="${a.id}" ${a.id === currentId ? "selected" : ""}>${esc(a.name)}</option>`).join("");
}

/* ── Routing rule management ────────────────────────────── */
function populateRuleDropdowns() {
  const participants = (studio.hoParticipantIds || [])
    .map((id) => studio.state.agents.find((a) => a.id === id))
    .filter(Boolean);
  const srcOpts = '<option value="">Source agent</option>' +
    participants.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  const srcSel = $("#rule-src-select");
  if (srcSel) srcSel.innerHTML = srcOpts;

  // Target checkboxes
  const tgtContainer = $("#rule-tgt-checks");
  if (tgtContainer) {
    tgtContainer.innerHTML = "";
    participants.forEach((a) => {
      const label = document.createElement("label");
      label.className = "ho-tgt-check";
      label.innerHTML = `<input type="checkbox" value="${a.id}" /><span>${esc(a.name)}</span>`;
      tgtContainer.appendChild(label);
    });
  }
}

function renderHandoffRules() {
  const list = $("#handoff-rules-list");
  if (!list) return;
  list.innerHTML = "";
  (studio.hoRules || []).forEach((rule, idx) => {
    const srcAgent = studio.state.agents.find((a) => a.id === rule.source_agent_id);
    const tgtAgents = (rule.target_agent_ids || [])
      .map((id) => studio.state.agents.find((a) => a.id === id))
      .filter(Boolean);
    const row = document.createElement("div");
    row.className = "ho-rule-row";
    row.innerHTML = `
      <span class="ho-rule-src">${esc(srcAgent?.name || rule.source_agent_id)}</span>
      <span class="rule-arrow">→</span>
      <span class="ho-rule-tgt">${tgtAgents.map((a) => esc(a.name)).join(", ") || "?"}</span>
      <button class="ho-chip-remove" data-rule-idx="${idx}" title="Remove rule">✕</button>
    `;
    row.querySelector(".ho-chip-remove").addEventListener("click", () => removeHandoffRule(idx));
    list.appendChild(row);
  });
  const h = hoFormSnapshot();
  renderHandoffGraph(h);
}

function addHandoffRule() {
  const src = $("#rule-src-select").value;
  const targets = Array.from($$("#rule-tgt-checks input:checked"))
    .map((cb) => cb.value)
    .filter((id) => id !== src);
  if (!src || !targets.length) return;
  const existing = (studio.hoRules || []).find((r) => r.source_agent_id === src);
  if (existing) {
    const newTargets = targets.filter((t) => !(existing.target_agent_ids || []).includes(t));
    if (!newTargets.length) return;
    existing.target_agent_ids = [...(existing.target_agent_ids || []), ...newTargets];
  } else {
    studio.hoRules = [...(studio.hoRules || []), { source_agent_id: src, target_agent_ids: targets }];
  }
  // Clear selections
  $("#rule-src-select").value = "";
  $$("#rule-tgt-checks input").forEach((cb) => { cb.checked = false; });
  renderHandoffRules();
  markHandoffDirty();
}

function removeHandoffRule(idx) {
  studio.hoRules = (studio.hoRules || []).filter((_, i) => i !== idx);
  renderHandoffRules();
  markHandoffDirty();
}

/* ── Form snapshot (unsaved state) ─────────────────────── */
function hoFormSnapshot() {
  return {
    id: studio.currentHandoffId || createId("handoff"),
    name: ($("#handoff-name")?.value || "").trim() || "New Handoff Workflow",
    description: ($("#handoff-description")?.value || "").trim(),
    participant_agent_ids: studio.hoParticipantIds || [],
    start_agent_id: $("#handoff-start-agent")?.value || null,
    rules: studio.hoRules || [],
    termination_keyword: ($("#handoff-termination-keyword")?.value || "").trim() || "goodbye",
    autonomous_mode: $("#handoff-autonomous")?.checked || false,
  };
}

/* ── Load a handoff into the form ───────────────────────── */
function loadHandoff(h) {
  studio.currentHandoffId = h.id;
  studio.hoParticipantIds = [...(h.participant_agent_ids || [])];
  studio.hoRules = JSON.parse(JSON.stringify(h.rules || []));
  studio.hoNodePositions = {};   // reset layout for fresh drag-and-drop
  studio.hoPanX = 0; studio.hoPanY = 0; studio.hoZoom = 1.0;

  $("#handoff-name").value = h.name || "";
  $("#handoff-description").value = h.description || "";
  $("#handoff-termination-keyword").value = h.termination_keyword || "goodbye";
  $("#handoff-autonomous").checked = !!h.autonomous_mode;

  populateParticipantAddSelect();
  renderParticipantChips();
  populateHandoffStartAgentSelect(h.start_agent_id, h.participant_agent_ids || []);
  populateRuleDropdowns();
  renderHandoffRules();
  populateHandoffList();
  renderHandoffGraph(h);
  updateHandoffAgentStrip(h);
  setStatus("#handoff-status", `Loaded ${h.name}`);
  clearHandoffDirty();
}

/* ── Collect form data ──────────────────────────────────── */
function collectHandoffForm() {
  return hoFormSnapshot();
}

/* ── Save handoff ───────────────────────────────────────── */
async function saveHandoff() {
  try {
    const h = collectHandoffForm();
    studio.currentHandoffId = h.id;
    const p = await api("/api/handoffs", { method: "POST", body: JSON.stringify(h) });
    populateState(p.state);
    renderHandoffGraph(h);
    updateHandoffAgentStrip(h);
    setStatus("#handoff-status", p.message);
    log(p.message, h);
    clearHandoffDirty();
    showToast("ワークフローを保存しました");
  } catch (e) {
    setStatus("#handoff-status", e.message);
    log("Failed to save handoff", { error: e.message });
    showToast("保存に失敗しました", "error");
  }
}

/* ── Delete handoff ─────────────────────────────────────── */
async function deleteHandoff() {
  if (!studio.currentHandoffId) return;
  const h = (studio.state.handoffs || []).find((x) => x.id === studio.currentHandoffId);
  if (!confirm(`Delete handoff "${h?.name || studio.currentHandoffId}"?`)) return;
  try {
    const p = await api(`/api/handoffs/${encodeURIComponent(studio.currentHandoffId)}`, { method: "DELETE" });
    studio.currentHandoffId = null;
    studio.handoffSessionId = null;
    populateState(p.state);
    if (p.state.handoffs?.length) {
      loadHandoff(p.state.handoffs[0]);
    } else {
      newHandoff();
    }
    setStatus("#handoff-status", p.message);
    log(p.message);
  } catch (e) {
    setStatus("#handoff-status", e.message);
    log("Failed to delete handoff", { error: e.message });
  }
}

/* ── New handoff ────────────────────────────────────────── */
function newHandoff() {
  studio.currentHandoffId = null;
  studio.handoffSessionId = null;
  studio.handoffCurrentAgentId = null;
  studio.handoffChatMessages = [];
  studio.hoParticipantIds = [];
  studio.hoRules = [];
  studio.hoNodePositions = {};
  const blank = createBlankHandoff();
  loadHandoff(blank);
  clearHandoffChat();
  setStatus("#handoff-status", "New handoff");
  clearHandoffDirty();
}

/* ── Agent strip (participants status bar) ──────────────── */
function updateHandoffAgentStrip(handoff) {
  const strip = $("#handoff-agent-strip");
  strip.innerHTML = "";
  const participants = (handoff.participant_agent_ids || [])
    .map((id) => studio.state.agents.find((a) => a.id === id))
    .filter(Boolean);
  participants.forEach((agent) => {
    const pill = document.createElement("div");
    pill.className = "handoff-agent-pill";
    pill.dataset.agentId = agent.id;
    if (agent.id === studio.handoffCurrentAgentId) pill.classList.add("active");
    pill.innerHTML = `<span class="pill-dot"></span><span class="pill-name">${esc(agent.name)}</span>`;
    strip.appendChild(pill);
  });
}

function setActiveAgentInStrip(agentId, agentName) {
  studio.handoffCurrentAgentId = agentId;
  $$(".handoff-agent-pill").forEach((p) => p.classList.toggle("active", p.dataset.agentId === agentId));
  $("#handoff-active-agent-name").textContent = agentName || "Unknown agent";
  const badge = $("#handoff-active-agent-badge");
  badge.classList.add("pulse");
  setTimeout(() => badge.classList.remove("pulse"), 800);
  animateHandoffGraphNode(agentId);
}

/* ==============================================================
   HANDOFF GRAPH (Workflow-style canvas + SVG edge layer)
   ============================================================== */
const HO_NODE_W = 170;
const HO_NODE_H = 68;

function drawHoEdges(svg, handoff) {
  const defs = svg.querySelector("defs");
  svg.innerHTML = "";
  if (defs) {
    svg.appendChild(defs);
  } else {
    svg.innerHTML = `<defs>
      <marker id="ho-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#7baeff"/></marker>
      <marker id="ho-arrow-flash" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#34d399"/></marker>
    </defs>`;
  }
  (handoff.rules || []).forEach((rule) => {
    (rule.target_agent_ids || []).forEach((tid) => {
      const p1 = studio.hoNodePositions[rule.source_agent_id];
      const p2 = studio.hoNodePositions[tid];
      if (!p1 || !p2) return;
      const isFlashing = studio.handoffFlashEdgeKey
        && rule.source_agent_id === studio.handoffFlashEdgeKey.from
        && tid === studio.handoffFlashEdgeKey.to;
      const x1 = p1.x + HO_NODE_W, y1 = p1.y + HO_NODE_H / 2;
      const x2 = p2.x, y2 = p2.y + HO_NODE_H / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", isFlashing ? "#34d399" : "#7baeff");
      path.setAttribute("stroke-width", isFlashing ? "3" : "2");
      path.setAttribute("stroke-opacity", isFlashing ? "1" : "0.85");
      path.setAttribute("marker-end", isFlashing ? "url(#ho-arrow-flash)" : "url(#ho-arrow)");
      path.classList.add("ho-edge");
      if (isFlashing) path.classList.add("ho-edge-flash");
      path.dataset.from = rule.source_agent_id;
      path.dataset.to = tid;
      svg.appendChild(path);
    });
  });
}

function updateHoViewport() {
  const vp = $("#ho-viewport");
  if (!vp) return;
  vp.style.transform = `translate(${studio.hoPanX}px, ${studio.hoPanY}px) scale(${studio.hoZoom})`;
  const label = $("#ho-zoom-label");
  if (label) label.textContent = `${Math.round(studio.hoZoom * 100)}%`;
}

function resetHoLayout(handoff) {
  const participants = (handoff.participant_agent_ids || [])
    .map((id) => studio.state.agents.find((a) => a.id === id))
    .filter(Boolean);
  const shell = $("#ho-canvas")?.parentElement?.parentElement; // ho-viewport → ho-canvas-shell
  const W = shell ? (shell.clientWidth || 520) : 520;
  const H = shell ? (shell.clientHeight || 360) : 360;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(cx, cy) - 70;
  participants.forEach((agent, i) => {
    const angle = (i / participants.length) * 2 * Math.PI - Math.PI / 2;
    studio.hoNodePositions[agent.id] = {
      x: Math.round(cx + radius * Math.cos(angle) - HO_NODE_W / 2),
      y: Math.round(cy + radius * Math.sin(angle) - HO_NODE_H / 2),
    };
  });
  studio.hoPanX = 0;
  studio.hoPanY = 0;
  studio.hoZoom = 1.0;
  updateHoViewport();
  renderHandoffGraph(handoff);
}

function renderHandoffGraph(handoff) {
  const canvas = $("#ho-canvas");
  const svg = $("#ho-edge-layer");
  if (!canvas || !svg) return;

  const participants = (handoff.participant_agent_ids || [])
    .map((id) => studio.state.agents.find((a) => a.id === id))
    .filter(Boolean);

  canvas.innerHTML = "";

  if (!participants.length) {
    svg.innerHTML = "";
    const placeholder = document.createElement("div");
    placeholder.className = "ho-canvas-empty";
    placeholder.textContent = "Add participants to see the handoff graph";
    canvas.appendChild(placeholder);
    updateHoViewport();
    return;
  }

  // Initialize default positions for new agents (circular layout)
  const shell = canvas.parentElement?.parentElement; // viewport → shell
  const W = shell ? (shell.clientWidth || 520) : 520;
  const H = shell ? (shell.clientHeight || 360) : 360;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(cx, cy) - 70;
  participants.forEach((agent, i) => {
    if (!studio.hoNodePositions[agent.id]) {
      const angle = (i / participants.length) * 2 * Math.PI - Math.PI / 2;
      studio.hoNodePositions[agent.id] = {
        x: Math.round(cx + radius * Math.cos(angle) - HO_NODE_W / 2),
        y: Math.round(cy + radius * Math.sin(angle) - HO_NODE_H / 2),
      };
    }
  });

  // Draw SVG edges first (they sit behind the node divs via absolute positioning)
  svg.innerHTML = `<defs>
    <marker id="ho-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#7baeff"/></marker>
    <marker id="ho-arrow-flash" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#34d399"/></marker>
  </defs>`;
  drawHoEdges(svg, handoff);

  // Draw node divs
  participants.forEach((agent) => {
    const pos = studio.hoNodePositions[agent.id];
    const isStart = agent.id === handoff.start_agent_id;
    const isActive = agent.id === studio.handoffCurrentAgentId;
    const initials = agent.name.split(" ").map((w) => w[0] || "").slice(0, 2).join("").toUpperCase();

    const el = document.createElement("div");
    el.className = `ho-node-card${isActive ? " active" : ""}${isStart ? " start" : ""}`;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.dataset.agentId = agent.id;
    el.innerHTML = `
      <div class="ho-node-avatar">${initials}</div>
      <div class="ho-node-info">
        <strong>${esc(agent.name)}</strong>
        <div class="ho-node-meta">${esc(agent.model?.provider || "")}</div>
      </div>
      ${isStart ? '<span class="ho-node-badge ho-badge-start">START</span>' : ""}
    `;

    // Drag — coordinates corrected for zoom
    let dragging = false, ox = 0, oy = 0;
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // don't trigger shell pan
      dragging = true;
      const r = canvas.getBoundingClientRect();
      ox = (e.clientX - r.left) / studio.hoZoom - pos.x;
      oy = (e.clientY - r.top) / studio.hoZoom - pos.y;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      pos.x = Math.max(0, (e.clientX - r.left) / studio.hoZoom - ox);
      pos.y = Math.max(0, (e.clientY - r.top) / studio.hoZoom - oy);
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
      drawHoEdges(svg, handoff);
    });
    el.addEventListener("pointerup", () => { dragging = false; el.style.cursor = "grab"; });
    el.addEventListener("pointercancel", () => { dragging = false; el.style.cursor = "grab"; });

    canvas.appendChild(el);
  });

  // Pan on shell background (register once per render via dataset flag)
  if (shell && !shell.dataset.panBound) {
    shell.dataset.panBound = "1";
    let panning = false, panSX = 0, panSY = 0;
    shell.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".ho-node-card")) return;
      panning = true;
      panSX = e.clientX - studio.hoPanX;
      panSY = e.clientY - studio.hoPanY;
      shell.setPointerCapture(e.pointerId);
      shell.classList.add("panning");
    });
    shell.addEventListener("pointermove", (e) => {
      if (!panning) return;
      studio.hoPanX = e.clientX - panSX;
      studio.hoPanY = e.clientY - panSY;
      updateHoViewport();
    });
    const stopPan = () => { panning = false; shell.classList.remove("panning"); };
    shell.addEventListener("pointerup", stopPan);
    shell.addEventListener("pointercancel", stopPan);
    // Wheel zoom toward cursor
    shell.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const r = shell.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const newZoom = Math.min(4, Math.max(0.25, studio.hoZoom * factor));
      studio.hoPanX = mx - (mx - studio.hoPanX) * (newZoom / studio.hoZoom);
      studio.hoPanY = my - (my - studio.hoPanY) * (newZoom / studio.hoZoom);
      studio.hoZoom = newZoom;
      updateHoViewport();
    }, { passive: false });
  }

  updateHoViewport();
}

function animateHandoffGraphNode(agentId) {
  // Re-render graph with updated active agent highlight
  const h = hoFormSnapshot();
  renderHandoffGraph(h);
}

/* ==============================================================
   HANDOFF CHAT + THINKING PROCESS
   ============================================================== */
function clearHandoffChat() {
  studio.handoffChatMessages = [];
  studio.handoffSessionId = null;
  studio.handoffCurrentAgentId = null;
  studio.handoffFlashEdgeKey = null;
  renderHandoffChatMessages();
  $$(".handoff-agent-pill").forEach((p) => p.classList.remove("active"));
  const nameEl = $("#handoff-active-agent-name");
  if (nameEl) nameEl.textContent = "No active agent";
}

function addHandoffChatMessage(role, text, agentName = null) {
  const time = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  studio.handoffChatMessages.push({ role, text, agentName, time, events: [] });
  renderHandoffChatMessages();
}

function buildHandoffThinkingProcessHtml(events, msgIdx) {
  // Re-use the shared Agents-tab step builder for visual consistency
  const steps = events.map((ev) => buildThinkingStepHtml(ev)).join("");
  const wasOpen = false;
  return `
    <div class="thinking-process" data-msg-idx="${msgIdx}">
      <div class="thinking-toggle">
        <span class="thinking-arrow">&#9654;</span>
        <span class="thinking-label">Thinking process (${events.length} step${events.length !== 1 ? "s" : ""})</span>
      </div>
      <div class="thinking-steps">${steps}</div>
    </div>
  `;
}

function renderHandoffChatMessages() {
  const container = $("#handoff-chat-messages");
  if (!container) return;

  if (!studio.handoffChatMessages.length) {
    container.innerHTML = `
      <div class="handoff-empty-chat">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        <p>Save the handoff configuration, then start chatting to test agent routing.</p>
      </div>`;
    return;
  }

  container.innerHTML = "";

  // Group messages into turns (user + following agent msgs) to keep thinking blocks
  // adjacent to their user message, then render in chronological order.
  const turns = [];
  let currentTurn = [];
  studio.handoffChatMessages.forEach((msg) => {
    if (msg.role === "user") {
      if (currentTurn.length) turns.push(currentTurn);
      currentTurn = [msg];
    } else {
      currentTurn.push(msg);
    }
  });
  if (currentTurn.length) turns.push(currentTurn);

  // Render in chronological order (oldest first, newest at bottom)
  turns.forEach((turn) => {
    turn.forEach((msg) => {
      const idx = studio.handoffChatMessages.indexOf(msg);

      if (msg.role === "user") {
        const el = document.createElement("div");
        el.className = "chat-msg handoff-msg-user";
        el.innerHTML = `
          <div class="chat-msg-avatar user">U</div>
          <div class="chat-msg-body">
            <div class="chat-msg-text">${esc(msg.text)}</div>
          </div>
          <span class="chat-msg-time">${esc(msg.time)}</span>
        `;
        container.appendChild(el);
      } else {
        // ── Thinking block (if any) ──
        if (msg.events && msg.events.length > 0) {
          const thinkingEl = document.createElement("div");
          thinkingEl.className = "thinking-block";
          thinkingEl.dataset.msgIdx = idx;
          thinkingEl.innerHTML = buildHandoffThinkingProcessHtml(msg.events, idx);
          bindThinkingToggle(thinkingEl);
          container.appendChild(thinkingEl);
        }
        // ── Agent segments ──
        const segments = msg.segments && msg.segments.length ? msg.segments : [{agentId: "", agentName: msg.agentName || "AI", text: msg.text || ""}];
        segments.forEach((seg) => {
          if (!seg.text) return;
          const avatarLabel = (seg.agentName || "AI").slice(0, 2).toUpperCase();
          const el = document.createElement("div");
          el.className = "chat-msg handoff-msg-agent";
          el.innerHTML = `
            <div class="chat-msg-avatar assistant">${esc(avatarLabel)}</div>
            <div class="chat-msg-body">
              <span class="handoff-agent-tag">${esc(seg.agentName || "AI")}</span>
              <div class="chat-msg-text">${renderMarkdown(seg.text || "")}</div>
            </div>
            <span class="chat-msg-time">${esc(msg.time)}</span>
          `;
          container.appendChild(el);
        });
      }
    });
  });
  container.scrollTop = container.scrollHeight;
}

async function sendHandoffMessage() {
  const input = $("#handoff-chat-input");
  const message = input.value.trim();
  if (!message) return;

  // Check unsaved state
  if (!studio.currentHandoffId) {
    const time = new Date().toLocaleTimeString();
    studio.handoffChatMessages.push({ role: "agent", text: "⚠️ Please save the handoff configuration first.", agentName: "System", time, events: [] });
    renderHandoffChatMessages();
    return;
  }
  const isSaved = (studio.state.handoffs || []).some((x) => x.id === studio.currentHandoffId);
  if (!isSaved) {
    const time = new Date().toLocaleTimeString();
    studio.handoffChatMessages.push({ role: "agent", text: "⚠️ This handoff has not been saved yet. Click **Save** in the configuration panel, then try again.", agentName: "System", time, events: [] });
    renderHandoffChatMessages();
    return;
  }

  addHandoffChatMessage("user", message);
  input.value = "";

  studio.handoffChatMessages.push({ role: "agent", text: "", agentName: null, time: new Date().toLocaleTimeString(), events: [], segments: [] });
  const msgIdx = studio.handoffChatMessages.length - 1;
  renderHandoffChatMessages();

  try {
    const body = JSON.stringify({
      handoff_id: studio.currentHandoffId,
      message,
      session_id: studio.handoffSessionId || null,
    });
    const res = await fetch("/api/handoffs/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      let eventType = "";
      let eventData = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          eventData = line.slice(6);
          if (eventType && eventData) {
            try { handleHandoffSSE(eventType, JSON.parse(eventData), msgIdx); } catch { /* skip */ }
            eventType = "";
            eventData = "";
          }
        }
      }
    }
  } catch (e) {
    studio.handoffChatMessages[msgIdx] = {
      ...studio.handoffChatMessages[msgIdx],
      text: `Error: ${e.message}`,
    };
    renderHandoffChatMessages();
    log("Handoff chat failed", { error: e.message });
  }
}

function handleHandoffSSE(type, data, msgIdx) {
  const msg = studio.handoffChatMessages[msgIdx];
  if (!msg) return;
  if (!msg.events) msg.events = [];
  if (!msg.segments) msg.segments = [];

  if (type === "active_agent") {
    setActiveAgentInStrip(data.agent_id, data.agent_name);
    // Start a new segment for this agent (if not already the current one)
    const last = msg.segments[msg.segments.length - 1];
    if (!last || last.agentId !== data.agent_id) {
      msg.segments.push({ agentId: data.agent_id, agentName: data.agent_name, text: "" });
    }
    if (!msg.agentName) msg.agentName = data.agent_name;
    // Note: the connection trace event is emitted separately as type="event"/connection
    renderHandoffChatMessages();
  } else if (type === "handoff") {
    // Flash the transitioning edge for 1.5 s, then revert
    studio.handoffFlashEdgeKey = { from: data.from_agent_id, to: data.to_agent_id };
    const hFlash = (studio.state.handoffs || []).find((x) => x.id === studio.currentHandoffId);
    if (hFlash) {
      const svgF = $("#ho-edge-layer");
      if (svgF) drawHoEdges(svgF, hFlash);
    }
    setTimeout(() => {
      studio.handoffFlashEdgeKey = null;
      const hClear = (studio.state.handoffs || []).find((x) => x.id === studio.currentHandoffId);
      if (hClear) {
        const svgC = $("#ho-edge-layer");
        if (svgC) drawHoEdges(svgC, hClear);
      }
    }, 1500);
    setActiveAgentInStrip(data.to_agent_id, data.to_agent_name);
    // New segment will be opened when active_agent fires for the next agent
    renderHandoffChatMessages();
  } else if (type === "clear_text") {
    // Backend detected a new tool call — discard any "planning" preamble text
    const last = msg.segments[msg.segments.length - 1];
    if (last && (!data.agent_id || last.agentId === data.agent_id)) {
      last.text = "";
    }
    msg.text = "";
    renderHandoffChatMessages();
  } else if (type === "delta") {
    // Append to the current (last) segment
    let last = msg.segments[msg.segments.length - 1];
    if (!last) {
      msg.segments.push({ agentId: data.agent_id || "", agentName: data.agent_name || "AI", text: "" });
      last = msg.segments[msg.segments.length - 1];
    }
    last.text = (last.text || "") + (data.text || "");
    msg.text = (msg.text || "") + (data.text || ""); // legacy fallback
    if (data.agent_name && !msg.agentName) msg.agentName = data.agent_name;
    renderHandoffChatMessages();
    const c = $("#handoff-chat-messages");
    if (c) c.scrollTop = c.scrollHeight;
  } else if (type === "done") {
    studio.handoffSessionId = data.session_id || studio.handoffSessionId;
    // Update last segment text with the server-finalised version
    if (data.text && msg.segments.length) {
      msg.segments[msg.segments.length - 1].text = data.text;
    }
    msg.agentName = data.agent_name || msg.agentName;
    if (data.current_agent_id) studio.handoffCurrentAgentId = data.current_agent_id;
    renderHandoffChatMessages();
    const h = (studio.state.handoffs || []).find((x) => x.id === studio.currentHandoffId);
    if (h) renderHandoffGraph(h);
    log(`Handoff turn complete. Active agent: ${data.agent_name || "?"}`, data);
  } else if (type === "event") {
    msg.events.push({ type: data.type || "trace", title: data.title || "", detail: data.detail || "" });
    renderHandoffChatMessages();
  } else if (type === "error") {
    msg.segments = [{ agentId: "", agentName: "System", text: `Error: ${data.detail}` }];
    msg.text = `Error: ${data.detail}`;
    renderHandoffChatMessages();
  }
}

/* ==============================================================
   SKILL VISUALIZATION PAGE — state + logic
   ============================================================== */

/* ── Dedicated state ─────────────────────────────────────── */
const sv = {
  handoffId:        null,
  sessionId:        null,
  activeAgentId:    null,
  chatMessages:     [],
  timelineEvents:   [],
  loadedSkillIds:   [],     // IDs of skills currently active in the session
  systemPromptLayers: { base: "", advertise: "", loadedSkills: [] },
  nodePositions:    {},
  zoom:             1.0,
  panX:             0,
  panY:             0,
  flashEdgeKey:     null,
  skillPreviewCache: {},    // agentId → { base_instructions, advertise_block, skills }
  toolExecEvents:   [],     // Tool Execution column entries
  sessionMessages:  [],     // Sessions column: reconstructed _cache per agent
  _callQueue:       [],     // FIFO queue of function call names for result pairing
  _pendingScriptSkill: null, // skill_name of last run_skill_script call (for auto-refresh)
  customerContext:  {},     // Shared customer context captured from skill results
  _customerFetched: false,  // True once full profile has been fetched for current customer_id
  _prevCustomerCtx: null,   // Snapshot of previous context for diff-based flash
};

/* ── Handoff selector ────────────────────────────────────── */
function populateSvHandoffSelect() {
  const sel = $("#sv-handoff-select");
  if (!sel) return;
  const curVal = sel.value;
  sel.innerHTML = '<option value="">— Select Handoff —</option>' +
    (studio.state.handoffs || []).map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
  if (curVal) sel.value = curVal;
  else if (sv.handoffId) sel.value = sv.handoffId;
  else if (studio.state.handoffs?.length) sel.value = studio.state.handoffs[0].id;
}

async function loadHandoffForViz() {
  const sel = $("#sv-handoff-select");
  const hid = sel?.value;
  if (!hid) return;
  const h = (studio.state.handoffs || []).find((x) => x.id === hid);
  if (!h) return;

  sv.handoffId = hid;
  sv.nodePositions = {};
  sv.zoom = 1.0; sv.panX = 0; sv.panY = 0;
  sv.chatMessages = [];
  sv.timelineEvents = [];
  sv.loadedSkillIds = [];
  sv.activeAgentId = null;
  sv.flashEdgeKey = null;
  sv.systemPromptLayers = { base: "", advertise: "", loadedSkills: [] };

  if (sv.sessionId) {
    fetch(`/api/handoffs/sessions/${encodeURIComponent(sv.sessionId)}`, { method: "DELETE" }).catch(() => {});
    sv.sessionId = null;
  }

  renderSvChatMessages();
  clearSvTimeline();
  renderSvSystemPrompt();
  renderSvSkillsStatus([]);
  try { renderSvGraph(h); } catch (e) { console.warn("renderSvGraph:", e); }

  // Load skill preview for the start agent
  const startId = h.start_agent_id;
  if (startId) {
    sv.activeAgentId = startId;
    updateSvActiveAgent(startId);
    await fetchAndRenderSkillPreview(startId);
  }
}

/* ── Skill Preview fetch ─────────────────────────────────── */
async function fetchAndRenderSkillPreview(agentId) {
  if (!agentId) return;
  try {
    let data = sv.skillPreviewCache[agentId];
    if (!data) {
      data = await api(`/api/agents/${encodeURIComponent(agentId)}/skill-preview`);
      sv.skillPreviewCache[agentId] = data;
    }
    sv.systemPromptLayers = {
      base:         data.base_instructions || "",
      advertise:    data.advertise_block || "",
      loadedSkills: sv.systemPromptLayers.loadedSkills || [],
    };
    renderSvSystemPrompt();
    renderSvSkillsStatus(data.skills || []);

    // Inject advertise event into timeline
    if ((data.skills || []).length) {
      addSvTimelineEvent({
        type:      "skill_advertise",
        title:     `Skills Advertised → ${data.agent_name}`,
        detail:    (data.skills || []).map((s) => s.name).join(", "),
      });
    }
  } catch (e) {
    console.warn("skill-preview fetch failed:", e);
  }
}

/* ── Send chat message ───────────────────────────────────── */
async function sendSvMessage() {
  const input = $("#sv-chat-input");
  const message = (input?.value || "").trim();
  if (!message) return;

  if (!sv.handoffId) {
    svPushSystemMsg("⚠️ Please select and load a handoff first.");
    return;
  }
  const isSaved = (studio.state.handoffs || []).some((x) => x.id === sv.handoffId);
  if (!isSaved) {
    svPushSystemMsg("⚠️ This handoff has not been saved yet. Save it from the Handoffs tab first.");
    return;
  }

  svAddChatMsg("user", message);
  input.value = "";

  sv._callQueue = [];

  sv.chatMessages.push({ role: "agent", text: "", agentName: null, time: new Date().toLocaleTimeString(), events: [], segments: [] });
  const msgIdx = sv.chatMessages.length - 1;
  renderSvChatMessages();

  try {
    const body = JSON.stringify({ handoff_id: sv.handoffId, message, session_id: sv.sessionId || null });
    const res = await fetch("/api/handoffs/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      let evType = "", evData = "";
      for (const line of lines) {
        if (line.startsWith("event: "))      { evType = line.slice(7).trim(); }
        else if (line.startsWith("data: "))  {
          evData = line.slice(6);
          if (evType && evData) {
            try { handleSvSSE(evType, JSON.parse(evData), msgIdx); } catch {}
          }
          evType = ""; evData = "";
        } else if (line === "") { evType = ""; evData = ""; }
      }
    }
  } catch (e) {
    const msg = sv.chatMessages[msgIdx];
    if (msg) { msg.segments = [{ agentId: "", agentName: "System", text: `Error: ${e.message}` }]; }
    renderSvChatMessages();
  }
}

/* ── SSE event handler ───────────────────────────────────── */
function handleSvSSE(type, data, msgIdx) {
  const msg = sv.chatMessages[msgIdx];
  const h = (studio.state.handoffs || []).find((x) => x.id === sv.handoffId);

  if (type === "active_agent") {
    sv.activeAgentId = data.agent_id;
    updateSvActiveAgent(data.agent_id);
    try { if (h) renderSvGraph(h); } catch (e) { console.warn("renderSvGraph(SSE):", e); }
    // Fetch skill preview for the newly active agent (must run even if graph fails)
    fetchAndRenderSkillPreview(data.agent_id);

  } else if (type === "handoff") {
    sv.flashEdgeKey = { from: data.from_agent_id, to: data.to_agent_id };
    if (h) renderSvGraph(h);
    addSvTimelineEvent({ type: "handoff", title: `Handoff → ${data.to_agent_name}`, detail: `from ${data.from_agent_name}` });
    setTimeout(() => { sv.flashEdgeKey = null; if (h) renderSvGraph(h); }, 1600);

  } else if (type === "event") {
    if (!msg) return;
    msg.events.push(data);

    // Classify and route to timeline
    const evType = data.type || "";
    const title  = data.title || "";

    // Read Resources & Run Scripts column — only read_skill_resource and run_skill_script
    if (evType === "function_call.complete" || evType === "function_result.complete") {
      const t = title.toLowerCase();
      if (t.includes("run_skill_script") || t.includes("read_skill_resource")) {
        addSvToolExecEvent(data);
      }
    }

    // ── Load Skills column: track load_skill calls/results only ──
    if (evType === "function_call.complete") {
      const fnMatch = title.match(/function_call\(([^)]+)\)/);
      const fnName  = fnMatch ? fnMatch[1] : title.replace(/calling\s+/i, "").trim();
      sv._callQueue.push(fnName);
      if (fnName === "load_skill") {
        let skillName = null;
        try { skillName = JSON.parse(data.detail || "{}").skill_name; } catch {}
        if (!skillName) skillName = extractSvSkillName(data);
        const ts = new Date().toLocaleTimeString();
        sv.sessionMessages.push({ type: "skill_call", funcName: fnName, skillName: skillName || fnName, args: data.detail || "", ts });
        renderSvSessionMessages();
      } else if (fnName === "run_skill_script") {
        try { sv._pendingScriptSkill = JSON.parse(data.detail || "{}").skill_name || null; }
        catch { sv._pendingScriptSkill = null; }
      }
    } else if (evType === "function_result.complete") {
      const calledName = sv._callQueue.shift() || "";
      if (calledName === "load_skill") {
        const ts = new Date().toLocaleTimeString();
        sv.sessionMessages.push({ type: "skill_result", funcName: "load_skill", content: (data.detail || "").slice(0, 400), ts });
        renderSvSessionMessages();
      } else if (calledName === "run_skill_script") {
        const scriptSkill = sv._pendingScriptSkill;
        sv._pendingScriptSkill = null;
        const READONLY_SKILLS = new Set([
          "customer_lookup", "customer_profile_summary", "identity_verification",
          "auto_insurance_quote", "auto_insurance_recommendation",
          "life_insurance_quote", "life_insurance_recommendation",
        ]);
        if (scriptSkill && !READONLY_SKILLS.has(scriptSkill) && sv.customerContext.customer_id) {
          fetchAndPopulateCustomer(sv.customerContext.customer_id, { force: true });
        }
      }
    }

    if (evType === "skill_load" || (evType === "function_call.complete" && title.includes("load_skill"))) {
      const skillName = extractSvSkillName(data);
      addSvTimelineEvent({ type: "skill_load", title: title || `load_skill: ${skillName}`, detail: data.detail });
      if (skillName) addSkillToSvPrompt(skillName);
      if (skillName && !sv.loadedSkillIds.includes(skillName)) {
        sv.loadedSkillIds.push(skillName);
        renderSvSkillsStatus(sv.skillPreviewCache[sv.activeAgentId]?.skills || []);
      }
    } else if (evType === "function_call.complete" && title.includes("run_skill_script")) {
      addSvTimelineEvent({ type: "function_execute", title, detail: data.detail });
    } else if (evType === "function_result.complete") {
      const lower = title.toLowerCase();
      if (lower.includes("load_skill") || lower.includes("run_skill") || lower.includes("read_skill")) {
        addSvTimelineEvent({ type: "function_result", title, detail: (data.detail || "").slice(0, 200) });
      }
    } else if (evType === "function_call.complete" && title.includes("read_skill_resource")) {
      addSvTimelineEvent({ type: "resource_load", title, detail: data.detail });
    } else if (evType === "handoff_transition") {
      addSvTimelineEvent({ type: "handoff", title, detail: "" });
      // Reset Load Skills and Read Resources & Run Scripts on handoff
      sv.sessionMessages = [];
      sv._callQueue = [];
      renderSvSessionMessages();
      const te = $("#sv-tool-exec-entries");
      if (te) te.innerHTML = '<div class="sv-skills-empty">read_skill_resource / run_skill_script が呼び出されるとここに追加されます。</div>';
      sv.toolExecEvents = [];
    } else if (evType === "response_complete") {
      addSvTimelineEvent({ type: "response_complete", title: "Response complete", detail: "" });
    }

    renderSvChatMessages();

  } else if (type === "clear_text") {
    if (!msg) return;
    const last = msg.segments && msg.segments[msg.segments.length - 1];
    if (last && (!data.agent_id || last.agentId === data.agent_id)) last.text = "";
    msg.text = "";
    renderSvChatMessages();

  } else if (type === "delta") {
    if (!msg) return;
    let last = msg.segments && msg.segments[msg.segments.length - 1];
    if (!last || (last.agentId && data.agent_id && last.agentId !== data.agent_id)) {
      if (!msg.segments) msg.segments = [];
      msg.segments.push({ agentId: data.agent_id || "", agentName: data.agent_name || "AI", text: "" });
      last = msg.segments[msg.segments.length - 1];
    }
    last.text = (last.text || "") + (data.text || "");
    msg.text = (msg.text || "") + (data.text || "");
    if (data.agent_name && !msg.agentName) msg.agentName = data.agent_name;
    renderSvChatMessages();
    const c = $("#sv-chat-messages");
    if (c) c.scrollTop = c.scrollHeight;

  } else if (type === "done") {
    sv.sessionId = data.session_id || sv.sessionId;
    if (!msg) return;
    if (data.text && msg.segments?.length) msg.segments[msg.segments.length - 1].text = data.text;
    msg.agentName = data.agent_name || msg.agentName;
    if (data.current_agent_id) { sv.activeAgentId = data.current_agent_id; updateSvActiveAgent(data.current_agent_id); }
    if (data.customer_context && Object.keys(data.customer_context).length) {
      const prevId = sv.customerContext.customer_id;
      // Exclude contracts/activities: those come from fresh CSV fetch and must not be
      // overwritten by the server-side session context which may be stale.
      const { contracts: _c, activities: _a, ...scalarCtx } = data.customer_context;
      sv.customerContext = { ...sv.customerContext, ...scalarCtx };
      renderSvCustomerInfo();
      const newId = sv.customerContext.customer_id;
      if (newId && newId !== prevId) fetchAndPopulateCustomer(newId);
    }
    renderSvChatMessages();
    if (h) renderSvGraph(h);

  } else if (type === "customer_context") {
    const prevId = sv.customerContext.customer_id;
    // Exclude contracts/activities: those come from fresh CSV fetch.
    const { contracts: _c, activities: _a, ...scalarCtx } = data;
    sv.customerContext = { ...sv.customerContext, ...scalarCtx };
    renderSvCustomerInfo();
    const newId = sv.customerContext.customer_id;
    if (newId && newId !== prevId) fetchAndPopulateCustomer(newId);

  } else if (type === "error") {
    if (!msg) return;
    msg.segments = [{ agentId: "", agentName: "System", text: `Error: ${data.detail}` }];
    msg.text = `Error: ${data.detail}`;
    renderSvChatMessages();
  }
}

/* ── Skill helpers ───────────────────────────────────────── */
function extractSvSkillName(ev) {
  const m = (ev.title || "").match(/load_skill[:\s]+([a-z0-9_\-]+)/i);
  if (m) return m[1];
  try { const d = JSON.parse(ev.detail || "{}"); return d.skill_id || d.skill_name || null; } catch { return null; }
}

async function addSkillToSvPrompt(skillId) {
  if (!skillId) return;
  if (sv.systemPromptLayers.loadedSkills.some((s) => s.id === skillId)) return;

  // Look up skill content from cache
  let skillContent = null, skillDisplayName = skillId;
  for (const cached of Object.values(sv.skillPreviewCache)) {
    const found = (cached.skills || []).find((s) => s.id === skillId || s.name === skillId);
    if (found) { skillContent = found.content; skillDisplayName = found.name; break; }
  }

  sv.systemPromptLayers.loadedSkills.push({
    id: skillId, name: skillDisplayName,
    content: skillContent || `[Content for skill: ${skillId}]`,
    addedAt: new Date().toLocaleTimeString(),
  });
  renderSvSystemPrompt();
}

/* ── System Prompt renderer ──────────────────────────────── */
function renderSvSystemPrompt() {
  const instrEl = $("#sv-context-instructions");
  if (!instrEl) return;
  const { base, advertise, loadedSkills } = sv.systemPromptLayers;

  // Instructions tab: base + advertise only
  let instrHtml = "";
  if (base) {
    instrHtml += `<div class="sv-prompt-section sv-prompt-base">
      <div class="sv-prompt-section-label">Base Instructions</div>
      <pre class="sv-prompt-pre">${esc(base)}</pre>
    </div>`;
    if (advertise) {
      instrHtml += `<details class="sv-prompt-section sv-prompt-advertise">
        <summary class="sv-prompt-section-label sv-label-added">+ Skills Advertised</summary>
        <pre class="sv-prompt-pre">${esc(advertise)}</pre>
      </details>`;
    }
  } else {
    instrHtml = `<div class="sv-prompt-placeholder">Load a handoff to view the system prompt augmented by Agent Skills.</div>`;
  }
  instrEl.innerHTML = instrHtml;
  instrEl.scrollTop = instrEl.scrollHeight;

  // Session tab: delegate to dedicated renderer
  renderSvSessionMessages();
}

/* ── Customer Information renderer ──────────────────────── */
/* ── Customer profile fetch ──────────────────────────────── */
async function fetchAndPopulateCustomer(customerId, { force = false } = {}) {
  if (!customerId) return;
  // Skip if we already fetched a full profile for this ID (unless forced)
  if (!force && sv._customerFetched && sv.customerContext.customer_id === customerId) return;

  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(customerId)}`);
    if (!res.ok) return;
    const profile = await res.json();
    // Merge using same shape as update_context_from_output
    const cust = profile.customer || {};
    const merged = { ...sv.customerContext, ...cust };
    if (profile.contracts?.items) {
      merged.contracts = profile.contracts.items;
      merged.contract_id = merged.contract_id || (profile.contracts.items[0]?.contract_id || "");
      merged.product_name = merged.product_name || (profile.contracts.items[0]?.product_name || "");
    }
    if (profile.recent_activities?.length) merged.activities = profile.recent_activities;
    sv.customerContext = merged;
    sv._customerFetched = true;
    renderSvCustomerInfo();
  } catch (_) {
    // silently ignore network errors
  }
}

function renderSvCustomerInfo() {
  const el = $("#sv-customer-info");
  if (!el) return;
  const ctx = sv.customerContext || {};

  function fval(key) {
    const v = ctx[key];
    return (v !== undefined && v !== null && v !== "")
      ? `<span class="sv-crm-val-text">${esc(String(v))}</span>`
      : `<span class="sv-crm-val-empty">—</span>`;
  }

  const PROFILE = [
    ["顧客ID",    "customer_id"],
    ["氏名",      "full_name"],
    ["年齢",      "age"],
    ["性別",      "gender"],
    ["都道府県",  "prefecture"],
    ["職業",      "occupation"],
    ["年収",      "annual_income"],
    ["担当者",    "assigned_agent"],
  ];

  const contracts  = Array.isArray(ctx.contracts)  ? ctx.contracts  : [];
  const activities = (Array.isArray(ctx.activities) ? [...ctx.activities] : [])
    .sort((a, b) => {
      const dateDiff = (b.activity_date || "").localeCompare(a.activity_date || "");
      if (dateDiff !== 0) return dateDiff;
      return (b.activity_id || "").localeCompare(a.activity_id || "");
    });

  // ── Contract rows ──
  const contractRows = contracts.length
    ? contracts.map((c, i) => {
        const isActive = c.contract_status === "有効";
        const premium  = c.monthly_premium ? `¥${Number(c.monthly_premium).toLocaleString()}` : "—";
        return `<tr class="sv-crm-clickable" data-crm-type="contract" data-crm-idx="${i}" title="クリックで詳細表示">
          <td>${esc(c.contract_id    || "—")}</td>
          <td>${esc(c.product_name   || "—")}</td>
          <td class="sv-crm-td-num">${premium}</td>
          <td><span class="sv-crm-status${isActive ? " sv-crm-status-active" : ""}">${esc(c.contract_status || "—")}</span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" class="sv-crm-td-empty">—</td></tr>`;

  // ── Activity rows ──
  const activityRows = activities.length
    ? activities.map((a, i) => `
        <div class="sv-crm-activity sv-crm-clickable" data-crm-type="activity" data-crm-idx="${i}" title="クリックで詳細表示">
          <div class="sv-crm-activity-meta">
            <span class="sv-crm-activity-date">${esc(a.activity_date || "")}</span>
            <span class="sv-crm-activity-type">${esc(a.activity_type || "")}</span>
          </div>
          <div class="sv-crm-activity-subject">${esc(a.subject || "")}</div>
          ${a.outcome ? `<div class="sv-crm-activity-outcome">${esc(a.outcome)}</div>` : ""}
        </div>`).join("")
    : `<div class="sv-crm-td-empty">—</div>`;

  const badge = (n) => n ? `<span class="sv-crm-badge">${n}</span>` : "";

  el.innerHTML = `
  <div class="sv-crm">
    <div class="sv-crm-section">
      <div class="sv-crm-section-head">顧客プロフィール</div>
      <div class="sv-crm-fields">
        ${PROFILE.map(([label, key]) => `
          <div class="sv-crm-row">
            <span class="sv-crm-label">${label}</span>
            <span class="sv-crm-value">${fval(key)}</span>
          </div>`).join("")}
      </div>
    </div>
    <div class="sv-crm-section">
      <div class="sv-crm-section-head">契約一覧 ${badge(contracts.length)}</div>
      <table class="sv-crm-table">
        <thead><tr><th>契約ID</th><th>商品名</th><th>月額</th><th>状態</th></tr></thead>
        <tbody>${contractRows}</tbody>
      </table>
    </div>
    <div class="sv-crm-section">
      <div class="sv-crm-section-head">商談履歴 ${badge(activities.length)}</div>
      <div class="sv-crm-activities">${activityRows}</div>
    </div>
  </div>`;

  // クリックイベント（イベント委譲）
  el.querySelectorAll(".sv-crm-clickable").forEach(row => {
    row.addEventListener("click", () => {
      const type = row.dataset.crmType;
      const idx  = parseInt(row.dataset.crmIdx, 10);
      if (type === "contract") showCrmDetailModal("contract", contracts[idx]);
      if (type === "activity") showCrmDetailModal("activity", activities[idx]);
    });
  });
}

/* ── CRM Detail Modal ────────────────────────────────────── */
function showCrmDetailModal(type, data) {
  const modal = $("#crm-detail-modal");
  const title = $("#crm-detail-title");
  const body  = $("#crm-detail-body");
  if (!modal || !data) return;

  const CONTRACT_FIELDS = [
    ["契約ID",        "contract_id"],
    ["商品ID",        "product_id"],
    ["商品名",        "product_name"],
    ["契約日",        "contract_date"],
    ["開始日",        "start_date"],
    ["終了日",        "end_date"],
    ["契約状態",      "contract_status"],
    ["月額保険料",    "monthly_premium"],
    ["保障額",        "coverage_amount"],
    ["支払方法",      "payment_method"],
    ["被保険者",      "insured_name"],
    ["受取人",        "beneficiary_name"],
    ["受取人続柄",    "beneficiary_relation"],
    ["次回見直日",    "next_review_date"],
    ["備考",          "notes"],
  ];
  const ACTIVITY_FIELDS = [
    ["活動ID",        "activity_id"],
    ["活動種別",      "activity_type"],
    ["活動日",        "activity_date"],
    ["担当者",        "agent_name"],
    ["件名",          "subject"],
    ["内容",          "content"],
    ["結果",          "outcome"],
    ["次のアクション","next_action"],
    ["次回予定日",    "next_action_date"],
  ];

  const fields = type === "contract" ? CONTRACT_FIELDS : ACTIVITY_FIELDS;
  title.textContent = type === "contract" ? "契約詳細" : "商談詳細";

  body.innerHTML = fields.map(([label, key]) => {
    if (key === "coverage_amount" && String(data.product_name || "").includes("自動車")) return "";
    let val = data[key];
    if (val === undefined || val === null || val === "") val = null;
    if (key === "monthly_premium" && val) val = `¥${Number(val).toLocaleString()}`;
    if (key === "coverage_amount"  && val) val = `¥${Number(val).toLocaleString()}`;
    return `<div class="crm-modal-row">
      <span class="crm-modal-label">${label}</span>
      <span class="crm-modal-value">${val !== null ? esc(String(val)) : '<span class="crm-modal-empty">—</span>'}</span>
    </div>`;
  }).join("");

  modal.classList.add("crm-modal-open");
}

(function initCrmModal() {
  document.addEventListener("click", e => {
    const modal = $("#crm-detail-modal");
    if (!modal) return;
    if (e.target.id === "crm-detail-modal" || e.target.closest("#crm-detail-close")) {
      modal.classList.remove("crm-modal-open");
    }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") $("#crm-detail-modal")?.classList.remove("crm-modal-open");
  });
})();

/* ── Session message renderer ────────────────────────────── */
function renderSvSessionMessages() {
  const el = $("#sv-session-entries");
  if (!el) return;
  if (!sv.sessionMessages.length) {
    el.innerHTML = '<div class="sv-sess-empty">load_skill が呼び出されるとここに追加されます。</div>';
    return;
  }
  el.innerHTML = sv.sessionMessages.map((m) => {
    switch (m.type) {
      case "skill_call": {
        let skillName = m.skillName || m.funcName;
        let argsPreview = "";
        try {
          const a = JSON.parse(m.args || "{}");
          argsPreview = Object.entries(a).map(([k, v]) => `${k}: ${v}`).join(", ");
        } catch { argsPreview = ""; }
        return `<div class="sv-sess-row sv-sess-call sv-sess-skill-call">
          <div class="sv-sess-call-head">
            <span class="sv-sess-badge sv-sess-badge-skill">📦 load_skill</span>
            <span class="sv-sess-skill-name">${esc(skillName)}</span>
          </div>
          ${argsPreview ? `<div class="sv-sess-call-args">${esc(argsPreview)}</div>` : ""}
          <span class="sv-sess-ts">${esc(m.ts)}</span>
        </div>`;
      }

      case "skill_result": {
        const content = m.content || "";
        return `<div class="sv-sess-row sv-sess-result sv-sess-skill-result">
          <details class="sv-sess-result-details">
            <summary class="sv-sess-result-summary">↳ 結果を表示</summary>
            <pre class="sv-sess-result-pre sv-sess-result-pre--full">${esc(content)}</pre>
          </details>
        </div>`;
      }

      default:
        return "";
    }
  }).join("");
  const wrap = el.closest(".sv-context-col-body");
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

/* ── Skills status panel ─────────────────────────────────── */
function renderSvSkillsStatus(skills) {
  const container = $("#sv-loaded-skills");
  if (!container) return;
  if (!skills || !skills.length) {
    container.innerHTML = '<div class="sv-skills-empty">No skills attached to this agent.</div>';
    return;
  }
  container.innerHTML = skills.map((s) => {
    const isLoaded = sv.loadedSkillIds.includes(s.id) || sv.loadedSkillIds.includes(s.name);
    return `<div class="sv-skill-card ${isLoaded ? "sv-skill-loaded-active" : "sv-skill-available"}" data-skill-id="${esc(s.id)}">
      <div class="sv-skill-card-header">
        <span class="sv-skill-dot ${isLoaded ? "dot-green" : "dot-purple"}"></span>
        <strong class="sv-skill-name">${esc(s.name)}</strong>
        <span class="sv-skill-state-badge">${isLoaded ? "Loaded" : "Available"}</span>
      </div>
      <div class="sv-skill-desc">${esc(s.description || "")}</div>
      ${(s.scripts || []).length ? `<div class="sv-skill-scripts">${s.scripts.map((sc) => `<span class="sv-script-chip">${esc(sc.name)}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("");
}

/* ── Timeline ────────────────────────────────────────────── */
function addSvTimelineEvent(event) {
  const ts = new Date().toLocaleTimeString();
  sv.timelineEvents.push({ ...event, ts });
  renderSvTimelineEntry({ ...event, ts });
}

function renderSvTimelineEntry(event) {
  const container = $("#sv-timeline");
  if (!container) return;
  const empty = container.querySelector(".sv-timeline-empty");
  if (empty) empty.remove();

  const TYPE_CFG = {
    skill_advertise:  { icon: "📢", cls: "sv-ev-advertise",  label: "Advertised" },
    skill_load:       { icon: "📦", cls: "sv-ev-load",       label: "Loaded" },
    resource_load:    { icon: "📄", cls: "sv-ev-resource",   label: "Resource" },
    function_execute: { icon: "⚙️",  cls: "sv-ev-execute",   label: "Executed" },
    function_result:  { icon: "✓",  cls: "sv-ev-result",     label: "Result" },
    handoff:          { icon: "↗",  cls: "sv-ev-handoff",    label: "Handoff" },
    response_complete:{ icon: "✓",  cls: "sv-ev-done",       label: "Done" },
    connection:       { icon: "🔗", cls: "sv-ev-connection", label: "Connect" },
  };
  const cfg = TYPE_CFG[event.type] || { icon: "●", cls: "sv-ev-info", label: event.type };

  const entry = document.createElement("div");
  entry.className = `sv-event-entry ${cfg.cls}`;
  entry.innerHTML = `
    <div class="sv-event-icon">${cfg.icon}</div>
    <div class="sv-event-body">
      <div class="sv-event-header">
        <span class="sv-event-badge ${cfg.cls}-badge">${cfg.label}</span>
        <span class="sv-event-time">${esc(event.ts)}</span>
      </div>
      <div class="sv-event-title">${esc(event.title || "")}</div>
      ${event.detail ? `<div class="sv-event-detail">${esc((event.detail || "").slice(0, 140))}</div>` : ""}
    </div>`;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

/* ── Tool Execution panel ────────────────────────────────── */
function addSvToolExecEvent(data) {
  const ts = new Date().toLocaleTimeString();
  const entry = { ...data, ts };
  sv.toolExecEvents.push(entry);
  renderSvToolExecEntry(entry);
}

function renderSvToolExecEntry(ev) {
  const container = $("#sv-tool-exec-entries");
  if (!container) return;
  const empty = container.querySelector(".sv-skills-empty");
  if (empty) empty.remove();

  const evType = ev.type || "";
  const title  = ev.title || "";
  const isCall   = evType === "function_call.complete";
  const isResult = evType === "function_result.complete";

  const isSkillLoad = title.includes("load_skill");
  const isSkillRun  = title.includes("run_skill_script");
  const isSkillRes  = title.includes("read_skill_resource");
  const isSkillRelated = isSkillLoad || isSkillRun || isSkillRes;

  let badgeText = "";
  let badgeCls  = "";
  if (isSkillLoad)     { badgeText = "load_skill"; badgeCls = "sv-tool-badge-load"; }
  else if (isSkillRun) { badgeText = "run_script";  badgeCls = "sv-tool-badge-run";  }
  else if (isSkillRes) { badgeText = "resource";    badgeCls = "sv-tool-badge-res";  }
  else if (isResult)   { badgeText = "result";      badgeCls = "sv-tool-badge-result"; }

  let detailHtml = "";
  if (ev.detail) {
    let detailText = ev.detail;
    if (isCall) {
      try { const p = JSON.parse(ev.detail); detailText = JSON.stringify(p, null, 2); } catch {}
    }
    const snippet = detailText.slice(0, 300);
    const summaryLabel = isResult ? "↳ 出力を表示" : "引数を表示";
    detailHtml = `<details class="sv-tool-exec-details">
      <summary class="sv-tool-exec-summary">${summaryLabel}</summary>
      <pre class="sv-tool-exec-detail">${esc(snippet)}${detailText.length > 300 ? "\n…" : ""}</pre>
    </details>`;
  }

  const icon = isResult ? "✓" : "⚙";
  const cls = `sv-tool-exec-entry${isSkillRelated ? " sv-tool-skill" : ""}${isResult ? " sv-tool-result" : " sv-tool-call"}`;

  const entryEl = document.createElement("div");
  entryEl.className = cls;
  entryEl.innerHTML = `
    <div class="sv-tool-exec-head">
      <span class="sv-tool-exec-icon">${icon}</span>
      <span class="sv-tool-exec-name">${esc(title)}</span>
      ${badgeText ? `<span class="sv-tool-exec-badge ${esc(badgeCls)}">${esc(badgeText)}</span>` : ""}
      <span class="sv-time-tag">${esc(ev.ts)}</span>
    </div>
    ${detailHtml}`;
  container.appendChild(entryEl);
  container.scrollTop = container.scrollHeight;
}

function clearSvTimeline() {
  const c = $("#sv-timeline");
  if (c) c.innerHTML = '<div class="sv-timeline-empty">Start a conversation to see skill events here.</div>';
  sv.timelineEvents = [];
  // also reset Tool Execution panel
  const te = $("#sv-tool-exec-entries");
  if (te) te.innerHTML = '<div class="sv-skills-empty">read_skill_resource / run_skill_script が呼び出されるとここに追加されます。</div>';
  sv.toolExecEvents = [];
  // also reset Sessions panel
  sv.sessionMessages = [];
  sv._callQueue = [];
  renderSvSessionMessages();
  // also reset Customer Information panel
  sv.customerContext = {};
  sv._customerFetched = false;
  renderSvCustomerInfo();
}

/* ── Copy session log as JSON ────────────────────────────── */
function copySvSessionLog() {
  const log = {
    session_id:           sv.sessionId,
    handoff_id:           sv.handoffId,
    active_agent_id:      sv.activeAgentId,
    customer_context:     sv.customerContext,
    chat_messages:        sv.chatMessages,
    timeline_events:      sv.timelineEvents,
    session_messages:     sv.sessionMessages,
    tool_exec_events:     sv.toolExecEvents,
    loaded_skill_ids:     sv.loadedSkillIds,
    system_prompt_layers: sv.systemPromptLayers,
    copied_at:            new Date().toISOString(),
  };
  navigator.clipboard.writeText(JSON.stringify(log, null, 2)).then(() => {
    const btn = $("#sv-chat-copy-btn");
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.title = "Copied!";
    setTimeout(() => { btn.innerHTML = orig; btn.title = "セッションログをJSONでコピー"; }, 2000);
  }).catch((e) => { console.error("Copy failed:", e); });
}

/* ── Active agent badge ──────────────────────────────────── */
function updateSvActiveAgent(agentId) {
  sv.activeAgentId = agentId;
  const agent = studio.state.agents.find((a) => a.id === agentId);
  const agentName = agent?.name || agentId || "Unknown";
  const nameEl = $("#sv-active-agent-name");
  if (nameEl) nameEl.textContent = agentName;
  const badge = $("#sv-active-agent-badge");
  if (badge) { badge.classList.add("pulse"); setTimeout(() => badge.classList.remove("pulse"), 800); }
  const ctxLabel = $("#sv-context-agent-label");
  if (ctxLabel) ctxLabel.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg> ${esc(agentName)}`;
}

/* ── Chat renderer ───────────────────────────────────────── */
function svAddChatMsg(role, text, agentName = null) {
  const time = new Date().toLocaleTimeString();
  sv.chatMessages.push({ role, text, agentName, time, events: [], segments: [] });
  renderSvChatMessages();
}

function svPushSystemMsg(text) {
  const time = new Date().toLocaleTimeString();
  sv.chatMessages.push({ role: "agent", text, agentName: "System", time, events: [], segments: [{ agentId: "", agentName: "System", text }] });
  renderSvChatMessages();
}

function renderSvChatMessages() {
  const container = $("#sv-chat-messages");
  if (!container) return;
  if (!sv.chatMessages.length) {
    container.innerHTML = `<div class="handoff-empty-chat">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
      <p>Select a handoff and start chatting to visualize Agent Skills in action.</p>
    </div>`;
    return;
  }
  container.innerHTML = "";
  sv.chatMessages.forEach((msg, idx) => {
    if (msg.role === "user") {
      const el = document.createElement("div");
      el.className = "chat-msg handoff-msg-user";
      el.innerHTML = `<div class="chat-msg-avatar user">U</div>
        <div class="chat-msg-body"><div class="chat-msg-text">${esc(msg.text)}</div></div>
        <span class="chat-msg-time">${esc(msg.time)}</span>`;
      container.appendChild(el);
    } else {
      if (msg.events?.length) {
        const tb = document.createElement("div");
        tb.className = "thinking-block";
        tb.dataset.msgIdx = idx;
        tb.innerHTML = buildHandoffThinkingProcessHtml(msg.events, idx);
        bindThinkingToggle(tb);
        container.appendChild(tb);
      }
      const segs = msg.segments?.length ? msg.segments : [{ agentId: "", agentName: msg.agentName || "AI", text: msg.text || "" }];
      segs.forEach((seg) => {
        if (!seg.text) return;
        const lbl = (seg.agentName || "AI").slice(0, 2).toUpperCase();
        const el = document.createElement("div");
        el.className = "chat-msg handoff-msg-agent";
        el.innerHTML = `<div class="chat-msg-avatar assistant">${esc(lbl)}</div>
          <div class="chat-msg-body">
            <span class="handoff-agent-tag">${esc(seg.agentName || "AI")}</span>
            <div class="chat-msg-text">${renderMarkdown(seg.text)}</div>
          </div>
          <span class="chat-msg-time">${esc(msg.time)}</span>`;
        container.appendChild(el);
      });
    }
  });
  container.scrollTop = container.scrollHeight;
}

/* ── Skill Viz Graph ─────────────────────────────────────── */
function _svDrawEdges(svg, handoff) {
  // Ensure marker defs exist (idempotent)
  if (!svg.querySelector("defs")) {
    const d = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    [["sv-arrow", "#7baeff"], ["sv-arrow-flash", "#34d399"]].forEach(([id, fill]) => {
      const m = document.createElementNS("http://www.w3.org/2000/svg", "marker");
      m.setAttribute("id", id); m.setAttribute("markerWidth", "10"); m.setAttribute("markerHeight", "10");
      m.setAttribute("refX", "8"); m.setAttribute("refY", "3"); m.setAttribute("orient", "auto");
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", "M0,0 L0,6 L9,3 z"); p.setAttribute("fill", fill);
      m.appendChild(p); d.appendChild(m);
    });
    svg.appendChild(d);
  }
  // Remove previous edges (keep defs/markers)
  svg.querySelectorAll(".ho-edge").forEach((p) => p.remove());
  // Draw edges
  (handoff.rules || []).forEach((rule) => {
    (rule.target_agent_ids || []).forEach((tid) => {
      const p1 = sv.nodePositions[rule.source_agent_id];
      const p2 = sv.nodePositions[tid];
      if (!p1 || !p2) return;
      const flash = sv.flashEdgeKey && rule.source_agent_id === sv.flashEdgeKey.from && tid === sv.flashEdgeKey.to;
      const x1 = p1.x + HO_NODE_W, y1 = p1.y + HO_NODE_H / 2;
      const x2 = p2.x,             y2 = p2.y + HO_NODE_H / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", flash ? "#34d399" : "#7baeff");
      path.setAttribute("stroke-width", flash ? "3" : "2");
      path.setAttribute("stroke-opacity", flash ? "1" : "0.85");
      path.setAttribute("marker-end", `url(#sv-arrow${flash ? "-flash" : ""})`);
      path.classList.add("ho-edge");
      if (flash) path.classList.add("ho-edge-flash");
      svg.appendChild(path);
    });
  });
}

function renderSvGraph(handoff) {
  const canvas = $("#sv-canvas");
  const svg    = $("#sv-edge-layer");
  if (!canvas || !svg) return;

  const participants = (handoff.participant_agent_ids || [])
    .map((id) => studio.state.agents.find((a) => a.id === id))
    .filter(Boolean);

  canvas.innerHTML = "";
  if (!participants.length) {
    svg.innerHTML = "";
    const ph = document.createElement("div");
    ph.className = "ho-canvas-empty";
    ph.textContent = "No participants — add agents to this handoff in the Handoffs tab.";
    canvas.appendChild(ph);
    _svUpdateViewport();
    return;
  }

  // Initialise positions (circular layout)
  const shell = document.getElementById("sv-canvas-shell");
  const W = shell ? (shell.clientWidth || 500) : 500;
  const H = shell ? (shell.clientHeight || 320) : 320;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(cx, cy) - 70;
  participants.forEach((agent, i) => {
    if (!sv.nodePositions[agent.id]) {
      const angle = (i / participants.length) * 2 * Math.PI - Math.PI / 2;
      sv.nodePositions[agent.id] = {
        x: Math.round(cx + radius * Math.cos(angle) - HO_NODE_W / 2),
        y: Math.round(cy + radius * Math.sin(angle) - HO_NODE_H / 2),
      };
    }
  });

  // SVG edges (initial draw)
  _svDrawEdges(svg, handoff);

  // Node cards
  participants.forEach((agent) => {
    const pos    = sv.nodePositions[agent.id];
    const isStart  = agent.id === handoff.start_agent_id;
    const isActive = agent.id === sv.activeAgentId;
    const initials = agent.name.split(" ").map((w) => w[0] || "").slice(0, 2).join("").toUpperCase();

    const el = document.createElement("div");
    el.className = `ho-node-card${isActive ? " active" : ""}${isStart ? " start" : ""}`;
    el.style.left = `${pos.x}px`;
    el.style.top  = `${pos.y}px`;
    el.dataset.agentId = agent.id;
    el.innerHTML = `
      <div class="ho-node-avatar">${initials}</div>
      <div class="ho-node-info">
        <strong>${esc(agent.name)}</strong>
        <div class="ho-node-meta">${esc(agent.model?.provider || "")}</div>
      </div>
      ${isStart ? '<span class="ho-node-badge ho-badge-start">START</span>' : ""}`;

    let dragging = false, ox = 0, oy = 0;
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      dragging = true;
      const r = canvas.getBoundingClientRect();
      ox = (e.clientX - r.left) / sv.zoom - pos.x;
      oy = (e.clientY - r.top)  / sv.zoom - pos.y;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      pos.x = Math.max(0, (e.clientX - r.left) / sv.zoom - ox);
      pos.y = Math.max(0, (e.clientY - r.top)  / sv.zoom - oy);
      el.style.left = `${pos.x}px`;
      el.style.top  = `${pos.y}px`;
      _svDrawEdges(svg, handoff); // edges only — don't rebuild DOM
    });
    el.addEventListener("pointerup",     () => { dragging = false; el.style.cursor = "grab"; });
    el.addEventListener("pointercancel", () => { dragging = false; el.style.cursor = "grab"; });
    canvas.appendChild(el);
  });

  // Shell pan + zoom (register once)
  if (shell && !shell.dataset.svPanBound) {
    shell.dataset.svPanBound = "1";
    let panning = false, panSX = 0, panSY = 0;
    shell.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".ho-node-card")) return;
      panning = true; panSX = e.clientX - sv.panX; panSY = e.clientY - sv.panY;
      shell.setPointerCapture(e.pointerId); shell.classList.add("panning");
    });
    shell.addEventListener("pointermove", (e) => {
      if (!panning) return;
      sv.panX = e.clientX - panSX; sv.panY = e.clientY - panSY; _svUpdateViewport();
    });
    const stopPan = () => { panning = false; shell.classList.remove("panning"); };
    shell.addEventListener("pointerup", stopPan); shell.addEventListener("pointercancel", stopPan);
    shell.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const r = shell.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const nz = Math.min(4, Math.max(0.25, sv.zoom * factor));
      sv.panX = mx - (mx - sv.panX) * (nz / sv.zoom);
      sv.panY = my - (my - sv.panY) * (nz / sv.zoom);
      sv.zoom = nz; _svUpdateViewport();
    }, { passive: false });
  }
  _svUpdateViewport();
}

function _svUpdateViewport() {
  const vp = $("#sv-viewport");
  if (!vp) return;
  vp.style.transform = `translate(${sv.panX}px, ${sv.panY}px) scale(${sv.zoom})`;
  const lbl = $("#sv-zoom-label");
  if (lbl) lbl.textContent = `${Math.round(sv.zoom * 100)}%`;
}

/* ── Panel maximize ──────────────────────────────────────── */
function initSvPanelMaximize() {
  let maximizedPanel = null;

  function getBackdrop(panel) {
    const layout = panel.closest(".sv-layout");
    if (!layout) return null;
    let bd = layout.querySelector(".sv-panel-backdrop");
    if (!bd) {
      bd = document.createElement("div");
      bd.className = "sv-panel-backdrop";
      layout.appendChild(bd);
    }
    return bd;
  }

  function maximize(panel) {
    if (maximizedPanel) restoreImmediate();
    maximizedPanel = panel;
    const grid = panel.closest(".sv-main-grid");
    const backdrop = getBackdrop(panel);
    const btn = panel.querySelector(".sv-maximize-btn");
    if (btn) {
      btn.classList.add("is-maximized");
      btn.title = "Restore";
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>';
    }
    panel.classList.add("sv-panel-maximized");
    if (grid) grid.classList.add("has-maximized");
    // Double rAF: let browser commit position, then trigger spring transition
    requestAnimationFrame(() => requestAnimationFrame(() => {
      panel.classList.add("sv-panel-expanded");
      if (backdrop) backdrop.classList.add("sv-backdrop-visible");
      // Redraw graph edges after spring settles (~450ms)
      if (panel.dataset.svPanel === "graph") {
        setTimeout(() => {
          _svUpdateViewport();
          const h = (studio.state.handoffs || []).find((x) => x.id === sv.handoffId);
          if (h) { try { _svDrawEdges($("#sv-edge-layer"), h); } catch {} }
        }, 460);
      }
    }));
  }

  function restore() {
    if (!maximizedPanel) return;
    const panel = maximizedPanel;
    maximizedPanel = null;
    const btn = panel.querySelector(".sv-maximize-btn");
    if (btn) {
      btn.classList.remove("is-maximized");
      btn.title = "Maximize";
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    }
    const grid = panel.closest(".sv-main-grid");
    const backdrop = getBackdrop(panel);
    // Trigger collapse transition
    panel.classList.remove("sv-panel-expanded");
    panel.classList.add("sv-panel-collapsing");
    if (backdrop) backdrop.classList.remove("sv-backdrop-visible");
    // Clean up after collapse animation
    panel.addEventListener("transitionend", () => {
      panel.classList.remove("sv-panel-maximized", "sv-panel-collapsing");
      if (grid) grid.classList.remove("has-maximized");
      if (panel.dataset.svPanel === "graph") {
        requestAnimationFrame(() => {
          _svUpdateViewport();
          const h = (studio.state.handoffs || []).find((x) => x.id === sv.handoffId);
          if (h) { try { _svDrawEdges($("#sv-edge-layer"), h); } catch {} }
        });
      }
    }, { once: true });
  }

  // Skip animation when switching directly between maximized panels
  function restoreImmediate() {
    if (!maximizedPanel) return;
    const panel = maximizedPanel;
    maximizedPanel = null;
    panel.classList.remove("sv-panel-maximized", "sv-panel-expanded", "sv-panel-collapsing");
    const grid = panel.closest(".sv-main-grid");
    if (grid) grid.classList.remove("has-maximized");
    const backdrop = getBackdrop(panel);
    if (backdrop) backdrop.classList.remove("sv-backdrop-visible");
  }

  // Bind buttons
  $$("#page-skillviz .sv-maximize-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const panel = btn.closest("[data-sv-panel]");
      if (!panel) return;
      if (maximizedPanel === panel) restore();
      else maximize(panel);
    });
  });

  // Esc to restore
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && maximizedPanel) restore();
  });
}

/* ── Init ────────────────────────────────────────────────── */
function initSkillViz() {
  // Context tab switching
  $$(".sv-context-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".sv-context-tab").forEach((t) => t.classList.remove("active"));
      $$(".sv-context-tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      $(`#sv-context-${tab.dataset.svPanel}`)?.classList.add("active");
    });
  });

  // Zoom controls
  $("#sv-zoom-in")?.addEventListener("click",    () => { sv.zoom = Math.min(4, sv.zoom * 1.2); _svUpdateViewport(); });
  $("#sv-zoom-out")?.addEventListener("click",   () => { sv.zoom = Math.max(0.25, sv.zoom / 1.2); _svUpdateViewport(); });
  $("#sv-zoom-reset")?.addEventListener("click", () => { sv.zoom = 1.0; sv.panX = 0; sv.panY = 0; _svUpdateViewport(); });

  // Load handoff
  $("#sv-load-handoff-btn")?.addEventListener("click", loadHandoffForViz);
  $("#sv-handoff-select")?.addEventListener("change", loadHandoffForViz);

  // Chat
  $("#sv-chat-copy-btn")?.addEventListener("click", copySvSessionLog);
  $("#sv-chat-send-btn")?.addEventListener("click", sendSvMessage);
  $("#sv-chat-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendSvMessage(); } });

  // New Thread
  $("#sv-new-thread-btn")?.addEventListener("click", () => {
    if (sv.sessionId) {
      fetch(`/api/handoffs/sessions/${encodeURIComponent(sv.sessionId)}`, { method: "DELETE" }).catch(() => {});
      sv.sessionId = null;
    }
    sv.chatMessages = []; sv.timelineEvents = []; sv.loadedSkillIds = [];
    sv.systemPromptLayers = { base: sv.systemPromptLayers.base, advertise: sv.systemPromptLayers.advertise, loadedSkills: [] };
    renderSvChatMessages(); clearSvTimeline(); renderSvSystemPrompt();
    const h = (studio.state.handoffs || []).find((x) => x.id === sv.handoffId);
    const cached = sv.skillPreviewCache[sv.activeAgentId];
    if (cached) renderSvSkillsStatus(cached.skills || []);
  });

  // Clear timeline
  $("#sv-clear-timeline-btn")?.addEventListener("click", clearSvTimeline);

  // Demo reset button — restore contracts.csv + activities.csv from _initial/ and clear panel
  $("#sv-demo-reset-btn")?.addEventListener("click", async () => {
    const btn = $("#sv-demo-reset-btn");
    if (btn) { btn.disabled = true; btn.classList.add("loading"); }
    try {
      await fetch("/api/demo/reset", { method: "POST" });
      sv.customerContext = {};
      sv._customerFetched = false;
      renderSvCustomerInfo();
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
    }
  });

  // Panel maximize/restore
  initSvPanelMaximize();

  populateSvHandoffSelect();
  // Auto-load first handoff when navigating to the page
  if (studio.state.handoffs?.length && !sv.handoffId) {
    loadHandoffForViz();
  }
}

/* ── Theme toggle ───────────────────────────────────────── */
(function initTheme() {
  if (localStorage.getItem("theme") === "light") document.body.classList.add("light");
  if (localStorage.getItem("sidebarCollapsed") === "1") document.body.classList.add("sidebar-collapsed");
})();

function bindEvents() {
  // Theme toggle
  $("#theme-toggle-btn")?.addEventListener("click", () => {
    const isLight = document.body.classList.toggle("light");
    localStorage.setItem("theme", isLight ? "light" : "dark");
  });
  // Sidebar collapse toggle
  $("#sidebar-collapse-btn")?.addEventListener("click", () => {
    const isCollapsed = document.body.classList.toggle("sidebar-collapsed");
    localStorage.setItem("sidebarCollapsed", isCollapsed ? "1" : "0");
  });
  // Nav item tooltips (fixed to body, bypasses overflow-x:hidden on #sidebar)
  (function initNavTooltip() {
    const tip = document.createElement("div");
    tip.id = "nav-tooltip";
    document.body.appendChild(tip);
    let hideTimer = null;
    document.querySelectorAll(".nav-item[data-label]").forEach(el => {
      el.addEventListener("mouseenter", e => {
        if (!document.body.classList.contains("sidebar-collapsed")) return;
        clearTimeout(hideTimer);
        const rect = el.getBoundingClientRect();
        tip.textContent = el.dataset.label;
        tip.style.left = rect.right + 10 + "px";
        tip.style.top = rect.top + rect.height / 2 + "px";
        tip.style.opacity = "1";
      });
      el.addEventListener("mouseleave", () => {
        hideTimer = setTimeout(() => { tip.style.opacity = "0"; }, 80);
      });
    });
  })();

  $("#new-agent-btn").addEventListener("click", newAgent);
  $("#add-mcp-btn").addEventListener("click", () => $("#mcp-container").appendChild(buildMcpRow()));

  // Agent Skills: picker open/close
  $("#skill-picker-trigger").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#skill-picker").classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#skill-picker")) {
      $("#skill-picker")?.classList.remove("open");
    }
  });

  // Agent Skills: Add / Remove / Detail
  $("#agent-skill-add-btn").addEventListener("click", () => {
    const newIds = Array.from($$("#skill-picker-options input:checked")).map((cb) => cb.value);
    if (!newIds.length) return;
    $("#skill-picker").classList.remove("open");
    const current = Array.from($$("#agent-skill-list .agent-skill-item")).map((el) => el.dataset.skillId);
    const merged = [...current, ...newIds.filter((id) => !current.includes(id))];
    populateAgentSkillSection(merged);
    updateAgentHeader(collectAgentForm());
  });
  $("#agent-skill-list").addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".agent-skill-remove-btn");
    if (removeBtn) {
      const current = Array.from($$("#agent-skill-list .agent-skill-item")).map((el) => el.dataset.skillId);
      populateAgentSkillSection(current.filter((id) => id !== removeBtn.dataset.skillId));
      updateAgentHeader(collectAgentForm());
      return;
    }
    const item = e.target.closest(".agent-skill-item");
    if (item) openSkillModal(item.dataset.skillId);
  });
  $("#save-agent-btn").addEventListener("click", saveAgent);
  $("#delete-agent-btn").addEventListener("click", deleteAgent);
  // Agent dropdown selector
  $("#agent-select")?.addEventListener("change", () => {
    const id = $("#agent-select").value;
    if (!id) { newAgent(); return; }
    const a = (studio.state?.agents || []).find(x => x.id === id);
    if (a) loadAgent(a);
  });
  // Chat send
  $("#chat-send-btn").addEventListener("click", testAgent);
  $("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); testAgent(); } });
  // New thread
  $("#new-thread-btn").addEventListener("click", clearChat);
  // Azure model fetch
  $("#btn-fetch-models").addEventListener("click", fetchAzureModels);
  $("#model-name").addEventListener("change", handleModelSelectChange);
  // Auto-fetch when provider changes to azure-openai
  $("#provider").addEventListener("change", () => {
    if ($("#provider").value === "azure-openai") fetchAzureModels();
  });
  // Skills
  $("#upload-skill-btn").addEventListener("click", uploadSkill);
  $("#script-skill-select").addEventListener("change", updateScriptNames);
  $("#run-script-btn").addEventListener("click", runSelectedScript);
  // Workflow
  $("#add-node-btn").addEventListener("click", addNode);
  $("#add-edge-btn").addEventListener("click", addEdge);
  $("#save-workflow-btn").addEventListener("click", saveWorkflow);
  $("#test-workflow-btn").addEventListener("click", testWorkflow);
  // Console
  $("#clear-console-btn").addEventListener("click", () => ($("#activity-console").textContent = "Console cleared."));

  // Handoffs
  $("#new-handoff-btn").addEventListener("click", newHandoff);
  $("#save-handoff-btn").addEventListener("click", saveHandoff);
  $("#delete-handoff-btn").addEventListener("click", deleteHandoff);
  $("#add-participant-btn").addEventListener("click", addHandoffParticipant);
  // Remove old single-select keydown handler (now using checkboxes)
  $("#add-rule-btn").addEventListener("click", addHandoffRule);
  // Mark dirty on form field changes
  ["#handoff-name", "#handoff-description", "#handoff-termination-keyword"].forEach(sel => {
    $(sel)?.addEventListener("input", markHandoffDirty);
  });
  $("#handoff-autonomous")?.addEventListener("change", markHandoffDirty);
  $("#handoff-start-agent")?.addEventListener("change", markHandoffDirty);
  // Handoff workflow select dropdown
  $("#handoff-select")?.addEventListener("change", () => {
    const id = $("#handoff-select").value;
    if (!id) { newHandoff(); return; }
    const h = (studio.state.handoffs || []).find(x => x.id === id);
    if (h) loadHandoff(h);
  });
  // Toggle Test Handoff panel
  $("#ho-toggle-chat-btn")?.addEventListener("click", () => {
    const grid = $("#ho-main-grid");
    const label = $("#ho-toggle-chat-label");
    const isHidden = grid.classList.toggle("chat-hidden");
    if (label) label.textContent = isHidden ? "Test ▶" : "Test ◀";
  });
  // ResizeObserver: redraw edges when graph panel resizes (e.g. chat panel toggle)
  const _hoShellEl = document.querySelector(".handoff-viz-panel .ho-canvas-shell");
  if (_hoShellEl && window.ResizeObserver) {
    let _hoEdgeRedrawTimer = null;
    new ResizeObserver(() => {
      clearTimeout(_hoEdgeRedrawTimer);
      _hoEdgeRedrawTimer = setTimeout(() => {
        const hId = studio.currentHandoffId;
        const hObj = hId ? (studio.state?.handoffs || []).find(x => x.id === hId) : null;
        if (!hObj) return;
        const svgEl = $("#ho-edge-layer");
        if (svgEl) drawHoEdges(svgEl, hObj);
      }, 30);
    }).observe(_hoShellEl);
  }
  // Handoff chat
  $("#handoff-chat-send-btn").addEventListener("click", sendHandoffMessage);
  $("#handoff-chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendHandoffMessage(); } });
  $("#handoff-new-thread-btn").addEventListener("click", () => {
    if (studio.handoffSessionId) {
      fetch(`/api/handoffs/sessions/${encodeURIComponent(studio.handoffSessionId)}`, { method: "DELETE" }).catch(() => {});
    }
    clearHandoffChat();
    const h = (studio.state.handoffs || []).find((x) => x.id === studio.currentHandoffId);
    if (h) updateHandoffAgentStrip(h);
  });
  // Handoff graph zoom / layout controls
  $("#ho-zoom-in-btn")?.addEventListener("click", () => {
    studio.hoZoom = Math.min(4, studio.hoZoom * 1.2);
    updateHoViewport();
  });
  $("#ho-zoom-out-btn")?.addEventListener("click", () => {
    studio.hoZoom = Math.max(0.25, studio.hoZoom / 1.2);
    updateHoViewport();
  });
  $("#ho-zoom-reset-btn")?.addEventListener("click", () => {
    studio.hoZoom = 1.0; studio.hoPanX = 0; studio.hoPanY = 0;
    updateHoViewport();
  });
  $("#ho-layout-btn").addEventListener("click", () => {
    studio.hoNodePositions = {};
    const h = (studio.state.handoffs || []).find((x) => x.id === studio.currentHandoffId) || hoFormSnapshot();
    resetHoLayout(h);
  });
}

/* ==============================================================
   INIT
   ============================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  initRouter();
  initAgentTabs();
  initInspectorTabs();
  initInspectorToggle();
  bindEvents();
  initSkillViz();
  await refreshState();
});
