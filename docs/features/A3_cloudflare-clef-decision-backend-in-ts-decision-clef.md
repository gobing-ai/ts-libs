---
schema_version: 1
id: "A3"
name: "Cloudflare Clef decision backend in ts-decision-clef"
status: done
priority: P2
tags: []
created_at: "2026-10-09T18:29:17.262Z"
updated_at: "2026-10-09T20:31:42.680Z"
---

# A3: Cloudflare Clef decision backend in ts-decision-clef

## Goal

Allow applications to make typed decisions with Cloudflare Clef and Clef Flash
through the existing DecisionMaker interface using the independently consumable
`@gobing-ai/ts-decision-clef` package.

## Scope

- In: `packages/decision-clef`, lockstep packaging/build exports, hosted Workers AI REST,
  both model selectors, choice/score/noul mapping, shared validation, provider limits,
  explicit credentials, typed errors, offline fixtures/tests, and usage documentation.
- In: existing `createDecisionMaker({ driver })` and manual lazy maker registration,
  with architectural rules preserving one-way dependency and APIClient ownership.
- Out: local GPU/Python hosting, image/video API changes, Worker binding transport,
  SDK dependencies, automatic retries, caching, automatic environment discovery,
  new ai-runner backend selectors, and new registry built-ins.
- Out: publishing, release tags/version bump and changes to GitHub Actions workflows.
- Sources: Cloudflare announcement/model schemas and both supplied Hugging Face model cards,
  researched 2026-10-09 in `docs/plans/2026-10-09-decision-clef-brainstorm.md`.

## Acceptance Criteria

```gherkin
Feature: Cloudflare Clef decision backend

  @core
  Scenario: R1 — Consumers import the lockstep Clef driver package
    # covers: I1
    Given the Bun workspace contains packages/decision-clef at the current lockstep version
    When a consumer imports createClefDriver and ClefDriverOptions from @gobing-ai/ts-decision-clef
    Then the package exports runtime code and TypeScript declarations from dist
    And the canonical workspace gates and build succeed

  @core
  Scenario: R2 — Model selection uses matching Clef routes and body selectors
    # covers: I3, I4
    Given explicit accountId and apiToken and a mocked Workers AI endpoint
    When the driver asks with its default model or a clef per-call override
    Then the default route and request body select clef-flash
    And the override route and request body select clef
    And unsupported model names fail before any HTTP call

  @core
  Scenario: R3 — DecisionMaker preserves typed batch answers and probabilities
    # covers: I2, I3, I4
    Given a Clef driver injected through createDecisionMaker and a mixed choice score noul question map
    When a mocked successful REST envelope supplies a choice label a fractional score and a yes probability
    Then one request evaluates the whole map and returns answers under the original question names
    And choice and score confidence distributions and score legend are preserved
    And noul returns only kind and probability
    And the existing choice score and noul convenience methods use the same driver

  @core
  Scenario: R4 — Invalid requests and malformed responses fail at the driver boundary
    # covers: I2, I4
    Given the driver is called directly or through DecisionMaker
    When questions exceed 64 or contain invalid IDs or choice counts outside 2 to 255 or score counts outside 2 to 10
    Then DecisionRequestError is raised before HTTP
    And absent null or empty prompts are rendered using the question ID
    And nonserializable state is rejected before HTTP
    And mismatched answer keys kinds labels distributions or score bounds raise DecisionBackendError

  @core
  Scenario: R5 — Configuration and transport failures use the decision error taxonomy
    # covers: I2, I3, I4
    Given explicit credentials and an injected fetch implementation
    When configuration is missing or invalid or the backend returns a failure
    Then missing credentials raise DecisionConfigError without exposing credentials
    And 401 and 403 map to DecisionAuthError and 429 maps to DecisionRateLimitError
    And other 4xx map to DecisionRequestError and 5xx map to DecisionBackendError
    And timeout maps to DecisionTimeoutError and connection failure maps to DecisionConnectionError
    And malformed JSON or a failed success envelope maps to DecisionBackendError
    And no failure becomes a fabricated answer and credentials and request state are absent from error text

  @core
  Scenario: R6 — Applications compose the backend without changing existing defaults
    # covers: I1, I2, I3, I4
    Given the existing registry can register a lazy custom maker named clef
    When an application injects createClefDriver and registers the resulting DecisionMaker
    Then a catalog decision can resolve that maker using the existing extension seam
    And ai-runner does not import or depend on the Clef package
    And existing backend defaults and registry built-ins remain compatible
    And the package README documents both model variants explicit credentials hosted scope and provider limits
    And HTTP uses APIClient and decision boundary rules enforce the package dependency direction
```

## Tasks

<!-- AUTO-GENERATED by spur feature refresh -->
| WBS | Task | Status |
| --- | ---- | ------ |
| 0108 | Implement the hosted Clef DecisionDriver package | done |
<!-- END AUTO-GENERATED -->

## Notes

## History

- 2026-10-09T20:28:59.958Z backlog → active (system)
- 2026-10-09T20:30:40.221Z active → verifying (system)
- 2026-10-09T20:31:42.680Z verifying → done (system)

