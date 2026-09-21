---
schema_version: 1
id: "J"
name: "Local Laya decision backend in ts-laya-mlx"
status: backlog
priority: P2
tags: []
created_at: "2026-09-21T01:13:13.175Z"
updated_at: "2026-09-21T03:07:33.630Z"
---

# J: Local Laya decision backend in ts-laya-mlx

## Goal

Give the typed-decision surface that shipped in `@gobing-ai/ts-ai-runner` a second, **local**
backend, so a `choice` / `score` / `noul` question can be answered on-device by the open-weight
Laya checkpoint instead of by the hosted TypeSafe ("Jev") API.

A new published workspace package, `@gobing-ai/ts-laya-mlx`, owns the local execution engine and
exposes it as a `DecisionDriver` — the same neutral question and answer types, the same error
taxonomy, and the same `DecisionMaker` facade that the hosted path already uses. `ts-ai-runner`
gains only an additive selection ergonomic, so downstream code chooses a backend by configuration
rather than by rewiring call sites.

The outcome is a drop-in, offline, zero-per-call-cost decision path that produces the same answers
as the reference implementation, and a second driver that proves the neutral seam is genuinely
neutral.

## Scope

### In scope

- New workspace package `packages/laya-mlx`, published as `@gobing-ai/ts-laya-mlx` and
  lockstep-versioned with the rest of the monorepo.
- A TypeScript `DecisionDriver` that executes the Laya multilingual checkpoint by driving the
  vendored `laya-mlx` Python runtime as a long-lived JSON-lines worker over `ts-runtime`'s
  `ProcessExecutor`, with the worker script published alongside the package.
- The bridge this package owns end to end: request construction, line framing and correlation,
  worker lifecycle, answer mapping onto the neutral `choice` / `score` / `noul` shapes, and
  translation of local failures into the existing decision error taxonomy.
- Declared host prerequisites — Apple Silicon macOS, and a Python interpreter carrying the
  runtime — verified at construction and at the startup handshake rather than surfacing as a raw
  process failure.
- Model-artifact resolution and caching driven through the worker: default model id, explicit
  local path, cache location, and offline behaviour.
- Parity against the checkpoint's shipped 63-question `validation.json` fixture, as an executable
  check rather than a claim.
- An additive, non-breaking backend-selection ergonomic in `packages/ai-runner` that keeps the
  dependency direction one-way, with no cycle between the two packages.
- Apache-2.0 attribution and the upstream NOTICE carried forward.
- ADR entries recording the execution-engine choice, the retained package name, and the new
  package's boundary rules.

### Out of scope

- Reimplementing the Laya forward pass in TypeScript — against `@mlx-node/core` or any other
  binding. The installed runtime owns every numeric path.
- An ONNX export and a portable `onnxruntime-node` engine; recorded as a follow-on feature for
  the hosts this design does not reach, not built here.
- A backend over Apple's Foundation Models `fm` command-line tool; that is a sibling driver for a
  different class of model, planned separately.
- Redistributing model weights inside the npm package, or installing the Python runtime on the
  consumer's behalf.
- Any breaking change to the neutral decision types, the `DecisionMaker` facade signature, or the
  behaviour of the existing TypeSafe driver.
- Modifying `vendors/laya-mlx`, which stays a read-only reference.
- The reference package's router, presets, e-mail and language helpers — this feature covers
  decision execution only.
- Training, fine-tuning, or evaluating the model itself.
- Serving the model over HTTP or as a sidecar service; the worker is a child process of the
  caller, not a server.
- Running the accelerated path on hosted CI runners.

## Acceptance Criteria

```gherkin
Feature: Local Laya decision backend in ts-laya-mlx

  @core
  Scenario: R1 — The workspace publishes ts-laya-mlx as a lockstep-versioned package
    # covers: I1
    Given the monorepo releases every package under packages/ at one shared version
    When packages/laya-mlx is built and packed
    Then the tarball declares the name @gobing-ai/ts-laya-mlx at the same version as every sibling package
    And its dependency on @gobing-ai/ts-ai-runner is written as workspace:* in the source tree
    And the lockstep version bump raises it together with the other packages

  @core
  Scenario: R2 — A decision is answered from the Laya multilingual weights with no network call
    # covers: I2, I5
    Given the Laya multilingual decision model is already present in the local artifact cache
    And no outbound network access is available
    When a caller asks a choice question through the ts-laya-mlx driver
    Then an answer is returned naming one of the supplied labels with a probability per label
    And no HTTP request is issued to any decision service

  @core
  Scenario: R3 — Local answers agree with the reference implementation on the shipped validation fixture
    # covers: I2, I5
    Given the 63-question validation fixture distributed with the Laya multilingual checkpoint
    When every fixture question is answered through the ts-laya-mlx driver
    Then each returned choice label, score, and yes-probability matches the fixture's recorded expectation within the documented tolerance
    And the run reports agreement on 63 of 63 questions

  @core
  Scenario: R4 — The local driver satisfies the same DecisionDriver contract as the hosted backend
    # covers: I3, I4
    Given the neutral decision types exported by @gobing-ai/ts-ai-runner
    When the ts-laya-mlx driver is type-checked against the DecisionDriver interface
    Then it compiles as a DecisionDriver carrying a readonly name and a single ask method
    And its answers use the same choice, score, and noul answer shapes the hosted driver returns
    And a noul answer carries only the yes-probability, with no confidence field present or synthesized

  @core
  Scenario: R5 — An application swaps to the local backend without editing a call site
    # covers: I3, I6
    Given an application that asks typed decisions through createDecisionMaker against the hosted backend
    When its configuration selects the local backend instead
    Then every existing ask, choice, score, and noul call compiles and runs unchanged
    And the resolved answers keep the neutral shapes the hosted backend produced

  @core
  Scenario: R6 — ts-ai-runner names the local backend without depending on its package
    # covers: I6
    Given @gobing-ai/ts-ai-runner exposes a named backend selector over its existing driver seam
    When the local backend is selected by name
    Then the local driver is resolved when a decision is first asked rather than by a static import
    And the ts-ai-runner manifest declares no dependency on @gobing-ai/ts-laya-mlx
    And selecting the hosted backend by name resolves the existing driver with no change in behaviour

  @core
  Scenario: R7 — Local failures surface through the existing decision error taxonomy
    # covers: I3, I4
    Given a ts-laya-mlx driver configured with a model artifact path that does not exist
    When a caller asks a decision
    Then the call rejects with one of the decision error classes exported by @gobing-ai/ts-ai-runner
    And the message names the artifact that could not be resolved

  @core
  Scenario: R8 — The package resolves and caches the model artifact on the caller's behalf
    # covers: I2, I5
    Given no Laya model artifact exists in the cache directory
    When a driver is created with the default model id
    Then the artifact is fetched once into the cache directory
    And a second driver created afterwards starts from the cached copy without fetching again
    And an explicit local artifact path takes precedence over the default model id

  @core
  Scenario: R9 — The published package carries upstream attribution and no weights
    # covers: I1, I5
    Given the vendored reference is distributed under Apache-2.0 with a NOTICE crediting the upstream project
    When the ts-laya-mlx tarball is inspected
    Then it contains the Apache-2.0 licence text and a NOTICE naming the upstream project and the revision it derives from
    And it contains no model weight files

  @core
  Scenario: R10 — Missing host prerequisites are reported before any decision is attempted
    # covers: I2, I5
    Given a host without the runtime distribution that executes the Laya checkpoint
    When a caller creates a driver and asks a decision
    Then the call rejects with a configuration error naming the missing prerequisite and the command that installs it
    And no raw process-spawn message reaches the caller
    And the package documentation states the supported runtime version range

  @core
  Scenario: R11 — The package documentation maps its surface onto the hosted SDK reference
    # covers: I3, I4
    Given the TypeSafe JavaScript SDK API reference is the contract of record for the external surface
    When the ts-laya-mlx README is read
    Then every exported factory, option, and answer field is listed beside the hosted counterpart it mirrors
    And each intentional divergence is named together with its reason

  @edge
  Scenario: R12 — A question set larger than the configured batch size is answered in chunks
    # covers: I5
    Given a driver configured with a batch size of 16
    When forty questions are asked in one call
    Then all forty answers are returned keyed by their question names
    And each answer equals the answer the same question receives when asked alone

  @edge
  Scenario: R13 — Non-finite model output is reported instead of being returned as an answer
    # covers: I5
    Given a driver running at a reduced numeric precision that produces non-finite model outputs
    When a decision is asked
    Then the call rejects with a decision error naming the precision problem
    And no answer containing a non-finite probability is returned

  @edge
  Scenario: R14 — An unsupported platform is refused at construction rather than at inference
    # covers: I1, I2
    Given a host that is not Apple Silicon macOS
    When a driver is created and a decision is asked
    Then the call rejects with a configuration error naming the platform requirement
    And the hosted backend stays selectable on that host with no change in behaviour

  @edge
  Scenario: R15 — Repeated decisions reuse one warm runtime instead of reloading the model
    # covers: I2, I5
    Given a driver that has already answered one decision
    When the same driver answers ten further decisions
    Then the model weights are loaded once for the driver's lifetime
    And no decision after the first pays the weight-load cost
```

## Tasks

<!-- AUTO-GENERATED by spur feature refresh -->
| WBS | Task | Status |
| --- | ---- | ------ |
| 0074 | Scaffold the ts-laya-mlx package with attribution and no weights | todo |
| 0075 | Publish the worker script and fix the JSON-lines protocol | todo |
| 0076 | Drive the worker over ProcessExecutor with correlation and timeouts | todo |
| 0077 | Validate host prerequisites and translate failures into the decision taxonomy | todo |
| 0078 | Map worker answers onto the neutral decision types | todo |
| 0079 | Resolve and cache the model artifact through driver options | todo |
| 0080 | Add the named backend selector to ts-ai-runner without a dependency edge | todo |
| 0081 | Build the two-layer parity check against the shipped validation fixture | todo |
| 0082 | Document the package surface against the hosted SDK reference | todo |
<!-- END AUTO-GENERATED -->

## Notes

## History
