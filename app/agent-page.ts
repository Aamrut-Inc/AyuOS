import { layout } from "./pages";

// The "Ask AI" screen: chat with the health assistant about this Mac's data.
// All rendering happens here in the page; the server streams events from
// /api/agent/turn. Answers are markdown, rendered after HTML-escaping.

const STYLE = `
  .agent { display: grid; grid-template-columns: 230px 1fr; gap: 16px; min-height: 70vh; }
  @media (max-width: 760px) { .agent { grid-template-columns: 1fr; } .agent-side { order: 2; } }
  .agent-side .card { padding: 12px; }
  .conv-list { list-style: none; margin: 8px 0 0; padding: 0; max-height: 55vh; overflow: auto; }
  .conv-list li { display: flex; align-items: center; gap: 4px; }
  .conv-list a { flex: 1; display: block; padding: 6px 8px; border-radius: 8px; color: var(--text); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv-list a.active, .conv-list a:hover { background: var(--brand-soft); text-decoration: none; }
  .conv-list button { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 13px; }
  .chat { display: flex; flex-direction: column; }
  .messages { flex: 1; display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px; }
  .msg { max-width: 92%; padding: 12px 16px; border-radius: 14px; line-height: 1.55; }
  .msg.user { align-self: flex-end; background: var(--brand); color: #fff; border-bottom-right-radius: 4px; white-space: pre-wrap; }
  .msg.bot { align-self: flex-start; background: var(--card); border: 1px solid var(--line); border-bottom-left-radius: 4px; box-shadow: var(--shadow); }
  .msg.bot.urgent { border-color: var(--bad); background: var(--bad-soft); }
  .msg.bot.error { border-color: var(--warn); background: var(--warn-soft); }
  .msg p { margin: 0 0 8px; } .msg p:last-child { margin-bottom: 0; }
  .msg ul { margin: 4px 0 8px; padding-left: 20px; }
  .msg h3, .msg h4 { margin: 8px 0 4px; font-size: 15px; }
  .msg code, .msg pre { font: 12px ui-monospace, Menlo, monospace; background: var(--off-soft); border-radius: 6px; }
  .msg code { padding: 1px 5px; } .msg pre { padding: 10px; overflow: auto; white-space: pre; }
  .status { align-self: flex-start; color: var(--muted); font-size: 13px; display: flex; gap: 8px; align-items: center; }
  .status::before { content: ""; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--brand); border-right-color: transparent; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  details.extra { margin-top: 10px; font-size: 13px; color: var(--muted); }
  details.extra summary { cursor: pointer; }
  details.extra ul { padding-left: 18px; }
  .msg-actions { display: flex; gap: 6px; margin-top: 10px; }
  .msg-actions button { border: 1px solid var(--line); background: none; border-radius: 8px; padding: 2px 8px; cursor: pointer; color: var(--muted); }
  .msg-actions button.chosen { background: var(--brand-soft); color: var(--brand); border-color: var(--brand); }
  .composer { display: flex; gap: 8px; position: sticky; bottom: 0; background: var(--bg); padding: 8px 0; }
  .composer textarea { flex: 1; resize: none; min-height: 48px; max-height: 160px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line);
    background: var(--card); color: var(--text); font: inherit; }
  .composer textarea:focus { outline: 2px solid var(--brand-soft); border-color: var(--brand); }
  .suggestions { display: flex; flex-wrap: wrap; gap: 8px; }
  .suggestions button { border: 1px solid var(--line); background: var(--card); color: var(--text); border-radius: 999px; padding: 6px 12px; cursor: pointer; font: inherit; font-size: 13px; }
  .suggestions button:hover { border-color: var(--brand); }
  .settings label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
  .settings input, .settings select { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: inherit; }
  .fine { font-size: 12px; color: var(--muted); }
  .fact { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
  .fact span { flex: 1; }
`;

const SCRIPT = String.raw`
const $ = (s) => document.querySelector(s);
const messages = $("#messages");
let conversationId = new URLSearchParams(location.search).get("c");
let busy = false;

function esc(t) { return String(t ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }

// Minimal markdown: headings, bold, italics, code, links, lists, paragraphs.
function md(text) {
  const lines = esc(text).split("\n");
  let html = "", list = false, para = [];
  const inline = (s) => s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
  const flush = () => { if (para.length) { html += "<p>" + inline(para.join("<br>")) + "</p>"; para = []; } };
  for (const line of lines) {
    const item = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    if (item) { flush(); if (!list) { html += "<ul>"; list = true; } html += "<li>" + inline(item[1]) + "</li>"; continue; }
    if (list) { html += "</ul>"; list = false; }
    if (head) { flush(); html += "<h4>" + inline(head[2]) + "</h4>"; continue; }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush(); if (list) html += "</ul>";
  return html;
}

const TOOL_LABEL = {
  search_lab_tests: "Lab test search", get_lab_results: "Lab results", get_latest_lab: "Latest lab result", list_flagged_labs: "Flagged lab results",
  get_vitals: "Vital signs", get_latest_vital: "Latest vital sign", search_conditions: "Diagnoses", list_conditions: "Problem list",
  search_medications: "Prescriptions", list_prescriptions: "Prescriptions", list_medication_statements: "Reported medications",
  list_allergies: "Allergies", list_immunizations: "Vaccines", list_procedures: "Procedures", list_encounters: "Visits",
  list_reports: "Reports", get_report: "Report", search_notes: "Clinical notes", get_note_excerpt: "Clinical note",
  get_family_history: "Family history", get_other_records: "Other records", get_sleep_nights: "Sleep", get_sleep_sessions: "Sleep sessions",
  get_recovery_daily: "Readiness / recovery", list_workouts: "Workouts", get_metric_daily: "Daily wearable values",
  get_metric_latest: "Latest wearable value", get_samples: "Wearable samples", list_available_metrics: "Wearable metrics",
  get_data_freshness: "Data sources and sync status", get_profile: "Profile", get_data_inventory: "Data inventory"
};

function sourcesHtml(citations) {
  if (!citations) return "";
  const data = citations.data || [], web = citations.web || [];
  if (!data.length && !web.length) return "";
  const items = data.map((d) => {
    const s = d.searched || {};
    const label = TOOL_LABEL[d.tool] || (d.tool === "analysis" ? "Analysis" : d.tool);
    return "<li>" + esc(label) + (s.date_range ? " · " + esc(s.date_range) : "") + (s.sources && s.sources.length ? " · " + esc(s.sources.join("; ")) : "") + (d.rows != null ? " · " + d.rows + " rows" : "") + "</li>";
  }).concat(web.map((w) => '<li><a href="' + esc(w.url) + '" target="_blank" rel="noopener noreferrer">' + esc(w.title || w.url) + "</a> (accessed " + esc(w.accessed) + ")</li>"));
  return '<details class="extra"><summary>Sources</summary><ul>' + items.join("") + "</ul></details>";
}

function calcHtml(calc) {
  if (!calc || !calc.code) return "";
  const q = (calc.code.queries || []).map((x) => "-- " + x.name + "\n" + x.sql).join("\n\n");
  return '<details class="extra"><summary>Show how this was calculated</summary>' +
    (calc.plan ? "<p>" + esc(calc.plan.restated_question || "") + " · " + esc((calc.plan.time_window || {}).label || "") + " · method: " + esc(calc.plan.method || "") + "</p>" : "") +
    "<pre>" + esc(q) + "</pre><pre>" + esc(calc.code.python || "") + "</pre></details>";
}

function addUser(text) {
  const el = document.createElement("div"); el.className = "msg user"; el.textContent = text; messages.appendChild(el); scroll();
}
function addBot(text, opts = {}) {
  const el = document.createElement("div");
  el.className = "msg bot" + (opts.kind ? " " + opts.kind : "");
  el.innerHTML = md(text) + sourcesHtml(opts.citations) + calcHtml(opts.calculation);
  if (opts.turnId && opts.kind !== "error") {
    const actions = document.createElement("div"); actions.className = "msg-actions";
    for (const [rating, label] of [["up", "👍"], ["down", "👎"]]) {
      const b = document.createElement("button"); b.textContent = label; b.title = rating === "up" ? "Helpful" : "Not helpful";
      b.onclick = async () => {
        actions.querySelectorAll("button").forEach((x) => x.classList.remove("chosen")); b.classList.add("chosen");
        await fetch("/api/agent/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turn_id: opts.turnId, rating }) });
      };
      actions.appendChild(b);
    }
    el.appendChild(actions);
  }
  messages.appendChild(el); scroll(); return el;
}
function scroll() { window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }

function setBusy(on) {
  busy = on; $("#send").hidden = on; $("#stop").hidden = !on; $("#input").disabled = on;
  if (!on) $("#input").focus();
}

async function ask(text) {
  if (busy || !text.trim()) return;
  $("#welcome")?.remove();
  addUser(text); $("#input").value = "";
  const status = document.createElement("div"); status.className = "status"; status.textContent = "Sending..."; messages.appendChild(status); scroll();
  setBusy(true);
  try {
    const res = await fetch("/api/agent/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation_id: conversationId, message: text }) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "The assistant isn't available."); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const ev = JSON.parse(data.slice(6));
        if (ev.conversation_id && ev.conversation_id !== conversationId) { conversationId = ev.conversation_id; history.replaceState(null, "", "/agent?c=" + conversationId); }
        if (ev.type === "status") status.textContent = ev.text;
        else if (ev.type === "answer") { status.remove(); addBot(ev.text, { citations: ev.citations, calculation: ev.calculation, turnId: ev.turn_id, kind: ev.lane === "urgent" ? "urgent" : "" }); }
        else if (ev.type === "clarify") { status.remove(); addBot(ev.text, { turnId: ev.turn_id }); }
        else if (ev.type === "error") { status.remove(); addBot(ev.message, { kind: "error" }); }
      }
    }
  } catch (e) {
    addBot(e.message || "Something went wrong.", { kind: "error" });
  } finally {
    status.remove(); setBusy(false); loadConversations();
  }
}

async function loadConversations() {
  const res = await fetch("/api/agent/conversations"); if (!res.ok) return;
  const { conversations } = await res.json();
  const list = $("#conversations"); list.innerHTML = "";
  for (const c of conversations) {
    const li = document.createElement("li");
    li.innerHTML = '<a href="/agent?c=' + esc(c.id) + '"' + (c.id === conversationId ? ' class="active"' : "") + ' title="' + esc(c.title) + '">' + esc(c.title || "Conversation") + '</a><button title="Delete">✕</button>';
    li.querySelector("button").onclick = async () => {
      if (!confirm("Delete this conversation and its logs?")) return;
      await fetch("/api/agent/conversations/" + c.id, { method: "DELETE" });
      if (c.id === conversationId) location.href = "/agent"; else loadConversations();
    };
    list.appendChild(li);
  }
}

async function loadConversation() {
  if (!conversationId) return;
  const res = await fetch("/api/agent/conversations/" + conversationId); if (!res.ok) return;
  const { turns } = await res.json();
  if (turns.length) $("#welcome")?.remove();
  for (const t of turns) {
    if (t.role === "user") addUser(t.text);
    else addBot(t.text, { citations: t.citations, calculation: t.calculation, turnId: t.id, kind: t.status === "urgent" ? "urgent" : t.status === "failed" ? "error" : "" });
  }
}

async function loadSettings() {
  const res = await fetch("/api/agent/settings");
  const s = await res.json();
  if (!res.ok) { $("#setup").hidden = false; $("#setup-text").textContent = s.error || "The assistant isn't available."; return; }
  $("#key-status").textContent = s.keys.openai ? "Saved (" + s.keys.openai + ")" : "Not set";
  $("#setup").hidden = Boolean(s.keys.openai || s.models.fast.provider !== "openai");
  $("#model-fast").value = s.models.fast.model; $("#model-strong").value = s.models.strong.model;
  $("#tz").value = s.timezone.source === "user" ? s.timezone.value : "";
  $("#tz").placeholder = "Follow this Mac (" + s.timezone.system + ")";
  $("#cost").value = s.cost_cap_usd;
}

async function saveSettings(extra = {}) {
  const body = { models: { fast: { provider: "openai", model: $("#model-fast").value.trim() }, strong: { provider: "openai", model: $("#model-strong").value.trim() } },
                 timezone: $("#tz").value.trim() || null, cost_cap_usd: Number($("#cost").value) || 0.5, ...extra };
  const res = await fetch("/api/agent/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json();
  $("#settings-msg").textContent = res.ok ? "Saved." : out.error;
  if (res.ok) loadSettings();
}

async function loadModels() {
  const res = await fetch("/api/agent/models"); const out = await res.json();
  $("#models-list").innerHTML = res.ok ? out.models.map((m) => "<option value='" + esc(m) + "'>").join("") : "";
  $("#settings-msg").textContent = res.ok ? out.models.length + " models available to your key." : out.error;
}

async function loadMemory() {
  const res = await fetch("/api/agent/memory"); if (!res.ok) return;
  const { facts } = await res.json();
  $("#facts").innerHTML = facts.length ? "" : '<p class="fine">Nothing remembered yet.</p>';
  for (const f of facts) {
    const row = document.createElement("div"); row.className = "fact";
    row.innerHTML = "<span>" + esc(f.fact_text) + ' <span class="fine">(' + esc(f.category.replace("_", " ")) + ')</span></span><button class="btn secondary">Delete</button>';
    row.querySelector("button").onclick = async () => { await fetch("/api/agent/memory/" + f.id, { method: "DELETE" }); loadMemory(); };
    $("#facts").appendChild(row);
  }
}

$("#form").onsubmit = (e) => { e.preventDefault(); ask($("#input").value); };
$("#input").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask($("#input").value); } };
$("#stop").onclick = () => conversationId && fetch("/api/agent/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation_id: conversationId }) });
$("#new").onclick = () => { location.href = "/agent"; };
document.querySelectorAll(".suggestions button").forEach((b) => b.onclick = () => ask(b.textContent));
$("#save-key").onclick = () => saveSettings({ openai_api_key: $("#key").value.trim() }).then(() => { $("#key").value = ""; });
$("#setup-save").onclick = () => saveSettings({ openai_api_key: $("#setup-key").value.trim() }).then(() => { $("#setup-key").value = ""; });
$("#save-settings").onclick = () => saveSettings();
$("#list-models").onclick = (e) => { e.preventDefault(); loadModels(); };
$("#settings-toggle").addEventListener("toggle", (e) => { if (e.target.open) loadMemory(); });
$("#forget-all").onclick = async () => { if (confirm("Forget everything the assistant remembered about you?")) { await fetch("/api/agent/memory", { method: "DELETE" }); loadMemory(); } };

loadSettings(); loadConversations(); loadConversation(); $("#input").focus();
`;

export function agentPage(): string {
  const body = `
    <style>${STYLE}</style>
    <h1>Ask about your health</h1>
    <p class="lede">Ask questions about your hospital records, lab results and wearable data. Your data stays in the database on this Mac;
      to answer, the question and the relevant parts of your data (never your name, birth date or ID numbers) are sent to OpenAI.
      This is information, not medical advice. In an emergency, contact your local emergency services.</p>

    <div class="alert warn" id="setup" hidden>
      <p id="setup-text" style="margin: 0 0 8px;">To start, add your OpenAI API key. It's stored in this Mac's Keychain and only sent to OpenAI.</p>
      <div class="row"><input id="setup-key" type="password" placeholder="sk-..." style="flex:1; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line);">
      <button class="btn" id="setup-save">Save key</button></div>
    </div>

    <div class="agent">
      <aside class="agent-side">
        <div class="card">
          <button class="btn" id="new" style="width:100%">New conversation</button>
          <ul class="conv-list" id="conversations"></ul>
        </div>
        <details class="card settings" id="settings-toggle">
          <summary style="cursor:pointer; font-weight:600;">Settings</summary>
          <label>OpenAI API key · <span id="key-status"></span></label>
          <div class="row"><input id="key" type="password" placeholder="sk-..."><button class="btn secondary" id="save-key">Save</button></div>
          <label>Fast model (routing, lookups)</label><input id="model-fast" list="models-list">
          <label>Strong model (analysis, explanations)</label><input id="model-strong" list="models-list">
          <datalist id="models-list"></datalist>
          <p class="fine"><a href="#" id="list-models">List models my key can use</a></p>
          <label>Time zone</label><input id="tz" placeholder="Follow this Mac">
          <label>Cost limit per answer (US$)</label><input id="cost" type="number" step="0.05" min="0.05" max="20">
          <p style="margin-top:10px"><button class="btn" id="save-settings">Save settings</button></p>
          <p class="fine" id="settings-msg"></p>
          <label>What the assistant remembers about you</label>
          <div id="facts"></div>
          <p><button class="btn secondary" id="forget-all">Forget everything</button></p>
        </details>
      </aside>

      <section class="chat">
        <div class="messages" id="messages">
          <div id="welcome" class="card">
            <p style="margin-top:0">Try asking:</p>
            <div class="suggestions">
              <button>What was my last LDL?</button>
              <button>How did I sleep last night?</button>
              <button>Has my resting heart rate gone up over the last 3 months?</button>
              <button>What medications am I prescribed?</button>
              <button>Do short nights lower my HRV the next day?</button>
              <button>When did my devices last sync?</button>
            </div>
          </div>
        </div>
        <form class="composer" id="form">
          <textarea id="input" rows="2" placeholder="Ask about your health data… (Enter to send, Shift+Enter for a new line)"></textarea>
          <button class="btn" id="send" type="submit">Send</button>
          <button class="btn secondary" id="stop" type="button" hidden>Stop</button>
        </form>
      </section>
    </div>`;
  return layout("Ask AI · AyuOS", body, SCRIPT, "/agent");
}
