---
name: Design
doc: 04_DESIGN
owns: SURFACE — concrete shapes: every CLI command, flag, config key, env var, table, DTO; index over docs/design/
authority: derived
version: 1.0.0
derived_from: [00_ADR, 01_PRD]
owner: Robin Min
updated_at: 2026-08-12
read_before: changing a public export, config key, schema, or DTO
edit_rules: 99 §6.5
sync: [T3, T9]
---

# Design

This workspace has no product CLI, UI surface, or current `docs/design/` satellites. Package source and
export maps define the concrete API; generated declarations are the compile-time contract.

## Current surface references

| Package | Detailed surface |
|---------|------------------|
| `@gobing-ai/ts-utils` | [`packages/utils/README.md`](../packages/utils/README.md) |
| `@gobing-ai/ts-runtime` | [`packages/runtime/README.md`](../packages/runtime/README.md) |
| `@gobing-ai/ts-db` | [`packages/db/README.md`](../packages/db/README.md) |
| `@gobing-ai/ts-infra` | [`packages/infra/README.md`](../packages/infra/README.md) |
| `@gobing-ai/ts-ai-runner` | [`packages/ai-runner/README.md`](../packages/ai-runner/README.md) |
| `@gobing-ai/ts-rule-engine` | [`packages/rule-engine/README.md`](../packages/rule-engine/README.md) |
| `@gobing-ai/ts-dual-workflow-engine` | [`packages/dual-workflow-engine/README.md`](../packages/dual-workflow-engine/README.md) |
| `@gobing-ai/ts-llm-jsonl-importer` | [`packages/llm-jsonl-importer/README.md`](../packages/llm-jsonl-importer/README.md) |

Public entry points are the `exports` maps in each package's `package.json`. Cross-package and platform
constraints are architectural decisions in `docs/00_ADR.md`, not duplicated here.
