// src/index.ts — Warren process entrypoint.
//
// Modes (by argv):
//   (default) | serve                      → boot container + trigger + fastify server.
//   review-local <repoDir> <base> <head>   → ONE-SHOT local-git review, print + exit.

import { createContainer } from "./container.js";
import { createServer } from "./server/app.js";

async function runReviewLocal(argv: string[]): Promise<void> {
  const [repoDir, baseRef, headRef] = argv;
  if (!repoDir || !baseRef || !headRef) {
    console.error("usage: warren review-local <repoDir> <baseRef> <headRef>");
    process.exitCode = 2;
    return;
  }
  const app = await createContainer();
  try {
    const { result, reportPath } = await app.reviewLocal(repoDir, baseRef, headRef);
    const s = result.stats;
    console.log("");
    console.log(`Review complete — ${result.posted ? "findings posted" : "no findings"}`);
    console.log(
      `  files=${s.filesReviewed} raw=${s.findingsRaw} verified=${s.findingsVerified} ` +
        `posted=${s.findingsPosted} (${s.durationMs}ms)`,
    );
    console.log(`  models: triage=${s.triageModel} review=${s.reviewModel} verify=${s.verifyModel}`);
    const firstLine = (result.summary ?? "").split("\n").find((l) => l.trim()) ?? "(none)";
    console.log(`  summary: ${firstLine}`);
    console.log(`  report:  ${reportPath}`);
  } finally {
    await app.stop();
  }
}

async function runServe(): Promise<void> {
  const app = await createContainer();
  await app.start();
  const server = createServer(app);
  const { host, port } = app.env;
  await server.listen({ host, port });
  app.logger.info(`warren listening on http://${host}:${port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.logger.info(`received ${signal}; shutting down`);
    await server.close().catch(() => {});
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "review-local") {
    await runReviewLocal(argv.slice(1));
    return;
  }
  // default + explicit "serve"
  await runServe();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
