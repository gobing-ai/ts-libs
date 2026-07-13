---
template: feature-impl
schema_version: 1
name: "Add lifecycle-bus-propagation architecture rule"
description: ""
status: todo
type: task
profile: standard
feature_id: B
parent_wbs: null
priority: P2
tags: []
dependencies: []
created_at: "2026-07-13T03:54:37.571Z"
updated_at: "2026-07-13T05:11:07.306Z"
---

## 0053. Add lifecycle-bus-propagation architecture rule

### Background



### Requirements
- [ ] R1. Add a `lifecycle-bus-propagation` rule under `.spur/rules/` that detects consumer-facing `events?: EventBus<XEvents>` APIs without a corresponding lifecycle-bus propagation path.
- [ ] R2. Cover compliant and non-compliant fixtures so the rule proves both detection and false-positive behavior.
- [ ] R3. Register the rule in the appropriate recommended preset only after it passes the existing repository sources.
- [ ] R4. Keep the rule structural and package-agnostic; do not hard-code the current package list.
### Acceptance Criteria
```gherkin
Feature: Enforce lifecycle bus propagation at EventBus API boundaries

  @core
  Scenario: Missing lifecycle propagation is rejected
    Given a TypeScript options API that declares events?: EventBus<XEvents>
    And no lifecycleBus option or constructor-injected propagation path exists
    When the lifecycle-bus-propagation rule runs
    Then it reports an actionable finding at that API boundary

  @core
  Scenario: Correct lifecycle propagation passes
    Given an events API that accepts lifecycleBus and parents its internal EventBus to it
    When the lifecycle-bus-propagation rule runs
    Then no finding is reported
```
### Q&A

<!-- Clarifications and decisions made during refinement. Keep empty if none. -->

### Design
Implement this as a dedicated Spur architecture rule with focused fixtures. Match the API shape and propagation behavior rather than package names. First prove the matcher against isolated compliant/non-compliant fixtures, then run it across the monorepo and add it to the recommended preset only when the existing sources are clean. This task is the explicit R8 deferral from 0050 because reliable cross-node AST/data-flow matching is non-trivial and should not be improvised inside feature verification.
### Plan
1. Survey existing `.spur/rules/` AST and architectural rule patterns.
2. Implement `lifecycle-bus-propagation` with actionable evidence and remediation text.
3. Add compliant and non-compliant rule fixtures/tests.
4. Run the rule against all workspace packages and fix matcher false positives.
5. Register it in the recommended preset and run `bun run spur-check` plus `bun run build`.
### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

A

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
