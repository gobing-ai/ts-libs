---
schema_version: 1
name: Verify the project rule fixtures against the real evaluators
status: backlog
template: feature-impl
created_at: 2026-10-09T21:50:39.278Z
updated_at: "2026-10-09T21:51:08.624Z"
feature_id: F

priority: P2
---

## 0109. Verify the project rule fixtures against the real evaluators

### Background

Three rule-fixture sets exist in this repo, and **none of them is executed by any gate**. Each
carries a hand-run recipe in a README instead:

| Fixture set | Pins | Run by |
|-------------|------|--------|
| `.spur/rules/fixtures/lifecycle-bus-propagation/` | the `lifecycle-bus-propagation` rule (task 0053) | nothing |
| `.spur/rules/fixtures/decision-boundaries/` | the three task-0108 boundary rules | nothing |
| `.spur/rules/fixtures/verify-confidence/` | the five `verify-confidence-level` assertions | nothing |

The fixtures live under `.spur/`, outside the `packages/**` scopes their rules scan, so
`bun run spur-check` never sees them. A rule edit that breaks a fixture therefore passes every gate
until someone reads the README and re-runs the recipe by hand. This has already happened twice in
one session: the `verify-confidence-level` rule was authored, then rewritten to add two assertions,
and only a hand-run recipe confirmed the fixtures still discriminated.

Evidence for the gap, measured in this session:

- `.spur/rules/fixtures/decision-boundaries/README.md` — recipe is correct and works, but nothing
  invokes it; its own text says the fixtures "are **not** part of any automated gate".
- `.spur/rules/fixtures/verify-confidence/README.md` — same, with a "Known limits" section that
  names the untracked-plane caveat rather than an automated check.
- `.spur/rules/fixtures/lifecycle-bus-propagation/` — the original precedent: `docs/tasks/0053`
  records the fixtures as manual evidence only, with no runner.

The evaluators themselves are already tested (`packages/rule-engine/tests/evaluators/`), so the gap
is specifically the *project's* fixture corpus: no entry point turns
`should-fire`/`should-pass` directories into pass/fail assertions.

Out of scope: rewriting any rule, changing evaluator behavior, or moving fixtures under `packages/`.

### Requirements

- [ ] R1. Provide a fixture-verification entry point that takes a rule file plus its fixture
      directory and asserts every file under `should-fire/` produces at least one finding and every
      file under `should-pass/` produces none, using the real evaluators rather than a re-implemented
      matcher.
- [ ] R2. Cover the three existing fixture sets in this repo
      (`lifecycle-bus-propagation`, `decision-boundaries`, `verify-confidence`) so all of them are
      exercised without a hand-run recipe, and make the check fail when a fixture that should fire
      stops firing or one that should pass starts firing.
- [ ] R3. Handle the exit-code evaluator's shape: it emits exactly one finding for a non-zero exit,
      so a fixture set driven by an `exit-code` rule must assert on exit status and capture the
      command's stdout for diagnostics rather than expecting one finding per file.
- [ ] R4. Treat an absent fixture directory as a pass (nothing to verify) and a present-but-empty
      one as a failure, so the check cannot pass by silently finding no fixtures.
- [ ] R5. Give the failure output the offending fixture path, the rule id, and which expectation was
      violated (expected fire / expected pass), and produce a verifiable, repeatable artifact for the
      run.

Out of scope: authoring new rules, changing rule semantics, and any change to `packages/rule-engine`
evaluator behavior beyond what the entry point needs.

### Acceptance Criteria

```gherkin
Feature: Project rule fixtures are verified by the gate

  Scenario: AC1 — A fixture that should fire and does not fails the check
    Given a rule whose evaluator no longer matches its should-fire fixture
    When the fixture check runs over that rule and fixture directory
    Then the check fails and names the fixture path, its rule id, and "expected fire"

  Scenario: AC2 — A fixture that should pass and does not fails the check
    Given a rule that starts matching its should-pass fixture
    When the fixture check runs over that rule and fixture directory
    Then the check fails and names the fixture path, its rule id, and "expected pass"

  Scenario: AC3 — The three existing fixture sets are exercised
    Given the repository's lifecycle-bus-propagation, decision-boundaries and verify-confidence fixture directories
    When the fixture check runs
    Then all three sets are evaluated with the real evaluators and the run reports a count per set

  Scenario: AC4 — An exit-code rule's fixtures are asserted by exit status
    Given a rule using the exit-code evaluator, which emits one finding for a non-zero exit
    When its should-fire and should-pass fixtures are checked
    Then the should-fire directory exits non-zero and the should-pass directory exits zero
    And the command's stdout is captured when the expectation is violated

  Scenario: AC5 — The check cannot pass vacuously
    Given a fixture directory that is present but contains no fixture files
    When the fixture check runs
    Then the check fails rather than reporting success
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**Placement.** The shortest correct path is a rule-engine capability plus repo wiring, in two steps:

1. `packages/rule-engine` gains the fixture check as a package-owned entry point (a small function or
   CLI over the existing evaluator registry) — F owns this, and it keeps the assertion logic reusable
   by `spur` instead of living in a one-off repo script.
2. This repo wires the three existing fixture directories into the post-check side of the gate.

Rejected alternative: a standalone `scripts/verify-rule-fixtures.ts` that reads `.spur/rules/**`
directly. It is smaller, but it duplicates evaluator dispatch that the rule engine already owns and
puts project-config knowledge into generic builder tooling. Rejected: a `bun test` file under
`packages/rule-engine/tests/` that reaches into the repo's `.spur` tree — that inverts the layering by
making a package test depend on the consuming project's config.

**Fixture contract.** A fixture directory is `<rules-dir>/fixtures/<rule-or-set>/` with `should-fire/`
and `should-pass/` children, as the three existing sets already are. The entry point takes a rule file
(or preset) and the fixture directory, evaluates the real rule against each subtree as the workdir, and
asserts the expectation. `should-fire` files may also need to mirror the real tree shape
(`packages/<pkg>/src/...`) for scope globs to match — all three existing sets already do this, so the
contract is "evaluate from the fixture subtree root", not "evaluate per file".

**Exit-code handling (R3).** `ExitCodeEvaluator` returns one finding for a non-zero exit and none for
the configured success code (`packages/rule-engine/src/evaluators/exit-code-evaluator.ts`), so the
assertion for such a rule is exit-status-based: `should-fire` must exit non-zero, `should-pass` zero,
and the command's stdout is the diagnostic. Per-file expectations apply only to finding-based
evaluators. The existing README recipes already encode this distinction — lift it into the check.

**Vacuous-pass guard (R4).** The check must distinguish "no fixture directory" (pass, the gate is
running in a tree where nothing is declared) from "a declared fixture directory with zero fixture
files" (fail). Without this the check passes in exactly the case it is meant to catch.

**Verification.** The check's own regression proof is mutation: flip one fixture's expectation and
confirm the check fails naming that path, then restore. Record the run as a captured log so the
artifact is repeatable.

### Plan

1. Precondition: re-read `.spur/rules/fixtures/*/README.md` and
   `packages/rule-engine/src/evaluators/` to confirm the contract above still holds, and confirm
   `bun run spur-check` is green on the current `main`.
2. Entry point (R1, R3, R4): add the fixture-verification capability to `packages/rule-engine` over
   the existing evaluator registry, with the exit-code/finding split and the absent-vs-empty directory
   distinction. Unit-test it against synthetic fixture trees, including the mutation case (a flipped
   expectation must fail).
3. Repo wiring (R2, R5): point the check at the three existing fixture directories and wire it into the
   gate, capturing a log with the per-set counts. Confirm each of the three sets is genuinely
   exercised — not silently skipped — by mutating one fixture per set and observing a failure.
4. Confirm the gate: `bun run spur-check` green with the new check present, and the new check failing
   when a fixture expectation is deliberately broken. Inspect the diff for intentional changes only.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
