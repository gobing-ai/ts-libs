---
schema_version: 1
name: Scaffold the ts-laya-mlx package with attribution and no weights
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.089Z
updated_at: "2026-09-21T18:04:31.930Z"
feature_id: J
priority: P1
tags:
  - laya-mlx
  - scaffold
estimate_hours: 3

---

## 0074. Scaffold the ts-laya-mlx package with attribution and no weights

### Background

Feature J adds a second DecisionDriver as its own published package. Nothing exists under packages/laya-mlx yet, so every later task needs a manifest, a build, and a place to put source. ADR-027 fixes the name and the lockstep versioning; ADR-002/ADR-004 fix how internal dependencies and tsconfig paths are written.

### Requirements

- [x] R1. packages/laya-mlx exists with src/, tests/, and worker/ directories and builds to dist/ under the workspace build script.
- [x] R2. The manifest declares @gobing-ai/ts-laya-mlx at the current lockstep version with a single `.` export.
- [x] R3. Internal dependencies on @gobing-ai/ts-ai-runner and @gobing-ai/ts-runtime are written as workspace:*, with matching tsconfig paths entries.
- [x] R4. The package carries the Apache-2.0 licence text and a NOTICE naming the upstream project and the revision it derives from.
- [x] R5. The `files` field publishes dist, src, worker, README.md, LICENSE and NOTICE, and no model weight artifact can enter the tarball.

### Acceptance Criteria

- [x] AC1 — The workspace publishes ts-laya-mlx as a lockstep-versioned package (req: R1, R2, R3)
- [x] AC2 — The published package carries upstream attribution and no weights (req: R4, R5)

`bun run build` and `bun run lint` both cover the new package with no per-package exemption.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** A new workspace package, source-only at this stage: manifest, tsconfig, build wiring, licence, NOTICE, and a placeholder entry point that exports nothing yet.

**Why this shape.** The package must exist before anything else in feature J can be written or type-checked, and its boundary decisions are the ones that are expensive to change later: the published name, the lockstep version, and `workspace:*` dependency form are all rule-enforced (ADR-002, ADR-003), and a hand-written version range here would be caught by the gate rather than by review.

**Why no engine dependency.** ADR-027 puts the engine in a host-side Python runtime driven over a process bridge, so this package has no npm dependency that executes a model. `dependencies` is exactly the two workspace siblings. Anything else appearing here later is a signal the design drifted.

**Attribution.** The vendored reference is Apache-2.0 with a NOTICE crediting the upstream project; clause 4(d) obliges carrying that NOTICE forward into anything derived from it. Weights are fetched at runtime and never redistributed, which keeps the tarball small and the licensing question confined to source.

### Plan

1. Create packages/laya-mlx with src/, tests/, worker/ and the standard package layout.
2. Write package.json: name, lockstep version, `.` export, workspace:* dependencies, files, publish config.
3. Add tsconfig with paths resolving both sibling packages to source (ADR-004).
4. Copy the Apache-2.0 LICENSE and write NOTICE naming the upstream project and source revision.
5. Add a placeholder src/index.ts so build and typecheck pass on an empty surface.
6. Confirm the package is picked up by the workspace build, lint, and typecheck scripts.
7. Pack locally and confirm the tarball contents match the files field and carry no weights.

### Solution

New package `packages/laya-mlx` (source-only scaffold; engine is the host-side
Python runtime per ADR-027, so `dependencies` is exactly the two workspace siblings):

- `packages/laya-mlx/package.json` — `@gobing-ai/ts-laya-mlx` at lockstep `0.5.1`
  (name:2, version:3); single `.` export (exports:29); `files` exactly
  `dist, src, worker, README.md, LICENSE, NOTICE` (files:34) so no weight artifact
  can enter the tarball; deps `@gobing-ai/ts-ai-runner` + `@gobing-ai/ts-runtime`
  both `workspace:*` (54–55, ADR-002); standard build/test/lint scripts mirroring
  `packages/ai-runner` incl. `publishConfig.access: public`.
- `packages/laya-mlx/tsconfig.json:5` — paths resolve `ts-ai-runner` plus the
  transitive source closure (`ts-db` + sanctioned `bun-sqlite`/`inbox` subpaths,
  `ts-infra`, `ts-runtime` + `bun-sqlite`, `ts-utils`) to sibling sources per
  ADR-004/ADR-012; extends `tooling/typescript/base.json`.
- `packages/laya-mlx/tsconfig.build.json` — emit config copied from the ai-runner
  precedent (`rootDir: src`, declarations, path-stripped).
- `packages/laya-mlx/src/index.ts` — placeholder module, `export {}` by design:
  the driver surface lands with the process-bridge tasks (0075–0079).
- `packages/laya-mlx/tests/index.test.ts` — scaffold guard: entry module stays
  importable so build/typecheck/dist smoke keep covering the package.
- `packages/laya-mlx/LICENSE` — Apache-2.0 text carried verbatim from upstream
  `laya-mlx` (`vendors/laya-mlx` @ fc1df628).
- `packages/laya-mlx/NOTICE` — names upstream `github.com/mizorewww/laya-mlx` @
  `fc1df62828a3fedf4d8229fdac1cbd85f1cdf337` and carries the upstream NOTICE
  forward verbatim (Apache-2.0 §4(d)), which itself chains Laya / Convai
  Innovations @ `6a581912`; states weights are fetched at run time, never shipped.
- `packages/laya-mlx/README.md`, `packages/laya-mlx/worker/README.md` — minimal
  attribution/host-prerequisite stub and the reserved worker directory (protocol
  lands in 0075); both inside the published `files` set.
- `bun.lock` — regenerated to register the new workspace member (required for any
  package addition; lockstep `bump-ver` auto-discovers via the `packages/*` glob).

No engine/npm dependency executes a model; no other manifest or script needed
edits — workspace build/typecheck/test discover the package via the existing
globs.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/laya-mlx/package.json:43` build script; fresh `bun run build` exited 0 this run (tsc + fix-dist-esm-extensions), dist/ emitted driver.js, index.js, worker-client.js + declarations; workspace discovery via bun.lock:104-105,250 registration |
| R2 | MET | `packages/laya-mlx/package.json:2-3` name @gobing-ai/ts-laya-mlx at 0.5.1 (lockstep with siblings after 54898bf9 bump); single `.` export `package.json:28-33` |
| R3 | MET | `packages/laya-mlx/package.json:55-56` both deps `workspace:*` (ADR-002); `packages/laya-mlx/tsconfig.json:5-14` paths closure resolving ts-ai-runner + transitive sources (ADR-004/012) |
| R4 | MET | `packages/laya-mlx/LICENSE` Apache-2.0 verbatim; `packages/laya-mlx/NOTICE:4-8` names upstream laya-mlx @ fc1df62828a3fedf4d8229fdac1cbd85f1cdf337; `NOTICE:14-31` carries upstream NOTICE forward per §4(d) |
| R5 | MET | `packages/laya-mlx/package.json:34-41` files exactly dist, src, worker, README.md, LICENSE, NOTICE; fresh `npm pack --dry-run` this run: 18 files, only allowlisted paths, zero weight artifacts |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R1 — The workspace publishes ts-laya-mlx as a lockstep-versioned package | MET | command | Fresh this run: `bun run build` exit 0; `npm pack --dry-run` → name @gobing-ai/ts-laya-mlx, version 0.5.1 (lockstep), 18 files; `package.json:55-56` deps workspace:* |
| R9 — The published package carries upstream attribution and no weights | MET | command | Fresh `npm pack --dry-run` tarball list: LICENSE (10.2kB) + NOTICE (1.3kB) present, no .safetensors/.gguf/weight files; NOTICE:5-6 names upstream project + revision |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | tests-pass | — | `bun test` packages/laya-mlx: 47 pass / 0 fail (7 files, this run) |
| P4 | typecheck | — | `tsc --noEmit` exit 0 (this run) |
| P4 | design-conformance | — | Scaffold matches task Design: source-only package, deps exactly the two workspace siblings, attribution files carried |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T04:18:21.732Z todo → wip (system)
- 2026-09-21T04:38:09.468Z wip → testing (system)
- 2026-09-21T04:38:21.744Z testing → done (system)

