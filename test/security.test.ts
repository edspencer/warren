// test/security.test.ts — hardening against untrusted PR code (issue #31).
//
// Two invariants:
//   1. The GitHub token NEVER persists in a checkout's `.git/config` (token-leak fix).
//   2. `review.execution` gates whether the review/verify/ask agents get `Bash` on the
//      untrusted checkout (`static` = no Bash; `full` = Bash; `trusted` = per-author).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCheckout } from "../src/review/target-github.js";
import { runGit } from "../src/review/target.js";
import { WarrenConfigZ } from "../src/config/schema.js";
import { resolveExecution } from "../src/review/policy.js";
import {
  reviewerAgentConfig,
  verifyAgentConfig,
  askAgentConfig,
  REVIEWER_DENIED_TOOLS,
} from "../src/herd/reviewer.js";
import type { WarrenConfig } from "../src/types.js";

const SECRET = "ghp_TOTALLYsecretTOKENvalue0123456789";

// A resolved config with the given execution mode + author allowlist.
function cfg(execution: "static" | "full" | "trusted", authors: string[] = []): WarrenConfig {
  return WarrenConfigZ.parse({
    review: { execution },
    auto_review: { authors },
  });
}

const tools = (a: Record<string, unknown>) => (a.allowed_tools as string[]) ?? [];

describe("checkout token leak (issue #31, fix 1)", () => {
  let dir: string;
  let upstream: string;
  let headSha: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "warren-sec-"));
    // A local bare "upstream" repo with one commit, used as the credential-free remote.
    upstream = join(dir, "upstream.git");
    await runGit(["init", "--quiet", "--bare", upstream]);
    const work = join(dir, "work");
    await runGit(["init", "--quiet", work]);
    await runGit(["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "--quiet", "--allow-empty", "-m", "init"], { cwd: work });
    await runGit(["push", "--quiet", `file://${upstream}`, "HEAD:main"], { cwd: work });
    headSha = (await runGit(["rev-parse", "HEAD"], { cwd: work })).trim();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves NO token in .git/config after fetch + checkout", async () => {
    const co = join(dir, "checkout");
    await prepareCheckout({
      dir: co,
      remoteUrl: `file://${upstream}`,
      headSha,
      token: SECRET,
    });
    // The checkout actually materialized at head (auth plumbing didn't break fetch).
    const head = (await runGit(["rev-parse", "HEAD"], { cwd: co })).trim();
    expect(head).toBe(headSha);
    // The token must NOT survive anywhere in the checkout's git config.
    const gitConfig = await readFile(join(co, ".git", "config"), "utf8");
    expect(gitConfig).not.toContain(SECRET);
    expect(gitConfig).not.toContain("x-access-token");
    // The remote URL is stored credential-free.
    expect(gitConfig).toContain(`file://${upstream}`);
  });

  it("scrubs a legacy token from a REUSED checkout's remote URL", async () => {
    const co = join(dir, "legacy");
    // Simulate a pre-hardening checkout that embedded the token in the remote URL.
    await runGit(["init", "--quiet", co]);
    await runGit(["remote", "add", "origin", `file://x-access-token:${SECRET}@${upstream}`], { cwd: co });
    expect(await readFile(join(co, ".git", "config"), "utf8")).toContain(SECRET);
    // Re-preparing the checkout must reset the remote to the credential-free URL.
    await prepareCheckout({ dir: co, remoteUrl: `file://${upstream}`, headSha, token: SECRET });
    const gitConfig = await readFile(join(co, ".git", "config"), "utf8");
    expect(gitConfig).not.toContain(SECRET);
    expect(gitConfig).not.toContain("x-access-token");
  });

  it("runGit never puts the token in argv (only a credential-helper reference)", async () => {
    // A failing git call surfaces the (scrubbed) argv in its error — assert no token there.
    await expect(
      runGit(["fetch", "--depth", "1", "origin", "does-not-exist-ref"], {
        cwd: join(dir, "checkout"),
        token: SECRET,
      }),
    ).rejects.toThrow(/git .*failed/);
    await runGit(["fetch", "origin", "nope"], { cwd: join(dir, "checkout"), token: SECRET }).catch(
      (err: Error) => {
        expect(err.message).not.toContain(SECRET);
      },
    );
  });
});

describe("execution policy — resolveExecution (issue #31, fix 2)", () => {
  it("static → static (default, safest)", () => {
    expect(resolveExecution(cfg("static"), "anyone")).toBe("static");
    expect(resolveExecution(cfg("static", ["alice"]), "alice")).toBe("static");
  });

  it("full → full for everyone", () => {
    expect(resolveExecution(cfg("full"), "anyone")).toBe("full");
    expect(resolveExecution(cfg("full"), undefined)).toBe("full");
  });

  it("trusted → full only for allowlisted authors", () => {
    const c = cfg("trusted", ["Alice", "bob"]);
    expect(resolveExecution(c, "alice")).toBe("full"); // case-insensitive
    expect(resolveExecution(c, "BOB")).toBe("full");
    expect(resolveExecution(c, "mallory")).toBe("static"); // stranger → static
    expect(resolveExecution(c, undefined)).toBe("static");
  });

  it("trusted with an EMPTY allowlist trusts NO ONE (fails safe)", () => {
    expect(resolveExecution(cfg("trusted", []), "alice")).toBe("static");
  });
});

describe("execution policy — agent tool sets", () => {
  it("static reviewer has NO Bash but keeps read/evidence + github_pr MCP", () => {
    const a = reviewerAgentConfig({ name: "r", workingDir: "/co", execution: "static" });
    expect(tools(a)).not.toContain("Bash");
    expect(tools(a)).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Task", "ToolSearch", "mcp__github_pr__*"]));
  });

  it("full reviewer includes Bash", () => {
    const a = reviewerAgentConfig({ name: "r", workingDir: "/co", execution: "full" });
    expect(tools(a)).toContain("Bash");
  });

  it("defaults to static when execution is omitted", () => {
    expect(tools(reviewerAgentConfig({ name: "r", workingDir: "/co" }))).not.toContain("Bash");
  });

  it("verify + ask agents honor the same gate", () => {
    expect(tools(verifyAgentConfig({ name: "v", workingDir: "/co" }))).not.toContain("Bash");
    expect(tools(verifyAgentConfig({ name: "v", workingDir: "/co", execution: "full" }))).toContain("Bash");
    expect(tools(askAgentConfig({ name: "a", workingDir: "/co" }))).not.toContain("Bash");
    expect(tools(askAgentConfig({ name: "a", workingDir: "/co", execution: "full" }))).toContain("Bash");
  });

  it("denylist is tightened as defense-in-depth (curl/wget/git config blocked)", () => {
    expect(REVIEWER_DENIED_TOOLS).toEqual(
      expect.arrayContaining(["Bash(curl *)", "Bash(wget *)", "Bash(git config *)", "Write", "Edit"]),
    );
  });
});
