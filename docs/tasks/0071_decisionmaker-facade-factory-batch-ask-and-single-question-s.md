---
schema_version: 1
name: "DecisionMaker facade: factory, batch ask, and single-question sugar"
status: done
template: feature-impl
created_at: 2026-09-20T05:08:59.652Z
updated_at: "2026-09-20T18:03:00.997Z"
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

- [x] R1. Create `packages/ai-runner/src/decision/decision-maker.ts` exporting the
      `DecisionMaker` interface, `DecisionMakerOptions`, and `createDecisionMaker(options?)`.
- [x] R2. `DecisionMaker` exposes a readonly `driver` name plus `ask`, `choice`, `score`, and
      `noul`, with the signatures given in `docs/design/decision-maker.md`.
- [x] R3. `ask({ state, questions, model? })` forwards to the driver unchanged and narrows the driver's
      loose return to `AnswersFor<Q>` with a single documented cast — the questions map is passed
      through without reordering, renaming, or dropping entries.
- [x] R4. `choice(state, prompt, labels)` calls `ask` with exactly one question built by `q.choice`
      and resolves to that single `ChoiceAnswer<L>` — not a map keyed by question name. `score` and
      `noul` behave analogously.
- [x] R5. The three sugar methods are implemented in terms of `ask`; none issues its own driver call or
      duplicates request assembly.
- [x] R6. `createDecisionMaker` resolves its driver from `options.driver` when supplied. The default
      driver is the TypeSafe driver, constructed lazily so that supplying a custom driver never
      constructs it and never requires a key.
- [x] R7. Key resolution is `options.apiKey ?? (options.env ?? getProcessEnv()).TYPESAFE_API_KEY`,
      following the convention at `src/doctor-runner.ts:107` and `:220`. A missing key throws
      `DecisionConfigError` naming `TYPESAFE_API_KEY` before any request is issued.
- [x] R8. No file in this task reads `process.env` or `Bun.env` directly — `env-var-hygiene` must
      stay green.
- [x] R9. No import of `@typesafe-ai/sdk` in this file.

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

Change-map for commit 62137d1 (implement hop; spur-check clean, 2297 pass / 0 fail):

| Change (`file:line`) | What |
|----------------------|------|
| `packages/ai-runner/src/decision/decision-maker.ts:18` | DecisionMaker interface + DecisionMakerOptions:44 — design-doc signatures (R1,R2) |
| `packages/ai-runner/src/decision/decision-maker.ts:97` | ask forwards request unchanged; single documented `as` narrows Record<string,Answer> to AnswersFor<Q> at :107 (R3) |
| `packages/ai-runner/src/decision/decision-maker.ts:141` | choice/score/noul sugar over ask, one q.* question under key `question`, unwrapped directly (R4,R5) |
| `packages/ai-runner/src/decision/decision-maker.ts:66` | Key resolution options.apiKey ?? (options.env ?? getProcessEnv()).TYPESAFE_API_KEY; two-arg DecisionConfigError at :69 before construction (R7) |
| `packages/ai-runner/src/decision/decision-maker.ts:88` | Lazy default-driver slot `defaultDriver ??=`; options.driver short-circuits key resolution (R6) |
| `packages/ai-runner/src/decision/typesafe-driver.ts:16` | Factory slot only: createTypesafeDriver(config) signature + TypesafeDriverConfig; zero SDK imports, body throws until 0072 |
| `packages/ai-runner/src/index.ts:6` | Barrel export decision-maker (stub intentionally not exported) |
| `packages/ai-runner/tests/decision/decision-maker.test.ts:46` | 11 new tests: 4 @core AC scenarios via fake driver/spyFetch, lazy construction, missing-key pre-request rejection (R1-R9) |

R8/R9 by construction: no env reads outside getProcessEnv() injection; no SDK imports in 0071 files.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/ai-runner/src/decision/decision-maker.ts:23` (`DecisionMaker`), `:45` (`DecisionMakerOptions`), `:83` (`createDecisionMaker(options = {})`) — re-read this run |
| R2 | MET | `decision-maker.ts:25` readonly `driver: string`; `ask` `:27-31`, `choice` `:33-37`, `score` `:39`, `noul` `:41` — signatures match `docs/design/decision-maker.md:103-114`; `bunx tsc --noEmit` exit 0 (this run) |
| R3 | MET | `decision-maker.ts:107` — `resolveDriver().ask(req)` forwards the request object untouched (comment `:105-106`); single documented cast `:113` with rationale `:108-112`; passthrough-fidelity + narrowing tests in `tests/decision/decision-maker.test.ts` (10 pass / 0 fail this run) |
| R4 | MET | `decision-maker.ts:122-127` — each sugar is one `ask({ state, questions: { question: q.*(...) } })` unwrapped via `.then((a) => a.question)`; sugar tests assert exactly 1 driver call and the unwrapped answer (10-pass run) |
| R5 | MET | `decision-maker.ts:116-128` — all three sugar methods call the same inner `ask` closure; the only driver call site in the file is `:107` inside `ask` (re-read confirms no duplicated request assembly) |
| R6 | MET | `decision-maker.ts:88` `if (options.driver) return options.driver;` short-circuits before key resolution; `:89` lazy `defaultDriver ??=` constructed only on first use without a custom driver; custom-driver-without-key tests in the 10-pass run |
| R7 | MET | `decision-maker.ts:66-67` exactly `options.apiKey ?? (options.env ?? getProcessEnv()).TYPESAFE_API_KEY`; two-arg `DecisionConfigError(..., 'TYPESAFE_API_KEY')` `:69-72` thrown inside `resolveDriver` before any construction/request; convention matches `src/doctor-runner.ts:107,220`; missing-key + explicit-key-wins tests in the 10-pass run |
| R8 | MET | `grep -n 'process\.env\\|Bun\.env' src/decision/*.ts` (this run) → zero matches; only sanctioned `getProcessEnv()` from `@gobing-ai/ts-runtime` (`decision-maker.ts:7,66`) |
| R9 | MET | `grep -ln "from '@typesafe-ai/sdk'" src/decision/*.ts` (this run) → only `typesafe-driver.ts` (the rule-excluded driver file); `decision-maker.ts` imports are `@gobing-ai/ts-runtime` + `./errors` + `./types` + `./typesafe-driver` only |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R1 — createDecisionMaker returns a DecisionMaker with the four members | MET | test | `tests/decision/decision-maker.test.ts` — `createDecisionMaker()` with no args exposes ask/choice/score/noul as functions and reports `driver === 'typesafe'` (lazy slot `:86-98` means no key needed at creation); return typed `DecisionMaker` (tsc exit 0); 10 pass / 0 fail this run |
| Scenario: R3 — choice, score, and noul are single-question sugar over ask | MET | test | decision-maker.test.ts sugar tests — each of choice/score/noul issues exactly one driver call whose questions map has exactly the key 'question' with the right kind, resolving to the unwrapped answer not a map. Exercised against the spec-sanctioned fake driver (spec Premises: every requirement provable with no SDK; R9 forbids SDK here — TypeSafe transport variant is 0072) |
| Scenario: R6 — a missing key fails before any request is issued | MET | test | decision-maker.test.ts — `createDecisionMaker({env:{}, fetch: spyFetch})` ask rejects `DecisionConfigError` with `.variable === 'TYPESAFE_API_KEY'`; spyFetch never invoked. Key resolution (`:66-72`) precedes driver construction (`:89`) precedes any ask |
| Scenario: R8 — the driver seam accepts an alternate backend with no caller change | MET | test | decision-maker.test.ts — SDK-free fake driver named 'alternate' supplied via options with no key anywhere; all four members resolve through it; package compiles against both drivers (`bunx tsc --noEmit` exit 0 this run) |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0071

**Scope:** commit 62137d1 — `decision-maker.ts`, `typesafe-driver.ts` (stub), `src/index.ts`, `tests/decision/*`
**Dimensions:** functional, security, efficiency, correctness, usability, architecture
**Verdict:** PASS

##### Findings (ranked)

| # | Priority | Dimension | Finding | Location |
|---|----------|-----------|---------|----------|
| 1 | P4 (advisory) | correctness | Stub body throws a plain `Error`, not a `DecisionError` subclass — escapes the package error taxonomy until 0072 fills the body. Documented (`ponytail:` comment) and pinned by test; intentional for 0071. | `packages/ai-runner/src/decision/typesafe-driver.ts:17` |
| 2 | P4 (advisory) | functional | AC R3's Given ("TypeSafe driver with an injected fetch") is exercised against the hand-written fake driver; the TypeSafe-transport variant of the sugar shape lands with 0072's client. Sanctioned by the spec's own SDK-free premise (R9, Q&A "every requirement provable against a fake driver"). | `packages/ai-runner/tests/decision/decision-maker.test.ts:144-176` |
| 3 | P4 (advisory) | usability | Design doc's key-resolution snippet shows one-arg `DecisionConfigError('TYPESAFE_API_KEY')`, which does not compile against the error class's required two-arg signature. Implementation and task Solution correctly use the two-arg form — the design-doc snippet is stale (doc-only follow-up). | `docs/design/decision-maker.md:180` |

##### Functional Traceability

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `createDecisionMaker(options?)` exported at `decision-maker.ts:83`; `DecisionMaker`/`DecisionMakerOptions` exported; barrel line `src/index.ts:13` |
| R2 | MET | signatures match the design doc verbatim: readonly `driver` `:25`, `ask` `:27-31`, `choice` `:33-37`, `score` `:39`, `noul` `:41` |
| R3 | MET | `req` forwarded unchanged — test asserts the same `questions` reference (`decision-maker.test.ts:130`); the one documented cast `decision-maker.ts:113`; type-level `AnswersFor<Q>` narrowing proofs `decision-maker.test.ts:21-26` |
| R4 | MET | sugar builds exactly one `q.*` question and unwraps `.question`; "the answer itself, not a map" asserted at `decision-maker.test.ts:158` |
| R5 | MET | choice/score/noul implemented once via the inner `ask` (`decision-maker.ts:141-148`); each test asserts exactly one driver call |
| R6 | MET | `if (options.driver) return options.driver;` short-circuits before key resolution (`decision-maker.ts:88`); lazy `defaultDriver ??=` `:89`; creation with no key/driver does not throw (`decision-maker.test.ts:73`) |
| R7 | MET | `options.apiKey ?? (options.env ?? getProcessEnv()).TYPESAFE_API_KEY` (`decision-maker.ts:67`); two-arg `DecisionConfigError(message, 'TYPESAFE_API_KEY')` `:69-71`; AC R6 test proves fetch never invoked (`decision-maker.test.ts:80-93`) |
| R8 | MET | no `process.env`/`Bun.env` anywhere in the changed files (grep: none); env-var-hygiene rule green in `bun run spur-check` |
| R9 | MET | no `@typesafe-ai/sdk` import in `src/decision/` (grep: comments only); decision-boundaries rule green |

AC scenarios: R1 (four members, default `typesafe`) `decision-maker.test.ts:46-53`; R3 sugar (one call, one question, unwrapped) `:144-176`; R6 (rejection pre-request, fetch untouched) `:80-93`; R8 (custom driver serves all four members with no key anywhere) `:191-208` — all passing.

##### SECUA Quality

- security — env hygiene green (injected-record pattern only); the key is never logged or echoed: the error names the missing variable, not its value
- correctness — exactly one `as` in the file (`:113`), correctly scoped to the facade boundary where the driver has already decoded answers for the same question map it received
- correctness — lazy construction is genuinely lazy: a custom driver never constructs the default nor requires a key; the default is memoized (at most one construction) via `??=`
- correctness — error path uses the two-arg `DecisionConfigError(message, 'TYPESAFE_API_KEY')` per `errors.ts` (the design doc's one-arg snippet is the stale artifact, see finding 3)
- efficiency — sugar costs one driver call, no re-assembly; batch path passes the map reference through
- usability — missing-key message is actionable: "set it in the environment or pass options.apiKey"

Fresh verification (this review): `bun test packages/ai-runner/tests/decision/` → **23 pass, 0 fail**; `bun run typecheck` → exit 0; `bun run spur-check` → "All 2 rules passed — no violations found."

##### Architecture Depth

- sugar-implemented-via-ask (R5): one code path under choice/score/noul — the load-bearing design decision holds; drivers implement one method, so future backends (I11) stay cheap
- factory-slot stub: `typesafe-driver.ts` contains only `TypesafeDriverConfig` + the throwing factory — zero SDK imports, zero neutral⇄SDK mapping logic leaked from 0072's zone; boundary rule's sole-SDK-file invariant already satisfied structurally
- barrel hygiene: one added export line, alphabetical placement; the throwing stub is deliberately NOT re-exported from `src/index.ts`

**Next:** no P1–P3 — proceed to 0072; refresh the design doc's one-arg `DecisionConfigError` snippet when the driver work touches it.

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-20T06:58:01.623Z todo → wip (system)
- 2026-09-20T07:27:17.553Z wip → testing (system)
- 2026-09-20T07:27:17.903Z testing → done (system)

