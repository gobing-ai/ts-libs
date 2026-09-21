---
schema_version: 1
name: Scaffold the ts-laya-mlx package with attribution and no weights
status: todo
template: feature-impl
created_at: 2026-09-21T03:11:42.089Z
updated_at: "2026-09-21T03:11:42.106Z"
feature_id: J
priority: P1
tags:
  - laya-mlx
  - scaffold
estimate_hours: 3

---

## 0074. Scaffold the ts-laya-mlx package with attribution and no weights

### Background

Feature J adds a second DecisionDriver as its own published package. Nothing exists under packages/laya-mlx yet, so every later task needs a manifest, a build, and a place to put source. ADR-027 fixes the name and the lockstep versioning; ADR-002/ADR-004 fix how internal dependencies and tsconfig paths are written.

### Requirements

- [ ] R1. packages/laya-mlx exists with src/, tests/, and worker/ directories and builds to dist/ under the workspace build script.
- [ ] R2. The manifest declares @gobing-ai/ts-laya-mlx at the current lockstep version with a single `.` export.
- [ ] R3. Internal dependencies on @gobing-ai/ts-ai-runner and @gobing-ai/ts-runtime are written as workspace:*, with matching tsconfig paths entries.
- [ ] R4. The package carries the Apache-2.0 licence text and a NOTICE naming the upstream project and the revision it derives from.
- [ ] R5. The `files` field publishes dist, src, worker, README.md, LICENSE and NOTICE, and no model weight artifact can enter the tarball.

### Acceptance Criteria

- [ ] AC1 — The workspace publishes ts-laya-mlx as a lockstep-versioned package (req: R1, R2, R3)
- [ ] AC2 — The published package carries upstream attribution and no weights (req: R4, R5)

`bun run build` and `bun run lint` both cover the new package with no per-package exemption.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** A new workspace package, source-only at this stage: manifest, tsconfig, build wiring, licence, NOTICE, and a placeholder entry point that exports nothing yet.

**Why this shape.** The package must exist before anything else in feature J can be written or type-checked, and its boundary decisions are the ones that are expensive to change later: the published name, the lockstep version, and `workspace:*` dependency form are all rule-enforced (ADR-002, ADR-003), and a hand-written version range here would be caught by the gate rather than by review.

**Why no engine dependency.** ADR-027 puts the engine in a host-side Python runtime driven over a process bridge, so this package has no npm dependency that executes a model. `dependencies` is exactly the two workspace siblings. Anything else appearing here later is a signal the design drifted.

**Attribution.** The vendored reference is Apache-2.0 with a NOTICE crediting the upstream project; clause 4(d) obliges carrying that NOTICE forward into anything derived from it. Weights are fetched at runtime and never redistributed, which keeps the tarball small and the licensing question confined to source.

### Plan

1. Create packages/laya-mlx with src/, tests/, worker/ and the standard package layout.
2. Write package.json: name, lockstep version, `.` export, workspace:* dependencies, files, publish config.
3. Add tsconfig with paths resolving both sibling packages to source (ADR-004).
4. Copy the Apache-2.0 LICENSE and write NOTICE naming the upstream project and source revision.
5. Add a placeholder src/index.ts so build and typecheck pass on an empty surface.
6. Confirm the package is picked up by the workspace build, lint, and typecheck scripts.
7. Pack locally and confirm the tarball contents match the files field and carry no weights.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
