---
schema_version: 1
name: "Document grok as a supported coding agent"
status: done
template: feature-impl
created_at: 2026-07-12T07:32:35.014Z
updated_at: "2026-07-12T16:13:34.081Z"
feature_id: A
priority: P2
tags: ["ai-runner", "grok", "docs"]
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
**Verdict: PASS** — re-certified 2026-07-12 via `/sp:dev-run 0048 --auto --next` (implement idempotent — already shipped).

**Coverage:** N/A (docs-only). Evidence: static-ref + command.

**Per-requirement traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R7 | MET | `packages/ai-runner/README.md:35` lists `grok`; table `:437`; deprecation notes `:464` |

**Acceptance criteria**

| Scenario | Status | Evidence |
|----------|--------|----------|
| R7 — package README lists grok as supported | MET | `rg '`grok`|Supported agent' packages/ai-runner/README.md` |

**Gate evidence (fresh this turn)**

- README identifiers + agent table + deprecation map all mention `grok`
### Review

**Verdict:** PASS — re-run via `/sp:dev-run 0048 --auto --next` (2026-07-12). Docs already shipped; Review backfilled for done-status gate; R7 re-certified.

**Scope:** `packages/ai-runner/README.md` only (docs). Shim/auth implementation owned by 0046/0047.

**Gate (fresh this turn):** `rg` confirms `grok` in supported identifiers (`README.md:35`), agent table (`:437`), deprecation notes (`:464`).

| Priority | Dim | file:line | Description | Remediation |
|----------|-----|-----------|-------------|-------------|
| P1 | — | — | No blockers | — |
| P2 | — | — | No warnings | — |
| P3 | Usability | `README.md:436` | Restored missing `hermes` table row while adding `grok` | Intentional list/table parity fix |
| P4 | Usability | `README.md` "Adding a New Agent" | Tutorial still uses fictional `amp` example | Pre-existing; out of scope for R7 |

**Requirements traceability**

- [x] **R7** README lists `grok` among supported agents → MET — identifiers + surface table + deprecation map

### History
- 2026-07-12T07:37:34.406Z todo → wip (system)
- 2026-07-12T07:37:34.744Z wip → testing (system)
- 2026-07-12T07:37:35.148Z testing → done (system)
