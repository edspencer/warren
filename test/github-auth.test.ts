// test/github-auth.test.ts — GitHub credential providers (PAT + App installation
// tokens). The App token exchange + /app lookup are MOCKED (a real RSA key is
// generated locally and the JWT is signed for real, but GitHub's API is never
// called). Proves: JWT shape, token caching + refresh, PKCS#1 key support, bot-login
// resolution, and the factory's guards — without touching the network.

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";

import {
  AppTokenProvider,
  StaticTokenProvider,
  createTokenProvider,
} from "../src/github/auth.js";
import { RestGitHubClient } from "../src/github/client.js";

/** An RSA private key in the requested PEM encoding (pkcs1 = what GitHub hands you). */
function rsaPrivateKeyPem(format: "pkcs1" | "pkcs8"): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: format === "pkcs1" ? "pkcs1" : "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey as string;
}

/** A JSON Response like GitHub returns. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("StaticTokenProvider (pat)", () => {
  it("returns the token verbatim and describes as pat", async () => {
    const p = new StaticTokenProvider("pat-fixture-value");
    expect(await p.getToken()).toBe("pat-fixture-value");
    expect(p.describe()).toBe("pat");
  });
});

describe("AppTokenProvider (app)", () => {
  it("mints an installation token via a signed JWT and caches it", async () => {
    const pem = rsaPrivateKeyPem("pkcs1"); // GitHub's native format
    const calls: Array<{ url: string; auth: string }> = [];
    let clock = 1_700_000_000_000;

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const auth = String((init?.headers as Record<string, string>).Authorization);
      calls.push({ url: u, auth });
      // Token exchange endpoint.
      return jsonResponse({
        token: "install-token-fixture",
        expires_at: new Date(clock + 60 * 60 * 1000).toISOString(),
      });
    }) as unknown as typeof fetch;

    const provider = new AppTokenProvider({
      appId: "123456",
      installationId: "789",
      privateKeyPem: pem,
      fetchImpl,
      now: () => clock,
    });

    const t1 = await provider.getToken();
    expect(t1).toBe("install-token-fixture");
    expect(provider.describe()).toBe("app(app_id=123456, installation_id=789)");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/app/installations/789/access_tokens");

    // The exchange request is authorized with a real RS256 App JWT (iss=appId).
    const jwt = calls[0].auth.replace(/^Bearer\s+/, "");
    expect(decodeProtectedHeader(jwt).alg).toBe("RS256");
    const claims = decodeJwt(jwt);
    expect(claims.iss).toBe("123456");
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(600); // ≤10 min per GitHub

    // Second call within TTL is served from cache — no second network hit.
    const t2 = await provider.getToken();
    expect(t2).toBe("install-token-fixture");
    expect(calls).toHaveLength(1);
  });

  it("refreshes the token after it (nearly) expires", async () => {
    const pem = rsaPrivateKeyPem("pkcs8"); // also accept PKCS#8
    let clock = 1_700_000_000_000;
    let issued = 0;
    const fetchImpl = (async () => {
      issued += 1;
      return jsonResponse({
        token: `install-token-${issued}`,
        expires_at: new Date(clock + 120_000).toISOString(), // 2-min TTL
      });
    }) as unknown as typeof fetch;

    const provider = new AppTokenProvider({
      appId: "1",
      installationId: "2",
      privateKeyPem: pem,
      fetchImpl,
      now: () => clock,
    });

    expect(await provider.getToken()).toBe("install-token-1");
    // Advance past expiry minus the 60s skew → forces a refresh.
    clock += 121_000;
    expect(await provider.getToken()).toBe("install-token-2");
    expect(issued).toBe(2);
  });

  it("coalesces concurrent refreshes into a single network call", async () => {
    const pem = rsaPrivateKeyPem("pkcs1");
    let hits = 0;
    const fetchImpl = (async () => {
      hits += 1;
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse({ token: "install-token-x", expires_at: new Date(Date.now() + 3.6e6).toISOString() });
    }) as unknown as typeof fetch;

    const provider = new AppTokenProvider({
      appId: "1",
      installationId: "2",
      privateKeyPem: pem,
      fetchImpl,
    });
    const [a, b, c] = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect([a, b, c]).toEqual(["install-token-x", "install-token-x", "install-token-x"]);
    expect(hits).toBe(1);
  });

  it("throws (status only, no body leak) when the exchange fails", async () => {
    const pem = rsaPrivateKeyPem("pkcs1");
    const fetchImpl = (async () =>
      new Response("secret-context", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    const provider = new AppTokenProvider({
      appId: "1",
      installationId: "2",
      privateKeyPem: pem,
      fetchImpl,
    });
    await expect(provider.getToken()).rejects.toThrow(/401 Unauthorized/);
    await expect(provider.getToken()).rejects.not.toThrow(/secret-context/);
  });

  it("resolves the bot login from GET /app (best-effort)", async () => {
    const pem = rsaPrivateKeyPem("pkcs1");
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/app")) return jsonResponse({ slug: "warren" });
      return jsonResponse({ token: "install-token-x", expires_at: new Date(Date.now() + 3.6e6).toISOString() });
    }) as unknown as typeof fetch;
    const provider = new AppTokenProvider({
      appId: "1",
      installationId: "2",
      privateKeyPem: pem,
      fetchImpl,
    });
    expect(await provider.getBotLogin()).toBe("warren[bot]");
    // cached — no throw on repeat
    expect(await provider.getBotLogin()).toBe("warren[bot]");
  });

  it("bot-login resolution is non-throwing on error", async () => {
    const pem = rsaPrivateKeyPem("pkcs1");
    const fetchImpl = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const provider = new AppTokenProvider({
      appId: "1",
      installationId: "2",
      privateKeyPem: pem,
      fetchImpl,
    });
    expect(await provider.getBotLogin()).toBeNull();
  });
});

describe("createTokenProvider factory", () => {
  it("pat mode with a token → StaticTokenProvider", async () => {
    const p = createTokenProvider({ mode: "pat", token: "pat-fixture-x" });
    expect(p).toBeInstanceOf(StaticTokenProvider);
    expect(await p!.getToken()).toBe("pat-fixture-x");
  });

  it("pat mode without a token → null (no credential is not fatal)", () => {
    expect(createTokenProvider({ mode: "pat" })).toBeNull();
  });

  it("app mode requires appId + installationId + privateKey", () => {
    expect(() => createTokenProvider({ mode: "app", appId: "1" })).toThrow(/requires an App ID/);
    const p = createTokenProvider({
      mode: "app",
      appId: "1",
      installationId: "2",
      privateKeyPem: rsaPrivateKeyPem("pkcs1"),
    });
    expect(p).toBeInstanceOf(AppTokenProvider);
  });
});

describe("RestGitHubClient sources its bearer from the provider", () => {
  it("uses a fresh (rotating) token per request", async () => {
    const seen: string[] = [];
    let n = 0;
    const rotating = {
      async getToken() {
        n += 1;
        return `tok_${n}`;
      },
      describe: () => "test",
    };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      return jsonResponse({
        number: 1,
        title: "t",
        body: "",
        state: "open",
        html_url: "",
        user: { login: "u" },
        head: { sha: "h", ref: "feat" },
        base: { sha: "b", ref: "main" },
      });
    }) as unknown as typeof fetch;

    const client = new RestGitHubClient({ tokenProvider: rotating, fetchImpl });
    await client.getPr({ owner: "o", name: "r" }, 1);
    await client.getPr({ owner: "o", name: "r" }, 1);
    expect(seen).toEqual(["Bearer tok_1", "Bearer tok_2"]);
  });
});
