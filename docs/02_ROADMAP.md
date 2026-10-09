---
name: Roadmap
doc: 02_ROADMAP
owns: WHEN — phases, current vs deferred, sequencing
authority: derived
version: 1.4.0
derived_from: [00_ADR, 01_PRD]
owner: Robin Min
updated_at: 2026-10-09
read_before: placing work in a phase
edit_rules: 99 §6.3
sync: [T5]
---

# Roadmap

## Phases

| Phase | Status | Items | Exit criterion |
|-------|--------|-------|----------------|
| Phase 0 — Library foundation | ✅ done | Eight-package Bun workspace, lockstep releases, package boundaries | `bun run spur-check` and `bun run build` pass for every package |
| Phase 1 — Agent and observability coverage | ✅ done | Grok agent support (A1) and System Events observability (D1) | Both delivery satellites and every linked task are terminal |
| Phase 2 — Browser profile automation | ✅ done | Feature M, task 0088: dedicated headed login and later headless profile reuse | Package build, tests, and task verify PASS; consumer dogfood follows in knowledge-kit E9 |
| Phase 3 — Hosted Clef decisions | ✅ done | Feature A3, package `ts-decision-clef` (ADR-037) | Feature AC verified; canonical workspace gates and build pass |

**Status legend:** ✅ done · 🔶 partial · ⏳ planned · 💤 deferred

Future phases enter through an approved PRD scope change and feature decomposition; this file does not
invent speculative work.
