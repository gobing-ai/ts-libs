---
schema_version: 1
name: "TypeSafe driver: client wiring, question and answer mapping, error mapping"
status: wip
template: feature-impl
created_at: 2026-09-20T05:08:59.653Z
updated_at: "2026-09-20T07:27:28.944Z"
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

- [ ] R1. Create `packages/ai-runner/src/decision/typesafe-driver.ts` exporting a
      factory that returns a `DecisionDriver` with `name` `"typesafe"`.
- [ ] R2. The driver constructs one `TypeSafeClient` per instance, passing `apiKey` **explicitly** so
      the SDK's own `TYPESAFE_API_KEY` self-resolution never runs, and forwarding `baseURL`,
      `timeoutMs` as `timeout`, `maxRetries` into `retry`, `model` as `defaultModel`, and an
      injected `fetch` when supplied.
- [ ] R3. `ask` issues exactly one `client.systemOne({ state, questions, model? })` call per
      invocation, whatever the number of questions.
- [ ] R4. Question mapping: `q.choice → choice(prompt, labels)`, `q.score → score(prompt, rubric)`,
      `q.noul → noul(prompt, { true: yes, false: no })`.
- [ ] R5. Answer mapping: `ChoiceResponse → { kind: 'choice', label: r.choice, confidence, probabilities }`;
      `ScoreResponse → { kind: 'score', score, confidence, legend, probabilities }`;
      `NoulResponse → { kind: 'noul', probability: r.noul }` with no confidence added.
- [ ] R6. Answers are returned keyed by the caller's question names, in correspondence with the request.
- [ ] R7. Every SDK error is translated per the design document's table, and no
      `@typesafe-ai/sdk` error class escapes the driver. Status and retry-after detail are preserved
      where the SDK provides them.
- [ ] R8. `usage` and the response `model` are intentionally not surfaced in this version.
- [ ] R9. Every test in this task runs against an injected `fetch` — no network, no live key.

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

- `bun run typecheck` (ai-runner): clean.
- `NODE_ENV=test bun test tests/decision/`: 34 pass / 0 fail — 13 tests in typesafe-driver.test.ts, all over injected fetch (no network, no live key).
- `bun run spur-check` (workspace root): lint + typecheck + 2308 pass / 0 fail + all recommended-pre/post rules pass.
- Coverage: single-request property asserted by counting fetch calls; wire body asserted from the serialized fetch body; every R7 table row exercised with status, retry-after, cause, and timeoutMs detail claims.

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-20T07:27:28.944Z todo → wip (system)

