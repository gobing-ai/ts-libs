---
name: "A1: Injectable RuntimePaths seam for cwd/home portability"
description: "A1: Injectable RuntimePaths seam for cwd/home portability"
status: Backlog
created_at: 2026-07-11T06:07:44.535Z
updated_at: 2026-07-11T06:07:44.535Z
folder: docs/tasks
type: task
feature-id: ""
priority: P2
estimated_hours: 6
dependencies: ["0041"]
tags: ["adr","runtime","portability","advisory"]
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0042. "A1: Injectable RuntimePaths seam for cwd/home portability"

### Background

ADR-023 advisory candidate A1 from codex review (task 0041). ts-runtime currently anchors to ambient cwd/home via process.cwd()/os.homedir(). Make RuntimePaths injectable so consumers stop reaching for ambient state and the importer roots resolve against home consistently.


### Requirements

1. Define a RuntimePaths interface (cwd: string, home: string) in ts-runtime. 2. createNodeFileSystem() and ProcessExecutor accept RuntimePaths via DI (defaulting to ambient). 3. Importer source resolution roots against home, not ambient cwd. 4. No breaking changes to existing public APIs — additive only. 5. Tests: injected paths used; defaults match ambient behavior.


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


