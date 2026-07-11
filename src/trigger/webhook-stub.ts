// src/trigger/webhook-stub.ts — WebhookStubTriggerSource (SPEC §3.2, M4 placeholder).
//
// The webhook/tunnel trigger is OUT OF SCOPE for v1 (poll is the M1 default, outbound-
// only, needs no public ingress). This stub exists so `createTriggerSource` can return
// the SAME `TriggerSource` shape for `mode: "webhook" | "tunnel"` and the two are
// swappable the day the real impl lands — without any container changes. `start()`
// throws so a misconfiguration fails loudly instead of silently producing nothing.
//
// ─── M4 TODO (real WebhookTriggerSource) ─────────────────────────────────────────
//  1. Stand up (or accept from the container) an HTTP route `POST /webhook`.
//  2. Verify `X-Hub-Signature-256`: HMAC-SHA256 of the RAW body with the secret from
//     `deps.config.trigger.secretEnv` (env var name); constant-time compare; reject on
//     mismatch/missing. NEVER log the secret or the signature.
//  3. Map GitHub event payloads → ReviewEvent and call `emit`:
//       • `pull_request` action `opened`/`reopened`   → reason "new_pr", full false
//       • `pull_request` action `synchronize`         → reason "new_head", full false
//       • `issue_comment`/`pull_request_review_comment` created → parse via
//         `parseWarrenCommand`; emit reason "command" (apply pause/resume to state,
//         mirroring PollTriggerSource.scanCommands).
//     Reuse the same draft / base-branch / paused-ignored gating as poll mode so the
//     two sources are behaviorally identical apart from their transport.
//  4. `stop()` closes the route/listener; keep it idempotent.
// No crypto/HTTP is wired here yet — only the swappable interface shape.

import type { ReviewEvent } from "../types.js";
import type { TriggerMode } from "./source.js";
import type { TriggerSource, TriggerSourceDeps } from "./source.js";

export class WebhookStubTriggerSource implements TriggerSource {
  constructor(
    private readonly deps: TriggerSourceDeps,
    private readonly mode: TriggerMode,
  ) {}

  async start(_emit: (e: ReviewEvent) => void): Promise<void> {
    this.deps.logger.error(
      `${this.mode} trigger not implemented in v1; set trigger.mode: "poll"`,
    );
    throw new Error(`${this.mode} trigger not implemented in v1; use poll mode`);
  }

  async stop(): Promise<void> {
    // Nothing to release (no listener was ever opened). Idempotent.
  }
}
