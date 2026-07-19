// test/webhook-route.test.ts — the gated POST /webhook ingress (#32).
// The route exists only when a webhook secret is configured, verifies the
// X-Hub-Signature-256 over the RAW body, and is NOT behind the /api bearer gate.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server/app.js";
import { makeFakeApp } from "./fake-app.js";

const SECRET = "test-webhook-secret";
const PAYLOAD = JSON.stringify({ action: "opened", number: 5 });

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "warren-wh-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("POST /webhook", () => {
  it("404s when no webhook secret is configured (route not registered)", async () => {
    const { app } = makeFakeApp({ dataDir });
    const server = createServer(app);
    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: PAYLOAD,
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it("accepts (202) a correctly-signed delivery", async () => {
    const { app } = makeFakeApp({ dataDir, webhookSecret: SECRET });
    const server = createServer(app);
    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(SECRET, PAYLOAD) },
      payload: PAYLOAD,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, delivered: false });
    await server.close();
  });

  it("rejects (401) a missing or wrong signature", async () => {
    const { app } = makeFakeApp({ dataDir, webhookSecret: SECRET });
    const server = createServer(app);

    const noSig = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: PAYLOAD,
    });
    expect(noSig.statusCode).toBe(401);

    const wrong = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign("nope", PAYLOAD) },
      payload: PAYLOAD,
    });
    expect(wrong.statusCode).toBe(401);
    await server.close();
  });

  it("is not behind the /api jwt gate (signature is the auth) even in jwt mode", async () => {
    const { app } = makeFakeApp({
      dataDir,
      webhookSecret: SECRET,
      auth: { mode: "jwt", jwtSecret: "x" },
    });
    const server = createServer(app);
    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(SECRET, PAYLOAD) },
      payload: PAYLOAD,
    });
    // No bearer token supplied, yet a valid signature is accepted.
    expect(res.statusCode).toBe(202);
    await server.close();
  });
});
