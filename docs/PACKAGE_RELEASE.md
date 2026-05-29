# Package Release Guide

How releases work for the four `@gobing-ai/ts-*` packages in this monorepo.

## How releasing works here

- **Existing packages** are published by **GitHub Actions** via npm **Trusted Publishing** (OIDC). You never run `npm publish` by hand — you push a git **tag** and CI does the rest.
- **Brand-new packages** must be **bootstrapped once manually**, because a Trusted Publisher can only be configured for a package that already exists on npm (chicken-and-egg).
- Versioning is **independent per package**. Each package carries its own version and its own tag.
- The publish workflow (`.github/workflows/publish.yml`) is **idempotent**: any matching tag triggers a loop over all 4 packages, and each is published only if its current `package.json` version is not already on npm. **What actually ships is decided by the version bump, not the tag name.**

> The per-package `release` npm script is intentionally disabled — running `bun run release` prints the tag instructions and exits non-zero. Manual `npm publish` is reserved for first-time bootstrap only (see below).

---

## Releasing an existing package (the normal path)

All packages are versioned in lockstep and released together with one command:

```bash
bun run bump-ver 0.1.4 --push
```

This bumps every manifest to `0.1.4`, commits `chore(release): ...`, creates the annotated
tags (`@gobing-ai/ts-<pkg>-v0.1.4`), pushes the branch, then pushes the tags as a dedicated
event — which triggers `publish.yml`. The workflow builds and publishes via OIDC (no token,
provenance automatic), in dependency order (`utils → runtime → db → infra`), skipping any
package whose version is already on npm.

### Review before pushing

Drop `--push` to do everything locally and stop, so you can inspect the commit and tags first:

```bash
bun run bump-ver 0.1.4        # bump + commit + tag, no push
git show                      # review
git push origin main && git push origin --tags   # release when satisfied
```

### Verify

- Watch the run: **GitHub → Actions → Publish**, or `gh run list --workflow=publish.yml`.
- Confirm on npm: `npm view @gobing-ai/ts-utils version`.

> **Tags must be pushed as their own event.** `git push origin main` alone does **not**
> reliably emit tag-push events (GitHub attributes the push to the branch), so the Publish
> workflow won't fire. Always push tags separately via `git push origin --tags` — which is
> exactly what `bump-ver --push` does.

### Fixing a mistake

If a tag was created with the wrong version or didn't trigger, remove it and retry:

```bash
bun run drop-tags 0.1.4 --remote   # delete local + remote tags for 0.1.4
```

### Bumping a dependency's major version

Internal deps use caret ranges (e.g. `"@gobing-ai/ts-runtime": "^0.1.0"`). A minor/patch bump
of a dependency needs **no change** in its dependents. A **major** bump does — widen the range
in the dependent's `package.json` (e.g. `^0.1.0` → `^1.0.0`) and release that package too.

---

## Releasing a brand-new package (one-time bootstrap)

Trusted Publishing can't be set up for a package that doesn't exist yet, so the **first** publish is manual. After that, the package joins the normal tag-based flow.

### 1. Scaffold the package

Create `packages/<new-pkg>/` following the conventions of the existing packages. The
`package.json` must include at minimum:

```jsonc
{
  "name": "@gobing-ai/ts-<new-pkg>",
  "version": "0.1.0",
  "private": false,
  "license": "Apache-2.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "src", "README.md"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/gobing-ai/ts-libs.git",
    "directory": "packages/<new-pkg>"
  },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && bun ../../scripts/fix-dist-esm-extensions.ts dist",
    "prepublishOnly": "bun run build"
  }
}
```

### 2. Publish the first version manually

`prepublishOnly` builds automatically. From the package directory:

```bash
cd packages/<new-pkg>
npm publish --access public
```

This uses your **personal npm login + 2FA** — that's expected and fine for a one-time bootstrap.

### 3. Configure the Trusted Publisher on npm

On [npmjs.com](https://www.npmjs.com/) → the new package → **Settings → Trusted Publishing** → add a GitHub Actions publisher:

| Field                  | Value          |
| ---------------------- | -------------- |
| Organization or user   | `gobing-ai`    |
| Repository             | `ts-libs`      |
| Workflow filename      | `publish.yml`  |
| Environment name       | *(leave blank)* |
| Allow npm publish      | ✅              |
| Allow npm stage publish | ⬜              |

### 4. Wire the package into CI

Add the new package to the publish loop in `.github/workflows/publish.yml` and to the
root `build` / `typecheck` scripts in `package.json`, matching the existing packages.

### 5. Done — switch to the normal flow

From now on this package releases like the others: bump version → commit → tag
`@gobing-ai/ts-<new-pkg>-v<version>` → push.

---

## Requirements & notes

- The publish job needs npm **≥ 11.5.1** and Node **≥ 22.14.0** for OIDC — handled in the
  workflow (`setup-node` + `npm install -g npm@latest`). Don't remove those steps.
- `publish.yml` must be on the **default branch (`main`)** for npm to match the OIDC claim.
- No `NPM_TOKEN` secret is used or needed. If you ever see the workflow asking for one, the
  Trusted Publisher config is missing or mismatched.
- Provenance attestations are generated automatically — no flags required.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Workflow runs but skips everything | Versions already on npm | Bump the version before tagging |
| `npm publish` fails with auth error in CI | Trusted Publisher not configured / field mismatch | Re-check the table in step 3 (workflow filename = `publish.yml`, env blank) |
| Tag pushed, no workflow run | Tag doesn't match `@gobing-ai/ts-*-v*` | Re-tag with the correct format |
| Consumer install conflict after release | Internal dep range too tight | Widen the caret range in the dependent and release it |
