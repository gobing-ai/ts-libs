---
schema_version: 1
name: "Add grok AgentShim and registry membership"
status: done
template: feature-impl
created_at: 2026-07-12T07:32:35.011Z
updated_at: "2026-07-12T07:38:55.371Z"
feature_id: A
priority: P1
tags: ["ai-runner", "grok", "shim"]
---

## 0046. Add grok AgentShim and registry membership

### Background

Register Grok Build CLI as a tier-1 coding agent in packages/ai-runner, following hermes/omp patterns. CLI surface verified from `grok --help` and headless docs (v0.2.93): `-p`/`--single`, `-c`/`--continue`, `-m`/`--model`, `--output-format plain|json`, `--version`/`--help`. Map ai-runner OutputMode `text` → `plain` (Grok has no `text` format).

### Requirements

R1. isAgentName("grok") and resolveAgentName("grok") accept and resolve to canonical id "grok".
R2. getPromptCommand maps input/continue/model/mode to grok argv (-p, -c, -m, --output-format plain|json).
R3. getHelpCommand is grok --help; getVersionCommand is grok --version.
R8. mode text never emits --output-format text (must be plain).
R9. getAuthCommand returns null.

### Acceptance Criteria
```gherkin
Feature: Add Grok coding agent to ts-ai-runner

  @core
  Scenario: R1 — grok is a known canonical agent id
    Given the ts-ai-runner agent registry
    When the caller checks isAgentName("grok") and resolveAgentName("grok")
    Then both accept grok and resolve to the canonical id "grok"

  @core
  Scenario: R2 — prompt command maps PromptOptions to grok headless argv
    Given the grok AgentShim
    When getPromptCommand is called with input, optional continue, model, and mode
    Then the command is "grok" with args using -p for input, -c when continue, -m for model, and --output-format plain for text or json for json

  @core
  Scenario: R3 — help and version commands target the grok binary
    Given the grok AgentShim
    When getHelpCommand and getVersionCommand are built
    Then they are grok --help and grok --version respectively

  @edge
  Scenario: R8 — text mode never passes --output-format text
    Given the grok AgentShim and mode "text" (the ai-runner default)
    When getPromptCommand builds argv
    Then args include --output-format and plain and do not include the bare value text as the format

  @edge
  Scenario: R9 — getAuthCommand is null so doctor does not require a CLI auth verb
    Given the grok AgentShim
    When getAuthCommand is called
    Then the result is null and doctor still reports usable when the binary is installed
```
### Q&A

<!-- Open questions and their resolutions. Delete if none. -->

### Design

<!-- Decision record — WHAT/WHY. Chosen approach + 1-line reason, rejected alternatives, key signatures (not bodies), invariants. ≤2 illustrative snippets MAX. -->

### Plan

<!-- Ordered checklist or table of implementation steps (not prose). The how-to-execute order within this one task. -->

### Solution
Change map — HOW/WHERE for the grok AgentShim registration.

| Change (`file:line`) | What / why |
|----------------------|------------|
| `packages/ai-runner/src/agents/shims.ts:14` | Extend `AgentName` with canonical id `grok`. |
| `packages/ai-runner/src/agents/shims.ts:242` | Add `grokShim`: binary `grok`, tier 1; `-p`/`-c`/`-m`; map mode `text`→`--output-format plain`, `json`→`json`; help/version; `getAuthCommand() → null`. |
| `packages/ai-runner/src/agents/shims.ts:271` | Register `grok` in `AGENT_SHIMS`. |
| `packages/ai-runner/src/agents/shims.ts:283` | Append `grok` to `TIER1_PRIORITY` (end — does not reorder preferred agents). |
| `packages/ai-runner/src/agents/shims.ts:297` | Append `grok` to `DISPLAY_ORDER`. |
| `packages/ai-runner/tests/agents/shims.test.ts:25` | R1: `isAgentName('grok')` / resolve coverage. |
| `packages/ai-runner/tests/agents/shims.test.ts:177` | R2–R3, R8–R9: argv mapping, help/version, no bare `text` format, auth null. |

**Deferred (not this task):** env/file auth + detector/doctor → **0047**; README → **0048**.
### Testing
**Verdict: PASS** — re-certified 2026-07-12 via `/sp:dev-run 0046 --auto --next` (implement idempotent — already shipped).

**Coverage:** `bun test packages/ai-runner` — **131 pass / 0 fail**; shims suite **18 pass / 0 fail**.

**Per-requirement traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `isAgentName('grok')` / `resolveAgentName('grok')` — `shims.ts:14`; `shims.test.ts:25`, `:93` |
| R2 | MET | `getPromptCommand` `-p`/`-c`/`-m`/`--output-format` — `shims.ts:248-255`; `shims.test.ts:177-189` |
| R3 | MET | `grok --help` / `grok --version` — `shims.ts:246-247`; `:197-198` |
| R8 | MET | mode `text` → `plain`, never bare `text` — `shims.ts:251-253`; `:190-194` |
| R9 | MET | `getAuthCommand() → null` — `shims.ts:256`; `:195-196` |

**Acceptance criteria** — all five scenarios MET (same unit evidence as R1–R3, R8–R9).

**Gate evidence (fresh this turn)**

- `bun test packages/ai-runner` → **131 pass / 0 fail**
- `bunx tsc --noEmit -p packages/ai-runner/tsconfig.json` → **exit 0**
### Review

**Verdict:** PASS — re-run via `/sp:dev-run 0046 --auto --next` (2026-07-12). Implementation already complete; this pass backfills Review (required at `done`) and re-certifies evidence.

**Scope:** `packages/ai-runner/src/agents/shims.ts` + `tests/agents/shims.test.ts` only (R1–R3, R8–R9). Auth/doctor/README owned by 0047/0048.

**Gate (fresh this turn):** `bun test packages/ai-runner` → **131 pass / 0 fail**; shims.test.ts **18 pass / 0 fail**. `tsc --noEmit` clean for package.


| Dim | Result | Notes |
|-----|--------|-------|
| Security | OK | No credentials; `getAuthCommand` null (auth deferred to 0047 env/file). |
| Efficiency | OK | Pure command builders; O(1) registry lookup. |
| Correctness | OK | Argv matches `grok --help` / headless docs; `text`→`plain` mapping covered by unit test. |
| Usability | OK | Tier-1; appended to `TIER1_PRIORITY`/`DISPLAY_ORDER` without reordering preferred agents. |
| Architecture | OK | Follows existing `AgentShim` pattern (hermes/omp); no new boundaries. |


No P1–P3 findings in task scope.

| # | Sev | Dim | Location | Note |
|---|-----|-----|----------|------|
| 1 | P4 | Usability | `shims.ts` grokShim | Advanced flags (sandbox, worktree, best-of-n) not mapped — out of scope until `PromptOptions` grows. |


- [x] **R1** `isAgentName`/`resolveAgentName('grok')` → MET — `shims.ts:14`, tests
- [x] **R2** prompt argv `-p`/`-c`/`-m`/`--output-format` → MET — `shims.ts:248-255`
- [x] **R3** help/version → MET — `shims.ts:246-247`
- [x] **R8** mode `text` never emits format `text` → MET — maps to `plain`
- [x] **R9** `getAuthCommand() → null` → MET — `shims.ts:256`

### History
- 2026-07-12T07:34:49.586Z todo → wip (system)
- 2026-07-12T07:34:59.098Z wip → testing (system)
- 2026-07-12T07:35:37.612Z testing → done (system)
