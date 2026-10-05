---
schema_version: 1
name: Fresh runs may start at a declared startable state (startState)
status: done
template: feature-impl
created_at: 2026-10-05T17:58:41.865Z
updated_at: "2026-10-05T18:19:34.593Z"
feature_id: C

priority: P2
ac_numbering: task-local
ac_altitude: task-local
estimate_hours: 5
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs/.spur/run/0102-verdict.json
---

## 0102. Fresh runs may start at a declared startable state (startState)

### Background

`WorkflowService.run` always begins at `initialState` / `initialNode`. The only way to enter a graph
mid-way is `resume()`, which targets the *same* run, loads its latest snapshot, and defaults to
`skip-enter`. A completed run therefore cannot be re-driven from a chosen point: a consumer wanting
only the tail of a graph (re-run a publish phase after fixing a credential) must either re-execute
every earlier node or leave the engine.

Downstream consumer: spur-new task 1072 (`spur workflow run --from <state-id>` / `--from-run
<run-id>`). Its 2026-10-04 re-evaluation confirmed 0.5.15 has no start-state option under any name —
`WorkflowRunOptions` has no `startState`, the strict schema has no `startable`, and every engine
commit in 0.5.13–0.5.15 is DAG-only. This task supplies the option.

Closest existing primitives, and why they are not the answer: `reseedRun` + `resumeRun({ resumeMode:
'rerun-enter' })` can reach a state, but only through an existing run row (so validation happens
after the row exists), it emits `workflow.run.reseeded` at warning severity on every use, and it
reuses `resumeRerun` — a marker declared for *interruption* safety — to mean something else.
`startState` keeps the semantics explicit and refuses before any run row is created.

### Requirements

- [x] R1. `WorkflowRunOptions.startState?: string`. On a fresh run the driver begins at that state/node with fresh-run semantics: no snapshot is loaded, `resumeMode` is undefined, `transitionsTaken` starts at 0, and the start state's on-enter/node action executes.
- [x] R2. Per-state and per-node opt-in: `startable: z.boolean().optional()` in `StateDefSchema` and `FlowNodeDefSchema` (both `.strict()`, beside the existing `resumeRerun`). A state not marked `startable: true` may never be a start point.
- [x] R3. `WorkflowService.run` refuses before any run row exists, with `FSMError`: undeclared state, terminal state, failure state, non-`startable` state, and `kind: dag`.
- [x] R4. Absent `startState`, behavior is unchanged: no snapshot, `initialState`, and the existing pause/resume/interrupt/dryRun semantics are untouched.
- [x] R5. `startState` is independent of `resumeMode`/`resumeOwner`: passing it does not imply a resume, and passing `resumeMode` without an existing run does not manufacture one.
- [x] R6. Out of scope: DAG start states (node-level resume already exists for DAG), a workflow-level blanket allow, any caller override flag, and any consumer CLI surface.

### Acceptance Criteria

```gherkin
Scenario: AC1 — State-machine fresh run begins at a startable state (req: R1, R2)
  Given a state-machine fixture whose every state's onEnter action appends its id to a marker file
    and state S3 declared `startable: true`
  When `run(def, { startState: 'S3' })` executes
  Then the marker file contains only S3 and its successors
  And the run reaches the declared terminal state
  And no state snapshot is read for the new run
  And `transitionsTaken` counts only post-start edges

Scenario: AC2 — Transition-flow fresh run begins at a startable node (req: R1, R2)
  Given a transition-flow fixture whose every node's action appends its id to a marker file
    and node N3 declared `startable: true`
  When `run(def, { startState: 'N3' })` executes
  Then the marker file contains only N3 and its successors
  And the run reaches the declared terminal node

Scenario: AC3 — Every refusal is loud and side-effect free (req: R3, R6)
  Given a definition and a start state that is undeclared, terminal, a failure state, not marked
    `startable`, or on a `kind: dag` workflow
  When `run` is called with that `startState`
  Then it throws `FSMError`
  And no run row is created (`listRuns()` did not grow)

Scenario: AC4 — A run without `startState` is unchanged (req: R4)
  Given a fresh run with `startState` omitted
  When the driver executes
  Then no snapshot read occurs and the run starts at `initialState`
  And the existing driver suites pass unmodified

Scenario: AC5 — `startState` composes with `dryRun`, not with resume (req: R1, R5)
  Given `startState` set together with `dryRun: true`
  When the run executes
  Then the walk begins at the start state and no action executes
  And `startState` neither sets `resumeMode` nor claims run ownership
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-05T18:00:00.362Z

Closed at intake (2026-10-05):

- **Q: Reuse the loop's `resumeFromState` parameter instead of adding a parallel one?** A: No. That branch also loads the latest snapshot and defaults `resumeMode` to `skip-enter`, which skips the start state's action — precisely the silent skip this feature exists to prevent. Use a distinct parameter so no later edit can re-couple them.
- **Q: Why not compose `reseedRun` + `resumeRun({ resumeMode: 'rerun-enter' })`, which 0.5.15 already supports?** A: Considered and rejected as the primary path. It requires a run row (born `paused`) to exist before validation, splits refusals across three call sites and two error types, emits `workflow.run.reseeded` at `severity: 'warning'` on every use, and reuses `resumeRerun` — a marker declared for interruption safety — for a different meaning.
- **Q: Why an opt-in marker rather than a workflow-level allow or a caller override?** A: An override recreates the silent skip: a mid-graph start on a state that assumed earlier artifacts must fail loud. The engine owns the marker because the definition schema is strict.
- **Q: DAG start states?** A: Out of scope (R6). DAG already has node-level resume; a node-subset start is a different feature.

### Design

**Change map (files to touch in `packages/dual-workflow-engine`).**

- `src/types.ts` `WorkflowRunOptions` (currently `:285`, ends at `resumeOwner`) — add `readonly startState?: string`. Documented as fresh-run only.
- `src/schema.ts` `StateDefSchema` (`:98`) and `FlowNodeDefSchema` (`:138`) — add `startable: z.boolean().optional()` beside `resumeRerun`. Both objects are `.strict()`, so the field must be declared or a YAML author setting it is rejected.
- `src/service.ts` `run()` (driver dispatch at `~:61`) — validate `options.startState` before dispatching to any driver and before `RunLifecycle.run` creates the row; throw `FSMError` (`src/errors.ts`). `assertReseedTargetDeclared` is the precedent for the shape of this validation.
- `src/state-machine.ts` `run()` → `loop()` (`:26` → `~:54`) and `src/transition-flow.ts` `run()` → `loop()` (`~:56`) — thread the start point as a **distinct** parameter (e.g. `startAtState` / `startAtNode`) that sets the initial cursor while leaving `snapshot`, `resumeMode`, and `snapshotTransitions` on their fresh-run values.

**Invariants.**

- `startState` is a *fresh-run* input. It never loads a snapshot, never sets `resumeMode`, never claims ownership, and never touches `resumeRun` / `reseedRun` / `resumeRerun`.
- The start state's on-enter (or node action) **executes**. Skipping it is the silent-skip failure this feature exists to prevent, so the parameter must not be able to reach the resume branch.
- Validation completes before the run row exists, so a refused start leaves no `runs` / state / transition / phase rows behind.
- Absent `startState`, the code path is byte-identical to today.

**Why not reuse `resumeFromState`.** That branch (`state-machine.ts` `~:66-73`) loads the latest snapshot and defaults `resumeMode` to `skip-enter` — correct for a paused run, wrong for a fresh start. Overloading it would make the two semantics indistinguishable to future edits.

### Plan

- [x] 1. Write the failure list first (the five R3 refusal cases, the `loop()` coupling, and the `dryRun` interaction), then implement the schema field and the option.
- [x] 2. Thread the start point through both drivers with a distinct parameter; leave `resumeFromState` / `resumeFromNode` untouched.
- [x] 3. Add the pre-dispatch validation in `WorkflowService.run`, including the no-row-created guarantee.
- [x] 4. Tests for AC1–AC5, including the `listRuns()` non-growth assertion for every refusal.
- [x] 5. Docs: new ADR entry (T1), `docs/03_ARCHITECTURE.md` mechanism, package `README.md` API section, `CHANGELOG.md` 0.5.16 section.
- [x] 6. Gate: `bun run spur-check` and `bun run build`.
- [x] 7. Release 0.5.16 (lockstep `bump-ver`) so the downstream consumer can pin it.

### Solution

| File:line | Change |
| --- | --- |
| `packages/dual-workflow-engine/src/types.ts:326` | `WorkflowRunOptions.startState?: string` — fresh-run start point, documented as fresh-run-only (no snapshot, no `resumeMode`, start action executes) and unsupported for DAG. |
| `packages/dual-workflow-engine/src/types.ts:87` | `StateDef.startable?: boolean` — author opt-in for a fresh run to begin at this state. |
| `packages/dual-workflow-engine/src/types.ts:152` | `FlowNodeDef.startable?: boolean` — same for transition-flow nodes. |
| `packages/dual-workflow-engine/src/schema.ts:100` | `startable: z.boolean().optional()` in `StateDefSchema` (`.strict()`), so a definition declaring the marker validates. |
| `packages/dual-workflow-engine/src/schema.ts:142` | `startable: z.boolean().optional()` in `FlowNodeDefSchema` (`.strict()`). |
| `packages/dual-workflow-engine/src/service.ts:67` | `WorkflowService.run` validates `options.startState` before driver dispatch, so a refusal leaves no run row (R3). |
| `packages/dual-workflow-engine/src/service.ts:165` | New `assertStartStateAllowed` — refuses `kind: 'dag'`, undeclared (listing valid `startable` ids), failure, terminal and non-`startable` targets with `FSMError`. |
| `packages/dual-workflow-engine/src/state-machine.ts:59` | `loop` gains a `startAtState` parameter, distinct from `resumeFromState`. |
| `packages/dual-workflow-engine/src/state-machine.ts:70` | `entryState = resumeFromState ?? startAtState` sets the initial cursor; the snapshot load, `resumeMode` and `transitionsTaken` stay on their fresh-run values. |
| `packages/dual-workflow-engine/src/state-machine.ts:90` | The undeclared-state `FSMError` label reports the effective entry state. |
| `packages/dual-workflow-engine/src/transition-flow.ts:62` | `loop` gains a `startAtNode` parameter, distinct from `resumeFromNode`. |
| `packages/dual-workflow-engine/src/transition-flow.ts:72` | `entryNode = resumeFromNode ?? startAtNode` sets the initial cursor; resume state untouched. |
| `packages/dual-workflow-engine/src/transition-flow.ts:88` | The undeclared-node `FSMError` label reports the effective entry node. |
| `packages/dual-workflow-engine/tests/start-state.test.ts:110` | AC1/AC2 fixture runs: a `mark` action appends its id to a marker file, so the observed marker is the executed-state set. |
| `packages/dual-workflow-engine/tests/start-state.test.ts:129-138` | AC3 refusal matrix, each case asserting `FSMError` and `listRuns()` non-growth. |
| `docs/00_ADR.md:680-699` | ADR-035 records the decision and the rejected `reseedRun` + `rerun-enter` composition. |
| `docs/03_ARCHITECTURE.md:61` | § dual-workflow-engine gains the start-state mechanism paragraph. |
| `packages/dual-workflow-engine/README.md:591-618` | New "Fresh-run Start State" section with YAML + TS usage and the refusal rules. |

### Testing

`bun run spur-check` — PASS. Biome clean, per-package `tsc --noEmit` clean, `2804 pass / 0 fail` across 235 test files, and both `spur rule run` presets (`recommended-pre-check` before tests, `recommended-post-check` after) report no violations.

`bun run build` — PASS. All 12 packages built with exit 0, including `@gobing-ai/ts-dual-workflow-engine`.

`NODE_ENV=test bun test tests/start-state.test.ts --reporter=dots` — PASS, 10 tests / 0 fail:
- AC1 — state-machine run from `s2` leaves marker `s2, s3`, reaches `done`, `transitionsTaken: 2`, and `snapshotReads: 0`.
- AC2 — transition-flow run from `n2` leaves marker `n2, n3`, reaches `end`, `snapshotReads: 0`.
- AC3 — undeclared (message lists `Startable ids: s2`), terminal, failure, non-`startable`, and DAG targets each throw `FSMError` with `listRuns()` still empty.
- AC4 — omitting `startState` runs `s1, s2, s3` from `initialState`.
- AC5 — `dryRun` + `startState` reaches `done` with an empty marker; a `startable` state without `resumeRerun` resolves normally, proving `startState` does not enter the rerun-enter path.

Coverage note: the new branch is exercised by the assertions above; no suppression or skipped test was added.

### Review

Self-review of the change diff (9 files, +162/-7) against the task's Design and R1–R6.

| Priority | Dimension | Location | Finding |
| --- | --- | --- | --- |
| P4 | Duplication | `packages/dual-workflow-engine/src/service.ts:165` | `assertStartStateAllowed` re-derives the terminal/failure sets that each driver loop already builds (`state-machine.ts:63-64`, `transition-flow.ts:63`). Four lines of duplication; a future change to failure-state semantics could drift between the two. Advisory — extracting a shared derivation would touch both drivers for no current benefit. |
| P4 | Test coverage | `packages/dual-workflow-engine/tests/start-state.test.ts:172` | The DAG refusal is asserted against an in-memory definition, so the strict `DagNodeDefSchema` rejecting a DAG node that declares `startable` is intended behavior but not directly asserted. Advisory — the schema path is covered by the existing schema suite. |
| P4 | Silent option interaction | `packages/dual-workflow-engine/src/state-machine.ts:73` | `resumeMode` supplied alongside `startState` on a fresh run is ignored (the drivers read `resumeMode` only when a resume cursor is present). This is pre-existing behavior and the `startState` doc comment states fresh-run-only; no refusal was added because R5 only requires that `startState` not *imply* resume. Advisory. |

Residual risk: none blocking. The change is additive and refusal-first — an absent `startState` leaves every existing path untouched, and every illegal start point is refused before a run row exists. Consumer integration (spur-new task 1072 pinning 0.5.16 and implementing `--from` / `--from-run`) is deliberately out of scope and unverified here.

Disposition: PASS — no P1–P3 findings; the three P4 advisories carry no action in this task.

### References

- Parent feature: `C` (`ts-dual-workflow-engine`).
- `src/service.ts` — `run` (no start option; dispatch), `resumeRun` (paused/interrupted only), `assertResumeRerunAllowed`, `assertReseedTargetDeclared`.
- `src/state-machine.ts` — `run` → `initialState`, `resume` → `resumeFromState`, and the start/snapshot/resumeMode block in `loop`.
- `src/transition-flow.ts` — same shape for nodes.
- `src/types.ts` — `WorkflowRunOptions`; `src/schema.ts` — `resumeRerun` precedent; `src/errors.ts` — `FSMError`.
- `docs/00_ADR.md` ADR-025 (run interruption contract) and ADR-034 (DAG mode) — the adjacent contracts this change deliberately does not modify.
- Downstream consumer: spur-new `docs/tasks5/1072_start-or-resume-a-workflow-run-from-a-chosen-state.md`.

### History

- 2026-10-05T18:13:31.642Z backlog → todo (system)
- 2026-10-05T18:13:31.807Z todo → wip (system)
- 2026-10-05T18:13:32.140Z wip → testing (system)
- 2026-10-05T18:19:34.565Z testing → done (system)

