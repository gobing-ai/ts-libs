---
schema_version: 1
id: "A2"
name: "Provider-neutral DecisionMaker over TypeSafe Jev in ts-ai-runner"
status: verifying
priority: P2
tags: []
created_at: "2026-09-20T04:48:50.742Z"
updated_at: "2026-09-20T09:21:30.465Z"
---

# A2: Provider-neutral DecisionMaker over TypeSafe Jev in ts-ai-runner

## Goal

Add a provider-neutral **structured-decision** capability to `@gobing-ai/ts-ai-runner`: a
`DecisionMaker` interface and a `createDecisionMaker()` factory that return typed, calibrated
judgments — a selected label, a rubric score, or a yes-probability — that caller code can branch,
sort, and route on directly, instead of the free text the package's existing prompt-execution
surface returns and callers must parse.

The interface is **batch-first**: `ask({ state, questions })` evaluates many named questions
against one shared state in a single request, and `choice` / `score` / `noul` are thin
single-question conveniences over it. This matches the execution model of the backing API, where
the three primitives are question *builders* collected into one `systemOne` call rather than
independently callable operations; a per-primitive-only surface would cost one round trip per
question and re-upload the shared state each time.

The only in-scope backend driver wraps `@typesafe-ai/sdk` (TypeSafe AI's Jev / System One model
family, default `jev-latest`), pinned to exact `0.6.0` and confined to this package behind the
`DecisionMaker` seam. The seam exists so the deferred traditional-LLM and local-model drivers can
land without touching callers, and so pre-1.0 SDK churn stays a one-file edit.

## Scope

- In:
    - `DecisionMaker` interface with a batch-first core `ask({ state, questions })` plus
      `choice` / `score` / `noul` single-question conveniences delegating to it
    - `createDecisionMaker(options?)` object factory selecting a backend driver (default: TypeSafe)
    - TypeSafe driver over `@typesafe-ai/sdk`, wrapping `new TypeSafeClient(...)` and
      `client.systemOne({ state, questions, model? })`; question construction via the SDK's
      exported `choice` / `score` / `noul` builders
    - Distinct answer types per primitive: choice → selected label + `confidence` + per-label
      probabilities; score → expected score + `confidence` + rubric legend + per-level
      probabilities; noul → yes-probability only (no `confidence` field — the SDK does not return
      one, and it must not be synthesized)
    - API key resolution through an injected env record following the existing
      `{PROVIDER}_API_KEY` convention (`src/doctor-runner.ts:220`), passing `apiKey` explicitly to
      the SDK so its own `TYPESAFE_API_KEY` self-resolution is bypassed
    - Injectable `fetch` (via `TypeSafeClientConfig.fetch`) plus timeout/retry/model pass-through,
      so the driver is unit-testable with no network and no live key
    - Mapping the SDK error taxonomy (`AuthenticationError`, `RateLimitError`, `APITimeoutError`,
      `APIConnectionError`, …) onto package-level errors, preserving status and retry-after
    - `@typesafe-ai/sdk` pinned to exact `0.6.0` in `packages/ai-runner/package.json`
    - A `.spur/rules/` boundary rule confining `@typesafe-ai/sdk` imports to `packages/ai-runner`,
      mirroring the `db-boundaries` treatment of `drizzle-orm` (ADR-005 / ADR-006)
    - Unit tests over mocked `fetch`: batch request shape (one request, N questions, shared state),
      answer decoding per primitive, key injection, error mapping, driver substitutability
    - Export from the package barrel; `packages/ai-runner/README.md` capability section
- Out:
    - Traditional-LLM and local-model `DecisionMaker` drivers (explicitly deferred by the operator;
      the seam must not foreclose them)
    - Live-network integration or CI smoke tests that call the TypeSafe API
    - Any calibration/quality evaluation of Jev's probabilities against recorded repo data
    - Migrating existing `ai-runner` consumers (`doctor-runner`, `model-health-probe`,
      agent/model routing) onto `DecisionMaker` — no current consumer is changed
    - `client.models.list()` / model-discovery surface
    - Streaming, browser use (`dangerouslyAllowBrowser`), and custom logger wiring
    - A new ADR for the package's own architecture; the new dependency boundary is carried by the
      spur rule under existing ADR-005 / ADR-006 precedent

## Acceptance Criteria

```gherkin
Feature: Provider-neutral DecisionMaker over TypeSafe Jev in ts-ai-runner

  @core
  Scenario: R1 — createDecisionMaker returns a DecisionMaker with the four members
    Given the ts-ai-runner package barrel
    When createDecisionMaker is called with no arguments
    Then it returns an object exposing ask, choice, score, and noul
    And the returned value is typed as DecisionMaker with the TypeSafe driver selected by default

  @core
  Scenario: R2 — ask evaluates many questions against one shared state in a single request
    Given a DecisionMaker backed by the TypeSafe driver with an injected fetch
    When ask is called with one state and three named questions of mixed primitive types
    Then exactly one HTTP request is issued to the systemOne endpoint
    And its body carries the state once and all three questions keyed by their given names
    And the resolved answers are keyed by those same names with each answer's type inferred from its question

  @core
  Scenario: R3 — choice, score, and noul are single-question sugar over ask
    Given a DecisionMaker backed by the TypeSafe driver with an injected fetch
    When choice, score, or noul is called with a state and one question
    Then each issues exactly one systemOne request containing exactly one question
    And each resolves to that primitive's answer directly rather than to a map keyed by question name

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
  Scenario: R6 — a missing key fails before any request is issued
    Given an env record with no TYPESAFE_API_KEY and no key passed in options
    When a DecisionMaker is created and ask is called
    Then it rejects with a package-level configuration error naming the missing variable
    And the injected fetch is never invoked

  @core
  Scenario: R7 — the driver is exercisable with no network and no live key
    Given a DecisionMaker created with an injected fetch that returns recorded systemOne payloads
    When any of ask, choice, score, or noul is called
    Then the call resolves from the injected fetch alone
    And timeout, retry, and model options passed to the factory reach the SDK client configuration

  @core
  Scenario: R8 — the driver seam accepts an alternate backend with no caller change
    Given a hand-written test driver that satisfies the DecisionMaker driver contract without importing @typesafe-ai/sdk
    When createDecisionMaker is given that driver and caller code calls ask, choice, score, and noul
    Then every call resolves through the test driver
    And the caller code compiles and passes unchanged against both drivers

  @core
  Scenario: R9 — SDK errors surface as package-level errors preserving actionable detail
    Given an injected fetch that produces authentication, rate-limit, timeout, and connection failures in turn
    When a DecisionMaker call encounters each failure
    Then each rejects with a package-level error carrying the failure kind, HTTP status where present, and retry-after where present
    And no raw @typesafe-ai/sdk error class escapes the package boundary

  @core
  Scenario: R10 — the SDK dependency is pinned exactly and confined to this package
    Given the workspace manifests and the .spur rule catalog
    When the rule gate runs
    Then packages/ai-runner declares @typesafe-ai/sdk at exact 0.6.0 with no range prefix
    And a boundary rule fails the gate when any package other than ai-runner imports @typesafe-ai/sdk

  @core
  Scenario: R11 — the capability is exported from the barrel and documented
    Given the completed DecisionMaker implementation
    When the package barrel and README are inspected
    Then createDecisionMaker, the question builders, the neutral types, and the error taxonomy are all reachable from the package entry point
    And no @typesafe-ai/sdk type, class, or error is exported through it
    And the README documents the batch form, the single-question form, key configuration, and that the yes/no answer carries no confidence
    And it identifies an additional backend driver as the intended extension point
```

## Tasks

<!-- AUTO-GENERATED by spur feature refresh -->
| WBS | Task | Status |
| --- | ---- | ------ |
| 0069 | Pin @typesafe-ai/sdk and add the decision-boundaries rule | done |
| 0070 | Neutral decision types, q builders, driver contract, and error taxonomy | done |
| 0071 | DecisionMaker facade: factory, batch ask, and single-question sugar | done |
| 0072 | TypeSafe driver: client wiring, question and answer mapping, error mapping | done |
| 0073 | Export DecisionMaker from the barrel and document the capability | done |
<!-- END AUTO-GENERATED -->

## Notes

## History

- 2026-09-20T09:21:30.323Z backlog → active (system)
- 2026-09-20T09:21:30.465Z active → verifying (system)

