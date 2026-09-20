---
schema_version: 1
name: "DecisionMaker facade: factory, batch ask, and single-question sugar"
status: wip
template: feature-impl
created_at: 2026-09-20T05:08:59.652Z
updated_at: "2026-09-20T06:58:01.623Z"
feature_id: A2
priority: P2
tags:
  - ai-runner
  - decision-maker
  - facade

dependencies: ["0070"]
---

## 0071. DecisionMaker facade: factory, batch ask, and single-question sugar

### Background

The public surface, and the task that carries the feature's central design
decision: `choice`, `score`, and `noul` are implemented **once, here**, as `ask()` with a
single-entry question map. They are not part of the driver contract.

That split is what makes the deferred local-model and traditional-LLM drivers cheap — each has to
satisfy one batch entry point rather than re-deriving three conveniences — and it means the sugar
can never drift from the batch path, because there is only one code path underneath.

The facade is also where the feature's provider independence is proven: every requirement in this
task is testable against a hand-written fake driver, with no SDK involvement at all. If this task's
tests pass without `@typesafe-ai/sdk` in the picture, the seam is real rather than nominal.

### Requirements

- [ ] R1. Create `packages/ai-runner/src/decision/decision-maker.ts` exporting the
      `DecisionMaker` interface, `DecisionMakerOptions`, and `createDecisionMaker(options?)`.
- [ ] R2. `DecisionMaker` exposes a readonly `driver` name plus `ask`, `choice`, `score`, and
      `noul`, with the signatures given in `docs/design/decision-maker.md`.
- [ ] R3. `ask({ state, questions, model? })` forwards to the driver unchanged and narrows the driver's
      loose return to `AnswersFor<Q>` with a single documented cast — the questions map is passed
      through without reordering, renaming, or dropping entries.
- [ ] R4. `choice(state, prompt, labels)` calls `ask` with exactly one question built by `q.choice`
      and resolves to that single `ChoiceAnswer<L>` — not a map keyed by question name. `score` and
      `noul` behave analogously.
- [ ] R5. The three sugar methods are implemented in terms of `ask`; none issues its own driver call or
      duplicates request assembly.
- [ ] R6. `createDecisionMaker` resolves its driver from `options.driver` when supplied. The default
      driver is the TypeSafe driver, constructed lazily so that supplying a custom driver never
      constructs it and never requires a key.
- [ ] R7. Key resolution is `options.apiKey ?? (options.env ?? getProcessEnv()).TYPESAFE_API_KEY`,
      following the convention at `src/doctor-runner.ts:107` and `:220`. A missing key throws
      `DecisionConfigError` naming `TYPESAFE_API_KEY` before any request is issued.
- [ ] R8. No file in this task reads `process.env` or `Bun.env` directly — `env-var-hygiene` must
      stay green.
- [ ] R9. No import of `@typesafe-ai/sdk` in this file.

### Acceptance Criteria

```gherkin
  @core
  Scenario: R1 — createDecisionMaker returns a DecisionMaker with the four members
    Given the ts-ai-runner package barrel
    When createDecisionMaker is called with no arguments
    Then it returns an object exposing ask, choice, score, and noul
    And the returned value is typed as DecisionMaker with the TypeSafe driver selected by default

  @core
  Scenario: R3 — choice, score, and noul are single-question sugar over ask
    Given a DecisionMaker backed by the TypeSafe driver with an injected fetch
    When choice, score, or noul is called with a state and one question
    Then each issues exactly one systemOne request containing exactly one question
    And each resolves to that primitive's answer directly rather than to a map keyed by question name

  @core
  Scenario: R6 — a missing key fails before any request is issued
    Given an env record with no TYPESAFE_API_KEY and no key passed in options
    When a DecisionMaker is created and ask is called
    Then it rejects with a package-level configuration error naming the missing variable
    And the injected fetch is never invoked

  @core
  Scenario: R8 — the driver seam accepts an alternate backend with no caller change
    Given a hand-written test driver that satisfies the DecisionMaker driver contract without importing @typesafe-ai/sdk
    When createDecisionMaker is given that driver and caller code calls ask, choice, score, and noul
    Then every call resolves through the test driver
    And the caller code compiles and passes unchanged against both drivers
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-20T05:16:52.960Z

**The sugar lives in the facade, not the driver.** The load-bearing decision, settled during
planning. Considered putting `choice` / `score` / `noul` in the driver contract, rejected:
every future backend would re-derive three conveniences instead of one batch method, and the sugar
could drift from the batch path. Here there is exactly one code path underneath.

**Batch-first `ask` rather than per-primitive-only.** The original ask named only
`createDecisionmaker` / `choice` / `noul` / `score`. Reshaped during planning: the backing
API evaluates N named questions against one shared state in a single call, so a per-primitive-only
surface would cost one round trip per question and re-upload the state each time. The named methods
survive as sugar, so nothing in the original ask was dropped.

**Key resolution in the factory, not the driver.** Reuses the `options.env ?? getProcessEnv()`
convention already at `src/doctor-runner.ts:107` and the `{PROVIDER}_API_KEY` lookup at
`:220`. Considered `getEnvVar` from `packages/utils/src/env.ts` — the actual env gateway —
rejected because it would add a new internal dependency to reach a path `runtime/config.ts`
already sits atop. Hoisting resolution to the factory also makes the missing-key failure precede
any driver or client construction.

**Lazy default driver.** An eagerly constructed TypeSafe driver would demand a key even when the
caller supplied their own driver, breaking the fake-driver tests and any future local driver.

**One documented cast at the facade boundary.** Narrowing `Record<string, Answer>` to
`AnswersFor<Q>` cannot be proven to the compiler without duplicating the driver's runtime
contract in types. One commented cast in one place is the trade for trivial drivers.

**Premises.** Every requirement in this task is provable against a hand-written fake driver with no
SDK involvement — if these tests pass without `@typesafe-ai/sdk` in the picture, the seam is real
rather than nominal; and `getProcessEnv()` from `ts-runtime` is already a dependency of this
package, so no manifest change is needed here.

### Design

**WHAT** — one file implementing the four public members over the one-method driver
seam, plus factory-level driver selection and key resolution.

**WHY the sugar lives in the facade, not the driver** — the load-bearing decision of the feature.
A driver implements `ask` and nothing else. Consequences: a new
backend is one method; the sugar cannot diverge from the batch path; and the conditional-type
machinery exists in exactly one place.

**WHY `ask` passes the questions map through untouched** — the whole point of the batch path is
one request carrying N questions against one shared state. Any reordering or per-question splitting
in the facade would silently reintroduce the round-trip-per-question cost the design exists to
avoid. R3's test asserts the map arrives intact.

**WHY the default driver is lazy** — an eagerly constructed TypeSafe driver would demand a
`TYPESAFE_API_KEY` even when the caller supplied their own driver, which would make the fake-driver
tests (and any future local driver) require a credential they never use.

**WHY key resolution lives in the factory rather than the driver** — it is the same
injected-env convention `doctor-runner` already uses, and hoisting it means the missing-key failure
happens before any driver or client is constructed, satisfying "no request issued" cleanly.

**WHY the single cast** — narrowing `Record<string, Answer>` to `AnswersFor<Q>` cannot be proven
to the compiler without duplicating the driver's runtime contract in types. One cast at one
boundary, commented, is the honest trade for drivers that stay trivial.

### Plan

1. Write the `DecisionMaker` and `DecisionMakerOptions` declarations against the
   design document's signatures.
2. Implement `ask` as a driver passthrough with the documented narrowing cast.
3. Implement `choice`, `score`, and `noul` as single-entry `ask` calls that unwrap the one
   answer.
4. Implement `createDecisionMaker`: driver selection, lazy default, key resolution via
   `options.env ?? getProcessEnv()`, `DecisionConfigError` on a missing key.
5. Write a fake driver in the test tree that records the requests it receives and returns canned
   answers, importing no SDK.
6. Test against the fake driver: batch passthrough fidelity, one-question-per-sugar-call, unwrapped
   sugar returns, sugar-delegates-to-ask, lazy default construction, missing-key failure before any
   driver call.
7. Run typecheck, tests, and `bun run spur-check`.

### Solution

- `packages/ai-runner/src/decision/decision-maker.ts` — `DecisionMaker` (readonly `driver` name +
  `ask`/`choice`/`score`/`noul` per design-doc signatures), `DecisionMakerOptions`, and
  `createDecisionMaker`. `ask` forwards the request object unchanged to the driver and narrows
  `Record<string, Answer>` to `AnswersFor<Q>` with one documented cast (R3). The three sugar
  methods each call `ask` with exactly one `q.*` question and unwrap `answers.question` — no second
  driver call, no duplicated request assembly (R4/R5). Driver resolution is lazy: a
  caller-supplied driver short-circuits before key resolution; otherwise the TypeSafe driver is
  constructed once on first use after key resolution succeeds (R6). Key resolution is
  `options.apiKey ?? (options.env ?? getProcessEnv()).TYPESAFE_API_KEY` (doctor-runner convention),
  throwing `DecisionConfigError(message, 'TYPESAFE_API_KEY')` — the two-arg ctor, not the design
  doc's stale one-arg snippet — before any construction or request (R7).
- `packages/ai-runner/src/decision/typesafe-driver.ts` — 0072's factory slot only:
  `createTypesafeDriver(config)` signature + `TypesafeDriverConfig` (the wiring 0071 owns); body
  throws until 0072 fills in client wiring and neutral⇄SDK mapping. File is the boundary rule's
  designated sole SDK zone.
- `packages/ai-runner/src/index.ts` — barrel export of decision-maker members.
- No `process.env`/`Bun.env` reads (R8); no SDK import outside the designated driver file (R9).

### Testing

`packages/ai-runner/tests/decision/decision-maker.test.ts` — 10 tests, all SDK-free against a
hand-written fake driver: no-arg factory returns the four members with driver `typesafe` (AC R1);
lazy default never constructs at creation; missing key rejects `ask` with `DecisionConfigError`
naming `TYPESAFE_API_KEY`, injected fetch never invoked (AC R6); injected-env key and explicit
`apiKey` override both pass resolution; batch passthrough forwards state/questions/model unchanged
(same `questions` reference) with type-level `AnswersFor<Q>` narrowing proofs (AC R3); each sugar
method issues exactly one driver call carrying exactly one question of the right kind and resolves
to the unwrapped answer (AC R3/R4/R5); a custom driver with no key anywhere serves all four members
(AC R8). Verified: `bun run typecheck` clean, `bun test tests/decision/` 22 pass / 0 fail across the
decision suite, `bun run spur-check` clean (repo gate).

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-20T06:58:01.623Z todo → wip (system)

