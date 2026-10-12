---
schema_version: 1
name: Verify the project rule fixtures against the real evaluators
status: todo
template: feature-impl
created_at: 2026-10-09T21:50:39.278Z
updated_at: "2026-10-12T16:16:52.722Z"
feature_id: F1

priority: P2
ac_altitude: task-local
ac_numbering: task-local
estimate_hours: 6
---

## 0109. Verify the project rule fixtures against the real evaluators

### Background

The project rule fixtures are not invoked by package.json or scripts. Current tree evidence: lifecycle-bus-propagation has two failing source cases, two passing source cases and a passing crossfile group; its events.ts files are supporting declarations, not independent failing cases. Decision-boundaries has four source fixtures covering two rule IDs, not the third task-0108 manifest rule. Verify-confidence has eight failing and six passing JSON fixtures, including hidden .spur/run and .spur/memory/evidence paths. Only decision-boundaries and verify-confidence have README recipes. The current RuleEngine and loadRuleFile already provide real evaluator dispatch; the missing capability is per-case assertion and repository gate wiring.

**Refine corrections (2026-10-12)**
- Every set has a README → lifecycle has none → use the actual fixture tree and task 0053 as evidence.
- Three decision boundary rules have fixtures → only two import rules do → explicitly select those two; exclude the manifest rule.
- Five verify-confidence assertions → eight failing JSON cases currently exist → enumerate all current files, including hidden paths.
- All fixture sets mirror packages and every file is a case → lifecycle mixes flat source, support declarations and a crossfile group → stage named isolated cases with support files.
- Whole should-fire subtree proves every fixture → one violation can hide a missed case → evaluate cases separately.
- Engine results expose exit status/stdout → ExitCodeEvaluator discards process output → record ProcessResult through the existing injected ProcessExecutor seam without altering evaluator semantics.
- A small function or CLI leaves placement and gate unspecified → freeze a package verifier, repository case adapter, and test-post-check wiring below.
- Loader filesystem injection → RuleFileLoadOptions has only schema/fetch options → keep rule YAML physical and inject FileSystem only into fixture checks and engine evaluation.

### Requirements

- [ ] R1. Export verifyRuleFixtures from ts-rule-engine; accept a rule file, fixture directory and prepared cases, evaluate each case/rule pair independently with the real RuleEngine, and require a genuine violation for expected fire and zero findings for expected pass. Evaluator errors always fail.
- [ ] R2. Add bun run verify-rule-fixtures and invoke it after the existing recommended-post-check command in package.json test-post-check; cover all 23 current cases (5 lifecycle, 4 decision-boundaries, 14 verify-confidence), reporting per-set and per-expectation counts.
- [ ] R3. For exit-code cases compare the recorded normal process exit with configured successCode (default 0); retain stdout/stderr and findings in failure diagnostics. Spawn errors, timeout, signals and evaluator errors fail regardless of expected fire.
- [ ] R4. An absent optional fixture directory returns an explicit skipped result; an existing empty case set, unknown/disabled rule ID, absent case workdir or missing case source fails. The repository adapter requires all three declared directories and both expectation classes, so deletion cannot silently skip its gate.
- [ ] R5. Emit deterministic case/rule/expected/actual diagnostics and a machine-readable JSON report at .spur/run/rule-fixtures-report.json, fail the command on any mismatch, and clean temporary workdirs in finally. Never mutate checked-in fixtures or evaluate against the live repository as a case.

Out of scope: new rules, changed evaluator semantics, automatic fixture inference for arbitrary projects, custom evaluator extensions, a new spur CLI command, and asserting the unrepresented decision-boundaries manifest rule.

### Acceptance Criteria

```gherkin
Feature: Project rule fixtures are verified by the gate

  Scenario: AC1 — A fixture that should fire and does not fails the check (req: R1)
    Given a prepared expected-fire case whose selected real evaluator returns no violation
    When verifyRuleFixtures evaluates that case independently
    Then the result fails and identifies the source path, rule ID and expected fire
    And an evaluator error cannot satisfy the expected violation

  Scenario: AC2 — A fixture that should pass and does not fails the check (req: R1)
    Given a prepared expected-pass case that produces a finding
    When verifyRuleFixtures evaluates it
    Then the result fails naming the source path, rule ID and expected pass

  Scenario: AC3 — The three existing fixture sets are exercised (req: R2, R5)
    Given the current repository corpus
    When bun run verify-rule-fixtures runs through test-post-check
    Then all 23 cases across all three sets are checked and counts are reported
    And an independent temporary-copy mutation in each set causes command failure and a diagnostic JSON report

  Scenario: AC4 — An exit-code rule's fixtures are asserted by exit status (req: R3)
    Given separately staged expected-fire and expected-pass exit-code cases
    When their commands complete normally
    Then their exits differ from or equal configured successCode respectively
    And mismatches include stdout and stderr while timeout or launch failure always fails

  Scenario: AC5 — The check cannot pass vacuously (req: R4)
    Given an optional absent directory or an existing empty case set
    When the verifier runs
    Then absence is explicitly skipped and emptiness fails
    And the repository gate fails for a missing declared directory, source case or selected rule
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-12T16:15:28.981Z

Q: Where does the reusable capability end? A: ts-rule-engine owns evaluation and assertion; scripts owns repository-specific enumeration, temporary staging and report writing. This preserves ADR-011 runtime ownership and avoids package tests reaching into consuming .spur configuration.

Q: What is a case? A: An independently evaluated prepared workdir, with explicit support files. Never combine unrelated should-fire files. lifecycle events.ts is support only; crossfile is one multi-file passing case.

Q: Does absence pass? A: Only for a generic caller's optional fixture directory. The repository adapter declares three required directories and fails if one disappears.

Q: Dependencies? A: None of 0110/0111 is needed. Existing engine/executor APIs are available now. No unfinished task handoff and no new dependency or architecture decision required.

### Design

**WHAT / WHERE.** Add packages/rule-engine/src/fixture-verifier.ts, export it from src/index.ts, document it in packages/rule-engine/README.md and test synthetic cases in tests/fixture-verifier.test.ts. New public names: RuleFixtureCase { path: string; workdir: string; ruleIds: string[]; expect: 'fire' | 'pass' }, RuleFixtureVerificationOptions { ruleFile: string; fixtureDir: string; cases: RuleFixtureCase[]; fileSystem?: FileSystem; processExecutor?: ProcessExecutor }, RuleFixtureVerificationResult { pass: boolean; skipped: boolean; cases: RuleFixtureCaseResult[] }, and RuleFixtureCaseResult { path: string; ruleId: string; expect: 'fire' | 'pass'; pass: boolean; findings: ConstraintFinding[]; processes: ProcessResult[]; error?: string }. Export async verifyRuleFixtures(options): Promise<RuleFixtureVerificationResult>. Invalid configuration/I/O may throw; adapter catches, writes failure report and exits nonzero. Missing optional fixtureDir returns pass=true, skipped=true and cases=[]. Support only built-in rules; reject extension declarations instead of silently ignoring them.

**Evaluation.** Use loadRuleFile for the physical ruleFile, then validate the selected enabled IDs and nonempty case declarations. The existing loader has no FileSystem option: rule YAML remains a physical file; the optional FileSystem covers fixture checks and engine evaluation, not rule loading. Tests use real temporary YAML files. Defaults use createNodeFileSystem and nodeBunFactory.createProcessExecutor from ts-runtime. Wrap executor.run to record the original ProcessResult and delegate runStreaming unchanged. Construct RuleEngine with this wrapper and filesystem. Evaluate one selected rule and one case workdir at a time, sequentially, with no fixes; reset captured results for each pair. Unexpected operational errors are failures, never successful should-fire evidence. Ordinary evaluators use violation findings; exit-code uses the recorded exit against successCode and rejects abnormal process outcomes even if a nonzero exit creates a finding. Keep engine and evaluator APIs unchanged. Do not emulate rg, shell scripts or evaluator logic. Use ts-runtime path/FileSystem APIs in the package.

**Repository adapter.** Add scripts/verify-rule-fixtures.ts and scripts/tests/rule-fixtures.test.ts. Its internal runRuleFixtureChecks(repoRoot, reportPath) function supports temporary-repository integration tests; executable defaults use the actual root and .spur/run/rule-fixtures-report.json. Use the existing scripts Node tooling convention for temporary directories/copying, with unique mkdtemp roots and finally cleanup. Discover files recursively including hidden entries, in sorted order. Fail unrecognized non-support fixture shapes rather than silently dropping new cases.

- lifecycle: rule file .spur/rules/typescript/lifecycle-bus-propagation.yaml, ID lifecycle-bus-propagation. Stage each no-lifecycle-bus.ts and unused-lifecycle-bus.ts independently under packages/demo/src with should-fire/events.ts. Stage multiline-parenting.ts and with-lifecycle-bus.ts separately with should-pass/events.ts. Copy should-pass/crossfile contents as one separate workdir. Support files are never independent assertions.
- decision-boundaries: .spur/rules/typescript/decision-boundaries.yaml. Stage each source preserving its packages path. Map packages/ai-runner to no-clef-driver-import-in-ai-runner and packages/decision-clef to no-ai-decision-import-in-decision-clef. Evaluate only its relevant ID; unrelated rules in the same YAML are not required to fire. No checked-in manifests are altered.
- verify-confidence: .spur/rules/quality/verify-confidence.yaml, ID verify-confidence-level. Each JSON is one isolated case, preserving its path relative to should-fire/should-pass (including .spur). No JSON is evaluated beside another verdict.

Wire package.json verify-rule-fixtures to bun scripts/verify-rule-fixtures.ts and append it to test-post-check only after the existing spur rule command succeeds; retain all existing gate flags. Adjust the two existing fixture README recipes to describe automation. Reports contain set summaries and results without nondeterministic temp-root paths; failure output names original source, rule and expectation. Tests may use mutated temporary copies, never edit live fixtures. Targets also include package.json and the two existing fixture READMEs. No numbered-doc edits, new dependencies, preset change or public spur command. No active wip tasks or additional worktrees were present at refinement; preserve unrelated working-tree changes.

### Plan

- [ ] 1. Add synthetic verifier tests for isolated positive/negative cases, evaluator error, exit-code successCode, stdout/stderr, timeout, missing/empty inputs and invalid IDs (R1, R3, R4).
- [ ] 2. Implement and export the frozen verifier using existing loader, RuleEngine, FileSystem and ProcessExecutor seams; document its public contract (R1, R3, R4).
- [ ] 3. Add the repository adapter, hidden-path discovery and staging; assert current counts and add temporary-copy mutation checks for all three sets plus missing required directory and cleanup checks (R2, R4, R5).
- [ ] 4. Wire verify-rule-fixtures into test-post-check and update existing recipe READMEs; run the command and inspect its JSON report (R2, R5).
- [ ] 5. Run bun test packages/rule-engine/tests/fixture-verifier.test.ts scripts/tests/rule-fixtures.test.ts, bun run spur-check and bun run build; confirm only intentional changes and no fixture mutations (R1–R5).

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Parent: docs/features/F1_rule-fixture-verification.md; historical owner task 0053 and boundary task 0108 (existing completed contracts, not scheduling dependencies).
- docs/00_ADR.md ADR-006 (gates) and ADR-011 (runtime seams).
- Current evidence: packages/rule-engine/src/engine.ts, config/loader.ts, evaluators/exit-code-evaluator.ts; package.json; .spur/rules/fixtures/**.
- Refinement: one main worktree, no wip tasks; no dependency on tasks 0110/0111. Existing uncommitted infra changes are outside this spec work.

### History

- 2026-10-12T16:16:12.350Z backlog → todo (system)

