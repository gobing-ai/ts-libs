---
schema_version: 1
name: Document the package surface against the hosted SDK reference
status: todo
template: feature-impl
created_at: 2026-09-21T03:11:42.102Z
updated_at: "2026-09-21T03:11:56.595Z"
feature_id: J
priority: P2
tags:
  - laya-mlx
  - docs
estimate_hours: 3

dependencies: ["0080", "0081"]
---

## 0082. Document the package surface against the hosted SDK reference

### Background

I4 makes the TypeSafe JavaScript SDK API reference the contract of record for the external surface, and I3 promises a downstream user can replace one backend with the other. A reader deciding whether to switch needs to see the two surfaces side by side, including where they deliberately differ.

### Requirements

- [ ] R1. The README lists every exported factory, option, and answer field beside the hosted counterpart it mirrors.
- [ ] R2. Each intentional divergence is named together with its reason.
- [ ] R3. The host prerequisites, the supported runtime version range, and the install command are stated.
- [ ] R4. The backend-selection ergonomic is shown from the caller's side, for both names.
- [ ] R5. The worker protocol is documented well enough to debug by hand.
- [ ] R6. Attribution to the upstream project and the derived revision is present and matches the NOTICE.

### Acceptance Criteria

- [ ] AC1 — The package documentation maps its surface onto the hosted SDK reference (req: R1, R2)

Prerequisites, selection examples, protocol notes, and attribution are additionally present (R3, R4, R5, R6).

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** The package README, written as a substitution guide rather than a feature tour.

**Why a mapping table.** The question a reader arrives with is whether their existing code keeps working. A table from hosted surface to local surface answers that directly, and its gaps are the answer to the follow-up question — what changes. Prose describing the local surface on its own terms would make the reader do that diff themselves.

**Why divergences are named with reasons.** There are only a few, and each is deliberate: the dropped noul confidence, the absent action probability, the host prerequisites, the platform lock. A reader who finds one undocumented reasonably concludes it is a bug and files it. Naming them converts each from a surprise into a decision they can evaluate.

**Why prerequisites are prominent.** This is the only package in the workspace that will not work on an arbitrary host. Burying that below the usage example wastes the reader's time and produces avoidable support traffic.

**Why document the protocol.** The worker is a published file a maintainer can drive from a terminal, and the fastest diagnosis of a misbehaving bridge is to speak to it directly. Documenting it costs a short section and removes the need to read the source to do that.

### Plan

1. Draft the substitution table: hosted surface against local surface, field by field.
2. Write the divergence section, one entry per deliberate difference with its reason.
3. Write the prerequisites section with the version range and install command, above the usage example.
4. Show backend selection from the caller's side for both names.
5. Document the worker protocol with a hand-drivable example.
6. Add the attribution section and confirm it matches the NOTICE.
7. Add the package to the design index and confirm the cross-links resolve.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
