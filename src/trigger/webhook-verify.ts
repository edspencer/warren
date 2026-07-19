// src/trigger/webhook-verify.ts — GitHub webhook signature verification.
//
// GitHub signs every webhook delivery with `X-Hub-Signature-256: sha256=<hex>`,
// an HMAC-SHA256 of the RAW request body keyed by the shared webhook secret. This
// module verifies that signature in constant time so Warren's eventual webhook
// ingress can only be driven by GitHub (or whoever holds the secret) — never by an
// unauthenticated caller who found the URL.
//
// Pure + dependency-free (node:crypto only). The secret and the signature are
// NEVER logged. The full webhook→ReviewEvent delivery path is a follow-up; this
// lands the security primitive + config so the endpoint is safe from day one.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The header GitHub sends the HMAC-SHA256 signature in. */
export const SIGNATURE_HEADER = "x-hub-signature-256";

/** Compute the expected `sha256=<hex>` signature for a body under a secret. */
export function computeSignature(secret: string, body: string | Buffer): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the raw body. Returns false
 * (never throws) on a missing/malformed header, an empty secret, or any mismatch.
 * The compare is constant-time to avoid leaking the secret via timing.
 */
export function verifyWebhookSignature(
  secret: string | undefined,
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!secret) return false;
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  // Only the sha256 scheme is accepted (sha1 is deprecated + weaker).
  if (!signatureHeader.startsWith("sha256=")) return false;

  const expected = computeSignature(secret, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  // timingSafeEqual throws on unequal lengths — guard first, still constant-time
  // for equal-length-but-different inputs (the security-relevant case).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
