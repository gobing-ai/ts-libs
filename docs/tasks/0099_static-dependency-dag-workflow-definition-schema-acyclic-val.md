---
schema_version: 1
name: Static dependency DAG workflow definition schema, acyclic validation, and ADR specification
status: todo
template: feature-impl
created_at: 2026-10-04T21:10:02.283Z
updated_at: "2026-10-04T21:28:45.858Z"
feature_id: C3
priority: P2
tags:
  - dual-workflow-engine
  - dag
  - schema
estimate_hours: 6

dependencies: ["0093"]
---

## 0099. Static dependency DAG workflow definition schema, acyclic validation, and ADR specification

### Background

Implements: R1 — Acyclic graph validation and dependency resolution.

In `ts-dual-workflow-engine`, both `state-machine` and `transition-flow` represent state transitions. While structured fork-join (Feature C2) handles parallel branch regions, general dataflow and dependency workflows need static DAG semantics: nodes declare dependencies on upstream nodes (`dependsOn: string[]`), the graph is statically validated to be strictly acyclic, and nodes are dispatched as their prerequisites complete.

This task authors ADR-034 for static DAG execution, introduces the `DagWorkflowDef` schema and types, and implements acyclic graph validation using Kahn's algorithm or Tarjan's SCC in `validateWorkflowDef`.

### Requirements

- [ ] R1. Author ADR-034 in docs/00_ADR.md specifying the static dependency DAG workflow contract, schema, and dependency resolution rules.
- [ ] R2. Define DagWorkflowDef, DagNodeDef in src/types.ts and DagWorkflowDefSchema in src/schema.ts, supporting dependsOn: string[] and dependencyPolicy ('all' | 'any').
- [ ] R3. Create schemas/dag-workflow.schema.json and wire it into workflow loading.
- [ ] R4. validateDagWorkflowDef in src/config.ts enforces that all dependsOn targets exist, rejects self-dependencies, and detects any cycles with topological sort.
- [ ] R5. Out of scope: Scheduler execution loop (owned by task 0100).

### Acceptance Criteria

- [ ] AC1 — Acyclic graph validation and dependency resolution (req: R1; req: R2; req: R3; req: R4)

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature: C3 (Static dependency DAG workflow execution mode)
- ADR-013 (RunLifecycle), ADR-034 (Static Dependency DAG)
- Dependency: 0093 (Schema conventions)

### History
