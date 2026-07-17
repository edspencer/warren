---
"warren": minor
---

Dashboard becomes real routed pages (#12, #13, #20). The no-router tab-panel SPA is replaced by a History-API client router — `/`, `/repos`, `/reviews`, `/reviews/:id` are deep-linkable, bookmarkable URLs with working browser back/forward and URL-derived nav active-state; the server serves the SPA shell for every client route (SPA fallback) so hard-refresh and pasted deep links hydrate. The "Reviews over time" chart is rebuilt as an inline SVG with a real y-scale, a minimum bar height, day labels, hover tooltips and an empty state (fixes the ~1px collapse on sparse/single-day data). Adds clickable/hover/focus affordances, keyboard-navigable review rows (role=link, Enter/Space), loading skeletons, and real error/empty/not-found states. Room left for `/repos/:owner/:name` and `/findings` that later tickets add.
