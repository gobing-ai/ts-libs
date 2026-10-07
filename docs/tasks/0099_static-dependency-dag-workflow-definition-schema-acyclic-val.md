---
schema_version: 1
name: Static dependency DAG workflow definition schema, acyclic validation, and ADR specification
status: done
template: feature-impl
created_at: 2026-10-04T21:10:02.283Z
updated_at: "2026-10-07T21:52:24.549Z"
feature_id: C3
priority: P2
tags:
  - dual-workflow-engine
  - dag
  - schema
estimate_hours: 6

dependencies: ["0093"]
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-runall-c3-c3f1/.spur/run/0099-verdict.json
---

## 0099. Static dependency DAG workflow definition schema, acyclic validation, and ADR specification

### Background

Implements: R1 — Acyclic graph validation and dependency resolution.

In `ts-dual-workflow-engine`, both `state-machine` and `transition-flow` represent state transitions. While structured fork-join (Feature C2) handles parallel branch regions, general dataflow and dependency workflows need static DAG semantics: nodes declare dependencies on upstream nodes (`dependsOn: string[]`), the graph is statically validated to be strictly acyclic, and nodes are dispatched as their prerequisites complete.

This task authors ADR-034 for static DAG execution, introduces the `DagWorkflowDef` schema and types, and implements acyclic graph validation using Kahn's algorithm or Tarjan's SCC in `validateWorkflowDef`.

### Requirements

- [x] R1. Author ADR-034 in docs/00_ADR.md specifying static dependency DAG workflow execution mode and syntax within ts-dual-workflow-engine.
- [x] R2. Zod and JSON schema for DAG workflow definitions accepting nodes with dependsOn string arrays.
- [x] R3. validateWorkflowDef detects and rejects circular dependencies via topological sort, self-edges, and references to undeclared nodes.
- [x] R4. Out of scope: Scheduler execution loop (owned by task 0100).

### Acceptance Criteria

- [x] AC1 — Acyclic graph validation and dependency resolution (req: R1; req: R2; req: R3)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T21:28:45.404Z

#### Q&A entry — 2026-10-04T14:30:00.000Z
- **Q: Does DAG mode support cycles?**
  - A: No. DAG mode strictly requires acyclic graphs and rejects cycles at load time. Workflows requiring cycles must use state-machine or transition-flow mode.
- **Q: Can dependencyPolicy be per-node?**
  - A: Yes, each node can declare `dependencyPolicy: 'all'` (default) or `'any'` (any completed prerequisite satisfies dispatch).

### Design

**WHAT:**
Add ADR-034 to `docs/00_ADR.md`. Add `DagWorkflowDef` and `DagNodeDef` in `src/types.ts`, `src/schema.ts`, and `src/config.ts`.

**FROZEN TYPES:**
```ts
export interface DagNodeDef {
    readonly id: string;
    readonly description?: string;
    readonly action?: ActionDef;
    readonly dependsOn?: readonly string[];
    readonly dependencyPolicy?: 'all' | 'any';
    readonly condition?: GuardDef;
    readonly pause?: boolean;
    readonly resumeRerun?: boolean;
}

export interface DagWorkflowDef {
    readonly kind: 'dag';
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
    readonly iterationBound?: number;
    readonly defaultOnError?: OnErrorPolicy;
    readonly vars?: Vars;
    readonly env?: Env;
    readonly nodes: readonly DagNodeDef[];
    readonly extensions?: WorkflowExtensions;
}
```

**WHERE:**
- Primary files: `docs/00_ADR.md`, `packages/dual-workflow-engine/src/types.ts`, `src/schema.ts`, `src/config.ts`, `schemas/dag-workflow.schema.json`.
- Test targets: `packages/dual-workflow-engine/tests/dag-schema.test.ts`.

**ANTI-PATTERNS:**
- Do not overload `transition-flow` with DAG edges; keeping `kind: 'dag'` makes semantic expectations explicit and prevents accidental cycle rejections on legal transition-flow loops.

**HANDOFF TO DOWNSTREAM:**
Provides validated `DagWorkflowDef` and topological sorting helpers to task 0100 (ready-queue scheduler).

### Plan

1. Draft ADR-034 in `docs/00_ADR.md`.
2. Define `DagWorkflowDef` in `src/types.ts` and `src/schema.ts`.
3. Create `schemas/dag-workflow.schema.json`.
4. Implement `validateDagWorkflowDef` in `src/config.ts` with cycle detection using Kahn's algorithm.
5. Add unit tests in `tests/dag-schema.test.ts` verifying valid DAGs pass and cyclic graphs fail with explicit cycle paths.

### Solution

The static DAG dialect remains defined by ADR-034 (docs/00_ADR.md:664), node/workflow types (packages/dual-workflow-engine/src/types.ts:226,238), Zod schemas (packages/dual-workflow-engine/src/schema.ts:236,250), and packaged JSON schema (packages/dual-workflow-engine/schemas/dag-workflow.schema.json:6). Validation at packages/dual-workflow-engine/src/config.ts:283 rejects duplicates, self/unknown dependencies and cycles without changing legal FSM/flow cycles. Fresh schema regressions at packages/dual-workflow-engine/tests/dag-schema.test.ts:16-145 verify this boundary. No schema production changes were needed in this re-audit.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | docs/00_ADR.md:664 specifies static DAG mode, dependency policy and cycle freedom. Fresh full gate: 2861 pass, 0 fail. |
| R2 | MET | packages/dual-workflow-engine/src/types.ts:226,238 and packages/dual-workflow-engine/src/schema.ts:236,250 declare node/workflow shapes; packages/dual-workflow-engine/schemas/dag-workflow.schema.json:6-45 requires kind/name/nodes and string dependency arrays. packages/dual-workflow-engine/tests/dag-schema.test.ts:16,22 tests minimal/full accepted inputs. Fresh full gate: 2861 pass, 0 fail. |
| R3 | MET | packages/dual-workflow-engine/src/config.ts:283-336 rejects duplicate/self/undeclared dependencies and cycles; packages/dual-workflow-engine/tests/dag-schema.test.ts:91-136 tests all error cases. Fresh full gate: 2861 pass, 0 fail. |
| R4 | MET | packages/dual-workflow-engine/src/config.ts:283 owns validation only; the scheduler lives separately at packages/dual-workflow-engine/src/dag.ts:513. Out-of-scope scheduler row satisfied by maintained boundary. Fresh full gate: 2861 pass, 0 fail. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R1 — Acyclic graph validation and dependency resolution | MET | test | packages/dual-workflow-engine/tests/dag-schema.test.ts:16-145 covers accepted schema, load, duplicate/self/undeclared dependencies and direct/indirect cycles; docs/00_ADR.md:664 freezes the dialect. Fresh full gate: 2861 pass, 0 fail. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0099

**Scope:** working tree fallback (no exact task subject tag), restricted to this task's declared source/tests plus immediate callers; source and anchors reread this run.
**Dimensions:** functional, security, efficiency, correctness, usability, architecture.
**Verdict:** PASS

##### Findings

| Priority | Dimension | Location | Finding | Disposition |
| --- | --- | --- | --- | --- |
| P4 | all | packages/dual-workflow-engine/src/dag.ts:121-600 | No open P1-P3 findings: task requirements/AC trace to real-driver tests and the fresh full gate. | ACCEPTED |

##### Functional Traceability

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | MET | docs/00_ADR.md:664 specifies static DAG mode, dependency policy and cycle freedom. |
| R2 | MET | packages/dual-workflow-engine/src/types.ts:226,238 and packages/dual-workflow-engine/src/schema.ts:236,250 declare node/workflow shapes; packages/dual-workflow-engine/schemas/dag-workflow.schema.json:6-45 requires kind/name/nodes and string dependency arrays. packages/dual-workflow-engine/tests/dag-schema.test.ts:16,22 tests minimal/full accepted inputs. |
| R3 | MET | packages/dual-workflow-engine/src/config.ts:283-336 rejects duplicate/self/undeclared dependencies and cycles; packages/dual-workflow-engine/tests/dag-schema.test.ts:91-136 tests all error cases. |
| R4 | MET | packages/dual-workflow-engine/src/config.ts:283 owns validation only; the scheduler lives separately at packages/dual-workflow-engine/src/dag.ts:513. Out-of-scope scheduler row satisfied by maintained boundary. |

##### SECUA Quality

Replay admission remains before ownership claim; both entry points share the same helper. Nodes reserve admission once, publish only durable completion, and drained errors keep their reasons. No secrets, unbounded new buffers, new dependencies, suppressions or skipped tests were introduced. Existing fail/continue and lifecycle error composition remain intact. Historical accepted observations are maintained by the design: no timeout for nonsettling work, action failures use fail-policy results, and variable collisions follow durable live completion / stable topological recovery ordering.

##### Architectural Depth

No candidates: DAG validation, scheduling, ledger recovery and lifecycle finalization retain their existing seams. No production FSM/transition-flow or adapter-contract changes; ADR-034 remains satisfied. Historical wave and snapshot-shortcut descriptions are superseded explicitly in Solution by tasks 0104/0105. Driver dryRun suppression retains the shared terminal-pause write contract; ledger writes remain separate from action effects with marked at-least-once replay, as documented in README.

**Validation:** bun run spur-check exit 0, 2861 pass / 0 fail, 58 pre / 2 post rules; all package builds exit 0. Receipts .spur/run/c3-verifyall/spur-check.log and build.log.

### References

- Feature: C3 (Static dependency DAG workflow execution mode)
- ADR-013 (RunLifecycle), ADR-034 (Static Dependency DAG)
- Dependency: 0093 (Schema conventions)

### History

- 2026-10-04T22:33:52.341Z todo → wip (system)
- 2026-10-04T22:40:08.382Z wip → testing (system)
- 2026-10-04T22:40:22.999Z testing → done (system)

