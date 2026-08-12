---
name: Roadmap
doc: 02_ROADMAP
owns: WHEN — phases, current vs deferred, sequencing
authority: derived
version: 1.1.0
derived_from: [00_ADR, 01_PRD]
owner: Robin Min
updated_at: 2026-08-12
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

**Status legend:** ✅ done · 🔶 partial · ⏳ planned · 💤 deferred

Future phases enter through an approved PRD scope change and feature decomposition; this file does not
invent speculative work.
