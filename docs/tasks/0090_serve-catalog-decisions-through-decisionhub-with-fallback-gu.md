---
schema_version: 1
name: Serve catalog decisions through DecisionHub with fallback-guaranteed decide
status: done
template: feature-impl
created_at: 2026-10-03T05:42:57.282Z
updated_at: "2026-10-03T22:16:56.512Z"
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
| R1 | MET | `packages/ai-decision/src/hub.ts:157` `DecisionHub`, :221 `loadFile`, :199 duplicate-id error naming both sources, all-or-nothing `load` (hub.ts:177-199); unregistered maker names checked at load — tests "rejects a duplicate decision id" / load-time maker checks pass this run |
| R2 | MET | `hub.ts:226` `list()` returns {id,type,description,source}; :236 `describe(id)` returns parameter contract incl. instructions, criteria, fallback, effective floor and maker; purity proven by test "list() and describe() never run a maker factory" — pass this run |
| R3 | MET | `hub.ts:261` `decide` issues exactly one `maker.ask` with `questions: { [id]: question }` (:282-286); `buildJevQuestion` maps choice/score/noul; model resolves decision → catalog default → omitted (:280) |
| R4 | MET | `hub.ts:308-325` result envelope per type: choice label, score number, noul boolean p>=0.5 with probability; `durationMs` via injectable `now` (:262) |
| R5 | MET | `hub.ts:329-335` error taxonomy: `DecisionConfigError`/resolve failure → `no-backend`, `DecisionTimeoutError` → `timeout`, else `error`; `low-confidence` floor at :300-307; each returns declared fallback with `source:'default'` via `fallbackResult` (:366) |
| R6 | MET | caller errors before any backend call: `UnknownDecisionError` at `mustGet` (:263, :342), `DecisionInputError` at :264, unregistered per-call maker → `UnknownDecisionMakerError` at :267-275; constructor defaultMaker check |
| R7 | MET | maker precedence per-call → decision → catalog defaults → hub default at `hub.ts:266`; resolved only via `registry.resolve` (:290), hub builds no maker itself |
| R8 | MET | `packages/ai-decision/examples/decisions.yaml` declares `category` (:10), `bug_severity` (:23), `refund_requested` (:36); README documents catalog format/hub usage/fallback contract/maker registration |
| R9 | MET | `hub.ts:409` `createDecisionHub`: registry or builtins, register makers, construct, loadFile catalogs in order, any failure rejects with no partial hub — test "a bad catalog path rejects; no partially built hub is returned" pass this run |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | test | `cd packages/ai-decision && bun test` → 97 pass / 0 fail (this run); hub.test.ts AC1 duplicate-id describe |
| AC-2 | MET | test | hub.test.ts AC2 describe + "list() and describe() never run a maker factory" |
| AC-3 | MET | test | hub.test.ts AC3 describe: exactly one Jev-shaped question with params substituted (scripted driver records requests) |
| AC-4 | MET | test | hub.test.ts AC4 describe: confident answer → source model, reason accepted, maker + durationMs |
| AC-5 | MET | test | hub.test.ts AC5/AC6 describe: backend cannot be constructed / timeout / decision error / invalid label all resolve to fallback without rejecting |
| AC-6 | MET | test | hub.test.ts AC5/AC6: below-floor noul answer → fallback, reason low-confidence; above floor → model |
| AC-7 | MET | test | hub.test.ts AC7: unknown id / invalid input / unregistered per-call maker throw named errors, no backend request |
| AC-8 | MET | test | hub.test.ts AC8: precedence per-call → decision → catalog → hub default with scripted makers alpha/beta/gamma/delta |
| AC-9 | MET | test | hub.test.ts AC9: reserved instructions carries caller text; empty when omitted; state null |
| AC-10 | MET | test | hub.test.ts AC10: unregistered maker fails loudly at load / per-call; factory throw → no-backend fallback |
| AC-11 | MET | test | hub.test.ts AC11: `createDecisionHub` over two catalog files with scripted-judge; factory lazy until first decide |
| R12 — Caller mistakes raise named errors instead of falling back | MET | test | hub.test.ts AC7 (this run): unknown id → UnknownDecisionError, invalid input → DecisionInputError, unregistered per-call maker → UnknownDecisionMakerError, each before any backend request (`hub.ts:263-275`) |
| R13 — Maker selection follows a fixed precedence by name without new driver code | MET | test | hub.test.ts AC8 (this run): precedence per-call → decision → catalog defaults → hub default `typesafe` (`hub.ts:266`), resolved via registry.resolve only, no new driver code |
| R14 — The reserved instructions parameter carries caller text to the model | MET | test | hub.test.ts AC9 (this run): caller instructions land in the question prompt; empty input renders empty text; state null (implicit param `params.ts:14-20`) |
| R16 — An unregistered maker name fails loudly instead of falling back | MET | test | hub.test.ts AC10 (this run): catalog declaring unregistered maker fails at load naming source/decision/field; per-call unregistered maker throws before backend; factory throw → fallback no-backend |
| R17 — One call builds a ready hub from catalog files and maker registrations | MET | test | hub.test.ts AC11 (this run): one `createDecisionHub` call over two catalog files + registered scripted-judge serves decide; bad path rejects with no partial hub (`hub.ts:409`) |
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

