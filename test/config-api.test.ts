import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import { createServer } from "../src/server/app.js";
import { makeFakeApp } from "./fake-app.js";

const SECRET = "config-editor-hs256-signing-key";

async function sign(): Promise<string> {
  const key = new TextEncoder().encode(SECRET);
  return new SignJWT({ sub: "alice" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

let dataDir: string;
let configPath: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "warren-cfg-"));
  configPath = join(dataDir, ".warren.yaml");
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("GET /api/config", () => {
  it("returns structured (defaults materialized) + raw text, secret-free, when no file exists", async () => {
    const { app } = makeFakeApp({ dataDir, configPath });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // snake_case structured config with defaults applied.
    expect(body.config.min_severity).toBe("low");
    expect(body.config.profile).toBe("chill");
    expect(body.config.models.review).toBeTruthy();
    expect(body.exists).toBe(false);
    // raw is a serialized default when the file is absent (valid starting point).
    expect(body.raw).toContain("min_severity");
    // Never leaks a token or the absolute server path.
    expect(JSON.stringify(body)).not.toContain("token");
    expect(body.path).toBe(".warren.yaml");
    expect(body.authMode).toBe("none");
    expect(body.editable).toBe(false);
    await server.close();
  });

  it("reflects an existing config file's content", async () => {
    await writeFile(configPath, "min_severity: high\nprofile: assertive\n", "utf8");
    const { app } = makeFakeApp({ dataDir, configPath });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/config" });
    const body = res.json();
    expect(body.exists).toBe(true);
    expect(body.config.min_severity).toBe("high");
    expect(body.config.profile).toBe("assertive");
    expect(body.raw).toContain("min_severity: high");
    await server.close();
  });

  it("does not 500 on a malformed/invalid on-disk config — returns raw text + default structured", async () => {
    // Schema-invalid value that WarrenConfigRawZ.parse would throw on.
    await writeFile(configPath, "min_severity: catastrophic\nprofile: chill\n", "utf8");
    const { app } = makeFakeApp({ dataDir, configPath });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Falls back to a valid default structured config so the editor can render.
    expect(body.config.min_severity).toBe("low");
    // Still surfaces the raw (broken) text so the operator can fix it in place.
    expect(body.raw).toContain("catastrophic");
    expect(body.exists).toBe(true);
    await server.close();
  });

  it("does not 500 on malformed YAML on disk either", async () => {
    await writeFile(configPath, "min_severity: [unclosed\n", "utf8");
    const { app } = makeFakeApp({ dataDir, configPath });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.min_severity).toBe("low");
    expect(res.json().raw).toContain("unclosed");
    await server.close();
  });

  it("is editable=true in jwt mode (with a valid token)", async () => {
    const { app } = makeFakeApp({ dataDir, configPath, auth: { mode: "jwt", jwtSecret: SECRET } });
    const server = createServer(app);
    const res = await server.inject({
      method: "GET",
      url: "/api/config",
      headers: { authorization: `Bearer ${await sign()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().editable).toBe(true);
    await server.close();
  });
});

describe("PUT /api/config — auth guard", () => {
  it("403s in none mode (config writes disabled without jwt)", async () => {
    const { app } = makeFakeApp({ dataDir, configPath, auth: { mode: "none" } });
    const server = createServer(app);
    const res = await server.inject({
      method: "PUT",
      url: "/api/config",
      payload: { yaml: "min_severity: high\n" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("auth_mode_required");
    // Nothing written.
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
    await server.close();
  });

  it("401s in jwt mode without a token", async () => {
    const { app } = makeFakeApp({ dataDir, configPath, auth: { mode: "jwt", jwtSecret: SECRET } });
    const server = createServer(app);
    const res = await server.inject({
      method: "PUT",
      url: "/api/config",
      payload: { yaml: "min_severity: high\n" },
    });
    expect(res.statusCode).toBe(401);
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
    await server.close();
  });

  it("401s in jwt mode with a token signed by the wrong secret", async () => {
    const { app } = makeFakeApp({ dataDir, configPath, auth: { mode: "jwt", jwtSecret: SECRET } });
    const server = createServer(app);
    const badKey = new TextEncoder().encode("nope-nope-nope");
    const badToken = await new SignJWT({ sub: "mallory" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(badKey);
    const res = await server.inject({
      method: "PUT",
      url: "/api/config",
      headers: { authorization: `Bearer ${badToken}` },
      payload: { yaml: "min_severity: high\n" },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});

describe("PUT /api/config — write + validate + hot-reload", () => {
  function jwtApp() {
    return makeFakeApp({ dataDir, configPath, auth: { mode: "jwt", jwtSecret: SECRET } });
  }

  it("writes raw YAML, validates it, and hot-reloads the live config", async () => {
    const { app } = jwtApp();
    const server = createServer(app);
    const token = await sign();

    // Baseline: default min_severity is "low".
    expect(app.config.minSeverity).toBe("low");

    const put = await server.inject({
      method: "PUT",
      url: "/api/config",
      headers: { authorization: `Bearer ${token}` },
      payload: { yaml: "min_severity: high\nprofile: assertive\n" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().applied).toBe(true);

    // File written verbatim.
    expect(await readFile(configPath, "utf8")).toContain("min_severity: high");
    // Live config hot-reloaded in place (camelCase domain type).
    expect(app.config.minSeverity).toBe("high");
    expect(app.config.profile).toBe("assertive");

    // GET now reflects it.
    const get = await server.inject({
      method: "GET",
      url: "/api/config",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.json().config.min_severity).toBe("high");
    await server.close();
  });

  it("accepts a structured { config } body, serializes it to YAML, and applies it", async () => {
    const { app } = jwtApp();
    const server = createServer(app);
    const token = await sign();

    const put = await server.inject({
      method: "PUT",
      url: "/api/config",
      headers: { authorization: `Bearer ${token}` },
      payload: { config: { min_severity: "medium", resolve_on_fix: false } },
    });
    expect(put.statusCode).toBe(200);
    expect(app.config.minSeverity).toBe("medium");
    expect(app.config.resolveOnFix).toBe(false);
    // Written as YAML.
    const onDisk = await readFile(configPath, "utf8");
    expect(onDisk).toContain("min_severity: medium");
    await server.close();
  });

  it("400s on a schema-invalid config and leaves the file untouched", async () => {
    // Pre-seed a valid file so we can prove it isn't clobbered by a bad write.
    await writeFile(configPath, "min_severity: low\n", "utf8");
    const { app } = jwtApp();
    const server = createServer(app);
    const token = await sign();

    const put = await server.inject({
      method: "PUT",
      url: "/api/config",
      headers: { authorization: `Bearer ${token}` },
      payload: { yaml: "min_severity: catastrophic\n" }, // not a valid Severity
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toMatch(/validation/i);
    expect(Array.isArray(put.json().details)).toBe(true);
    expect(put.json().details.length).toBeGreaterThan(0);
    // Untouched.
    expect(await readFile(configPath, "utf8")).toBe("min_severity: low\n");
    await server.close();
  });

  it("400s on malformed YAML", async () => {
    const { app } = jwtApp();
    const server = createServer(app);
    const token = await sign();
    const put = await server.inject({
      method: "PUT",
      url: "/api/config",
      headers: { authorization: `Bearer ${token}` },
      payload: { yaml: "min_severity: [unclosed\n" },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toMatch(/yaml/i);
    await server.close();
  });

  it("400s when the body is neither { yaml } nor { config }", async () => {
    const { app } = jwtApp();
    const server = createServer(app);
    const token = await sign();
    const put = await server.inject({
      method: "PUT",
      url: "/api/config",
      headers: { authorization: `Bearer ${token}` },
      payload: { nope: true },
    });
    expect(put.statusCode).toBe(400);
    await server.close();
  });
});

describe("dashboard SPA (settings / config editor, #27)", () => {
  it("ships the settings route, nav entry, and config-editor plumbing", async () => {
    const { app } = makeFakeApp({ dataDir, configPath });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/" });
    const html = res.body;
    expect(html).toContain("function renderSettings");
    expect(html).toContain("function apiSend");
    expect(html).toContain("/api/config");
    expect(html).toContain('data-view="settings"');
    expect(html).toContain("Save configuration");
    expect(html).toContain("Save YAML");
    await server.close();
  });

  it("serves the SPA shell for the /settings deep link", async () => {
    const { app } = makeFakeApp({ dataDir, configPath });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Warren");
    await server.close();
  });
});
