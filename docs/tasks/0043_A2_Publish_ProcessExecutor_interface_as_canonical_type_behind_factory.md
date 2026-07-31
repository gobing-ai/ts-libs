---
template: standard
schema_version: 1
name: "A2: Publish ProcessExecutor interface as canonical type behind factory"
status: done
type: task
priority: P2
created_at: 2026-07-13T16:58:22.349Z
updated_at: 2026-07-13T17:44:09.122Z
---

## 0043. A2: Publish ProcessExecutor interface as canonical type behind factory

### Background

ADR-023 follow-up A2 requires `@gobing-ai/ts-runtime` to publish `ProcessExecutor` as the canonical structural contract while keeping platform implementations behind the existing runtime-factory seam. The current `ProcessExecutor` export is both the public type and the concrete Node/Bun implementation. Although production consumers generally accept executor injection, several composition roots instantiate `ProcessExecutor` or `NodeProcessExecutor` directly, and multiple tests subclass the concrete class or use unsafe casts for fakes.

Split the contract from the implementation without changing process execution behavior. The public `ProcessExecutor` type contains only `run` and `runStreaming`; the existing implementation becomes the concrete Node/Bun executor returned by `RuntimeFactory.createProcessExecutor`. Production consumers in ai-runner, rule-engine, dual-workflow-engine, and runtime context use the interface for dependency declarations and obtain defaults through a runtime factory. Preserve the current constructible `ProcessExecutor` value as a deprecated compatibility alias during this release so existing callers do not break while the interface becomes canonical for new code.

Task 0041 established the runtime-factory and process-observability prerequisites and is complete. Scope includes runtime source/exports/tests/README plus direct workspace consumers that construct or subclass the concrete executor. It excludes new executor capabilities, command semantics, timeout/output/event/tracing changes, synchronous executor redesign, and platform-boundary changes.

### Requirements

- [ ] R1. Export a canonical `ProcessExecutor` interface from `@gobing-ai/ts-runtime` with `run(options: ProcessOptions): Promise<ProcessResult>` and `runStreaming(options: PipeProcessOptions): PipeProcess` as its complete contract.
- [ ] R2. Promote `NodeProcessExecutor` to the concrete Node/Bun implementation of that interface while preserving the current buffered execution, streaming execution, timeout, abort, output policy, process-event, and tracing behavior.
- [ ] R3. Keep `RuntimeFactory.createProcessExecutor(config?)` returning the `ProcessExecutor` interface; make Node/Bun default wiring construct `NodeProcessExecutor`, and preserve the existing Cloudflare unsupported-operation behavior.
- [ ] R4. Change runtime context and production consumers in ai-runner, rule-engine, and dual-workflow-engine to declare dependencies with type-only `ProcessExecutor` imports and obtain default implementations through the existing runtime-factory seam rather than constructing the canonical type.
- [ ] R5. Preserve a deprecated constructible `ProcessExecutor` value alias to the Node/Bun implementation for source compatibility in the current release, while ensuring `import type { ProcessExecutor }` resolves to the interface.
- [ ] R6. Update test doubles to implement the structural interface directly instead of subclassing the concrete executor or using unsafe `as unknown as ProcessExecutor` casts; concrete implementation tests may instantiate `NodeProcessExecutor` explicitly.
- [ ] R7. Add compile-time and runtime coverage proving factory results satisfy `ProcessExecutor`, injected structural fakes work, the compatibility value remains constructible, and Node/Bun plus Cloudflare factory behavior is unchanged.
- [ ] R8. Update `packages/runtime/README.md` and any directly affected consumer documentation to show interface injection and factory-based default construction, including the compatibility alias deprecation path.
- [ ] R9. Do not change public process option/result shapes, exit-code handling, error semantics, I/O behavior, event payloads, tracing semantics, or platform API ownership.

### Acceptance Criteria

#### Scenario: Structural executor injection is canonical

- Given a plain object or test double implementing `run` and `runStreaming`
- When it is assigned to `ProcessExecutor` and injected into a workspace consumer
- Then TypeScript accepts it without concrete inheritance or an unsafe cast and existing consumer behavior passes

#### Scenario: Node/Bun factory returns the concrete provider through the interface

- Given `nodeBunFactory.createProcessExecutor` with or without configuration
- When it creates an executor and buffered or streaming execution is invoked
- Then the result is interface-compatible and behavior, events, tracing, timeouts, aborts, and output handling match the pre-refactor implementation

#### Scenario: Existing constructor callers remain compatible

- Given code that imports the runtime `ProcessExecutor` value and invokes `new ProcessExecutor(config)`
- When it is compiled and executed during the compatibility window
- Then construction still succeeds through the deprecated alias and returns an executor with the existing behavior

#### Scenario: Production consumers use the port and factory seam

- Given production source in runtime context, ai-runner, rule-engine, and dual-workflow-engine
- When imports and default wiring are inspected and type-checked
- Then dependency declarations use the `ProcessExecutor` interface, concrete construction is confined to ts-runtime factory wiring, and no consumer imports a concrete executor for normal default composition

#### Scenario: Unsupported runtimes remain explicit

- Given `cloudflareWorkersFactory` where process execution capability is false
- When `createProcessExecutor` is called with or without configuration
- Then it throws the existing unsupported-operation error and no Node/Bun implementation is constructed

#### Scenario: Repository gates remain green

- Given the interface extraction, compatibility export, consumer migration, tests, and documentation
- When `bun run spur-check` and `bun run build` execute
- Then both commands pass with no skipped tests, new suppression directives, behavioral regressions, or unrelated changes

### Design

Keep the contract and implementation colocated in `packages/runtime/src/process-executor.ts`. Define `ProcessExecutor` as an interface over the two consumer-facing operations. Move the current class body to `NodeProcessExecutor implements ProcessExecutor`; configuration remains constructor/factory input and is not part of the service contract.

Use TypeScript's separate type and value namespaces to retain source compatibility: export the interface as `ProcessExecutor` and expose a deprecated constructible value alias pointing to `NodeProcessExecutor`. Existing `new ProcessExecutor(...)` callers continue to run, while type-only imports and structural fakes no longer inherit implementation state. Internal workspace code migrates off the compatibility value so the deprecation is exercised only by an explicit compatibility test.

Reuse the existing `RuntimeFactory.createProcessExecutor` abstraction rather than adding a second competing factory API. `nodeBunFactory` creates `NodeProcessExecutor` and returns it as `ProcessExecutor`; `cloudflareWorkersFactory` continues to throw because process execution is unavailable. Runtime context and Node/Bun-only composition roots request their defaults through that factory seam. Dependency declarations remain interface-typed throughout.

Verification must cover interface assignability, compatibility construction, all existing process behavior, structural test doubles, consumer type-checking, Cloudflare failure behavior, public exports, and documentation. No process implementation logic should change beyond the class rename and wiring updates.

### Plan

1. Introduce the `ProcessExecutor` interface, move the implementation to `NodeProcessExecutor`, and add the deprecated constructible compatibility value export.
2. Update runtime public exports and the existing `RuntimeFactory` implementations so factory return types are interface-based and Node/Bun construction uses the concrete class.
3. Rewire runtime context plus ai-runner, rule-engine, and dual-workflow-engine production defaults through the existing factory seam while keeping dependency fields interface-typed.
4. Convert structural fakes away from concrete inheritance and unsafe casts; update implementation tests to use `NodeProcessExecutor` or the factory as appropriate.
5. Add focused type/runtime assertions for factory compatibility, legacy construction, Node/Bun behavior, and Cloudflare unsupported behavior.
6. Update runtime and affected consumer README examples and diagrams to describe the interface, concrete provider, factory seam, and compatibility alias.
7. Run focused tests and type checks for all affected packages, then run `bun run spur-check`, `bun run build`, and inspect `git status` for intentional changes only.

### Testing

**Verdict:** PASS — all 9 requirements MET, all 6 Acceptance Criteria scenarios MET.

Verified 2026-07-13 against the working-tree diff (27 files). Gate evidence run this turn:

- `bun run lint` → biome clean (386 files) + per-package `tsc --noEmit` exit 0 for all 8 packages.
- `bun run test` → 1626 pass / 0 fail / 0 skip, 3559 expect() calls, 168 files.
- `bun run build` → exit 0 for all 8 packages.
- `bun run spur-check` → lint + tests + both spur presets green (`coverage-gate`, `every-export-has-tsdoc`).
- Coverage: `process-executor.ts` 94.87% func / 100% line; `context.ts`, `runtime-cf.ts`, `index.ts` 100%.

**Per-Requirement Traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 — canonical `ProcessExecutor` interface (`run` + `runStreaming`) | MET | `packages/runtime/src/process-executor.ts:113-127`; exported at `index.ts:33`; typecheck clean |
| R2 — `NodeProcessExecutor implements ProcessExecutor`, behavior preserved | MET | `process-executor.ts:139`; behavior suite `tests/process-executor.test.ts` (13 tests) pass; func cov 94.87% |
| R3 — factory returns interface; Node/Bun builds `NodeProcessExecutor`; CF unchanged | MET | `runtime-node-bun.ts:37`; `runtime-cf.ts:27-28` throws; `tests/runtime-cf.test.ts:25-33` + `tests/runtime-node-bun.test.ts:65` pass |
| R4 — consumers use type-only import + factory seam | MET | `ai-runner.ts:3-8,83`, `team-agent-process.ts:3,39`, `dual-workflow-engine/host.ts:2,94-101`, `rule-engine` 3 evaluators, `runtime/context.ts:7,53`; typecheck clean |
| R5 — deprecated constructible value alias; `import type` resolves to interface | MET | `process-executor.ts:415` `export const ProcessExecutor = NodeProcessExecutor`; `tests/index.test.ts:19` `new ProcessExecutor()` instanceof `NodeProcessExecutor` passes |
| R6 — test doubles implement structurally; no subclass/unsafe cast | MET | 11 test files converted `extends`→`implements`; all `as unknown as ProcessExecutor` casts removed (rg: 0 residual); `fixers.test.ts:404` wrong `{spawn}` fake corrected to `run`/`runStreaming` |
| R7 — compile-time + runtime coverage (factory, fakes, compat, Node/Bun+CF) | MET | `tests/runtime-node-bun.test.ts:65`, `runtime-factory.test.ts:19`, `index.test.ts:19`, `runtime-cf.test.ts:25-33`, consumer injection suites — all pass |
| R8 — README + affected consumer docs | MET | `packages/runtime/README.md`: interface/impl table, mermaid `ProcessExecutor <|.. NodeProcessExecutor`, process-execution section, compat-alias deprecation note (README:541 uses `new NodeProcessExecutor`) |
| R9 — no option/result/event/tracing/IO/ownership shape changes | MET | Diff limited to class rename + factory wiring; `ProcessOptions`/`ProcessResult`/`ProcessEventDetail` unchanged; behavior-assertion tests unchanged and green |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| Structural executor injection is canonical | MET | test + static | `implements ProcessExecutor` fakes across 11 suites; typecheck clean, no casts |
| Node/Bun factory returns concrete provider through interface | MET | test | `tests/runtime-node-bun.test.ts:65` createProcessExecutor block; `process-executor.test.ts` behavior/event/tracing/timeout/abort tests pass |
| Existing constructor callers remain compatible | MET | test | `tests/index.test.ts:19` `new ProcessExecutor()` instanceof `NodeProcessExecutor` |
| Production consumers use the port and factory seam | MET | static + command | `git diff` src consumers use `type ProcessExecutor` + `nodeBunFactory.createProcessExecutor()`; `bun run lint` typecheck exit 0 |
| Unsupported runtimes remain explicit | MET | test | `tests/runtime-cf.test.ts:25-33` — throws `ProcessExecutor is not available on Cloudflare Workers.` with and without config |
| Repository gates remain green | MET | command | `bun run spur-check` + `bun run build` both exit 0; 1626 pass / 0 fail / 0 skip; no new suppressions |

**Coverage:** measured — `process-executor.ts` 94.87% func / 100% line; consumer/context/factory paths 100%. No coverage-gate violation (spur `coverage-gate` preset passed).

**SECUA review (focus=all):** no blocker/major findings. Security — no new secrets, injection surface, or platform-API leakage (ADR-014 seam respected: consumers import the port, construction confined to `nodeBunFactory`). Correctness — `NodeProcessExecutor` body is a verbatim move; deprecated alias preserves `new ProcessExecutor(...)`. Architecture — interface/impl split deepens the seam; test doubles no longer inherit implementation state. Minor/advisory only: historical `docs/tasks/*` and `docs/plans/*` mention `new ProcessExecutor(...)` — out of scope (historical records, not living docs).

### Review

**Verdict: PASS** — reviewed 2026-07-13 against the working-tree diff (25 code files). All 9 requirements MET, all 6 AC scenarios MET, no blocker/major SECUA findings, no blocker/major architecture findings. Two advisory deepening candidates recorded (non-blocking).

**Gate evidence (fresh, this turn):** `bun run spur-check` → 1626 pass / 0 fail / 0 skip, both spur presets green (`coverage-gate`, `every-export-has-tsdoc`); `bun run build` → exit 0 for all 8 packages; `rg "extends ProcessExecutor|as unknown as ProcessExecutor"` → 0 residual.

---

**Functional Traceability (sp-functional-review)**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 — canonical `ProcessExecutor` interface (`run` + `runStreaming`) | MET | `packages/runtime/src/process-executor.ts:113-127` interface; `index.ts:33` re-export; typecheck clean |
| R2 — `NodeProcessExecutor implements ProcessExecutor`, behavior preserved | MET | `process-executor.ts:139` `class NodeProcessExecutor implements ProcessExecutor`; behavior suite `tests/process-executor.test.ts` (13 tests, renamed describe) pass; func cov 94.87% |
| R3 — factory returns interface; Node/Bun builds concrete; CF throws | MET | `runtime-node-bun.ts:37` `new NodeProcessExecutor(config)`; `runtime-cf.ts:27` `(_config?): never`; `tests/runtime-cf.test.ts:25-33` + `tests/runtime-node-bun.test.ts:65-100` pass |
| R4 — consumers type-only import + factory seam | MET | `ai-runner.ts:4,83`, `team-agent-process.ts:3,39`, `dual-workflow-engine/host.ts:2,95,100`, `exit-code-evaluator.ts:1,13`, `ripgrep-evaluator.ts:1,37`, `sg-evaluator.ts:1,32`, `runtime/context.ts:7,53`; all typecheck clean |
| R5 — deprecated constructible value alias; `import type` → interface | MET | `process-executor.ts:415` `export const ProcessExecutor = NodeProcessExecutor` (JSDoc `@deprecated`); `tests/index.test.ts:19` `expect(new ProcessExecutor()).toBeInstanceOf(NodeProcessExecutor)` pass |
| R6 — test doubles structural; no subclass/unsafe cast | MET | 11 test files `extends`→`implements`; `rg "extends ProcessExecutor\|as unknown as ProcessExecutor"` → 0 residual; `fixers.test.ts:404` wrong `{spawn}` fake corrected to `run`/`runStreaming` |
| R7 — compile-time + runtime coverage (factory, fakes, compat, Node/Bun+CF) | MET | `runtime-node-bun.test.ts:65-100` (run/streaming/cwd/timeout/rejectOnError), `runtime-factory.test.ts:19-20`, `index.test.ts:19` (compat instanceof), `runtime-cf.test.ts:25-33` (throws), consumer injection suites pass |
| R8 — README + affected consumer docs | MET | `packages/runtime/README.md`: table row `ProcessExecutor` (interface) + `NodeProcessExecutor` impl; mermaid L140 `ProcessExecutor <|.. NodeProcessExecutor : implements`; L536 process-execution section uses `new NodeProcessExecutor`; L568 deprecation note |
| R9 — no option/result/event/tracing/IO/ownership shape changes | MET | `ProcessOptions`/`ProcessResult`/`ProcessEventDetail` interfaces unchanged (`process-executor.ts:19,34,48`); diff limited to class rename + factory wiring; behavior-assertion tests unchanged and green |

**Acceptance Criteria**

| AC | Status | Evidence |
|----|--------|----------|
| Structural executor injection is canonical | MET | 11 fakes `implements ProcessExecutor` inject without cast; consumer suites pass |
| Node/Bun factory returns concrete through interface | MET | `runtime-node-bun.test.ts:65-100` behavior suite green |
| Existing constructor callers remain compatible | MET | `index.test.ts:19` `new ProcessExecutor() instanceof NodeProcessExecutor` pass |
| Production consumers use port + factory seam | MET | 6 consumers migrated; `rg NodeProcessExecutor` in non-runtime src → 0; typecheck clean |
| Unsupported runtimes remain explicit | MET | `runtime-cf.test.ts:25-33` throws on `createProcessExecutor()` + `createProcessExecutor({})` |
| Repository gates remain green | MET | `spur-check` + `build` exit 0; no `.skip`, no new suppressions |

---

**SECUA Review (sp-code-verification, review mode)**

| Dim | Severity | Finding |
|-----|----------|---------|
| Security | — | No new input paths, no secrets, no injection surface. Interface extraction is a rename + re-export. Clean. |
| Efficiency | — | No perf impact; same impl body, factory default construction same cost. Clean. |
| Correctness | — | Dual type/value namespace sound: `import type` → interface, `new` → const alias. `runStreaming(): never` stubs on run-only fakes fail loud (correct) — no consumer of run-only fakes calls `runStreaming`. `context.ts:53` cast preserved from pre-refactor (not new). Clean. |
| Usability | — | Alias JSDoc actionable ("Construct `NodeProcessExecutor` directly or use `nodeBunFactory.createProcessExecutor()`"). README diagrams + examples updated. Clean. |
| Architecture | — | Seam correctly placed: contract (interface) / construction (factory) / impl (concrete). Compat alias documented with removal intent. Clean. |

No blocker/major/minor SECUA findings.

---

**Architecture Depth (sp-code-improvement)**

Five lenses applied to the diff scope. The split is a deepening improvement, not friction: it reduces coupling (consumers → interface, not concrete), improves the test surface (structural fakes replace inheritance + casts), and places the construction seam in the factory. Two advisory candidates only.

**C1 — No deprecation-enforcement rule for `new ProcessExecutor(`**

- **Severity:** advisory
- **Signal:** poor test surface (deprecation not machine-enforced)
- **Location:** `packages/runtime/src/process-executor.ts:415` (alias) + `.spur/rules/`
- **Symptom:** The `ProcessExecutor` const alias is `@deprecated` in JSDoc only. No spur/ast-grep rule flags `new ProcessExecutor(` call sites, so the deprecation is advisory-on-paper — migration to `NodeProcessExecutor`/factory relies on manual review.
- **Evidence:** `process-executor.ts:407-414` JSDoc `@deprecated`; `rg "new ProcessExecutor(" packages --type ts` shows residual compat-test usage only (intentional), but no rule guards against new usage creeping in.
- **Deepening proposal:** Add an ast-grep rule under `.spur/rules/` matching `new ProcessExecutor($ARGS)` (excluding the compat test) that emits a warning, enrolled in `recommended-post-check`. Accelerates the alias-removal release by making deprecation machine-gated.
- **Challenge:** The compat test (`index.test.ts:19`) intentionally uses `new ProcessExecutor()` — a rule must exempt it or it blocks the gate.
- **Defense:** ast-grep rule `severity: warning` + path exclude `tests/index.test.ts` (or a `// spur-ignore: compat-alias` marker). Feasible.
- **Affected files:** `.spur/rules/deprecated-process-executor-construct.yaml`, `recommended-post-check` preset.

**C2 — `runStreaming(): never` stub boilerplate across 9 run-only fakes**

- **Severity:** advisory
- **Signal:** weak locality (the "fail loud on unstubbed streaming" contract is duplicated)
- **Location:** `packages/ai-runner/tests/{ai-runner,agent-detector,doctor-runner,lifecycle-bus,agents/auth-shims}.test.ts`, `packages/rule-engine/tests/{rule-engine,evaluators/ripgrep-evaluator,evaluators/sg-evaluator,fixers/fixers}.test.ts`
- **Symptom:** Each run-only fake repeats `runStreaming(): never { throw new Error('... not implemented') }`. The contract ("calling the unstubbed method fails loud") is expressed 9 times.
- **Evidence:** `rg "runStreaming\(\): never" packages --type ts` → 9 matches across 4 packages.
- **Deepening proposal:** A per-package `makeRunOnlyFake(responder)` helper would centralize the contract. **But:** fakes live in 4 packages with no shared test-utils package; a cross-package helper adds coupling. Per-package duplication is acceptable.
- **Challenge:** No shared test-utils package exists; creating one for one helper is itself a shallow module.
- **Defense:** none strong — drop or keep as advisory. The current explicit stubs are readable and the abstraction would be premature for a single helper. **Keep as advisory; do not act.**
- **Affected files:** (if acted on) each package's test files + a new shared util — not recommended now.

---

**Review Verdict: PASS**

`--next` → auto-transition to `done`.

### History

- 2026-07-13T16:58:26.265Z backlog → todo (system)
- 2026-07-13T17:44:09.122Z todo → done (system)
