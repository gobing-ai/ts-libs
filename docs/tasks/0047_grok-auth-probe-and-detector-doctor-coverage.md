---
schema_version: 1
name: "Grok auth probe and detector/doctor coverage"
status: done
template: feature-impl
created_at: 2026-07-12T07:32:35.014Z
updated_at: "2026-07-12T16:18:01.244Z"
feature_id: A
priority: P1
tags: ["ai-runner", "grok", "auth", "doctor"]
---

## 0047. Grok auth probe and detector/doctor coverage

### Background

Grok has no auth-status CLI verb. Auth is tri-state and off the run-readiness critical path: non-empty XAI_API_KEY or non-empty ~/.grok/auth.json → authenticated; otherwise unknown (never false-negative unauthenticated). Detector must parse `grok 0.2.93 (...)` version output. Doctor/DISPLAY_ORDER must include grok.

### Requirements

R4. AgentDetector.detectOne("grok") parses version from mock exit-0 stdout "grok 0.2.93 (deadbeef) [stable]".
R5. isAuthenticated("grok") returns authenticated for XAI_API_KEY or ~/.grok/auth.json; unknown when neither present.
R6. DoctorRunner.runAll includes one row for agent "grok"; DISPLAY_ORDER contains "grok" exactly once.

### Acceptance Criteria
```gherkin
Feature: Add Grok coding agent to ts-ai-runner

  @core
  Scenario: R4 — AgentDetector parses grok version output
    Given a ProcessExecutor that returns exit 0 and stdout "grok 0.2.93 (deadbeef) [stable]" for the version command
    When AgentDetector.detectOne("grok") runs
    Then installed is true and version contains 0.2.93

  @core
  Scenario: R5 — auth resolves from XAI_API_KEY or ~/.grok/auth.json without false negatives
    Given auth probe context for agent grok
    When XAI_API_KEY is a non-empty string or ~/.grok/auth.json is a non-empty file
    Then isAuthenticated returns authenticated
    And when neither credential source is present isAuthenticated returns unknown not unauthenticated

  @core
  Scenario: R6 — doctor and display order include grok
    Given DoctorRunner with no custom executors
    When runAll is invoked
    Then one result row has agent "grok" and DISPLAY_ORDER contains "grok" exactly once
```
### Q&A

<!-- Open questions and their resolutions. Delete if none. -->

### Design

<!-- Decision record — WHAT/WHY. Chosen approach + 1-line reason, rejected alternatives, key signatures (not bodies), invariants. ≤2 illustrative snippets MAX. -->

### Plan

<!-- Ordered checklist or table of implementation steps (not prose). The how-to-execute order within this one task. -->

### Solution

Change map — HOW/WHERE for grok auth probe + detector/doctor coverage.

| Change (`file:line`) | What / why |
|----------------------|------------|
| `packages/ai-runner/src/agents/auth-shims.ts:101` | Dispatch `grok` to dedicated auth path (no CLI auth verb). |
| `packages/ai-runner/src/agents/auth-shims.ts:128` | `checkGrokAuth`: non-empty `XAI_API_KEY` or `~/.grok/auth.json` → `authenticated`; else `unknown` (never false-negative `unauthenticated`). |
| `packages/ai-runner/src/agents/auth-shims.ts:86` | JSDoc documents grok credential sources. |
| `packages/ai-runner/tests/agents/auth-shims.test.ts:167` | R5: env key, blank key, auth file, neither → unknown. |
| `packages/ai-runner/tests/agent-detector.test.ts:97` | R4: parse `grok 0.2.93 (deadbeef) [stable]`. |
| `packages/ai-runner/tests/doctor-runner.test.ts:72` | R6: `DISPLAY_ORDER` / `runAll` include `grok` exactly once. |

### Testing
**Verdict: PASS** — `/sp:dev-verify 0047 --focus all --fix all --auto --force` (2026-07-12).

**Coverage:** targeted auth/detector/doctor **43 pass / 0 fail**; full `bun test packages/ai-runner` → **131 pass / 0 fail**. biome + tsc clean.

**Per-requirement traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R4 | MET | `AgentDetector.detectOne('grok')` with stdout `grok 0.2.93 (deadbeef) [stable]` → installed + version contains `0.2.93`; `agent-detector.test.ts:97`; runtime smoke this pass |
| R5 | MET | `checkGrokAuth` (`auth-shims.ts:128`): non-empty `XAI_API_KEY` or `~/.grok/auth.json` → `authenticated`; neither → `unknown`; blank key does not authenticate; `auth-shims.test.ts:167+`; runtime smoke key/file/none |
| R6 | MET | `DISPLAY_ORDER` filter length 1; `DoctorRunner.runAll` one row `agent === 'grok'`; `doctor-runner.test.ts:72-73`; runtime smoke doctorOnce=1, usable=true with authenticated=unknown |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| Scenario: R4 — AgentDetector parses grok version output | MET | test | agent-detector.test.ts + runtime smoke |
| Scenario: R5 — auth resolves from XAI_API_KEY or ~/.grok/auth.json without false negatives | MET | test | four unit cases + runtime smoke |
| Scenario: R6 — doctor and display order include grok | MET | test | doctor-runner.test.ts + runtime smoke |

**Gate evidence (fresh this turn)**

- Targeted **43 pass / 0 fail**; full package **131 pass / 0 fail**
- `tsc --noEmit` clean; biome check clean on touched files
- Runtime smoke: detect installed, authKey/authFile authenticated, authNone unknown, doctor usable with unknown auth
- `--fix all`: no UNMET/PARTIAL/major → no repair
### Review
**Verdict:** PASS — `/sp:dev-verify 0047 --focus all --fix all --auto --force` (2026-07-12).

**Scope:** `auth-shims.ts` `checkGrokAuth` + detector/auth/doctor tests. Shim registration 0046; README 0048.

**Gate:** 43 targeted + 131 package tests pass; biome/tsc clean; runtime smoke confirms R4–R6.

| Priority | Dim | file:line | Description | Remediation |
|----------|-----|-----------|-------------|-------------|
| P1 | — | — | No blockers | — |
| P2 | — | — | No warnings | — |
| P3 | Usability | `auth-shims.ts:128` | No CLI auth-status verb; env/file only | Intentional; missing → `unknown` not `unauthenticated` |
| P4 | Correctness | out of scope | No live xAI network smoke in CI | Feature A out-of-scope; optional follow-up |

**SECUA (focus=all)**

| Dim | Result | Notes |
|-----|--------|-------|
| Security | OK | Read-only env/file probe; no secret values logged |
| Efficiency | OK | Env check then optional single file stat |
| Correctness | OK | Tri-state auth; version parse of real grok shape; doctor row present |
| Usability | OK | Doctor usable remains true when auth unknown (liveness-only) |
| Architecture | OK | Mirrors codex/gemini env/file patterns; no new package deps |

**Requirements traceability**

- [x] R4 MET — detector version parse
- [x] R5 MET — env/file auth tri-state
- [x] R6 MET — doctor + DISPLAY_ORDER once
### History
- 2026-07-12T07:36:54.560Z todo → wip (system)
- 2026-07-12T07:36:54.841Z wip → testing (system)
- 2026-07-12T07:36:55.201Z testing → done (system)
