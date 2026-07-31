---
template: feature-impl
schema_version: 1
name: Add lifecycle-bus-propagation architecture rule
description: ""
status: done
type: task
profile: standard
feature_id: B
parent_wbs: null
priority: P2
tags: []
dependencies: []
created_at: 2026-07-13T03:54:37.571Z
updated_at: 2026-07-13T16:41:11.518Z
---

## 0053. Add lifecycle-bus-propagation architecture rule

### Background

### Requirements

- [x] R1. Add a `lifecycle-bus-propagation` rule under `.spur/rules/` that detects consumer-facing `events?: EventBus<XEvents>` APIs without a corresponding lifecycle-bus propagation path.
- [x] R2. Cover compliant and non-compliant fixtures so the rule proves both detection and false-positive behavior.
- [x] R3. Register the rule in the appropriate recommended preset only after it passes the existing repository sources.
- [x] R4. Keep the rule structural and package-agnostic; do not hard-code the current package list.

### Acceptance Criteria

```gherkin
Feature: Enforce lifecycle bus propagation at EventBus API boundaries

  @core
  Scenario: Missing lifecycle propagation is rejected
    Given a TypeScript options API that declares events?: EventBus<XEvents>
    And no lifecycleBus option or constructor-injected propagation path exists
    When the lifecycle-bus-propagation rule runs
    Then it reports an actionable finding at that API boundary

  @core
  Scenario: Correct lifecycle propagation passes
    Given an events API that accepts lifecycleBus and parents its internal EventBus to it
    When the lifecycle-bus-propagation rule runs
    Then no finding is reported
```

### Q&A

<!-- Clarifications and decisions made during refinement. Keep empty if none. -->

### Design

Implement this as a dedicated Spur architecture rule with focused fixtures. Match the API shape and propagation behavior rather than package names. First prove the matcher against isolated compliant/non-compliant fixtures, then run it across the monorepo and add it to the recommended preset only when the existing sources are clean. This task is the explicit R8 deferral from 0050 because reliable cross-node AST/data-flow matching is non-trivial and should not be improvised inside feature verification.

### Plan

1. Survey existing `.spur/rules/` AST and architectural rule patterns.
2. Implement `lifecycle-bus-propagation` with actionable evidence and remediation text.
3. Add compliant and non-compliant rule fixtures/tests.
4. Run the rule against all workspace packages and fix matcher false positives.
5. Register it in the recommended preset and run `bun run spur-check` plus `bun run build`.

### Solution
**Rule:** `.spur/rules/typescript/lifecycle-bus-propagation.yaml:1-143` defines a package-agnostic `exit-code` evaluator for consumer-facing `events?: EventBus<XEvents>` declarations. It derives each declaration's package `src/` root from the file path and is included automatically in `recommended-pre-check` through the existing `typescript` preset.

**Propagation proof:** a declaration passes only when its file or package contains an actual parented `new EventBus<...>({ lifecycleBus: ... })` construction (`.spur/rules/typescript/lifecycle-bus-propagation.yaml:55-110,129-139`). Merely declaring or referencing `lifecycleBus` no longer satisfies the rule. The scan strips line/block comments before matching and supports multiline constructor formatting.

**Fixtures:** `.spur/rules/fixtures/lifecycle-bus-propagation/` contains two non-compliant cases (no lifecycle option; declared-but-unused lifecycle option) and three compliant shapes (file-local, cross-file package path, multiline parenting). The commented-out suggested fix in `unused-lifecycle-bus.ts:22-24` proves comments cannot silence the rule.

**Production scope:** all 10 declaration sites across the workspace pass without package-name allowlists. The rule remains a structural package-level proxy rather than full TypeScript data-flow analysis: it proves that a package with an event-bus API contains a real parented construction, but does not establish a symbol-level edge from every declaration to that construction.
### Testing
**Verification Verdict: PASS** — all four requirements and both core scenarios are MET after one bounded `--fix all` repair.

**Requirement Verification**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `.spur/rules/typescript/lifecycle-bus-propagation.yaml:29-143` detects `events?: EventBus<X>` declarations and requires a real parented EventBus construction in the declaring file/package. The initial identifier-only false positive was repaired. |
| R2 | MET | Fixture harness proves two should-fire cases and three compliant shapes: file-local, cross-file, and multiline. Commented-out and unused lifecycle identifiers remain violations. |
| R3 | MET | `spur rule list --preset recommended-pre-check --json` reports 45 rules and includes `lifecycle-bus-propagation`; the production rule run returns zero findings. |
| R4 | MET | The evaluator derives package roots from declaration paths and contains no package allowlist; production scan covers 10 declaration sites across the workspace. |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| Scenario: Missing lifecycle propagation is rejected | MET | command | Extracted evaluator run against `should-fire/` exits 1 with exactly two actionable findings: no lifecycle path and declared-but-unused lifecycle option. |
| Scenario: Correct lifecycle propagation passes | MET | command | The same evaluator run against `should-pass/` exits 0 with zero findings for file-local, cross-file, and multiline parenting; production `spur rule run` also exits 0. |

**Design Conformance**

| Claim | Status | Evidence |
|-------|--------|----------|
| Dedicated Spur architecture rule | DONE | Rule file validates and is resolved by the TypeScript preset. |
| Match propagation behavior, not package names | DONE | Requires an actual parented construction and derives package paths dynamically. |
| Focused compliant/non-compliant fixtures | DONE | Five fixture shapes cover both directions and identified false-positive risks. |
| Register only after current sources are clean | DONE | Ad-hoc production run and canonical preset both return zero findings. |

**Checks**

| Check | Status | Evidence |
|-------|--------|----------|
| Focused rule verification | PASS | Rule schema valid; should-fire exits 1 with 2 findings; should-pass and production exit 0 with 0 findings. |
| Design conformance | PASS | 4/4 non-trivial claims DONE; no undocumented deviation or unrelated diff. |
| SECUA | PASS | No unresolved blocker/major finding after repairing identifier-only matching. Remaining package-level correlation and O(d×f) scanning are advisory at current scale. |
| Canonical gate | PASS | Fresh `bun run spur-check`: 1,626 tests pass, 0 fail, 3,559 assertions, 99.26% lines; all 45 pre-check and 2 post-check rules pass. |
| Build | PASS | Fresh `bun run build`: all eight packages exit 0. |
| Hygiene | PASS | `git diff --check` clean; no TODO/FIXME, suppression, focused/skipped test, or console-output addition in task scope. |

**Fix Applied During Verification**

- Replaced the identifier-only `lifecycleBus` proxy, which accepted unused options/dead references, with a comment-aware proof of an actual parented EventBus construction.
- Added declared-but-unused, commented-out-fix, and multiline-format fixtures to prevent regressions.

Coverage: N/A — the deliverable is a shell/rg constraint evaluator; deterministic fixture executions are its behavior coverage.
### Review

**SECU findings:**

| Priority | Dimension | Location | Finding |
| ---------- | ----------- | ---------- | ---------- |
| P4 | Correctness | rule YAML | `has_lb_code` re-enters `rg` per file; O(n²) on large packages but n is small (≤10 declaration sites) — acceptable. |
| P4 | Maintainability | rule YAML | Comment filter is heuristic (prefix split on `//`, `/*`, `*`); does not handle nested block comments or `*` inside strings, but no such cases exist in current sources. |
| P4 | Accuracy | rule YAML | Package-level `lifecycleBus` identifier is a structural proxy, not data-flow proof (documented R8 deferral). A package referencing `lifecycleBus` in dead code would still pass. |

No P1–P3 findings. Residual risk: the cross-node proxy may miss a future shape
where `lifecycleBus` is introduced under a different identifier (e.g. aliased
import). Mitigation: re-evaluate when task 0050 R8 data-flow work lands.

### References

A

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-07-13T06:52:05.098Z todo → wip (system)
- 2026-07-13T16:30:09.096Z wip → testing (system)
- 2026-07-13T16:30:51.362Z testing → done (system)
