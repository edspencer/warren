---
"warren": minor
---

Harden the reviewer against untrusted PR code (#31):

- **Checkout token leak fixed.** The GitHub PR is now cloned with a credential-free
  remote URL; the token is supplied to `git` via a command-scoped credential helper
  that reads it from the process environment, so no token-bearing string is written to
  the checkout's `.git/config` (was `https://x-access-token:<token>@…`). Reusing a
  checkout also scrubs any legacy token a pre-hardening run persisted.
- **Execution policy — `review.execution: static | full | trusted` (default `static`).**
  `static` removes `Bash` from the review/verify/ask agents entirely, so untrusted PR
  code is inspected but never executed; `full` allows Bash (trusted repos); `trusted`
  allows it only for authors on `auto_review.authors` (empty allowlist ⇒ nobody).
  Per-repo overridable. The Bash denylist is tightened (curl/wget/nc/ssh/git config) as
  defense-in-depth only.
- **Sandbox + egress (design-only).** New `SECURITY.md` threat model plus schema-wired
  `sandbox.mode` / `sandbox.egress_allowlist` / resource-limit knobs for a roadmap
  ephemeral-container sandbox with a GitHub+Anthropic-only egress allowlist. Clearly
  marked implemented vs. design-only (the container runtime is not yet enforced).
