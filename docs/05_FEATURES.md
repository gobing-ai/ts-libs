---
name: Features
doc: 05_FEATURES
owns: STATUS — feature decomposition + state; index over docs/features/
authority: derived
version: 1.0.0
derived_from: [00_ADR, 01_PRD]
owner: Robin Min
updated_at: 2026-08-12
read_before: finding a feature's state
edit_rules: 99 §6.6
sync: [T4, T9]
---

# Features

Feature satellites are owned by `spur feature`. The generated, authoritative roster is
[`docs/features/INDEX.md`](features/INDEX.md); refresh it with `spur feature refresh` after satellite changes.

## Feature summary

| ID | Feature | Status | Satellite |
|----|---------|--------|-----------|
| A | Add Grok coding agent to ts-ai-runner | ✅ done | [`A_add-grok-coding-agent-to-ts-ai-runner.md`](features/A_add-grok-coding-agent-to-ts-ai-runner.md) |
| B | Restore System Events observability coverage | ✅ done | [`B_restore-system-events-observability-coverage.md`](features/B_restore-system-events-observability-coverage.md) |

**Status legend:** ✅ done · 🔶 partial · ⏳ planned · 💤 deferred
