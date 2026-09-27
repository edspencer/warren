---
"warren": patch
---

Security: bump `@herdctl/core` to `^5.33.2` ([edspencer/herdctl#467](https://github.com/edspencer/herdctl/pull/467)). On the CLI runtime (Warren's default), the injected `github_pr` MCP server was served over an HTTP bridge bound to `0.0.0.0` with no authentication, so anything on the network could call Warren's review tools (e.g. post fake findings) while a review ran. 5.33.2 requires a per-bridge bearer token, binds the CLI bridge to `127.0.0.1`, and passes `--mcp-config` as an owner-only temp file instead of inline JSON on the command line. No Warren code changes needed.
