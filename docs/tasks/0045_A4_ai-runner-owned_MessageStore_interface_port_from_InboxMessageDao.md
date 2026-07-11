---
name: "A4: ai-runner-owned MessageStore interface port from InboxMessageDao"
description: "A4: ai-runner-owned MessageStore interface port from InboxMessageDao"
status: Backlog
created_at: 2026-07-11T06:08:05.269Z
updated_at: 2026-07-11T06:08:05.269Z
folder: docs/tasks
type: task
feature-id: ""
priority: P3
estimated_hours: 5
dependencies: ["0041","0040"]
tags: ["adr","ai-runner","ts-db","advisory"]
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0045. "A4: ai-runner-owned MessageStore interface port from InboxMessageDao"

### Background

ADR-023 advisory candidate A4 from codex review (task 0041). ai-runner's team-orchestrator uses 4-5 methods from InboxMessageDao (ts-db). Define a MessageStore interface owned by ts-ai-runner that InboxMessageDao satisfies structurally, loosening ts-db coupling consistent with the ts-db-as-optional-peer direction (task 0040).


### Requirements

1. Define MessageStore interface in ts-ai-runner with the 4-5 methods team-orchestrator actually uses. 2. InboxMessageDao satisfies MessageStore structurally (no changes to ts-db). 3. team-orchestrator depends on MessageStore, not InboxMessageDao. 4. ts-ai-runner no longer imports ts-db types directly for message access. 5. Tests: team-orchestrator works with any MessageStore implementation; InboxMessageDao passes structural check.


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


