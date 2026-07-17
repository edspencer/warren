---
"warren": minor
---

Richer review-detail page with GitHub links (#14, #18). The `/reviews/:id` view now
links out to GitHub: a prominent "View PR on GitHub" link on the header and on the
reviews-list rows, and each finding links to its exact code location
(`blob@headSha/path#Lline`, falling back to the PR files view). Summary and
walkthrough render as real **markdown** (a tiny, dependency-free, XSS-safe
renderer — headings, lists, code fences/spans, blockquotes, bold/italic, links)
instead of an escaped `pre-wrap` blob. Findings now show a **suggested-change**
diff block (persisted as a new `suggestion` field on history findings), an explicit
verify status (verified/unverified) with confidence, and the review's coverage line
and model. Dark-mode + mobile rules and the none|jwt auth layer are unchanged.
