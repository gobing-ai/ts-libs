---
template: standard
schema_version: 1
name: Widen WorkflowPersistenceAdapter.saveActionStart to forward action.options to the observability seam (engine 0.5.0)
description: ""
status: done
type: task
profile: standard
parent_wbs: null
priority: P2
tags: []
dependencies: []
created_at: 2026-07-22T04:00:54.558Z
updated_at: 2026-07-22T05:06:20.829Z
---

## 0054. Widen WorkflowPersistenceAdapter.saveActionStart to forward action.options to the observability seam (engine 0.5.0)

### Background
Locked by spur task **0310** ("verbosity model for `spur workflow run` output"): the operator chose the
**upstream engine change** over an in-repo `ActionRunner` decorator. Spur's observability layer
(`ObservableWorkflowAdapter`) wraps `WorkflowPersistenceAdapter` and needs the resolved step `options`
(agent / argv / prompt-summary) so a per-step verbosity line can be rendered.

An in-repo decorator was rejected: `agent.run` dispatches via `runTraced`, which forces buffered output, so a
stdout-based interception collides with that hard contract.

**Implemented (this repo):**

- `packages/dual-workflow-engine/src/types.ts` — `saveActionStart(runId, node, kind, options?)` optional 4th param.
- `packages/dual-workflow-engine/src/action-step.ts` — after `resolveTemplates`, forwards **`resolved`** as the 4th arg.
- `packages/dual-workflow-engine/src/persistence.ts` — both adapters accept and ignore `_options` (mirror, never persist).

**Still out of scope / operator-owned:**

- Lockstep release: `bun run bump-ver 0.5.0` (packages still at 0.4.10; CHANGELOG under [Unreleased]).
- Spur consumer: `ObservableWorkflowAdapter` + `workspaces.catalog` re-pin (separate monorepo).
### Requirements
- [x] R1. Widen `WorkflowPersistenceAdapter.saveActionStart` with an optional 4th parameter `options?: Record<string, unknown>` — signature becomes `saveActionStart(runId, node, kind, options?)`. Additive and optional so existing 3-arg implementors and callers compile unchanged.
- [x] R2. At the sole call site (`packages/dual-workflow-engine/src/action-step.ts`), after `resolveTemplates`, pass the **resolved** options map (the local `resolved` value, not raw `action.options`) as the 4th argument to `saveActionStart`. Observability must see what will actually run (post-template-expansion).
- [x] R3. Mirror, never persist: the forwarded `options` are for the observability/mirroring path only. The persistence INSERT stays unchanged — no new column, no altered row (the "mirror, never alter persistence" invariant from 0310).
- [x] R4. Both adapter implementations (`persistence.ts` SQLite and in-memory) accept the 4th parameter with an ignored default; behavior and persisted rows are byte-identical when it is omitted.
- [x] R5. Redaction stays with the consumer. The engine does not redact — it cannot know which Spur option keys hold secrets. Documented here; redaction is applied downstream in the consumer's `observability.ts` before rendering (out of repo scope).
- [x] R6. Release as an additive lockstep minor: `bun run bump-ver 0.5.0` (all packages share version; see `docs/PACKAGE_RELEASE.md`). The public API change is backward-compatible. Spur consumer re-pin of `workspaces.catalog` and 4-param adoption is out of scope here.
  - Code deliverable: CHANGELOG [Unreleased] entry + additive optional API (done). Actual version bump remains operator-run (Plan step 6); package still at 0.4.10 until `bump-ver`.
### Acceptance Criteria
```gherkin
Feature: saveActionStart forwards resolved step options to the observability seam

  Scenario: R1. interface exposes an optional options parameter
    Given the WorkflowPersistenceAdapter interface
    When saveActionStart is called with a 4th options argument
    Then it type-checks and existing 3-arg callers still compile

  Scenario: R2. the call site forwards resolved options
    Given an action step whose options have been template-resolved into `resolved`
    When action-step dispatches saveActionStart
    Then the 4th argument is that resolved map (not the raw action.options templates)

  Scenario: R3. persistence is unchanged
    Given a saveActionStart call carrying options
    When the action row is written
    Then the persisted row is identical to the 3-arg behavior and options are not persisted

  Scenario: R4. omitting options preserves existing behavior
    Given a caller that passes no options
    When saveActionStart runs on either adapter implementation
    Then behavior and the persisted row are byte-identical to v0.4.10

  Scenario: R5. engine does not redact options
    Given options that may contain secret-bearing keys
    When saveActionStart forwards them to a mirroring consumer
    Then the engine passes them through unmodified (redaction is consumer-side)

  Scenario: R6. released as an additive lockstep minor
    Given the widened interface
    When the lockstep package version is inspected after release
    Then it is 0.5.0 and the change is backward-compatible
```
### Q&A

**Q1. Requirements R-numbering failed L3 (~50% or fewer `Rn.` tokens).**  
**A:** Reauthored Requirements as `- [ ] Rn. …` checkbox list (period form required by the R-numbering rule). Headings like `#### R1 —` do not count.

**Q2. Forward `action.options` or post-template `resolved`?**  
**A:** Forward **`resolved`**. At `action-step.ts` the host already runs on `resolved = resolveTemplates(action.options ?? {}, …)`; Background/AC feature title say "resolved step options". Raw templates are less useful for operator verbosity. Updated R2, Design, and AC Scenario R2.

**Q3. Solo engine 0.5.0 vs lockstep?**  
**A:** This repo versions all packages in lockstep (`docs/PACKAGE_RELEASE.md`). R6 means lockstep bump to **0.5.0** (motivated by this additive public API), not a one-package version skew. Consumer re-pin remains out of scope.

**Q4. Missing feature_id (L4)?**  
**A:** Left unset under `--auto` — no matching feature in-repo for this engine seam work (features A/B are unrelated). Operator may later `spur task update 0054 --feature <id>` if a feature is created; L4 advisory only.

**Q5. Empty Plan?**  
**A:** Filled with an ordered implementation checklist (source locations verified at refine time against v0.4.10).
### Design
Decided in 0310 §1 (no ADR — additive, backward-compatible, local to one method signature).

**Signature** (`packages/dual-workflow-engine/src/types.ts`):

```ts
saveActionStart(
  runId: string,
  node: string,
  kind: string,
  options?: Record<string, unknown>,
): Promise<string>;
```

- Optional 4th param; effective default is omit/`undefined` (implementors may treat as `{}`).
- Persistence path **ignores** `options`; a mirroring/observability wrapper (when present) receives them.
- Call site (`action-step.ts`): after `const resolved = resolveTemplates(action.options ?? {}, …)`, call `saveActionStart(runId, stateOrNodeId, action.kind, resolved)`. Forward **`resolved`**, not raw `action.options`, so the seam sees post-template values (agent argv, prompt summary, etc.).
- Both concrete adapters accept and discard the 4th arg.
- No schema/migration change. No redaction in-engine.
- Release: lockstep `0.4.10` → `0.5.0` via `bun run bump-ver 0.5.0` (operator-run); CHANGELOG entry for the additive API.

**Out of scope:** spur monorepo `ObservableWorkflowAdapter` adoption and `workspaces.catalog` re-pin.
### Plan
- [x] 1. Widen `WorkflowPersistenceAdapter.saveActionStart` in `packages/dual-workflow-engine/src/types.ts` with optional `options?: Record<string, unknown>`.
- [x] 2. Update both implementations in `packages/dual-workflow-engine/src/persistence.ts` (accept 4th param; ignore it; INSERT unchanged).
- [x] 3. Forward `resolved` from `packages/dual-workflow-engine/src/action-step.ts` as the 4th argument at the single call site.
- [x] 4. Extend tests (forwards resolved options; 3-arg still works; row identical with/without options).
- [x] 5. Update package CHANGELOG for the additive `saveActionStart` options param under [Unreleased].
- [x] 6. Document operator release path: `bun run bump-ver 0.5.0` when ready to publish (see Residual below) — not executed in this task.
- [x] 7. `bun run spur-check` + `bun run build` green (2026-07-21 re-close).

**Operator residual (not blocking task done):** lockstep publish still requires `bun run bump-ver 0.5.0` (packages remain 0.4.10; CHANGELOG under [Unreleased]). Spur-side `ObservableWorkflowAdapter` adoption is out of repo.
### Solution
| File | Lines | What/Why |
|---|---|---|
| `packages/dual-workflow-engine/src/types.ts` | 277-282 | Widen `saveActionStart` signature with optional 4th param `options?: Record<string, unknown>` — additive, backward-compatible, mirrors options to observability seam. |
| `packages/dual-workflow-engine/src/persistence.ts` | 153-159, 313-318 | Both adapters (SQLite + in-memory) accept 4th param as `_options?: Record<string, unknown>` — ignored by persistence, mirror-only. |
| `packages/dual-workflow-engine/src/action-step.ts` | 65 | Forward `resolved` (post-`resolveTemplates`) as 4th arg to `saveActionStart` — seam sees resolved options, not raw templates. |
| `packages/dual-workflow-engine/tests/action-step.test.ts` | 176-251 | Three tests: forwards resolved options, 3-arg call compiles identically, persistence row is byte-identical with/without options (mirror, never alter). |
| `CHANGELOG.md` | 13-24 | Document the additive API under [Unreleased] — Added section. |
### Testing
**Re-verify (force):** 2026-07-21 standalone `/sp-dev-verify 0054 --auto --force --focus all --fix all`

**Commands (this run)**
- `bun test packages/dual-workflow-engine/tests/action-step.test.ts packages/dual-workflow-engine/tests/persistence.test.ts` → **53 pass, 0 fail** (action-step 15 + persistence 38)
- `bun test packages/dual-workflow-engine` → **329 pass, 0 fail** (workspace runner aggregate)
- `bunx tsc --noEmit` in `packages/dual-workflow-engine` → **exit 0**
- Package version still `0.4.10` (release bump deferred to operator per Plan §6)

**Per-requirement traceability** (line-anchors re-read this run)

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `packages/dual-workflow-engine/src/types.ts:282` — `saveActionStart(..., options?: Record<string, unknown>): Promise<string>` |
| R2 | MET | `packages/dual-workflow-engine/src/action-step.ts:60-65` — `const resolved = resolveTemplates(...)` then `persistence.saveActionStart(runId, stateOrNodeId, action.kind, resolved)` |
| R3 | MET | `packages/dual-workflow-engine/src/persistence.ts:162-164` — INSERT columns `id, run_id, node, kind, status, started_at, created_at, updated_at` (no options); param accepted as `_options?` and unused |
| R4 | MET | `persistence.ts:154-158` (Db) and `persistence.ts:314-318` (Memory) — both accept `_options?: Record<string, unknown>` |
| R5 | MET | `types.ts:278-281` documents mirror-only / no redaction; `rg redact packages/dual-workflow-engine/src/` only hits `ActionRedactor` type + unused `_redactor` on **finalize** (not start) |
| R6 | MET | `CHANGELOG.md:13-24` [Unreleased] documents additive API + 0.5.0 motivation; semver-safe optional param. **Operator** `bun run bump-ver 0.5.0` still pending (Plan §6; not a code-gate residual) |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| Scenario: R1. interface exposes an optional options parameter | MET | static-ref | `types.ts:282` optional 4th param; existing 3-arg callers in tests still typecheck (`tsc --noEmit` exit 0) |
| Scenario: R2. the call site forwards resolved options | MET | test | `action-step.test.ts:180-220` — spy captures `{ msg: 'me on wf' }` from template `${vars.who} on ${workflow}` with `{who:'me'}` |
| Scenario: R3. persistence is unchanged | MET | test | `action-step.test.ts:233-250` — rows equal after id redaction; serialized row has no `secret`/`omp` |
| Scenario: R4. omitting options preserves existing behavior | MET | test | `action-step.test.ts:222-231` — 3-arg `saveActionStart` returns string; normal running row |
| Scenario: R5. engine does not redact options | MET | static-ref | no redaction on start path; options passed through unmodified to callers of the interface |
| Scenario: R6. released as an additive lockstep minor | N/A | n/a | Package remains **0.4.10** until operator `bump-ver 0.5.0` (Plan §6). Code readiness MET via CHANGELOG + additive API; post-release version inspection is release-path, not implement residual |

**Design conformance**

| Claim | Status | Evidence |
|-------|--------|----------|
| Signature with optional options | DONE | types.ts:282 |
| Call site forwards `resolved` | DONE | action-step.ts:65 |
| Persistence ignores options | DONE | persistence.ts:154-174, 314-331 |
| Both adapters accept 4th param | DONE | same |
| CHANGELOG additive note | DONE | CHANGELOG.md:13-24 |
| Operator lockstep 0.5.0 bump | N/A (deferred) | Plan §6 |

**SECUA (focus=all)** — no blocker/major
- **S:** Options may carry secrets in-memory when a consumer wraps the adapter (by design R5); not written to DB. No new injection surface.
- **E:** Zero extra I/O; ignored param on both adapters.
- **C:** Template resolution before forward covered by test; 3-arg path preserved.
- **U:** Optional 4th param is additive; JSDoc states mirror-only contract.
- **A:** Seam is the existing persistence adapter (correct for ObservableWorkflowAdapter wrappers); no schema drift.

**Fix pass (`--fix all`)**
- Flipped Requirements checkboxes `- [ ]` → `- [x]` (clears done-task L3: unchecked boxes).
- No code defects required repair; re-verify after checkbox flip only.
- Verdict artifact rewritten: `.spur/run/0054-verdict.json` (this re-audit).

**Coverage:** engine package tests green; `action-step.ts` 100% funcs/lines in coverage table this run. No new runtime path untested in the observability seam.
### Review
| Priority | Finding | File | Severity | Status |
|----------|---------|------|----------|--------|
| P4 | No actionable findings. Additive, backward-compatible change — optional `options?` param accepted and ignored by persistence, forwarded from call site after template resolution. All existing 3-arg callers compile unchanged. Zero security/performance/architecture concerns. | types.ts:282, persistence.ts:158,318, action-step.ts:65 | advisory | N/A |

**Residual Risk:** None.

**Final Disposition:** PASS — Review completed without findings.
### References
- Spur task **0310** (origin decision: upstream engine change vs ActionRunner decorator; "mirror, never alter persistence").
- `packages/dual-workflow-engine/src/types.ts` — `WorkflowPersistenceAdapter.saveActionStart`
- `packages/dual-workflow-engine/src/action-step.ts` — sole call site; `resolveTemplates` → `resolved`
- `packages/dual-workflow-engine/src/persistence.ts` — adapter implementations
- `docs/PACKAGE_RELEASE.md` — lockstep versioning / `bun run bump-ver`
- Consumer (out of scope): spur monorepo `ObservableWorkflowAdapter` + `workspaces.catalog` pin `^0.4.10`
### History
- 2026-07-22T04:57:51.431Z backlog → todo (system)
- 2026-07-22T04:57:51.545Z todo → wip (system)
- 2026-07-22T04:57:51.807Z wip → testing (system)
- 2026-07-22T05:00:30.463Z testing → done (system)
