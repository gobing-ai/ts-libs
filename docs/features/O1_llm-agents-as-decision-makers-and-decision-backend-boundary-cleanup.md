---
schema_version: 1
id: "O1"
name: "LLM agents as decision makers and decision-backend boundary cleanup"
status: done
priority: P2
tags: []
created_at: "2026-10-19T06:29:03.007Z"
updated_at: "2026-10-19T19:11:19.059Z"
---

# O1: LLM agents as decision makers and decision-backend boundary cleanup

## Goal

Let any installed LLM agent or model act as a contract-compatible decision maker, by lifting the engine-agnostic sampling and estimation logic out of `ts-decision-fm` into the neutral decision contract and building an agent-backed driver on it — while tightening the decision package boundary so `ts-ai-runner` owns only the provider-neutral contract and every concrete backend (including TypeSafe) lives in a driver package or the `ts-ai-decision` hub.

## Scope

**In scope**

- A pure, dependency-free sampled-driver core in `ts-ai-runner` (`src/decision/`): prompt rendering, per-question enum options, JSON answer parsing/validation, k-sample frequency estimation and entropy confidence (ADR-030 estimator generalized).
- Refactor `ts-decision-fm` onto that core with byte-for-byte unchanged answers; keep its public exports (re-exported) for compatibility.
- An agent-backed LLM decision driver in `ts-ai-decision` that samples any `ts-ai-runner` agent/model through `AiRunner.runPromptCommand`, runs in an isolated scratch working directory, and is pre-registered as a lazy built-in maker visible to downstream `spur decision status`.
- Move the TypeSafe driver and its pinned `@typesafe-ai/sdk` dependency from `ts-ai-runner` to `ts-ai-decision`; keep `createDecisionMaker()`'s `typesafe` backend working for one release through a deprecated dynamic-import bridge (ADR-028 pattern).
- New ADR entry superseding the relevant parts of ADR-028/ADR-033, updated `decision-boundaries` spur rules, package READMEs, architecture/design docs, and a Spur migration note.

**Out of scope**

- Renaming `packages/laya-mlx` or the published `@gobing-ai/ts-laya-mlx` (evaluated and declined — see idea-eval report Q2).
- Moving the neutral decision contract out of `ts-ai-runner` (would create a cycle with the driver packages).
- A new `ts-decision-agent` npm package, constrained decoding for generic agents, token log-probability estimation, caching, or concurrency pools beyond a simple per-ask sample concurrency option.
- Registering `clef` as a built-in registry maker (ADR-037 keeps it consumer-registered).
- Changes to downstream Spur itself beyond the migration note.

## Acceptance Criteria

```gherkin
Feature: LLM agents as decision makers and decision-backend boundary cleanup

  @core
  Scenario: R1 — ts-ai-runner exports a dependency-free sampled-driver core
    # covers: I5, I6
    Given packages/ai-runner/src/decision contains the sampled-driver core module
    When a consumer imports the prompt renderer, declared-options helper, answer parser and the choice, score and noul frequency estimators from @gobing-ai/ts-ai-runner
    Then the module imports no SDK, no workspace package and no platform API
    And createSampledDriver accepts a name, a sample count, a deterministic flag and a sampler callback returning raw model text per sample
    And the returned driver satisfies the DecisionDriver contract and declares its estimator kind and sample count

  @core
  Scenario: R2 — Sampled answers use empirical frequencies and entropy confidence
    # covers: I4, I5
    Given a sampled driver with three samples whose sampler returns choice labels a, a, b for a choice question with labels a, b, c
    When the driver answers the question map
    Then the choice answer label is a with probabilities a 2/3, b 1/3 and c 0
    And confidence equals one minus the normalized entropy of that distribution
    And a score question returns the most frequent level with ties going to the lower level
    And a noul question returns only kind and a yes probability with no confidence field

  @core
  Scenario: R3 — Malformed sample output fails through the decision error taxonomy
    # covers: I4, I5
    Given a sampled driver whose sampler returns text with no JSON object, a missing question key, or a value outside the declared options
    When the driver answers the question map
    Then the ask rejects with DecisionBackendError naming the offending question key
    And no partial answer is returned
    And a JSON object wrapped in surrounding prose or a fenced code block is still parsed

  @core
  Scenario: R4 — decision-fm answers are unchanged after moving onto the shared core
    # covers: I6
    Given the existing decision-fm test suite and a recorded set of fm respond stdout fixtures
    When createFmDriver answers the same question maps after the refactor
    Then every answer, probability, confidence and error is identical to the pre-refactor output
    And fm keeps its schema-constrained respond call, token budget preflight and platform check
    And every symbol previously exported from @gobing-ai/ts-decision-fm is still exported

  @core
  Scenario: R5 — Agent decision driver samples an ai-runner agent in an isolated directory
    # covers: I4, I5
    Given createAgentDriver from @gobing-ai/ts-ai-decision configured with agent claude, a model id and an injected AiRunner whose process executor is mocked
    When the driver answers a mixed choice, score and noul question map
    Then each sample is one runPromptCommand call carrying the rendered prompt and the configured model
    And every call runs with a fresh temporary working directory that is removed afterwards, never the caller's cwd
    And a per-call model on ask overrides the configured model
    And a non-zero agent exit code or timeout rejects with DecisionBackendError

  @core
  Scenario: R6 — Agent maker is a lazy built-in in the decision registry
    # covers: I4, I8
    Given a DecisionMakerRegistry constructed with default built-ins
    When names() is read before any resolve
    Then it lists typesafe, fm-local, laya-local and llm-agent without constructing any driver or spawning any process
    And resolving llm-agent with no configured agent selects the first detected tier-1 agent
    And resolving llm-agent when no agent is detected rejects with DecisionConfigError so a catalog decision resolves to its fallback

  @core
  Scenario: R7 — TypeSafe driver lives in ts-ai-decision and ts-ai-runner drops the SDK
    # covers: I1, I2
    Given the refactored workspace
    When the package manifests and sources are inspected
    Then @typesafe-ai/sdk is a dependency of @gobing-ai/ts-ai-decision and not of @gobing-ai/ts-ai-runner
    And createTypesafeDriver is exported from @gobing-ai/ts-ai-decision
    And the decision-boundaries spur rules allow the SDK only inside the ts-ai-decision TypeSafe driver file
    And ts-ai-runner still exports the neutral types, errors, validators and createDecisionMaker

  @core
  Scenario: R8 — Legacy typesafe backend selection keeps working through a deprecated bridge
    # covers: I2
    Given a consumer that calls createDecisionMaker with no driver and no backend, with TYPESAFE_API_KEY set
    When the first decision is asked
    Then ts-ai-runner dynamically imports createTypesafeDriver from @gobing-ai/ts-ai-decision and answers through it
    And when @gobing-ai/ts-ai-decision cannot be imported the ask rejects with DecisionConfigError carrying an install hint
    And the typesafe backend option is marked deprecated in its TSDoc

  @core
  Scenario: R9 — Decision architecture records and docs describe the new boundary
    # covers: I3, I7
    Given the feature implementation is complete
    When docs/00_ADR.md, docs/03_ARCHITECTURE.md and the ai-runner, ai-decision and decision-fm READMEs are read
    Then a new dated ADR states the contract-core in ts-ai-runner, drivers outside it rule, and amends ADR-028 and ADR-033
    And the ADR records why the laya-mlx directory keeps its name
    And the ai-decision README documents llm-agent configuration, sample cost and the isolated working directory
    And the canonical workspace gate and build succeed

  @edge
  Scenario: R10 — Deterministic agent sampling is one sample with one-hot probabilities
    # covers: I4
    Given an agent driver configured with deterministic true and samples 5
    When the driver answers a choice question
    Then exactly one runPromptCommand call is made
    And the chosen label has probability 1 and confidence 1
```

## Tasks

<!-- AUTO-GENERATED by spur feature refresh -->
| WBS | Task | Status |
| --- | ---- | ------ |
| 0114 | Extract sampled-driver core into ts-ai-runner and rebase ts-decision-fm on it | done |
| 0115 | Agent-backed llm-agent decision driver and registry built-in in ts-ai-decision | done |
| 0116 | Relocate TypeSafe driver to ts-ai-decision with deprecated ai-runner bridge and finalize decision docs | done |
<!-- END AUTO-GENERATED -->

## Notes

## History

- 2026-10-19T17:03:08.435Z moved O → P1 (system)
- 2026-10-19T17:03:11.500Z moved P1 → O1 (system)
- 2026-10-19T17:36:27.087Z backlog → active (system)
- 2026-10-19T19:11:18.723Z active → verifying (system)
- 2026-10-19T19:11:19.059Z verifying → done (system)

