---
template: feature-impl
schema_version: 1
name: Document grok as a supported coding agent
status: done
type: task
feature_id: A1
priority: P2
tags: [ai-runner,grok,docs]
created_at: 2026-07-12T07:32:35.014Z
updated_at: "2026-08-12T14:40:50.744Z"
---

## 0048. Document grok as a supported coding agent

### Background

Package README is the consumer-facing list of supported agent identifiers. Add grok alongside claude, codex, hermes, omp, etc., noting binary name and headless flags if the README already documents per-agent surfaces.

### Requirements

R7. packages/ai-runner/README.md lists grok among supported agent identifiers.

### Acceptance Criteria
```gherkin
Feature: Add Grok coding agent to ts-ai-runner

  @core
  Scenario: R7 — package README lists grok as supported
    Given packages/ai-runner/README.md
    When a consumer reads the supported agent identifiers
    Then grok appears alongside the other bundled agents
```
### Q&A

<!-- Open questions and their resolutions. Delete if none. -->

### Design

<!-- Decision record — WHAT/WHY. Chosen approach + 1-line reason, rejected alternatives, key signatures (not bodies), invariants. ≤2 illustrative snippets MAX. -->

### Plan

<!-- Ordered checklist or table of implementation steps (not prose). The how-to-execute order within this one task. -->

### Solution

Change map — document grok in package README (R7).

| Change (`file:line`) | What / why |
|----------------------|------------|
| `packages/ai-runner/README.md:35` | Add `grok` to supported agent identifiers list. |
| `packages/ai-runner/README.md:437` | Agent surface table: CLI `grok`, tier 1, env/file auth, `-p`/`-c`/`-m`/`--output-format plain\|json`. |
| `packages/ai-runner/README.md:436` | Also list missing `hermes` row so the table matches the identifier list (pre-existing gap). |
| `packages/ai-runner/README.md:462` | Deprecation map notes: `grok` is first-class canonical. |

### Testing
**Verdict: PASS** — `/sp:dev-verify 0048 --focus all --fix all --auto --force` (2026-07-12).

**Coverage:** N/A (docs-only). Evidence: static-ref + command checks.

**Per-requirement traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R7 | MET | `packages/ai-runner/README.md:35` supported identifiers include `` `grok` ``; agent surface table `:437`; deprecation map `:464` |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| Scenario: R7 — package README lists grok as supported | MET | static-ref + command | `rg` hits + registry/doc consistency check: every `AGENT_SHIMS` id appears in identifiers list and agent table (`missingFromIdLine: []`, `missingFromTable: []`) |

**Gate evidence (fresh this turn)**

- `rg` confirms grok in identifiers, table, deprecation notes
- Consistency script: full registry ↔ README parity
- `spur task check 0048` → pass: true (L2 done-status advisories only)
- `--fix all`: no UNMET/PARTIAL/major → no repair
### Review
**Verdict:** PASS — `/sp:dev-verify 0048 --focus all --fix all --auto --force` (2026-07-12).

**Scope:** `packages/ai-runner/README.md` only (R7). Implementation code owned by 0046/0047.

**Gate:** static-ref + consistency check; all canonical agents present in identifiers list and surface table.

| Priority | Dim | file:line | Description | Remediation |
|----------|-----|-----------|-------------|-------------|
| P1 | — | — | No blockers | — |
| P2 | — | — | No warnings | — |
| P3 | Usability | `README.md:436` | Restored pre-existing missing `hermes` table row while documenting `grok` | Intentional parity fix |
| P4 | Usability | README "Adding a New Agent" | Tutorial still uses fictional `amp` example | Pre-existing; out of R7 scope |

**SECUA (focus=all)**

| Dim | Result | Notes |
|-----|--------|-------|
| Security | OK | Docs only; documents env/file auth without embedding secrets |
| Efficiency | N/A | Documentation task |
| Correctness | OK | Identifier list + table + deprecation notes match shipped registry |
| Usability | OK | Consumer-facing flags and auth sources documented |
| Architecture | OK | No code boundary change |

**Requirements traceability**

- [x] R7 MET — README lists grok among supported agents
### History
- 2026-07-12T07:37:34.406Z todo → wip (system)
- 2026-07-12T07:37:34.744Z wip → testing (system)
- 2026-07-12T07:37:35.148Z testing → done (system)
