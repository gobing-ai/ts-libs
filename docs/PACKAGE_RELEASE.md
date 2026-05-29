# Package Release Guide

How releases work for the four `@gobing-ai/ts-*` packages in this monorepo.

## How releasing works here

- **Existing packages** are published by **GitHub Actions** via npm **Trusted Publishing** (OIDC). You never run `npm publish` by hand — you push git **tags** and CI does the rest.
- **Brand-new packages** must be **bootstrapped once manually**, because a Trusted Publisher can only be configured for a package that already exists on npm (chicken-and-egg).
- **All packages are versioned in lockstep** — every release bumps all four to the same version and tags each one (`@gobing-ai/ts-<pkg>-v<version>`).
- The publish workflow (`.github/workflows/publish.yml`) is **tag-scoped and idempotent**: `@gobing-ai/ts-<pkg>-v<version>` is resolved against workspace manifests, publishes only that package, only when the manifest has the same version, and skips cleanly if npm already has it.

> The per-package `release` npm script is intentionally disabled — running `bun run release` prints instructions and exits non-zero. Manual `npm publish` is reserved for first-time bootstrap only (see below).

### Why four tags trigger four runs

Each per-package tag push triggers its own Publish run. The tag name decides the single package/version that run may publish, and a `concurrency` group serializes the runs so they never race. This is expected: four tag pushes, four scoped runs.

---

## Releasing an existing package (the normal path)

One command does everything:

```bash
bun run bump-ver 0.1.5 --push
```

This will:

1. **Pre-check** — abort if the working tree is dirty, the version's tags already exist (local or remote), or the version is already on npm.
2. **Bump** every manifest (root + 4 packages) to `0.1.5`.
3. **Commit** `chore(release): bump all packages to 0.1.5` (only manifests + `CHANGELOG.md` + `bun.lock`).
4. **Tag** each package: `@gobing-ai/ts-<pkg>-v0.1.5` (annotated).
5. **Push** the branch first (without tags), then each tag **individually**.

The tag pushes trigger `publish.yml`, which builds and publishes via OIDC (no token, provenance automatic). `bump-ver --push` pushes tags in dependency order (`utils → runtime → db → infra`) so dependents publish after dependencies.

> Update `CHANGELOG.md` with a `0.1.5` section **before** running `bump-ver` — it gets folded into the release commit.

### Review before pushing

Drop `--push` to do everything locally and stop, so you can inspect the commit and tags first:

```bash
bun run bump-ver 0.1.5        # bump + commit + tag, no push
git show                      # review the commit
git log --oneline -1; git tag -l '*v0.1.5'
# release when satisfied — push branch first, then tags one at a time:
git push --no-follow-tags origin main
for p in utils runtime db infra; do
  git push origin "refs/tags/@gobing-ai/ts-$p-v0.1.5"
done
```

### Verify

```bash
gh run list --workflow=publish.yml --limit 5   # expect event=push, ~4 runs, all green
npm view @gobing-ai/ts-utils version           # expect 0.1.5
```

### Fixing a mistake

If a release went wrong (bad version, tags didn't trigger), delete the tags and retry with a clean version:

```bash
bun run drop-tags 0.1.5 --remote   # delete local + remote tags for 0.1.5
```

> Note: deleting a git tag does **not** unpublish from npm — npm versions are immutable. If a version was already published, bump to the next one rather than reusing it.

### Bumping a dependency's major version

Internal deps use caret ranges (e.g. `"@gobing-ai/ts-runtime": "^0.1.0"`). A minor/patch bump of a dependency needs **no change** in its dependents. A **major** bump does — widen the range in the dependent's `package.json` (e.g. `^0.1.0` → `^1.0.0`) before releasing.

---

## Releasing a brand-new package (one-time bootstrap)

Trusted Publishing can't be set up for a package that doesn't exist yet, so the **first** publish is manual. After that, the package joins the normal flow.

### 1. Scaffold the package

Create `packages/<new-pkg>/` following the conventions of the existing packages. The `package.json` must include at minimum:

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
    "build": "tsc -p tsconfig.build.json && bun ../../scripts/builder.ts fix-dist-esm-extensions dist",
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

This uses your **personal npm login + 2FA** — expected and fine for a one-time bootstrap.

### 3. Configure the Trusted Publisher on npm

On [npmjs.com](https://www.npmjs.com/) → the new package → **Settings → Trusted Publishing** → add a GitHub Actions publisher:

| Field                   | Value           |
| ----------------------- | --------------- |
| Organization or user    | `gobing-ai`     |
| Repository              | `ts-libs`       |
| Workflow filename       | `publish.yml`   |
| Environment name        | *(leave blank)* |
| Allow npm publish       | ✅              |
| Allow npm stage publish | ⬜              |

### 4. Wire the package into CI

Add the new package to the root `build` / `typecheck` scripts in `package.json`, matching the existing packages. The `bump-ver`, `drop-tags`, and `scripts/builder.ts publish-packages` commands discover packages automatically from the `workspaces` glob — no CI publish-loop edit is needed.

### 5. Done — switch to the normal flow

From now on this package releases with the others via `bun run bump-ver <version> --push`.

---

## Requirements & notes

- The publish job needs npm **≥ 11.5.1** and Node **≥ 22.14.0** for OIDC — handled in the workflow (`setup-node` + `npm install -g npm@^11.5.1`). Don't remove those steps.
- `publish.yml` must be on the **default branch (`main`)** — and a tag's target commit must be **reachable from `main`** — for a tag push to trigger a workflow run. `bump-ver --push` pushes the branch before the tags to guarantee this.
- **Push tags individually, not `git push --tags`.** GitHub does not create workflow runs when more than three tags are pushed at once. `bump-ver --push` pushes each tag separately.
- No `NPM_TOKEN` secret is used or needed. If the workflow ever asks for one, the Trusted Publisher config is missing or mismatched.
- Provenance attestations are generated automatically — no flags required.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Tag pushed, no Publish run | Tag's commit not reachable from `main` (branch wasn't pushed first), or 4 tags pushed at once | Push `main` first, then tags one at a time (`bump-ver --push` does both) |
| Tag pushed, no Publish run | Tag doesn't match the `**-v*` glob | Use the `@gobing-ai/ts-<pkg>-v<version>` format |
| Publish run skips everything | Version already on npm | Bump to a new version — npm versions are immutable |
| Publish run fails with tag/version mismatch | The workflow checked out a commit whose manifest version does not match the tag | Recreate the tag on the correct release commit, or use a new version if npm already has the old one |
| Publish run shows "already published" skip | Normal for a retried run or a version already present on npm | None if npm has the expected version |
| `npm publish` fails with auth error in CI | Trusted Publisher not configured / field mismatch | Re-check the table in step 3 (workflow filename = `publish.yml`, env blank) |
| Consumer install conflict after release | Internal dep range too tight | Widen the caret range in the dependent and release it |
| `bump-ver` aborts "already published on npm" | The target version exists on npm | Use a higher version |
