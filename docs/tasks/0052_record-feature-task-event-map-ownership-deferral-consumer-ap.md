---
template: meta
schema_version: 1
name: "Record feature.* / task.* event-map ownership deferral (consumer app owns)"
description: ""
status: cancelled
type: meta
profile: standard
feature_id: A
parent_wbs: null
priority: P2
tags: ["meta"]
dependencies: []
created_at: "2026-07-12T23:56:02.754Z"
updated_at: "2026-07-13T00:13:18.181Z"
---

## 0052. Record feature.* / task.* event-map ownership deferral (consumer app owns)

### Background
Companion to 0049. Grep across `packages/` found **zero** typed event maps or emit keys for
`feature.*` / `task.*`. Those prefixes belong to the product-management / spur CLI surface
(file-based feature and task corpora), not to the `ts-libs` runtime event-bus graph.

This meta task records the ownership decision so the System Events diagnosis is complete
without inventing in-repo emitters that have no runtime owner today.
### Requirements
- [ ] R1. Record in `docs/00_ADR.md` (short addendum under the observability / EventBus family, or a one-paragraph cross-link from ADR-013 addendum) that `feature.*` / `task.*` lifecycle events are **out of scope for ts-libs** and owned by the consumer app / spur product surface.
- [ ] R2. Keep the note code-free: no `FeatureEvents` / `TaskEvents` maps, no emitters, no `lifecycleBus` wiring in this repo for those prefixes.
- [ ] R3. If the operator later decides those maps belong in `ts-libs`, replace this deferral with a new implementation task — do not silently expand 0050/0051.
### Acceptance Criteria
```gherkin
Feature: feature.* / task.* ownership deferral

  @core
  Scenario: 0052-R1 — ADR records consumer ownership
    Given feature.* and task.* have no event maps in packages/
    When the ADR note from this task is read
    Then it states those prefixes are owned by the consumer app / spur surface
    And it explicitly defers in-repo FeatureEvents / TaskEvents

  @core
  Scenario: 0052-R2 — No code invents the maps
    Given this task is Done
    When packages/ is grepped for FeatureEvents or TaskEvents
    Then no new maps were added solely to satisfy the System Events tabview
```
### Q&A

<!-- Clarifications and decisions made during refinement. Keep empty if none. -->

### Design
**Ownership boundary**

| Prefix | Exists in ts-libs today? | Owner |
|--------|--------------------------|--------|
| `feature.*` | No typed map / no emits | Consumer app / spur CLI |
| `task.*` | No typed map / no emits | Consumer app / spur CLI |

**Why not in 0050?** Wiring `lifecycleBus` only helps prefixes that already emit on an
`EventBus`. Inventing maps without a producer is noise. 0050/0051 close real missing
telemetry; this task closes the documentation gap only.

**ADR touchpoint:** ADR-013 addendum (observability seam) is the natural home for a
one-paragraph "not every prefix is a library concern" note; avoid a full new ADR unless
the operator wants a broader product-vs-library boundary decision.
### Plan
1. Draft a short ADR note (or ADR-013 addendum paragraph) stating `feature.*` / `task.*`
   are consumer-owned and intentionally absent from ts-libs event maps.
2. Land the note in `docs/00_ADR.md` with a dated entry; link back to task 0049.
3. No package code changes; `bun run spur-check` stays green with docs-only diff.
4. Mark this task done after the ADR paragraph is merged.
### Solution

<!-- Filled during implementation: changed files/sections and concise rationale. -->

### Testing

<!-- Filled during verification: commands/checks run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to docs, tasks, decisions, or external references. -->

### History
- 2026-07-13T00:13:18.181Z todo → cancelled (system)
