import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalGitTargetProvider } from "../src/review/target-localgit.js";
import { runGit } from "../src/review/target.js";
import type { LocalGitTarget } from "../src/types.js";

let repoDir: string;
let dataDir: string;

async function git(args: string[]): Promise<string> {
  return runGit(args, { cwd: repoDir });
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "warren-localgit-"));
  dataDir = await mkdtemp(join(tmpdir(), "warren-data-"));

  await runGit(["init", "--quiet", repoDir]);
  await git(["config", "user.email", "test@warren.local"]);
  await git(["config", "user.name", "Warren Test"]);
  await git(["config", "commit.gpgsign", "false"]);

  // Base branch "main" with one committed file.
  await git(["checkout", "-q", "-b", "main"]);
  await writeFile(join(repoDir, "a.txt"), "line1\nline2\nline3\n");
  await git(["add", "a.txt"]);
  await git(["commit", "-q", "-m", "base: add a.txt"]);

  // Head branch "pr/seeded-issues": modify a.txt, add a nested new file.
  await git(["checkout", "-q", "-b", "pr/seeded-issues"]);
  await writeFile(join(repoDir, "a.txt"), "line1\nCHANGED\nline3\n");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src/new.ts"), "export const x = 1;\n");
  await git(["add", "a.txt", "src/new.ts"]);
  await git(["commit", "-q", "-m", "head: change a.txt and add src/new.ts"]);
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

const target: LocalGitTarget = {
  kind: "local-git",
  get repoDir() {
    return repoDir;
  },
  baseRef: "main",
  headRef: "pr/seeded-issues",
  label: "local:seeded-issues",
};

describe("LocalGitTargetProvider", () => {
  it("materializes diff, changed files, and head reads", async () => {
    const provider = new LocalGitTargetProvider({ dataDir, pathFilters: [] });
    const mt = await provider.materialize(target, { full: true, sinceSha: "" });

    // Resolved SHAs.
    expect(mt.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(mt.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(mt.headSha).not.toBe(mt.baseSha);

    // Diff carries the change.
    expect(mt.diff).toContain("a.txt");
    expect(mt.diff).toContain("+CHANGED");
    expect(mt.diff).toContain("src/new.ts");

    // Changed-file list with statuses + numstat.
    const byPath = new Map(mt.files.map((f) => [f.path, f]));
    expect(byPath.has("a.txt")).toBe(true);
    expect(byPath.has("src/new.ts")).toBe(true);
    expect(byPath.get("a.txt")?.status).toBe("modified");
    expect(byPath.get("src/new.ts")?.status).toBe("added");
    expect(byPath.get("src/new.ts")?.additions).toBeGreaterThan(0);
    expect(byPath.get("a.txt")?.patch).toContain("+CHANGED");

    // readFile pulls file content at head.
    const newFile = await mt.readFile("src/new.ts");
    expect(newFile).toBe("export const x = 1;\n");
    const changed = await mt.readFile("a.txt");
    expect(changed).toContain("CHANGED");

    // checkoutDir is the repo; dispose is a safe no-op.
    expect(mt.checkoutDir).toBe(repoDir);
    await mt.dispose();

    // Context derived from commit metadata.
    expect(mt.context.title).toBe("local:seeded-issues");
    expect(mt.context.author).toBe("Warren Test");
  });

  it("applies path filters to files and diff", async () => {
    const provider = new LocalGitTargetProvider({
      dataDir,
      pathFilters: ["!src/**"],
    });
    const mt = await provider.materialize(target, { full: true, sinceSha: "" });
    const paths = mt.files.map((f) => f.path);
    expect(paths).toContain("a.txt");
    expect(paths).not.toContain("src/new.ts");
    expect(mt.diff).not.toContain("src/new.ts");
  });
});
