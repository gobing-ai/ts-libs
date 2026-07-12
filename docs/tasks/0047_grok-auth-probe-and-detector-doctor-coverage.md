---
schema_version: 1
name: "Grok auth probe and detector/doctor coverage"
status: done
template: feature-impl
created_at: 2026-07-12T07:32:35.014Z
updated_at: "2026-07-12T07:41:23.167Z"
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
**Verdict: PASS** — re-certified 2026-07-12 via `/sp:dev-run 0047 --auto --next` (implement idempotent — already shipped).

**Coverage:** auth/detector/doctor suites **43 pass / 0 fail**; full package suite re-run this turn.

**Per-requirement traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R4 | MET | `agent-detector.test.ts` — `detectOne('grok')` with `grok 0.2.93 (deadbeef) [stable]` |
| R5 | MET | `auth-shims.ts` `checkGrokAuth`; four unit cases (key, blank key, auth.json, neither) |
| R6 | MET | `doctor-runner.test.ts` — DISPLAY_ORDER/runAll grok length 1 |

**Acceptance criteria** — R4, R5, R6 scenarios MET via unit tests above.

**Gate evidence (fresh this turn)**

- Targeted tests **43 pass / 0 fail**
- `bun test packages/ai-runner` full package suite (this pass)
### Review
**Verdict:** PASS — re-run via `/sp:dev-run 0047 --auto --next` (2026-07-12). Implementation already complete; Review backfilled for done-status gate; R4–R6 re-certified.

**Scope:** `packages/ai-runner/src/agents/auth-shims.ts` + detector/auth/doctor tests. Shim registration owned by 0046; README by 0048.

**Gate (fresh this turn):** targeted auth/detector/doctor **43 pass / 0 fail**; full `bun test packages/ai-runner` → **131 pass / 0 fail**.

| Priority | Dim | file:line | Description | Remediation |
|----------|-----|-----------|-------------|-------------|
| P1 | — | — | No blockers | — |
| P2 | — | — | No warnings | — |
| P3 | Usability | `auth-shims.ts:128` | Grok has no CLI auth-status verb; env/file only | Intentional; missing credentials stay `unknown` |
| P4 | Correctness | out of scope | No live xAI smoke in CI | Deferred by feature A; optional follow-up |

**Requirements traceability**

- [x] **R4** AgentDetector parses `grok 0.2.93 (...)` → MET — `agent-detector.test.ts:97`
- [x] **R5** `XAI_API_KEY` / `~/.grok/auth.json` → authenticated; neither → unknown → MET — `checkGrokAuth` + `auth-shims.test.ts:167+`
- [x] **R6** Doctor/DISPLAY_ORDER include grok once → MET — `doctor-runner.test.ts:72-73`
### History
- 2026-07-12T07:36:54.560Z todo → wip (system)
- 2026-07-12T07:36:54.841Z wip → testing (system)
- 2026-07-12T07:36:55.201Z testing → done (system)
