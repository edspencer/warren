// src/github/auth.ts — GitHub credential providers.
//
// Warren authenticates to GitHub one of two ways, selected by `github.auth`:
//
//   • pat  — a static Personal Access Token (the default; legacy behavior). The
//            token is used verbatim on every request.
//   • app  — a GitHub App identity. Warren signs a short-lived RS256 JWT with the
//            App's private key, exchanges it for a per-INSTALLATION access token
//            (scoped, ~1h TTL), and refreshes that token before it expires. The
//            client sources its bearer transparently via `getToken()` so no call
//            site changes when the mode flips.
//
// A TokenProvider is the seam the REST/GraphQL client depends on. Secrets (the
// PAT, the App private key, the minted installation token) are NEVER logged — the
// only thing `describe()` ever surfaces is the non-secret mode + App/installation
// identifiers.
//
// The App JWT is built with `jose` (already a dep) over a Node `crypto.KeyObject`
// so BOTH PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub hands you) and PKCS#8
// (`BEGIN PRIVATE KEY`) private keys work without the operator running openssl.

import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";

import type { Logger } from "../types.js";

// ─────────────────────────── Provider seam ───────────────────────────

/**
 * Supplies a currently-valid GitHub bearer token. `getToken()` is called before
 * every request (or batch of requests) — a static impl returns instantly; the App
 * impl returns a cached installation token and only hits the network to mint/refresh.
 */
export interface TokenProvider {
  /** A valid bearer token for the GitHub REST/GraphQL API. */
  getToken(): Promise<string>;
  /** Log-safe description (mode + non-secret ids). NEVER includes a token. */
  describe(): string;
}

// ─────────────────────────── PAT (static) ───────────────────────────

/** A fixed Personal Access Token. Legacy/default path — identical to prior behavior. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
  describe(): string {
    return "pat";
  }
}

// ─────────────────────────── GitHub App ───────────────────────────

const DEFAULT_API_BASE_URL = "https://api.github.com";
/** Refresh an installation token this many ms BEFORE its stated expiry. */
const EXPIRY_SKEW_MS = 60_000;
/** App JWT lifetime. GitHub caps it at 10 min; 9 leaves headroom for clock drift. */
const JWT_TTL_SEC = 9 * 60;
/** Backdate `iat` to absorb clock skew between Warren and GitHub. */
const JWT_IAT_BACKDATE_SEC = 60;

export interface AppTokenProviderOptions {
  /** The GitHub App's numeric App ID (as a string; not a secret). */
  appId: string;
  /** The installation id the token is minted for (not a secret). */
  installationId: string;
  /** The App's RSA private key, PEM text (PKCS#1 or PKCS#8). SECRET — never logged. */
  privateKeyPem: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Injectable clock (ms). Defaults to Date.now — overridden in tests. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  /** Absolute expiry (ms epoch) as reported by GitHub. */
  expiresAtMs: number;
}

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Mints and caches per-installation access tokens for a GitHub App. Thread-safe
 * enough for Warren's single-process use: concurrent `getToken()` calls that race
 * a refresh share one in-flight promise so the token endpoint is hit at most once.
 */
export class AppTokenProvider implements TokenProvider {
  private readonly appId: string;
  private readonly installationId: string;
  private readonly privateKeyPem: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly now: () => number;

  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;
  private botLoginCache: string | null = null;

  constructor(opts: AppTokenProviderOptions) {
    if (!opts.appId) throw new Error("AppTokenProvider: appId is required");
    if (!opts.installationId) {
      throw new Error("AppTokenProvider: installationId is required");
    }
    if (!opts.privateKeyPem || !opts.privateKeyPem.includes("PRIVATE KEY")) {
      throw new Error("AppTokenProvider: a PEM private key is required");
    }
    this.appId = opts.appId;
    this.installationId = opts.installationId;
    this.privateKeyPem = opts.privateKeyPem;
    this.apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
  }

  describe(): string {
    return `app(app_id=${this.appId}, installation_id=${this.installationId})`;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - EXPIRY_SKEW_MS > this.now()) {
      return this.cached.token;
    }
    // Coalesce concurrent refreshes onto one network call.
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Force a refresh of the installation token (mint via the App JWT). */
  private async refresh(): Promise<string> {
    const jwt = await this.signAppJwt();
    const url = `${this.apiBaseUrl}/app/installations/${encodeURIComponent(
      this.installationId,
    )}/access_tokens`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${jwt}`,
      },
    });
    if (!res.ok) {
      // Do NOT include the body verbatim — it can echo request context. Status only.
      throw new Error(
        `GitHub App token exchange failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token) {
      throw new Error("GitHub App token exchange returned no token");
    }
    const expiresAtMs = body.expires_at
      ? Date.parse(body.expires_at)
      : this.now() + 55 * 60_000;
    this.cached = {
      token: body.token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() + 55 * 60_000,
    };
    this.logger.info(
      `github-app: minted installation token (expires ${
        body.expires_at ?? "in ~1h"
      })`,
    );
    return this.cached.token;
  }

  /**
   * The App's bot login, `${app-slug}[bot]`, resolved once by reading `GET /app`
   * with the App JWT. Best-effort: on any error returns null so callers can fall
   * back to config or the marker-based self-comment detection. NEVER throws.
   */
  async getBotLogin(): Promise<string | null> {
    if (this.botLoginCache) return this.botLoginCache;
    try {
      const jwt = await this.signAppJwt();
      const res = await this.fetchImpl(`${this.apiBaseUrl}/app`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${jwt}`,
        },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { slug?: string };
      if (!body.slug) return null;
      this.botLoginCache = `${body.slug}[bot]`;
      return this.botLoginCache;
    } catch (err) {
      this.logger.debug(
        `github-app: could not resolve bot login (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return null;
    }
  }

  /** Sign a short-lived App JWT (RS256). iss=appId, iat backdated, exp≤10min. */
  private async signAppJwt(): Promise<string> {
    const key = createPrivateKey(this.privateKeyPem);
    const nowSec = Math.floor(this.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.appId)
      .setIssuedAt(nowSec - JWT_IAT_BACKDATE_SEC)
      .setExpirationTime(nowSec + JWT_TTL_SEC)
      .sign(key);
  }
}

// ─────────────────────────── Factory ───────────────────────────

export interface CreateTokenProviderOptions {
  mode: "pat" | "app";
  /** PAT (pat mode). */
  token?: string;
  /** App identity (app mode). */
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => number;
}

/**
 * Build a TokenProvider for the configured auth mode. Returns null in `pat` mode
 * when no token is present (the caller decides whether that's fatal — a local-git-
 * only deploy needs no GitHub credential). In `app` mode a missing App ID /
 * installation id / private key is a hard misconfiguration and throws loudly.
 */
export function createTokenProvider(
  opts: CreateTokenProviderOptions,
): TokenProvider | null {
  if (opts.mode === "app") {
    if (!opts.appId || !opts.installationId || !opts.privateKeyPem) {
      throw new Error(
        "github.auth=app requires an App ID, an installation id, and a private key " +
          "(set app_id / installation_id in .warren.yaml and provide the private key " +
          "via private_key_path or the private_key_env env var).",
      );
    }
    return new AppTokenProvider({
      appId: opts.appId,
      installationId: opts.installationId,
      privateKeyPem: opts.privateKeyPem,
      apiBaseUrl: opts.apiBaseUrl,
      fetchImpl: opts.fetchImpl,
      logger: opts.logger,
      now: opts.now,
    });
  }
  // pat mode
  if (!opts.token) return null;
  return new StaticTokenProvider(opts.token);
}
