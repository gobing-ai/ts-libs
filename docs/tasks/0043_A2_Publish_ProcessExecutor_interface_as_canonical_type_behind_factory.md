---
name: "A2: Publish ProcessExecutor interface as canonical type behind factory"
description: "A2: Publish ProcessExecutor interface as canonical type behind factory"
status: Backlog
created_at: 2026-07-11T06:07:50.997Z
updated_at: 2026-07-11T06:07:50.997Z
folder: docs/tasks
type: task
feature-id: ""
priority: P2
estimated_hours: 4
dependencies: ["0041"]
tags: ["adr","runtime","interface","advisory"]
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0043. "A2: Publish ProcessExecutor interface as canonical type behind factory"

### Background

ADR-023 advisory candidate A2 from codex review (task 0041). ProcessExecutor is currently a concrete class; consumers already accept injection everywhere, so publishing the interface as canonical and making concrete classes default wiring behind a factory is mostly a type-level change.


### Requirements

1. Extract and publish the ProcessExecutor interface as the canonical exported type. 2. Concrete classes (NodeProcessExecutor, etc.) become default wiring behind a factory function. 3. All consumers import the interface type, not the concrete class. 4. No behavioral changes — pure type-level refactor. 5. Tests: existing tests pass unchanged; new test verifying factory returns interface type.


### Q&A



### Design



### Solution



### Plan



### Review



### Testing



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


