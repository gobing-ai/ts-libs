---
schema_version: 1
name: Validate host prerequisites and translate failures into the decision taxonomy
status: todo
template: feature-impl
created_at: 2026-09-21T03:11:42.097Z
updated_at: "2026-09-21T03:11:55.486Z"
feature_id: J
priority: P1
tags:
  - laya-mlx
  - errors
  - prerequisites
estimate_hours: 5

dependencies: ["0076"]
---

## 0077. Validate host prerequisites and translate failures into the decision taxonomy

### Background

This package is platform-locked and depends on a host-side runtime it does not install. Those constraints become support burden unless they are reported precisely. ai-runner already owns a seven-class decision error taxonomy shipped with the TypeSafe driver; the local driver reuses it rather than inventing local error types.

### Requirements

- [ ] R1. An unsupported platform is refused with a configuration error naming the platform requirement, before any process is spawned.
- [ ] R2. A missing interpreter, or a present interpreter that cannot import the runtime, is reported as a configuration error naming the missing piece and the command that installs it.
- [ ] R3. No raw process-spawn message reaches the caller.
- [ ] R4. Worker error kinds map to the taxonomy: config to DecisionConfigError, request to DecisionRequestError, backend to DecisionBackendError.
- [ ] R5. Non-finite model output is reported as a decision error naming the precision problem, and no answer containing a non-finite probability is returned.
- [ ] R6. Credential and transport failures during artifact resolution surface as DecisionAuthError and DecisionConnectionError respectively.
- [ ] R7. Both timeout paths surface as DecisionTimeoutError.

### Acceptance Criteria

- [ ] AC1 — Local failures surface through the existing decision error taxonomy (req: R4, R6, R7)
- [ ] AC2 — Missing host prerequisites are reported before any decision is attempted (req: R2, R3)
- [ ] AC3 — An unsupported platform is refused at construction rather than at inference (req: R1)
- [ ] AC4 — Non-finite model output is reported instead of being returned as an answer (req: R5)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** The construction-time prerequisite checks and the single translation point from worker failures to the decision error taxonomy.

**Why check the platform before spawning.** An unsupported host produces a confusing failure if it is discovered by a process that fails to start — the message describes a missing binary rather than the real constraint. Checking first turns a support question into a sentence the caller can act on.

**Why the install command is part of the message.** The one prerequisite this package cannot satisfy for the user is the host runtime. A configuration error that names the missing distribution without saying how to get it converts directly into a support request; naming the command is the cheapest possible documentation, delivered at the moment it is needed.

**Why reuse the existing taxonomy.** The whole premise of feature J is that a caller can swap backends without editing a call site. Code that catches DecisionAuthError around a hosted call must keep working when the local backend is selected. Introducing local error classes would break exactly the substitutability the feature exists to prove.

**Why one translation point.** Scattering error construction across the lifecycle, protocol, and mapping layers would make the taxonomy a convention rather than a guarantee. A single translator keeps every failure path auditable and gives the tests one surface to enumerate against.

**On the non-finite path.** The runtime raises on non-finite outputs rather than returning them, and it names the precision remedy. That message is worth preserving through the translation rather than flattening, because the actionable part is the dtype, not the fact of failure.

### Plan

1. Write the platform check and the interpreter resolution order: explicit option, environment key, then the default on PATH.
2. Build the configuration errors for each prerequisite, each naming the requirement and the command that satisfies it.
3. Detect a failed import of the runtime from the worker's startup behaviour and report it as configuration, not backend.
4. Write the translator from worker error kinds to the taxonomy classes.
5. Map the two timeout paths and the worker-exit path onto their classes.
6. Map artifact credential and transport failures onto DecisionAuthError and DecisionConnectionError.
7. Enumerate every branch in tests against a stub process, asserting class and message content.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
