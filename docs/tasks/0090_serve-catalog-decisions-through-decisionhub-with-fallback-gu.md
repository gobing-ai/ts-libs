---
schema_version: 1
name: Serve catalog decisions through DecisionHub with fallback-guaranteed decide
status: todo
template: feature-impl
created_at: 2026-10-03T05:42:57.282Z
updated_at: "2026-10-03T15:41:06.184Z"
feature_id: N
priority: P2
tags:
  - ai-decision
  - hub
  - decision-maker
estimate_hours: 6

dependencies: ["0089", "0091"]
---

## 0090. Serve catalog decisions through DecisionHub with fallback-guaranteed decide

### Background

This is Feature N's serving side. Once catalogs load, `DecisionHub`:
- registers them and exposes discovery
- serves `decide(id, input, { maker })` with a guaranteed concrete answer, sending one Jev-shaped question per call through a maker picked by name from the 0091 registry
- offers `createDecisionHub` as the one-call entry point
- resolves model problems to the declared fallback; only caller mistakes throw

See ADR-033 and `docs/design/ai-decision-catalog.md` § API and § decide algorithm.

Implements: R6 — The hub loads several catalogs and rejects a duplicate decision id; R7 — The hub lists and describes its decisions for downstream discovery; R8 — decide sends exactly one Jev-shaped question with parameters substituted into instructions and criteria; R9 — A confident backend answer is returned with model provenance; R10 — Backend failures resolve to the declared fallback instead of throwing; R11 — An answer below the confidence floor resolves to the declared fallback; R12 — Caller mistakes raise named errors instead of falling back; R13 — Maker selection follows a fixed precedence by name without new driver code; R14 — The reserved instructions parameter carries caller text to the model; R16 — An unregistered maker name fails loudly instead of falling back; R17 — One call builds a ready hub from catalog files and maker registrations.

### Requirements

- [ ] R1. Implement `DecisionHub` with `registry`, `load(catalog)`, `loadFile(path, options)`, `list()` and `describe(id)`. `load` raises `DecisionCatalogError` and registers nothing from the offending catalog when:
  - a decision id duplicates one from another catalog (the error names both sources)
  - a decision or `defaults.maker` name is not registered (field `maker`)
- [ ] R2. Discovery methods never construct a `DecisionMaker` or driver:
  - `list()` returns `{id, type, description, source}`
  - `describe(id)` returns the parameter contract (including `instructions`) with type, default and required flag, plus the criteria, fallback, effective confidence floor and effective maker name
- [ ] R3. `decide(id, input, options)` resolves the input, renders the question and issues exactly one `maker.ask({ state, questions: { [id]: question }, model })`:
  - choice uses `q.choice`, score uses `q.score`, and noul uses `q.noul(prompt, { yes: criteria.true, no: criteria.false })`
  - `model` resolves from the decision, then the catalog default, then is omitted
- [ ] R4. Return the `DecisionResult` envelope `{id, type, value, confidence, source, reason, maker, durationMs}`:
  - choice: `value` is a string label
  - score: `value` is the expected score (a number, possibly fractional)
  - noul: `value` is a boolean (`p >= 0.5`), with `probability` and confidence `max(p, 1-p)`
- [ ] R5. Error and confidence handling:
  - map `DecisionConfigError` and any `registry.resolve` factory failure to `no-backend`, `DecisionTimeoutError` to `timeout`, and any other backend failure or invalid answer to `error`; each returns the declared fallback with `source: 'default'`
  - an answer below the effective `minConfidence` (decision, then catalog defaults, then 0.7) returns the fallback with `low-confidence`
- [ ] R6. Caller errors throw before any backend call:
  - an unknown id raises `UnknownDecisionError`
  - invalid input raises `DecisionInputError`
  - an unregistered per-call `maker` raises `UnknownDecisionMakerError`
  - the constructor raises `UnknownDecisionMakerError` for an unregistered `defaultMaker`
- [ ] R7. Select the maker name with this precedence: per-call `options.maker`, then the decision's `maker`, then the catalog's `defaults.maker`, then the hub's `defaultMaker` (default `typesafe`). Resolve it through `registry.resolve`; the hub builds no maker itself.
- [ ] R8. Ship `examples/decisions.yaml` with `category`/`bug_severity`/`refund_requested` matching the design doc. Complete the package README with:
  - the catalog format, including the reserved `instructions` param and `${params.*}`
  - hub usage
  - the fallback contract
  - maker registration and selection
- [ ] R9. Provide `createDecisionHub(options)`:
  - use `options.registry` or build one with `options.builtins`
  - register `options.makers`
  - construct the hub and `loadFile` each of `options.catalogs` in order with `options.catalogOptions`
  - any failure rejects, and no partially built hub is returned

### Acceptance Criteria

- [ ] AC1 — The hub loads several catalogs and rejects a duplicate decision id
- [ ] AC2 — The hub lists and describes its decisions for downstream discovery
- [ ] AC3 — decide sends exactly one Jev-shaped question with parameters substituted into instructions and criteria
- [ ] AC4 — A confident backend answer is returned with model provenance
- [ ] AC5 — Backend failures resolve to the declared fallback instead of throwing
- [ ] AC6 — An answer below the confidence floor resolves to the declared fallback
- [ ] AC7 — Caller mistakes raise named errors instead of falling back
- [ ] AC8 — Maker selection follows a fixed precedence by name without new driver code
- [ ] AC9 — The reserved instructions parameter carries caller text to the model
- [ ] AC10 — An unregistered maker name fails loudly instead of falling back
- [ ] AC11 — One call builds a ready hub from catalog files and maker registrations

Task-local check: `bun run spur-check` and `bun run build` pass, and the e2e transcript in tests/ shows every `reason` value.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

Approach: an in-process registry (a `Map` from id to a resolved decision plus its catalog defaults) with a single `decide` path. That path wraps one `maker.ask` call in a try/catch that maps errors to closed reasons. Reason: the fallback guarantee is the core contract, and one call site makes it auditable.

Rejected alternatives:
- network serving and caching (deferred; feature N out of scope)
- batching several decisions into one `ask`, which couples failures across unrelated decisions
- relying on ai-runner's dynamic `import()` of the fm and laya packages; the 0091 registry builds them from direct deps instead
- an injected `decisionMaker` that overrides every decision: it is replaced by a named maker plus `defaultMaker`, which composes with per-decision and per-call selection
- treating an unregistered name as a `no-backend` fallback: a misspelled name is a configuration or caller bug, so it fails loudly

Invariants:
- `decide` never rejects for backend construction, transport, timeout, answer validation or low confidence. It rejects only for an unknown id or invalid input, and does so before any backend call.
- Exactly one question per `decide` call, keyed by the decision id.
- `list` and `describe` are pure reads and never build a maker or driver.
- Makers come only from `registry.resolve(name)`, and the hub contains no driver code. `model` is passed per `ask` (`decision-maker.ts:31`).
- Every `maker` name a loaded catalog uses is registered, checked at `load`. Registering after load is allowed and affects only per-call names.
- `durationMs` uses an injectable clock (`now`, default `Date.now`) so tests are deterministic.

Key signatures:
- `new DecisionHub(options?)`, with options:
  - `registry?: DecisionMakerRegistry`
  - `defaultMaker?: string`
  - `now?: () => number`
- `decide(id: string, input?: Record<string, Json>, options?: { maker?: string }): Promise<DecisionResult>`
- `createDecisionHub(options?: DecisionHubOptions & { builtins?; makers?; catalogs?; catalogOptions? }): Promise<DecisionHub>`
- `class UnknownDecisionError`

Surface detail: `docs/design/ai-decision-catalog.md` § API, § Maker registry, § decide algorithm, § Request mapping (Jev).

### Plan

- [ ] List the ways decide can fail or mislead, then write the e2e cases for each before writing the hub. Cases:
  - backend missing or driver construction fails
  - timeout
  - invalid answer
  - low confidence
  - noul near 0.5
  - unknown id
  - bad input
  - duplicate id
  - wrong maker or model chosen
  - unregistered maker in a catalog, per call or as defaultMaker
  - a factory that throws
  - createDecisionHub with a bad catalog path
  - template not substituted
  - empty instructions
- [ ] Implement the registry with `load`/`loadFile`/`list`/`describe` and duplicate-id rejection.
- [ ] Implement `createDecisionHub` after `decide`.
- [ ] Implement `decide`: input resolution, question rendering, state building, maker-name selection through the registry, the single `ask`, the confidence floor, and the error-to-reason mapping.
- [ ] Write the e2e suite in tests/:
  - load `examples/decisions.yaml` into a hub
  - drive `decide` through scripted makers registered by name, each built on a scripted `DecisionDriver` that records requests
  - assert the substituted Jev question and the state
  - cover each reason and every maker-precedence step, including `createDecisionHub` over two catalog files
  - write a JSON transcript of results as the repeatable artifact
- [ ] Finish the README and the example catalog.
- [ ] Run `bun run spur-check` and `bun run build`.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
