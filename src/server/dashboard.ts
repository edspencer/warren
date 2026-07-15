// src/server/dashboard.ts — the self-contained static dashboard SPA.
//
// Exported as a string constant (not a file on disk) so it works identically
// from `src` (tsx) and `dist` (compiled) with no @fastify/static dependency and
// no runtime file reads. Vanilla JS + fetch + inline CSS — dependency-light by
// design (see the dashboard deliverable). Dark-mode-friendly.
//
// Auth: on load the SPA calls the unauthenticated GET /api/auth-mode. In `jwt`
// mode it reads a token from localStorage (prompting if absent / on any 401) and
// sends it as `Authorization: Bearer <token>` on every /api/* call.

export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Warren — review dashboard</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1e222b; --border: #2a2f3a;
    --text: #e6e9ef; --muted: #9aa4b2; --accent: #7c9cff; --accent-2: #5b7cfa;
    --crit: #ff6b6b; --high: #ff9f43; --med: #f6c945; --low: #4dabf7; --nit: #868e96;
    --ok: #37b24d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header {
    display: flex; align-items: center; gap: 16px; padding: 14px 22px;
    border-bottom: 1px solid var(--border); background: var(--panel);
    position: sticky; top: 0; z-index: 10;
  }
  header .brand { font-weight: 700; font-size: 16px; letter-spacing: .2px; }
  header .brand small { color: var(--muted); font-weight: 400; margin-left: 6px; }
  nav { display: flex; gap: 4px; margin-left: 8px; }
  nav button {
    background: transparent; color: var(--muted); border: 0; padding: 7px 12px;
    border-radius: 8px; cursor: pointer; font-size: 14px;
  }
  nav button.active { background: var(--panel-2); color: var(--text); }
  nav button:hover { color: var(--text); }
  header .spacer { flex: 1; }
  header .mode { color: var(--muted); font-size: 12px; }
  main { padding: 22px; max-width: 1100px; margin: 0 auto; }
  h2 { margin: 4px 0 16px; font-size: 18px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 16px;
  }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .4px; }
  .card .value { font-size: 26px; font-weight: 700; margin-top: 4px; }
  .panel {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px; margin-top: 18px;
  }
  .panel h3 { margin: 0 0 12px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-weight: 600; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: var(--panel-2); }
  .badge {
    display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
    font-weight: 700; text-transform: uppercase; letter-spacing: .3px;
  }
  .sev-critical { background: rgba(255,107,107,.18); color: var(--crit); }
  .sev-high { background: rgba(255,159,67,.18); color: var(--high); }
  .sev-medium { background: rgba(246,201,69,.18); color: var(--med); }
  .sev-low { background: rgba(77,171,247,.18); color: var(--low); }
  .sev-nit { background: rgba(134,142,150,.2); color: var(--nit); }
  .bars { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: grid; grid-template-columns: 74px 1fr 40px; align-items: center; gap: 10px; }
  .bar-track { background: var(--panel-2); border-radius: 6px; height: 16px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent); border-radius: 6px; min-width: 2px; }
  .series { position: relative; display: flex; align-items: flex-end; gap: 4px; height: 132px; padding: 6px 0 22px; }
  .series .col { position: relative; flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; min-width: 8px; }
  .series .col .stalk { width: 70%; background: var(--accent-2); border-radius: 4px 4px 0 0; min-height: 3px; }
  .series .col .day { position: absolute; bottom: -18px; color: var(--muted); font-size: 10px; transform: rotate(-45deg); white-space: nowrap; }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .back { cursor: pointer; color: var(--accent); margin-bottom: 12px; display: inline-block; }
  .finding { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; background: var(--panel-2); }
  .finding .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .finding .title { font-weight: 600; }
  .finding .loc { margin-top: 4px; }
  .finding .body { margin-top: 8px; white-space: pre-wrap; }
  .md { white-space: pre-wrap; }
  .empty { color: var(--muted); padding: 20px; text-align: center; }
  .token-bar { display: none; gap: 8px; align-items: center; }
  .token-bar input { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 8px; width: 260px; }
  .token-bar button { background: var(--accent-2); color: #fff; border: 0; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
  .banner { background: rgba(255,107,107,.14); border: 1px solid var(--crit); color: var(--crit); padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; display: none; }

  /* ---------- Responsive / mobile (patterns mirror Paddock PR #203) ---------- */
  /* Safe-area chrome under viewport-fit=cover; max(fallback, env) keeps the
     original padding on non-notched devices where the inset resolves to 0. */
  header {
    padding-top: max(14px, env(safe-area-inset-top));
    padding-left: max(22px, env(safe-area-inset-left));
    padding-right: max(22px, env(safe-area-inset-right));
  }
  main {
    padding-left: max(22px, env(safe-area-inset-left));
    padding-right: max(22px, env(safe-area-inset-right));
    padding-bottom: max(22px, env(safe-area-inset-bottom));
  }
  /* Kill the grey tap-flash box on touch. */
  button, a, tr.clickable { -webkit-tap-highlight-color: transparent; }

  @media (max-width: 640px) {
    /* iOS zooms whenever a focused form control has computed font-size < 16px
       (which would also break the layout). Our token input is 14px, so bump
       form controls to 16px on small screens — the accessible fix, NOT
       user-scalable=no. !important so it wins over any element/utility rule. */
    input, textarea, select { font-size: 16px !important; }

    header {
      flex-wrap: wrap; gap: 10px 12px;
      padding: max(10px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) 10px max(14px, env(safe-area-inset-left));
    }
    header .brand { font-size: 15px; }
    header .brand small { display: none; }
    header .spacer { display: none; }
    header .mode { order: 2; margin-left: auto; }
    nav { order: 3; width: 100%; margin-left: 0; gap: 6px; }
    nav button { flex: 1; min-height: 40px; padding: 9px 6px; }
    .token-bar { order: 4; width: 100%; }
    .token-bar input { flex: 1 1 auto; width: auto; min-width: 0; }

    main { padding: 16px max(14px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
    h2 { font-size: 17px; }
    .cards { grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; }
    .card { padding: 12px 13px; }
    .card .value { font-size: 22px; }
    .panel { padding: 13px; }
    .bar-row { grid-template-columns: 64px 1fr 32px; gap: 8px; }
    .series { height: 118px; }

    /* Tables → stacked cards: each row a card, each cell a label/value line
       (label supplied via data-label; see renderRepos/renderReviews). */
    thead { display: none; }
    table, tbody, tr, td { display: block; width: 100%; }
    tbody tr {
      border: 1px solid var(--border); border-radius: 10px;
      background: var(--panel-2); padding: 4px 12px; margin-bottom: 10px;
    }
    tr.clickable:hover td, tr.clickable:active td { background: transparent; }
    td {
      border: 0; padding: 7px 0; font-size: 13px;
      display: flex; gap: 12px; justify-content: space-between; align-items: baseline;
    }
    td + td { border-top: 1px solid var(--border); }
    td::before {
      content: attr(data-label); color: var(--muted);
      font-size: 11px; text-transform: uppercase; letter-spacing: .3px;
      flex: 0 0 auto; white-space: nowrap;
    }
    td.empty { display: block; text-align: center; padding: 18px 0; }
    td.empty::before { content: none; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">🐇 Warren <small>review dashboard</small></div>
  <nav id="nav">
    <button data-view="overview" class="active">Overview</button>
    <button data-view="repos">Repos</button>
    <button data-view="reviews">Reviews</button>
  </nav>
  <div class="spacer"></div>
  <div class="token-bar" id="tokenBar">
    <input id="tokenInput" type="password" placeholder="Bearer token" />
    <button id="tokenSave">Save</button>
  </div>
  <div class="mode" id="modeLabel"></div>
</header>
<main>
  <div class="banner" id="banner"></div>
  <div id="app"></div>
</main>
<script>
const state = { mode: "none", view: "overview" };
const app = document.getElementById("app");
const banner = document.getElementById("banner");

function token() { return localStorage.getItem("warren_token") || ""; }
function setToken(t) { if (t) localStorage.setItem("warren_token", t); else localStorage.removeItem("warren_token"); }

async function api(path) {
  const headers = {};
  if (state.mode === "jwt" && token()) headers["Authorization"] = "Bearer " + token();
  const res = await fetch(path, { headers });
  if (res.status === 401) {
    showTokenBar(true);
    showBanner("Authentication required — enter a valid bearer token.");
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function showBanner(msg) { if (msg) { banner.textContent = msg; banner.style.display = "block"; } else { banner.style.display = "none"; } }
function showTokenBar(show) { document.getElementById("tokenBar").style.display = show ? "flex" : "none"; }

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function fmtMs(ms) { if (ms == null) return "—"; if (ms < 1000) return ms + "ms"; return (ms/1000).toFixed(1) + "s"; }
function fmtTime(iso) { if (!iso) return "—"; const d = new Date(iso); return d.toLocaleString(); }
function sevBadge(sev) { return '<span class="badge sev-' + esc(sev) + '">' + esc(sev) + '</span>'; }

async function renderOverview() {
  const o = await api("/api/overview");
  const sev = o.totalFindings.bySeverity;
  const maxSev = Math.max(1, ...Object.values(sev));
  const sevOrder = ["critical","high","medium","low","nit"];
  const bars = sevOrder.map(s =>
    '<div class="bar-row">' + sevBadge(s) +
    '<div class="bar-track"><div class="bar-fill sev-' + s + '" style="width:' + (100*(sev[s]||0)/maxSev) + '%;background:var(--' + ({critical:"crit",high:"high",medium:"med",low:"low",nit:"nit"})[s] + ')"></div></div>' +
    '<div style="text-align:right">' + (sev[s]||0) + '</div></div>'
  ).join("");

  const series = o.reviewsOverTime || [];
  const maxDay = Math.max(1, ...series.map(d => d.count));
  const cols = series.length ? series.map(d =>
    '<div class="col" title="' + esc(d.date) + ': ' + d.count + '"><div class="stalk" style="height:' + (100*d.count/maxDay) + '%"></div><div class="day">' + esc(d.date.slice(5)) + '</div></div>'
  ).join("") : '<div class="empty">No reviews yet.</div>';

  app.innerHTML =
    '<h2>Overview</h2>' +
    '<div class="cards">' +
      card("Total reviews", o.totalReviews) +
      card("Findings posted", o.findingsPosted) +
      card("Findings (raw)", o.findingsRaw) +
      card("Mean wall time", fmtMs(o.meanWallMs)) +
      card("Watched repos", o.watchedRepos) +
      card("Last review", o.lastReviewAt ? fmtTime(o.lastReviewAt) : "—") +
    '</div>' +
    '<div class="panel"><h3>Findings by severity</h3><div class="bars">' + bars + '</div></div>' +
    '<div class="panel"><h3>Reviews over time</h3><div class="series">' + cols + '</div></div>';
}

function card(label, value) {
  return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div></div>';
}

async function renderRepos() {
  const { repos } = await api("/api/repos");
  const rows = repos.length ? repos.map(r =>
    '<tr><td data-label="Repo">' + esc(r.repo) + (r.watched ? '' : ' <span class="muted">(unwatched)</span>') + '</td>' +
    '<td data-label="Reviews">' + r.reviewCount + '</td>' +
    '<td data-label="Last review" class="muted">' + fmtTime(r.lastReviewAt) + '</td></tr>'
  ).join("") : '<tr><td colspan="3" class="empty">No repositories.</td></tr>';
  app.innerHTML = '<h2>Repositories</h2><div class="panel"><table>' +
    '<thead><tr><th>Repo</th><th>Reviews</th><th>Last review</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

async function renderReviews() {
  const { records, total } = await api("/api/reviews?limit=100");
  const rows = records.length ? records.map(r =>
    '<tr class="clickable" data-id="' + esc(r.id) + '">' +
    '<td data-label="Repo">' + esc(r.repo) + (r.prNumber != null ? ' <span class="muted">#' + r.prNumber + '</span>' : '') + '</td>' +
    '<td data-label="When" class="muted">' + fmtTime(r.timestamp) + '</td>' +
    '<td data-label="Files">' + r.stats.filesReviewed + '</td>' +
    '<td data-label="Findings">' + r.findingsPosted + '</td>' +
    '<td data-label="Wall" class="muted">' + fmtMs(r.wallMs) + '</td>' +
    '<td data-label="Head" class="mono">' + esc((r.headSha || "").slice(0,7)) + '</td></tr>'
  ).join("") : '<tr><td colspan="6" class="empty">No reviews recorded yet.</td></tr>';
  app.innerHTML = '<h2>Reviews <span class="muted">(' + total + ')</span></h2><div class="panel"><table>' +
    '<thead><tr><th>Repo</th><th>When</th><th>Files</th><th>Findings</th><th>Wall</th><th>Head</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  app.querySelectorAll("tr.clickable").forEach(tr =>
    tr.addEventListener("click", () => renderReviewDetail(tr.getAttribute("data-id")))
  );
}

async function renderReviewDetail(id) {
  const r = await api("/api/reviews/" + encodeURIComponent(id));
  const findings = (r.findings || []).map(f =>
    '<div class="finding"><div class="head">' + sevBadge(f.severity) +
    '<span class="badge sev-nit">' + esc(f.category) + '</span>' +
    '<span class="title">' + esc(f.title) + '</span>' +
    (f.verified ? '<span class="badge" style="background:rgba(55,178,77,.18);color:var(--ok)">verified</span>' : '') +
    '</div>' +
    '<div class="loc mono muted">' + esc(f.path) + ':' + f.line + (f.endLine ? '-' + f.endLine : '') +
    ' · confidence ' + (f.confidence != null ? f.confidence.toFixed(2) : '—') + '</div>' +
    '</div>'
  ).join("") || '<div class="empty">No findings posted.</div>';

  app.innerHTML =
    '<span class="back" id="back">← Back to reviews</span>' +
    '<h2>' + esc(r.repo) + (r.prNumber != null ? ' #' + r.prNumber : '') + '</h2>' +
    '<div class="cards">' +
      card("Findings posted", r.stats.findingsPosted) +
      card("Files", r.stats.filesReviewed) +
      card("Hunks", r.stats.hunksReviewed) +
      card("Wall", fmtMs(r.wallMs)) +
      card("Model", r.model || "—") +
    '</div>' +
    '<div class="panel"><h3>When</h3><div class="muted">' + fmtTime(r.timestamp) + ' · head <span class="mono">' + esc(r.headSha || "—") + '</span></div></div>' +
    (r.summary ? '<div class="panel"><h3>Summary</h3><div class="md">' + esc(r.summary) + '</div></div>' : '') +
    (r.walkthrough ? '<div class="panel"><h3>Walkthrough</h3><div class="md">' + esc(r.walkthrough) + '</div></div>' : '') +
    '<div class="panel"><h3>Findings (' + (r.findings || []).length + ')</h3>' + findings + '</div>';
  document.getElementById("back").addEventListener("click", () => switchView("reviews"));
}

const views = { overview: renderOverview, repos: renderRepos, reviews: renderReviews };

async function switchView(view) {
  state.view = view;
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("active", b.getAttribute("data-view") === view));
  showBanner("");
  try { await (views[view] || renderOverview)(); }
  catch (e) { if (e.message !== "unauthorized") app.innerHTML = '<div class="empty">Failed to load: ' + esc(e.message) + '</div>'; }
}

document.getElementById("nav").addEventListener("click", e => {
  const v = e.target.getAttribute && e.target.getAttribute("data-view");
  if (v) switchView(v);
});
document.getElementById("tokenSave").addEventListener("click", () => {
  setToken(document.getElementById("tokenInput").value.trim());
  showBanner(""); switchView(state.view);
});

async function boot() {
  try {
    const m = await (await fetch("/api/auth-mode")).json();
    state.mode = m.mode || "none";
  } catch { state.mode = "none"; }
  document.getElementById("modeLabel").textContent = "auth: " + state.mode;
  if (state.mode === "jwt") {
    showTokenBar(true);
    document.getElementById("tokenInput").value = token();
  }
  switchView("overview");
}
boot();
</script>
</body>
</html>`;
