---
"warren": minor
---

Token/cost usage ledger + global rate limits (cost & runaway-loop protection):

- **Real token accounting.** Each review now captures its actual token usage (input +
  output, summed across the triage/review/verify passes) from the SDK result message,
  and computes a **notional** list-price cost from a per-model price table. Both are
  recorded on every history record and surfaced per-review + aggregated (hour / day /
  month / all-time) on the dashboard's new **Spend** panel and at `GET /api/usage`. On
  the default `cli` (Max-plan) runtime billing is flat, so the dollar figure is a
  budgeting signal, not an invoice — but the token counts are exact. Old history records
  (no usage field) degrade gracefully.

- **Global time-windowed rate limits.** New `limits` config block —
  `reviews_per_hour|day`, `tokens_per_hour|day`, `cost_per_day_usd` (all `0` = off) —
  enforced before a review spends any tokens, counting completed reviews (from history)
  plus in-flight ones. Count windows are noise control (an explicit `@warren review`
  bypasses them); spend windows are a hard budget ceiling (they apply even to commands).
  A rate-limited auto-review **defers** — it doesn't advance `lastReviewedSha`, so the
  next poll retries once the window frees. Limits are server-level/global.

- **Model choice is cost-tunable.** Documented that `models.{triage,review,verify}`
  accept any Claude id (global or per-repo `overrides`), so a busy repo can run
  `review` on `claude-sonnet-5` / `claude-haiku-4-5` to trade depth for spend. Known
  families (opus/sonnet/haiku/fable) are priced in the ledger; an unknown id still runs,
  priced at the Opus rate as a conservative fallback.
