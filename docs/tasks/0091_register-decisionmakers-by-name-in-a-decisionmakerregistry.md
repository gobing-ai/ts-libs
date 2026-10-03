---
schema_version: 1
name: Register DecisionMakers by name in a DecisionMakerRegistry
status: todo
template: feature-impl
created_at: 2026-10-03T15:39:23.464Z
updated_at: "2026-10-03T15:41:05.787Z"
feature_id: N

dependencies: ["0089"]
---

## 0091. Register DecisionMakers by name in a DecisionMakerRegistry

### Background

Feature N needs a single place to pick a `DecisionMaker` by name. With it, a catalog, a hub or a caller can route a decision to a built-in maker (`typesafe`, `fm-local`, `laya-local`) or to a consumer-registered one with a plain string. This task owns the registry. Task 0090 consumes it for maker selection.

See ADR-033 and `docs/design/ai-decision-catalog.md` § Maker registry.

Implements: R15 — Built-in DecisionMakers are registered by name and consumers register their own.

### Requirements

- [ ] R1. Export `DecisionMakerRegistry` from `@gobing-ai/ts-ai-decision` with `register(name, source)`, `has(name)`, `names()` and `resolve(name)`.
  - `source` is a `DecisionMaker` or a factory returning one, sync or async.
  - Names match `^[a-z][a-z0-9-]*$`.
- [ ] R2. Unless `builtins: false`, pre-register three built-ins, each through `createDecisionMaker` with `...makerOptions`:
  - `typesafe`: `createDecisionMaker({ backend: 'typesafe', ...makerOptions })`
  - `fm-local`: `{ driver: createFmDriver(driverOptions['fm-local'] ?? {}) }`
  - `laya-local`: `{ driver: createLayaDriver(driverOptions['laya-local'] ?? {}) }`
- [ ] R3. Factories are lazy:
  - registering builds nothing
  - the first `resolve` runs the factory and memoises the maker
  - a factory that throws is not memoised, so a later `resolve` retries
- [ ] R4. Errors:
  - registering an invalid or already-registered name throws `DecisionRegistryError`
  - resolving an unregistered name throws `UnknownDecisionMakerError`
  - factory errors propagate unchanged, so the hub can map them to `no-backend`
- [ ] R5. Export the `MakerSource` and `BuiltinMakerOptions` types, and document the registry in the package README.

### Acceptance Criteria

- [ ] AC1 — Built-in DecisionMakers are registered by name and consumers register their own

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

- [ ] List the ways the registry can mislead, then write the e2e cases before the class. Cases:
  - an eager build at construction
  - a duplicate or invalid name
  - an unknown name
  - a factory run twice
  - a failed factory memoised
  - a built-in wired to the wrong driver
- [ ] Implement `DecisionMakerRegistry`, the two error classes and the built-in factories.
- [ ] Write the e2e suite in tests/:
  - check the built-in names
  - register a scripted maker and count factory runs
  - resolve `fm-local` and `laya-local` with `driverOptions` injecting stub executors, and assert the driver identity on the resulting maker
  - check that a throwing factory retries
- [ ] Add the README section and export the types from the barrel.
- [ ] Run `bun run spur-check` and `bun run build`.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-10-03T15:39:48.551Z backlog → todo (system)

