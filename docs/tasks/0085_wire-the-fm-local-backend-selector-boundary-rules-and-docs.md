---
schema_version: 1
name: Wire the fm-local backend selector, boundary rules and docs
status: todo
template: feature-impl
created_at: 2026-09-23T16:30:08.845Z
updated_at: "2026-09-23T17:08:41.420Z"
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

- [ ] R1. `DecisionBackend = 'typesafe' | 'laya-local' | 'fm-local'`; add `FM_DRIVER_PACKAGE = '@gobing-ai/ts-decision-fm'` and `resolveFmDriver(options)` mirroring `resolveLayaDriver` (dynamic import on first ask, `createFmDriver(options)`, failures ⇒ `DecisionConfigError(…, 'FM_BACKEND', { cause })` naming the package and `bun add` hint); one new branch in `createDecisionMaker`.
- [ ] R2. `packages/ai-runner/package.json` gains no dependency, peer or optional entry for `@gobing-ai/ts-decision-fm`.
- [ ] R3. In `.spur/rules/typescript/decision-boundaries.yaml`, add `no-fm-driver-import-in-ai-runner` (forbidden-import `@gobing-ai/ts-decision-fm`, scope `packages/ai-runner/src/**/*.ts`) and `decision-fm-process-executor-only` (forbid `node:child_process`, `child_process`, `Bun.spawn|spawnSync` usage; scope `packages/decision-fm/src/**/*.ts`), both `severity: error`, in the laya rule shape.
- [ ] R4. In `packages/ai-runner/tests/decision/backend-selection.test.ts`: `backend: 'fm-local'` with `platform: 'darwin'`, `arch: 'arm64'` and a stub executor answers `choice`/`score`/`noul` through the unchanged facade calls used for the typesafe/laya cases; `dm.driver === 'fm-local'`.
- [ ] R5. ADR-029/030/031 status → `Accepted` with build date; docs/03 decision-fm section and docs/04 index row marked built; README of ts-ai-runner lists `fm-local` next to `laya-local`.

Out of scope: config-file selection of the backend, retries, and any fm option added to the typed `DecisionMakerOptions` surface.

### Acceptance Criteria

- [ ] AC1 — An application swaps to the fm-local backend without editing a call site
- [ ] AC2 — ts-ai-runner names the fm-local backend without depending on its package
- [ ] AC3 — The design decisions and usage are recorded in the project documents

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature K; ADR-028/029/030/031; docs/design/decision-fm-backend.md § Backend selection.
- Precedent: `resolveLayaDriver` (packages/ai-runner/src/decision/decision-maker.ts:84-101); rules `no-laya-driver-import-in-ai-runner`, `laya-mlx-process-executor-only`.
- Depends on tasks 0083 and 0084.

### History
