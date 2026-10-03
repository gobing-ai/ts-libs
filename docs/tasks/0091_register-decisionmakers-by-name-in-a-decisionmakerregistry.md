---
schema_version: 1
name: Register DecisionMakers by name in a DecisionMakerRegistry
status: done
template: feature-impl
created_at: 2026-10-03T15:39:23.464Z
updated_at: "2026-10-03T22:16:56.847Z"
feature_id: N

dependencies: ["0089"]
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-dev-runall-feature-n-5d1f7c/.spur/memory/evidence/0091-verdict.json
---

## 0091. Register DecisionMakers by name in a DecisionMakerRegistry

### Background

Feature N needs a single place to pick a `DecisionMaker` by name. With it, a catalog, a hub or a caller can route a decision to a built-in maker (`typesafe`, `fm-local`, `laya-local`) or to a consumer-registered one with a plain string. This task owns the registry. Task 0090 consumes it for maker selection.

See ADR-033 and `docs/design/ai-decision-catalog.md` § Maker registry.

Implements: R15 — Built-in DecisionMakers are registered by name and consumers register their own.

### Requirements

- [x] R1. Export `DecisionMakerRegistry` from `@gobing-ai/ts-ai-decision` with `register(name, source)`, `has(name)`, `names()` and `resolve(name)`.
  - `source` is a `DecisionMaker` or a factory returning one, sync or async.
  - Names match `^[a-z][a-z0-9-]*$`.
- [x] R2. Unless `builtins: false`, pre-register three built-ins, each through `createDecisionMaker` with `...makerOptions`:
  - `typesafe`: `createDecisionMaker({ backend: 'typesafe', ...makerOptions })`
  - `fm-local`: `{ driver: createFmDriver(driverOptions['fm-local'] ?? {}) }`
  - `laya-local`: `{ driver: createLayaDriver(driverOptions['laya-local'] ?? {}) }`
- [x] R3. Factories are lazy:
  - registering builds nothing
  - the first `resolve` runs the factory and memoises the maker
  - a factory that throws is not memoised, so a later `resolve` retries
- [x] R4. Errors:
  - registering an invalid or already-registered name throws `DecisionRegistryError`
  - resolving an unregistered name throws `UnknownDecisionMakerError`
  - factory errors propagate unchanged, so the hub can map them to `no-backend`
- [x] R5. Export the `MakerSource` and `BuiltinMakerOptions` types, and document the registry in the package README.

### Acceptance Criteria

- [x] AC1 — Built-in DecisionMakers are registered by name and consumers register their own

Task-local check: `bun run spur-check` and `bun run build` pass.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

Approach: one class holding a `Map<string, { source: MakerSource; maker?: DecisionMaker }>`. Built-ins are registered as factories in the constructor, so a fm/laya platform check runs only when that maker is first resolved. Reason: the operator wants any DecisionMaker addressable by a plain string, and a lazy map is the smallest thing that does that without building backends nobody uses.

Rejected alternatives:
- a module-level global registry: hidden shared state across hubs and tests; a registry instance is passed or defaulted instead
- `register(name, source, { replace: true })`: no consumer needs to override a built-in in place, because `builtins` options or `builtins: false` cover reconfiguration
- memoising a failed factory: it would turn a transient failure such as a model not yet downloaded into a permanent one

Invariants:
- `register`, `has` and `names` never construct a maker or driver.
- A successful `resolve` returns the same `DecisionMaker` instance for the life of the registry.
- The registry has no catalog dependency; catalog code depends on it, never the reverse.
- No new driver code. Built-ins only compose `createDecisionMaker`, `createFmDriver` and `createLayaDriver`.

Key signatures:
- `type MakerSource = DecisionMaker | (() => DecisionMaker | Promise<DecisionMaker>)`
- `new DecisionMakerRegistry(options?: { builtins?: BuiltinMakerOptions | false })`
- `register(name: string, source: MakerSource): this`
- `resolve(name: string): Promise<DecisionMaker>`
- `class DecisionRegistryError`
- `class UnknownDecisionMakerError { name }`

Surface detail: `docs/design/ai-decision-catalog.md` § API, § Maker registry.

### Plan

- [x] List the ways the registry can mislead, then write the e2e cases before the class. Cases:
  - an eager build at construction
  - a duplicate or invalid name
  - an unknown name
  - a factory run twice
  - a failed factory memoised
  - a built-in wired to the wrong driver
- [x] Implement `DecisionMakerRegistry`, the two error classes and the built-in factories.
- [x] Write the e2e suite in tests/:
  - check the built-in names
  - register a scripted maker and count factory runs
  - resolve `fm-local` and `laya-local` with `driverOptions` injecting stub executors, and assert the driver identity on the resulting maker
  - check that a throwing factory retries
- [x] Add the README section and export the types from the barrel.
- [x] Run `bun run spur-check` and `bun run build`.

### Solution

- `packages/ai-decision/src/registry.ts:1-78` — `DecisionMakerRegistry`: `Map<string, { source, maker? }>`; constructor pre-registers the three built-ins as lazy factories (`typesafe` → `createDecisionMaker({ backend: 'typesafe', ...makerOptions })`; `fm-local`/`laya-local` → `createDecisionMaker({ driver: createFmDriver/createLayaDriver(driverOptions[...] ?? {}), ...makerOptions })`) unless `builtins: false`; `register` validates `^[a-z][a-z0-9-]*$` and rejects duplicates, `resolve` runs a factory once on first use, memoises on success, lets failures propagate unchanged (retry on next resolve). Exports `MakerSource`, `BuiltinMakerOptions`.
- `packages/ai-decision/src/errors.ts:17-44` — `DecisionRegistryError` (invalid/duplicate name) and `UnknownDecisionMakerError` (unresolved name; `name` field carries the unknown maker, `instanceof` identifies the class since `this.name` would clobber the field).
- `packages/ai-decision/src/index.ts:4` — barrel exports `./registry`.
- `packages/ai-decision/tests/registry.test.ts:1-192` — e2e suite written first per Plan: built-in names, lazy registration (no eager driver build), factory-error propagation, memoised sync/async factories, static maker instance, duplicate/invalid names, throwing-factory retry, fm-local/laya-local driver identity via injected stub executor/client, `builtins: false`.
- `packages/ai-decision/README.md:36-56 (71 lines total)` — "Maker registry" section.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/ai-decision/src/registry.ts:26` `DecisionMakerRegistry` with `register` (:44, chains, name pattern `^[a-z][a-z0-9-]*$` at :15), `has` (:59), `names()` (:63), `resolve` (:73); exported via `src/index.ts:5` (`export * from './registry'`) |
| R2 | MET | `registry.ts:32-42` constructor pre-registers `typesafe` / `fm-local` / `laya-local` via `createDecisionMaker({ backend:'typesafe', ... })` and `{ driver: createFmDriver/createLayaDriver(driverOptions[...] ?? {}) }` with `...makerOptions`; `builtins: false` skips (:33) — re-read this run |
| R3 | MET | laziness: `register` stores `{ source }` only (:50); first `resolve` runs and memoises (:73-95); failed factory not memoised — `run.catch` clears `entry.pending` (:90-92) so a later resolve retries; tests "registering never constructs a maker or driver" + "a throwing factory is not memoised" pass this run |
| R4 | MET | invalid/duplicate name → `DecisionRegistryError` (:45-49); unknown resolve → `UnknownDecisionMakerError` (:76-79); factory errors propagate unchanged (no wrapping in `resolve`) — test "built-in factory errors propagate unchanged" pass this run |
| R5 | MET | `MakerSource` (:7) and `BuiltinMakerOptions` (:10) exported from the barrel; README registry section at `packages/ai-decision/README.md:106-119` documents registration, laziness and names — re-read this run |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | test | `cd packages/ai-decision && bun test` → 97 pass / 0 fail (this run); `tests/registry.test.ts` AC1 describe: built-in names listed without construction, scripted factory registered and run once, fm-local/laya-local resolve on injected driver options, duplicate/invalid name throw, unknown resolve throws |
| R15 — Built-in DecisionMakers are registered by name and consumers register their own | MET | test | registry.test.ts (this run): `names()` lists typesafe/fm-local/laya-local with zero factories run; registering scripted-judge adds it and double-resolve runs the factory once; fm-local resolves on stub driver options keeping driver identity; duplicate/invalid name → DecisionRegistryError; unknown resolve → UnknownDecisionMakerError (`registry.ts:32-95`) |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | — | — | No findings (verify verdict PASS) |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-10-03T15:39:48.551Z backlog → todo (system)
- 2026-10-03T18:04:50.638Z todo → wip (system)
- 2026-10-03T18:27:58.650Z wip → testing (system)
- 2026-10-03T18:28:47.638Z testing → done (system)

