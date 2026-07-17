// src/server/dashboard.ts — the self-contained static dashboard SPA.
//
// Exported as a string constant (not a file on disk) so it works identically
// from `src` (tsx) and `dist` (compiled) with no @fastify/static dependency and
// no runtime file reads. Vanilla JS + fetch + inline CSS — dependency-light by
// design (see the dashboard deliverable). Dark-mode-friendly.
//
// Routing: a small History-API client router (#12). Routes `/`, `/repos`,
// `/reviews`, `/reviews/:id` are real, deep-linkable URLs; browser back/forward
// work and nav active-state is derived from the URL. The server serves this same
// shell for every client route (SPA fallback in app.ts) so a hard refresh or a
// pasted deep link renders correctly. Room is left for `/repos/:owner/:name` and
// `/findings` that later tickets add — an unknown path renders a Not-found view.
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
  /* Visible keyboard focus everywhere (a11y — #20). Mouse users don't see it. */
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
  header {
    display: flex; align-items: center; gap: 16px; padding: 14px 22px;
    border-bottom: 1px solid var(--border); background: var(--panel);
    position: sticky; top: 0; z-index: 10;
  }
  header .brand { font-weight: 700; font-size: 16px; letter-spacing: .2px; }
  header .brand a { color: inherit; }
  header .brand a:hover { text-decoration: none; }
  header .brand small { color: var(--muted); font-weight: 400; margin-left: 6px; }
  nav { display: flex; gap: 4px; margin-left: 8px; }
  nav a {
    display: inline-block; background: transparent; color: var(--muted); border: 0;
    padding: 7px 12px; border-radius: 8px; cursor: pointer; font-size: 14px; line-height: 1;
  }
  nav a.active { background: var(--panel-2); color: var(--text); }
  nav a:hover { color: var(--text); text-decoration: none; }
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
  tr.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  tr.clickable:focus-visible td { background: var(--panel-2); }
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

  /* ---------- Reviews-over-time chart (#13 — inline SVG, proportional) ---------- */
  .chart { width: 100%; }
  .chart svg { width: 100%; height: auto; display: block; overflow: visible; }
  .chart .bar { fill: var(--accent-2); transition: fill .12s ease; }
  .chart .barhit { cursor: default; }
  .chart .barhit:hover .bar { fill: var(--accent); }
  .chart .axis { stroke: var(--border); stroke-width: 1; }
  .chart .grid { stroke: var(--border); stroke-dasharray: 3 3; opacity: .5; }
  .chart .lbl { fill: var(--muted); font: 12px system-ui, sans-serif; }
  .chart .val { fill: var(--muted); font: 11px system-ui, sans-serif; }

  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .back {
    cursor: pointer; color: var(--accent); margin-bottom: 12px; display: inline-block;
    background: none; border: 0; padding: 4px 2px; font: inherit;
  }
  .back:hover { text-decoration: underline; }
  .finding { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; background: var(--panel-2); }
  .finding .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .finding .title { font-weight: 600; }
  .finding .loc { margin-top: 4px; }
  .finding .body { margin-top: 8px; white-space: pre-wrap; }
  .md { white-space: pre-wrap; }
  .empty { color: var(--muted); padding: 28px 20px; text-align: center; }
  .empty h2 { color: var(--text); }

  /* Clickable stat cards (#15/#17) — a card that is itself a link into a drill-down. */
  a.card.cardlink { display: block; color: inherit; text-decoration: none; transition: border-color .12s ease; }
  a.card.cardlink:hover { border-color: var(--accent); text-decoration: none; }

  /* Clickable severity bars (#15) — each bar row drills into a filtered Findings list. */
  a.bar-row.barlink { color: inherit; text-decoration: none; padding: 2px 4px; margin: 0 -4px; border-radius: 8px; }
  a.bar-row.barlink:hover { text-decoration: none; background: var(--panel-2); }
  a.bar-row.barlink:hover .bar-track { outline: 1px solid var(--accent); }

  /* Finding cards link to their review + GitHub (#15). */
  .finding a.title { color: var(--text); }
  .finding a.title:hover { color: var(--accent); text-decoration: underline; }
  .finding .finding-meta { margin-top: 8px; font-size: 12px; }
  .filterbar { margin: -6px 0 14px; font-size: 13px; }

  /* Read-only effective-config table (#19). */
  .cfg-row { display: grid; grid-template-columns: 190px 1fr; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--border); }
  .cfg-row:last-child { border-bottom: 0; }
  .cfg-k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .3px; }
  .cfg-v { word-break: break-word; }
  .cfg-v .pi { margin-top: 4px; }
  @media (max-width: 640px) { .cfg-row { grid-template-columns: 1fr; gap: 3px; } }

  /* Error state (#20) — a real, retryable failure surface (not a bare string). */
  .error-box {
    border: 1px solid var(--crit); background: rgba(255,107,107,.1); border-radius: 12px;
    padding: 18px 20px; text-align: center;
  }
  .error-box .error-title { font-weight: 700; color: var(--crit); margin-bottom: 6px; }
  .error-box button {
    margin-top: 12px; background: var(--accent-2); color: #fff; border: 0;
    padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px;
  }
  .error-box button:hover { background: var(--accent); }

  /* Loading skeletons (#20) — shimmer placeholders shown while a view fetches. */
  .skeleton {
    background: linear-gradient(90deg, var(--panel-2) 25%, #262b36 37%, var(--panel-2) 63%);
    background-size: 400% 100%; animation: shimmer 1.3s ease-in-out infinite; border-radius: 8px;
  }
  @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
  .sk-line { height: 12px; }
  .sk-chart { height: 190px; }
  .sk-row { height: 40px; margin: 8px 0; }

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

  /* Respect reduced-motion: no shimmer animation. */
  @media (prefers-reduced-motion: reduce) {
    .skeleton { animation: none; }
    .chart .bar { transition: none; }
  }

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
    nav a { flex: 1; min-height: 40px; padding: 9px 6px; text-align: center; line-height: 22px; }
    .token-bar { order: 4; width: 100%; }
    .token-bar input { flex: 1 1 auto; width: auto; min-width: 0; }

    main { padding: 16px max(14px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
    h2 { font-size: 17px; }
    .cards { grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; }
    .card { padding: 12px 13px; }
    .card .value { font-size: 22px; }
    .panel { padding: 13px; }
    .bar-row { grid-template-columns: 64px 1fr 32px; gap: 8px; }

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
  <div class="brand"><a href="/" data-link>🐇 Warren</a> <small>review dashboard</small></div>
  <nav id="nav" aria-label="Primary">
    <a href="/" data-link data-view="overview" class="active" aria-current="page">Overview</a>
    <a href="/repos" data-link data-view="repos">Repos</a>
    <a href="/reviews" data-link data-view="reviews">Reviews</a>
  </nav>
  <div class="spacer"></div>
  <div class="token-bar" id="tokenBar">
    <input id="tokenInput" type="password" placeholder="Bearer token" aria-label="Bearer token" />
    <button id="tokenSave">Save</button>
  </div>
  <div class="mode" id="modeLabel"></div>
</header>
<main>
  <div class="banner" id="banner" role="alert"></div>
  <div id="app" aria-live="polite"></div>
</main>
<script>
const state = { mode: "none" };
const app = document.getElementById("app");
const banner = document.getElementById("banner");
const nav = document.getElementById("nav");

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
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function showBanner(msg) { if (msg) { banner.textContent = msg; banner.style.display = "block"; } else { banner.style.display = "none"; } }
function showTokenBar(show) { document.getElementById("tokenBar").style.display = show ? "flex" : "none"; }

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function fmtMs(ms) { if (ms == null) return "—"; if (ms < 1000) return ms + "ms"; return (ms/1000).toFixed(1) + "s"; }
function fmtTime(iso) { if (!iso) return "—"; const d = new Date(iso); return d.toLocaleString(); }
function sevBadge(sev) { return '<span class="badge sev-' + esc(sev) + '">' + esc(sev) + '</span>'; }
function card(label, value) {
  return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div></div>';
}
// A stat card that is itself a link into a drill-down view (#15/#17).
function cardLink(label, value, href) {
  return '<a class="card cardlink" href="' + esc(href) + '" data-link>' +
    '<div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div></a>';
}

// Clickable severity bars → a filtered Findings list (#15). Optional repoFilter
// scopes the drill-down to one repo (used on the repo detail page).
function severityBars(sev, repoFilter) {
  const maxSev = Math.max(1, ...Object.values(sev || {}));
  const sevOrder = ["critical","high","medium","low","nit"];
  const sevVar = { critical:"crit", high:"high", medium:"med", low:"low", nit:"nit" };
  return sevOrder.map(s => {
    const n = (sev && sev[s]) || 0;
    const href = "/findings?severity=" + s + (repoFilter ? "&repo=" + encodeURIComponent(repoFilter) : "");
    return '<a class="bar-row barlink" href="' + href + '" data-link aria-label="' + n + ' ' + s + ' findings">' +
      sevBadge(s) +
      '<div class="bar-track"><div class="bar-fill sev-' + s + '" style="width:' + (100*n/maxSev) + '%;background:var(--' + sevVar[s] + ')"></div></div>' +
      '<div style="text-align:right">' + n + '</div></a>';
  }).join("");
}

// GitHub blob deep-link for a github-pr finding (head sha + path + line).
function ghBlobUrl(f) {
  if (f.kind !== "github-pr" || !f.repo || !f.headSha || !f.path) return null;
  return "https://github.com/" + f.repo + "/blob/" + f.headSha + "/" + f.path +
    "#L" + f.line + (f.endLine ? "-L" + f.endLine : "");
}

// One finding card, linking to its review + repo + GitHub (#15).
function findingCard(f) {
  const gh = ghBlobUrl(f);
  const loc = esc(f.path) + ':' + f.line + (f.endLine ? '-' + f.endLine : '');
  const repoLink = f.kind === "github-pr"
    ? '<a href="/repos/' + esc(f.repo) + '" data-link>' + esc(f.repo) + '</a>'
    : esc(f.repo);
  return '<div class="finding"><div class="head">' + sevBadge(f.severity) +
    '<span class="badge sev-nit">' + esc(f.category) + '</span>' +
    '<a class="title" href="/reviews/' + encodeURIComponent(f.reviewId) + '" data-link>' + esc(f.title) + '</a>' +
    (f.verified ? '<span class="badge" style="background:rgba(55,178,77,.18);color:var(--ok)">verified</span>' : '') +
    '</div>' +
    '<div class="loc mono muted">' + loc +
      ' · confidence ' + (f.confidence != null ? f.confidence.toFixed(2) : '—') + '</div>' +
    '<div class="finding-meta muted">' + repoLink +
      (f.prNumber != null ? ' <span class="muted">#' + f.prNumber + '</span>' : '') +
      ' · ' + fmtTime(f.timestamp) +
      (gh ? ' · <a href="' + esc(gh) + '" target="_blank" rel="noopener noreferrer">GitHub ↗</a>' : '') +
    '</div></div>';
}

// Shared reviews table (used by Reviews, Overview recent, and repo detail).
function reviewRow(r) {
  return '<tr class="clickable" role="link" tabindex="0" data-href="/reviews/' + encodeURIComponent(r.id) + '"' +
    ' aria-label="Open review of ' + esc(r.repo) + (r.prNumber != null ? ' PR ' + r.prNumber : '') + '">' +
    '<td data-label="Repo">' + esc(r.repo) + (r.prNumber != null ? ' <span class="muted">#' + r.prNumber + '</span>' : '') + '</td>' +
    '<td data-label="When" class="muted">' + fmtTime(r.timestamp) + '</td>' +
    '<td data-label="Files">' + r.stats.filesReviewed + '</td>' +
    '<td data-label="Findings">' + r.findingsPosted + '</td>' +
    '<td data-label="Wall" class="muted">' + fmtMs(r.wallMs) + '</td>' +
    '<td data-label="Head" class="mono">' + esc((r.headSha || "").slice(0,7)) + '</td></tr>';
}
function reviewsTable(records, emptyMsg) {
  const rows = records.length ? records.map(reviewRow).join("")
    : '<tr><td colspan="6" class="empty">' + esc(emptyMsg) + '</td></tr>';
  return '<table><thead><tr><th scope="col">Repo</th><th scope="col">When</th>' +
    '<th scope="col">Files</th><th scope="col">Findings</th><th scope="col">Wall</th>' +
    '<th scope="col">Head</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// ─────────────────────────────── views ───────────────────────────────
// Each view is an async fn returning { html, wire? }. render() shows a
// skeleton, awaits the fn, and (if not superseded) commits its html.

async function renderOverview() {
  // Signal-first (#17): totals are a compact clickable strip; the body is recent
  // activity + attention-worthy findings you can click straight into.
  const [o, recent, allFindings] = await Promise.all([
    api("/api/overview"),
    api("/api/reviews?limit=6"),
    api("/api/findings"),
  ]);
  const sev = o.totalFindings.bySeverity;

  // Attention: newest critical/high findings (api returns newest-first).
  const attention = (allFindings.findings || [])
    .filter(f => f.severity === "critical" || f.severity === "high")
    .slice(0, 6);
  const attentionHtml = attention.length
    ? attention.map(findingCard).join("")
    : '<div class="empty">No critical or high findings — nothing needs attention. 🎉</div>';

  const recentHtml = reviewsTable(recent.records || [], "No reviews recorded yet.");

  const html =
    '<h2>Overview</h2>' +
    '<div class="cards">' +
      cardLink("Total reviews", o.totalReviews, "/reviews") +
      cardLink("Findings posted", o.findingsPosted, "/findings") +
      cardLink("Watched repos", o.watchedRepos, "/repos") +
      card("Mean wall time", fmtMs(o.meanWallMs)) +
      card("Last review", o.lastReviewAt ? fmtTime(o.lastReviewAt) : "—") +
    '</div>' +
    '<div class="panel"><h3>Needs attention <span class="muted" style="text-transform:none;letter-spacing:0">— recent critical / high</span></h3>' + attentionHtml + '</div>' +
    '<div class="panel"><h3>Recent reviews</h3>' + recentHtml +
      (o.totalReviews > (recent.records || []).length ? '<div style="margin-top:10px"><a href="/reviews" data-link>View all reviews →</a></div>' : '') +
    '</div>' +
    '<div class="panel"><h3>Findings by severity <span class="muted" style="text-transform:none;letter-spacing:0">— click to drill down</span></h3><div class="bars">' + severityBars(sev) + '</div></div>' +
    '<div class="panel"><h3>Reviews over time</h3>' + reviewsChart(o.reviewsOverTime || []) + '</div>';
  return { html };
}

// #13 — inline-SVG bar chart. Robust for sparse/single-day data: a real y-scale
// (bars are a fraction of the plot height, not a CSS % that collapses), a min
// bar height so any non-zero day is visible, day labels (thinned when dense), a
// native hover tooltip per bar, and a proper empty state.
function reviewsChart(series) {
  if (!series.length) {
    return '<div class="empty">No reviews yet — this chart fills in once reviews are recorded.</div>';
  }
  const W = 900, H = 190, padL = 34, padR = 14, padT = 14, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const baseY = padT + plotH;
  const n = series.length;
  const max = Math.max(1, ...series.map(d => d.count));
  const band = plotW / n;
  const bw = Math.min(46, band * 0.62);
  const labelEvery = Math.ceil(n / 12); // thin labels so they never collide

  let bars = "";
  series.forEach((d, i) => {
    const cx = padL + band * i + band / 2;
    const h = d.count > 0 ? Math.max(4, (d.count / max) * plotH) : 0;
    const x = cx - bw / 2;
    const y = baseY - h;
    const showLbl = (i % labelEvery === 0) || i === n - 1;
    const tip = esc(d.date) + ": " + d.count + " review" + (d.count === 1 ? "" : "s");
    bars +=
      '<g class="barhit"><title>' + tip + '</title>' +
      // invisible full-height hit target so hover works even above short bars
      '<rect x="' + (padL + band * i).toFixed(1) + '" y="' + padT + '" width="' + band.toFixed(1) + '" height="' + plotH + '" fill="transparent"></rect>' +
      (h > 0 ? '<rect class="bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3"></rect>' : '') +
      (showLbl ? '<text class="lbl" x="' + cx.toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(d.date.slice(5)) + '</text>' : '') +
      '</g>';
  });

  const axis =
    '<line class="grid" x1="' + padL + '" y1="' + padT + '" x2="' + (W - padR) + '" y2="' + padT + '"></line>' +
    '<line class="axis" x1="' + padL + '" y1="' + baseY + '" x2="' + (W - padR) + '" y2="' + baseY + '"></line>' +
    '<text class="val" x="' + (padL - 6) + '" y="' + (padT + 4) + '" text-anchor="end">' + max + '</text>' +
    '<text class="val" x="' + (padL - 6) + '" y="' + (baseY) + '" text-anchor="end">0</text>';

  const label = "Reviews over time: " + n + " day" + (n === 1 ? "" : "s") + ", up to " + max + " per day";
  return '<div class="chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label) + '" preserveAspectRatio="xMidYMid meet">' +
    axis + bars + '</svg></div>';
}

async function renderRepos() {
  const { repos } = await api("/api/repos");
  const rows = repos.length ? repos.map(r => {
    const parts = String(r.repo).split("/");
    const linkable = parts.length === 2 && parts[0] && parts[1]; // owner/name → detail page
    const open = linkable
      ? '<tr class="clickable" role="link" tabindex="0" data-href="/repos/' + esc(r.repo) + '" aria-label="Open ' + esc(r.repo) + '">'
      : '<tr>';
    return open + '<td data-label="Repo">' + esc(r.repo) + (r.watched ? '' : ' <span class="muted">(unwatched)</span>') + '</td>' +
      '<td data-label="Reviews">' + r.reviewCount + '</td>' +
      '<td data-label="Last review" class="muted">' + fmtTime(r.lastReviewAt) + '</td></tr>';
  }).join("") : '<tr><td colspan="3" class="empty">No repositories watched yet.</td></tr>';
  const html = '<h2>Repositories</h2><div class="panel"><table>' +
    '<thead><tr><th scope="col">Repo</th><th scope="col">Reviews</th><th scope="col">Last review</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  return { html };
}

// #16 + #19 — per-repo detail: aggregate stats, its reviews, watched status,
// last activity, and the effective (read-only) config Warren applies to it.
async function renderRepoDetail(owner, name) {
  let d;
  const label = owner + "/" + name;
  try {
    d = await api("/api/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name));
  } catch (e) {
    if (e.message === "not_found") {
      return { html: backLink("/repos", "← Back to repos") +
        '<div class="empty"><h2>Repo not found</h2><p class="muted">No watched repo or review history for <span class="mono">' + esc(label) + '</span>.</p></div>' };
    }
    throw e;
  }

  const cards =
    '<div class="cards">' +
      cardLink("Reviews", d.reviewCount, "/reviews?repo=" + encodeURIComponent(d.repo)) +
      cardLink("Findings posted", d.findingsPosted, "/findings?repo=" + encodeURIComponent(d.repo)) +
      card("Mean wall", fmtMs(d.meanWallMs)) +
      card("Last review", d.lastReviewAt ? fmtTime(d.lastReviewAt) : "—") +
      card("Watched", d.watched ? "yes" : "no") +
    '</div>';

  const html =
    backLink("/repos", "← Back to repos") +
    '<h2>' + esc(d.repo) + (d.watched ? '' : ' <span class="muted">(unwatched)</span>') +
      ' <a class="muted" style="font-size:13px;font-weight:400" href="https://github.com/' + esc(d.repo) + '" target="_blank" rel="noopener noreferrer">GitHub ↗</a></h2>' +
    cards +
    '<div class="panel"><h3>Findings by severity <span class="muted" style="text-transform:none;letter-spacing:0">— click to drill down</span></h3><div class="bars">' + severityBars(d.totalFindings.bySeverity, d.repo) + '</div></div>' +
    configPanel(d.config) +
    '<div class="panel"><h3>Reviews</h3>' + reviewsTable(d.reviews || [], "No reviews recorded for this repo yet.") + '</div>';
  return { html };
}

// #19 — read-only projection of the effective config Warren applies to a repo.
function configPanel(c) {
  const authors = (c.autoReview.authors || []);
  const rows = [
    ["Review model", c.model],
    ["Min severity", c.minSeverity],
    ["Profile", c.profile],
    ["Auto-review", c.autoReview.enabled ? "enabled" : "disabled"],
    ["Review drafts", c.autoReview.drafts ? "yes" : "no"],
    ["Base branches", (c.autoReview.baseBranches || []).join(", ") || "—"],
    ["Author allowlist", authors.length ? authors.join(", ") : "all authors"],
    ["Path filters", (c.pathFilters || []).join("  ") || "—"],
    ["Resolve on fix", c.resolveOnFix ? "yes" : "no"],
    ["Walkthrough", "diagrams " + (c.walkthrough.sequenceDiagrams ? "on" : "off") + " · poem " + (c.walkthrough.poem ? "on" : "off")],
    ["Triage / verify", (c.models.triage || "—") + "  ·  " + (c.models.verify || "—")],
  ];
  let dl = rows.map(([k, v]) =>
    '<div class="cfg-row"><div class="cfg-k">' + esc(k) + '</div><div class="cfg-v mono">' + esc(v) + '</div></div>'
  ).join("");
  const pi = c.pathInstructions || [];
  if (pi.length) {
    dl += '<div class="cfg-row"><div class="cfg-k">Path instructions</div><div class="cfg-v">' +
      pi.map(p => '<div class="pi"><span class="mono">' + esc(p.path) + '</span> <span class="muted">— ' + esc(p.instructions) + '</span></div>').join("") +
      '</div></div>';
  }
  return '<div class="panel"><h3>Effective config <span class="muted" style="text-transform:none;letter-spacing:0">(read-only)</span></h3>' + dl + '</div>';
}

// #15 — flat, filtered findings list. Filters come from the query string
// (?severity=&repo=&verified=) so it is deep-linkable from Overview drill-downs.
async function renderFindings() {
  const params = new URLSearchParams(location.search);
  const severity = params.get("severity") || "";
  const repo = params.get("repo") || "";
  const verified = params.get("verified") || "";
  const qp = [];
  if (severity) qp.push("severity=" + encodeURIComponent(severity));
  if (repo) qp.push("repo=" + encodeURIComponent(repo));
  if (verified) qp.push("verified=" + encodeURIComponent(verified));
  const { findings, total } = await api("/api/findings" + (qp.length ? "?" + qp.join("&") : ""));

  const active = [];
  if (severity) active.push("severity " + sevBadge(severity));
  if (repo) active.push('repo <a href="/repos/' + esc(repo) + '" data-link class="mono">' + esc(repo) + '</a>');
  if (verified) active.push("verified: " + esc(verified));
  const filterbar = active.length
    ? '<div class="filterbar muted">Filtered by ' + active.join(", ") + ' · <a href="/findings" data-link>clear</a></div>'
    : '<div class="filterbar muted">All findings across every review.</div>';

  const body = findings.length
    ? findings.map(findingCard).join("")
    : '<div class="empty">No findings match this filter.</div>';

  const html =
    '<a class="back" href="/" data-link>← Back to overview</a>' +
    '<h2>Findings <span class="muted">(' + total + ')</span></h2>' +
    filterbar +
    '<div class="panel">' + body + '</div>';
  return { html };
}

async function renderReviews() {
  const params = new URLSearchParams(location.search);
  const repo = params.get("repo") || "";
  const { records, total } = await api("/api/reviews?limit=100" + (repo ? "&repo=" + encodeURIComponent(repo) : ""));
  const filterbar = repo
    ? '<div class="filterbar muted">Filtered by repo <a href="/repos/' + esc(repo) + '" data-link class="mono">' + esc(repo) + '</a> · <a href="/reviews" data-link>clear</a></div>'
    : "";
  const html = '<h2>Reviews <span class="muted">(' + total + ')</span></h2>' + filterbar +
    '<div class="panel">' + reviewsTable(records || [], "No reviews recorded yet.") + '</div>';
  return { html };
}

async function renderReviewDetail(id) {
  let r;
  try {
    r = await api("/api/reviews/" + encodeURIComponent(id));
  } catch (e) {
    if (e.message === "not_found") {
      return { html: backLink() + '<div class="empty"><h2>Review not found</h2><p class="muted">No review with id <span class="mono">' + esc(id) + '</span>.</p></div>' };
    }
    throw e;
  }
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

  const html =
    backLink() +
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
  return { html };
}

function backLink(href, label) {
  return '<a class="back" href="' + (href || "/reviews") + '" data-link>' + (label || "← Back to reviews") + '</a>';
}

// ─────────────────────────────── skeletons ───────────────────────────────
function skCards(n) {
  return '<div class="cards">' + Array.from({ length: n }).map(() =>
    '<div class="card"><div class="skeleton sk-line" style="width:55%"></div>' +
    '<div class="skeleton sk-line" style="width:75%;height:22px;margin-top:8px"></div></div>').join("") + '</div>';
}
function skRows(n) {
  return Array.from({ length: n }).map(() => '<div class="skeleton sk-row"></div>').join("");
}
function skOverview() {
  return '<h2>Overview</h2>' + skCards(6) +
    '<div class="panel"><h3>Findings by severity</h3>' + skRows(3) + '</div>' +
    '<div class="panel"><h3>Reviews over time</h3><div class="skeleton sk-chart"></div></div>';
}
function skList(title) {
  return '<h2>' + title + '</h2><div class="panel">' + skRows(6) + '</div>';
}
function skDetail() {
  return backLink() + skCards(5) + '<div class="panel">' + skRows(4) + '</div>';
}

// ─────────────────────────────── router ───────────────────────────────
const routes = [
  { name: "overview", re: /^\/$/, load: renderOverview, skeleton: () => skOverview() },
  { name: "repos", re: /^\/repos\/?$/, load: renderRepos, skeleton: () => skList("Repositories") },
  { name: "repoDetail", re: /^\/repos\/([^/]+)\/([^/]+)\/?$/, load: (m) => renderRepoDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2])), skeleton: () => skDetail() },
  { name: "findings", re: /^\/findings\/?$/, load: renderFindings, skeleton: () => skList("Findings") },
  { name: "reviews", re: /^\/reviews\/?$/, load: renderReviews, skeleton: () => skList("Reviews") },
  { name: "reviewDetail", re: /^\/reviews\/([^/]+)\/?$/, load: (m) => renderReviewDetail(decodeURIComponent(m[1])), skeleton: () => skDetail() },
];

/** Nav highlight key for a route (detail views roll up under their section). */
function navKeyFor(name) {
  if (name === "reviewDetail") return "reviews";
  if (name === "repoDetail") return "repos";
  return name; // "findings" matches no nav item → no highlight (reached from Overview)
}

function matchRoute(path) {
  for (const r of routes) { const m = r.re.exec(path); if (m) return { route: r, m }; }
  return null;
}

function setActiveNav(name) {
  const key = navKeyFor(name);
  nav.querySelectorAll("a").forEach(a => {
    const active = a.getAttribute("data-view") === key;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}

let renderSeq = 0;
async function render() {
  const path = location.pathname;
  const match = matchRoute(path);
  showBanner("");
  const seq = ++renderSeq;
  if (!match) {
    setActiveNav("");
    app.innerHTML = '<div class="empty"><h2>Not found</h2><p class="muted">No page at <span class="mono">' +
      esc(path) + '</span>.</p><p><a href="/" data-link>← Back to overview</a></p></div>';
    return;
  }
  setActiveNav(match.route.name);
  app.innerHTML = match.route.skeleton();
  try {
    const out = await match.route.load(match.m);
    if (seq !== renderSeq) return; // a newer navigation superseded this one
    app.innerHTML = out.html;
    if (out.wire) out.wire(app);
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.message === "unauthorized") {
      app.innerHTML = '<div class="empty">Authentication required — enter a valid bearer token above, then retry.</div>';
      return;
    }
    app.innerHTML =
      '<div class="error-box"><div class="error-title">Couldn’t load this view</div>' +
      '<div class="muted">' + esc(e.message) + '</div>' +
      '<button type="button" data-retry>Retry</button></div>';
    const btn = app.querySelector("[data-retry]");
    if (btn) btn.addEventListener("click", () => render());
  }
}

function navigate(path, opts) {
  opts = opts || {};
  const current = location.pathname + location.search;
  if (path !== current) {
    if (opts.replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
  }
  render();
}

// Intercept internal-link clicks (nav + back link + not-found link).
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest("a[data-link]");
  if (!a) return;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

// Clickable table rows (role="link") — click + keyboard (Enter/Space).
app.addEventListener("click", e => {
  const el = e.target.closest && e.target.closest("[data-href]");
  if (el && app.contains(el)) { e.preventDefault(); navigate(el.getAttribute("data-href")); }
});
app.addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
  const el = e.target.closest && e.target.closest("[data-href]");
  if (el && app.contains(el)) { e.preventDefault(); navigate(el.getAttribute("data-href")); }
});

window.addEventListener("popstate", () => render());

document.getElementById("tokenSave").addEventListener("click", () => {
  setToken(document.getElementById("tokenInput").value.trim());
  showBanner(""); render();
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
  render();
}
boot();
</script>
</body>
</html>`;
