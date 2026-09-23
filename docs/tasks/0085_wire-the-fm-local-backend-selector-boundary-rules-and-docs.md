---
schema_version: 1
name: Wire the fm-local backend selector, boundary rules and docs
status: done
template: feature-impl
created_at: 2026-09-23T16:30:08.845Z
updated_at: "2026-09-23T19:54:01.792Z"
feature_id: K
priority: P2
tags:
  - ai-runner
  - decision-fm
  - rules
  - docs
estimate_hours: 3

dependencies: ["0084", "0083"]
---

## 0085. Wire the fm-local backend selector, boundary rules and docs

### Background

Implements: R11 — An application swaps to the fm-local backend without editing a call site; R12 — ts-ai-runner names the fm-local backend without depending on its package; R17 — The design decisions and usage are recorded in the project documents. Design of record: ADR-028 selection seam, ADR-029 and docs/design/decision-fm-backend.md § Backend selection.

**Refine corrections (2026-09-23)**
- "a missing package raises `DecisionConfigError`" → the laya path wraps both import failure and a missing factory export in `DecisionConfigError(msg, 'LAYA_BACKEND', { cause })` (`packages/ai-runner/src/decision/decision-maker.ts:86-101`) → fm mirrors it with variable `'FM_BACKEND'` and factory `createFmDriver`.
- "`resolveLayaDriver` passes fm-specific options" → it forwards the whole `DecisionMakerOptions`, whose index signature (`[key: string]: unknown`, line 65) already admits `samples`, `deterministic`, `executor`, `platform`, `arch` → no facade type change; `createFmDriver` ignores facade-only keys (`backend`, `env`, `apiKey`, `model`, `baseURL`, `timeoutMs`, `maxRetries`, `fetch`).
- R5 flips ADR-031 (the fm agent shim, task 0083) as well as ADR-029/030 → dependency on 0083 added alongside the existing 0084 edge.
- Current ADR status text is `Accepted (design)` (`docs/00_ADR.md:526,544,560`); the flip target is `Accepted` with a `Built: <date>` note, per the ADR-028 precedent.

### Requirements

- [x] R1. `DecisionBackend = 'typesafe' | 'laya-local' | 'fm-local'`; add `FM_DRIVER_PACKAGE = '@gobing-ai/ts-decision-fm'` and `resolveFmDriver(options)` mirroring `resolveLayaDriver` (dynamic import on first ask, `createFmDriver(options)`, failures ⇒ `DecisionConfigError(…, 'FM_BACKEND', { cause })` naming the package and `bun add` hint); one new branch in `createDecisionMaker`.
- [x] R2. `packages/ai-runner/package.json` gains no dependency, peer or optional entry for `@gobing-ai/ts-decision-fm`.
- [x] R3. In `.spur/rules/typescript/decision-boundaries.yaml`, add `no-fm-driver-import-in-ai-runner` (forbidden-import `@gobing-ai/ts-decision-fm`, scope `packages/ai-runner/src/**/*.ts`) and `decision-fm-process-executor-only` (forbid `node:child_process`, `child_process`, `Bun.spawn|spawnSync` usage; scope `packages/decision-fm/src/**/*.ts`), both `severity: error`, in the laya rule shape.
- [x] R4. In `packages/ai-runner/tests/decision/backend-selection.test.ts`: `backend: 'fm-local'` with `platform: 'darwin'`, `arch: 'arm64'` and a stub executor answers `choice`/`score`/`noul` through the unchanged facade calls used for the typesafe/laya cases; `dm.driver === 'fm-local'`.
- [x] R5. ADR-029/030/031 status → `Accepted` with build date; docs/03 decision-fm section and docs/04 index row marked built; README of ts-ai-runner lists `fm-local` next to `laya-local`.

Out of scope: config-file selection of the backend, retries, and any fm option added to the typed `DecisionMakerOptions` surface.

### Acceptance Criteria

- [x] AC1 — An application swaps to the fm-local backend without editing a call site
- [x] AC2 — ts-ai-runner names the fm-local backend without depending on its package
- [x] AC3 — The design decisions and usage are recorded in the project documents

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-23T17:08:41.273Z

- Closed: duplicate the resolver instead of generalizing it (two call sites, backend-specific error text).
- Closed: fm tuning through `backend: 'fm-local'` rides the existing index signature; typed tuning uses `driver: createFmDriver(...)`.

### Design

Reuse the ADR-028 one-way dynamic-import seam unchanged — a literal, a package constant, a resolver and a branch are the whole code change. A second copy of the resolver is preferred over a generic `resolveDriverPackage(pkg, factory, variable)`: two call sites, each four lines of difference, and the error text differs per backend (three similar lines beat a premature abstraction). Rules live under `.spur/rules/` per ADR-006 so the boundary is enforced, not reviewed. Rejected: static optional peer dependency (creates the edge ADR-028 forbids). Invariant: selecting another backend never loads the fm package.

Callers needing typed fm options construct the driver themselves: `createDecisionMaker({ driver: createFmDriver({ samples: 9 }) })`; the `backend: 'fm-local'` path forwards loose keys only.

Rule verification: plant `import '@gobing-ai/ts-decision-fm'` in an ai-runner source file and `Bun.spawn(` in a decision-fm source file, run `spur rule check`, see both fire, remove the plants.

### Plan

0. Confirm 0083 and 0084 are done and `@gobing-ai/ts-decision-fm` resolves from ai-runner tests via the workspace link.
1. TDD the `fm-local` selection path in backend-selection.test.ts (R1, R4), including the `FM_BACKEND` config error.
2. Implement the literal, constant, resolver and branch in decision-maker.ts.
3. Add the two spur rules; verify with planted violations, then remove them (R3). Confirm the ai-runner manifest is unchanged (R2).
4. Update ADR status lines, docs/03, docs/04, ts-ai-runner README (R5).
5. `bun run spur-check` and `bun run build`.

### Solution

**Code (R1, AC1, AC2)** — `packages/ai-runner/src/decision/decision-maker.ts`:
- `DecisionBackend` gains `'fm-local'` (`decision-maker.ts:66`); `FM_DRIVER_PACKAGE = '@gobing-ai/ts-decision-fm'` + `resolveFmDriver(options)` (`decision-maker.ts:102-121`) mirror `resolveLayaDriver` line-for-line: dynamic import on first ask, `createFmDriver(options)` factory call, both import failure and missing-factory wrapped as `DecisionConfigError(msg, 'FM_BACKEND', { cause })` naming the package and `bun add @gobing-ai/ts-decision-fm`. Deliberate duplicate resolver per Design (two call sites, per-backend error text).
- One new branch in `createDecisionMaker.getDriver` (`decision-maker.ts:150-153`). Loose fm options (`platform`, `arch`, `executor`, `samples`, …) ride the existing index signature; facade-only keys are ignored by `createFmDriver`.

**Tests (R4)** — `packages/ai-runner/tests/decision/backend-selection.test.ts`: `backend: 'fm-local'` + `platform: 'darwin'`/`arch: 'arm64'` + scripted `ProcessExecutor` (stub `available`/`count-tokens`/`respond` queue) answers `choice`/`score`/`noul` through the same facade sugar as the typesafe/laya cases; `dm.driver === 'fm-local'`. Second case drives the resolver's wrap through a real `createFmDriver` construction failure (unsupported host) and asserts `variable === 'FM_BACKEND'` plus the package/`bun add` message.

**Rules (R3)** — `.spur/rules/typescript/decision-boundaries.yaml`: `no-fm-driver-import-in-ai-runner` (forbidden import `@gobing-ai/ts-decision-fm`, scope `packages/ai-runner/src/**/*.ts`) and `decision-fm-process-executor-only` (forbids `node:child_process`, `child_process`, `Bun.spawn|spawnSync` usage in `packages/decision-fm/src/**/*.ts`), both `severity: error`, in the laya rule shape.

Plant-run evidence (Design's verification step): planted `import { createFmDriver } from '@gobing-ai/ts-decision-fm';` in `packages/ai-runner/src/identity.ts` → `spur rule run --preset recommended-pre-check` reported `ERROR no-fm-driver-import-in-ai-runner packages/ai-runner/src/identity.ts:126`; planted `Bun.spawn([...])` / `Bun.spawnSync([...])` in `packages/decision-fm/src/estimate.ts` → `ERROR decision-fm-process-executor-only …:101/:102` (plus the pre-existing global `no-direct-process-spawn`). Plants removed afterwards; both files restored; `spur rule run --preset recommended-pre-check` and `--preset recommended-post-check` exit 0. Note: a bare side-effect import (`import 'pkg';`) is not matched by the forbidden-import evaluator — named/default import forms are; same limitation as the existing laya rule.

**Docs (R5, AC3)** — `docs/00_ADR.md:526/544/560`: ADR-029/030/031 status `Accepted (design)` → `Accepted` with `**Built:** 2026-09-23` in the status line. `docs/03_ARCHITECTURE.md:164`: decision-fm section heading now "built 2026-09-23 — ADR-029/ADR-030/ADR-031". `docs/04_DESIGN.md:27`: decision-fm index row "built 2026-09-23". `packages/ai-runner/README.md` (Decision Making intro): named-backends paragraph listing `typesafe` (default), `laya-local` (`@gobing-ai/ts-laya-mlx`) and `fm-local` (`@gobing-ai/ts-decision-fm`), the dynamic-import/no-manifest-dependency rule, and the `driver:` escape hatch for typed options.

**R2** — `packages/ai-runner/package.json` untouched (no decision-fm dependency/peer/optional entry; verified via `git diff` + grep).

**Deviations**
1. The literal "missing-package" scenario is not reproducible in-process: `bun test` runs all files in one process/module registry, `mock.module` is process-global and cannot displace an already-imported module (or be undone for later imports), so a mock-based missing-package test either starves or poisons the real-import selection test in the same file. The wrap path is instead covered by a real `createFmDriver` construction failure flowing through the identical catch, asserting the same `FM_BACKEND` variable and message. Mirrors the laya precedent, whose error-path test also does not exercise the import failure.
2. `packages/ai-runner/tsconfig.json` gains `"@gobing-ai/ts-decision-fm": ["../decision-fm/src/index"]` (ADR-004 source-resolution alias, mirroring the laya line). Without it the dynamic import resolved the workspace link to `dist/`, pulling `packages/decision-fm/dist/fm-process.js` into the coverage report and failing the bunfig 90% coverage threshold. The alias is a tsconfig paths entry, not a package.json dependency — R2 untouched; the same alias already exists for `ts-laya-mlx`.
3. The `Built:` wording does not exist verbatim anywhere in `docs/00_ADR.md` yet (the refine note's "ADR-028 precedent" predates the file's current state); rendered as `**Status:** Accepted · **Date:** 2026-09-23 · **Built:** 2026-09-23 · **Targets:** …`, consistent with the file's status-line shape.

**Risks**
- A bare side-effect import of `@gobing-ai/ts-decision-fm` under `packages/ai-runner/src/**` would not trip `no-fm-driver-import-in-ai-runner` (pre-existing evaluator limitation, shared with the laya rule).
- `docs/03_ARCHITECTURE.md` § laya-mlx still reads "(accepted design …; not yet built)" although laya shipped in task 0080 — pre-existing drift outside this task's scope, flagged for doc-evolve.
- resolver lines `decision-maker.ts:92,95-99` (laya missing-factory/catch) remain uncovered — pre-existing, symmetric with fm's shape (fm's catch is covered via the construction-failure test; `decision-maker.ts` at 91.86% lines, above the 90% gate).

**Verification** — `bun run spur-check` exit 0 (Biome + per-package `tsc --noEmit` + 2459 tests across 215 files with coverage thresholds + both spur rule presets). `bun run build` exit 0 (all packages). `bun test packages/ai-runner packages/decision-fm`: 356 pass, 0 fail.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | packages/ai-runner/src/decision/decision-maker.ts:46 union adds 'fm-local'; :104 FM_DRIVER_PACKAGE and :106-122 resolveFmDriver mirroring resolveLayaDriver (:86-102) — dynamic import on first ask, createFmDriver(options) factory check, failures wrapped as DecisionConfigError 'FM_BACKEND' naming package + bun add hint (:115-121); single new branch :149-152, lazy via getDriver |
| R2 | MET | packages/ai-runner/package.json has zero 'decision-fm' matches (grep over full file incl. all dependency sections) and the file is absent from the diff; bun.lock diff adds only the decision-fm workspace entry + alias, ai-runner dependency block untouched; packages/ai-runner/tsconfig.json:8 '@gobing-ai/ts-decision-fm' is a paths-only alias (compile-time, ADR-004 pattern mirroring ts-laya-mlx), not a manifest edge — ADR-028 holds |
| R3 | MET | .spur/rules/typescript/decision-boundaries.yaml:66-76 no-fm-driver-import-in-ai-runner (forbidden-import '@gobing-ai/ts-decision-fm', scope packages/ai-runner/src/**, severity error) and :77-90 decision-fm-process-executor-only (node:child_process + child_process + Bun spawn/spawnSync usage pattern, scope packages/decision-fm/src/**, severity error) — exact shape parity with laya rules :40-51 and :52-64; .spur/run/0085-test-gate.log:22 pre-check 'All 55 rules passed' and :227 post-check 'All 2 rules passed' |
| R4 | MET | packages/ai-runner/tests/decision/backend-selection.test.ts:94-163 new fm-local block; :124-146 creates backend 'fm-local' with platform 'darwin' and arch 'arm64' plus scripted StubFmExecutor, asserts dm.driver === 'fm-local' (:139) and drives choice/score/noul through the unchanged facade sugar (:140-145); executed in the recorded gate (2459 pass, 0085-test-gate.log:216-217) |
| R5 | MET | docs/00_ADR.md:526, :544, :560 ADR-029/030/031 flipped to 'Accepted · Built: 2026-09-23' (ADR-027/028 intentionally stay 'Accepted (design)'); docs/03_ARCHITECTURE.md:164-167 decision-fm section marked built; docs/04_DESIGN.md:27 index row 'built 2026-09-23'; packages/ai-runner/README.md:743-747 named-backends paragraph lists fm-local beside laya-local with the no-manifest-dependency rule and driver: escape hatch |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | test | backend-selection.test.ts:124-146 — app swaps to fm-local by one options key with zero call-site edits: same createDecisionMaker + choice/score/noul facade calls as typesafe/laya cases, real dynamic import of workspace ts-decision-fm end to end; runnable via bun test (recorded in 0085-test-gate.log:216, 2459 pass / 0 fail) |
| AC-2 | MET | test | Dynamic-import-only resolution with the sole fm reference in decision-maker.ts:104-122 (grep-verified no other src import); manifest clean (package.json grep 0 hits, bun.lock ai-runner block unchanged); failure UX asserted in backend-selection.test.ts:148-161 (DecisionConfigError, FM_BACKEND, package + bun add message); static enforcement by decision-boundaries.yaml:66-76 passing both presets (0085-test-gate.log:22, :227) |
| AC-3 [docs-only] | MET | static-ref | 00_ADR.md:526,544,560; 03_ARCHITECTURE.md:164; 04_DESIGN.md:27; README.md:743-747; implementation matches design-of-record decision-fm-backend.md:174-188 § Backend selection (union, laya-parity dynamic import, config-error contract, two rules) |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |
| P4 | proof-input-digest | — | sha256:81c994ce3c3f95f0ccb96e4b1e6419d3e8e8ca3638b837b7c4def032347ba361 |

### References

- Feature K; ADR-028/029/030/031; docs/design/decision-fm-backend.md § Backend selection.
- Precedent: `resolveLayaDriver` (packages/ai-runner/src/decision/decision-maker.ts:84-101); rules `no-laya-driver-import-in-ai-runner`, `laya-mlx-process-executor-only`.
- Depends on tasks 0083 and 0084.

### History

- 2026-09-23T19:14:21.688Z todo → wip (system)
- 2026-09-23T19:54:01.474Z wip → testing (system)
- 2026-09-23T19:54:01.792Z testing → done (system)

