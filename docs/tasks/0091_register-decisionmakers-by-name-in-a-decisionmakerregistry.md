---
schema_version: 1
name: Register DecisionMakers by name in a DecisionMakerRegistry
status: done
template: feature-impl
created_at: 2026-10-03T15:39:23.464Z
updated_at: "2026-10-03T18:28:47.645Z"
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
| R1 | MET | DecisionMakerRegistry at packages/ai-decision/src/registry.ts:30 with register:60, has:76, names:80, resolve:88; barrel export src/index.ts:4; package name @gobing-ai/ts-ai-decision (package.json:2); MakerSource sync/async/instance union registry.ts:8; name pattern ^[a-z][a-z0-9-]*$ enforced registry.ts:19,62-64 — tests registry.test.ts:165 invalid-name throws (6 bad names), :150 unknown-name |
| R2 | MET | Guard builtins === false registry.ts:39; typesafe -> createDecisionMaker({backend:'typesafe',...makerOptions}) registry.ts:41; fm-local -> createFmDriver(driverOptions['fm-local'] ?? {}) registry.ts:42-45; laya-local -> createLayaDriver(driverOptions['laya-local'] ?? {}) registry.ts:46-48 — tests registry.test.ts:43 built-in names, :194/:205 driver identity via injected executor/client, :217 typesafe+memoised |
| R3 | MET | Lazy: constructor only registers factories — registry.test.ts:52 win32 poison driverOptions (no eager build), :84 runs===0 after register; first resolve runs+memoises registry.ts:100-107 — tests :74 runs 1 same instance, :91 async; throw not memoised -> retry registry.ts:105-108 catch clears pending — tests :173 runs 1->2, :122 rejected in-flight cleared |
| R4 | MET | Invalid/duplicate name -> DecisionRegistryError registry.ts:63,67 (errors.ts:20-26); unknown -> UnknownDecisionMakerError carrying name registry.ts:89-93 (errors.ts:31-39); factory errors unwrapped — await entry.pending rethrows original — tests registry.test.ts:62 message passthrough not instanceOf registry errors, :177 exact message |
| R5 | MET | MakerSource registry.ts:8 + BuiltinMakerOptions registry.ts:13 exported via src/index.ts:4; README.md:36-56 "Maker registry" section documents built-ins, builtins:false, lazy memoise+retry, both error types, makerOptions/driverOptions injection |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-15 | MET | test | registry.test.ts:43 pre-registers the three built-in names + consumer registration :74 resolves a scripted factory once and memoises + :144 registered DecisionMaker instance resolves as-is (register chains); 16-test registry suite at 100% spec coverage of R1-R5 |
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

