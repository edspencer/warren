---
"warren": minor
---

Config editing UI — make the dashboard configuration editable, backed by the `.warren.yaml` text file (#27), building on the read-only effective-config view (#19).

- **Backend.** New `GET /api/config` returns the current server config as structured data (snake_case, defaults materialized) + the raw file text — secret-free (secrets live in env, never in config). New `PUT /api/config` validates the submission against the Zod schema, writes it to the resolved config path, and **hot-reloads it in place** (applies on the next poll / next review) via `reloadWarrenConfigInto` on the container. Accepts `{ yaml }` (raw text, written verbatim so comments/formatting survive) or `{ config }` (structured, serialized to YAML). Invalid config → **400** with per-issue details, and the on-disk file is left untouched.
- **Write auth guard.** Config writes are hard-gated on `WARREN_AUTH_MODE=jwt`: in `none` mode `PUT /api/config` is refused (**403**) so an unauthenticated LAN deploy can't rewrite the review policy; in `jwt` mode the existing auth hook already enforces a valid bearer token (**401** without).
- **Frontend.** New `/settings` route + nav entry. A schema-driven **generic form** (walks the structured config, so newly-added knobs appear automatically) for scalar/array fields, plus a **raw-YAML editor** with validate-on-save. Save success / validation-error surfacing, editing disabled with a notice in `none` mode. Dark-mode + mobile + dependency-light, consistent with the existing SPA.

In-repo `.warren.yaml` (a config committed in each reviewed repo, CodeRabbit-style) is split out as a follow-up (#28). Existing tests stay green (+13), `tsc` clean.
