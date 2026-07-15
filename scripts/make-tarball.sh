#!/usr/bin/env bash
# Build a self-contained Warren release tarball from an already-built tree.
#
# Assumes `npm run build` has run (dist/ exists). Produces warren-<version>.tgz
# containing exactly what a host needs to run the app:
#   package.json + package-lock.json (for `npm ci --omit=dev`)
#   dist/                            (compiled server + inline dashboard)
#   INSTALL.md                       (run instructions)
#
# Consumer:  tar xzf warren-<v>.tgz && cd warren-<v> && npm ci --omit=dev \
#            && WARREN_DATA_DIR=/var/lib/warren node dist/index.js serve
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
OUT="warren-${VERSION}"
STAGE="dist-tarball/${OUT}"

test -d dist || { echo "dist/ missing — run 'npm run build' first" >&2; exit 1; }

rm -rf dist-tarball
mkdir -p "${STAGE}"

cp package.json package-lock.json "${STAGE}/"
cp -R dist "${STAGE}/dist"

cat > "${STAGE}/INSTALL.md" <<EOF
# Warren ${VERSION} — tarball install

\`\`\`sh
npm ci --omit=dev
WARREN_DATA_DIR=/var/lib/warren \\
GITHUB_TOKEN=... \\
CLAUDE_CODE_OAUTH_TOKEN=... \\
WARREN_REPOS=owner/name \\
PORT=5000 HOST=0.0.0.0 \\
node dist/index.js serve
\`\`\`

Requires Node.js >= 22 and (for the default \`cli\` runtime) the \`claude\` CLI on
PATH (\`npm i -g @anthropic-ai/claude-code\`). See the Docker image
(\`ghcr.io/edspencer/warren:${VERSION}\`) for a batteries-included alternative.
EOF

tar -czf "${OUT}.tgz" -C dist-tarball "${OUT}"
( command -v sha256sum >/dev/null && sha256sum "${OUT}.tgz" || shasum -a 256 "${OUT}.tgz" ) > "${OUT}.tgz.sha256"
rm -rf dist-tarball

echo "built ${OUT}.tgz"
cat "${OUT}.tgz.sha256"
