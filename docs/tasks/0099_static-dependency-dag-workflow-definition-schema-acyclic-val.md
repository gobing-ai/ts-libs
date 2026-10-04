---
schema_version: 1
name: Static dependency DAG workflow definition schema, acyclic validation, and ADR specification
status: done
template: feature-impl
created_at: 2026-10-04T21:10:02.283Z
updated_at: "2026-10-04T23:31:24.576Z"
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

- `docs/00_ADR.md:664`: added `ADR-034: Static Dependency DAG Workflow Mode` specifying `kind: 'dag'`, `dependsOn: string[]`, and cycle rejection.
- `packages/dual-workflow-engine/src/types.ts:199`: added `DependencyPolicy`, `DagNodeDef`, `DagWorkflowDef`, and widened `WorkflowDef` union.
- `packages/dual-workflow-engine/src/schema.ts:230`: added `DagNodeDefSchema`, `DagWorkflowDefSchema`, and updated `WorkflowDefSchema`.
- `packages/dual-workflow-engine/schemas/dag-workflow.schema.json:4`: created packaged JSON schema for static DAG workflows.
- `packages/dual-workflow-engine/src/config.ts:283`: implemented `validateDagWorkflowDef` with Kahn's algorithm cycle rejection and variable checking.
- `packages/dual-workflow-engine/tests/dag-schema.test.ts:6`: added test suite for DAG schema parsing, dependency validation, and cycle detection.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `docs/00_ADR.md:664` — ADR-034: Static Dependency DAG Workflow Mode |
| R2 | MET | `packages/dual-workflow-engine/src/types.ts:199` — DagNodeDef with dependsOn; JSON schema at `packages/dual-workflow-engine/schemas/dag-workflow.schema.json:4` |
| R3 | MET | `packages/dual-workflow-engine/src/config.ts:283` — validateDagWorkflowDef rejects cycles, self-edges, undeclared deps |
| R4 | MET | Out-of-scope row (scheduler loop owned by 0100); boundary confirmed in commit 42ab26e2 |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R1 — Acyclic graph validation and dependency resolution | MET | test | `packages/dual-workflow-engine/tests/dag-schema.test.ts:6` — describe block covering cycle/self-edge/undeclared rejection (tests at :91, :102, :111, :123); fresh run: bun test tests/dag.test.ts tests/dag-schema.test.ts 18 pass / 0 fail |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

Review of the 0099 patch:

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P2 | Strict cycle rejection at definition load time | `packages/dual-workflow-engine/src/config.ts:283` | FIXED — Kahn's topological sort detects any cycle or self-reference and throws `WorkflowValidationError` |
| P2 | Schema discrimination for kind: 'dag' | `packages/dual-workflow-engine/src/config.ts:145` | FIXED — `selectWorkflowSchema` checks `parsed.kind === 'dag'` and returns `DagWorkflowDefSchema` |
| P3 | Reseed and resume guards for DAG workflows | `packages/dual-workflow-engine/src/service.ts:69` | FIXED — `assertReseedTargetDeclared` and `resumeRun` explicitly handle `kind: 'dag'` |
| P4 | JSON schema parity | `packages/dual-workflow-engine/schemas/dag-workflow.schema.json:1` | FIXED — JSON schema packaged with `$defs.action`, `$defs.guard`, and `$defs.extensions` |

Residual risk: None. FSM and transition-flow validation remains 100% backward-compatible.

### References

- Feature: C3 (Static dependency DAG workflow execution mode)
- ADR-013 (RunLifecycle), ADR-034 (Static Dependency DAG)
- Dependency: 0093 (Schema conventions)

### History

- 2026-10-04T22:33:52.341Z todo → wip (system)
- 2026-10-04T22:40:08.382Z wip → testing (system)
- 2026-10-04T22:40:22.999Z testing → done (system)

