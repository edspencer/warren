/**
 * GitHubClient — hand-rolled REST/GraphQL client (no octokit, native fetch).
 *
 * READS always hit the real GitHub API with a bearer token (from the host env,
 * passed in). WRITES are dry-run-gated: when `live` is false they are captured to
 * a DryRunSink (in-memory + JSONL under the data dir) and a synthetic response is
 * returned; when `live` is true the identical request is POSTed for real. Callers
 * treat `WriteOutcome` uniformly — flipping live requires zero call-site changes.
 *
 * Fetch plumbing (exponential backoff, `Retry-After`/`X-RateLimit-Reset` honoring,
 * Link-header pagination, `.diff`/`.raw` Accept handling) is modeled on herdctl's
 * hand-rolled adapters/github.ts. The token is NEVER logged.
 */

import type { DiffSide, Logger, RepoRef } from "../types.js";
import { mapFindingToHunk, parseDiff } from "./diff.js";
import { DryRunSink, syntheticId, syntheticNodeId } from "./dryrun.js";
import {
  fetchReviewThreads,
  graphqlRequest,
  RESOLVE_REVIEW_THREAD_MUTATION,
  type ReviewThread,
} from "./graphql.js";

// ─────────────────────────── Public DTOs ───────────────────────────

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  draft: boolean;
  state: "open" | "closed";
  author: string;
  htmlUrl: string;
}

export interface PrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CompareResult {
  files: PrFile[];
  aheadBy: number;
  baseSha: string;
  headSha: string;
}

export interface IssueComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  /** Channel this comment came from: "issue" = PR conversation, "review" = diff thread. */
  kind?: "issue" | "review";
}

export interface ReviewSubmission {
  commitId: string;
  body: string;
  event: "COMMENT";
  comments: Array<{
    path: string;
    body: string;
    line: number;
    side: DiffSide;
    startLine?: number;
    startSide?: DiffSide;
  }>;
}

export interface WriteOutcome {
  dryRun: boolean;
  ref: string | number | null;
  capturePath?: string;
}

export type ReactionContent = "eyes" | "rocket" | "+1";

export interface GitHubClient {
  // ── READS (always real API) ──
  getPr(repo: RepoRef, prNumber: number): Promise<PrInfo>;
  listOpenPrs(repo: RepoRef): Promise<PrInfo[]>;
  listFiles(repo: RepoRef, prNumber: number): Promise<PrFile[]>;
  getDiff(repo: RepoRef, prNumber: number): Promise<string>;
  compare(repo: RepoRef, base: string, head: string): Promise<CompareResult>;
  getFileAtRef(repo: RepoRef, path: string, ref: string): Promise<string>;
  listComments(repo: RepoRef, prNumber: number, sinceId?: number): Promise<IssueComment[]>;
  /** Review-thread node ids + first-comment body/path (for resolve-on-fix). */
  listReviewThreads(repo: RepoRef, prNumber: number): Promise<ReviewThread[]>;

  // ── WRITES (dry-run gated by `live`) ──
  createReview(
    repo: RepoRef,
    prNumber: number,
    review: ReviewSubmission,
  ): Promise<WriteOutcome>;
  upsertStickyComment(
    repo: RepoRef,
    prNumber: number,
    marker: string,
    body: string,
    knownId: number | null,
  ): Promise<WriteOutcome>;
  replyToThread(
    repo: RepoRef,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<WriteOutcome>;
  /**
   * Post a NEW top-level PR conversation (issue) comment. Used to answer a free-form
   * `@warren` question raised in an issue comment (which has no threaded-reply endpoint).
   */
  postIssueComment(repo: RepoRef, prNumber: number, body: string): Promise<WriteOutcome>;
  resolveThread(repo: RepoRef, threadId: string): Promise<WriteOutcome>;
  addReaction(repo: RepoRef, commentId: number, content: ReactionContent): Promise<WriteOutcome>;
  /**
   * DELETE a previously-added reaction (eyes-ack cleanup).
   * NOTE: extends the spec §3.5 interface (task item 1 asked for removeReaction).
   */
  removeReaction(repo: RepoRef, commentId: number, reactionId: number): Promise<WriteOutcome>;
}

// ─────────────────────────── Internal write descriptors ───────────────────────────

export interface PreparedWrite {
  kind: string;
  method: string;
  /** Endpoint path relative to the API base ("/graphql" for GraphQL). */
  path: string;
  body?: unknown;
  syntheticRef: string | number;
}

function reviewComments(review: ReviewSubmission) {
  return review.comments.map((c) => ({
    path: c.path,
    body: c.body,
    line: c.line,
    side: c.side,
    ...(c.startLine != null
      ? { start_line: c.startLine, start_side: c.startSide ?? c.side }
      : {}),
  }));
}

export function buildCreateReviewWrite(
  repo: RepoRef,
  prNumber: number,
  review: ReviewSubmission,
): PreparedWrite {
  return {
    kind: "createReview",
    method: "POST",
    path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews`,
    body: {
      commit_id: review.commitId,
      event: "COMMENT",
      body: review.body,
      comments: reviewComments(review),
    },
    syntheticRef: syntheticId(),
  };
}

export function buildReplyWrite(
  repo: RepoRef,
  prNumber: number,
  commentId: number,
  body: string,
): PreparedWrite {
  return {
    kind: "replyToThread",
    method: "POST",
    path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/comments/${commentId}/replies`,
    body: { body },
    syntheticRef: syntheticId(),
  };
}

export function buildPostIssueCommentWrite(
  repo: RepoRef,
  prNumber: number,
  body: string,
): PreparedWrite {
  return {
    kind: "postIssueComment",
    method: "POST",
    path: `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`,
    body: { body },
    syntheticRef: syntheticId(),
  };
}

export function buildReactionWrite(
  repo: RepoRef,
  commentId: number,
  content: ReactionContent,
): PreparedWrite {
  return {
    kind: "addReaction",
    method: "POST",
    path: `/repos/${repo.owner}/${repo.name}/issues/comments/${commentId}/reactions`,
    body: { content },
    syntheticRef: syntheticId(),
  };
}

export function buildRemoveReactionWrite(
  repo: RepoRef,
  commentId: number,
  reactionId: number,
): PreparedWrite {
  return {
    kind: "removeReaction",
    method: "DELETE",
    path: `/repos/${repo.owner}/${repo.name}/issues/comments/${commentId}/reactions/${reactionId}`,
    syntheticRef: reactionId,
  };
}

export function buildResolveThreadWrite(_repo: RepoRef, threadId: string): PreparedWrite {
  return {
    kind: "resolveThread",
    method: "POST",
    path: "/graphql",
    body: { query: RESOLVE_REVIEW_THREAD_MUTATION, variables: { threadId } },
    syntheticRef: threadId,
  };
}

/** Ensure the hidden marker is present in a sticky-comment body. */
function withMarker(marker: string, body: string): string {
  return body.includes(marker) ? body : `${body}\n\n${marker}`;
}

// ─────────────────────────── Fetch/backoff config ───────────────────────────

const DEFAULT_API_BASE_URL = "https://api.github.com";

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 30000 };

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RequestOpts {
  body?: unknown;
  /** Override Accept header (e.g. diff/raw media types). */
  accept?: string;
}

export interface RestGitHubClientOptions {
  token: string;
  apiBaseUrl?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  retry?: Partial<RetryConfig>;
}

// ─────────────────────────── Live REST client ───────────────────────────

export class RestGitHubClient implements GitHubClient {
  readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryConfig;

  constructor(opts: RestGitHubClientOptions) {
    this.token = opts.token;
    this.apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.logger = opts.logger ?? noopLogger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
  }

  private graphqlOpts() {
    return { token: this.token, apiBaseUrl: this.apiBaseUrl, fetchImpl: this.fetchImpl };
  }

  /** Core fetch with backoff + rate-limit handling. Never logs the token. */
  private async coreRequest(
    method: string,
    endpoint: string,
    opts: RequestOpts = {},
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const url = `${this.apiBaseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Accept: opts.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${this.token}`,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        this.logger.debug(`github: network error ${method} ${endpoint} (attempt ${attempt})`);
        if (attempt < this.retry.maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw lastErr;
      }

      if (this.isRetryable(response) && attempt < this.retry.maxRetries) {
        const wait = this.retryDelay(response, attempt);
        this.logger.debug(
          `github: ${response.status} ${method} ${endpoint}; retrying in ${wait}ms`,
        );
        await sleep(wait);
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        let msg = `GitHub API error: ${response.status} ${response.statusText}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (parsed.message) msg = `GitHub API error: ${parsed.message}`;
        } catch {
          /* non-JSON error body */
        }
        throw new GitHubApiError(msg, response.status, endpoint);
      }
      return { status: response.status, headers: response.headers, text };
    }
    throw lastErr ?? new GitHubApiError("GitHub request failed", 0, endpoint);
  }

  private isRetryable(response: Response): boolean {
    if (response.status >= 500) return true;
    if (response.status === 429) return true;
    if (response.status === 403) {
      // Secondary rate limit / primary rate limit exhausted.
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null && parseInt(remaining, 10) === 0) return true;
      if (response.headers.get("retry-after") !== null) return true;
    }
    return false;
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) return Math.min(Number(retryAfter) * 1000 + 1000, this.retry.maxDelayMs);
    const reset = response.headers.get("x-ratelimit-reset");
    if (reset) {
      const ms = Number(reset) * 1000 - Date.now();
      if (ms > 0) return Math.min(ms + 1000, this.retry.maxDelayMs);
    }
    return this.backoff(attempt);
  }

  private backoff(attempt: number): number {
    const base = Math.min(this.retry.baseDelayMs * 2 ** attempt, this.retry.maxDelayMs);
    return Math.floor(base + base * 0.1 * Math.random());
  }

  private async requestJson<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const { status, text } = await this.coreRequest(method, endpoint, { body });
    if (status === 204 || text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async requestText(method: string, endpoint: string, accept: string): Promise<string> {
    const { text } = await this.coreRequest(method, endpoint, { accept });
    return text;
  }

  /** Paginate an array endpoint via the Link header. */
  private async paginate<T>(endpointBase: string, perPage = 100): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const sep = endpointBase.includes("?") ? "&" : "?";
      const endpoint = `${endpointBase}${sep}per_page=${perPage}&page=${page}`;
      const { text, headers } = await this.coreRequest("GET", endpoint);
      const data = (text.length ? JSON.parse(text) : []) as T[];
      if (Array.isArray(data)) out.push(...data);
      if (!hasNextLink(headers.get("Link"))) break;
      page += 1;
    }
    return out;
  }

  // ── READS ──

  async getPr(repo: RepoRef, prNumber: number): Promise<PrInfo> {
    const raw = await this.requestJson<RawPull>(
      "GET",
      `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`,
    );
    return toPrInfo(raw);
  }

  async listOpenPrs(repo: RepoRef): Promise<PrInfo[]> {
    const raws = await this.paginate<RawPull>(
      `/repos/${repo.owner}/${repo.name}/pulls?state=open`,
    );
    return raws.map(toPrInfo);
  }

  async listFiles(repo: RepoRef, prNumber: number): Promise<PrFile[]> {
    const raws = await this.paginate<RawFile>(
      `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/files`,
    );
    return raws.map(toPrFile);
  }

  async getDiff(repo: RepoRef, prNumber: number): Promise<string> {
    return this.requestText(
      "GET",
      `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`,
      "application/vnd.github.diff",
    );
  }

  async compare(repo: RepoRef, base: string, head: string): Promise<CompareResult> {
    // Paginate the files array via Link (compare returns ≤300 files on page 1).
    const files: PrFile[] = [];
    let aheadBy = 0;
    let baseSha = base;
    let page = 1;
    for (;;) {
      const endpoint = `/repos/${repo.owner}/${repo.name}/compare/${encodeURIComponent(
        base,
      )}...${encodeURIComponent(head)}?per_page=100&page=${page}`;
      const { text, headers } = await this.coreRequest("GET", endpoint);
      const raw = JSON.parse(text) as RawCompare;
      aheadBy = raw.ahead_by ?? aheadBy;
      baseSha = raw.merge_base_commit?.sha ?? raw.base_commit?.sha ?? baseSha;
      for (const f of raw.files ?? []) files.push(toPrFile(f));
      if (!hasNextLink(headers.get("Link"))) break;
      page += 1;
    }
    return { files, aheadBy, baseSha, headSha: head };
  }

  async getFileAtRef(repo: RepoRef, path: string, ref: string): Promise<string> {
    return this.requestText(
      "GET",
      `/repos/${repo.owner}/${repo.name}/contents/${encodeContentPath(path)}?ref=${encodeURIComponent(
        ref,
      )}`,
      "application/vnd.github.raw",
    );
  }

  async listComments(repo: RepoRef, prNumber: number, sinceId?: number): Promise<IssueComment[]> {
    // Issue (conversation) comments + review (diff-thread) comments, merged, for
    // @mention detection. Both are needed to catch @warren commands anywhere.
    const [issue, review] = await Promise.all([
      this.paginate<RawIssueComment>(
        `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`,
      ),
      this.paginate<RawIssueComment>(
        `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/comments`,
      ),
    ]);
    let merged = [
      ...issue.map((c) => toIssueComment(c, "issue")),
      ...review.map((c) => toIssueComment(c, "review")),
    ];
    if (sinceId != null) merged = merged.filter((c) => c.id > sinceId);
    merged.sort((a, b) => a.id - b.id);
    return merged;
  }

  // ── WRITES (live) ──

  async createReview(
    repo: RepoRef,
    prNumber: number,
    review: ReviewSubmission,
  ): Promise<WriteOutcome> {
    // Defensive server-side validation: relocate/drop comments not on a diff hunk
    // so the batched POST never 422s. Best-effort — a diff-fetch failure posts as-is.
    let submission = review;
    try {
      const files = parseDiff(await this.getDiff(repo, prNumber));
      const kept: ReviewSubmission["comments"] = [];
      for (const c of review.comments) {
        const mapped = mapFindingToHunk(
          { path: c.path, line: c.startLine ?? c.line, endLine: c.line, side: c.side },
          files,
        );
        if (!mapped) {
          this.logger.debug(`createReview: dropped stray comment on ${c.path}:${c.line}`);
          continue;
        }
        kept.push({ ...c, line: mapped.line, side: mapped.side, startLine: mapped.startLine, startSide: mapped.startSide });
      }
      submission = { ...review, comments: kept };
    } catch (err) {
      this.logger.debug(
        `createReview: skipped diff validation (${err instanceof Error ? err.message : err})`,
      );
    }
    const w = buildCreateReviewWrite(repo, prNumber, submission);
    const json = await this.requestJson<{ id: number }>(w.method, w.path, w.body);
    return { dryRun: false, ref: json?.id ?? null };
  }

  /** Build the sticky-comment write (PATCH existing marker comment, else POST). */
  async prepareStickyWrite(
    repo: RepoRef,
    prNumber: number,
    marker: string,
    body: string,
    knownId: number | null,
  ): Promise<PreparedWrite> {
    const finalBody = withMarker(marker, body);
    let targetId = knownId;
    if (targetId == null) {
      const comments = await this.paginate<RawIssueComment>(
        `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`,
      );
      const found = comments.find((c) => (c.body ?? "").includes(marker));
      targetId = found ? found.id : null;
    }
    if (targetId != null) {
      return {
        kind: "upsertStickyComment",
        method: "PATCH",
        path: `/repos/${repo.owner}/${repo.name}/issues/comments/${targetId}`,
        body: { body: finalBody },
        syntheticRef: targetId,
      };
    }
    return {
      kind: "upsertStickyComment",
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`,
      body: { body: finalBody },
      syntheticRef: syntheticId(),
    };
  }

  async upsertStickyComment(
    repo: RepoRef,
    prNumber: number,
    marker: string,
    body: string,
    knownId: number | null,
  ): Promise<WriteOutcome> {
    const w = await this.prepareStickyWrite(repo, prNumber, marker, body, knownId);
    const json = await this.requestJson<{ id: number }>(w.method, w.path, w.body);
    return { dryRun: false, ref: json?.id ?? w.syntheticRef };
  }

  async replyToThread(
    repo: RepoRef,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<WriteOutcome> {
    const w = buildReplyWrite(repo, prNumber, commentId, body);
    const json = await this.requestJson<{ id: number }>(w.method, w.path, w.body);
    return { dryRun: false, ref: json?.id ?? null };
  }

  async postIssueComment(repo: RepoRef, prNumber: number, body: string): Promise<WriteOutcome> {
    const w = buildPostIssueCommentWrite(repo, prNumber, body);
    const json = await this.requestJson<{ id: number }>(w.method, w.path, w.body);
    return { dryRun: false, ref: json?.id ?? null };
  }

  async resolveThread(repo: RepoRef, threadId: string): Promise<WriteOutcome> {
    const thread = await (async () => {
      const data = await graphqlRequest<{
        resolveReviewThread: { thread: { id: string } };
      }>(this.graphqlOpts(), RESOLVE_REVIEW_THREAD_MUTATION, { threadId });
      return data.resolveReviewThread.thread;
    })();
    return { dryRun: false, ref: thread.id };
  }

  async addReaction(
    repo: RepoRef,
    commentId: number,
    content: ReactionContent,
  ): Promise<WriteOutcome> {
    const w = buildReactionWrite(repo, commentId, content);
    const json = await this.requestJson<{ id: number }>(w.method, w.path, w.body);
    return { dryRun: false, ref: json?.id ?? null };
  }

  async removeReaction(
    repo: RepoRef,
    commentId: number,
    reactionId: number,
  ): Promise<WriteOutcome> {
    const w = buildRemoveReactionWrite(repo, commentId, reactionId);
    await this.requestJson<void>(w.method, w.path);
    return { dryRun: false, ref: reactionId };
  }

  /** Look up review-thread node ids (for resolveThread). Live-only helper. */
  async listReviewThreads(repo: RepoRef, prNumber: number) {
    return fetchReviewThreads(this.graphqlOpts(), repo.owner, repo.name, prNumber);
  }
}

// ─────────────────────────── Dry-run wrapper ───────────────────────────

/**
 * Wraps a live RestGitHubClient: READS delegate to the real API; WRITES are
 * captured to the DryRunSink and return synthetic outcomes. Same interface, so
 * call sites are identical to the live client.
 */
export class DryRunGitHubClient implements GitHubClient {
  constructor(
    private readonly inner: RestGitHubClient,
    private readonly sink: DryRunSink,
    private readonly key?: string,
  ) {}

  // Reads → real API.
  getPr(repo: RepoRef, prNumber: number) {
    return this.inner.getPr(repo, prNumber);
  }
  listOpenPrs(repo: RepoRef) {
    return this.inner.listOpenPrs(repo);
  }
  listFiles(repo: RepoRef, prNumber: number) {
    return this.inner.listFiles(repo, prNumber);
  }
  getDiff(repo: RepoRef, prNumber: number) {
    return this.inner.getDiff(repo, prNumber);
  }
  compare(repo: RepoRef, base: string, head: string) {
    return this.inner.compare(repo, base, head);
  }
  getFileAtRef(repo: RepoRef, path: string, ref: string) {
    return this.inner.getFileAtRef(repo, path, ref);
  }
  listComments(repo: RepoRef, prNumber: number, sinceId?: number) {
    return this.inner.listComments(repo, prNumber, sinceId);
  }
  listReviewThreads(repo: RepoRef, prNumber: number) {
    return this.inner.listReviewThreads(repo, prNumber);
  }

  private capture(w: PreparedWrite): Promise<WriteOutcome> {
    return this.sink.record({
      kind: w.kind,
      method: w.method,
      url: `${this.inner.apiBaseUrl}${w.path}`,
      body: w.body,
      key: this.key,
      syntheticRef: w.syntheticRef,
    });
  }

  createReview(repo: RepoRef, prNumber: number, review: ReviewSubmission) {
    // No diff-fetch in dry-run: capture the intended payload verbatim (no network).
    return this.capture(buildCreateReviewWrite(repo, prNumber, review));
  }

  async upsertStickyComment(
    repo: RepoRef,
    prNumber: number,
    marker: string,
    body: string,
    knownId: number | null,
  ) {
    // Reads still go live (spec §3.5) to decide PATCH vs POST; only the write is captured.
    const w = await this.inner.prepareStickyWrite(repo, prNumber, marker, body, knownId);
    return this.capture(w);
  }

  replyToThread(repo: RepoRef, prNumber: number, commentId: number, body: string) {
    return this.capture(buildReplyWrite(repo, prNumber, commentId, body));
  }

  postIssueComment(repo: RepoRef, prNumber: number, body: string) {
    return this.capture(buildPostIssueCommentWrite(repo, prNumber, body));
  }

  resolveThread(repo: RepoRef, threadId: string) {
    const w = buildResolveThreadWrite(repo, threadId);
    return this.capture({ ...w, syntheticRef: threadId || syntheticNodeId("THREAD") });
  }

  addReaction(repo: RepoRef, commentId: number, content: ReactionContent) {
    return this.capture(buildReactionWrite(repo, commentId, content));
  }

  removeReaction(repo: RepoRef, commentId: number, reactionId: number) {
    return this.capture(buildRemoveReactionWrite(repo, commentId, reactionId));
  }
}

// ─────────────────────────── Factory ───────────────────────────

export interface CreateGitHubClientOptions {
  token: string;
  live: boolean;
  dataDir: string;
  apiBaseUrl?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Optional state key (targetKey) recorded with dry-run captures. */
  key?: string;
}

/**
 * Build a GitHubClient. `live: true` → real POSTs. `live: false` → a dry-run
 * wrapper that captures writes to `${dataDir}/writes.jsonl` and returns synthetic
 * outcomes. Reads hit the real API in both modes.
 */
export function createGitHubClient(opts: CreateGitHubClientOptions): GitHubClient {
  const rest = new RestGitHubClient({
    token: opts.token,
    apiBaseUrl: opts.apiBaseUrl,
    logger: opts.logger,
    fetchImpl: opts.fetchImpl,
  });
  if (opts.live) return rest;
  const sink = new DryRunSink(opts.dataDir, opts.logger);
  return new DryRunGitHubClient(rest, sink, opts.key);
}

// ─────────────────────────── Errors + mappers ───────────────────────────

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
  isNotFound(): boolean {
    return this.statusCode === 404;
  }
}

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  draft?: boolean;
  state: "open" | "closed";
  html_url: string;
  user: { login: string } | null;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}
interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}
interface RawCompare {
  ahead_by?: number;
  base_commit?: { sha: string };
  merge_base_commit?: { sha: string };
  files?: RawFile[];
}
interface RawIssueComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
}

function toPrInfo(p: RawPull): PrInfo {
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    headSha: p.head.sha,
    baseSha: p.base.sha,
    baseRef: p.base.ref,
    headRef: p.head.ref,
    draft: p.draft ?? false,
    state: p.state,
    author: p.user?.login ?? "",
    htmlUrl: p.html_url,
  };
}

function toPrFile(f: RawFile): PrFile {
  return {
    path: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  };
}

function toIssueComment(c: RawIssueComment, kind?: "issue" | "review"): IssueComment {
  return {
    id: c.id,
    body: c.body ?? "",
    author: c.user?.login ?? "",
    createdAt: c.created_at,
    ...(kind ? { kind } : {}),
  };
}

/** Encode a repo-relative path for the contents API, preserving slashes. */
function encodeContentPath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function hasNextLink(link: string | null): boolean {
  if (!link) return false;
  return /rel="next"/.test(link);
}
