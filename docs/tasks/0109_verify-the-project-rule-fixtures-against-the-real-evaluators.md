---
schema_version: 1
name: Verify the project rule fixtures against the real evaluators
status: done
template: feature-impl
created_at: 2026-10-09T21:50:39.278Z
updated_at: "2026-10-12T18:12:28.126Z"
feature_id: F1

priority: P2
ac_altitude: task-local
ac_numbering: task-local
estimate_hours: 6
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0109-verdict.json
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

- [x] R1. Export verifyRuleFixtures from ts-rule-engine; accept a rule file, fixture directory and prepared cases, evaluate each case/rule pair independently with the real RuleEngine, and require a genuine violation for expected fire and zero findings for expected pass. Evaluator errors always fail.
- [x] R2. Add bun run verify-rule-fixtures and invoke it after the existing recommended-post-check command in package.json test-post-check; cover all 23 current cases (5 lifecycle, 4 decision-boundaries, 14 verify-confidence), reporting per-set and per-expectation counts.
- [x] R3. For exit-code cases compare the recorded normal process exit with configured successCode (default 0); retain stdout/stderr and findings in failure diagnostics. Spawn errors, timeout, signals and evaluator errors fail regardless of expected fire.
- [x] R4. An absent optional fixture directory returns an explicit skipped result; an existing empty case set, unknown/disabled rule ID, absent case workdir or missing case source fails. The repository adapter requires all three declared directories and both expectation classes, so deletion cannot silently skip its gate.
- [x] R5. Emit deterministic case/rule/expected/actual diagnostics and a machine-readable JSON report at .spur/run/rule-fixtures-report.json, fail the command on any mismatch, and clean temporary workdirs in finally. Never mutate checked-in fixtures or evaluate against the live repository as a case.

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

- [x] 1. Add synthetic verifier tests for isolated positive/negative cases, evaluator error, exit-code successCode, stdout/stderr, timeout, missing/empty inputs and invalid IDs (R1, R3, R4).
- [x] 2. Implement and export the frozen verifier using existing loader, RuleEngine, FileSystem and ProcessExecutor seams; document its public contract (R1, R3, R4).
- [x] 3. Add the repository adapter, hidden-path discovery and staging; assert current counts and add temporary-copy mutation checks for all three sets plus missing required directory and cleanup checks (R2, R4, R5).
- [x] 4. Wire verify-rule-fixtures into test-post-check and update existing recipe READMEs; run the command and inspect its JSON report (R2, R5).
- [x] 5. Run bun test packages/rule-engine/tests/fixture-verifier.test.ts scripts/tests/rule-fixtures.test.ts, bun run spur-check and bun run build; confirm only intentional changes and no fixture mutations (R1–R5).

### Solution

`verifyRuleFixtures` is exported from `@gobing-ai/ts-rule-engine`; the repository adapter enumerates all
three fixture sets, stages each case into a scratch workdir, asserts it through the real `RuleEngine`,
and is wired into `test-post-check`. All **23 current case/rule pairs pass** (lifecycle 5,
decision-boundaries 4, verify-confidence 14), and each set's temporary-copy mutation fails the sweep.

| Anchor | Change |
|--------|--------|
| `packages/rule-engine/src/fixture-verifier.ts:81` | `verifyRuleFixtures`: loads the physical rule file, rejects extension declarations, validates selected enabled IDs and non-empty case declarations, then evaluates one rule against one workdir at a time with fixes off. |
| `packages/rule-engine/src/fixture-verifier.ts:161-165` | Absent case workdir, or a case `path` missing under `fixtureDir`, fails that pair instead of disappearing. |
| `packages/rule-engine/src/fixture-verifier.ts:185` | `exit-code` rules are routed to the exit-status judge; every other evaluator is judged on findings. |
| `packages/rule-engine/src/fixture-verifier.ts:197` | Exit comparison against the rule's configured `successCode` (default `0`); timeout, signal, spawn failure and any non-`exit` outcome fail regardless of expectation. |
| `packages/rule-engine/src/fixture-verifier.ts:233` | stdout/stderr are retained in the failure diagnostic. |
| `packages/rule-engine/src/index.ts:14` | Public export of the new contract. |
| `packages/rule-engine/tests/fixture-verifier.test.ts:183` | An evaluator error cannot satisfy an expected violation. |
| `packages/rule-engine/tests/fixture-verifier.test.ts:215` | Recorded exit vs `successCode` mismatch, including a non-default `successCode`. |
| `packages/rule-engine/tests/fixture-verifier.test.ts:292` | Timeout, spawn error and launch failure always fail. |
| `packages/rule-engine/tests/fixture-verifier.test.ts:343-347` | Absent optional `fixtureDir` yields `pass: true, skipped: true, cases: []`; an existing empty case set fails. |
| `scripts/verify-rule-fixtures.ts:496` | `runRuleFixtureChecks(repoRoot, reportPath)`: the sweep plus the report write, which happens for a passing and a failing sweep alike. |
| `scripts/verify-rule-fixtures.ts:227` | All three declared set directories **and** both expectation classes are required, so deletion cannot silently skip the gate. |
| `scripts/verify-rule-fixtures.ts:203` | Recursive discovery including hidden entries, in sorted order; a non-file entry is an unrecognized shape. |
| `scripts/verify-rule-fixtures.ts:31-41` | lifecycle staging constants: each source is staged independently under `packages/demo/src` beside its `events.ts` support file, and `crossfile/` is staged as one multi-file workdir. |
| `scripts/verify-rule-fixtures.ts:290-300` | decision-boundaries: package → rule mapping, preserving the `packages/<pkg>/src/<file>.ts` source path; an unmapped package fails rather than skipping. |
| `scripts/verify-rule-fixtures.ts:317-325` | verify-confidence: one isolated `.spur` verdict-plane case per `<file>.json`, with its hidden path preserved. |
| `scripts/verify-rule-fixtures.ts:466-479` | Per-set and per-expectation counts are tallied here, and the scratch root is removed in the `finally` on both the passing and the failing path. |
| `scripts/verify-rule-fixtures.ts:362` | Captured streams are bounded, so the report stays deterministic and small. |
| `scripts/verify-rule-fixtures.ts:438` | Each set declares its expected case count per expectation class, so a deleted (or silently added) fixture fails by name instead of shrinking the plan into a vacuous pass. |
| `scripts/verify-rule-fixtures.ts:513` | Diagnostics name the set, source path, rule ID and expectation for every failing pair. |
| `scripts/tests/rule-fixtures.test.ts:60` | Pins the 23 pairs and the per-set/per-expectation counts as a regression check. |
| `scripts/tests/rule-fixtures.test.ts:83` | An independent temporary-copy mutation in each set fails the sweep, and the checked-in fixture is byte-identical afterwards. |
| `scripts/tests/rule-fixtures.test.ts:161` | No scratch workdir survives a sweep. |
| `scripts/tests/rule-fixtures.test.ts:320` | An emptied expectation directory fails the sweep with the declared count. |
| `scripts/tests/rule-fixtures.test.ts:331` | A single deleted case source fails the sweep. |
| `scripts/tests/rule-fixtures.test.ts:341` | A case added without a declaration update fails the sweep. |
| `package.json:41` | `verify-rule-fixtures` is appended to `test-post-check` after the existing rule command, so `bun run spur-check` covers it. |
| `package.json:42` | The `bun run verify-rule-fixtures` entry point. |
| `packages/rule-engine/README.md:488` | Public contract documented: options, result shape, per-expectation semantics, and the skip-vs-fail table. |
| `.spur/rules/fixtures/decision-boundaries/README.md:10` | Recipe now describes the automation, with the hand-run route kept for a single rule edit. |
| `.spur/rules/fixtures/verify-confidence/README.md:11` | Same for the verdict-plane set. |

**Rationale.** The reusable capability stops at evaluation and assertion, so `ts-rule-engine` owns it:
`verifyRuleFixtures` takes a prepared case list and asserts it, and knows nothing about this
repository's layout. Enumeration, staging and reporting stay in `scripts/`, which is where
repository-specific knowledge already lives (`scripts/config.ts`, `scripts/lib/`) and where
`runtime-boundaries` does not apply, so the adapter may use `node:fs` directly. The verifier never
prints or exits; the adapter owns the report and the exit code.

The evaluator seam is reused, not extended: the engine already dispatches through injected
`FileSystem` and `ProcessExecutor` ports, so wrapping `run()` to record the original `ProcessResult`
gives the exit-code assertion its evidence without touching evaluator semantics or the rule file
schema. Fixtures are staged outside the repository (OS temp dir) and only ever read from it, so a
mutated temporary copy is the only way a case can change — which is exactly what the mutation tests
do, and why the checked-in corpus stays untouched.

The gate fails closed in five ways that matter: a deleted declared directory fails instead of
skipping, an unrecognized fixture shape fails instead of being dropped, an empty case set fails
instead of passing vacuously, and — the gap the review stage found — a **reduced or grown** case
inventory fails by name. That last one is load-bearing for R4/AC5: the adapter plans cases from disk,
so a plan derived purely from what is present can never notice that something is missing; every
remaining case simply passes and the sweep reports PASS. The per-set `expected` counts make the
inventory explicit, so a deletion is a named failure at the wired gate rather than a pass that only
the corpus pin in the test suite would catch. The cost is that adding a fixture now takes one
declaration line beside it — a deliberate trade against a vacuous green.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | verifyRuleFixtures is exported through packages/rule-engine/src/index.ts:14 and implemented at packages/rule-engine/src/fixture-verifier.ts:81: it loads the physical rule file, keeps only enabled rule IDs, then evaluates one rule against one prepared workdir per pair, sequentially, with fixes off. judgeCase (packages/rule-engine/src/fixture-verifier.ts:174) demands a genuine violation for expected fire (packages/rule-engine/src/fixture-verifier.ts:189), zero findings for expected pass (packages/rule-engine/src/fixture-verifier.ts:193), and fails both expectations on any evaluator-kind error (packages/rule-engine/src/fixture-verifier.ts:182). Reproduced this run against the real rule .spur/rules/typescript/decision-boundaries.yaml (id no-clef-driver-import-in-ai-runner) with the real RuleEngine: matched expectations returned pass=true with fire findings=1 / pass findings=0; the crossed expectations returned pass=false with "expected fire but the rule reported no violation" and "expected pass but the rule reported 1 violation(s)", each naming the source path and rule ID. Evaluator error cannot satisfy a violation: packages/rule-engine/tests/fixture-verifier.test.ts:183 passes, and its finding set is entirely kind error. |
| R2 | MET | package.json:41 appends "bun run verify-rule-fixtures" to test-post-check after the recommended-post-check rule command; package.json:42 defines the entry point as "bun scripts/verify-rule-fixtures.ts". My own run of bun run verify-rule-fixtures printed "PASS  lifecycle-bus-propagation  cases 5 (fire 2, pass 3)  failed 0", "PASS  decision-boundaries  cases 4 (fire 2, pass 2)  failed 0", "PASS  verify-confidence  cases 14 (fire 8, pass 6)  failed 0", "rule-fixtures: PASS — 23/23 pair(s) across 3 set(s)" and exited 0; .spur/run/rule-fixtures-report.json records totals sets=3, cases total 23 (fire 12, pass 11), passed 23, failed 0, matching the per-set counts echoed above. The gate log .spur/run/0109-test-gate.log shows both chained commands running in order after the tests. |
| R3 | MET | packages/rule-engine/src/fixture-verifier.ts:185 routes exit-code rules to judgeExitCodeCase (packages/rule-engine/src/fixture-verifier.ts:197), which reads the ProcessResult recorded by the wrapped run() and compares its exitCode with the rule's configured successCode (packages/rule-engine/src/fixture-verifier.ts:202). Abnormal outcomes fail regardless of expectation (packages/rule-engine/src/fixture-verifier.ts:206) and stdout/stderr are retained in the diagnostic (packages/rule-engine/src/fixture-verifier.ts:233). My own exit-code control with successCode 7 and a command exiting 7: expected fire returned pass=false with "expected fire but exit 7 equals successCode 7", recorded processes [{"exitCode":7,"outcome":"exit"}], and the same input with expected pass returned pass=true, so the judgement comes from the recorded exit and not from the findings. On a temporary repository copy with the rule command pointed at a missing binary, all 5 lifecycle pairs failed with "exit-code: process did not complete normally (outcome exit)" and processes [{"exitCode":null,"outcome":"exit"}], i.e. the null exit fails even for expected fire. |
| R4 | MET | Library half, reproduced this run through verifyRuleFixtures with the real rule file: absent optional fixture directory returned {"pass":true,"skipped":true,"cases":[]} (packages/rule-engine/src/fixture-verifier.ts:87); an existing empty case set returned {"pass":false,"skipped":false,"cases":[]} (packages/rule-engine/src/fixture-verifier.ts:88); an unknown rule ID returned "rule \"not-a-rule\" is not an enabled rule" (packages/rule-engine/src/fixture-verifier.ts:134); a missing case source and an absent workdir returned the named "case source ... is missing under" and "case workdir ... is missing" failures (packages/rule-engine/src/fixture-verifier.ts:165, packages/rule-engine/src/fixture-verifier.ts:168). Adapter half: all three declared set directories and both expectation classes are required (scripts/verify-rule-fixtures.ts:227) and a reduced or grown inventory fails by name (scripts/verify-rule-fixtures.ts:438). My own temporary-copy runs: removing the lifecycle-bus-propagation set directory returned pass=false with "declared fixture directory \"lifecycle-bus-propagation\" is missing"; emptying verify-confidence/should-fire with the directory kept returned "declared 8 case(s), found 0"; deleting verify-confidence/should-pass/.spur/memory/evidence/0204-verdict.json returned "declared 6 case(s), found 5"; adding decision-boundaries/should-pass/packages/ai-runner/src/extra.ts returned "declared 2 case(s), found 3". |
| R5 | MET | runRuleFixtureChecks (scripts/verify-rule-fixtures.ts:496) produces the machine-readable report and printReport (scripts/verify-rule-fixtures.ts:513) renders set, source, rule ID and expectation for every failing pair; captured streams are bounded (scripts/verify-rule-fixtures.ts:362). My own checks this run: two consecutive bun run verify-rule-fixtures runs wrote byte-identical .spur/run/rule-fixtures-report.json (cmp clean); the report contains zero occurrences of the scratch prefix, /tmp/ or the temp root, and no "case-" workdir string; zero ts-libs-rule-fixtures-* directories survived under the OS temp dir after the sweeps; git status --porcelain .spur/rules is empty, so no checked-in fixture was written or mutated; on a temporary repository copy the failing sweep still wrote the report with pass=false and its single named error, and printReport rendered "rule-fixtures: FAIL — declared case inventory mismatch ..." to stderr. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — A fixture that should fire and does not fails the check (req: R1) | MET | test | packages/rule-engine/tests/fixture-verifier.test.ts:138 passes (re-run this run with bun test -t "fails an expected-fire case whose evaluator reports no violation": 1 pass, 0 fail) and asserts pass=false naming the case path, the rule ID, expect fire and "no violation". Independent control through the real evaluator (see R1): a should-pass workdir asserted with expect fire returned pass=false, findings=0, error "expected fire but the rule reported no violation". An evaluator error cannot satisfy the violation: packages/rule-engine/tests/fixture-verifier.test.ts:183 passes and packages/rule-engine/src/fixture-verifier.ts:182 returns the evaluator error before the fire branch. |
| AC2 — A fixture that should pass and does not fails the check (req: R1) | MET | test | packages/rule-engine/tests/fixture-verifier.test.ts:162 passes (re-run this run with bun test -t "fails an expected-pass case that produces a finding": 1 pass, 0 fail) and asserts expect pass, "1 violation" and findings length 1. Independent control through the real evaluator (see R1): the should-fire source staged with expect pass returned pass=false, findings=1, error "expected pass but the rule reported 1 violation(s)" while naming the source path and rule ID. |
| AC3 — The three existing fixture sets are exercised (req: R2, R5) | MET | test | bun run verify-rule-fixtures exited 0 and reported all three sets with per-set and per-expectation counts — lifecycle-bus-propagation 5 (fire 2, pass 3), decision-boundaries 4 (fire 2, pass 2), verify-confidence 14 (fire 8, pass 6) — plus "rule-fixtures: PASS — 23/23 pair(s) across 3 set(s)"; scripts/tests/rule-fixtures.test.ts:60 pins the same counts and the written report, and the full two-file suite ran 31 pass / 0 fail / 100 expect() calls this run. My own temporary-copy mutations through the real adapter runRuleFixtureChecks (scripts/verify-rule-fixtures.ts:496) failed the sweep in every set and still wrote the diagnostic report: lifecycle should-fire/no-lifecycle-bus.ts deleted gave "declared case inventory mismatch for \"lifecycle-bus-propagation/should-fire\": declared 2 case(s), found 1"; decision-boundaries should-pass/packages/ai-runner/src/extra.ts added gave "declared 2 case(s), found 3"; verify-confidence should-pass/.spur/memory/evidence/0204-verdict.json deleted gave "declared 6 case(s), found 5" and the emptied verify-confidence/should-fire gave "declared 8 case(s), found 0". |
| AC4 — An exit-code rule's fixtures are asserted by exit status (req: R3) | MET | test | packages/rule-engine/tests/fixture-verifier.test.ts:215 asserts the recorded exit against a non-default successCode 1 and that processes[0].exitCode is the recorded 1; packages/rule-engine/tests/fixture-verifier.test.ts:239 accepts the differing-exit fire half and the equal-exit pass half against successCode 0; packages/rule-engine/tests/fixture-verifier.test.ts:266 asserts stdout/stderr retention; packages/rule-engine/tests/fixture-verifier.test.ts:292 asserts timeout, spawn error and launch failure fail even for expected fire. Independent reproduction this run (see R3): successCode 7 with a real command exiting 7 failed the expected-fire half with "expected fire but exit 7 equals successCode 7" and passed the expected-pass half, from recorded processes [{"exitCode":7,"outcome":"exit"}], so the judge reads the recorded process and not a re-derivation from findings; a missing binary failed all 5 lifecycle pairs with exitCode null and outcome exit. On a temporary copy whose crossfile parenting file was gutted, the expected-pass lifecycle case failed with "expected pass but exit 1 differs from successCode 0" and the rule's own stdout retained. |
| AC5 — The check cannot pass vacuously (req: R4) | MET | test | Adversarial runs this run of the real adapter runRuleFixtureChecks (scripts/verify-rule-fixtures.ts:496) against fresh temporary repository copies holding a copy of .spur/rules: (d) unmutated copy returned pass=true with totals total 23 (fire 12, pass 11); (a) verify-confidence/should-fire emptied with the directory kept returned pass=false with "declared 8 case(s), found 0"; (b) the single case source verify-confidence/should-pass/.spur/memory/evidence/0204-verdict.json deleted returned pass=false with "declared 6 case(s), found 5"; (c) the undeclared case decision-boundaries/should-pass/packages/ai-runner/src/extra.ts added returned pass=false with "declared 2 case(s), found 3"; and removing the declared lifecycle-bus-propagation set directory returned pass=false with "declared fixture directory \"lifecycle-bus-propagation\" is missing". Every failing sweep wrote the report (pass=false) to the requested path, and the guard sits at scripts/verify-rule-fixtures.ts:438 inside collectReport before staging, pinned by scripts/tests/rule-fixtures.test.ts:320, scripts/tests/rule-fixtures.test.ts:331 and scripts/tests/rule-fixtures.test.ts:341. Library half: the absent optional directory skip and the existing empty case set failure are asserted by packages/rule-engine/tests/fixture-verifier.test.ts:338 and packages/rule-engine/tests/fixture-verifier.test.ts:353, and I reproduced both through verifyRuleFixtures in this run. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

| Priority | Anchor | Finding | Disposition |
| --- | --- | --- | --- |
| P1 (blocker) | — | none | — |
| P2 (major) | — | none | — |
| P3 (minor) | — | none | — |
| P4 (advisory) | `scripts/verify-rule-fixtures.ts:436` | Case identity and fixture bytes are not pinned, only observed rule behaviour. Emptied a declared `should-fire` body (`verify-confidence/should-fire/.spur/run/0103-verdict.json` zero-byte, name and count preserved) and the sweep still reported 23/23, because the rule treats unreadable JSON as a violation — its own fail-safe branch. `lifecycle-bus-propagation/should-fire/events.ts` emptied likewise stayed green. A name-based inventory would not close this; only a content pin would. Needs a deliberate fixture edit, and no rule regression escapes without it. | DEFER |
| P4 (advisory) | `.spur/run/0109-check-receipt.json` | Receipt `inputDigest` is the stale run-1 digest `sha256:32a91859…`, not this tree's digest `sha256:4b7e5d7e…`. Cause is harness-side: `quality-gate` records the *supplied* `proofDigest` (`quality-gate.mjs:30551`) even when its reuse check refused that value, and the refusal line plus `0109-gate2.env.sh` both carry the current `4b7e5d7e…`, which I reproduced independently from the working tree. Not caused by this diff; the consequence is a re-run (fail-closed), never a false green — but a verify-stage receipt/proof equality check will see a mismatch. | DEFER |

**Verdict: PASS.** No open P1–P3 finding; the two P4 items are deferred hardening/evidence-chain notes, not contract failures.

## What I verified independently

Frozen contract: `docs/tasks/0109_...md` (`### Requirements` R1–R5, `### Acceptance Criteria` AC1–AC5). Scope reviewed:
commit `f2960cb8` plus the corpus writes. `### Solution` and the replaced `### Review` were treated as claims only.

**R1 (reusable verifier).** `packages/rule-engine/src/fixture-verifier.ts:81` exports `verifyRuleFixtures`, wired
into the public barrel at `packages/rule-engine/src/index.ts:14`. One enabled rule against one workdir per pair,
sequentially, fixes off (`engine.evaluate` → `evaluateWithFixes(..., 'none')`). `judgeCase`
(`packages/rule-engine/src/fixture-verifier.ts:174`) requires a genuine violation for `fire`, zero findings for
`pass`, and routes `kind: 'error'` findings to a failure for both expectations (`:180-182`), so an evaluator error
cannot satisfy an expected violation. Reproduced live through the real engine and the real rule files: all 23
declared pairs pass against the checked-in corpus, and inverting one pair in a temp copy fails that pair by name.

**R2 (wiring + coverage).** `package.json:41` appends `bun run verify-rule-fixtures` to `test-post-check` after the
`recommended-post-check` preset; `package.json:42` defines the entry point. Live run: `lifecycle-bus-propagation`
5 (fire 2, pass 3), `decision-boundaries` 4 (2, 2), `verify-confidence` 14 (8, 6) — `23/23 pair(s) across 3 set(s)`,
exit 0, and `.spur/run/rule-fixtures-report.json` carries the same per-set and per-expectation counts.

**R3 (exit-code semantics).** The wrapper at `packages/rule-engine/src/fixture-verifier.ts:112-116` records the
original `ProcessResult` and returns it unchanged; `runStreaming` is delegated. The judgement is read off that
recorded result (`:185` routes `exit-code`, `:197` compares `exitCode` against the rule's `successCode`, read the
same way `ExitCodeEvaluator` reads it — `configNumber` falls back to 0 for a non-finite value, and the verifier's
`typeof === 'number'` test matches that on every realistically-loadable config). Abnormal outcomes fail regardless
of expectation (`:206`), with stdout/stderr retained (`:233`). Three live deformations of the rule files through
the **real** `ProcessExecutor` and real rule engine, each on a temporary copy: missing binary → 5/5 lifecycle pairs
fail (`{"exitCode":null,"outcome":"exit"}`); `sleep 5` under `timeout: 400` → 14/14 verify-confidence pairs fail
(`outcome timeout (signal Termination)`); `kill -TERM $$` → 14/14 fail (`outcome signal`). Worth recording: the bun
executor reports a launch failure as `outcome: 'exit'` with `exitCode: null`, so the `exitCode === null` disjunct
at `:206` is the load-bearing half — an `outcome`-only test would have let a spawn failure satisfy an expected-fire
case.

**R4 / AC5 (cannot pass vacuously).** Library half: absent optional directory → `{pass: true, skipped: true, cases:
[]}` (`:87`), present-but-empty case set → failure (`:88`), unknown/disabled rule ID → named failure (`:134`),
missing case source or workdir → named failure (`:159-169`). Adapter half: all three set directories **and** both
expectation classes are required (`scripts/verify-rule-fixtures.ts:227`), an unrecognized shape throws (`:216`,
`:258`, `:300`, `:326`), and the declared count per expectation class is asserted before staging (`:436`) — the
guard that closed the round-1 escape. Live confirmation: with the selected rule set `enabled: false` in a temp copy,
the two `no-clef-driver-import-in-ai-runner` pairs fail naming the rule; deleting a rule file fails the sweep with
the I/O reason and a written report.

**R5 (deterministic diagnostics + report).** `.spur/run/rule-fixtures-report.json` is produced by
`runRuleFixtureChecks` (`:496`) and rendered by `printReport` (`:513`) naming set, source, rule ID and expectation.
Two consecutive live runs produced a byte-identical report (`cmp` clean), with zero occurrences of
`ts-libs-rule-fixtures-`, `/tmp/` or `/var/folders`; no `ts-libs-rule-fixtures-*` scratch directory survived
(`finally` at `:478`); `git status --porcelain .spur/rules/fixtures` is empty, so no checked-in fixture was written
(staging is `copyFile` only, `:356`).

**AC1–AC5.** AC1 and AC2 are pinned by `packages/rule-engine/tests/fixture-verifier.test.ts:138` and `:162` plus
the cross-expectation control I ran through the real rule; AC3 by the live sweep and the count pin at
`scripts/tests/rule-fixtures.test.ts:60`; AC4 by `packages/rule-engine/tests/fixture-verifier.test.ts:215`, `:239`,
`:266`, `:292` and by the three live process deformations above; AC5 by the inventory guard at
`scripts/verify-rule-fixtures.ts:436` and the skip-vs-fail pair at
`packages/rule-engine/tests/fixture-verifier.test.ts:343-347`. All five are MET; the honest caveat is the P4 in the
table, which is a *content*-pinning gap, not a cardinality or fail-open gap.

**Review questions asked by the brief.** The wrapper preserves evaluator semantics (records and forwards; per-pair
capture reset before each evaluation; sequential, so no cross-pair bleed). The exit-code judgement is read off the
recorded process, not re-derived from findings. No checked-in fixture is mutated and the report is temp-path-free
(verified above). `test-post-check`'s `&&` cannot hide a failure: `A && B` is non-zero when either side fails, and
the receipt log shows both chained commands executing in order after the tests. The adapter's relative
workspace-source import (`scripts/verify-rule-fixtures.ts:5-12`) is the right call and arguably the safer one: the
root `tsconfig.json` declares no `paths`, `scripts/` has no tsconfig of its own, and every package `exports` targets
an unbuilt `dist/`, so a package-name import would (a) fail without a prior build and (b) once built, risk asserting
against a *stale* `dist` copy of the evaluator instead of the source under change. It is a new convention for
`scripts/` (existing scripts import only local modules), and the comment states the constraint. Architecture: the
reusable evaluation/assertion capability sits in `ts-rule-engine` behind the injected `FileSystem`/`ProcessExecutor`
ports (ADR-011) with no repository knowledge, while enumeration, staging, the package→rule map and the report sit in
`scripts/`, consistent with the existing `scripts/lib/*` node-tooling home and outside `runtime-boundaries`. Both are
the right seams.

## Adversarial mutations (10 attempted on temporary copies; 7 caught, 3 survived)

Each ran `runRuleFixtureChecks` (`scripts/verify-rule-fixtures.ts:496`) against a throwaway repository root holding a
copy of `.spur/rules`; the checked-in corpus was never touched. Baseline on the unmutated copy: `pass=true`, 23/23.

1. Rule disabled (`enabled: false` on `no-clef-driver-import-in-ai-runner`) — CAUGHT by name (2 pairs).
2. Rule file deleted (`verify-confidence.yaml`) — CAUGHT (report `error`, `pass=false`, 0 pairs).
3. Rule retargeted (forbidden specifier `@gobing-ai/ts-decision-clef` → `@gobing-ai/ts-somewhere-else`) — CAUGHT;
   the fixture that documents the rule is what caught the rule edit, which is this task's whole point.
4. `should-fire/no-lifecycle-bus.ts` body replaced with a passing body (name and count preserved) — CAUGHT
   (`expected fire but exit 0 equals successCode 0`).
5. `should-pass/crossfile/.../service.ts` gutted to a no-op export — CAUGHT (`expected pass but exit 1 differs from
   successCode 0`, with the rule's own message retained).
6. Rule command replaced with a missing binary — CAUGHT (5/5 lifecycle pairs).
7. Rule command set to `sleep 5` under a 400 ms timeout — CAUGHT (14/14 pairs).
8. Rule command set to `kill -TERM $$` — CAUGHT (14/14 pairs).
9. `verify-confidence/should-fire/.spur/run/0103-verdict.json` zero-byte, name and count preserved — SURVIVED
   (`pass=true`, 23/23): the rule flags unreadable JSON as a violation, so the `fire` expectation still holds while
   the case's documented subject is gone. The P4 in the table.
10. `lifecycle-bus-propagation/should-fire/events.ts` zero-byte, name and count preserved — SURVIVED (`pass=true`):
    support-file bytes are unpinned, and the violation lives in the asserted source, so the case still fires.

Class not re-tested because it is already known: emptying an expectation directory, deleting a case source and
adding an undeclared case all fail by name today, and a count-preserving substitution of one case for a
differently-named one remains the known advisory.

## Residual risk

The two surfaced gaps (case-body/support-byte content, and substitution) share one root: the gate asserts behaviour,
never fixture bytes. Any body that produces the required outcome satisfies its case, so a fixture can silently stop
testing what its README documents without turning the gate red; a content pin (or a catalogue hash) would close it.
`scripts/` is outside every `tsconfig` project reference, so the 537-line adapter is biome-linted and executed by the
tests but never typechecked — pre-existing for all of `scripts/`, not introduced here. `verifyRuleFixtures`'s failure
text for a missing case workdir interpolates the (temporary) workdir path; unreachable from the adapter today, since
staging always creates the workdir, but it is the one diagnostic that could leak a scratch path into the report if
that ever changed. The `import.meta.main` + `process.exit(report.pass ? 0 : 1)` failure path
(`scripts/verify-rule-fixtures.ts:533-537`) was judged from the source plus the passing CLI's exit 0 and the
`printReport` unit test, not executed end-to-end against a mutated repository root, because the CLI is bound to the
real repository root and mutating checked-in fixtures is out of bounds. The receipt digest mismatch recorded as P4 is
environmental; if the verify stage asserts receipt/proof digest equality, it should compare against the *recomputed*
digest (`0109-gate2.env.sh` / the gate log's refusal line), which is this tree's.

### References

- Parent: docs/features/F1_rule-fixture-verification.md; historical owner task 0053 and boundary task 0108 (existing completed contracts, not scheduling dependencies).
- docs/00_ADR.md ADR-006 (gates) and ADR-011 (runtime seams).
- Current evidence: packages/rule-engine/src/engine.ts, config/loader.ts, evaluators/exit-code-evaluator.ts; package.json; .spur/rules/fixtures/**.
- Refinement: one main worktree, no wip tasks; no dependency on tasks 0110/0111. Existing uncommitted infra changes are outside this spec work.

### History

- 2026-10-12T16:16:12.350Z backlog → todo (system)
- 2026-10-12T17:16:29.744Z todo → wip (system)
- 2026-10-12T17:51:40.713Z wip → testing (system)
- 2026-10-12T17:55:01.781Z testing → wip (system)
- 2026-10-12T18:12:13.748Z wip → testing (system)
- 2026-10-12T18:12:28.116Z testing → done (system)

