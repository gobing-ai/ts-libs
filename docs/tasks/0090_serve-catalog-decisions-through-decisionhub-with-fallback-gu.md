---
schema_version: 1
name: Serve catalog decisions through DecisionHub with fallback-guaranteed decide
status: done
template: feature-impl
created_at: 2026-10-03T05:42:57.282Z
updated_at: "2026-10-03T19:06:23.370Z"
feature_id: N
priority: P2
tags:
  - ai-decision
  - hub
  - decision-maker
estimate_hours: 6

dependencies: ["0089", "0091"]
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-dev-runall-feature-n-5d1f7c/.spur/memory/evidence/0090-verdict.json
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

- [x] R1. Implement `DecisionHub` with `registry`, `load(catalog)`, `loadFile(path, options)`, `list()` and `describe(id)`. `load` raises `DecisionCatalogError` and registers nothing from the offending catalog when:
  - a decision id duplicates one from another catalog (the error names both sources)
  - a decision or `defaults.maker` name is not registered (field `maker`)
- [x] R2. Discovery methods never construct a `DecisionMaker` or driver:
  - `list()` returns `{id, type, description, source}`
  - `describe(id)` returns the parameter contract (including `instructions`) with type, default and required flag, plus the criteria, fallback, effective confidence floor and effective maker name
- [x] R3. `decide(id, input, options)` resolves the input, renders the question and issues exactly one `maker.ask({ state, questions: { [id]: question }, model })`:
  - choice uses `q.choice`, score uses `q.score`, and noul uses `q.noul(prompt, { yes: criteria.true, no: criteria.false })`
  - `model` resolves from the decision, then the catalog default, then is omitted
- [x] R4. Return the `DecisionResult` envelope `{id, type, value, confidence, source, reason, maker, durationMs}`:
  - choice: `value` is a string label
  - score: `value` is the expected score (a number, possibly fractional)
  - noul: `value` is a boolean (`p >= 0.5`), with `probability` and confidence `max(p, 1-p)`
- [x] R5. Error and confidence handling:
  - map `DecisionConfigError` and any `registry.resolve` factory failure to `no-backend`, `DecisionTimeoutError` to `timeout`, and any other backend failure or invalid answer to `error`; each returns the declared fallback with `source: 'default'`
  - an answer below the effective `minConfidence` (decision, then catalog defaults, then 0.7) returns the fallback with `low-confidence`
- [x] R6. Caller errors throw before any backend call:
  - an unknown id raises `UnknownDecisionError`
  - invalid input raises `DecisionInputError`
  - an unregistered per-call `maker` raises `UnknownDecisionMakerError`
  - the constructor raises `UnknownDecisionMakerError` for an unregistered `defaultMaker`
- [x] R7. Select the maker name with this precedence: per-call `options.maker`, then the decision's `maker`, then the catalog's `defaults.maker`, then the hub's `defaultMaker` (default `typesafe`). Resolve it through `registry.resolve`; the hub builds no maker itself.
- [x] R8. Ship `examples/decisions.yaml` with `category`/`bug_severity`/`refund_requested` matching the design doc. Complete the package README with:
  - the catalog format, including the reserved `instructions` param and `${params.*}`
  - hub usage
  - the fallback contract
  - maker registration and selection
- [x] R9. Provide `createDecisionHub(options)`:
  - use `options.registry` or build one with `options.builtins`
  - register `options.makers`
  - construct the hub and `loadFile` each of `options.catalogs` in order with `options.catalogOptions`
  - any failure rejects, and no partially built hub is returned

### Acceptance Criteria

- [x] AC1 — The hub loads several catalogs and rejects a duplicate decision id
- [x] AC2 — The hub lists and describes its decisions for downstream discovery
- [x] AC3 — decide sends exactly one Jev-shaped question with parameters substituted into instructions and criteria
- [x] AC4 — A confident backend answer is returned with model provenance
- [x] AC5 — Backend failures resolve to the declared fallback instead of throwing
- [x] AC6 — An answer below the confidence floor resolves to the declared fallback
- [x] AC7 — Caller mistakes raise named errors instead of falling back
- [x] AC8 — Maker selection follows a fixed precedence by name without new driver code
- [x] AC9 — The reserved instructions parameter carries caller text to the model
- [x] AC10 — An unregistered maker name fails loudly instead of falling back
- [x] AC11 — One call builds a ready hub from catalog files and maker registrations

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

- [x] List the ways decide can fail or mislead, then write the e2e cases for each before writing the hub. Cases:
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
- [x] Implement the registry with `load`/`loadFile`/`list`/`describe` and duplicate-id rejection.
- [x] Implement `createDecisionHub` after `decide`.
- [x] Implement `decide`: input resolution, question rendering, state building, maker-name selection through the registry, the single `ask`, the confidence floor, and the error-to-reason mapping.
- [x] Write the e2e suite in tests/:
  - load `examples/decisions.yaml` into a hub
  - drive `decide` through scripted makers registered by name, each built on a scripted `DecisionDriver` that records requests
  - assert the substituted Jev question and the state
  - cover each reason and every maker-precedence step, including `createDecisionHub` over two catalog files
  - write a JSON transcript of results as the repeatable artifact
- [x] Finish the README and the example catalog.
- [x] Run `bun run spur-check` and `bun run build`.

### Solution

Change-map (task 0090, feature N serving side; anchors verified by fresh verifier run 22d06a04):

- `packages/ai-decision/src/hub.ts:1` — `DecisionHub`: constructor ({registry, defaultMaker='typesafe', now}) :150-172; `load` all-or-nothing staging with duplicate-id (names both sources) and unregistered decision/defaults maker errors :182-218; `loadFile` :221; pure `list` :226 and `describe` :236 (contract incl. reserved instructions, criteria, fallback, effective floor/maker); `decide` :263-388 — caller errors pre-backend (UnknownDecisionError/DecisionInputError/UnknownDecisionMakerError :263-275), maker-name precedence :266, single Jev question keyed by decision id with `${params.*}` substitution and model precedence :278-291, one try/catch mapping DecisionConfigError/factory->no-backend, timeout->timeout, other->error :328-334, minConfidence floor decision->defaults->0.7 :296-306, DecisionResult envelope :317-327 (noul p>=0.5, confidence max(p,1-p) :123), fallback source:'default' :361-388; `createDecisionHub` :409-423 (registry-or-builtins, makers, loadFile each catalog in order, reject without partial hub).
- `packages/ai-decision/src/errors.ts:33` — `UnknownDecisionError {decisionId}` (name set :44).
- `packages/ai-decision/src/index.ts:4` — barrel exports hub, createDecisionHub, UnknownDecisionError.
- `packages/ai-decision/tests/hub.test.ts:1` — e2e-first suite, 27 tests: 14 planned failure/behavior cases over scripted DecisionDriver makers registered by name; substituted question/state/model asserts :314; every reason :556-674, :782; every maker-precedence step :351; createDecisionHub over two catalog files :709,760; JSON transcript artifact `tests/output/hub-e2e-transcript.json` (all five reason values); review-sensitivity additions :782 (default 0.7 floor) :802 (discovery runs 0 factories).
- `packages/ai-decision/examples/decisions.yaml:16` — category/bug_severity/refund_requested matching the design doc.
- `packages/ai-decision/README.md:14` — catalog format (reserved `instructions` + `${params.*}`), hub usage :57, fallback contract :81, maker registration/selection :104.
- `biome.json:1` — `!**/tests/output` exclusion for the generated transcript artifact.

Rationale: single `decide` call site makes the fallback guarantee auditable (Design); hub builds no makers — all selection flows through the 0091 registry; no new driver code.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | hub.ts:150 registry, 182 load, 221 loadFile, 226 list, 236 describe; all-or-nothing staging hub.ts:196-218; duplicate names both sources hub.ts:198-204 (field id), decision/defaults maker hub.ts:185-191,207-212 (field maker); tests hub.test.ts:196 duplicate both sources + nothing registered, 225, 251 |
| R2 | MET | list hub.ts:226-233 {id,type,description,source}; describe hub.ts:236-258 parameters (incl. instructions), criteria, fallback, effective floor/maker; purity test 'list() and describe() never run a maker factory' hub.test.ts:802 (factoryRuns 0); contract test hub.test.ts:163 |
| R3 | MET | single request hub.ts:278-285 (questions keyed by decision id, model decision->defaults->omitted), one maker.ask hub.ts:291; q.choice/q.score/q.noul hub.ts:133-147 (noul yes/no criteria hub.ts:139-145); test hub.test.ts:314 exactly one substituted question; model precedence hub.test.ts:416 |
| R4 | MET | DecisionResult envelope hub.ts:44-63; choice label hub.ts:317-318, score number hub.ts:319-320, noul p>=0.5 + probability hub.ts:321-327, confidence max(p,1-p) hub.ts:123; tests hub.test.ts:459 fractional 1.5, 488, 512 boundary 0.5/0.45 |
| R5 | MET | catch mapping hub.ts:328-334 (DecisionConfigError->no-backend, Timeout->timeout, else error); fallback source:'default' hub.ts:361-388; floor decision->defaults->0.7 hub.ts:110-112 + :37; low-confidence hub.ts:296-306; tests hub.test.ts:593, 622 factory throw->no-backend, 656, 674, 556, 573, 782 default 0.7 floor |
| R6 | MET | UnknownDecisionError hub.ts:263 via mustGet hub.ts:343-351 (errors.ts:33-46); DecisionInputError hub.ts:264 via params.ts:57-84; per-call UnknownDecisionMakerError hub.ts:266-275; constructor hub.ts:166-172; all pre-backend — tests hub.test.ts:276, 286, 298, 307 each assert 0 driver requests |
| R7 | MET | precedence hub.ts:266 options.maker ?? definition.maker ?? defaults.maker ?? this.defaultMaker; DEFAULT_MAKER 'typesafe' hub.ts:40; resolved only via registry.resolve hub.ts:289-290, hub builds no maker; test hub.test.ts:351 every maker-precedence step |
| R8 | MET | examples/decisions.yaml:16-49 category/bug_severity/refund_requested field-for-field identical to design doc; README.md:14,50 catalog format + reserved instructions + ${params.*}, :57 hub usage, :81 fallback contract, :104,128 maker registration/selection |
| R9 | MET | createDecisionHub hub.ts:409-423: registry-or-builtins :410, makers registered :411-413, catalogs loadFile in order with catalogOptions :414-416; failure rejects; tests hub.test.ts:709 two catalogs end-to-end, 760 bad path and second-file failure |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | test | hub.test.ts:163 loads examples/decisions.yaml (3 decisions); :196 duplicate id rejected naming duplicate.yaml + EXAMPLES_PATH, brand_new not registered |
| AC-2 | MET | test | hub.test.ts:163 list summaries + describe (floor 0.7, maker typesafe, model jev-latest, instructions param); :802 discovery runs 0 factories |
| AC-3 | MET | test | hub.test.ts:314 exact substituted question + state {channel:'chat'}, exactly 1 request; :697 no ${params. reaches the wire |
| AC-4 | MET | test | hub.test.ts:314 result source:'model' confidence 0.9 maker 'typesafe' with ask-level model 'jev-latest'; score/noul accepted hub.test.ts:459, 488 |
| AC-5 | MET | test | hub.test.ts:593 keyless->no-backend, 622 factory throw->no-backend with retry, 656 timeout, 674 missing/mismatched answer->error; all source:'default' |
| AC-6 | MET | test | hub.test.ts:556 0.5<0.7 fallback low-confidence, 573 noul 0.5<declared 0.8, 782 default floor 0.65->low-confidence |
| AC-7 | MET | test | hub.test.ts:276 UnknownDecisionError, 286 DecisionInputError, 298 per-call UnknownDecisionMakerError, 307 constructor defaultMaker; each 0 requests |
| AC-8 | MET | test | hub.test.ts:351 all four precedence levels asserted; name-only routing via registry.resolve, no new driver code |
| AC-9 | MET | test | hub.test.ts:314 caller text lands in prompt, :488 noul passthrough, :697 empty-input default renders empty; implicit param params.ts:14-19 |
| AC-10 | MET | test | hub.test.ts:225 decision maker (field maker, nothing registered), 251 defaults.maker, 298 per-call throws before backend |
| AC-11 | MET | test | hub.test.ts:709 one createDecisionHub call over two catalog files + 3 makers serves decide; :760 bad path and second-file failure reject with no partial hub |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | — | — | No findings (verify verdict PASS) |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-10-03T18:48:59.630Z todo → wip (system)
- 2026-10-03T19:06:00.299Z wip → testing (system)
- 2026-10-03T19:06:23.363Z testing → done (system)

