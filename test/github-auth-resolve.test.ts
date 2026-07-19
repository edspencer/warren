// test/github-auth-resolve.test.ts — the container's GitHub-auth resolution:
// selects PAT vs App from config+env, reads secrets from the env by their
// CONFIGURED name (never from config), and resolves the webhook secret + bot login.

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import { resolveGithubAuth } from "../src/container.js";
import { defaultWarrenConfig } from "../src/config/load.js";
import { readEnv } from "../src/config/env.js";
import { AppTokenProvider, StaticTokenProvider } from "../src/github/auth.js";
import type { Logger, WarrenConfig } from "../src/types.js";

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function pkcs1(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey as string;
}

function withGithub(over: Partial<WarrenConfig["github"]>): WarrenConfig {
  const cfg = defaultWarrenConfig();
  return { ...cfg, github: { ...cfg.github, ...over } };
}

describe("resolveGithubAuth — pat (default)", () => {
  it("wraps GITHUB_TOKEN in a StaticTokenProvider and passes the webhook secret", async () => {
    const source = { GITHUB_TOKEN: "pat-fixture-abc", WARREN_WEBHOOK_SECRET: "whsec" };
    const env = readEnv(source);
    const auth = await resolveGithubAuth(defaultWarrenConfig(), env, source, silent);
    expect(auth.mode).toBe("pat");
    expect(auth.tokenProvider).toBeInstanceOf(StaticTokenProvider);
    expect(await auth.tokenProvider!.getToken()).toBe("pat-fixture-abc");
    expect(auth.webhookSecret).toBe("whsec");
  });

  it("no token → null provider (not fatal)", async () => {
    const source = {};
    const auth = await resolveGithubAuth(defaultWarrenConfig(), readEnv(source), source, silent);
    expect(auth.tokenProvider).toBeNull();
    expect(auth.webhookSecret).toBeUndefined();
  });
});

describe("resolveGithubAuth — app", () => {
  it("builds an AppTokenProvider, reading the private key from the configured env var", async () => {
    const config = withGithub({
      auth: "app",
      appId: "42",
      installationId: "99",
      botLogin: "warren[bot]", // set so no GET /app network call is made
      privateKeyEnv: "MY_APP_KEY",
    });
    const source = { MY_APP_KEY: pkcs1(), WARREN_WEBHOOK_SECRET: "wh" };
    const auth = await resolveGithubAuth(config, readEnv(source), source, silent);
    expect(auth.mode).toBe("app");
    expect(auth.tokenProvider).toBeInstanceOf(AppTokenProvider);
    expect(auth.botLogin).toBe("warren[bot]");
    expect(auth.webhookSecret).toBe("wh");
  });

  it("env (GITHUB_AUTH_MODE/APP_ID/…) overrides config; bot login override wins", async () => {
    const config = withGithub({ auth: "pat" });
    const source = {
      GITHUB_AUTH_MODE: "app",
      GITHUB_APP_ID: "7",
      GITHUB_APP_INSTALLATION_ID: "8",
      GITHUB_BOT_LOGIN: "custom[bot]",
      GITHUB_APP_PRIVATE_KEY: pkcs1(),
    };
    const auth = await resolveGithubAuth(config, readEnv(source), source, silent);
    expect(auth.mode).toBe("app");
    expect(auth.tokenProvider).toBeInstanceOf(AppTokenProvider);
    expect(auth.tokenProvider!.describe()).toBe("app(app_id=7, installation_id=8)");
    expect(auth.botLogin).toBe("custom[bot]");
  });

  it("app mode without a private key throws a clear misconfig error", async () => {
    const config = withGithub({ auth: "app", appId: "1", installationId: "2", botLogin: "x[bot]" });
    const source = {}; // no key anywhere
    await expect(
      resolveGithubAuth(config, readEnv(source), source, silent),
    ).rejects.toThrow(/requires an App ID/);
  });
});
