---
name: Features
doc: 05_FEATURES
owns: STATUS — feature decomposition + state; index over docs/features/
authority: derived
version: 1.6.0
derived_from: [00_ADR, 01_PRD]
owner: Robin Min
updated_at: 2026-10-09
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
| A | ts-ai-runner | ⏳ planned | [`A_ts-ai-runner.md`](features/A_ts-ai-runner.md) |
| A1 | ↳ Add Grok coding agent to ts-ai-runner | ✅ done | [`A1_add-grok-coding-agent-to-ts-ai-runner.md`](features/A1_add-grok-coding-agent-to-ts-ai-runner.md) |
| A3 | ↳ Hosted Clef decision backend (ADR-037) | ✅ done | [`A3_cloudflare-clef-decision-backend-in-ts-decision-clef.md`](features/A3_cloudflare-clef-decision-backend-in-ts-decision-clef.md) |
| B | ts-db | ⏳ planned | [`B_ts-db.md`](features/B_ts-db.md) |
| C | ts-dual-workflow-engine | ⏳ planned | [`C_ts-dual-workflow-engine.md`](features/C_ts-dual-workflow-engine.md) |
| C1 | ↳ Workflow YAML rule-style extensions | ✅ done | [`C1_workflow-yaml-rule-style-extensions.md`](features/C1_workflow-yaml-rule-style-extensions.md) |
| C2 | ↳ Durable structured fork-join parallel execution | ✅ done | [`C2_durable-structured-fork-join-parallel-execution.md`](features/C2_durable-structured-fork-join-parallel-execution.md) |
| C3 | ↳ Static dependency DAG workflow execution mode | 🔶 partial | [`C3_static-dependency-dag-workflow-execution-mode.md`](features/C3_static-dependency-dag-workflow-execution-mode.md) |
| D | ts-infra | ⏳ planned | [`D_ts-infra.md`](features/D_ts-infra.md) |
| D1 | ↳ Restore System Events observability coverage | ✅ done | [`D1_restore-system-events-observability-coverage.md`](features/D1_restore-system-events-observability-coverage.md) |
| E | ts-llm-jsonl-importer | 🔶 partial | [`E_ts-llm-jsonl-importer.md`](features/E_ts-llm-jsonl-importer.md) |
| F | ts-rule-engine | ⏳ planned | [`F_ts-rule-engine.md`](features/F_ts-rule-engine.md) |
| G | ts-runtime | ⏳ planned | [`G_ts-runtime.md`](features/G_ts-runtime.md) |
| H | ts-utils | ⏳ planned | [`H_ts-utils.md`](features/H_ts-utils.md) |
| I | Add DeepSeek dsh coding agent support | 🔶 partial | [`I_add-deepseek-dsh-coding-agent-support.md`](features/I_add-deepseek-dsh-coding-agent-support.md) |
| J | Local Laya decision backend in ts-laya-mlx | ✅ done | [`J_local-laya-decision-backend-in-ts-laya-mlx.md`](features/J_local-laya-decision-backend-in-ts-laya-mlx.md) |
| K | Apple fm on-device agent and ts-decision-fm decision backend | ✅ done | [`K_apple-fm-on-device-agent-and-ts-decision-fm-decision-backend.md`](features/K_apple-fm-on-device-agent-and-ts-decision-fm-decision-backend.md) |
| L | hardening-review-remediation | ✅ done | [`L_hardening-review-remediation.md`](features/L_hardening-review-remediation.md) |
| M | Reusable browser profile automation | ✅ done | [`M_reusable-browser-profile-automation.md`](features/M_reusable-browser-profile-automation.md) |
| N | Declarative AI decision catalog and hub in ts-ai-decision | ✅ done | [`N_declarative-ai-decision-catalog-and-hub-in-ts-ai-decision.md`](features/N_declarative-ai-decision-catalog-and-hub-in-ts-ai-decision.md) |

**Status legend:** ✅ done · 🔶 partial · ⏳ planned · 💤 deferred
