---
name: Design
doc: 04_DESIGN
owns: SURFACE — concrete shapes: every CLI command, flag, config key, env var, table, DTO; index over docs/design/
authority: derived
version: 1.3.0
derived_from: [00_ADR, 01_PRD]
owner: Robin Min
updated_at: 2026-09-20
read_before: changing a public export, config key, schema, or DTO
edit_rules: 99 §6.5
sync: [T3, T9]
---

# Design

This workspace has no product CLI or UI surface. Package source and export maps define the concrete
API; generated declarations are the compile-time contract.

## Surface index

| Surface | Status | Design document |
|---------|--------|-----------------|
| Package export maps | current | [`package-exports.md`](design/package-exports.md) |
| `DecisionMaker` (`ts-ai-runner`) | current | [`decision-maker.md`](design/decision-maker.md) |

Cross-package and platform constraints are architectural decisions in `docs/00_ADR.md`, not
duplicated here.
