# Warren

**An agentic PR reviewer you host yourself.** Warren watches your GitHub pull
requests and posts a single, batched code review plus a sticky walkthrough —
built on the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk)
(`@herdctl/core`). It's precision-first: every finding survives an adversarial
verify pass before it's posted, so you get signal, not a wall of nits.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

> Status: feature-complete for its first milestone — poll trigger, agentic
> review + verify, resolve-on-fix, `@warren` chat, and a web dashboard, with 132
> tests green. See [Status & roadmap](#status--roadmap).

---

## Why it exists

CodeRabbit and friends are great until the free tier rate-limits you and the paid
tier bills per seat. Warren is the self-hosted alternative:

- **~Zero marginal cost.** Run it on your existing **Claude Max** subscription
  (the `cli` runtime drives your logged-in Claude Code) — no per-review metering.
  An Anthropic API key works too (the `sdk` runtime) if you'd rather pay per token.
- **No rate limit of its own.** Your plan is the only ceiling.
- **No public ingress required.** The default **poll** trigger is outbound-only —
  it reaches out to GitHub on an interval, so it runs happily behind a homelab
  firewall or NAT with nothing exposed. (Inbound webhook / tunnel support is on
  the roadmap.)
- **Your code and credentials stay yours.** The review agent runs on your box and
  never holds a token (see [Security posture](#security-posture)).

## Features

- **Agentic review.** The reviewer isn't handed a diff and asked to guess — it's
  an agent working in a real checkout. It reads the surrounding code, greps for
  callers, and can run the repo's own lints/tests to confirm a concern.
- **Adversarial verify + severity gate.** Every candidate finding is challenged by
  a second (cheaper) model pass; low-confidence or refuted findings are dropped.
  A severity floor and fingerprint dedup gate what's left. Precision over recall.
- **Sticky walkthrough + coverage signal.** One pinned comment summarizes the PR;
  a coverage line ("Reviewed 3 changed files (7 hunks); ran the verify pass; 0
  findings") makes a clean review read as *looked and found nothing*, not *gave up*.
- **Incremental re-review + supersede.** Re-reviews only look at what changed since
  the last head; a new push supersedes an in-flight review of the old head.
- **Fingerprint dedup.** A finding already posted isn't posted again on the next push.
- **Resolve-on-fix.** When you fix a flagged issue, Warren resolves that review
  thread on the next pass instead of leaving stale comments around.
- **`@warren` commands + conversational replies.** Comment `@warren review`,
  `@warren full review`, `@warren pause` / `resume`, or `@warren resolve`. Ask a
  free-form question (`@warren why is this a problem?`) and Warren **resumes the
  PR's original review session** to answer with real continuity — the diff, the
  findings, and its reasoning are already in the conversation.
- **Web dashboard.** Review history, per-repo activity, severity metrics, and live
  status — with optional auth.

## How it works

```
                        ┌──────────── Warren (your box) ─────────────┐
   GitHub               │                                            │
  ┌────────┐  poll      │  trigger ──▶ queue ──▶ pipeline            │
  │  PRs & │◀───────────┼─ (outbound)   (per-PR,   │                 │
  │comments│            │               supersede) │                 │
  └────────┘            │                          ▼                 │
      ▲                 │            materialize checkout             │
      │  batched        │                          │                 │
      │  review +       │                          ▼                 │
      │  sticky         │              ┌─ review agent ─┐  findings   │
      │  walkthrough    │              │  (no token;    │──via MCP──┐ │
      └─────────────────┼──────────────┤  github_pr MCP)│           │ │
        (live mode)     │              └────────────────┘           ▼ │
                        │                      │            verify ▶ gate
                        │                      ▼                    │  │
                        │                 dashboard ◀── history ◀───┘  │
                        └────────────────────────────────────────────┘
```

1. **Trigger** (poll, by default) sweeps each watched repo: it emits an event for
   a new PR or a new head SHA, and scans PR comments for `@warren` commands.
2. Events go through a **queue** keyed per-PR — at most one job per PR at a time,
   and a newer head **supersedes** an in-flight review.
3. The **pipeline** materializes the target into a real checkout + diff, then runs
   the **review agent**. The agent's *only* write path is an injected `github_pr`
   MCP server — it records findings/summary/walkthrough there and **never touches
   the GitHub token**.
4. Findings go through the **verify** pass (adversarial, fail-open) and a
   **severity/dedup gate**.
5. The pipeline posts **one batched review** (COMMENT event) + upserts the sticky
   walkthrough. In dry-run it writes the same payloads to disk instead.

## Quickstart

### Prerequisites

- **Node.js ≥ 20**
- One of:
  - a **Claude Max** login (`claude` CLI logged in) — for `WARREN_RUNTIME=cli`, or
  - an **Anthropic API key** — for `WARREN_RUNTIME=sdk`
- A **GitHub token** with access to the repos you want to review (only needed for
  GitHub reviews, not for `review-local`).

### Install

```bash
git clone https://github.com/edspencer/warren.git
cd warren
npm install
npm run build      # compiles TypeScript to dist/
```

> Contributors: if your shell sets `NODE_ENV=production`, dev tooling (tsc,
> vitest) is pruned on install. Use `NODE_ENV=development npm install
> --include=dev`, and run tests/builds with the var unset (`env -u NODE_ENV npm
> test`).

### Watch a repo in dry-run (safe default)

Dry-run reads GitHub and *captures* the review it would post to
`${WARREN_DATA_DIR}/` — it never comments. This is the default (`WARREN_LIVE`
unset).

```bash
export GITHUB_TOKEN=ghp_...        # read access to the repo
export WARREN_REPOS=owner/repo     # comma-separate multiple repos
export WARREN_RUNTIME=cli          # Claude Max plan (default)

npm start                          # or: node dist/index.js  (alias: serve)
```

Warren boots the poll trigger + the dashboard on `$PORT` (default 5000). Open a
PR (or push to one) and watch the logs — the captured review lands under
`./data/`.

### Go live

When you're happy with what dry-run captures, flip the switch:

```bash
export WARREN_LIVE=1
npm start
```

Now Warren posts real GitHub reviews (always a `COMMENT` event — it never
approves or requests-changes; see [Security posture](#security-posture)).

### Review a local diff (no GitHub)

Point Warren at any local git repo and two refs — it reviews `base..head` and
prints a report (also written under `./data/reviews/`). No token, no posting:

```bash
node dist/index.js review-local /path/to/repo main my-feature-branch
# or during development:
npm run review:local -- /path/to/repo main my-feature-branch
```

### One-off dry-run of a real PR

Run the full pipeline against a real GitHub PR and capture the result locally
(JSON + rendered markdown) without ever posting:

```bash
env -u NODE_ENV npx tsx scripts/review-pr.ts owner/repo 1234 ./out
```

## Configuration

### `.warren.yaml`

Optional server config, read from the directory you run Warren in. Every key has
a default — see **[`.warren.example.yaml`](./.warren.example.yaml)** for a
commented starter. Keys are snake_case on disk.

| Key | Default | What it does |
|-----|---------|--------------|
| `profile` | `chill` | Review persona; `assertive` also surfaces `nit`-level findings. |
| `min_severity` | `low` | Lowest severity that can be posted (`critical`…`nit`). |
| `trigger.mode` | `poll` | `poll` (outbound-only, shipped). `webhook`/`tunnel` are roadmap. |
| `trigger.poll_interval` | `60s` | Poll cadence — `"30s"`, `"5m"`, `"1h"`, or ms. |
| `auto_review.enabled` | `true` | Auto-review open PRs (vs. `@warren`-only). |
| `auto_review.drafts` | `false` | Also review draft PRs. |
| `auto_review.base_branches` | `[main]` | Only auto-review PRs targeting these branches. |
| `auto_review.authors` | `[]` | **Safety allowlist** of PR author logins (case-insensitive). Empty = review everyone; when set, only these authors' PRs are reviewed/commented on (also gates `@warren` commands). |
| `auto_review.deny_authors` | `[]` | **Denylist** of PR author logins (case-insensitive). Deny wins over allow; also gates `@warren` commands. Silence noisy bots. |
| `auto_review.skip_release_prs` | `true` | Skip mechanical release/version PRs (by title/branch/author, or a lockfile/`CHANGELOG`/`.changeset`-only diff). Explicit `@warren review` still runs. |
| `auto_review.release_title_patterns` / `.release_branch_patterns` / `.release_authors` | `[]` | **Additive** custom release heuristics (regex, case-insensitive) on top of the built-in defaults. |
| `auto_review.skip_labels` | `[warren:skip]` | Skip any PR carrying one of these labels. |
| `auto_review.only_labels` | `[]` | When set, auto-review a PR **only** if it carries one of these labels. |
| `auto_review.skip_title_patterns` / `.skip_branch_patterns` | `[]` | Ignore patterns (regex) for AUTO review; explicit `@warren` commands still run. |
| `review.effort` | `normal` | `low` (no triage/verify, tight budget), `normal` (verify on), `high` (triage + verify, generous budget). Reasoning-effort proxy. |
| `review.max_files` | `0` | Soft ceiling: skip a PR whose changed-file count exceeds this (`0` = no cap). |
| `review.max_tokens` | `0` | Soft ceiling: skip a PR whose diff (est. ~4 chars/token) exceeds this (`0` = no cap). |
| `path_filters` | excludes `dist`/lockfiles/`node_modules` | Globs of files to review; `!` excludes. |
| `path_instructions` | `[]` | Extra `{ path, instructions }` guidance for the agent. |
| `walkthrough.sequence_diagrams` | `false` | Add sequence diagrams to the walkthrough. |
| `walkthrough.poem` | `false` | Add a poem to the walkthrough. |
| `commands_allowed` | all | Which `@warren` verbs are honored. |
| `models.triage` / `.review` / `.verify` | haiku / opus / haiku | Model per pipeline stage. |
| `resolve_on_fix` | `true` | Auto-resolve a review thread once its finding is fixed. |
| `live` | `false` | Post for real (env `WARREN_LIVE` overrides). |
| `concurrency` | `3` | Max concurrent review jobs. |
| `repos` | `[]` | Watched repos (`github:` or `local_git:`, with optional `overrides:`). |

### Environment variables

Secrets and deploy-specific settings live in the env (see
**[`.env.example`](./.env.example)**):

| Var | Default | What it does |
|-----|---------|--------------|
| `GITHUB_TOKEN` | — | Read PRs + post reviews. **Secret.** Required for GitHub reviews. |
| `ANTHROPIC_API_KEY` | — | Only used when `WARREN_RUNTIME=sdk`. **Secret.** |
| `WARREN_RUNTIME` | `cli` | `cli` (Claude Max plan) or `sdk` (metered API key). |
| `WARREN_LIVE` | off | Truthy (`1`/`true`) = post for real; otherwise dry-run. |
| `WARREN_REPOS` | — | CSV of `owner/repo` to watch (merged with `.warren.yaml`). |
| `PORT` / `WARREN_PORT` | `5000` | HTTP server port (`WARREN_PORT` wins). |
| `HOST` / `WARREN_HOST` | `0.0.0.0` | Bind host. |
| `WARREN_DATA_DIR` | `./data` | State, review history, captured dry-run payloads. |
| `WARREN_AUTH_MODE` | `none` | Dashboard auth: `none` or `jwt`. |
| `WARREN_JWT_SECRET` | — | HS256 secret for `jwt` mode. **Secret.** Required in `jwt` mode. |
| `WARREN_JWT_ISSUER` / `WARREN_JWT_AUDIENCE` | — | Optional `iss`/`aud` claims to validate. |

## The dashboard

`serve` (the default command) also runs a small web dashboard + JSON API on
`$PORT`. Reach it at `http://<host>:<port>/`. It shows review history, per-repo
activity, severity breakdowns, and live status.

API surface: `GET /` (dashboard SPA), `GET /api/overview`, `GET /api/repos`,
`GET /api/reviews`, `GET /api/reviews/:id`, `GET /api/auth-mode`, `GET /status`,
`GET /healthz`, and `POST /review` (manually enqueue a review).

**Auth** is the installer's choice (`WARREN_AUTH_MODE`):

- **`none`** (default) — open access, for a trusted LAN.
- **`jwt`** — the `/api/*` data plane requires a signed `Authorization: Bearer
  <jwt>` (HS256, verified against `WARREN_JWT_SECRET`, with optional `iss`/`aud`).
  The static shell and `/healthz` stay open; the SPA prompts for a token and
  stores it in `localStorage`. Warren refuses to start in `jwt` mode without a
  secret (fails closed, loudly).

## Security posture

Warren treats a PR as **untrusted input** — its diff and comments are attacker-
controllable, so the design keeps the model boxed in:

- **The review agent holds no secrets.** Its environment is scrubbed of
  credentials. Its *only* way to affect the outside world is the injected
  `github_pr` MCP server, whose "write" tools merely record intent into a
  host-side collector. The pipeline — not the agent — does the verify → gate →
  post, using the token that never leaves the server.
- **COMMENT-only.** Warren posts reviews as `COMMENT` events. It never approves a
  PR and never requests changes in a way that gates merges.
- **Dry-run by default.** Nothing is posted until you explicitly set `WARREN_LIVE=1`.
- **No public ingress in poll mode.** Nothing inbound to attack.
- **Secrets are never logged.** Diagnostics report only *presence* booleans
  (`hasGithubToken: true`), never values.

## Runtime & cost

| Runtime | Auth | Cost | Notes |
|---------|------|------|-------|
| `cli` (default) | Claude Max login (`claude` CLI) | Covered by your subscription | ~Zero marginal cost; bound by your plan. |
| `sdk` | `ANTHROPIC_API_KEY` | Metered per token | Use when you don't have a Max plan or want a dedicated key. |

Both drive the same pipeline; only how the agent turns are executed differs. Triage
and verify run on a fast model (`claude-haiku-4-5`); the review pass uses Opus by
default (all configurable under `models:`).

## Status & roadmap

**Shipped**

- Poll trigger (outbound-only), incremental review + supersede
- Agentic review + adversarial verify + severity/dedup gate
- Batched GitHub review + sticky walkthrough + coverage signal
- Fingerprint dedup, resolve-on-fix
- `@warren` commands + conversational replies (session resume)
- `review-local` and one-off `scripts/review-pr.ts` dry-run runners
- Web dashboard with `none` / `jwt` auth
- 132 tests green

**Planned**

- Public ingress: inbound **webhook** + **tunnel** triggers (schema stubs exist)
- **GitHub App** auth (installation tokens) instead of a PAT
- A **Docker image** for one-command deploy
- Richer walkthrough output

## Contributing

Issues and PRs welcome at
[github.com/edspencer/warren](https://github.com/edspencer/warren). Please keep
`env -u NODE_ENV npx tsc --noEmit` clean and `env -u NODE_ENV npx vitest run`
green.

## License

MIT © Ed Spencer. See [LICENSE](./LICENSE).
