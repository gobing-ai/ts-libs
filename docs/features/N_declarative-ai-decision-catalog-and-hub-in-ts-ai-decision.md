---
schema_version: 1
id: "N"
name: "Declarative AI decision catalog and hub in ts-ai-decision"
status: done
priority: P2
tags: []
created_at: "2026-10-03T05:38:02.433Z"
updated_at: "2026-10-03T19:32:35.932Z"
---

# N: Declarative AI decision catalog and hub in ts-ai-decision

## Goal

Give downstream applications a declarative, fallback-guaranteed way to use the workspace's
`DecisionMaker` backends. A new published package, `@gobing-ai/ts-ai-decision`, loads YAML/JSON
decision catalogs — each declaring named decision points with a `kind`, kind-specific answer
vocabulary, a typed parameter contract and a fallback answer — and serves them through an
in-process `DecisionHub`. A valid `decide(id, input)` call always returns a concrete typed answer:
the model's when it is available and confident enough, the declared fallback otherwise, with the
provenance stated in the result.

## Scope

### In scope

- New workspace package `packages/ai-decision`, published as `@gobing-ai/ts-ai-decision`,
  lockstep-versioned, with one-way `workspace:*` dependencies on `@gobing-ai/ts-ai-runner`
  (neutral surface and the TypeSafe Jev `typesafe` backend), `@gobing-ai/ts-decision-fm`
  (`fm-local`), `@gobing-ai/ts-laya-mlx` (`laya-local`) and `@gobing-ai/ts-runtime`.
- A YAML-only decision catalog format, with a shipped JSON Schema exported at
  `./schemas/decision-catalog.schema.json` and a matching zod schema. The catalog has `version`,
  optional `defaults` (maker, model, minConfidence) and `decisions` keyed by id.
- Each decision follows the TypeSafe Jev question shape:
  - `type`: choice, score or noul
  - an optional templated `instructions`
  - `criteria`: a label map for choice, an ordered rubric for score, optional `true`/`false` for noul
- Each decision also has typed `parameters`, a mandatory `fallback` valid for its type, and
  optional `minConfidence`, `maker` and `model` overrides.
  - Parameter types are string, number, boolean, enum and json, in shorthand `name: type` or full
    form.
  - A parameter without a default is required.
- A reserved `instructions` parameter on every decision carries the caller's text for the model to
  evaluate. It is the default question `instructions` when the author supplies no template.
- Variable replacement with `${params.<name>}` in `instructions` and criteria descriptions, applied
  before the backend call. The syntax is aligned with `ts-dual-workflow-engine`; no other
  namespace, including `${env.*}`, is allowed.
- Load-time validation that fails loudly on:
  - schema violations and non-YAML sources
  - a fallback outside the answer vocabulary
  - references to undeclared parameters or other namespaces
  - defaults that do not match their type
  - a declared `instructions` parameter
  - duplicate decision ids across catalogs in one hub
- `DecisionHub` with `load`/`loadFile`, `list()`/`describe(id)` introspection, and
  `decide(id, input)`. `decide` validates and defaults the input, renders the templates, asks exactly
  one question, applies the confidence floor, and returns a typed result envelope: `id`, `type`,
  `value`, `confidence`, `source: model | default`, closed `reason`, `maker`, `durationMs`.
- The fallback guarantee: model-side failures (no backend, timeout, decision error, invalid answer,
  low confidence) never throw from `decide`. Caller errors (unknown id, invalid input) throw named
  errors.
- A `DecisionMakerRegistry` mapping a name to a `DecisionMaker` or a lazy factory.
  - It pre-registers the built-ins `typesafe`, `fm-local` and `laya-local`; the bundled fm and laya
    drivers are injected through `createDecisionMaker({ driver })`, with no new driver code.
  - Consumers register their own makers under new names.
  - The registry has no catalog dependency, so it is usable on its own.
- Maker selection by name, with precedence: per-call `decide(..., { maker })`, then the decision's
  `maker`, then the catalog `defaults.maker`, then the hub `defaultMaker` (`typesafe`). An
  unregistered name fails loudly: at `hub.load` for catalogs, before any backend call for a per-call
  name.
- `createDecisionHub({ catalogs, makers, ... })`: one call from file paths and maker registrations
  to a ready hub.
- The ADR entry, package README, architecture/design docs per the constitution, and a runnable
  example catalog exercised by e2e tests with a scripted driver.

### Out of scope

- A network transport (HTTP/RPC server, authentication, multi-tenant hosting) for the hub;
  downstream applications mount `hub.decide` behind their own transport.
- Answer caching or memoization.
- Dynamic, call-time questions. Callers needing ad-hoc questions use `DecisionMaker` directly.
- Multi-question batching of several decision points into one model request.
- JSON catalogs.
- Template logic beyond `${params.*}` substitution: no conditionals, loops, helpers, escaping or
  environment references.
- Persistence, history, or a database-backed decision log.
- Changes to the neutral decision types, the `DecisionMaker` facade, or any existing driver.
- Migrating Spur's `decide` action onto this package.

## Acceptance Criteria

```gherkin
Feature: Declarative AI decision catalog and hub in ts-ai-decision

  @core
  Scenario: R1 — A catalog file with several decision points loads into typed decision definitions
    # covers: I1, I2, I4, I13, I14
    Given a YAML catalog declaring decision "category" of type choice, "bug_severity" of type score and "refund_requested" of type noul under decisions
    And each decision declares its criteria, parameters and fallback in the Jev question shape
    When the catalog is loaded from disk
    Then three decision definitions are returned keyed by their ids
    And each definition carries its type, its criteria, its parameters including the reserved instructions parameter and its fallback
    And the same content saved with a .json extension is rejected as an unsupported catalog source

  @core
  Scenario: R2 — The shipped JSON Schema validates a catalog that declares it
    # covers: I1, I14
    Given the package exports schemas/decision-catalog.schema.json
    And a catalog whose top-level $schema is the package specifier for that file
    When a catalog with a decision missing its type is loaded
    Then loading fails with a schema error naming the catalog file and the offending decision
    And a catalog that satisfies the schema loads without error

  @core
  Scenario: R3 — Declared parameter types and defaults shape the external input
    # covers: I3
    Given decision "bug_severity" declares parameter "component" in shorthand as string, "affected_users" as number with default 10 and "channel" as enum with values email and chat and default email
    When it is invoked with input component "checkout"
    Then the resolved parameters carry affected_users 10 and channel email from the declared defaults
    And input affected_users "ten" is rejected as a type mismatch naming the parameter
    And input channel "sms" is rejected because it is outside the declared enum values
    And input without component is rejected as a missing required parameter

  @core
  Scenario: R4 — An inconsistent catalog fails at load time with the decision and field named
    # covers: I1, I3, I4, I14, I15, I16
    Given catalogs each carrying one defect: a choice fallback outside the criteria labels, a reference to an undeclared parameter, an env reference, a parameter declared as instructions, a default that mismatches its type, and a score fallback outside the rubric levels
    When each catalog is loaded
    Then loading throws a catalog error naming the catalog source, the decision id and the offending field
    And no partially loaded decision is registered

  @core
  Scenario: R5 — The new ts-ai-decision package joins the workspace with one-way dependencies on ts-ai-runner and the bundled drivers
    # covers: I6, I12
    Given the workspace packages directory
    When packages/ai-decision is built and its manifest inspected
    Then it is published as @gobing-ai/ts-ai-decision at the lockstep workspace version
    And it depends on @gobing-ai/ts-ai-runner, @gobing-ai/ts-decision-fm, @gobing-ai/ts-laya-mlx and @gobing-ai/ts-runtime through workspace:*
    And no other workspace package imports @gobing-ai/ts-ai-decision
    And it imports no node:fs, node:path or process.env directly

  @core
  Scenario: R6 — The hub loads several catalogs and rejects a duplicate decision id
    # covers: I2, I7
    Given a DecisionHub loading catalog ops.yaml with decision "refund_requested" and catalog support.yaml that also declares "refund_requested"
    When the second catalog is loaded
    Then loading throws a duplicate-id error naming both catalog sources
    And the hub still serves the decisions loaded from ops.yaml

  @core
  Scenario: R7 — The hub lists and describes its decisions for downstream discovery
    # covers: I7, I9, I15
    Given a DecisionHub with the catalog from R1 loaded
    When a downstream application calls list and then describe for "category"
    Then list returns the three decision ids with their types and descriptions
    And describe returns the parameter contract including instructions with each type, default and required flag, the criteria, the fallback and the maker name
    And neither call constructs a decision backend

  @core
  Scenario: R8 — decide sends exactly one Jev-shaped question with parameters substituted into instructions and criteria
    # covers: I5, I14, I16
    Given decision "category" of type choice with instructions "Classify this ${params.channel} ticket: ${params.instructions}"
    And decision "bug_severity" whose rubric entry reads "Broken or degraded feature in ${params.component}; workaround exists"
    And a scripted decision driver that records each request
    When decide is called for "category" with input instructions "I was charged twice" and channel "chat"
    Then the driver receives one request with one choice question whose instructions read "Classify this chat ticket: I was charged twice" and whose labels are the criteria labels unchanged
    And the declared parameters other than instructions are passed as the decision state
    And when decide is called for "bug_severity" with component "checkout" the rubric entry reads "Broken or degraded feature in checkout; workaround exists"

  @core
  Scenario: R9 — A confident backend answer is returned with model provenance
    # covers: I5, I8
    Given decision "category" with minConfidence 0.7
    And a scripted driver answering label billing with confidence 0.9
    When decide is called for "category"
    Then the result carries id category, type choice, value billing, confidence 0.9, source model and reason accepted
    And the result names the maker that answered and the elapsed duration in milliseconds

  @core
  Scenario: R10 — Backend failures resolve to the declared fallback instead of throwing
    # covers: I8
    Given decision "category" with fallback account
    When decide is called while the backend cannot be constructed, times out, throws a decision error or answers a label outside the criteria
    Then decide resolves without throwing
    And the result carries value account, source default and a reason from no-backend, timeout or error matching the failure

  @core
  Scenario: R11 — An answer below the confidence floor resolves to the declared fallback
    # covers: I8
    Given decision "refund_requested" of type noul with fallback false and minConfidence 0.8
    When the scripted driver answers yes-probability 0.6
    Then the result carries value false, source default, reason low-confidence and confidence 0.6
    And when the scripted driver answers yes-probability 0.95 the result carries value true, source model and confidence 0.95

  @core
  Scenario: R12 — Caller mistakes raise named errors instead of falling back
    # covers: I7, I9
    Given a DecisionHub with the catalog from R1 loaded
    When decide is called for the undeclared id "free_form_question"
    Then it throws an unknown-decision error naming the id
    And when decide is called for "bug_severity" with an invalid input it throws an input error naming the parameter
    And no backend request is made in either case

  @core
  Scenario: R13 — Maker selection follows a fixed precedence by name without new driver code
    # covers: I5, I12
    Given a registry holding scripted makers "alpha", "beta", "gamma" and "delta"
    And a hub whose defaultMaker is "delta" loading a catalog with defaults maker "gamma" and decision "bug_severity" declaring maker "beta"
    When decide is called for "bug_severity" with option maker "alpha"
    Then "alpha" answers and the result names maker alpha
    And without the option "beta" answers "bug_severity" and "gamma" answers every other decision
    And a catalog with no maker anywhere is answered by "delta"
    And a hub built with no defaultMaker and no catalog maker selects the built-in typesafe maker

  @core
  Scenario: R14 — The reserved instructions parameter carries caller text to the model
    # covers: I15, I14
    Given decision "refund_requested" declares no instructions template and no parameters
    When decide is called with input instructions "Please refund my last invoice"
    Then the question sent to the backend has instructions "Please refund my last invoice"
    And the decision state is null
    And when decide is called without instructions the question instructions are empty and no input error is raised

  @core
  Scenario: R15 — Built-in DecisionMakers are registered by name and consumers register their own
    # covers: I17
    Given a new DecisionMakerRegistry with default options
    When its names are listed
    Then they include typesafe, fm-local and laya-local without any maker having been constructed
    And registering "scripted-judge" with a factory adds it, and resolving it twice runs the factory once
    And resolving fm-local with stub driver options yields a DecisionMaker backed by the bundled ts-decision-fm driver
    And registering an existing name or an invalid name throws a registry error
    And resolving an unregistered name throws an unknown-maker error

  @core
  Scenario: R16 — An unregistered maker name fails loudly instead of falling back
    # covers: I17
    Given a hub whose registry has no maker named "missing"
    When a catalog whose decision declares maker "missing" is loaded
    Then loading throws a catalog error naming the source, the decision and the maker field, and nothing is registered
    And when decide is called with option maker "missing" it throws an unknown-maker error before any backend request
    And when a registered maker factory throws during construction decide resolves to the fallback with reason no-backend

  @core
  Scenario: R17 — One call builds a ready hub from catalog files and maker registrations
    # covers: I17, I7
    Given catalog files ops.yaml and support.yaml and a scripted maker factory
    When createDecisionHub is called with both catalog paths and the factory registered as "scripted-judge"
    Then the returned hub lists the decisions from both files
    And a decision routed to "scripted-judge" is answered by the scripted maker
    And the factory is not invoked until the first decide that selects it
```

## Tasks

<!-- AUTO-GENERATED by spur feature refresh -->
| WBS | Task | Status |
| --- | ---- | ------ |
| 0089 | Scaffold ts-ai-decision and load decision catalogs | done |
| 0090 | Serve catalog decisions through DecisionHub with fallback-guaranteed decide | done |
| 0091 | Register DecisionMakers by name in a DecisionMakerRegistry | done |
<!-- END AUTO-GENERATED -->

## Notes

## History

- 2026-10-03T17:50:38.866Z backlog → active (system)
- 2026-10-03T19:16:10.316Z active → verifying (system)
- 2026-10-03T19:32:35.932Z verifying → done (system)

