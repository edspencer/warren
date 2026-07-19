// test/webhook-verify.test.ts — GitHub webhook HMAC signature verification.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

import {
  computeSignature,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
} from "../src/trigger/webhook-verify.js";

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ action: "opened", number: 7 });

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("computeSignature", () => {
  it("matches an independent HMAC-SHA256 of the body", () => {
    expect(computeSignature(SECRET, BODY)).toBe(sign(SECRET, BODY));
    expect(computeSignature(SECRET, BODY)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a correct signature", () => {
    expect(verifyWebhookSignature(SECRET, BODY, sign(SECRET, BODY))).toBe(true);
  });

  it("accepts a Buffer body identically to a string body", () => {
    const sig = sign(SECRET, BODY);
    expect(verifyWebhookSignature(SECRET, Buffer.from(BODY), sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = sign(SECRET, BODY);
    expect(verifyWebhookSignature(SECRET, BODY + " ", sig)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyWebhookSignature(SECRET, BODY, sign("wrong", BODY))).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyWebhookSignature(SECRET, BODY, undefined)).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, "")).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, "deadbeef")).toBe(false); // no scheme
    // The deprecated sha1 scheme is not accepted.
    expect(verifyWebhookSignature(SECRET, BODY, "sha1=" + "0".repeat(40))).toBe(false);
  });

  it("rejects when no secret is configured (fails closed)", () => {
    expect(verifyWebhookSignature(undefined, BODY, sign(SECRET, BODY))).toBe(false);
    expect(verifyWebhookSignature("", BODY, sign(SECRET, BODY))).toBe(false);
  });

  it("rejects a length-mismatched signature without throwing", () => {
    expect(verifyWebhookSignature(SECRET, BODY, "sha256=abc")).toBe(false);
  });

  it("exports the canonical header name", () => {
    expect(SIGNATURE_HEADER).toBe("x-hub-signature-256");
  });
});
