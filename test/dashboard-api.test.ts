import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server/app.js";
import { ghResult, makeFakeApp, makeFinding } from "./fake-app.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "warren-api-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("dashboard API", () => {
  it("GET /api/auth-mode reports the mode (unauthenticated)", async () => {
    const { app } = makeFakeApp({ dataDir, auth: { mode: "none" } });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/auth-mode" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "none" });
    await server.close();
  });

  it("GET / serves the dashboard HTML", async () => {
    const { app } = makeFakeApp({ dataDir });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Warren");
    await server.close();
  });

  it("SPA fallback: serves the shell for client routes (deep links / hard refresh)", async () => {
    const { app } = makeFakeApp({ dataDir });
    const server = createServer(app);
    for (const url of ["/reviews", "/reviews/some-id", "/repos", "/repos/acme/widgets", "/findings?severity=high"]) {
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("Warren");
    }
    await server.close();
  });

  it("SPA fallback does NOT shadow the JSON API: unknown /api/* is a JSON 404", async () => {
    const { app } = makeFakeApp({ dataDir });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    await server.close();
  });

  it("SPA fallback in jwt mode: client routes stay open (no 401), API stays guarded", async () => {
    const { app } = makeFakeApp({ dataDir, auth: { mode: "jwt", jwtSecret: "s".repeat(24) } });
    const server = createServer(app);
    const shell = await server.inject({ method: "GET", url: "/reviews/abc" });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers["content-type"]).toContain("text/html");
    const api = await server.inject({ method: "GET", url: "/api/overview" });
    expect(api.statusCode).toBe(401);
    await server.close();
  });

  it("GET /api/overview aggregates severity counts, totals, and a time series", async () => {
    const { app, history } = makeFakeApp({ dataDir });
    await history.append(
      ghResult({ pr: 1, findings: [makeFinding({ severity: "critical" }), makeFinding({ severity: "low" })] }),
    );
    await history.append(ghResult({ pr: 2, findings: [makeFinding({ severity: "critical" })] }));
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/overview" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalReviews).toBe(2);
    expect(body.totalFindings.total).toBe(3);
    expect(body.totalFindings.bySeverity.critical).toBe(2);
    expect(body.totalFindings.bySeverity.low).toBe(1);
    expect(body.watchedRepos).toBe(1);
    expect(Array.isArray(body.reviewsOverTime)).toBe(true);
    expect(body.reviewsOverTime.reduce((n: number, d: { count: number }) => n + d.count, 0)).toBe(2);
    expect(body.meanWallMs).toBe(3000);
    await server.close();
  });

  it("GET /api/repos lists watched repos (incl. zero-review) + per-repo counts", async () => {
    const { app, history } = makeFakeApp({
      dataDir,
      repos: [
        { github: { owner: "acme", name: "widgets" } },
        { github: { owner: "acme", name: "unused" } },
      ],
    });
    await history.append(ghResult({ owner: "acme", name: "widgets", pr: 1 }));
    await history.append(ghResult({ owner: "acme", name: "widgets", pr: 2 }));
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/repos" });
    expect(res.statusCode).toBe(200);
    const repos = res.json().repos as Array<{ repo: string; reviewCount: number; watched: boolean; lastReviewAt: string | null }>;
    const widgets = repos.find((r) => r.repo === "acme/widgets")!;
    const unused = repos.find((r) => r.repo === "acme/unused")!;
    expect(widgets.reviewCount).toBe(2);
    expect(widgets.lastReviewAt).not.toBeNull();
    expect(unused.reviewCount).toBe(0);
    expect(unused.watched).toBe(true);
    await server.close();
  });

  it("GET /api/reviews returns paginated summaries; supports repo + pr filters", async () => {
    const { app, history } = makeFakeApp({ dataDir });
    await history.append(ghResult({ owner: "acme", name: "a", pr: 1 }));
    await history.append(ghResult({ owner: "acme", name: "b", pr: 2 }));
    await history.append(ghResult({ owner: "acme", name: "b", pr: 3 }));
    const server = createServer(app);

    const all = await server.inject({ method: "GET", url: "/api/reviews" });
    expect(all.json().total).toBe(3);

    const byRepo = await server.inject({ method: "GET", url: "/api/reviews?repo=acme/b" });
    expect(byRepo.json().total).toBe(2);

    const byPr = await server.inject({ method: "GET", url: "/api/reviews?pr=3" });
    expect(byPr.json().total).toBe(1);
    expect(byPr.json().records[0].prNumber).toBe(3);

    const paged = await server.inject({ method: "GET", url: "/api/reviews?limit=1&offset=1" });
    expect(paged.json().records).toHaveLength(1);
    expect(paged.json().total).toBe(3);
    await server.close();
  });

  it("GET /api/reviews/:id returns the full record; 404 for unknown id", async () => {
    const { app, history } = makeFakeApp({ dataDir });
    const rec = await history.append(ghResult({ pr: 5 }));
    const server = createServer(app);

    const ok = await server.inject({ method: "GET", url: "/api/reviews/" + rec!.id });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().prNumber).toBe(5);
    expect(ok.json().walkthrough).toBe("walkthrough");
    expect(Array.isArray(ok.json().findings)).toBe(true);

    const miss = await server.inject({ method: "GET", url: "/api/reviews/does-not-exist" });
    expect(miss.statusCode).toBe(404);
    await server.close();
  });

  it("GET /api/findings flattens findings across reviews with review context", async () => {
    const { app, history } = makeFakeApp({ dataDir });
    await history.append(
      ghResult({
        owner: "acme",
        name: "a",
        pr: 1,
        findings: [makeFinding({ severity: "critical" }), makeFinding({ severity: "low" })],
      }),
    );
    await history.append(
      ghResult({ owner: "acme", name: "b", pr: 2, findings: [makeFinding({ severity: "critical" })] }),
    );
    const server = createServer(app);

    const all = await server.inject({ method: "GET", url: "/api/findings" });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(3);
    // Newest-first: repo b's review comes first, carries its review context.
    const first = all.json().findings[0];
    expect(first.repo).toBe("acme/b");
    expect(first.reviewId).toBeTruthy();
    expect(first.prNumber).toBe(2);
    expect(first.headSha).toBeTruthy();

    await server.close();
  });

  it("GET /api/findings filters by severity, repo, and verified", async () => {
    const { app, history } = makeFakeApp({ dataDir });
    await history.append(
      ghResult({
        owner: "acme",
        name: "a",
        pr: 1,
        findings: [
          makeFinding({ severity: "critical", verified: true }),
          makeFinding({ severity: "low", verified: false }),
        ],
      }),
    );
    await history.append(
      ghResult({ owner: "acme", name: "b", pr: 2, findings: [makeFinding({ severity: "critical", verified: true })] }),
    );
    const server = createServer(app);

    const crit = await server.inject({ method: "GET", url: "/api/findings?severity=critical" });
    expect(crit.json().total).toBe(2);

    const byRepo = await server.inject({ method: "GET", url: "/api/findings?repo=acme/a" });
    expect(byRepo.json().total).toBe(2);

    const critByRepo = await server.inject({ method: "GET", url: "/api/findings?severity=critical&repo=acme/a" });
    expect(critByRepo.json().total).toBe(1);

    const unverified = await server.inject({ method: "GET", url: "/api/findings?verified=false" });
    expect(unverified.json().total).toBe(1);
    expect(unverified.json().findings[0].severity).toBe("low");

    await server.close();
  });

  it("GET /api/repos/:owner/:name returns aggregate stats, reviews, and effective config", async () => {
    const { app, history } = makeFakeApp({
      dataDir,
      repos: [
        {
          github: { owner: "acme", name: "widgets" },
          overrides: { minSeverity: "high", profile: "assertive" },
        },
      ],
    });
    await history.append(
      ghResult({ owner: "acme", name: "widgets", pr: 1, findings: [makeFinding({ severity: "critical" })] }),
    );
    await history.append(
      ghResult({ owner: "acme", name: "widgets", pr: 2, findings: [makeFinding({ severity: "high" })] }),
    );
    const server = createServer(app);

    const res = await server.inject({ method: "GET", url: "/api/repos/acme/widgets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.repo).toBe("acme/widgets");
    expect(body.watched).toBe(true);
    expect(body.reviewCount).toBe(2);
    expect(body.lastReviewAt).not.toBeNull();
    expect(body.totalFindings.total).toBe(2);
    expect(body.totalFindings.bySeverity.critical).toBe(1);
    expect(body.reviews).toHaveLength(2);
    // Reviews are summaries (findings stripped), newest-first.
    expect(body.reviews[0].prNumber).toBe(2);
    expect(body.reviews[0].findings).toBeUndefined();
    // Effective config reflects the per-repo overrides (#19), never a token.
    expect(body.config.minSeverity).toBe("high");
    expect(body.config.profile).toBe("assertive");
    expect(body.config.model).toBeTruthy();
    expect(JSON.stringify(body.config)).not.toContain("token");

    await server.close();
  });

  it("GET /api/repos/:owner/:name works for an unwatched repo that has history", async () => {
    const { app, history } = makeFakeApp({ dataDir, repos: [] });
    await history.append(ghResult({ owner: "acme", name: "orphan", pr: 9 }));
    const server = createServer(app);

    const res = await server.inject({ method: "GET", url: "/api/repos/acme/orphan" });
    expect(res.statusCode).toBe(200);
    expect(res.json().watched).toBe(false);
    expect(res.json().reviewCount).toBe(1);
    expect(res.json().config.model).toBeTruthy();

    await server.close();
  });

  it("GET /api/repos/:owner/:name 404s for an unknown, historyless repo", async () => {
    const { app } = makeFakeApp({ dataDir, repos: [] });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/repos/nobody/nothing" });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it("GET /api/reviews/:id exposes a finding's suggestion for the detail view (#18)", async () => {
    const { app, history } = makeFakeApp({ dataDir });
    const rec = await history.append(
      ghResult({ pr: 8, findings: [makeFinding({ suggestion: "await sleep(ms);" })] }),
    );
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/reviews/" + rec!.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings[0].suggestion).toBe("await sleep(ms);");
    await server.close();
  });
});

describe("dashboard SPA (GitHub links + markdown, #14/#18)", () => {
  it("ships the markdown renderer and GitHub-link helpers in the shell", async () => {
    const { app } = makeFakeApp({ dataDir });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/" });
    const html = res.body;
    // #18: real markdown renderer (not the old escaped pre-wrap blob).
    expect(html).toContain("function mdToHtml");
    expect(html).toContain("mdToHtml(r.summary)");
    expect(html).toContain("mdToHtml(r.walkthrough)");
    // #14: PR + exact-location link builders, and a suggestion block.
    expect(html).toContain("function prUrl");
    expect(html).toContain("function findingUrl");
    expect(html).toContain("/pull/");
    expect(html).toContain("/blob/");
    expect(html).toContain("Suggested change");
    await server.close();
  });
});
