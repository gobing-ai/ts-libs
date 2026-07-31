---
schema_version: 1
name: shared plugin core for rule-engine and dual-workflow-engine
description: Extract a shared plugin/capability core used by rule-engine and dual-workflow-engine
status: done
type: task
profile: complex
priority: P2
created_at: 2026-06-03T00:36:54.000Z
updated_at: 2026-06-04T02:29:40.400Z
---

## 0006. "shared plugin core for rule-engine and dual-workflow-engine"

### Background

`packages/rule-engine` already decomposes its generic engine into a host plus extensible capability
registries: evaluators, resolvers, formatters, and extension-loaded modules. That model is useful
because callers can add or override engine behavior without forking the engine. The extension loader
also keeps arbitrary module import behind an explicit `allowExtensions` trust gate.

`packages/dual-workflow-engine` has similar but less formal seams today. It exposes
`WorkflowEngineHost`, `ActionRunner`, `GuardRunner`, `WorkflowPersistenceAdapter`, and two built-in
execution drivers (`state-machine` and `transition-flow`). However, the action/guard registries are
private `Map`s, there is no shared registry metadata (`origin`, listing, override warnings), and no
workflow extension loader equivalent to the rule-engine loader.

The target direction is Option D from the architecture brainstorm: extract a shared plugin/capability
core that both engines use, then migrate both packages onto it. The goal is not to make both engines
identical. The goal is to give both engines the same extension vocabulary, override semantics,
diagnostics, and trust-gated module loading while preserving each engine's domain-specific contracts.

> **Decision frozen (2026-06-03) — see ADR-010.** Architecture is settled as **Option A: share the
> mechanism, not the concepts.** The shared core lives in **`@gobing-ai/ts-runtime`**, exported from the
> subpath **`@gobing-ai/ts-runtime/plugin`** (not a new package). It exposes generic primitives only —
> `CapabilityRegistry<T>` (with `origin` + `entries`/`getEntry`), a generic trust-gated extension loader
> that calls an engine-provided registration callback, and a standalone `assertRelativeExtensionPath()`
> validator. Domain concepts (evaluator/action/guard), `ExtensionKind` enums, `extensions` schemas,
> kind→registry mapping, **error types**, and **override semantics** stay engine-owned. Unifying the
> capability *contract* across engines is rejected (false commonality: query vs command). The workflow
> driver registry, shell-action trust changes, and a shared template engine are explicitly deferred to
> future ADRs. R2 below is now resolved by ADR-010; R13–R14 capture the two boundary refinements.

This task is intentionally design-heavy and should be implemented later, not immediately. It exists to
freeze the agreed destination and prevent implementation drift.

### Requirements

## Requirements — 2026-06-04 (re-audit, --force)

All 14 requirements MET. All 5 child tasks Done (0007–0011). `spur-check` passes.

- [x] **R1 — ADR before implementation**: Done — ADR-010 in `docs/00_ADR.md` (2026-06-03).
- [x] **R2 — Shared-core location**: Resolved — `@gobing-ai/ts-runtime/plugin` (ADR-010).
- [x] **R3 — Shared core owns generic capability registry**: ✅ 0007 — `CapabilityRegistry<T>` with `register`/`get`/`has`/`list`/`getEntry`/`entries` + `origin` metadata.
- [x] **R4 — Shared core owns generic extension loading primitives**: ✅ 0007 — `loadExtensionModules<K>` with fail-closed trust gate, `ExtensionRef<K>` (path+baseDir), `assertRelativeExtensionPath`.
- [x] **R5 — Rule-engine migrated without behavior drift**: ✅ 0008 (registry + path-guard), 0011 (loader delegation). 219 tests unchanged. Compat re-export at old path.
- [x] **R6 — Dual-workflow-engine migrated to same registry model**: ✅ 0009 — host maps → `CapabilityRegistry<ActionRunner/GuardRunner>`. `WorkflowValidationError` preserved. 149 tests pass.
- [x] **R7 — Workflow extension loading for actions/guards only**: ✅ 0010 — `loadWorkflowExtensionsIntoHost` with `WorkflowExtensionKind = 'actions' | 'guards'`. No driver/loader/validator/formatter surfaces.
- [x] **R8 — Workflow extensions trust-gated**: ✅ 0010 — delegates to shared `loadExtensionModules` (fail-closed). Pre-adaptation `..` guard on `absPath`.
- [x] **R9 — No premature unification of engine loops**: ✅ Driver registry deferred per ADR-010. `WorkflowService` dispatch remains explicit. No driver extension surface.
- [x] **R10 — Package boundaries remain valid**: ✅ All internal deps `workspace:*`. tsconfig path aliases on all consuming packages (rule-engine, dual-workflow-engine). No private-source path imports.
- [x] **R11 — Compatibility and migration documented**: ✅ Compat re-export at `rule-engine/src/host/capability-registry.ts` → shared. `origin` param additive. No breaking changes to public APIs.
- [x] **R12 — Gates clean**: ✅ `spur-check` pass (30 rules + 948 tests + 8× typecheck + TSDoc + coverage-gate). `bun run build` green (8/8 packages).
- [x] **R13 — Error types stay engine-owned**: ✅ Shared `CapabilityRegistry.get` throws generic `Error`. Rule-engine preserves error messages. Workflow host preserves `WorkflowValidationError` at boundary (`has()`-then-throw). 0010 uses `WorkflowValidationError` for extension shape mismatches.
- [x] **R14 — Override semantics stay engine-owned**: ✅ Rule-engine override warnings in 0008 adapter callback. Workflow override warnings in 0010 `warnIfOverride` (only warns on built-in overrides). Shared core bakes in no override policy.

### Scope Drift
None detected. All code maps to the ADR-010 architecture. No driver registry, no lifecycle hooks, no DI containers introduced.


### Q&A

**Q: Should dual-workflow-engine copy rule-engine's design one-to-one?**

A: No. The workflow engine should converge on the same plugin vocabulary and infrastructure, but its
domain components stay workflow-specific. Rule-engine has evaluators/resolvers/fixers/formatters.
Workflow-engine has actions/guards/persistence and, later if needed, drivers/loaders/validators.

**Q: Is Option D worth it?**

A: Yes as a destination, because two packages now need the same extensibility grammar and a third may
later. It is not worth doing as a speculative mega-refactor. Implement it in phases: shared registry
first, workflow actions/guards next, then optional extension loader parity.

**Q: Should drivers become plugins now?**

A: No. `WorkflowService` currently dispatches between exactly two built-in dialects. A driver registry
is a valid future design, but implementing it now would create abstraction before pressure. Record the
future seam in the ADR and defer implementation.

**Q: Should shell action be extension-loaded instead of built-in?**

A: Not in this task. Preserve current behavior of `createDefaultWorkflowEngineHost`. If the trust model
for shell execution needs tightening, open a separate security-oriented task.

### Design

## Design

### Target Architecture

Introduce a shared plugin/capability core used by both:

- `packages/rule-engine`
- `packages/dual-workflow-engine`

The shared core should provide generic infrastructure only:

- typed capability registry
- capability entry metadata
- extension ref metadata
- trust-gated module loading helper
- shared diagnostics shape for overrides and invalid extension exports

It must not know about rule-engine concepts (`evaluator`, `resolver`, `fixer`, `formatter`) or
workflow concepts (`action`, `guard`, `driver`). Each engine owns its domain-specific extension kinds,
schemas, and registration mapping.

### Recommended Package Location

Default recommendation: place the shared core under `packages/runtime`, exported from
`@gobing-ai/ts-runtime/plugin` or `@gobing-ai/ts-runtime/capabilities`.

Reasoning:

- both `rule-engine` and `dual-workflow-engine` already depend on `@gobing-ai/ts-runtime`
- the primitives are generic runtime infrastructure, not an engine-specific concern
- this avoids introducing a new package and release surface prematurely
- the API can be moved to a dedicated package later only if multiple packages need richer plugin
  lifecycle features

Rejected default: create `packages/plugin-core` immediately. That is cleaner in isolation, but it
adds package overhead, path aliases, release metadata, docs, and a new public artifact for a small
initial API.

ADR must explicitly revisit this decision before implementation.

### Shared Core API Sketch

The exact names can change during implementation, but the core shape should stay close to this:

```ts
export type CapabilityOrigin = 'builtin' | 'extension';

export interface CapabilityEntry<TCapability> {
  readonly capability: TCapability;
  readonly origin: CapabilityOrigin;
}

export interface CapabilityRegistryOptions {
  readonly kind: string;
}

export class CapabilityRegistry<TCapability> {
  constructor(options: CapabilityRegistryOptions | string);

  register(name: string, capability: TCapability, origin?: CapabilityOrigin): void;
  has(name: string): boolean;
  get(name: string): TCapability;
  getEntry(name: string): CapabilityEntry<TCapability> | undefined;
  list(): string[];
  entries(): Array<readonly [string, CapabilityEntry<TCapability>]>;
}
```

Required behavior:

- `register` replaces existing capabilities by name, matching current behavior.
- `origin` defaults to `'extension'` for extension-loader use, but engine built-ins must register with
  `'builtin'`.
- `get` throws a clear error including the capability kind and missing name.
- `list` returns stable insertion order from the underlying map.
- `getEntry` or `entries` must exist so callers can inspect `origin`.

### Shared Extension Loading API Sketch

The generic loader should not decide which registry receives a module. It should load and validate
extension modules, then call an engine-provided registration callback.

```ts
export interface ExtensionRef<TExtensionKind extends string = string> {
  readonly kind: TExtensionKind;
  readonly absPath: string;
  readonly sourceName: string;
}

export interface LoadExtensionsOptions {
  readonly allowExtensions?: boolean;
  readonly logger?: { warn: (message: string) => void };
  readonly moduleLoader?: (absPath: string) => Promise<Record<string, unknown>>;
}

export interface LoadedExtension {
  readonly name: string;
}

export async function loadExtensionModules<TExtensionKind extends string>(
  refs: readonly ExtensionRef<TExtensionKind>[],
  options: LoadExtensionsOptions,
  register: (ref: ExtensionRef<TExtensionKind>, extension: LoadedExtension) => void | Promise<void>,
): Promise<void>;
```

Required behavior:

- no refs means no-op
- refs plus `allowExtensions !== true` throws before importing anything
- loader accepts either default export or named `extension`
- invalid export throws with source path and source name
- `moduleLoader` seam remains for tests
- engine-specific registration maps `ref.kind` to host registries
- engine-specific code owns override warnings because only the engine knows whether an override is
  meaningful

### Rule-Engine Migration Design

Current facts:

- `RuleEngineHost` owns `evaluators`, `formatters`, and `resolvers`.
- `CapabilityRegistry` currently lives inside `packages/rule-engine/src/host`.
- rule-engine extension refs currently support `resolvers`, `evaluators`, `fixers`, and `formatters`,
  but host registration supports only `resolvers`, `evaluators`, and `formatters`; fixers live outside
  the host path today.

Migration target:

- move or replace imports from `../host/capability-registry` to the shared core export
- keep `RuleEngineHost` public shape unchanged
- keep `collectExtensions` in rule-engine because extension kinds and schema are rule-engine-specific
- reimplement `loadExtensionsIntoHost` using the shared generic loader internally
- preserve all current errors unless tests deliberately approve clearer messages
- keep the `allowExtensions` trust gate unchanged
- preserve override warning behavior

Compatibility plan:

- If `CapabilityRegistry` is exported publicly from rule-engine today, re-export it from the old path
  for one release if feasible.
- If it is internal-only, update internal imports directly and do not add extra public surface.
- Avoid changing rule file or preset schema unless the ADR explicitly says so.

### Dual-Workflow-Engine Migration Design

Current facts:

- `WorkflowEngineHost` owns private action and guard maps.
- `registerAction` and `registerGuard` replace existing entries by `kind`.
- `runAction` and `evaluateGuard` throw `WorkflowValidationError` on unknown kinds.
- built-ins are registered by `createDefaultWorkflowEngineHost`.
- `WorkflowPersistenceAdapter` is already an injected adapter seam.
- `WorkflowService` hardcodes state-machine vs transition-flow driver selection.

Migration target:

- replace private maps with shared registries:

```ts
private readonly actions = new CapabilityRegistry<ActionRunner>('workflow action');
private readonly guards = new CapabilityRegistry<GuardRunner>('workflow guard');
```

- preserve existing public methods and error types:

```ts
registerAction(action: ActionRunner): this
registerGuard(guard: GuardRunner): this
runAction(kind: string, options: Record<string, unknown>, context: ActionRunContext): Promise<ActionResult>
evaluateGuard(kind: string, options: Record<string, unknown>, context: GuardContext): Promise<boolean>
```

- add introspection methods if useful:

```ts
hasAction(kind: string): boolean
hasGuard(kind: string): boolean
listActions(): string[]
listGuards(): string[]
```

- built-ins should register with `origin: 'builtin'`
- extension-loaded actions/guards should register with `origin: 'extension'`
- unknown action/guard errors must remain `WorkflowValidationError`, not generic `Error`

### Workflow Extension Model

Add workflow extension support for actions and guards only:

```ts
export type WorkflowExtensionKind = 'actions' | 'guards';

export interface WorkflowExtensionRef {
  readonly kind: WorkflowExtensionKind;
  readonly absPath: string;
  readonly sourceName: string;
}
```

Recommended extension module shape:

```ts
export default {
  name: 'slack-workflow-extension',
  actions: [new SlackNotifyAction()],
  guards: [new BusinessHoursGuard()],
};
```

Alternative per-capability shape:

```ts
export const extension = {
  name: 'slack-notify',
  action: new SlackNotifyAction(),
};
```

Recommendation: use grouped extension modules (`actions` and `guards` arrays). They scale better for
workflow packages because custom action libraries usually ship multiple related capabilities.

Validation rules:

- extension export must have a string `name`
- `actions`, if present, must be an array of objects with `kind: string` and `execute: function`
- `guards`, if present, must be an array of objects with `kind: string` and `evaluate: function`
- extension kind refs must decide which arrays are accepted:
  - `kind: 'actions'` accepts action contributions
  - `kind: 'guards'` accepts guard contributions
- if a module contributes the wrong capability kind for the ref, throw a clear validation error

Open design item for implementation: decide whether workflow definitions themselves may declare
extension refs, or whether extension refs are loaded only from host construction options. Safer default:
host construction options first; workflow-file declarations later, if needed, because workflow files
may come from less trusted sources.

### Future Driver Registry - Design Only

Do not implement driver registry in this task. Record the future shape in the ADR:

```ts
interface WorkflowDriver<TWorkflow extends WorkflowDef = WorkflowDef> {
  readonly kind: string;
  run(workflow: TWorkflow, options: WorkflowRunOptions): Promise<WorkflowRunResult>;
  validate?(workflow: TWorkflow): void;
}
```

Trigger for future implementation:

- a third workflow dialect appears
- a consumer needs to override state-machine or transition-flow execution semantics
- workflow validation/loading needs to become dialect-pluggable

Until then, keep `WorkflowService` dispatch explicit.

### Security and Trust Boundary

Extension modules are arbitrary code. The shared core must preserve the rule-engine security posture:

- loading disabled by default
- fail closed when refs exist and extensions are disabled
- module loading must be injectable for tests and embedders
- no dynamic import before the trust gate passes
- no silent drop of declared extensions
- extension path collection remains engine-owned and must keep traversal/absolute-path protections
  where relevant

Workflow-specific note: shell action execution is a separate risk from extension loading. This task
must not silently change shell action behavior.

### Non-Goals

- Do not rewrite rule-engine evaluator/fixer/formatter/resolver contracts.
- Do not rewrite workflow execution loops.
- Do not create a workflow driver registry unless the ADR explicitly expands this task.
- Do not introduce dependency injection containers.
- Do not add lifecycle hooks (`onLoad`, `onBeforeRun`, `onAfterRun`) in this task.
- Do not add async initialization/disposal semantics unless a concrete extension needs it.
- Do not modify release workflow or `.github/workflows`.

### Solution

#### Subtasks (decomposed 2026-06-03)

Decomposed by **deliverable boundary** (which package/capability ships), not by implementation phase.
Docs and gates are folded into each child's acceptance criteria (R8/R9 per child), not split out as
phase-tasks. Phase 1 (ADR-010) is already complete, so the parent's remaining work is these four:

- [ ] [0007 - Shared plugin core in `ts-runtime/plugin`](0007_shared_plugin_core_in_ts-runtime_plugin_subpath.md) — foundation; registry + generic loader + path-guard + tests (~7h, **high risk: security primitive**)
- [ ] [0008 - Migrate rule-engine onto shared core](0008_migrate_rule-engine_onto_shared_plugin_core.md) — zero behavior drift (~6h)
- [ ] [0009 - Migrate workflow host onto shared registry](0009_migrate_dual-workflow-engine_host_onto_shared_registry.md) — actions/guards, origin, `WorkflowValidationError` preserved (~6h)
- [ ] [0010 - Trust-gated workflow extension loading](0010_add_trust-gated_workflow_extension_loading_for_actions_and_guards.md) — actions/guards only (~6h, **high risk: new trust surface**)
- [ ] [0011 - Align both loaders on shared loader + unified ExtensionRef](0011_align_rule-engine_and_workflow_extension_loaders_on_shared_loader_and_unified_ExtensionRef.md) — follow-up split from 0008; resolves the absPath-vs-baseDir loader-delegation conflict (~5h)

**Dependency order:** `0007 → (0008 || 0009) → 0010 → 0011`
**Estimated total effort:** 27–33 hours

> **Note (2026-06-03):** 0008 migrated rule-engine's registry + path-guard onto the shared core cleanly
> (zero drift), but deferred full loader delegation — rule-engine's public `ExtensionRef.absPath`
> conflicts with the shared loader's `baseDir`-resolve security model. That delegation is now task 0011,
> sequenced after 0010 so the unified ref contract is decided once.
**Parent status:** remains non-terminal; execution continues on the child tasks above, in dependency
order. Start with 0007.

---

Implement the ADR-010 decision (Option A: share mechanism, not concepts) in phases. Phase 1 (the ADR)
is already complete:

1. ~~Add an ADR that defines the shared plugin-core architecture and package location.~~ **Done: ADR-010.**
2. Extract the generic `CapabilityRegistry` and extension-loading primitives into the selected shared
   package, recommended `packages/runtime`.
3. Migrate `packages/rule-engine` onto the shared registry and generic loader without changing
   behavior.
4. Migrate `packages/dual-workflow-engine` action/guard maps onto the shared registry while keeping
   public host methods and error types stable.
5. Add workflow action/guard extension loading behind the same explicit trust gate.
6. Document the extension model and add focused tests plus full monorepo gates.

### Plan

## Plan

- [ ] **Phase 0 - confirm baseline**
  - [ ] Run `git status --short` and verify no unrelated edits will be touched.
  - [ ] Run focused current tests for rule-engine extension loading and workflow host behavior.
  - [ ] Inspect current `tsconfig` path aliases for `rule-engine`, `dual-workflow-engine`, and
        `runtime`.

- [x] **Phase 1 - ADR (DONE 2026-06-03)**
  - [x] Append ADR-010 to `docs/00_ADR.md`.
  - [x] Decide shared-core location: `packages/runtime`, subpath `@gobing-ai/ts-runtime/plugin`.
  - [x] Record API surface, trust boundary, error-type/override ownership, non-goals, migration order,
        and compatibility strategy.
  - [x] Record why driver registry is deferred.

- [ ] **Phase 2 - shared core**
  - [ ] Add shared capability registry module under the selected package.
  - [ ] Add generic extension ref/options/types.
  - [ ] Add generic trust-gated extension module loader.
  - [ ] Export via an explicit subpath if using runtime, e.g. `@gobing-ai/ts-runtime/plugin`.
  - [ ] Add unit tests for registry replacement, origin metadata, list order, unknown capability
        errors, trust gate, invalid exports, default export, named `extension`, and injected
        `moduleLoader`.

- [ ] **Phase 3 - rule-engine migration**
  - [ ] Update rule-engine imports to use the shared registry.
  - [ ] Keep `RuleEngineHost` public shape unchanged.
  - [ ] Rewrite `loadExtensionsIntoHost` to delegate generic loading to the shared core while keeping
        rule-engine kind mapping local.
  - [ ] Preserve existing rule-engine extension tests and add compatibility tests if error messages or
        re-exports change.
  - [ ] Confirm fixers remain outside host registration unless a separate design expands that seam.

- [ ] **Phase 4 - workflow host migration**
  - [ ] Replace private action/guard maps with shared registries.
  - [ ] Preserve `WorkflowValidationError` for unknown action/guard kinds.
  - [ ] Register built-ins with `origin: 'builtin'`.
  - [ ] Add optional host introspection methods (`hasAction`, `hasGuard`, `listActions`,
        `listGuards`) if accepted by ADR.
  - [ ] Add tests proving replacement semantics, origin metadata, unknown action/guard errors, and
        built-in registrations.

- [ ] **Phase 5 - workflow extension loading**
  - [ ] Add workflow extension types for actions and guards.
  - [ ] Add workflow-specific `collectWorkflowExtensions` only if extension refs are allowed from
        config files; otherwise add host-construction loader API first.
  - [ ] Add `loadWorkflowExtensionsIntoHost` using the shared generic loader.
  - [ ] Validate grouped extension exports (`name`, `actions[]`, `guards[]`).
  - [ ] Add tests for disabled trust gate, invalid module shape, override warning, action extension
        registration, guard extension registration, and wrong-kind rejection.

- [ ] **Phase 6 - docs**
  - [ ] Update rule-engine docs if public import paths or extension docs changed.
  - [ ] Update dual-workflow-engine README/API docs with custom actions, custom guards, and extension
        loading examples.
  - [ ] Document that workflow driver registry is intentionally deferred.
  - [ ] Document security note: extension modules execute arbitrary code and require explicit trust.

- [ ] **Phase 7 - gates**
  - [ ] Run focused package tests after each migration phase.
  - [ ] Run `bun run lint`.
  - [ ] Run `bun run test`.
  - [ ] Run `bun run spur-check`.
  - [ ] Run `bun run build`.
  - [ ] Verify `git status --short` shows only intentional changes.

#### Acceptance Criteria

- [x] ADR exists (ADR-010) and does not conflict with existing ADR-001 through ADR-009.
- [ ] Shared registry and extension loader live in the ADR-approved package and are exported through
      stable public package paths.
- [ ] Rule-engine behavior is unchanged from the caller perspective.
- [ ] Dual-workflow-engine action/guard behavior is unchanged from the caller perspective.
- [ ] Workflow engine has trust-gated extension loading for actions and guards.
- [ ] No implementation of workflow driver registry lands unless the ADR explicitly expands scope.
- [ ] Full monorepo gate passes: `bun run spur-check` and `bun run build`.

### Review

## Review — 2026-06-04 (re-audit, --force)

**Verdict: PASS** — All 5 child tasks Done. All 14 requirements MET. No integration-level SECU findings.
**Scope:** Cross-package: `packages/runtime/src/plugin/` + `packages/rule-engine/src/` + `packages/dual-workflow-engine/src/`
**Mode:** verify (Phase 7 SECU + Phase 8 traceability)
**Channel:** current
**Gate:** `bun run spur-check` → pass (30 rules + 948 tests + 8× typecheck)

### Child Task Status

| WBS | Task | Status |
|-----|------|--------|
| 0007 | Shared plugin core in ts-runtime/plugin | Done |
| 0008 | Migrate rule-engine onto shared core | Done |
| 0009 | Migrate workflow host onto shared registry | Done |
| 0010 | Trust-gated workflow extension loading | Done |
| 0011 | Align loaders on shared ExtensionRef | Done |

### P1 — Blockers
No findings.

### P2 — Warnings
No findings.

### P3 — Info
No findings.

### P4 — Suggestions
No findings.

#### Integration-level SECU analysis

- **Security — Trust boundary**: The shared fail-closed gate (`allowExtensions !== true` throws before any import) governs all extension loading across both engines. The shared `assertRelativeExtensionPath` provides defense-in-depth path validation. Both engine adapters (0008 `extensions.ts:96-103`, 0010 `extensions.ts:76-83`) add pre-adaptation `..` checks on caller-supplied `absPath` before `dirname`/`basename` decomposition. No `import()` reachable before the gate in any path.
- **Security — Shared core isolation**: `packages/runtime/src/plugin/` imports neither `ts-rule-engine` nor `ts-dual-workflow-engine`. Zero engine vocabulary in the shared core. The `moduleLoader` is required (not optional), keeping the shared core free of ambient code-loading capability.
- **Correctness — Error-type ownership (ADR-010 R13)**: `WorkflowEngineHost.runAction/evaluateGuard` use `has()`-then-throw-`WorkflowValidationError` (0009). 0010's `registerExtensionOnHost` throws `WorkflowValidationError` for shape mismatches. No engine error class leaks into the shared core.
- **Correctness — Override semantics (ADR-010 R14)**: Rule-engine override warnings live in 0008's adapter callback. Workflow override warnings live in 0010's `warnIfOverride`. The shared core bakes in no override policy.
- **Correctness — Developer contract compliance (R9)**: No driver registry implementation. `WorkflowExtensionKind` restricted to `'actions' | 'guards'`. `WorkflowService` dispatch remains explicit.
- **Efficiency**: O(n) single-pass over refs; Map-backed registries O(1). `dirname`/`basename` decomposition is string-only. No N+1, no unbounded growth.
- **Usability**: Compat re-exports preserve rule-engine's public surface. `origin` param is additive and backward-compatible. Introspection methods expose registry metadata.


### Testing

Not started.

Required test coverage:

- shared registry replacement/origin/list/get behavior
- shared extension loader trust gate and export validation
- rule-engine extension loading regression suite
- workflow host action/guard registration and execution suite
- workflow extension loading suite for action/guard modules
- full monorepo gate

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| Task | `docs/tasks/0006_shared_plugin_core_for_rule_engine_and_dual_workflow_engine.md` | Codex | 2026-06-03 |

### References

- `packages/rule-engine/src/host/capability-registry.ts` - current rule-engine registry source.
- `packages/rule-engine/src/host/rule-engine-host.ts` - current rule-engine host.
- `packages/rule-engine/src/config/extensions.ts` - current trust-gated extension loading.
- `packages/dual-workflow-engine/src/host.ts` - current workflow action/guard host.
- `packages/dual-workflow-engine/src/types.ts` - current workflow action, guard, persistence, and
  workflow contracts.
- `packages/dual-workflow-engine/src/service.ts` - current explicit state-machine vs transition-flow
  driver dispatch.
- `docs/00_ADR.md` - authoritative architecture decisions; must be updated before implementation.


### History

- Migrated from legacy format (2026-07-31)
