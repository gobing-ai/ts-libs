# Build and Release Scripts

`scripts/builder.ts` is the public entry point for project automation. Keep command wiring there, shared constants in `scripts/config.ts`, and reusable implementation in `scripts/lib/`.

## Commands

```bash
bun scripts/builder.ts bump-version <version> [--push]
bun scripts/builder.ts drop-tags <version> [--remote]
bun scripts/builder.ts build
bun scripts/builder.ts typecheck
bun scripts/builder.ts fix-dist-esm-extensions <dist-dir> [...dist-dir]
bun scripts/builder.ts publish-packages
bun scripts/builder.ts smoke-dist-imports
```

`bump-version --push` creates per-package tags for traceability and one aggregate trigger tag,
`@gobing-ai/ts-libs-v<version>`, which starts a single Publish workflow run for the whole lockstep release.

Root `package.json` keeps short aliases for the release commands:

```bash
bun run bump-ver 0.1.6 --push
bun run drop-tags 0.1.6 --remote
```

Root `build` and `typecheck` also delegate here. They discover publishable workspaces from the root `workspaces` globs, sort them by internal package dependencies, then run each package script. `build` finishes by smoke-importing every package's `dist/index.js` with Bun; packages listed in `buildConfig.nodeSmokePackages` are also smoke-imported with Node. That list is empty by default.

## Layout

- `config.ts` centralizes project-specific constants: package naming, release tag format, workflow name, optional Node smoke import targets, and semver validation.
- `builder.ts` parses commands and delegates to libraries.
- `lib/` contains reusable build, release, command, and workspace helpers.
- `tests/` contains unit tests for script behavior.
