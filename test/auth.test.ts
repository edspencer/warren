import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import { createServer } from "../src/server/app.js";
import { makeFakeApp } from "./fake-app.js";

const SECRET = "super-secret-hs256-signing-key";

async function sign(
  claims: Record<string, unknown> = {},
  opts: { secret?: string; expSeconds?: number; issuer?: string; audience?: string } = {},
): Promise<string> {
  const key = new TextEncoder().encode(opts.secret ?? SECRET);
  let jwt = new SignJWT({ sub: "alice", ...claims }).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
  if (opts.expSeconds != null) jwt = jwt.setExpirationTime(`${opts.expSeconds}s`);
  else jwt = jwt.setExpirationTime("1h");
  if (opts.issuer) jwt = jwt.setIssuer(opts.issuer);
  if (opts.audience) jwt = jwt.setAudience(opts.audience);
  return jwt.sign(key);
}

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "warren-auth-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("auth: none mode", () => {
  it("allows /api/* without any token", async () => {
    const { app } = makeFakeApp({ dataDir, auth: { mode: "none" } });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/overview" });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it("keeps /healthz open", async () => {
    const { app } = makeFakeApp({ dataDir, auth: { mode: "none" } });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await server.close();
  });
});

describe("auth: jwt mode", () => {
  function jwtApp() {
    return makeFakeApp({ dataDir, auth: { mode: "jwt", jwtSecret: SECRET } });
  }

  it("throws at registration when jwt mode has no secret", () => {
    const { app } = makeFakeApp({ dataDir, auth: { mode: "jwt" } });
    expect(() => createServer(app)).toThrow(/WARREN_JWT_SECRET/);
  });

  it("401 on a missing token", async () => {
    const server = createServer(jwtApp().app);
    const res = await server.inject({ method: "GET", url: "/api/overview" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("auth_required");
    await server.close();
  });

  it("401 on a token signed with the wrong secret", async () => {
    const server = createServer(jwtApp().app);
    const token = await sign({}, { secret: "the-wrong-secret" });
    const res = await server.inject({
      method: "GET",
      url: "/api/overview",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("auth_invalid");
    await server.close();
  });

  it("401 on an expired token", async () => {
    const server = createServer(jwtApp().app);
    // exp in the past.
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ sub: "alice" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    const res = await server.inject({
      method: "GET",
      url: "/api/overview",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("200 on a valid signed token", async () => {
    const server = createServer(jwtApp().app);
    const token = await sign();
    const res = await server.inject({
      method: "GET",
      url: "/api/overview",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it("keeps /healthz and /api/auth-mode open in jwt mode", async () => {
    const server = createServer(jwtApp().app);
    const health = await server.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    const mode = await server.inject({ method: "GET", url: "/api/auth-mode" });
    expect(mode.statusCode).toBe(200);
    expect(mode.json()).toEqual({ mode: "jwt" });
    await server.close();
  });

  it("enforces issuer/audience when configured", async () => {
    const { app } = makeFakeApp({
      dataDir,
      auth: { mode: "jwt", jwtSecret: SECRET, jwtIssuer: "warren", jwtAudience: "dashboard" },
    });
    const server = createServer(app);

    const good = await sign({}, { issuer: "warren", audience: "dashboard" });
    const okRes = await server.inject({
      method: "GET",
      url: "/api/overview",
      headers: { authorization: `Bearer ${good}` },
    });
    expect(okRes.statusCode).toBe(200);

    const wrongAud = await sign({}, { issuer: "warren", audience: "somewhere-else" });
    const badRes = await server.inject({
      method: "GET",
      url: "/api/overview",
      headers: { authorization: `Bearer ${wrongAud}` },
    });
    expect(badRes.statusCode).toBe(401);
    await server.close();
  });
});
