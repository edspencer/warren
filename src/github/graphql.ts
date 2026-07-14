/**
 * Minimal GitHub GraphQL v4 helper.
 *
 * Only what Warren needs: resolve a review thread and look up review-thread ids
 * (thread ids are GraphQL node ids, NOT the REST comment ids — you cannot resolve
 * a thread with a REST id).
 *
 * Uses the native global fetch with a small backoff on 5xx / secondary rate
 * limits. The token is sent as a bearer and is NEVER logged.
 */

export interface GraphQLOptions {
  token: string;
  /** REST API base; the GraphQL endpoint is derived as `${apiBaseUrl}/graphql`. */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; type?: string }>;
}

export const RESOLVE_REVIEW_THREAD_MUTATION = /* GraphQL */ `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

export const REVIEW_THREADS_QUERY = /* GraphQL */ `
  query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            path
            comments(first: 1) {
              nodes {
                databaseId
                body
              }
            }
          }
        }
      }
    }
  }
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Perform a single GraphQL POST, retrying transient failures. Never logs the token. */
export async function graphqlRequest<T>(
  opts: GraphQLOptions,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.apiBaseUrl ?? "https://api.github.com"}/graphql`;
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }

    // Retry on server errors and secondary rate limits.
    if (response.status >= 500 || response.status === 403 || response.status === 429) {
      lastErr = new Error(`GitHub GraphQL error: ${response.status} ${response.statusText}`);
      if (attempt < maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const waitMs = retryAfter
          ? retryAfter * 1000
          : reset
            ? Math.max(0, reset * 1000 - Date.now()) + 1000
            : baseDelay * 2 ** attempt;
        await sleep(Math.min(waitMs, 30000));
        continue;
      }
      throw lastErr;
    }

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`GitHub GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`);
    }
    if (!payload.data) throw new Error("GitHub GraphQL response had no data");
    return payload.data;
  }
  throw lastErr ?? new Error("GitHub GraphQL request failed");
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** Repo-relative path the thread is anchored to (null for file-less threads). */
  path: string | null;
  /** databaseId of the thread's first comment — the REST comment id, for cross-ref. */
  firstCommentDatabaseId: number | null;
  firstCommentBody: string | null;
}

/** Resolve a review thread by its GraphQL node id. */
export async function resolveReviewThread(
  opts: GraphQLOptions,
  threadId: string,
): Promise<{ id: string; isResolved: boolean }> {
  const data = await graphqlRequest<{
    resolveReviewThread: { thread: { id: string; isResolved: boolean } };
  }>(opts, RESOLVE_REVIEW_THREAD_MUTATION, { threadId });
  return data.resolveReviewThread.thread;
}

/** Page through all review threads for a PR, returning node ids + first-comment refs. */
export async function fetchReviewThreads(
  opts: GraphQLOptions,
  owner: string,
  name: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const out: ReviewThread[] = [];
  let cursor: string | null = null;

  for (;;) {
    const data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              id: string;
              isResolved: boolean;
              isOutdated: boolean;
              path: string | null;
              comments: { nodes: Array<{ databaseId: number | null; body: string | null }> };
            }>;
          };
        };
      };
    } = await graphqlRequest(opts, REVIEW_THREADS_QUERY, {
      owner,
      name,
      number: prNumber,
      cursor,
    });

    const conn = data.repository.pullRequest.reviewThreads;
    for (const node of conn.nodes) {
      const first = node.comments.nodes[0];
      out.push({
        id: node.id,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        path: node.path ?? null,
        firstCommentDatabaseId: first?.databaseId ?? null,
        firstCommentBody: first?.body ?? null,
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}
