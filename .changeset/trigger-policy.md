---
"warren": minor
---

Trigger filtering & review policy (#26). New config-driven, per-repo-overridable knobs to make Warren pleasant to run day-to-day:

- **Skip mechanical/release PRs** (`auto_review.skip_release_prs`, default `true`): pure version/release churn is skipped by title (e.g. `chore: version packages`), branch (e.g. `changeset-release/*`), a known release-bot author, or a diff that only touches lockfiles / `CHANGELOG` / `.changeset/**`. Additive custom heuristics via `release_title_patterns` / `release_branch_patterns` / `release_authors`. An explicit `@warren review` still reviews such a PR.
- **Trigger filters**: label gating (`auto_review.skip_labels`, default `[warren:skip]`, and `only_labels`), title/branch ignore patterns (`skip_title_patterns` / `skip_branch_patterns`), and an author `deny_authors` denylist complementing the existing allowlist. Draft handling unchanged.
- **Review policy levers** (per-repo): `review.effort` (`low` | `normal` | `high`) controls whether the triage pass runs, the verify pass, and the reviewer's turn budget; `review.max_files` / `review.max_tokens` soft ceilings skip giant/generated PRs before spending review tokens. The existing `concurrency` cap is surfaced alongside.

All defaults preserve prior behavior except the new default release-PR skip. `.warren.example.yaml` and the README config table document every key.
