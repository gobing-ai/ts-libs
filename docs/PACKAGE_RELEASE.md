# Package Release Guide

How releases work for the `@gobing-ai/ts-*` packages in this monorepo.

## How releasing works here

- **Existing packages** are published by **GitHub Actions** via npm **Trusted Publishing** (OIDC). You never run `npm publish` by hand — you push git **tags** and CI does the rest.
- **Brand-new packages** must be **bootstrapped once manually**, because a Trusted Publisher can only be configured for a package that already exists on npm (chicken-and-egg). A package npm has never seen has nothing to authenticate the OIDC exchange against, so `npm publish` in CI fails with `ENEEDAUTH`. The publish script **preflights** every pending package and aborts *before publishing anything* when one is unknown to npm, so a new package can no longer strand the packages ordered after it.
- **All packages are versioned in lockstep** — every release bumps all package manifests to the same version and tags each one (`@gobing-ai/ts-<pkg>-v<version>`).
- The publish workflow (`.github/workflows/publish.yml`) is **aggregate-tag scoped and idempotent**: `@gobing-ai/ts-libs-v<version>` is resolved against the root workspace manifest, then publishes all non-private packages in dependency order. It skips cleanly if npm already has a package version.

> The per-package `release` npm script is intentionally disabled — running `bun run release` prints instructions and exits non-zero. Manual `npm publish` is reserved for first-time bootstrap only (see below).

### Why one tag triggers one Publish run

Each release still creates per-package tags for traceability, but only the aggregate `@gobing-ai/ts-libs-v<version>` tag matches the Publish workflow trigger. This avoids multiple tag-triggered Publish runs competing under the same concurrency group.

---

## Releasing an existing package (the normal path)

One command does everything:

```bash
bun run bump-ver 0.1.5 --push
```

This will:

1. **Pre-check** — abort if the working tree is dirty, the version's tags already exist (local or remote), or the version is already on npm.
2. **Bump** every workspace manifest to `0.1.5`.
3. **Commit** `chore(release): bump all packages to 0.1.5` (only manifests + `CHANGELOG.md` + `bun.lock`).
4. **Tag** each package: `@gobing-ai/ts-<pkg>-v0.1.5` (annotated), plus the aggregate trigger tag `@gobing-ai/ts-libs-v0.1.5`.
5. **Push** the branch first (without tags), then tags **individually**.

The aggregate tag push triggers one `publish.yml` run, which builds and publishes via OIDC (no token, provenance automatic). The publish script publishes packages in dependency order (`utils → runtime → db → infra`) so dependents publish after dependencies. That order is **canonical**: it is derived from the package set (roots and edges visited in name order), never from filesystem discovery order, so a given commit builds and publishes in the same sequence on every machine and in CI.

> Update `CHANGELOG.md` with a `0.1.5` section **before** running `bump-ver` — it gets folded into the release commit.

### Review before pushing

Drop `--push` to do everything locally and stop, so you can inspect the commit and tags first:

```bash
bun run bump-ver 0.1.5        # bump + commit + tag, no push
git show                      # review the commit
git log --oneline -1; git tag -l '*v0.1.5'
# release when satisfied — push branch first, then tags one at a time. Keep the followTags guard on
# every push: with `push.followTags=true` an unguarded tag push also pushes every other annotated
# tag on the same commit, and GitHub creates no workflow runs when more than three tags arrive at once.
git push --no-follow-tags origin main
for p in utils runtime db infra; do
  git -c push.followTags=false push origin "refs/tags/@gobing-ai/ts-$p-v0.1.5:refs/tags/@gobing-ai/ts-$p-v0.1.5"
done
git -c push.followTags=false push origin "refs/tags/@gobing-ai/ts-libs-v0.1.5:refs/tags/@gobing-ai/ts-libs-v0.1.5"
# verify the Publish run was triggered (bounded lookup, ~10s, then exit 1 if absent):
bun scripts/builder.ts verify-publish @gobing-ai/ts-libs-v0.1.5
```

### Verify

For local-mode releases (without `--push`), verify the triggered Publish run:

```bash
bun scripts/builder.ts verify-publish @gobing-ai/ts-libs-v<version>
# or if no run was triggered (recovers with a single workflow_dispatch):
bun scripts/builder.ts verify-publish @gobing-ai/ts-libs-v<version> --dispatch
```

The check-only form polls `gh run list` up to 3 times, 5s apart (~10s), so a scripted verify run
fired the instant the tag lands can report a false "no run" for a trigger that is merely late. Exit 1
naming the tag is always actionable: re-run it, or add `--dispatch`.

`bump-ver <version> --push` now **proves the Publish run exists before returning** (task 0510 R4):
after pushing the aggregate tag it polls `gh run list --workflow=publish.yml` (3 attempts, 5s apart)
for a run whose head branch matches `@gobing-ai/ts-libs-v<version>`. If no push-triggered run appears,
it dispatches `publish.yml` once at the same tag ref (`gh workflow run publish.yml --ref <tag>`) and
confirms the dispatched run, then reports the run ID/URL. It never deletes, moves, or re-pushes a
tag — the workflow is idempotent, so dispatch of the immutable tag ref is the safe recovery for a
missed push event.

```bash
# bump-ver --push already verified the run and printed its ID/URL; a manual check is optional:
gh run list --workflow=publish.yml --limit 5   # expect one event=push Publish run
npm view @gobing-ai/ts-utils version           # expect 0.1.5
```

If `bump-ver` exits with "No Publish workflow run found", a dispatch was attempted but the run was
not yet visible in the Actions API. Check the Actions tab; the run may be queued. Tags are never
mutated, so re-running `bump-ver` after cleanup is unnecessary — the workflow is idempotent.

### Fixing a mistake

If a release went wrong (bad version, tags didn't trigger), delete the tags and retry with a clean version:

```bash
bun run drop-tags 0.1.5 --remote   # delete local + remote tags for 0.1.5
```

> Note: deleting a git tag does **not** unpublish from npm — npm versions are immutable. If a version was already published, bump to the next one rather than reusing it.

### Bumping the lockstep major version

Internal deps stay `workspace:*` in source for every release, including majors. `bump-ver` updates all
package versions together; publishing substitutes each workspace range with `^<new-version>`. Never
hand-edit internal dependency ranges.

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
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "prepublishOnly": "bun run build"
  }
}
```

### 2. Publish the first version manually

Do **not** run a bare `npm publish` from the package directory: npm packs the manifest as-is, so a sibling dependency written as `workspace:*` (ADR-002) would be published unresolved and uninstallable. A bare publish is now **blocked**, not merely discouraged — every package's `prepublishOnly` runs `builder.ts check-publish-manifest`, which refuses to pack an unresolved `workspace:` range.

Use the release script's bootstrap mode from the **repo root** — it substitutes `workspace:` ranges for the tarball, restores the manifest afterwards, and skips the "must already exist on npm" preflight:

```bash
npm login                                                        # personal account + 2FA
bun scripts/builder.ts publish-packages --bootstrap @gobing-ai/ts-<new-pkg>
```

This is the one publish that uses your **personal npm login + 2FA** instead of OIDC — expected and fine for a one-time bootstrap. If your account requires a one-time password and the shell is not interactive, pass it through the environment:

```bash
NPM_CONFIG_OTP=<code> bun scripts/builder.ts publish-packages --bootstrap @gobing-ai/ts-<new-pkg>
```

> Running `--bootstrap` in CI cannot work: there is no Trusted Publisher to authenticate against yet. It is a local, operator-run command.

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

### 4. Verify workspace discovery

No CI publish-loop or root `build` / `typecheck` script edit is needed. The automation discovers non-private packages from the root `workspaces` glob, sorts them by internal package dependencies, and uses the package's own `build` and `typecheck` scripts.

```bash
bun run typecheck
bun run build
```

By default, `bun run build` smoke-imports every publishable package with Bun. `buildConfig.nodeSmokePackages` is empty by default; add a package there only when Node import compatibility is an explicit contract.

### 5. Done — switch to the normal flow

From now on this package releases with the others via `bun run bump-ver <version> --push`.

---

## Requirements & notes

- The publish job needs npm **≥ 11.5.1** and Node **≥ 22.14.0** for OIDC — handled in the workflow (`setup-node` + `npm install -g npm@^11.5.1`). Don't remove those steps.
- `publish.yml` must be on the **default branch (`main`)** — and a tag's target commit must be **reachable from `main`** — for a tag push to trigger a workflow run. `bump-ver --push` pushes the branch before the tags to guarantee this.
- **Push tags individually, not `git push --tags`.** GitHub does not create workflow runs when more than three tags are pushed at once. `bump-ver --push` disables `push.followTags` for the branch push and then pushes each tag as an explicit `refs/tags/<tag>:refs/tags/<tag>` refspec. Only the aggregate tag matches `publish.yml`.
- No `NPM_TOKEN` secret is used or needed. If the workflow ever asks for one, the Trusted Publisher config is missing or mismatched.
- Provenance attestations are generated automatically — no flags required.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Tag pushed, no Publish run | Tag's commit not reachable from `main` (branch wasn't pushed first), or tags were pushed together | Push `main` first, then tags one at a time (`bump-ver --push` does both). For local releases, run `bun scripts/builder.ts verify-publish <aggregate-tag> [--dispatch]`. If the run is still missing, `bump-ver --push` or `verify-publish --dispatch` auto-recovers by dispatching `publish.yml` at the aggregate tag ref once (task 0510 R4) — no tag deletion/re-push needed |
| Per-package tag pushed, no Publish run | Expected — per-package tags are traceability tags only | Check for the aggregate `@gobing-ai/ts-libs-v<version>` tag run |
| Publish run skips everything | Version already on npm | Bump to a new version — npm versions are immutable |
| Publish run fails with tag/version mismatch | The workflow checked out a commit whose manifest version does not match the tag | Recreate the tag on the correct release commit, or use a new version if npm already has the old one |
| Publish run shows "already published" skip | Normal for a retried run or a version already present on npm | None if npm has the expected version |
| Publish run fails with `ENEEDAUTH` on a package that isn't on npm | Brand-new package in the release — npm has no Trusted Publisher to attach to a package it does not have (the preflight normally catches this *before* publishing anything) | Bootstrap the first publish (`publish-packages --bootstrap <name>`, step 2), configure the Trusted Publisher (step 3), then re-run the workflow — it is idempotent |
| `npm publish` aborts with `unresolved workspace range "...": "workspace:*" — refusing to publish a broken manifest` | A hand-run publish (bootstrap) is packing a manifest whose `workspace:` ranges were never substituted | Use `publish-packages --bootstrap <name>` from the repo root (step 2) — it resolves the ranges first. Do not work around the guard |
| Publish run fails with `ENEEDAUTH` on a package that *is* on npm | Trusted Publisher not configured / field mismatch | Re-check the table in step 3 (workflow filename = `publish.yml`, env blank) |
| `npm publish` fails with auth error in CI | Trusted Publisher not configured / field mismatch | Re-check the table in step 3 (workflow filename = `publish.yml`, env blank) |
| Consumer install conflict after release | Consumer mixes different lockstep releases | Align all `@gobing-ai/ts-*` packages to the same released version |
| `bump-ver` aborts "already published on npm" | The target version exists on npm | Use a higher version |
