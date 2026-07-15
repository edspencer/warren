# Changesets

Warren uses [changesets](https://github.com/changesets/changesets) for versioning
and releases. Warren is an **app**, not a published npm library — the release
artifacts are a Docker image (`ghcr.io/edspencer/warren`) and a tarball attached
to a GitHub Release, not an npm publish.

## Adding a changeset

When you make a user-facing change, add a changeset describing it:

```sh
npm run changeset
```

Pick a bump (`patch` / `minor` / `major`) and write a one-line summary. Commit the
generated file in `.changeset/` with your PR.

## How a release happens

1. On merge to `main`, the Release workflow opens/updates a **"chore: version
   packages"** PR that consumes the pending changesets, bumps `version` in
   `package.json`, and updates `CHANGELOG.md`.
2. Merging that PR (no changesets left, version bumped, no matching `v<version>`
   tag yet) triggers the release: multi-arch Docker image → GHCR, a release
   tarball, and a GitHub Release `v<version>`.

See `.github/workflows/release.yml`.
