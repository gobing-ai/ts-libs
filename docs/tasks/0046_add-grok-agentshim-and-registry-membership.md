---
template: feature-impl
schema_version: 1
name: Add grok AgentShim and registry membership
status: done
type: task
feature_id: A1
priority: P1
tags: [ai-runner,grok,shim]
created_at: 2026-07-12T07:32:35.011Z
updated_at: "2026-08-12T14:40:50.744Z"
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
**Verdict: PASS** — `/sp:dev-verify 0046 --focus all --fix all --auto --force` (2026-07-12).

**Coverage:** `bun test packages/ai-runner` — **131 pass / 0 fail**. `biome check` on shims + tests clean. `tsc --noEmit` clean.

**Per-requirement traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `isAgentName('grok')` / `resolveAgentName('grok')` → `true`/`'grok'`; `shims.ts:14`, `AGENT_SHIMS.grok`; tests `shims.test.ts:25`, `:93`; runtime smoke this pass |
| R2 | MET | `getPromptCommand` → `-p`, optional `-c`, `-m`, `--output-format plain\|json`; `shims.ts:248-255`; `shims.test.ts:177-189`; runtime smoke confirms argv |
| R3 | MET | `getHelpCommand` → `grok --help`, `getVersionCommand` → `grok --version`; `shims.ts:246-247`; tests + runtime smoke |
| R8 | MET | mode `text` → `--output-format plain`, args never contain bare format `text`; `shims.ts:252-254`; `shims.test.ts:190-194` |
| R9 | MET | `getAuthCommand() → null`; `shims.ts:257`; test `:195-196`. Doctor liveness-only usable for null-auth agents is existing design (antigravity path); binary install detection is version exit-0 (0047/doctor suite). |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| Scenario: R1 — grok is a known canonical agent id | MET | test | `shims.test.ts` isAgentName/resolve + runtime smoke |
| Scenario: R2 — prompt command maps PromptOptions to grok headless argv | MET | test | `shims.test.ts` argv equality + runtime smoke |
| Scenario: R3 — help and version commands target the grok binary | MET | test | `shims.test.ts` + runtime smoke |
| Scenario: R8 — text mode never passes --output-format text | MET | test | `not.toContain('text')` + plain |
| Scenario: R9 — getAuthCommand is null so doctor does not require a CLI auth verb | MET | test | `toBeNull()`; doctor null-auth usable is shared path |

**Gate evidence (fresh this turn)**

- `bun test packages/ai-runner` → **131 pass / 0 fail**
- `bunx tsc --noEmit -p packages/ai-runner/tsconfig.json` → **exit 0**
- `biome check src/agents/shims.ts tests/agents/shims.test.ts` → clean
- `spur task check 0046` → **pass: true** (L2 done-status section advisories only)
- `--fix all`: no UNMET/PARTIAL/major findings → no repair pass needed
### Review
**Verdict:** PASS — `/sp:dev-verify 0046 --focus all --fix all --auto --force` (2026-07-12).

**Scope:** `packages/ai-runner/src/agents/shims.ts` + `tests/agents/shims.test.ts` (R1–R3, R8–R9). Auth probe / doctor rows / README owned by 0047/0048.

**Gate:** 131 package tests pass; biome + tsc clean on touched files; runtime smoke of registry + argv confirmed this pass.

| Priority | Dim | file:line | Description | Remediation |
|----------|-----|-----------|-------------|-------------|
| P1 | — | — | No blockers | — |
| P2 | — | — | No warnings | — |
| P3 | Usability | `shims.ts:257` | `getAuthCommand` null — doctor auth state is `unknown` without env/file probe | By design for 0046; env/file probe shipped in **0047** |
| P4 | Architecture | `PromptOptions` | Advanced grok flags (sandbox, worktree, best-of-n) not mapped | Out of feature scope until PromptOptions expands |

**SECUA (focus=all)**

| Dim | Result | Notes |
|-----|--------|-------|
| Security | OK | Pure argv builders; no secrets in shim |
| Efficiency | OK | O(1) registry; no I/O in command build |
| Correctness | OK | Argv matches grok headless CLI; text→plain covered by unit test |
| Usability | OK | Tier-1; priority/display append without reordering preferred agents |
| Architecture | OK | Matches hermes/omp AgentShim pattern; no new package boundaries |

**Requirements traceability**

- [x] R1 MET — registry membership
- [x] R2 MET — prompt argv
- [x] R3 MET — help/version
- [x] R8 MET — text→plain
- [x] R9 MET — auth command null
### History
- 2026-07-12T07:34:49.586Z todo → wip (system)
- 2026-07-12T07:34:59.098Z wip → testing (system)
- 2026-07-12T07:35:37.612Z testing → done (system)
