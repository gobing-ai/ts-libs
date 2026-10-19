---
schema_version: 1
name: Extract sampled-driver core into ts-ai-runner and rebase ts-decision-fm on it
status: todo
template: feature-impl
created_at: 2026-10-19T06:34:09.533Z
updated_at: "2026-10-19T17:12:20.679Z"
feature_id: O1
priority: P2
tags:
  - ai-runner
  - decision-fm
  - decision

---

## 0114. Extract sampled-driver core into ts-ai-runner and rebase ts-decision-fm on it

### Background

Implements: R1 — ts-ai-runner exports a dependency-free sampled-driver core; R2 — Sampled answers use empirical frequencies and entropy confidence; R3 — Malformed sample output fails through the decision error taxonomy; R4 — decision-fm answers are unchanged after moving onto the shared core.

The engine-agnostic half of `packages/decision-fm` (prompt rendering in `src/schema.ts`, estimators in `src/estimate.ts`, enum check in `src/fm-process.ts`) is the base every LLM-as-decision-maker needs. ADR-038 places it in `ts-ai-runner` because `ts-ai-decision` already depends on `ts-decision-fm` (a core there would be a cycle). Shapes: `docs/design/llm-agent-decision-backend.md` § Sampled-driver core and § ts-decision-fm after the refactor.

### Requirements

- [ ] R1. Add `packages/ai-runner/src/decision/sampled-driver.ts` exporting `createSampledDriver`, `SampleSession`, `SampledDriverOptions`, `SampledDecisionDriver`, `EnumSchema`, `DECISION_INSTRUCTIONS`, `formatDesc`, `declaredOptions`, `buildPrompt`, `buildEnumSchema`, `requireEnumValue`, `extractJsonAnswer`, `entropyConfidence`, `estimateChoice`, `estimateScore`, `estimateNoul`. Add `export * from './decision/sampled-driver';` to `packages/ai-runner/src/index.ts` next to the existing `./decision/*` re-exports.
- [ ] R2. The core imports only `./types` and `./errors`. No SDK, workspace package, `node:*`, `Bun.*` or `process.*` imports.
- [ ] R3. Bodies move **verbatim** from decision-fm:
  - `schema.ts:19` `FM_INSTRUCTIONS` → `DECISION_INSTRUCTIONS`
  - `schema.ts:25` `FmSchema` → `EnumSchema`
  - `schema.ts:35` `buildFmSchema` → `buildEnumSchema`
  - `schema.ts:62` `formatDesc`, `schema.ts:69` `declaredOptions`, `schema.ts:86` `buildPrompt`
  - `estimate.ts:12/26/58/94` estimators
  - `fm-process.ts:202` `requireEnumValue` gains a 4th param `label = 'sample'`. Today it throws `` new DecisionBackendError(`fm sample for '${key}' violates the schema enum: ${value === undefined ? '(missing)' : `'${value}'`}`, undefined) ``. Generalise only the leading `fm` to `${label}`.
- [ ] R4. `createSampledDriver(options)` validates at construction. `samples` must be a positive integer, default 5; otherwise it throws `DecisionRequestError("samples must be a positive integer; got X")`, the same text as fm's `driver.ts:83`. `concurrency` must be a positive integer, default 1. The driver exposes `name` and `estimator: { kind: 'sample-frequency', samples: k, greedy: deterministic }`, where `k = deterministic ? 1 : samples`.
- [ ] R5. `ask({ state, questions, model })` runs in this order (the order is the contract):
  1. Empty map → `DecisionRequestError('expected a nonempty question map')`.
  2. Any question with fewer than 2 options → `DecisionRequestError("question '<key>' has fewer than two options (<n>)")`. Both texts are copied from `driver.ts:123-141`.
  3. `instructions = options.instructions ?? DECISION_INSTRUCTIONS`; `prompt = buildPrompt(state, questions)`.
  4. `session = await options.open({ instructions, prompt, questions, state, model })`.
  5. Inside `try { … } finally { await session.close?.() }`, draw k samples with at most `concurrency` in flight.
  6. For every sample and every key, run `requireEnumValue(sample, key, declaredOptions(q), sampleLabel ?? name)`.
  7. Estimate per kind.
  - Any sample failure rejects the whole ask with no partial estimate. Samples still in flight are awaited before `close` runs; use `Promise.allSettled` per batch, then rethrow the first rejection.
- [ ] R6. `extractJsonAnswer(text)` is lenient. In order it tries: (a) `JSON.parse(text.trim())`; (b) the body of the first fenced block tagged ```json (or untagged ```); (c) the first balanced `{…}` substring, scanned with a string/escape-aware brace counter.
  - The result must be a plain object whose values are all strings.
  - No object found → `DecisionBackendError('no JSON object in sample output', …)`.
  - A non-string value or an array/primitive → `DecisionBackendError` naming the offending key.
  - Constructor shape: `new DecisionBackendError(message, undefined)`; the second argument is the HTTP status (`errors.ts:28`).
- [ ] R7. `packages/decision-fm/src/driver.ts` `createFmDriver` keeps `FmDriverOptions` and `FmDecisionDriver` unchanged. It is rebuilt as:
  - A thin wrapper: the model guard (`model` must be `undefined` or `'system'`) runs **before** delegating to `inner.ask`. This keeps today's error order: the model error comes before the empty-map and options errors.
  - `inner = createSampledDriver({ name: 'fm-local', sampleLabel: 'fm', samples, deterministic, instructions: FM_INSTRUCTIONS, open })`.
  - `open`: `ensureFmAvailable()` (cached) → `countPromptTokens` budget check (same message) → write the schema temp file (`TMPDIR` + `fm-schema-<uuid>.json`). It returns `{ sample: () => runFmRespond(...).then(parseFmRespond), close: () => fs.deleteFile(schemaPath) }`.
  - The platform check stays at construction, after the samples check, keeping the existing order: samples error first, then `PLATFORM`.
  - Today `writeFile` runs inside the `try` whose `finally` deletes the file (`driver.ts:166-203`). After the refactor, `open` must return the session *before* writing, or delete on its own write failure, so that a failed write still triggers the delete exactly as today.
- [ ] R8. `packages/decision-fm/src/index.ts` keeps every export name: `FM_INSTRUCTIONS`, `buildFmSchema`, `FmSchema`, `formatDesc`, `declaredOptions`, `buildPrompt`, the estimators and `requireEnumValue`. They become re-exports or aliases from `@gobing-ai/ts-ai-runner`. `requireEnumValue` re-exported from fm keeps its 3-arg call working, with `label` defaulting to `'fm'` in the fm wrapper. `schema.ts` and `estimate.ts` shrink to aliases or are deleted. Delete them only if every test import is updated to the barrel.
- [ ] R9. Parity: every existing test in `packages/decision-fm/tests/{driver,estimate,fm-process,schema}.test.ts` passes **unmodified**, except for import-path changes where a source file was deleted. The new parity fixture (Plan step 1) matches byte-for-byte.

### Acceptance Criteria

- [ ] AC1 — ts-ai-runner exports a dependency-free sampled-driver core
- [ ] AC2 — Sampled answers use empirical frequencies and entropy confidence
- [ ] AC3 — Malformed sample output fails through the decision error taxonomy
- [ ] AC4 — decision-fm answers are unchanged after moving onto the shared core

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**Chosen.** A per-ask `SampleSession` hook (`open` → `sample` × k → `close`). fm keeps its schema file and token preflight, and the agent driver (0115) keeps its scratch dir, without a second abstraction.

**Rejected.**
- A sampler returning raw text with a shared parser: fm's strict `parseFmRespond` errors would change wording.
- The core in ts-ai-decision: it would be a cycle, because ts-ai-decision → ts-decision-fm.

**Placement.** The core goes in `ts-ai-runner/src/decision/`, beside `validation.ts`, which is already exported for external drivers (the ADR-037 precedent). ts-decision-fm already depends on ts-ai-runner, so no package.json or tsconfig `paths` change is needed. Verify with `packages/decision-fm/package.json` and `tsconfig.json`.

**Invariants (ADR-030).**
- Probabilities are sample frequencies over **declared** options only.
- argmax tie-break: declaration order for choice, lower level for score.
- Noul returns a bare `{ kind: 'noul', probability }` with **no** `confidence` key (`estimate.ts:93`). The hub derives `max(p, 1-p)`, never the driver.
- No confidence is ever asked of the model.

**Error-order preservation.**

| Step | fm today | After |
|---|---|---|
| construction | samples → PLATFORM | same (fm checks samples itself before PLATFORM, then builds core) |
| ask | model → empty map → <2 options → probe → budget → sample errors | model guard in fm wrapper → core (empty → <2 → open[probe → budget → schema]) → samples |

**Concurrency.** The default of 1 keeps fm sequential, matching its "k sequential respond calls" test (`driver.test.ts:196`). Implement it with a simple index-claiming worker pool of `concurrency` workers, without a new dependency.

**Failure modes, written before the code (each becomes a test in `packages/ai-runner/tests/decision/sampled-driver.test.ts`):**
1. Empty map → `DecisionRequestError`; `open` is never called.
2. A question with fewer than 2 options → `DecisionRequestError`; `open` is never called.
3. `open` throws → that error propagates; there is no session to close.
4. A sample throws on draw 2 of 3 → the ask rejects with that error; `close` is called exactly once.
5. A sample returns a value outside the enum → `DecisionBackendError` with the message `"<label> sample for '<key>' …"`; `close` is called.
6. A sample omits a key → `DecisionBackendError` (current `requireEnumValue` behaviour).
7. `close` throws after success → the close error propagates. This mirrors today's `finally { fs.deleteFile(schemaPath) }` (`driver.ts:201-203`), where a throwing delete wins.
8. `concurrency: 2` with `samples: 5` → never more than 2 in flight (track with a counter in a fake sampler).
9. `deterministic: true` → exactly one `sample()` call, one-hot probabilities, `greedy: true` in `estimator`.
10. Frequencies: choice 3/5 vs 2/5 → value and probabilities exact; a tie breaks by declaration order; score expected value; noul p.
11. `extractJsonAnswer`: bare object; prose + object; ```json fence; untagged fence; braces inside strings; nested object value → error; array → error; no object → error; numeric value → error.

### Plan

1. **Parity fixture first, before any move.** Add `packages/decision-fm/tests/parity.test.ts`. It drives the **current** `createFmDriver` through `StubFmExecutor` (copy it from `tests/driver.test.ts:31`) over these cases:
   - (a) a mixed choice/score/noul map, 5 samples, with a tie
   - (b) deterministic
   - (c) an enum violation
   - (d) non-JSON stdout
   - (e) over-budget
   - (f) a bad model
   - (g) an empty map
   It records `{answers | errorClass + message}` to `packages/decision-fm/tests/output/fm-parity.json`, written when absent and compared when present. Commit the generated JSON: it is the repeatable artifact. Run it once on unchanged code to create the baseline.
2. Write `packages/ai-runner/tests/decision/sampled-driver.test.ts` covering failure modes 1–11 from Design, against a fake `open`/`sample`. It fails at this point because the module is missing.
3. Create `sampled-driver.ts`: move the pure helpers verbatim, then add `createSampledDriver` and `extractJsonAnswer`. Export it from the barrel. Run `bun test packages/ai-runner/tests/decision/sampled-driver.test.ts`.
4. Rebuild `createFmDriver` on the core (R7). Turn decision-fm `schema.ts` and `estimate.ts` into re-exports or aliases (R8), and keep `fm-process.ts` apart from `requireEnumValue`, which becomes a re-export bound to label `'fm'`.
5. Run `bun test packages/decision-fm` with the existing suites unmodified, and run the parity test. The JSON must not change (`git diff --exit-code packages/decision-fm/tests/output/fm-parity.json`).
6. READMEs:
   - `packages/ai-runner/README.md`: add a "Sampled-driver core" subsection with the `createSampledDriver` example.
   - `packages/decision-fm/README.md`: note that it is built on the core and that exports are unchanged.
7. Gate: `bun run spur-check && bun run build`, then `git status` shows only these files.

**Files touched:**
- `packages/ai-runner/src/decision/sampled-driver.ts` (new)
- `packages/ai-runner/src/index.ts`
- `packages/ai-runner/tests/decision/sampled-driver.test.ts` (new)
- `packages/decision-fm/src/{driver,schema,estimate,fm-process,index}.ts`
- `packages/decision-fm/tests/parity.test.ts` (new) and `packages/decision-fm/tests/output/fm-parity.json` (new)
- the two READMEs

**Out of scope:** the agent driver (0115), TypeSafe (0116) and clef.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-10-19T17:03:08.435Z feature_id O → P1 (system)
- 2026-10-19T17:03:11.500Z feature_id P1 → O1 (system)

