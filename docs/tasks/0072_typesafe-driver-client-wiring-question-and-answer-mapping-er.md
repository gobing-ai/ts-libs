---
schema_version: 1
name: "TypeSafe driver: client wiring, question and answer mapping, error mapping"
status: done
template: feature-impl
created_at: 2026-09-20T05:08:59.653Z
updated_at: "2026-09-20T18:04:19.610Z"
feature_id: A2
priority: P2
tags:
  - ai-runner
  - decision-maker
  - typesafe
  - driver

dependencies: ["0069", "0070"]
---

## 0072. TypeSafe driver: client wiring, question and answer mapping, error mapping

### Background

The only in-scope backend driver, and the only file in the workspace permitted to
import `@typesafe-ai/sdk`. It implements the one-method `DecisionDriver` contract by translating
neutral questions into the SDK's builders, issuing a single `client.systemOne` call, and
translating the responses back into neutral answers.

The mapping is where the SDK's shape is absorbed. Two details matter more than the rest. First, the
SDK's `choice`, `score`, and `noul` exports are question *builders*, not operations — nothing
reaches the network until `systemOne` is called with the assembled map, which is exactly why the
driver contract is a single batch method. Second, a yes/no response carries only a probability, so
the mapping must not invent a confidence for it.

This driver is also where pre-1.0 SDK churn is absorbed. When `@typesafe-ai/sdk` breaks between
versions, this is the one file that changes.

### Requirements

- [x] R1. Create `packages/ai-runner/src/decision/typesafe-driver.ts` exporting a
      factory that returns a `DecisionDriver` with `name` `"typesafe"`.
- [x] R2. The driver constructs one `TypeSafeClient` per instance, passing `apiKey` **explicitly** so
      the SDK's own `TYPESAFE_API_KEY` self-resolution never runs, and forwarding `baseURL`,
      `timeoutMs` as `timeout`, `maxRetries` into `retry`, `model` as `defaultModel`, and an
      injected `fetch` when supplied.
- [x] R3. `ask` issues exactly one `client.systemOne({ state, questions, model? })` call per
      invocation, whatever the number of questions.
- [x] R4. Question mapping: `q.choice → choice(prompt, labels)`, `q.score → score(prompt, rubric)`,
      `q.noul → noul(prompt, { true: yes, false: no })`.
- [x] R5. Answer mapping: `ChoiceResponse → { kind: 'choice', label: r.choice, confidence, probabilities }`;
      `ScoreResponse → { kind: 'score', score, confidence, legend, probabilities }`;
      `NoulResponse → { kind: 'noul', probability: r.noul }` with no confidence added.
- [x] R6. Answers are returned keyed by the caller's question names, in correspondence with the request.
- [x] R7. Every SDK error is translated per the design document's table, and no
      `@typesafe-ai/sdk` error class escapes the driver. Status and retry-after detail are preserved
      where the SDK provides them.
- [x] R8. `usage` and the response `model` are intentionally not surfaced in this version.
- [x] R9. Every test in this task runs against an injected `fetch` — no network, no live key.

### Acceptance Criteria

```gherkin
  @core
  Scenario: R2 — ask evaluates many questions against one shared state in a single request
    Given a DecisionMaker backed by the TypeSafe driver with an injected fetch
    When ask is called with one state and three named questions of mixed primitive types
    Then exactly one HTTP request is issued to the systemOne endpoint
    And its body carries the state once and all three questions keyed by their given names
    And the resolved answers are keyed by those same names with each answer's type inferred from its question

  @core
  Scenario: R4 — each primitive's answer carries only the fields the API returns
    Given decoded systemOne responses for a choice, a score, and a noul question
    When the driver maps each response to its answer type
    Then the choice answer carries the selected label, a confidence, and a probability per label
    And the score answer carries the expected score, a confidence, a rubric legend, and a probability per level
    And the noul answer carries only the yes-probability, with no confidence field present or synthesized

  @core
  Scenario: R5 — the API key is injected, never read from process.env by this package
    Given an env record supplied to createDecisionMaker containing TYPESAFE_API_KEY
    When the TypeSafe driver constructs its client
    Then the key is read from the injected record following the {PROVIDER}_API_KEY convention
    And apiKey is passed explicitly to the SDK client so its own TYPESAFE_API_KEY self-resolution is bypassed
    And no source file in the feature reads process.env directly

  @core
  Scenario: R7 — the driver is exercisable with no network and no live key
    Given a DecisionMaker created with an injected fetch that returns recorded systemOne payloads
    When any of ask, choice, score, or noul is called
    Then the call resolves from the injected fetch alone
    And timeout, retry, and model options passed to the factory reach the SDK client configuration

  @core
  Scenario: R9 — SDK errors surface as package-level errors preserving actionable detail
    Given an injected fetch that produces authentication, rate-limit, timeout, and connection failures in turn
    When a DecisionMaker call encounters each failure
    Then each rejects with a package-level error carrying the failure kind, HTTP status where present, and retry-after where present
    And no raw @typesafe-ai/sdk error class escapes the package boundary
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-20T05:16:53.270Z

**`apiKey` always passed explicitly.** The SDK will otherwise resolve `TYPESAFE_API_KEY` from
the ambient environment itself. That would route a credential read around the workspace's env
gateway and make the `env-var-hygiene` guarantee hollow — the rule would be green while ambient
env access still happened, inside `node_modules`. Passing the key explicitly keeps one resolution
point, in the facade.

**One `systemOne` call per `ask`, asserted by counting fetch invocations.** A refactor that
quietly looped per question would pass every functional test while destroying the feature's reason
for existing, so the single-request property is measured rather than implied.

**`probability` rather than the SDK's `noul` field name.** The mapped name states what the
number is; the absence of a `confidence` key is the deliberate part.

**`usage` and the response `model` are not surfaced.** No consumer needs cost accounting yet,
and adding it behind an option later is trivial. Deferred condition: a caller that needs token or
cost attribution.

**Injected `fetch` rather than module mocking.** `TypeSafeClientConfig.fetch` is a first-class
SDK option, so the seam is the vendor's own and needs no test-framework machinery. It also keeps
the tests honest about the wire shape — they assert on the request body the SDK actually produces.

**Premises.** The SDK's `choice` / `score` / `noul` exports are question builders, not
operations — nothing reaches the network until `systemOne` is called, which is why the driver
contract is a single batch method; the SDK maps yes/no outcome descriptions under `true` /
`false` keys; and this file is where pre-1.0 SDK churn is absorbed, so a breaking SDK change is a
one-file edit.

### Design

**WHAT** — one file: client construction, neutral⇄SDK translation in both directions,
and error translation.

**WHY `apiKey` is always passed explicitly** — the SDK will otherwise resolve
`TYPESAFE_API_KEY` from the ambient environment itself. That would route a credential read around
the workspace's env gateway and make the `env-var-hygiene` rule's guarantee hollow: the rule would
be green while ambient env access still happened, just inside `node_modules`. Passing the key
explicitly keeps the single resolution point in the facade.

**WHY one `systemOne` call per `ask`, asserted by test** — this is the property the whole design
exists to protect. A refactor that quietly loops per question would still pass every functional
test while destroying the feature's reason for existing, so R3 is asserted by counting calls on the
injected `fetch`, not merely implied.

**WHY the noul mapping renames the field** — the SDK returns the probability under a field named
after the primitive itself (`r.noul`). Mapping it to `probability` states what the number is,
and the absence of a `confidence` key is the deliberate part: the API does not report one and the
driver must not synthesize one.

**WHY `usage` is omitted** — no consumer needs cost accounting yet, and adding it later behind an
option is trivial. Surfacing it now would widen the neutral answer type for a hypothetical caller.

**WHY injected `fetch` rather than a mocked module** — `TypeSafeClientConfig.fetch` is a
first-class option in the SDK, so the seam is the vendor's own and needs no test-framework
machinery. It also keeps the tests honest about the wire shape: they assert on the actual request
body the SDK produces.

### Plan

1. Write the driver factory: accept resolved `apiKey` plus the transport options and
   construct one `TypeSafeClient`.
2. Implement question mapping for the three neutral kinds via the SDK's builders.
3. Implement `ask` as a single `systemOne` call over the assembled question map.
4. Implement answer mapping for the three response kinds, keyed back to the caller's names.
5. Implement error translation per the design table, wrapping every SDK error class.
6. Capture representative `systemOne` response payloads as test fixtures.
7. Test with an injected `fetch`: one-request-per-ask under a three-question batch, request body
   shape, per-kind answer decoding, no confidence on the yes/no answer, option pass-through, and
   each error translation.
8. Confirm the boundary rule still passes with this file as the sole sanctioned importer.
9. Run typecheck, tests, and `bun run spur-check`.

### Solution

Change-map for commits a694cdf + 14d8dd4 (implement hop; spur-check clean, 2308+2 pass / 0 fail):

| Change (`file:line`) | What |
|----------------------|------|
| `packages/ai-runner/src/decision/typesafe-driver.ts:46` | Factory → DecisionDriver `name:typesafe`; one TypeSafeClient per instance; apiKey always explicit (R1,R2,R5) |
| `packages/ai-runner/src/decision/typesafe-driver.ts:51` | baseURL pass-through + residual-risk comment (ambient TYPESAFE_BASE_URL when omitted; hard seal needs SDK default constant — deferred) |
| `packages/ai-runner/src/decision/typesafe-driver.ts:75` | ask: exactly one client.systemOne per call (R3); answers keyed by caller names (R6); usage/model not surfaced (R8) |
| `packages/ai-runner/src/decision/typesafe-driver.ts:91` | q<->SDK builders: choice/score/noul (R4); answer mapping field-exact, noul = {kind,probability} only (R5) |
| `packages/ai-runner/src/decision/typesafe-driver.ts:139` | R7 translation table, subclass-before-base; 4xx→Request (incl NotFound), 5xx→Backend, local TypeSafeError→Request, foreign rethrown |
| `packages/ai-runner/tests/decision/typesafe-driver.test.ts:115` | 14 tests, all injected-fetch: single-request by fetch-count, wire-body asserts, full error table, timeout/abort path |
| `packages/ai-runner/tests/decision/typesafe-driver.test.ts:290` | 14d8dd4: non-SDK Error pass-through (identity assert); explicit baseURL under ambient TYPESAFE_BASE_URL via ts-utils gateway |

SDK 0.6.0 verified against installed typings (index.d.mts) — no material doc/SDK discrepancies.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/ai-runner/src/decision/typesafe-driver.ts:48` — `createTypesafeDriver(config)` factory returns `DecisionDriver` with `name: 'typesafe'` (`:68`) |
| R2 | MET | `typesafe-driver.ts:49-62` — one `TypeSafeClient` per instance; `apiKey: config.apiKey` explicit (`:52`) so SDK self-resolution never runs; `baseURL` `:57`, `defaultModel: config.model` `:58`, `timeout: config.timeoutMs` `:59`, `retry: { maxRetries }` `:60`, `fetch` `:61` forwarded |
| R3 | MET | `typesafe-driver.ts:75` — exactly one `client.systemOne({ state, questions: sdkQuestions, model })` per `ask`; fetch-count assertion in the 14-test injected-fetch suite proves single-request batching (this run) |
| R4 | MET | `typesafe-driver.ts:91-105` `toSdkQuestion` — choice → `choice(prompt ?? null, labels)` `:94`, score → `score(prompt ?? null, rubric)` `:96`, noul → `noul(prompt ?? null, { true: yes, false: no })` `:98-102` |
| R5 | MET | `typesafe-driver.ts:108-128` `fromSdkAnswer` — choice → {kind, label: answer.choice, confidence, probabilities} `:111-116`; score → {kind, score, confidence, legend, probabilities} `:118-124`; noul → `{ kind: 'noul', probability: answer.noul }` only `:126` — no confidence synthesized |
| R6 | MET | `typesafe-driver.ts:83-84` — answers re-keyed by caller question names via `Object.entries(result.answers)` (SDK echoes request names); key-correspondence asserted in the driver suite |
| R7 | MET | `typesafe-driver.ts:139-164` `translateError` — subclass-before-base: RateLimit → DecisionRateLimitError(status, retryAfterMs) `:141-143`; Authentication/PermissionDenied → DecisionAuthError(status) `:144-146`; APITimeout → DecisionTimeoutError(timeoutMs) `:147-149`; APIConnection → DecisionConnectionError `:150-152`; APIError 4xx → DecisionRequestError(status, bodySummary≤200) `:153-157`, 5xx → DecisionBackendError(status) `:158`; local TypeSafeError → DecisionRequestError `:160-162`; foreign errors rethrown `:163`. Full error-table tests in the 14-pass run |
| R8 | MET | `typesafe-driver.ts:80-82` — comment records `model`/`usage` deliberately not surfaced; mapping reads only `result.answers` |
| R9 | MET | `bun test tests/decision/typesafe-driver.test.ts` → 14 pass / 0 fail / 62 expect() calls, exit 0 (this run) — every test runs against the injected `fetch` (TypeSafeClientConfig.fetch seam); no network, no live key |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R2 — ask evaluates many questions against one shared state in a single request | MET | test | typesafe-driver.test.ts — three-question mixed-primitive batch issues exactly one HTTP request (fetch-count assertion), body carries state once + all questions keyed by given names, answers keyed by the same names with per-question types (14-pass run) |
| Scenario: R4 — each primitive's answer carries only the fields the API returns | MET | test | End-to-end decode proof (the half 0070 deferred here): recorded systemOne payloads map to choice(label+confidence+per-label probabilities), score(score+confidence+legend+per-level probabilities), noul(only yes-probability — `typesafe-driver.ts:126`, no confidence present or synthesized); decode tests in the 14-pass run |
| Scenario: R5 — the API key is injected, never read from process.env by this package | MET | test | Key flows facade env-record → `createTypesafeDriver` config → explicit `apiKey` at client construction (`typesafe-driver.ts:52`), bypassing SDK self-resolution; zero `process.env`/`Bun.env` reads in `src/decision/*.ts` (grep this run) |
| Scenario: R7 — the driver is exercisable with no network and no live key | MET | test | Entire suite (14 tests) resolves from injected fetch returning recorded payloads; timeout/retry/model option pass-through asserted on the SDK client configuration (14-pass run) |
| Scenario: R9 — SDK errors surface as package-level errors preserving actionable detail | MET | test | Injected-fetch failures for auth/rate-limit/timeout/connection each reject with the package-level class carrying kind + HTTP status + retry-after where present (`typesafe-driver.ts:141-152`); error-table tests + foreign-error identity passthrough (14d8dd4) in the 14-pass run; no raw SDK class escapes (`translateError` exhausts the taxonomy, `:163` rethrows only non-SDK errors) |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0072

**Scope:** commit `a694cdf` diff — `packages/ai-runner/src/decision/typesafe-driver.ts` (stub → 154-line driver), `packages/ai-runner/tests/decision/typesafe-driver.test.ts` (rewritten, 13 tests). Mapping claims verified against the **installed** SDK 0.6.0 typings (`node_modules/.bun/@typesafe-ai+sdk@0.6.0/.../dist/index.d.mts`), not memory.
**Dimensions:** functional, correctness, security, efficiency, usability, architecture
**Verdict:** PASS

**Fresh verification evidence (this review):** `bun test packages/ai-runner/tests/decision/` → 34 pass, 0 fail, 144 expect() calls; `bun run typecheck` → all 5 packages exit 0; coverage: `typesafe-driver.ts` 100% line / 96.51% branch (≥90% gate green), `errors.ts` + `types.ts` 100/100.

##### Findings (ranked)

| # | Priority | Dimension | Finding | Location |
|---|----------|-----------|---------|----------|
| 1 | P3 (minor) | correctness | The foreign-error rethrow (`throw err`) is the escape hatch that guarantees "no SDK class escapes" without mislabeling foreign errors — but it has zero test coverage (bun reports exactly lines 158–159 uncovered). One test pinning "plain non-SDK Error passes through untouched as-is" would close the contract. | `packages/ai-runner/src/decision/typesafe-driver.ts:159` |
| 2 | P3 (minor) | security | `apiKey` is sealed (always explicit, R5 holds), but `baseURL`/`defaultModel`/`logLevel` are forwarded as-is, so the SDK's ambient `TYPESAFE_BASE_URL` / `TYPESAFE_DEFAULT_MODEL` / `TYPESAFE_LOG_LEVEL` fallbacks stay live (confirmed in 0.6.0 `index.d.mts:204-211,315-321`). An ambient `TYPESAFE_BASE_URL` would silently re-point credential-bearing requests — the same class of ambient-env risk the Q&A entry seals for the key. Cheap seal: `config.baseURL ?? 'https://api.typesafe.ai'` (explicit value disables the env fallback); `defaultModel` cannot be sealed without inventing a model name — accept or document. | `packages/ai-runner/src/decision/typesafe-driver.ts:53-54` |
| 3 | P4 (advisory) | correctness | R6 keys-correspondence trusts the SDK echo: the driver maps whatever `result.answers` carries, with no request-keys ⊆ answer-keys check; a dropped key would surface only as a silent lie at the facade's one documented cast. Documented premise (spec Q&A), behavior is tested today (test asserts `Object.keys(answers)`), so advisory. | `packages/ai-runner/src/decision/typesafe-driver.ts:79-81` |
| 4 | P4 (advisory) | usability | Spec housekeeping: R1–R9 requirement checkboxes still unchecked and task status `wip` — do-time F1/F2 transitions pending after this review. | `docs/tasks/0072_typesafe-driver-client-wiring-question-and-answer-mapping-er.md:39-57` |

##### Functional Traceability

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `typesafe-driver.ts:48,64` — factory returns `DecisionDriver` named `'typesafe'`; test `:97` |
| R2 | MET | Constructor keys verified against 0.6.0 typings: `apiKey` explicit (`:52`), `baseURL` (`:53`), `timeoutMs→timeout` (`:55`), `maxRetries→retry.maxRetries` (`:56`), `model→defaultModel` (`:54`), `fetch` (`:57`); explicit key provably reaches the wire: `Authorization: Bearer explicit-key` (test `:105`) |
| R3 | MET | Exactly one `client.systemOne` per ask (`:71`); fetch-count tests: 1 question → 1 call, 3 questions → 1 call (tests `:114-128`) |
| R4 | MET | `toSdkQuestion` via SDK builders `choice`/`score`/`noul` (`:86-104`); signatures match typings; undescribed prompts → `null` and bare noul sends no criteria (test `:154-164`) |
| R5 | MET | `fromSdkAnswer` field-for-field vs SDK `ChoiceResponse`/`ScoreResponse`/`NoulResponse` (`:106-130`); noul answer has exactly `['kind','probability']` — no confidence invented (tests `:193-194`) |
| R6 | MET | Answers keyed by caller's names (`:79-81`); `Object.keys(answers)` equals request keys (test `:175`); premise documented in Q&A |
| R7 | MET | `translateError` (`:141-160`) matches design table with subclass-before-base order verified against the real hierarchy (`APITimeoutError extends APIConnectionError`; `RateLimit`/`Authentication`/`PermissionDenied` extend `APIError`); 429+retry-after, 401, 400, 503 detail asserted (tests `:200-246`); real timeout path `timeoutMs:25` (test `:258-267`); local `TypeSafeError` → `DecisionRequestError` before any fetch (test `:269-275`); construction failures also translated (test `:277-287`). Residual: finding #1 (foreign rethrow untested) |
| R8 | MET | Driver returns only the answers record (`:81`); exact-shape assertions leave no path for `usage`/`model` to leak (tests `:179-193`) |
| R9 | MET | All 13 driver tests run on injected `recordedFetch` returning recorded payloads; no `process.env` read anywhere in the decision feature (grep clean) |

##### Per-dimension verdicts

- **Functional (sp-functional-review):** PASS — R1–R9 all MET; all five `@core` AC scenarios evidenced against changed files (single-request batch `:114-147`; noul field-set asymmetry `:193-194`; explicit-key bypass `:105` + sealed at `:52`; no-network exercisability across all 13 tests; error taxonomy preserving detail `:200-246`).
- **SECUA quality (sp-code-verification):** PASS with 2 P3 — mapping is exhaustive and correct against the actual 0.6.0 typings (constructor config, `systemOne({state, questions, model})`, response field names `choice`/`confidence`/`probabilities`, `score`/`confidence`/`legend`, `noul`; error hierarchy); table ordering is subclass-before-base; no SDK class escape path (4xx→Request incl. NotFound, 5xx→Backend, local TypeSafeError→Request, foreign rethrown); ambient env sealed for the credential. Findings #1–#2 dispositionable.
- **Architecture depth (sp-code-improvement):** PASS — one `TypeSafeClient` per instance by construction (`:49-63`, closed over by `ask`); single-request property pinned by fetch-count, not implied; deliberate omissions (`usage`/`model`) cannot leak (answers-only return + exact-shape tests); 0071 factory slot intact (`decision-maker.ts:20,89` — `defaultDriver ??= createTypesafeDriver(...)`); boundary rule green — `@typesafe-ai/sdk` imported only in `typesafe-driver.ts` (src) and tests, matching the rule's scope.

**Next:** Disposition the two P3s (add the foreign-rethrow test; decide seal-vs-accept for `TYPESAFE_BASE_URL` fallback), then proceed to done-time housekeeping (F1 checkbox transitions). No P1/P2 — gate not blocked.

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-20T07:27:28.944Z todo → wip (system)
- 2026-09-20T08:24:00.756Z wip → testing (system)
- 2026-09-20T08:24:01.092Z testing → done (system)

