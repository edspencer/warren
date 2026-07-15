# Warren application image.
#
# Warren is an APP (a Fastify server that polls GitHub, runs the agentic review
# pipeline, and serves the review dashboard), not a library — this image is the
# unit of deployment. It bundles the compiled server + the inline dashboard and
# the `claude` CLI that Warren shells out to via @herdctl/core's cli runtime.
#
# Runtime requirements (supplied at `docker run` time, NOT baked in):
#   - CLAUDE_CODE_OAUTH_TOKEN   Claude Max auth (WARREN_RUNTIME=cli, the default).
#                               Or ANTHROPIC_API_KEY with WARREN_RUNTIME=sdk.
#   - GITHUB_TOKEN              Reads PRs (and posts reviews when WARREN_LIVE=1).
#   - WARREN_REPOS=owner/name,… Repos to watch (poll mode).
#   - a volume mounted at /data Persistent review state + history + Claude session
#                               transcripts (HOME=/data so ~/.claude survives → the
#                               @warren chat session-resume works across restarts).
#
# Multi-arch (linux/amd64, linux/arm64) is built in CI on native per-arch
# runners (see .github/workflows/release.yml); each leg pushes by digest and the
# manifests are merged with `docker buildx imagetools create`.

# ---- build stage ----------------------------------------------------------
# Pinned to $BUILDPLATFORM: this stage only emits arch-independent JS (tsc),
# so in an emulated cross-build it runs once, natively, instead of repeating
# npm ci + compile under QEMU per arch.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app

# Install deps first (cache layer) — manifests before sources.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript → dist/.
COPY . .
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=5000 \
    HOST=0.0.0.0 \
    WARREN_DATA_DIR=/data \
    HOME=/data

# System deps + the Claude CLI that Warren spawns for the cli runtime (default).
# git is needed to check out PR heads for review; curl backs the HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# Production dependencies only (tsc/tsx/vitest are build-time dev deps).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled server + inline dashboard.
COPY --from=build /app/dist ./dist

# Configure git auth from GITHUB_TOKEN (if provided), ensure the data dir, exec.
RUN printf '#!/bin/sh\nif [ -n "$GITHUB_TOKEN" ]; then\n  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"\nfi\nmkdir -p "$WARREN_DATA_DIR"\nexec "$@"\n' > /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js", "serve"]
