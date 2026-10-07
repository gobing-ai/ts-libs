---
schema_version: 1
name: Residuals from 0107
status: backlog
template: standard
created_at: 2026-10-07T20:04:50.834Z
updated_at: "2026-10-07T20:04:51.518Z"

---

## 0108. Residuals from 0107

### Background

Source task: 0107 (feature A) — deferred residuals filed by residual-scan settle (unlinked: a deferral must not hold the completing feature open).

- review-finding:3c7b8f11 — docs/tasks/0107 task file AC table: Cell "mass 1.0000001 rejected" contradicts R1's inclusive <=1e-6 contract (1.0000001 is 1e-7 off = inside); R1 + Q&A freeze are authoritative
- review-finding:2cfa7a4e — packages/ai-runner/tests/decision/validation.test.ts: Under-side inclusive boundary (sum = 1-1e-6 as computed number) not directly probed; decimal 0.999999 is 1 ulp outside the raw bound and serves as the under-side rejection probe

### Requirements

<!-- One R-item per line, exactly `- [ ] R1. <text>` (checkbox + `R<n>.`); `spur task check` flags any other form. Keep empty until requirements are known. -->

### Acceptance Criteria

<!-- Number items AC1, AC2, … (never R<n> — that is the Requirements namespace). Preferred: `Scenario: AC1 — <concrete outcome> (req: R1)` blocks with Given/When/Then, declaring both `ac_altitude: task-local` and `ac_numbering: task-local` for task-local regression criteria (altitude skips only the feature-subset check; numbering makes `(req: R<n>)` count toward requirement coverage). Parsed checkbox rows `- [ ] AC1 — <title>` are supported but never bind requirements — only `Scenario:` titles read `(req: R<n>)`. Bare `- AC1` bullets are legacy unparsed records, not a traceability bypass. Requirements use `- [ ] R1. <text>`, checked at close. Keep empty if this task has no objective AC yet. -->

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

<!-- Chosen approach, key tradeoffs, invariants, and impacted surfaces. Keep snippets short. -->

### Plan

<!-- Ordered implementation checklist. Fill before moving to todo/wip. -->

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to features, docs, ADRs, related tasks, or external references. -->

### History
