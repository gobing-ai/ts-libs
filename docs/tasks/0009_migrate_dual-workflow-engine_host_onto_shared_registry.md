---
name: migrate dual-workflow-engine host onto shared registry
description: migrate dual-workflow-engine host onto shared registry
status: Done
created_at: 2026-06-03T22:52:03.032Z
updated_at: 2026-06-04T02:24:05.720Z
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

## Requirements — 2026-06-04 (re-audit, --force)

All 9 requirements MET. 149/149 tests pass. No scope drift.

- [x] **R1**: WorkflowEngineHost replaces private Maps with shared CapabilityRegistry → **MET** | Evidence: `host.ts:8-9` — `CapabilityRegistry<ActionRunner>('workflow action')` and `CapabilityRegistry<GuardRunner>('workflow guard')`
- [x] **R2**: Public methods preserved: registerAction/registerGuard return `this`; runAction/evaluateGuard signatures unchanged → **MET** | Evidence: `host.ts:12-15,18-21,54-59,62-65`; `origin` param is optional (defaults to `'extension'`), backward-compatible
- [x] **R3**: runAction/evaluateGuard preserve WorkflowValidationError for unknown kinds via has()-then-throw; shared registry generic Error never leaks → **MET** | Evidence: `host.ts:54-58,62-65` — `has()` guard before `get()`; no TOCTOU (no await between)
- [x] **R4**: Built-ins (note, shell, always, never, action-ok) register with origin 'builtin' → **MET** | Evidence: `host.ts:73-82` — all 5 built-ins pass `'builtin'` as second arg
- [x] **R5**: Introspection methods: hasAction, hasGuard, listActions, listGuards (plus actionOrigin/guardOrigin) → **MET** | Evidence: `host.ts:24-51`
- [x] **R6**: tsconfig path alias + workspace dep → **MET** | Evidence: `tsconfig.json:8` — `@gobing-ai/ts-runtime/plugin` mapped to shared core
- [x] **R7**: Tests: origin metadata, introspection, unknown-kind WorkflowValidationError, replace-by-kind → **MET** | Evidence: 149 tests passing (up from 131 in previous review)
- [x] **R8**: No driver-registry work; shell action untouched → **MET** | Evidence: `host.ts:98-120` — ShellActionRunner unchanged
- [x] **R9**: Lint + test + build green → **MET** | Evidence: `bun run spur-check` pass (30 rules + 948 tests + 8× typecheck)

### Scope Drift
None detected.


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

## Review — 2026-06-04 (re-audit, --force)

**Verdict: PASS** — Host migrated to shared registry with zero caller-visible drift. No SECU findings.
**Scope:** `packages/dual-workflow-engine/src/host.ts` + tsconfig
**Mode:** verify (Phase 7 SECU + Phase 8 traceability)
**Channel:** current
**Gate:** `bun run spur-check` → pass (30 rules + 948 tests + 8× typecheck); workflow suite 149/149 pass

### P1 — Blockers
No findings.

### P2 — Warnings
No findings.

### P3 — Info
No findings.

### P4 — Suggestions
No findings.

#### SECU analysis notes

- **Security:** No secrets, no `any`, no empty catch blocks. R13 error-wrapping intact: `runAction` (line 54-58) and `evaluateGuard` (line 62-64) guard with `has()`-then-throw-`WorkflowValidationError` before touching the shared registry's `get()`. No TOCTOU window — no `await` between `has()` and `get()` (single-threaded JS). No cross-package imports to `ts-rule-engine`.
- **Efficiency:** Double O(1) Map lookup per call — negligible for per-step workflow execution.
- **Correctness:** Optional `origin` param defaults to `'extension'` — backward-compatible with all single-arg callers. `register*` still returns `this` for chaining. Built-ins registered with `'builtin'` (`host.ts:73-82`).
- **Usability:** Six introspection methods added: `hasAction`, `hasGuard`, `listActions`, `listGuards`, `actionOrigin`, `guardOrigin`. Clean, well-named.


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


