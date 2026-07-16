---
"warren": minor
---

Safety: author allowlist (#21). New `auto_review.authors` config (default `[]` = review everyone, unchanged) restricts which PR authors Warren auto-reviews and comments on — case-insensitive login match. When set, non-allowlisted authors' PRs are never enqueued or commented on, and `@warren` commands on their PRs are ignored (gated on the PR author). Scope a fresh install to just your own login while testing.
