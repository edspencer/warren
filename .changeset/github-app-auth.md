---
"warren": minor
---

GitHub App identity, per-installation tokens, command authorization & webhook signature verification (#32).

Adds a GitHub App auth path alongside the default PAT (additive, config-flagged — PAT behavior is unchanged):

- **App auth provider** — `github.auth: pat | app` (default `pat`). In `app` mode Warren signs a short-lived RS256 JWT with the App private key (PKCS#1 or PKCS#8 accepted), exchanges it for a scoped, ~1h **per-installation access token** (cached + auto-refreshed), and the GitHub client sources its bearer transparently. Comments post as `<app-slug>[bot]`.
- **Bot identity** — the bot login is threaded through the command scanner / self-comment detection (auto-resolved from `GET /app` in app mode, or set via `github.bot_login` / `GITHUB_BOT_LOGIN`).
- **Command authorization** — `@warren` commands can be gated on the commenter's repo permission via `auto_review.command_associations` (e.g. `[OWNER, MEMBER, COLLABORATOR]`), composed with the existing author allow/deny lists. Empty (default) keeps the legacy "any commenter" behavior.
- **Webhook signature verification** — a timing-safe `X-Hub-Signature-256` HMAC verifier; when `WARREN_WEBHOOK_SECRET` is set, Warren exposes a signature-verified `POST /webhook` (full delivery→review is a follow-up).
- **Secret-free config** — new `github.*` knobs hold only the auth mode, non-secret ids, and the NAMES of env vars / file paths for secrets. The App private key and webhook secret come from the environment / a mounted file, never from `.warren.yaml`. See the README "GitHub App identity" section for the one-time registration + install steps.
