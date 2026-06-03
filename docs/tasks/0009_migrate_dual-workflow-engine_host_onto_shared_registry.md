---
name: migrate dual-workflow-engine host onto shared registry
description: migrate dual-workflow-engine host onto shared registry
status: Testing
created_at: 2026-06-03T22:52:03.032Z
updated_at: 2026-06-03T23:47:45.704Z
folder: docs/tasks
type: task
feature-id: ""
priority: high
estimated_hours: 6
dependencies: ["0007"]
tags: ["0006","dual-workflow-engine","migration"]
preset: complex
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0009. migrate dual-workflow-engine host onto shared registry

### Background

Child of task 0006 (ADR-010), depends on 0007 (shared core). Replace WorkflowEngineHost's private action/guard Maps (packages/dual-workflow-engine/src/host.ts) with the shared CapabilityRegistry from @gobing-ai/ts-runtime/plugin, gaining origin metadata and introspection without changing caller-visible behavior. Parallel to 0008 (rule-engine migration) once 0007 lands. Critically, unknown action/guard lookups must keep throwing WorkflowValidationError, not the shared registry's generic Error — so the host preserves its error type at its boundary (has()-then-throw-own-error) per ADR-010 R13. Built-ins register with origin 'builtin'. This task does NOT add extension loading (that is child 0010) and does NOT touch the state-machine/transition-flow driver dispatch (deferred per ADR-010).


### Requirements

R1 WorkflowEngineHost replaces private maps with shared CapabilityRegistry<ActionRunner>('workflow action') and CapabilityRegistry<GuardRunner>('workflow guard'). R2 Public methods preserved exactly: registerAction(action):this, registerGuard(guard):this, runAction(kind,options,context), evaluateGuard(kind,options,context). R3 runAction/evaluateGuard preserve WorkflowValidationError for unknown kinds via has()-then-throw at the host boundary; the shared registry's generic get error must NOT leak (ADR-010 R13). R4 createDefaultWorkflowEngineHost built-ins (note, shell, always, never, action-ok) register with origin 'builtin'. R5 Add introspection methods hasAction, hasGuard, listActions, listGuards. R6 Dependency + tsconfig path alias to @gobing-ai/ts-runtime in sync (ADR-002/004). R7 Tests prove replacement semantics, origin metadata on built-ins, unknown action/guard errors remain WorkflowValidationError, and introspection. R8 No driver-registry work; shell action behavior unchanged. R9 bun run spur-check + bun run build pass. Acceptance: workflow action/guard behavior identical from caller perspective; errors stay WorkflowValidationError.


### Q&A



### Design

**Consumes** `@gobing-ai/ts-runtime/plugin` → `CapabilityRegistry<T>` (from 0007). Replace the host's
two private `Map`s with two shared registries; preserve every caller-visible behavior.

**Critical constraint (ADR-010 R13):** the shared `CapabilityRegistry.get` throws a generic `Error`,
but the host's tests pin `WorkflowValidationError` on unknown action/guard. So `runAction` /
`evaluateGuard` must **not** call `registry.get()` — they use `has()`-then-throw-`WorkflowValidationError`
at the host boundary, then `getEntry(kind).capability` (or `get` inside a try) to fetch. The generic
registry error must never leak.

**Moves:**

1. `private readonly actions = new CapabilityRegistry<ActionRunner>('workflow action')` and
   `guards = new CapabilityRegistry<GuardRunner>('workflow guard')`.
2. `registerAction(a)` → `this.actions.register(a.kind, a, 'extension'); return this;` (and guards).
   Built-ins in `createDefaultWorkflowEngineHost` register with `'builtin'`.
3. `runAction(kind, …)`: `if (!this.actions.has(kind)) throw new WorkflowValidationError("Unknown
   workflow action \"${kind}\"")` then run `this.actions.get(kind)`. Same for `evaluateGuard`.
4. Add introspection: `hasAction`, `hasGuard`, `listActions`, `listGuards` (R5).
5. tsconfig path alias `@gobing-ai/ts-runtime/plugin` (ADR-004); dep already `workspace:*`.

No driver-registry work; shell action untouched (ADR-010 deferrals).

### Solution

Swap the host's private maps for shared `CapabilityRegistry` instances, keep `registerAction`/
`registerGuard`/`runAction`/`evaluateGuard` signatures and `WorkflowValidationError` semantics, register
built-ins as `'builtin'`, add introspection methods, and wire the tsconfig alias. Preserve all existing
workflow tests; add focused tests for origin metadata and the new introspection.

### Plan

- [ ] Add tsconfig `@gobing-ai/ts-runtime/plugin` path alias.
- [ ] Replace private `Map`s in `WorkflowEngineHost` with shared `CapabilityRegistry` instances.
- [ ] Keep `registerAction`/`registerGuard` returning `this`; `runAction`/`evaluateGuard` throw
      `WorkflowValidationError` via `has()`-then-throw (never leak the registry's generic error).
- [ ] Register built-ins (`note`, `shell`, `always`, `never`, `action-ok`) with `origin: 'builtin'`.
- [ ] Add `hasAction`/`hasGuard`/`listActions`/`listGuards`.
- [ ] Add tests: origin metadata on built-ins, introspection, unknown-kind still
      `WorkflowValidationError`, replace-by-kind.
- [ ] `bun run lint` + `bun run test` + `bun run build` green (8/8); existing workflow tests unchanged.

### Review

**Verdict: PASS** — host migrated to shared registry with zero caller-visible drift.

#### Phase 7 — SECU (`/rd3:dev-verify --fix all`, 2026-06-03): no findings

- **Security:** no secrets/`any`/empty-catch; no new attack surface. The R13 error-wrapping holds
  system-wide — verified the drivers (`state-machine.ts`, `transition-flow.ts`) call only
  `host.runAction`/`host.evaluateGuard` (the wrapping methods), so the registry's generic `Error` cannot
  leak through any path.
- **Correctness:** the `has()`-then-`get()` double lookup has **no TOCTOU window** — no `await` or
  mutation point sits between the two calls (single-threaded JS; the `await` is on `.execute()` after
  `get()` resolves). Safe, not a race.
- **Efficiency:** double O(1) Map lookup per call — negligible for per-step workflow execution.
- **Usability:** additive optional `origin` param is backward-compatible — confirmed **no external
  consumers** of `registerAction`/`registerGuard` outside the package; all existing call sites + chaining
  unaffected.

`--fix all`: no findings to fix.

#### Phase 8 — Requirements traceability:

- **R1** ✅ `WorkflowEngineHost` now backs actions/guards with
  `CapabilityRegistry<ActionRunner>('workflow action')` and `CapabilityRegistry<GuardRunner>('workflow
  guard')` from `@gobing-ai/ts-runtime/plugin` (`src/host.ts:7-9`).
- **R2** ✅ `registerAction`/`registerGuard` still return `this`; `runAction`/`evaluateGuard` keep their
  signatures. `register*` gained an **optional** `origin` param (defaults to `'extension'`) — additive,
  backward-compatible (all existing single-arg callers + chaining unaffected, proven by 126 unchanged
  tests).
- **R3** ✅ `runAction`/`evaluateGuard` use `has()`-then-throw-`WorkflowValidationError`, then
  `get()` — the shared registry's generic `Error` never reaches callers. `host.test.ts` +
  `edge-cases.test.ts` assertions on `WorkflowValidationError` pass unchanged.
- **R4** ✅ `createDefaultWorkflowEngineHost` registers all built-ins (`note`, `shell`, `always`,
  `never`, `action-ok`) with `'builtin'`; **asserted** via the new `actionOrigin`/`guardOrigin`
  accessors.
- **R5** ✅ Added `hasAction`, `hasGuard`, `listActions`, `listGuards` — plus `actionOrigin`/
  `guardOrigin` (the latter two make built-in origin testable now and give 0010 the builtin-vs-extension
  signal it needs for override warnings).
- **R6** ✅ tsconfig `@gobing-ai/ts-runtime/plugin` alias added; dep already `workspace:*`.
- **R7** ✅ 5 new tests: introspection (has/list), origin metadata (builtin + extension default),
  replace-by-kind no-duplicate-listing, unknown-kind `WorkflowValidationError`. 131 workflow tests pass.
- **R8** ✅ No driver-registry work; `ShellActionRunner` untouched.
- **R9** ⚠ `bun run lint` + `bun run test` (931 pass) + `bun run build` (8/8) green. `spur-check` not
  runnable (no `spur` binary — same env caveat as 0007/0008).

### Testing

- **workflow suite:** 131 tests, all passing (126 existing **unchanged** + 5 new). `WorkflowValidationError`
  semantics on unknown kinds preserved; built-in origin = `'builtin'` asserted; introspection covered.
- **Full monorepo:** `bun run test` → 931 pass / 0 fail; `bun run lint` clean; `bun run build` green
  (8/8, ts-runtime `/plugin` subpath consumed by workflow engine).
- **Gate caveat:** `spur-check` pending a spur-equipped environment.

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| Code | `packages/dual-workflow-engine/src/host.ts` (private maps → shared registries + introspection) | Claude | 2026-06-03 |
| Config | `packages/dual-workflow-engine/tsconfig.json` (`/plugin` alias) | Claude | 2026-06-03 |
| Test | `packages/dual-workflow-engine/tests/host.test.ts` (+5 tests) | Claude | 2026-06-03 |

### References


