# Build and Release Scripts

`scripts/builder.ts` is the public entry point for project automation. Keep command wiring there, shared constants in `scripts/config.ts`, and reusable implementation in `scripts/lib/`.

## Commands

```bash
bun scripts/builder.ts bump-version <version> [--push]
bun scripts/builder.ts drop-tags <version> [--remote]
bun scripts/builder.ts verify-publish <aggregate-tag> [--dispatch]
bun scripts/builder.ts build
bun scripts/builder.ts typecheck
bun scripts/builder.ts fix-dist-esm-extensions <dist-dir> [...dist-dir]
bun scripts/builder.ts check-publish-manifest [dir]
bun scripts/builder.ts publish-packages [--bootstrap <package>]
bun scripts/builder.ts smoke-dist-imports
```

`check-publish-manifest` fails closed when the manifest npm is about to pack still contains a
`workspace:` range. It is wired into every package's `prepublishOnly`, so a hand-run
`npm publish` refuses to ship an unresolvable dependency instead of publishing a broken version.

`publish-packages --bootstrap <package>` publishes exactly one package, resolving `workspace:`
dependency ranges and skipping the "must already exist on npm" preflight. It is the one-time
first publish for a brand-new package (run locally with a personal npm login); every later
release goes through the Publish workflow. See `docs/PACKAGE_RELEASE.md`.

`bump-version --push` creates per-package tags for traceability and one aggregate trigger tag,
`@gobing-ai/ts-libs-v<version>`, which starts a single Publish workflow run for the whole lockstep release.

`verify-publish <aggregate-tag>` checks that a Publish workflow run exists for the aggregate release
tag and prints its id and URL, exiting 1 when none exists. It is the post-push check for a
local-mode release (`bump-version` without `--push`). The lookup is bounded — up to 3 `gh run list`
attempts 5s apart (~10s) — so an immediate scripted run can report a false "no run" for a trigger
that is merely late; re-run it, or pass `--dispatch`. With `--dispatch` it first performs the same
bounded lookup and, only when no run exists, dispatches `publish.yml` once at the tag ref — the
safe recovery for a missed push event, never a tag delete or re-push.

Root `package.json` keeps short aliases for the release commands:

```bash
bun run bump-ver 0.1.6 --push
bun run drop-tags 0.1.6 --remote
```

Root `build` and `typecheck` also delegate here. They discover publishable workspaces from the root `workspaces` globs, sort them by internal package dependencies, then run each package script. The sort is canonical — it depends on the package set, not on filesystem discovery order — so the sequence is identical on every machine and in CI. `build` finishes by smoke-importing every package's `dist/index.js` with Bun; packages listed in `buildConfig.nodeSmokePackages` are also smoke-imported with Node. That list is empty by default.

## Layout

- `config.ts` centralizes project-specific constants: package naming, release tag format, workflow name, optional Node smoke import targets, and semver validation.
- `builder.ts` parses commands and delegates to libraries.
- `lib/` contains reusable build, release, command, and workspace helpers.
- `tests/` contains unit tests for script behavior.
