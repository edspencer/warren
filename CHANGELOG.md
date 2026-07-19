# warren

## 0.2.0

### Minor Changes

- [#22](https://github.com/edspencer/warren/pull/22) [`6f4abe2`](https://github.com/edspencer/warren/commit/6f4abe204b3de1a110aeb0cced98fbffceb1ed72) Thanks [@edspencer](https://github.com/edspencer)! - Safety: author allowlist ([#21](https://github.com/edspencer/warren/issues/21)). New `auto_review.authors` config (default `[]` = review everyone, unchanged) restricts which PR authors Warren auto-reviews and comments on — case-insensitive login match. When set, non-allowlisted authors' PRs are never enqueued or commented on, and `@warren` commands on their PRs are ignored (gated on the PR author). Scope a fresh install to just your own login while testing.

- [#30](https://github.com/edspencer/warren/pull/30) [`06c0c55`](https://github.com/edspencer/warren/commit/06c0c55634f4fd98d42a62741c29d8de2f1a5975) Thanks [@edspencer](https://github.com/edspencer)! - Config editing UI — make the dashboard configuration editable, backed by the `.warren.yaml` text file ([#27](https://github.com/edspencer/warren/issues/27)), building on the read-only effective-config view ([#19](https://github.com/edspencer/warren/issues/19)).

  - **Backend.** New `GET /api/config` returns the current server config as structured data (snake_case, defaults materialized) + the raw file text — secret-free (secrets live in env, never in config). New `PUT /api/config` validates the submission against the Zod schema, writes it to the resolved config path, and **hot-reloads it in place** (applies on the next poll / next review) via `reloadWarrenConfigInto` on the container. Accepts `{ yaml }` (raw text, written verbatim so comments/formatting survive) or `{ config }` (structured, serialized to YAML). Invalid config → **400** with per-issue details, and the on-disk file is left untouched.
  - **Write auth guard.** Config writes are hard-gated on `WARREN_AUTH_MODE=jwt`: in `none` mode `PUT /api/config` is refused (**403**) so an unauthenticated LAN deploy can't rewrite the review policy; in `jwt` mode the existing auth hook already enforces a valid bearer token (**401** without).
  - **Frontend.** New `/settings` route + nav entry. A schema-driven **generic form** (walks the structured config, so newly-added knobs appear automatically) for scalar/array fields, plus a **raw-YAML editor** with validate-on-save. Save success / validation-error surfacing, editing disabled with a notice in `none` mode. Dark-mode + mobile + dependency-light, consistent with the existing SPA.

  In-repo `.warren.yaml` (a config committed in each reviewed repo, CodeRabbit-style) is split out as a follow-up ([#28](https://github.com/edspencer/warren/issues/28)). Existing tests stay green (+13), `tsc` clean.

- [#25](https://github.com/edspencer/warren/pull/25) [`40e7a7c`](https://github.com/edspencer/warren/commit/40e7a7ccea49e02ddc1b954f3da20ac50c38a9a2) Thanks [@edspencer](https://github.com/edspencer)! - Dashboard drill-down pages + endpoints on top of the new routing ([#15](https://github.com/edspencer/warren/issues/15), [#16](https://github.com/edspencer/warren/issues/16), [#17](https://github.com/edspencer/warren/issues/17), [#19](https://github.com/edspencer/warren/issues/19)).

  - **[#15](https://github.com/edspencer/warren/issues/15) — severity drill-down → Findings list.** New `GET /api/findings?severity=&repo=&verified=` flattens findings across every review with the context to link each back to its review (+ GitHub). Overview severity bars and the totals cards are now clickable, landing on a new deep-linkable `/findings` route filtered by severity/repo; each finding links to its review, its repo, and a GitHub blob deep-link (head sha + path + line).
  - **[#16](https://github.com/edspencer/warren/issues/16) — Repos → per-repo detail page.** Repo rows are clickable → new `/repos/:owner/:name` route backed by `GET /api/repos/:owner/:name` (aggregate stats, severity breakdown, watched status, last activity, and that repo's review history). 404s for an unknown, historyless repo.
  - **[#17](https://github.com/edspencer/warren/issues/17) — Overview surfaces signal.** Reframed around recent activity: a "Needs attention" panel (recent critical/high findings), a "Recent reviews" list, and clickable totals — not just six stat tiles.
  - **[#19](https://github.com/edspencer/warren/issues/19) — read-only per-repo config visibility.** The repo detail page shows the _effective_ config Warren applies (review model, `min_severity`, `profile`, base-branch/path filters, author allowlist, resolve-on-fix, walkthrough), read-only and secret-free.

  Dependency-light, dark-mode + mobile rules intact, auth (none|jwt) unbroken. New endpoint + view tests added.

- [#24](https://github.com/edspencer/warren/pull/24) [`9c85bf6`](https://github.com/edspencer/warren/commit/9c85bf6864f7360a34ac760159860e3ec76524e9) Thanks [@edspencer](https://github.com/edspencer)! - Richer review-detail page with GitHub links ([#14](https://github.com/edspencer/warren/issues/14), [#18](https://github.com/edspencer/warren/issues/18)). The `/reviews/:id` view now
  links out to GitHub: a prominent "View PR on GitHub" link on the header and on the
  reviews-list rows, and each finding links to its exact code location
  (`blob@headSha/path#Lline`, falling back to the PR files view). Summary and
  walkthrough render as real **markdown** (a tiny, dependency-free, XSS-safe
  renderer — headings, lists, code fences/spans, blockquotes, bold/italic, links)
  instead of an escaped `pre-wrap` blob. Findings now show a **suggested-change**
  diff block (persisted as a new `suggestion` field on history findings), an explicit
  verify status (verified/unverified) with confidence, and the review's coverage line
  and model. Dark-mode + mobile rules and the none|jwt auth layer are unchanged.

- [#23](https://github.com/edspencer/warren/pull/23) [`2c5afcb`](https://github.com/edspencer/warren/commit/2c5afcbc1692e05a692efc88a2442964a0518d01) Thanks [@edspencer](https://github.com/edspencer)! - Dashboard becomes real routed pages ([#12](https://github.com/edspencer/warren/issues/12), [#13](https://github.com/edspencer/warren/issues/13), [#20](https://github.com/edspencer/warren/issues/20)). The no-router tab-panel SPA is replaced by a History-API client router — `/`, `/repos`, `/reviews`, `/reviews/:id` are deep-linkable, bookmarkable URLs with working browser back/forward and URL-derived nav active-state; the server serves the SPA shell for every client route (SPA fallback) so hard-refresh and pasted deep links hydrate. The "Reviews over time" chart is rebuilt as an inline SVG with a real y-scale, a minimum bar height, day labels, hover tooltips and an empty state (fixes the ~1px collapse on sparse/single-day data). Adds clickable/hover/focus affordances, keyboard-navigable review rows (role=link, Enter/Space), loading skeletons, and real error/empty/not-found states. Room left for `/repos/:owner/:name` and `/findings` that later tickets add.

- [#29](https://github.com/edspencer/warren/pull/29) [`9a9a8fb`](https://github.com/edspencer/warren/commit/9a9a8fbb058951e00d397db5c7a7f74bd4d2c514) Thanks [@edspencer](https://github.com/edspencer)! - Trigger filtering & review policy ([#26](https://github.com/edspencer/warren/issues/26)). New config-driven, per-repo-overridable knobs to make Warren pleasant to run day-to-day:

  - **Skip mechanical/release PRs** (`auto_review.skip_release_prs`, default `true`): pure version/release churn is skipped by title (e.g. `chore: version packages`), branch (e.g. `changeset-release/*`), a known release-bot author, or a diff that only touches lockfiles / `CHANGELOG` / `.changeset/**`. Additive custom heuristics via `release_title_patterns` / `release_branch_patterns` / `release_authors`. An explicit `@warren review` still reviews such a PR.
  - **Trigger filters**: label gating (`auto_review.skip_labels`, default `[warren:skip]`, and `only_labels`), title/branch ignore patterns (`skip_title_patterns` / `skip_branch_patterns`), and an author `deny_authors` denylist complementing the existing allowlist. Draft handling unchanged.
  - **Review policy levers** (per-repo): `review.effort` (`low` | `normal` | `high`) controls whether the triage pass runs, the verify pass, and the reviewer's turn budget; `review.max_files` / `review.max_tokens` soft ceilings skip giant/generated PRs before spending review tokens. The existing `concurrency` cap is surfaced alongside.

  All defaults preserve prior behavior except the new default release-PR skip. `.warren.example.yaml` and the README config table document every key.

### Patch Changes

- [#11](https://github.com/edspencer/warren/pull/11) [`37d365f`](https://github.com/edspencer/warren/commit/37d365f5371c81a98d0181049d258a8ba4457d39) Thanks [@edspencer](https://github.com/edspencer)! - Responsive/mobile pass on the review dashboard ([#10](https://github.com/edspencer/warren/issues/10)): viewport safe-area handling (nothing tucks under a notch/home indicator), the iOS 16px focus-zoom fix on inputs, and small-screen layout for the nav, stat cards, and charts. Mirrors Paddock's mobile patterns.
