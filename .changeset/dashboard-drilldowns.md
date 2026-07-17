---
"warren": minor
---

Dashboard drill-down pages + endpoints on top of the new routing (#15, #16, #17, #19).

- **#15 — severity drill-down → Findings list.** New `GET /api/findings?severity=&repo=&verified=` flattens findings across every review with the context to link each back to its review (+ GitHub). Overview severity bars and the totals cards are now clickable, landing on a new deep-linkable `/findings` route filtered by severity/repo; each finding links to its review, its repo, and a GitHub blob deep-link (head sha + path + line).
- **#16 — Repos → per-repo detail page.** Repo rows are clickable → new `/repos/:owner/:name` route backed by `GET /api/repos/:owner/:name` (aggregate stats, severity breakdown, watched status, last activity, and that repo's review history). 404s for an unknown, historyless repo.
- **#17 — Overview surfaces signal.** Reframed around recent activity: a "Needs attention" panel (recent critical/high findings), a "Recent reviews" list, and clickable totals — not just six stat tiles.
- **#19 — read-only per-repo config visibility.** The repo detail page shows the *effective* config Warren applies (review model, `min_severity`, `profile`, base-branch/path filters, author allowlist, resolve-on-fix, walkthrough), read-only and secret-free.

Dependency-light, dark-mode + mobile rules intact, auth (none|jwt) unbroken. New endpoint + view tests added.
