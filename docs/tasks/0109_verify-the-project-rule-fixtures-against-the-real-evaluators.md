---
schema_version: 1
name: Verify the project rule fixtures against the real evaluators
status: testing
template: feature-impl
created_at: 2026-10-09T21:50:39.278Z
updated_at: "2026-10-12T17:52:46.719Z"
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

- Verdict: PARTIAL (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `verifyRuleFixtures` is exported (`packages/rule-engine/src/index.ts:14`) and implemented at `packages/rule-engine/src/fixture-verifier.ts:81`: physical `loadRuleFile`, one enabled rule against one workdir per pair, fixes off; `judgeCase` (`packages/rule-engine/src/fixture-verifier.ts:174`) requires a genuine violation for fire and zero findings for pass, and an evaluator `kind: 'error'` fails both expectations. Reproduced independently against the real engine and the real rule `.spur/rules/typescript/decision-boundaries.yaml` (id `no-clef-driver-import-in-ai-runner`): matched fire over the should-fire source → `findings=1 pass=true`; matched pass over the should-pass source → `findings=0 pass=true`; the same workdirs under a crossed expectation → `expected fire but the rule reported no violation` and `expected pass but the rule reported 1 violation(s)`. |
| R2 | MET | `package.json:41` runs `bun run verify-rule-fixtures` after the existing `spur rule run --preset recommended-post-check --fail-on warning &&`; `package.json:42` defines the entry point. Live run printed `PASS  lifecycle-bus-propagation  cases 5 (fire 2, pass 3)  failed 0` / `PASS  decision-boundaries  cases 4 (fire 2, pass 2)  failed 0` / `PASS  verify-confidence  cases 14 (fire 8, pass 6)  failed 0` / `rule-fixtures: PASS — 23/23 pair(s) across 3 set(s)` with exit 0, and `.spur/run/rule-fixtures-report.json` records `{"sets":3,"cases":{"total":23,"fire":12,"pass":11},"passed":{"total":23}}`. |
| R3 | MET | Exit-code rules are routed to the exit-status judge (`packages/rule-engine/src/fixture-verifier.ts:185` → `packages/rule-engine/src/fixture-verifier.ts:197`), which reads the captured `ProcessResult` recorded by the wrapped `run()` and compares `exitCode` against the configured `successCode` (default 0); `exitCode === null` or `outcome !== 'exit'` fails regardless of expectation (`packages/rule-engine/src/fixture-verifier.ts:206`), and `processDiagnostics` retains the recorded stdout/stderr (`packages/rule-engine/src/fixture-verifier.ts:233`). Repo-level control on a temporary copy of the exit-code-typed lifecycle set (crossfile parenting file `service.ts` deleted): `expected pass but exit 1 differs from successCode 0` with `stdout: lifecycle-bus-propagation: no parented EventBus path; add lifecycleBus and construct new EventBus({ lifecycleBus }): packages/demo/src/options.ts:17`, recorded process `{"exitCode":1,"outcome":"exit"}`. |
| R4 | MET | Absent optional `fixtureDir` → `{ pass: true, skipped: true, cases: [] }` (`packages/rule-engine/src/fixture-verifier.ts:87`); present-but-empty case set → `pass: false` (`packages/rule-engine/src/fixture-verifier.ts:88`); unknown or disabled rule ID → `is not an enabled rule` (`packages/rule-engine/src/fixture-verifier.ts:139`); absent case workdir or missing case source → named failure (`packages/rule-engine/src/fixture-verifier.ts:159`). The repository adapter requires all three set directories and both expectation classes (`scripts/verify-rule-fixtures.ts:227`) and fails a reduced or grown inventory by name (`scripts/verify-rule-fixtures.ts:438`). Reproduced on temporary copies: set directory removed → `declared fixture directory "lifecycle-bus-propagation" is missing`; `verify-confidence/should-fire` emptied → `declared case inventory mismatch for "verify-confidence/should-fire": declared 8 case(s), found 0`; one case source deleted → `declared 6 case(s), found 5`; undeclared case added → `declared 2 case(s), found 3`. |
| R5 | MET | Deterministic diagnostics plus a machine-readable report are produced by `runRuleFixtureChecks` (`scripts/verify-rule-fixtures.ts:496`) and rendered by `printReport` (`scripts/verify-rule-fixtures.ts:513`), which names set, source, rule ID and expectation for every failing pair; captured streams are bounded (`scripts/verify-rule-fixtures.ts:362`) and the scratch root is removed in `finally`. Two consecutive `bun run verify-rule-fixtures` runs produced byte-identical `.spur/run/rule-fixtures-report.json` (`cmp` exit 0) with zero matches for `ts-libs-rule-fixtures-`, `/tmp/` or `/var/folders`; no `ts-libs-rule-fixtures-*` scratch directory survived; `git status --porcelain .spur/rules/fixtures` lists only the two README targets, so no case file was mutated; in a temporary repository copy the CLI exited 1 on a mutated fixture and still wrote the report. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — A fixture that should fire and does not fails the check (req: R1) | MET | test | `packages/rule-engine/tests/fixture-verifier.test.ts:138` passes and asserts `pass=false` with `expected fire` and `no violation` on the named case. Independent control through the real rule at `packages/rule-engine/src/fixture-verifier.ts:174`: a clean workdir with `expect: 'fire'` returned `pass=false findings=0 :: expected fire but the rule reported no violation`. An evaluator error cannot satisfy the violation either — `packages/rule-engine/tests/fixture-verifier.test.ts:183` passes, and `packages/rule-engine/src/fixture-verifier.ts:181` returns `evaluator error: …` before the fire branch. |
| AC2 — A fixture that should pass and does not fails the check (req: R1) | MET | test | `packages/rule-engine/tests/fixture-verifier.test.ts:162` passes and asserts `expected pass`, `1 violation` and `findings` length 1. Independent control: the violating source staged into a workdir with `expect: 'pass'` returned `pass=false findings=1 :: expected pass but the rule reported 1 violation(s)` through the real evaluator, naming the source path and rule ID. |
| AC3 — The three existing fixture sets are exercised (req: R2, R5) | MET | test | `bun run verify-rule-fixtures` (exit 0) reported all three sets with per-set and per-expectation counts — lifecycle 5 (fire 2, pass 3), decision-boundaries 4 (2, 2), verify-confidence 14 (8, 6) — and `rule-fixtures: PASS — 23/23 pair(s) across 3 set(s)`; `scripts/tests/rule-fixtures.test.ts:60` pins the same counts and the written report. Mutations in each set fail: `scripts/tests/rule-fixtures.test.ts:83`, `scripts/tests/rule-fixtures.test.ts:105`, `scripts/tests/rule-fixtures.test.ts:122` invert one case per set, and in a temporary repository copy the real CLI `bun scripts/verify-rule-fixtures.ts` exited 1 per set — lifecycle `declared case inventory mismatch for "lifecycle-bus-propagation/should-fire": declared 2 case(s), found 1`, decision-boundaries `mismatch for "decision-boundaries/should-fire": declared 2 case(s), found 1`, verify-confidence `mismatch for "verify-confidence/should-pass": declared 6 case(s), found 5` — each writing `{"pass":false,"error":"declared case inventory mismatch …"}` to the report path. |
| AC4 — An exit-code rule's fixtures are asserted by exit status (req: R3) | MET | test | `packages/rule-engine/src/fixture-verifier.ts:197` judges the recorded `ProcessResult` rather than the findings: `packages/rule-engine/tests/fixture-verifier.test.ts:215` (non-default `successCode: 1`) asserts `successCode 1` on mismatch and `processes[0].exitCode === 1`; `packages/rule-engine/tests/fixture-verifier.test.ts:239` accepts differing/equal exits for the fire/pass halves against `successCode 0`; `packages/rule-engine/tests/fixture-verifier.test.ts:266` asserts stdout/stderr retention; `packages/rule-engine/tests/fixture-verifier.test.ts:292` asserts timeout, spawn error and launch failure fail even for expected fire. Repo-level control: the exit-code-typed `lifecycle-bus-propagation` set failed only through recorded exit `1` vs `successCode 0` (`{"exitCode":1,"outcome":"exit"}`) after the crossfile parenting file was deleted, with the evaluator stdout retained. |
| AC5 — The check cannot pass vacuously (req: R4) | MET | test | Adversarial runs of the real adapter `runRuleFixtureChecks` (`scripts/verify-rule-fixtures.ts:496`) against temporary repository copies: (d) unmutated copy → `pass=true` 23/23; (a) `verify-confidence/should-fire` emptied with the directory kept → `pass=false` `declared 8 case(s), found 0`; (b) one case source `.spur/memory/evidence/0204-verdict.json` deleted → `pass=false` `declared 6 case(s), found 5`; (c) undeclared `decision-boundaries/should-pass/packages/ai-runner/src/extra.ts` added → `pass=false` `declared 2 case(s), found 3`; plus a removed declared set directory → `pass=false` `declared fixture directory "lifecycle-bus-propagation" is missing`. The inventory guard sits at `scripts/verify-rule-fixtures.ts:438` inside `collectReport`, before staging and evaluation, so it throws and the CLI exits 1; pinned by `scripts/tests/rule-fixtures.test.ts:320`, `scripts/tests/rule-fixtures.test.ts:331` and `scripts/tests/rule-fixtures.test.ts:341`. Library half: absent optional directory skips while an existing empty case set fails (`packages/rule-engine/tests/fixture-verifier.test.ts:338`, `packages/rule-engine/tests/fixture-verifier.test.ts:353`). |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

| Priority | Anchor | Finding | Disposition |
| --- | --- | --- | --- |
| P1 (blocker) | — | none | — |
| P2 (major) | — | none | — |
| P3 (minor) | — | none | — |
| P4 (advisory) | `scripts/verify-rule-fixtures.ts:76` | Count-only inventory: a count-preserving case substitution still passes; and one file inside the sole multi-file case (`should-pass/crossfile`) can be deleted while the case stays counted and green. Hardening, not a contract failure — a per-case name or file inventory would close both. | DEFER |

**Verdict: PASS.** No open P1–P3 finding. Requirements R1–R5 are implemented, wired, and reproduced; the round-1 escape is closed.

**Round-1 P3 — closed, reproduced independently (temporary repository copies via `runRuleFixtureChecks`).**
- Emptying `verify-confidence/should-fire` (directory kept): `pass=false`, `declared case inventory mismatch for "verify-confidence/should-fire": declared 8 case(s), found 0` (round 1: `pass: true`, fire 12 → 4).
- Emptying both `verify-confidence` expectation directories: `pass=false` with the same named mismatch (round 1: `pass: true`, 9 pairs).
- Deleting a single case source (`should-pass/.spur/memory/evidence/0204-verdict.json`): `pass=false`, `declared 6 case(s), found 5`; the lifecycle `should-fire` variant reports `declared 2 case(s), found 1`. Round 1: `pass: true` with 22 pairs.
- Adding an undeclared case (`decision-boundaries/should-pass/packages/ai-runner/src/extra.ts`): `pass=false`, `declared 2 case(s), found 3`. The report is written on every failing path, and `printReport` renders the single named reason before the CLI exits nonzero.
- The check sits at `scripts/verify-rule-fixtures.ts:436` inside `collectReport`, before staging and evaluation, and throws — so it cannot be skipped by a later stage. The three new tests at `scripts/tests/rule-fixtures.test.ts:319-352` assert exactly these messages, and `bun test` on the two test files is 31 pass / 0 fail / 100 expect() calls (round-1 digest: 28). The failure text names the set, expectation class, declared count and found count, which satisfies R4's "fails by name" and the diagnostics half of R5.

**Traceability of R1–R5 (executable evidence, not prose).**
- R1 `packages/rule-engine/src/fixture-verifier.ts:81` + `packages/rule-engine/src/index.ts:14`: exported verifier, one rule against one workdir, fixes off, genuine violation required for fire, zero findings for pass, evaluator `kind: 'error'` (`:178`) fails both expectations. A synthetic `not-a-builtin` evaluator case cannot satisfy expected fire (`packages/rule-engine/tests/fixture-verifier.test.ts:183`).
- R2 `package.json:41-42`: `verify-rule-fixtures` is appended to `test-post-check` after the rule preset. Live run: lifecycle 5 (fire 2, pass 3), decision-boundaries 4 (2, 2), verify-confidence 14 (8, 6) — 23/23, exit 0. Per-set and per-expectation counts appear both in stdout and in `.spur/run/rule-fixtures-report.json`.
- R3 `fixture-verifier.ts:197-241`: the judge reads the *recorded* `ProcessResult` (`exitCode`, `outcome`, `signal`) captured by the `run()` wrapper (`:103-113`), with `successCode` read as `ExitCodeEvaluator` reads it; `runStreaming` is delegated unchanged. Timeout, `outcome: 'error'`, spawn throw, signal and evaluator error all fail regardless of expectation (`packages/rule-engine/tests/fixture-verifier.test.ts:292`), and stdout/stderr are retained in the diagnostic (`:233`). Independent control mutation — deleting the crossfile parenting file `service.ts` — is caught with `expected pass but exit 1 differs from successCode 0` and the rule's message in stdout.
- R4 `fixture-verifier.ts:88` (empty case set fails), `:165` (missing source / workdir fails), `:130` (unknown or disabled rule ID fails), `:85` (absent optional directory → explicit skip); adapter `scripts/verify-rule-fixtures.ts:227` requires all three set directories **and** both expectation classes, `:203` fails an unrecognized shape, `:436` fails a reduced *or* grown inventory. The library-level skip-vs-fail pair is pinned by `packages/rule-engine/tests/fixture-verifier.test.ts:343-347`.
- R5 report at `.spur/run/rule-fixtures-report.json`: byte-identical across two consecutive runs, no `ts-libs-rule-fixtures-`, `/tmp/` or `/var/folders` string anywhere in it, `finally` cleanup of the scratch root verified by `scripts/tests/rule-fixtures.test.ts:161`, and no checked-in fixture is ever written — staging is `copyFile` reads only, confirmed by `git status --porcelain` (only the six modified files plus the four new files under review) and by the byte-identity assertions in `scripts/tests/rule-fixtures.test.ts:83`.

**Review-dimension verdicts.**
- *Wrapper preserves evaluator semantics*: yes. It records the original result and returns it unchanged; `ProcessExecutor` has exactly `run`/`runStreaming`, both forwarded; the per-pair capture is reset before each evaluation and evaluation is sequential, so no cross-pair bleed. The exit-code judgement is read off the recorded process, not re-derived from findings (`fixture-verifier.ts:185`).
- *No fixture mutation, no temp leakage*: confirmed. Scratch roots are `mkdtemp` under the OS temp dir, removed in `finally` on both paths, and the report is path-clean.
- *Relative workspace-source imports in the adapter*: correct call, not a defect. The root `tsconfig.json` declares no `paths`, `scripts/` has no tsconfig, and every package `exports` points at an unbuilt `dist/`, so a package-name import cannot resolve without a prior build. The comment at `scripts/verify-rule-fixtures.ts:5-8` states exactly this constraint.
- *Gate order*: `spur rule run --preset recommended-post-check --fail-on warning && bun run verify-rule-fixtures` short-circuits on the left operand, so neither command can mask the other. Receipt `.spur/run/0109-check-receipt.json` is status PASS at `inputDigest sha256:32a91859…`, and the log shows 2976 pass / 0 fail plus both chained commands; the receipt (10:37:45) postdates the adapter edit (10:34:03), so the wired gate ran against the fixed code.
- *Architecture*: right seam and right owner. Evaluation/assertion lives in `ts-rule-engine` behind the injected `FileSystem`/`ProcessExecutor` ports (`ADR-011`); repository enumeration, staging, the package→rule map and the report live in `scripts/`, outside the `runtime-boundaries` include and alongside the existing `scripts/lib/build.ts` node-tooling convention.

**Adversarial mutations — 8 attempted on temporary repository copies, 4 caught, 3 surviving in the count-preserving-substitution class, 1 rejected as out of scope.**
1. Empty `verify-confidence/should-fire` — CAUGHT (8 declared vs 0 found).
2. Empty both `verify-confidence` expectation directories — CAUGHT (the round-1 headline defect).
3. Delete one `should-pass` case source — CAUGHT (6 declared vs 5 found).
4. Delete the crossfile parenting file `service.ts` — CAUGHT (`expected pass but exit 1 differs from successCode 0`).
5. Swap a `verify-confidence` fire case for an equal-content copy under a new name — SURVIVED: `pass=true`, 23/23 → P4 (count-only inventory).
6. Swap a `decision-boundaries` ai-runner fire case name — SURVIVED: `pass=true`, 23/23 → P4.
7. Swap the decision-clef fire case name — SURVIVED: `pass=true`, 23/23 → P4.
8. Delete the crossfile declaration file `options.ts`, then strip the case to `events.ts` only — SURVIVED: `pass=true`, 23/23, crossfile row `findings: 0` → P4 (within-case file inventory unpinned).
Rejected candidate: adding an offending file at the crossfile workdir root survived because the file lands outside the rule's `packages/**` scan scope by construction — a property of the rule, not a gate escape.

**P4 detail.**
- `scripts/verify-rule-fixtures.ts:76` with `:436`: `expected` holds per-expectation *counts*. A deleted case replaced by an undeclared same-class case keeps the count, so mutations 5–7 pass with 23/23. No integrity loss in kind — each substitute is still a genuinely asserted case, and the pair count never shrinks — but case *identity* is not pinned, so the Solution's "fails by name" guarantee is a cardinality guarantee. Pinning the declared names (or a sorted manifest) would make it name-based.
- `scripts/verify-rule-fixtures.ts:274`: the crossfile case is one declared case whose files are unpinned, so mutation 8 leaves the case counted while its subject is gone. The flat lifecycle case is protected (`events.ts` is required, and its source deletion reduces the count), so the blast radius is one case of 23 and requires a deliberate fixture edit. No R4/AC5 clause is false: the declared directory, the declared case source and the case count are all intact.
- `scripts/verify-rule-fixtures.ts:455` with `:468`: `verification.pass`/`skipped` are still not consulted; `report.pass` is recomputed from rows. Harmless today (every case yields exactly one row, all declared counts are non-zero, and `results.length > 0` is required), but an explicit `verification.pass` guard would make that equivalence explicit instead of incidental — this redundancy is what allowed the round-1 escape.
- `scripts/verify-rule-fixtures.ts:362` with `:384`: `boundedStream` bounds stdout/stderr only; `violations[].message` is copied verbatim, so report size tracks finding messages (18 KB for 23 pairs today, deterministic and accepted).

**Residual risk.** The wired gate cannot detect count-preserving fixture substitution, nor deletion of a file inside the one multi-file case (P4-1/P4-2), so the corpus regression pin at `scripts/tests/rule-fixtures.test.ts:67` remains the only end-to-end guard against those two shapes. `scripts/` is covered by no `tsc --noEmit` gate, so adapter type regressions surface at test runtime only (pre-existing for all of `scripts/`). Report size tracks finding messages, not just the bounded streams. The CLI's exit-1-on-failure path was judged from the three-line `import.meta.main` guard plus the failure reports written by `runRuleFixtureChecks`, not executed end-to-end against a mutated repository, because the CLI binds to the real repository root and mutating checked-in fixtures is out of bounds.

### References

- Parent: docs/features/F1_rule-fixture-verification.md; historical owner task 0053 and boundary task 0108 (existing completed contracts, not scheduling dependencies).
- docs/00_ADR.md ADR-006 (gates) and ADR-011 (runtime seams).
- Current evidence: packages/rule-engine/src/engine.ts, config/loader.ts, evaluators/exit-code-evaluator.ts; package.json; .spur/rules/fixtures/**.
- Refinement: one main worktree, no wip tasks; no dependency on tasks 0110/0111. Existing uncommitted infra changes are outside this spec work.

### History

- 2026-10-12T16:16:12.350Z backlog → todo (system)
- 2026-10-12T17:16:29.744Z todo → wip (system)
- 2026-10-12T17:51:40.713Z wip → testing (system)

