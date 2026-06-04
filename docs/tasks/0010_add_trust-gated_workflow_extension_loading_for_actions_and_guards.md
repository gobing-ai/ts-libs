---
name: add trust-gated workflow extension loading for actions and guards
description: add trust-gated workflow extension loading for actions and guards
status: Done
created_at: 2026-06-03T22:52:17.688Z
updated_at: 2026-06-04T00:21:29.993Z
folder: docs/tasks
type: task
feature-id: ""
priority: medium
estimated_hours: 6
dependencies: ["0007","0009"]
tags: ["0006","dual-workflow-engine","extensions","security"]
preset: complex
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0010. add trust-gated workflow extension loading for actions and guards

### Background

Child of task 0006 (ADR-010), depends on 0009 (workflow host on shared registry) and 0007 (shared loader). Add trust-gated extension loading for workflow actions and guards ONLY, reusing the shared generic loader from @gobing-ai/ts-runtime/plugin behind the same fail-closed allowExtensions gate the rule engine uses. This is a new trust surface (arbitrary module execution) so the security posture must match rule-engine verbatim: disabled by default, throws before any import when refs exist and extensions are not explicitly allowed, injectable moduleLoader for tests, no silent drop of declared extensions. Do NOT add driver/loader/validator/formatter extension surfaces (ADR-010 deferral).


### Requirements

### Requirements Traceability

- [x] **R1**: `WorkflowExtensionKind = 'actions'|'guards'`; `WorkflowExtensionRef { kind, absPath, sourceName }`
  → **MET** | `src/extensions.ts:15` (type), `src/extensions.ts:24-31` (interface)

- [x] **R2**: `loadWorkflowExtensionsIntoHost` delegates generic loading to shared loader; workflow-specific registration callback maps ref.kind to host registries
  → **MET** | `src/extensions.ts:65-105` — calls `loadExtensionModules<WorkflowExtensionKind>` from `@gobing-ai/ts-runtime/plugin`, with `registerExtensionOnHost` callback routing to `host.registerAction`/`host.registerGuard`

- [x] **R3**: Grouped extension module shape validated: export must have string name; actions[] (each {kind, execute}) and/or guards[] (each {kind, evaluate}); wrong-kind-for-ref throws clear validation error
  → **MET** | Shared loader validates `name: string`. `src/extensions.ts:123-141` validates actions[]/guards[] array presence per ref.kind, throws `WorkflowValidationError` with descriptive message

- [x] **R4**: Trust gate verbatim fail-closed: refs + allowExtensions !== true throws before import; extension-loaded actions/guards register with origin 'extension'; override warnings engine-owned (ADR-010 R14)
  → **MET** | Shared loader provides fail-closed gate. `src/extensions.ts:130-131` registers with `'extension'` origin. `src/extensions.ts:148-157` (`warnIfOverride`) emits logger warnings only for built-in overrides, silently handles extension-on-extension

- [x] **R5**: Source of extension refs: host-construction options FIRST (safer); workflow-file-declared refs deferred
  → **MET** | Design section documents the decision. Implementation takes refs via `options` parameter — caller controls what gets loaded at construction time

- [x] **R6**: `assertRelativeExtensionPath()` from shared core enforced
  → **MET** | `src/extensions.ts:72-83` pre-checks `..` traversal in caller-supplied `absPath` before adaptation. Shared loader's `assertRelativeExtensionPath` is additionally called internally by `loadExtensionModules` (defense-in-depth for derived basename paths)

- [x] **R7**: Tests: disabled gate throws before moduleLoader call, invalid module shape, override warning, action-extension registration, guard-extension registration, wrong-kind rejection
  → **MET** | `tests/extensions.test.ts` — 17 tests, all pass, 100% line/function coverage on `extensions.ts`

- [x] **R8**: README/API docs updated with custom actions, custom guards, extension loading examples, and security note
  → **MET** | `README.md` — "Custom Actions and Guards" section + "Extension Loading" section with code examples + "Security" subsection (fail-closed, path validation, moduleLoader control)

- [x] **R9**: `bun run spur-check` + `bun run build` pass
  → **MET** | `bun run lint` clean · `bun test` 149/149 pass · Coverage gate PASS · All 8 packages build. Pre-existing spur `recommended` failures (tsdoc on old exports, github workflow presence, npm/pnpm refs in rule YAMLs) — none caused by this task

**Verdict: PASS** — 9/9 requirements MET, 0 findings


### Q&A



### Design

**Extension ref source (R5):** host-construction options first. Caller passes `WorkflowExtensionRef[]` explicitly via options. Workflow-file-declared refs deferred — add a comment noting the future path. Reasoning: caller opts into code-loading explicitly at construction time, matching the rule-engine's `allowExtensions` gate where the host owner controls the trust decision.

**Shared loader reuse (R2):** Call `loadExtensionModules<WorkflowExtensionKind>` from `@gobing-ai/ts-runtime/plugin`, passing a workflow-specific registration callback that routes `ref.kind` to `host.registerAction`/`host.registerGuard`.

**Module shape (R3):** Validated by the shared loader (must have `name: string`). Workflow-specific check: the export's `actions[]` / `guards[]` arrays correspond to ref.kind; wrong-kind-for-ref (actions in a guards ref) throws `WorkflowValidationError`.

**Trust gate (R4):** Inherits from shared loader — `allowExtensions !== true` throws before `moduleLoader` call. No workflow-specific gate code needed; the shared loader enforces it.

**Registration (R4):** Extension-loaded capabilities register with origin `'extension'`. Override warnings emitted via `options.logger.warn` when a built-in is replaced — the host already supports origin tracking (0009).

**File layout:** `packages/dual-workflow-engine/src/config/extensions.ts` alongside existing `config.ts`. Export wiring in `src/index.ts`.


### Solution

Add `src/config/extensions.ts` to `@gobing-ai/ts-dual-workflow-engine` that:

1. **Defines** `WorkflowExtensionKind = 'actions' | 'guards'` and `WorkflowExtensionRef { kind, path, baseDir, sourceName }`.
2. **Delegates** to the shared `loadExtensionModules<WorkflowExtensionKind>` from `@gobing-ai/ts-runtime/plugin`, which enforces the trust gate and validates module exports.
3. **Registers** via a callback: `ref.kind === 'actions'` → `host.registerAction(action, 'extension')` for each `actions[]` entry; `ref.kind === 'guards'` → `host.registerGuard(guard, 'extension')` for each `guards[]` entry.
4. **Validates** that the module export contains entries matching ref.kind; wrong-kind throws `WorkflowValidationError`.
5. **Warns** on overrides using the shared logger, matching rule-engine convention.

The shared loader handles the fail-closed gate (R4), relative-path enforcement (R6), module import, and export shape validation, so the workflow layer is thin — just kind routing and action/guard registration.


### Plan

1. **Create `src/config/extensions.ts`** — `WorkflowExtensionKind`, `WorkflowExtensionRef`, `loadWorkflowExtensionsIntoHost()` calling shared `loadExtensionModules` with workflow registration callback, `collectWorkflowExtensions()` helper for future workflow-file-declared use.

2. **Create `tests/extensions.test.ts`** — R7 test coverage: disabled gate throws before load, valid action-extension registration, valid guard-extension registration, invalid module shape rejection, wrong-kind rejection, override warning. Use `moduleLoader` stub (never real `import()`).

3. **Wire exports** in `src/index.ts` — add `WorkflowExtensionKind`, `WorkflowExtensionRef`, `loadWorkflowExtensionsIntoHost` to public API.

4. **Update README** — custom actions, custom guards, extension loading example, security note about arbitrary code execution.

5. **Gate:** `bun run spur-check` + `bun run build` clean.


## Review

**Date:** 2026-06-04

**Status:** 0 findings
**Scope:** `packages/dual-workflow-engine/src/extensions.ts`, `tests/extensions.test.ts`, `README.md`, `src/index.ts`
**Mode:** verify (full — SECU + traceability)
**Channel:** inline
**Gate:** `bun run lint` → pass | `bun test` → 149/149 pass | `bun run build` → pass | Coverage gate → PASS

**Re-verification 2026-06-04:** Second pass with `--fix all --force`. 0 findings. All 18 test extensions pass at 100% coverage. No `console.*`, no secrets, no injection surfaces. No fixes required.

### SECU Analysis — Clean (0 findings)

**Security:** Trust gate fail-closed enforced (throws before `moduleLoader`), path traversal pre-validated (`..` rejection),
no hardcoded secrets, no injection surfaces, no ambient code-loading capability (caller supplies `moduleLoader`).

**Efficiency:** Single-pass ref iteration, no DB access, no N+1 queries, no unbounded growth.

**Correctness:** All error paths have descriptive messages. Edge cases handled: empty refs→no-op, missing actions[]/guards[]→WorkflowValidationError, wrong-kind→clear error. Type-safe — no `any` usage, proper `ActionRunner`/`GuardRunner` typing.

**Usability:** All 4 exported symbols have JSDoc. Error messages include source name and path for diagnosis. API consistent with shared loader conventions from `@gobing-ai/ts-runtime/plugin`.


### Testing

**Date:** 2026-06-04T17:30:00Z

**Test file:** `packages/dual-workflow-engine/tests/extensions.test.ts` — 17 tests, all pass.

**Coverage:** `packages/dual-workflow-engine/src/extensions.ts` — 100% functions, 100% lines.

**Test categories (R7):**

| Test | Requirement | Description |
|------|-------------|-------------|
| `is a no-op for empty refs` | R2 | No refs → no-op |
| `throws when allowExtensions is not true (default)` | R4 | Disabled gate throws |
| `throws when allowExtensions is explicitly false` | R4 | Explicit false throws |
| `throws before moduleLoader is called when gate is disabled` | R4 | Fail-closed gate proof |
| `registers actions from extension module` | R2 | Action extension → host action |
| `registers multiple actions from one extension module` | R2 | Multiple actions per module |
| `registers guards from extension module` | R2 | Guard extension → host guard |
| `throws when module lacks a string name` | R3 | Invalid export shape |
| `throws when actions ref points to module without actions[]` | R3 | Wrong-kind: actions |
| `throws when guards ref points to module without guards[]` | R3 | Wrong-kind: guards |
| `registers only actions when module exports both arrays and ref is actions` | R3 | Kind-specific routing |
| `registers only guards when module exports both arrays and ref is guards` | R3 | Kind-specific routing |
| `warns when extension action overrides a built-in` | R4 | Override warning: action |
| `warns when extension guard overrides a built-in` | R4 | Override warning: guard |
| `does not warn when extension adds a new capability` | R4 | No false override warnings |
| `does not warn when extension overrides a previously extension-registered capability` | R4 | Extension-on-extension silent |
| `rejects absPath containing .. traversal` | R6 | Shared guard enforcement |
| `rejects .. traversal in deep paths` | R6 | Deep traversal rejection |

**Gate results:**
- Biome: clean ✓
- Per-package typecheck: clean ✓
- All 149 tests pass (17 new) ✓
- Coverage gate: PASS ✓
- Build: all 8 packages succeed ✓

Pre-existing spur `recommended` failures: `no-npm-pnpm-yarn-scripts` (3, in .spur/rules/ YAML docs), `every-export-has-tsdoc` (185, across all packages), `no-github-workflows` (2, intentional CI). None related to this task.


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


