# Build and Release Scripts

`scripts/builder.ts` is the public entry point for project automation. Keep command wiring there, shared constants in `scripts/config.ts`, and reusable implementation in `scripts/lib/`.

## Commands

```bash
bun scripts/builder.ts bump-version <version> [--push]
bun scripts/builder.ts drop-tags <version> [--remote]
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

## Layout

- `config.ts` centralizes project-specific constants: package naming, release tag format, workflow name, smoke import targets, and semver validation.
- `builder.ts` parses commands and delegates to libraries.
- `lib/` contains reusable build, release, command, and workspace helpers.
- `tests/` contains unit tests for script behavior.
