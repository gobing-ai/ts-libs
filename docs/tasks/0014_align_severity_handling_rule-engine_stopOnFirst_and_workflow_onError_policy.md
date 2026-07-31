---
schema_version: 1
name: align_severity_handling_rule-engine_stopOnFirst_and_workflow_onError_policy
status: done
type: task
profile: complex
priority: P2
tags: [rule-engine,dual-workflow-engine,severity,error-policy,api,additive]
dependencies: [ADR-006,ADR-013]
created_at: 2026-06-04T22:24:26.829Z
updated_at: 2026-06-05T00:00:00.000Z
---

## 0014. align_severity_handling_rule-engine_stopOnFirst_and_workflow_onError_policy

### Background

Two sibling engines handle step/rule failure differently today. ts-rule-engine: engine.ts:74 loops over ALL rules exhaustively, never breaks; each finding carries severity (error|warning|info); the verdict (exit code) is computed by the CONSUMER (spur rule-service.ts:196 via --fail-on), NOT the engine. ts-dual-workflow-engine: drivers halt on the first ActionResult.ok===false (state-machine.ts:67, transition-flow.ts:72); binary ok, no severity, fail-fast is hard-coded. The asymmetry is INTRINSIC to batch-linter vs sequential-pipeline (ADR-006 §4 keeps error semantics engine-local) and must be preserved, not unified. Goal: align the shared *vocabulary* (severity enum + config-default→runtime-override pattern) while keeping the *policy verb* honestly different (rule-engine traversal=stopOnFirst, workflow control-flow=onError). No shared code; conceptual symmetry only.


### Requirements

**Part A — rule-engine (traversal alignment)**

- **R1**: Add opt-in `stopOnFirst?: 'error' | 'warning' | 'info'` param to `RuleEngine.evaluate` and `evaluateWithFixes`. When set, break the rule loop (`engine.ts:74`) after the first rule whose findings meet/exceed the threshold (via a `SEVERITY_RANK` comparison). → **Done when**: a test with 3 rules where rule 2 yields an `error` finding returns findings from rules 1–2 only and never invokes the rule-3 evaluator (assert via a spy/fake evaluator); the same rules with `stopOnFirst` omitted return all 3 (exhaustive, unchanged).
- **R1a**: Default (`stopOnFirst` undefined) is exhaustive — today's behavior, zero breaking change. The verdict (exit code) is NOT computed by the engine. → **Done when**: every existing rule-engine test passes unmodified; no `exitCode`/verdict logic added to `RuleEngine`.

**Part B — workflow-engine (control-flow alignment)**

- **R2**: Add per-action `ActionDef.onError?: 'fail' | 'continue'` to `types.ts` + both `ActionDefSchema` consumers. → **Done when**: schema parses a workflow with `onError: 'continue'` on an action and rejects an invalid value with a `WorkflowValidationError`.
- **R2a**: Add workflow-level `defaultOnError?: 'fail' | 'continue'` (default `'fail'`) to both `StateMachineWorkflowDef` and `TransitionFlowWorkflowDef` schemas + types. → **Done when**: an omitted `defaultOnError` resolves to `'fail'`; a workflow-level `'continue'` applies to actions that don't override it.
- **R2b**: Add `WorkflowRunOptions.onError?: 'fail' | 'continue'` run-option override. → **Done when**: precedence `action.onError ?? workflow.defaultOnError ?? runOptions.onError ?? 'fail'` is exercised by a test asserting each level wins over the next.
- **R3**: In both drivers, on `!ok` branch on the resolved policy. `'fail'` → current `lifecycle.fail()` (unchanged default). `'continue'` → `RunLifecycle` warn (reuse the ADR-013 observability seam) + retain `lastActionResult` + fall through to guard evaluation. Apply to all 4 `!ok` branches (state-machine onEnter/onExit/action at `state-machine.ts:67,103` + the action branch; transition-flow at `transition-flow.ts:72`). → **Done when**: a fail-vs-continue matrix test across both drivers shows `'continue'` advances to the next node/state using the failed step's result, and `'fail'` halts — for each of the 4 branches.
- **R4**: Config validation — a `'continue'` node/state with no outbound edge/transition resolves to `done` (not infinite loop, not error). → **Done when**: a single-node `'continue'` workflow with no edges terminates with status `done`; covered by a regression test.

**Cross-cutting**

- **R5**: Append an ADR-013 addendum recording the deliberate design: severity-vocabulary aligned, policy-verb divergent, no shared code, verdict-stays-in-consumer. → **Done when**: `docs/00_ADR.md` carries the dated addendum and references both engines.
- **R6**: Test coverage — rule-engine `stopOnFirst` (≥3 cases: threshold hit, threshold not met, omitted/exhaustive); workflow fail-vs-continue matrix across both drivers + precedence + R4 terminal case. → **Done when**: new tests added under each package's `tests/`, coverage gate (`coverage-gate` spur rule, ≥90%) stays green.
- **R7**: Full gate green and lockstep-publishable. → **Done when**: `bun run spur-check` and `bun run build` both pass; `git status` shows only intentional changes; both packages remain releasable in one lockstep bump (unblocks spur-new#0017).


### Q&A

_Refined via `rd3:dev-refine 0014 --auto` (synthesis-only, no interactive Q&A). Decisions derived from existing Background/Solution:_

- **Q: Preset?** → **complex**. Signals: 2 packages (rule-engine + dual-workflow-engine), 6+ files, a control-loop behavioral change in the most security-relevant code, an ADR addendum, and a cross-repo release gate. ≥2 complex-column signals; tiebreaker prefers higher to avoid under-scoping. Not `research` — the change is additive and well-understood.
- **Q: Split compound R2?** → Yes. Original R2 packed three concepts (per-action field, workflow default, run-option override) into one item; split into R2 / R2a / R2b for independent testability.
- **Q: Acceptance criteria?** → Added a "Done when" verification clause to every requirement; previously they stated intent only.
- **Q: Constraints?** → Synthesized from Background's stated invariants (additive-only, no shared code, distinct verbs, verdict-in-consumer, lockstep-publishable) plus project gates (spur-check, runtime boundaries).
- **Open (defer to design phase, not blocking):** exact `SEVERITY_RANK` reuse vs re-declaration between engines (must NOT share code — likely a tiny per-package const); whether `'continue'` should also surface in the `WorkflowRunResult` (e.g. a `warnings[]` field) or stay log-only — recommend log-only for v1 (YAGNI).


### Design

**Design invariants / constraints** (the "must / must NOT" that keep this change safe and on-target):

- **Additive-only (must NOT break callers).** Every new field/param is optional with a default reproducing today's behavior: rule-engine `stopOnFirst` defaults `undefined` (exhaustive); workflow `onError`/`defaultOnError` default `'fail'` (fail-fast). No existing test may need editing to keep passing.
- **No shared code between the two engines.** Alignment is conceptual (same `severity` enum + same config-default→runtime-override shape), not a shared module. ADR-006 §4 keeps error semantics engine-local; do NOT introduce a cross-engine policy util. `SEVERITY_RANK` is re-declared per package if needed, not shared.
- **Keep the policy verbs distinct.** rule-engine = `stopOnFirst` (traversal); workflow = `onError` (control-flow). Do NOT collapse into one `default-behavior` name — false symmetry is worse than two honest names.
- **Verdict stays in the consumer (rule-engine).** Must NOT move pass/fail into `RuleEngine`; `stopOnFirst` is traversal only. Exit-code/`--fail-on` logic stays in spur (`rule-service.ts:196`).
- **Boundaries unchanged.** No new `node:*` imports outside ts-runtime (ADR-011); no new top-level dependency in either package; drizzle stays internal to ts-db.
- **Lockstep-publishable.** Both packages must remain releasable in one lockstep bump so spur-new#0017 can consume `stopOnFirst` from a published version.
- **Gate is non-negotiable.** `bun run spur-check` + `bun run build` must pass; no `--no-verify`, no gate-silencing `biome-ignore`, no `.skip`'d tests.

**Resolution precedence (workflow onError):** `action.onError ?? workflow.defaultOnError ?? runOptions.onError ?? 'fail'` — implement as a single `resolvePolicy()` helper used by both drivers.

**Open design questions (decide at implementation, non-blocking):** (1) whether `'continue'` surfaces in `WorkflowRunResult` (e.g. `warnings[]`) or stays log-only — recommend log-only for v1 (YAGNI); (2) exact threshold-met comparison for `stopOnFirst` (`>=` on `SEVERITY_RANK`).


### Solution

Part A rule-engine (~15 src + ~40 test, ~45min, Low risk): SEVERITY_RANK helper + 3-line post-rule guard in engine.ts:74 loop; optional param threaded through evaluate→evaluateWithFixes. Part B workflow-engine (~40 src + ~90 test, ~2-3hr, Medium risk): 2 schema fields, types.ts, resolvePolicy() helper, 4 driver branches, RunLifecycle.warn-on-continue, run-option override, config-validation rule, ADR-013 addendum. Keep policy verbs distinct (stopOnFirst vs onError) — same severity enum + same config-default/runtime-override shape = the alignment; different verb = honest difference.


### Plan



### Review

## Review — 2026-06-05 (force re-verify, auto-fix all)

**Status:** 4 findings, ALL RESOLVED · verdict **PASS**
**Scope:** Task 0014 — rule-engine `stopOnFirst` + workflow `onError`/`defaultOnError`
**Mode:** verify (Phase 7 SECU + Phase 8 traceability) · **Channel:** current
**Gate:** `bun run spur-check` → PASS (1116 tests, 34+2 rules); `bun run build` → PASS (8/8)

### Phase 8 — Requirements Traceability: all 10 MET, no scope drift.

### Findings — all resolved

| # | Sev | Title | Resolution |
|---|-----|-------|------------|
| F1 | P2 | `continue` policy diverged across drivers: transition-flow retained the failed `lastActionResult`, state-machine nulled it to `undefined`. A downstream guard inspecting `.error`/`.data` would behave differently per dialect. | **FIXED.** state-machine `runActions` now returns a discriminated `{ outcome, result }` (`state-machine.ts:121-160`): the last action result is retained (including continued failures) so guards can inspect it, while `outcome` ('completed'\|'terminal'\|'fail') drives control flow. New cross-driver parity test `tests/onerror-parity.test.ts` asserts both drivers expose the identical continued-failure result to the downstream guard (would have failed pre-fix). |
| F2 | P3 | Test name `'runOptions.onError has lowest precedence'` contradicted its assertion. | **FIXED.** Renamed to `'runOptions.onError applies when action and workflow defaults are absent'` (`state-machine.test.ts:253`). |
| F3 | P3 | `warnActionFailed` lacked a span event (every other lifecycle method emits one). | **FIXED.** Added `addSpanEvent('workflow.action_failed_continue', …)` (`run-lifecycle.ts:145`). |
| F4 | P2 | Continued state-machine `onExit` failures were not retained for downstream guards; additionally, a state with no `onEnter` actions erased the prior action result. | **FIXED.** `state-machine.ts` now preserves prior results when no enter action runs and assigns continued `onExit` results before transitioning. Added regression test `state-machine.test.ts` asserting a next-state guard sees the continued `onExit` failure. |

### Notes
- Security: closed enums (`onError`, `stopOnFirst`); no injection/secret/exposure paths.
- Efficiency: `stopOnFirst` short-circuits; workflow policy resolution is constant-time.
- Design constraints honored: `SEVERITY_RANK` rule-engine-local; workflow `OnErrorPolicy` distinct; policy verbs kept distinct (`stopOnFirst` vs `onError`); no shared code between engines.


### Phase 8 — Requirements Traceability

| Req | Verdict | Evidence |
|-----|---------|----------|
| R1 rule-engine stopOnFirst param | **MET** | `engine.ts:50,73` (both signatures); loop guard `engine.ts:124` |
| R1a default exhaustive, verdict in consumer | **MET** | `stopOnFirst?` optional; no exitCode logic in engine; 8 tests incl. exhaustive default |
| R2 ActionDef.onError | **MET** | `types.ts:20`, `schema.ts:30` |
| R2a workflow defaultOnError (default 'fail') | **MET** | `types.ts:60,97`, `schema.ts:51,90`; `resolveOnErrorPolicy` defaults 'fail' |
| R2b WorkflowRunOptions.onError override | **MET** | `types.ts:153`; precedence tests SM lines 221-302 |
| R3 driver !ok policy branch (4 branches) | **MET** | SM `runActions` retains continued onEnter/onExit results; TF action branch retains failed result; onExit regression test covers next-state guard visibility |
| R4 continue + no-edge terminates done | **MET** | SM and TF single-node continue tests |
| R5 ADR-013 addendum | **MET** | `docs/00_ADR.md` (verify content) |
| R6 test coverage | **MET** | rule-engine 8 stopOnFirst cases; workflow precedence matrix, cross-driver parity, R4, terminal-wins, and onExit retention regression |
| R7 gate + build green, lockstep-publishable | **MET** | `bun run spur-check` and `bun run build` pass; no new dependency |

All 10 requirements MET. No scope drift.


### Testing

- `bun test packages/dual-workflow-engine/tests/state-machine.test.ts packages/dual-workflow-engine/tests/onerror-parity.test.ts packages/dual-workflow-engine/tests/transition-flow.test.ts packages/dual-workflow-engine/tests/schema.test.ts` → 59 tests passed; command exits nonzero on partial coverage threshold, expected for focused runs
- `bun test packages/rule-engine/tests/rule-engine.test.ts packages/rule-engine/tests/engine.test.ts` → 32 tests passed; command exits nonzero on partial coverage threshold, expected for focused runs
- `bun run spur-check` → PASS; 1116 tests, 0 fail; all 34 pre-check and 2 post-check spur rules passed
- `bun run build` → PASS for all 8 packages


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| Fix | `packages/dual-workflow-engine/src/state-machine.ts` | Codex | 2026-06-05 |
| Test | `packages/dual-workflow-engine/tests/state-machine.test.ts` | Codex | 2026-06-05 |

### References


### History

- Migrated from legacy format (2026-07-31)
