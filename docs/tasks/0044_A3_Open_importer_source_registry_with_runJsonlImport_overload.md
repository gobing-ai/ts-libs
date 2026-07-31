---
schema_version: 1
name: "A3: Open importer source registry with runJsonlImport overload"
status: backlog
type: task
priority: P3
tags: [adr,llm-jsonl-importer,advisory]
dependencies: ["0041"]
created_at: 2026-07-11T06:07:57.882Z
updated_at: 2026-07-11T06:07:57.882Z
---

## 0044. "A3: Open importer source registry with runJsonlImport overload"

### Background

ADR-023 advisory candidate A3 from codex review (task 0041). The JSONL importer currently has a closed source registry (SOURCE_DEFINITIONS). Open it with a runJsonlImport(source | SourceDefinition, ...) overload so callers can register custom source definitions. VALID_TABLE_NAME + schema validation already fence custom definitions.


### Requirements

1. Add SourceDefinition type to ts-llm-jsonl-importer public exports. 2. Add runJsonlImport(source | SourceDefinition, ...) overload — accepts either a known source name or a custom SourceDefinition. 3. VALID_TABLE_NAME and schema validation apply to custom definitions. 4. Existing runJsonlImport(sourceName, ...) calls unchanged. 5. Tests: custom source definition imports correctly; invalid table name rejected; schema mismatch rejected.


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




### History

- Migrated from legacy format (2026-07-31)
