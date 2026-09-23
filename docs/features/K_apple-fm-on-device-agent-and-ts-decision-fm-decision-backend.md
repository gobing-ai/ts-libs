---
schema_version: 1
id: "K"
name: "Apple fm on-device agent and ts-decision-fm decision backend"
status: done
priority: P2
tags: []
created_at: "2026-09-23T16:23:23.294Z"
updated_at: "2026-09-23T20:54:08.883Z"
---

# K: Apple fm on-device agent and ts-decision-fm decision backend

## Goal

Bring Apple's on-device Foundation Model — shipped with macOS 27 as the `fm` command-line tool — to
downstream users of this workspace through the two seams that already exist, without pretending it
is something it is not.

`@gobing-ai/ts-ai-runner` gains `fm` as one more agent, with detection, doctor/availability, prompt
execution and transcript-backed sessions. Its capability metadata states honestly that `fm` is a
text-only model with no file or shell tools, so it is never auto-selected for work that needs them.

A new published workspace package, `@gobing-ai/ts-decision-fm`, exposes the same model as a
`DecisionDriver` behind the existing neutral decision types, error taxonomy and `DecisionMaker`
facade, selectable as backend `fm-local`. Because `fm` exposes no token log-probabilities, answer
probabilities come from a declared multi-sample estimate — never from self-reported confidence.

The outcome is a zero-install, zero-key, offline prompt and decision path on every macOS 27 Apple
Silicon host, and a third driver that keeps the neutral decision seam honest.

## Scope

### In scope

- An `fm` agent entry in `packages/ai-runner`: detection, version reporting without a `--version`
  flag, availability via `fm available --model system`, one-shot prompt execution, structured
  output via `--schema`, and session continuity via `--save-transcript` / `--resume`.
- Honest capability metadata for `fm`: text-only, no file writes or shell tools, excluded from
  automatic agent selection that assumes a tool-using coding agent.
- New workspace package `packages/decision-fm`, published as `@gobing-ai/ts-decision-fm` and
  lockstep-versioned with the monorepo.
- A TypeScript `DecisionDriver` that answers `choice` / `score` / `noul` questions by invoking
  `fm respond --schema` over `ts-runtime`'s `ProcessExecutor`, with schemas that carry the
  `x-order` key the CLI requires.
- Probability estimation from k sequential non-greedy samples, with a deterministic greedy
  single-sample mode; the estimator is declared in the answer metadata.
- Context-size pre-flight via `fm count-tokens`, and translation of model-unavailable,
  context-overflow, guardrail-refusal and malformed-output failures into the existing decision
  error taxonomy.
- Declared host prerequisites — Apple Silicon, macOS 27+, `fm` on PATH, system model available —
  verified at construction rather than surfacing as a raw process failure.
- An additive, non-breaking `fm-local` backend selection in `packages/ai-runner` that keeps the
  dependency direction one-way, plus the matching boundary-rule update.
- Stubbed tests that pass on Linux CI, and a live check gated to capable macOS hosts.
- An ADR entry recording the package name, the sampling estimator and the prompt-only agent
  classification; package README and design/index docs per the constitution.

### Out of scope

- Private Cloud Compute (`--model pcc`) routing — not offered by the installed `fm` build.
- A long-lived `fm serve` HTTP/socket backend — verified to add no logprobs and no multi-sample
  support, so it brings lifecycle cost without capability.
- Self-reported or synthesised confidence in place of sampled probabilities.
- Any portable or non-macOS `fm` backend, and running the live model on hosted CI runners.
- Tool calling (`--tool`), image input, and `fm chat` interactive mode.
- Making `fm` perform file-editing or shell-driving coding-agent work.
- Any breaking change to the neutral decision types, the `DecisionMaker` facade, or existing
  drivers and agents.
- Calling the Foundation Models Swift framework directly or shipping a native binding.

## Acceptance Criteria

```gherkin
Feature: Apple fm on-device agent and ts-decision-fm decision backend

  @core
  Scenario: R1 — ts-ai-runner detects the fm agent and reports its version without a version flag
    # covers: I1, I2, I6
    Given a macOS 27 Apple Silicon host with the fm command-line tool installed at /usr/bin/fm
    When ts-ai-runner runs agent detection
    Then fm is listed as an installed agent
    And its reported version line carries the FoundationModels build identifier embedded in the fm binary
    And detection never invokes fm with a --version flag
    And a host without /usr/bin/fm reports fm as not installed

  @core
  Scenario: R2 — Doctor reports fm model availability from the system-model probe
    # covers: I2, I6
    Given the fm tool is installed
    When the ts-ai-runner doctor checks the fm agent
    Then it probes availability with fm available --model system
    And a non-zero probe exit is reported as unauthenticated
    And a zero probe exit is reported as authenticated

  @core
  Scenario: R3 — A prompt sent through the fm agent returns the model text response
    # covers: I1, I2
    Given the fm system model is available
    When a caller executes a prompt through ts-ai-runner with agent fm
    Then the prompt is delivered to fm respond without streaming
    And the model's text response is returned as the execution output with exit status zero

  @core
  Scenario: R4 — A second fm prompt in the same session continues the saved transcript
    # covers: I2, I6
    Given a caller executes a first prompt through the fm agent with a session directory and no session identifier
    When the caller executes a second prompt naming the saved transcript as its session identifier
    Then the first call saved its transcript into the session directory
    And the second call resumes that transcript so the model can refer to the first turn
    And a session identifier whose transcript does not exist fails the run instead of starting a fresh conversation

  @core
  Scenario: R5 — The fm agent declares itself text-only and is never auto-selected for tool-using work
    # covers: I1, I2
    Given the capability metadata exported for every ts-ai-runner agent
    When the fm entry is inspected
    Then it declares no file-writing and no shell-execution capability
    And automatic agent selection that prefers tool-using coding agents never resolves to fm
    And an explicit request for agent fm still resolves to fm

  @core
  Scenario: R6 — The workspace publishes ts-decision-fm as a lockstep-versioned package
    # covers: I3, I5
    Given the monorepo releases every package under packages/ at one shared version
    When packages/decision-fm is built and packed
    Then the tarball declares the name @gobing-ai/ts-decision-fm at the same version as every sibling package
    And its internal dependencies are written as workspace:* in the source tree
    And the lockstep version bump raises it together with the other packages

  @core
  Scenario: R7 — The fm driver satisfies the same DecisionDriver contract as the existing backends
    # covers: I3, I4
    Given the neutral decision types exported by @gobing-ai/ts-ai-runner
    When the ts-decision-fm driver is type-checked against the DecisionDriver interface
    Then it compiles as a DecisionDriver carrying a readonly name and a single ask method
    And its answers use the same choice, score and noul answer shapes the other drivers return

  @core
  Scenario: R8 — Choice probabilities come from repeated samples and never from self-reported confidence
    # covers: I4, I6
    Given an fm driver configured to draw k samples per question
    When a caller asks a choice question with three labels
    Then fm respond is invoked k times with sampling enabled and a schema restricting the answer to the supplied labels
    And each label probability equals the fraction of samples that returned that label
    And the driver declares its estimator as sample frequency together with the sample count
    And no prompt or schema asks the model to state its own confidence

  @core
  Scenario: R9 — Deterministic mode answers with a single greedy sample
    # covers: I4, I6
    Given an fm driver configured for deterministic answers
    When the same choice question is asked twice
    Then each ask invokes fm respond once with greedy sampling
    And both asks return the same label

  @core
  Scenario: R10 — Every generated schema carries the property-order key that fm requires
    # covers: I4, I6
    Given the fm tool rejects an object schema that lacks the x-order key
    When the driver builds the schema for a choice, score or noul question
    Then the schema lists every property under x-order
    And fm accepts the schema and returns JSON matching it

  @core
  Scenario: R11 — An application swaps to the fm-local backend without editing a call site
    # covers: I4
    Given an application that asks typed decisions through createDecisionMaker against another backend
    When its configuration selects the fm-local backend instead
    Then every existing ask, choice, score and noul call compiles and runs unchanged
    And the resolved answers keep the neutral answer shapes

  @core
  Scenario: R12 — ts-ai-runner names the fm-local backend without depending on its package
    # covers: I4
    Given @gobing-ai/ts-ai-runner exposes a named backend selector over its driver seam
    When the fm-local backend is selected by name
    Then the fm driver is resolved when a decision is first asked rather than by a static import
    And the ts-ai-runner manifest declares no dependency on @gobing-ai/ts-decision-fm
    And the decision boundary rule rejects any static import of @gobing-ai/ts-decision-fm from ts-ai-runner

  @core
  Scenario: R13 — An oversized question is rejected before the model is invoked
    # covers: I4, I6
    Given a question whose prompt exceeds the configured token budget as counted by fm count-tokens
    When a caller asks it through the fm driver
    Then the call rejects with a decision error naming the counted tokens and the budget
    And fm respond is never invoked

  @core
  Scenario: R14 — fm failures surface through the existing decision error taxonomy
    # covers: I4, I6
    Given fm respond fails because the model is unavailable, the context size is exceeded, the safety guardrails refuse, or the output does not match the schema
    When a caller asks a decision through the fm driver
    Then the call rejects with one of the decision error classes exported by @gobing-ai/ts-ai-runner
    And the message carries the fm error text
    And no refusal or malformed output is returned as an answer

  @core
  Scenario: R15 — Missing host prerequisites are reported before any decision is attempted
    # covers: I3, I6
    Given a host that is not Apple Silicon macOS 27 or later, or has no fm tool on PATH
    When a caller creates an fm driver and asks a decision
    Then the call rejects with a configuration error naming the missing prerequisite
    And a model that is present but not ready reports the reason text printed by fm
    And no raw process-spawn message reaches the caller

  @core
  Scenario: R16 — The test suites pass on Linux CI and exercise the live model only on capable hosts
    # covers: I3, I6
    Given the repository test command runs on a Linux CI runner without fm
    When the ts-ai-runner and ts-decision-fm suites run
    Then every stubbed test passes with the host platform pinned in its fixtures
    And the live-model checks are skipped by a host-capability condition rather than failing

  @docs
  Scenario: R17 — The design decisions and usage are recorded in the project documents
    # covers: I5, I6, I7
    Given the feature introduces a new package, a new backend name and a new agent classification
    When the documentation set is reviewed
    Then docs/00_ADR.md carries dated entries recording the package name, the sampling estimator and the text-only agent classification
    And packages/decision-fm/README.md documents host prerequisites, configuration, the sampling estimator and its latency cost
    And the ts-ai-runner README lists fm with its text-only capability
```

## Tasks

<!-- AUTO-GENERATED by spur feature refresh -->
| WBS | Task | Status |
| --- | ---- | ------ |
| 0083 | Add the fm text-only agent shim to ts-ai-runner | done |
| 0084 | Create the ts-decision-fm package with the sampling fm-local driver | done |
| 0085 | Wire the fm-local backend selector, boundary rules and docs | done |
<!-- END AUTO-GENERATED -->

## Notes

## History

- 2026-09-23T18:22:29.355Z backlog → active (system)
- 2026-09-23T19:54:29.689Z active → verifying (system)
- 2026-09-23T20:54:08.883Z verifying → done (system)

