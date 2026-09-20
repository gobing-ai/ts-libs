---
schema_version: 1
name: Neutral decision types, q builders, driver contract, and error taxonomy
status: done
template: feature-impl
created_at: 2026-09-20T05:08:59.651Z
updated_at: "2026-09-20T06:57:49.934Z"
feature_id: A2
priority: P2
tags:
  - ai-runner
  - decision-maker
  - types

---

## 0070. Neutral decision types, q builders, driver contract, and error taxonomy

### Background

The foundation layer of the `DecisionMaker` surface: the vocabulary everything
else is written against. Two deliberate choices drive it.

**Types are provider-neutral, not re-exported from the SDK.** Re-exporting `ChoiceResponse` and
friends would bind every caller to the vendor and deliver none of the provider independence the
feature exists for. Neutral names (`kind`, `labels`, `rubric`, `probability`) keep the
vendor mapping explicit and confined to one reviewable file.

**The answer types are asymmetric on purpose.** The backing API returns `confidence` for choice
and score questions but only a bare probability for a yes/no question. A uniform answer type would
have to invent a confidence value for the yes/no case — fabricating calibration data. This layer
encodes that asymmetry in the type system so no later code can paper over it.

This task also defines `DecisionDriver`, the one-method internal seam that keeps future backend
drivers cheap, and the `DecisionError` taxonomy that both the facade and the driver throw.

### Requirements

- [x] R1. Create `packages/ai-runner/src/decision/types.ts` exporting `Json`,
      `DecisionState`, `Desc`, `ChoiceQuestion<L>`, `ScoreQuestion`, `NoulQuestion`,
      `Question`, `ChoiceAnswer<L>`, `ScoreAnswer`, `NoulAnswer`, `Answer`, `AnswerFor<Q>`,
      `AnswersFor<Q>`.
- [x] R2. `NoulAnswer` has exactly the members `kind` and `probability` — no `confidence`.
      `ChoiceAnswer` carries `kind`, `label`, `confidence`, `probabilities`. `ScoreAnswer`
      carries `kind`, `score`, `confidence`, `legend`, `probabilities`.
- [x] R3. `ChoiceAnswer<L>['label']` is typed as `L`, and `probabilities` is keyed by `L` — so a
      caller passing a literal label map gets a union-typed label back, not `string`.
- [x] R4. `ScoreQuestion['rubric']` is typed `readonly [Desc, Desc, ...Desc[]]` — at least two levels,
      enforced at compile time.
- [x] R5. Export a `q` namespace object with `q.choice`, `q.score`, `q.noul` builders returning the
      corresponding question objects with the correct `kind` discriminant. `q.choice` infers the label
      union from its `labels` argument.
- [x] R6. Export `DecisionDriver` with a readonly `name` and a single `ask` method taking
      `{ state, questions, model? }` and returning `Promise<Record<string, Answer>>`.
- [x] R7. Create `packages/ai-runner/src/decision/errors.ts` exporting a `DecisionError` base plus
      `DecisionConfigError`, `DecisionAuthError`, `DecisionRateLimitError`,
      `DecisionTimeoutError`, `DecisionConnectionError`, `DecisionRequestError`,
      `DecisionBackendError`, each carrying the fields named in the design document.
- [x] R8. No import of `@typesafe-ai/sdk` in either file — the boundary rule must stay green.

### Acceptance Criteria

```gherkin
  @core
  Scenario: R4 — each primitive's answer carries only the fields the API returns
    Given decoded systemOne responses for a choice, a score, and a noul question
    When the driver maps each response to its answer type
    Then the choice answer carries the selected label, a confidence, and a probability per label
    And the score answer carries the expected score, a confidence, a rubric legend, and a probability per level
    And the noul answer carries only the yes-probability, with no confidence field present or synthesized
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-20T05:16:52.654Z

**Neutral types, not SDK re-exports.** Re-exporting `ChoiceResponse` and its siblings would be
less code but would bind every caller to the vendor and deliver none of the provider independence
the feature exists for. The neutral vocabulary keeps the mapping explicit and confined to one
reviewable file.

**`kind` as the discriminant, not the SDK's `type`.** A distinct name makes an accidental
structural pass-through of a raw SDK object fail to typecheck rather than silently work.

**`NoulAnswer` carries no `confidence`.** The wire response returns only a probability. A
uniform answer type would have to synthesize a confidence, fabricating calibration data. The
asymmetry is encoded in the type system so later code cannot paper over it.

**`q` namespace for the builders.** `choice` / `score` / `noul` are already the
`DecisionMaker` method names; namespacing the standalone builders under `q` resolves the
collision without renaming either surface.

**Driver contract returns the loose `Record<string, Answer>`.** Considered making the driver
reproduce the facade's conditional types, rejected: it would make every future driver carry
type machinery it does not need. The facade narrows once, at its own boundary.

**Premises.** `const` type parameters are required for label-union inference from an inline
object literal — without them the union widens to `string` and the main ergonomic benefit is
lost; and a two-element tuple prefix is the correct compile-time encoding of the rubric minimum.

### Design

**WHAT** — two pure files: `types.ts` (types + three builders + driver contract) and
`errors.ts` (error taxonomy). No I/O, no SDK.

**WHY `kind` and not the SDK's `type`** — a distinct discriminant name makes an accidental
structural pass-through of a raw SDK object fail to typecheck instead of silently working. The
mapping must be deliberate.

**WHY the `q` namespace** — the batch path needs standalone question builders, but `choice`,
`score`, and `noul` are already taken by the `DecisionMaker` methods. Namespacing under `q`
resolves the collision and reads well at the call site:
`q.choice('What is this about?', { billing: null, technical: null })`.

**WHY `const` type parameters on `q.choice`** — without `<const L extends string>`, an inline
object literal widens to `string` and the caller loses the union-typed label that is the main
ergonomic win. This is the one subtle typing detail in the file.

**WHY `DecisionDriver.ask` returns the loose `Record<string, Answer>`** — a driver should not
have to reproduce the facade's conditional-type machinery. The facade narrows to `AnswersFor<Q>`
with a single documented cast at its boundary. One cast in one place, in exchange for drivers that
are trivial to write.

**WHY errors live here and not with the driver** — the facade throws `DecisionConfigError` for a
missing key before any driver is consulted, so the taxonomy cannot depend on driver code. Keeping
all error classes in one file also keeps the "no raw SDK error escapes" invariant checkable by
reading a single file.

### Plan

1. Create `packages/ai-runner/src/decision/`.
2. Write `types.ts`: Json/state/description aliases, the three question interfaces, the three
   answer interfaces, the `AnswerFor`/`AnswersFor` conditional types, the `q` builders, and
   `DecisionDriver`.
3. Write `errors.ts`: `DecisionError` base and the seven subclasses with their payload fields.
4. Add type-level tests asserting label-union inference, the two-level rubric minimum, and the
   absence of `confidence` on `NoulAnswer`.
5. Add runtime tests for the three `q` builders' output shape and discriminants.
6. Run typecheck, tests, and `bun run spur-check`.

### Solution

Change-map for commit 78b6b92 (implement hop; spur-check 2286 pass / 0 fail):

| Change (`file:line`) | What |
|----------------------|------|
| `packages/ai-runner/src/decision/types.ts:10` | Neutral vocabulary: Json/DecisionState/Desc aliases, three question types (ScoreQuestion rubric `readonly [Desc, Desc, ...Desc[]]` at :22), asymmetric answers (NoulAnswer exactly kind+probability at :53), AnswerFor/AnswersFor conditionals (:59,:69) (R1,R2,R4) |
| `packages/ai-runner/src/decision/types.ts:80` | `<const L extends string>` on q.choice preserves inline label unions (R3); q namespace :75-101 (R5) |
| `packages/ai-runner/src/decision/types.ts:104` | DecisionDriver one-method seam: readonly name + ask() -> Promise<Record<string, Answer>> (R6) |
| `packages/ai-runner/src/decision/errors.ts:8` | DecisionError base (new.target name) + 7 subclasses with design-doc payload fields (:16,:27,:38,:50,:61,:68,:80) (R7) |
| `packages/ai-runner/src/index.ts:6` | Barrel decision exports, collision-free (verified by name sweep) |
| `packages/ai-runner/tests/decision/types.test.ts:22` | 12 tests: type-level Expect<Equal> label-union/rubric-min/no-confidence probes (tsc-proven) + runtime builder/driver contract (R2,R3,R4,R5,R6) |

R8 by omission: zero SDK imports in src/decision/ (rule scopes future typesafe-driver.ts). Slice note: @core R4 Then-clauses proven here; wire-mapping When-clause is 0072 per batch split.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | static-ref packages/ai-runner/src/decision/types.ts:10-69 — all 13 named exports (Json:10, DecisionState:13, Desc:16, ChoiceQuestion:19, ScoreQuestion:22, NoulQuestion:25, Question:28, ChoiceAnswer:31, ScoreAnswer:39, NoulAnswer:53, Answer:56, AnswerFor:59, AnswersFor:69) + command cd packages/ai-runner && bunx tsc --noEmit → exit 0 |
| R2 | MET | static-ref types.ts:31-46 ChoiceAnswer{kind,label,confidence,probabilities} / ScoreAnswer{kind,score,confidence,legend,probabilities}; types.ts:53 NoulAnswer exactly {kind,probability} + test types.test.ts:63-64 `_noConfidenceOnNoul`/`_noulMembersExact` and 71-76 runtime Object.keys === [kind,probability] + command bun test tests/decision/ → 12 pass, 0 fail |
| R3 | MET | static-ref types.ts:33,36 label: L, probabilities: Record<L, number>; `<const L extends string>` at types.ts:80 keeps inline unions + test types.test.ts:22-39 `_labelsStayUnion`/`_labelIsUnion`/`_probabilitiesKeyed` prove 'billing' |
| R4 | MET | static-ref types.ts:22 rubric: readonly [Desc, Desc, ...Desc[]] + test types.test.ts:64 @ts-expect-error one-level rubric, 66-67 missing-rubric negative + command bunx tsc --noEmit → exit 0 (unused directive would fail tsc, so the negative case fires) |
| R5 | MET | static-ref types.ts:75-101 q.choice/q.score/q.noul with correct kind discriminants; const type param on q.choice:80 + test types.test.ts:78-97 builders return right shapes and discriminants incl. q.noul spread semantics + command bun test → pass |
| R6 | MET | static-ref types.ts:104-111 readonly name + single ask({state, questions, model?}): Promise<Record<string, Answer>> + test types.test.ts:107-118 one-method fake driver satisfies DecisionDriver, keyed answers round-trip + command bun test → pass |
| R7 | MET | static-ref errors.ts:8-88 base + 7 subclasses; fields match design table docs/design/decision-maker.md:192-200 field-for-field (Config:variable:16, Auth:status:27, RateLimit:status+retryAfterMs:38, Timeout:timeoutMs:50, Connection:cause:61, Request:status+bodySummary:68, Backend:status:80); new.target.name at errors.ts:11-12 + test errors.test.ts:24-31 instanceof/name for all 7, per-field payload tests 33-66 + command bun test → 0 fail |
| R8 | MET | command grep -rn '@typesafe-ai/sdk' src/decision/ → comment mention only, zero imports (types.ts header: imports nothing) + command bun run spur-check → All 2 rules passed (incl. decision-boundaries), 0 violations |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R4 — each primitive's answer carries only the fields the API returns | MET | test | slice-scoped: Then-clauses fully proven — choice answer carries label+confidence+per-label probabilities (test `_confidencePresent` types.test.ts:31-33), score carries score+confidence+legend+probabilities (static-ref types.ts:39-46), noul carries only probability with no confidence present or synthesizable (test `_noConfidenceOnNoul` + Object.keys + command bunx tsc exit 0); the When-clause driver wire-mapping of decoded systemOne responses is task 0072's deliverable per spec Plan — nothing owed by 0070 |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0070 (pipeline Phase 7, auto profile)

**Scope:** commit 78b6b92 vs c7ced52 — `packages/ai-runner/src/decision/{types,errors}.ts`, `src/index.ts` (+2 barrel lines), `tests/decision/{types,errors}.test.ts`
**Dimensions:** functional traceability, SECUA (security/efficiency/correctness/usability), architecture depth
**Verdict:** PASS

##### Findings (ranked)

| # | Priority | Dimension | Finding | Location |
|---|----------|-----------|---------|----------|
| 1 | P3 (minor) | usability (record hygiene) | Task record `### Solution` and `### Testing` sections are still placeholders — implementation is verified (12/12 tests, tsc exit 0) but no raw gate evidence is recorded in the task doc. Backfill before the done-flip (done-time housekeeping F4). | `docs/tasks/0070_neutral-decision-types-q-builders-driver-contract-and-error-.md` (Solution/Testing sections) |
| 2 | P4 (advisory) | correctness (doc drift) | Design doc's illustrative snippet shows one-arg `new DecisionConfigError('TYPESAFE_API_KEY')`; implemented signature is two-arg `(message, variable)`. The normative taxonomy table ("carries: variable name") is satisfied; the 0072 facade implementer must use the two-arg form — a one-arg call fails to compile, which is the safe direction. | `docs/design/decision-maker.md:180` vs `packages/ai-runner/src/decision/errors.ts:16-24` |
| 3 | P4 (advisory) | correctness | `q.noul()` with prompt omitted leaves an own `prompt: undefined` key on the returned object. Harmless for JSON serialization (dropped) and structural typing (`toEqual` ignores undefined); matters only if exact-key wire audits arrive — conditional spread then. | `packages/ai-runner/src/decision/types.ts:97-101` |
| 4 | P4 (advisory) | architecture | `types.ts` co-locates type vocabulary, the runtime `q` builders, and the `DecisionDriver` interface. Per design (two pure files, boundary readable in one file) — correct now; split builders out only if the file grows with the 0072 mapping. | `packages/ai-runner/src/decision/types.ts:1-117` |

##### Functional Traceability

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `packages/ai-runner/src/decision/types.ts:10-69` — all 13 named exports present (Json, DecisionState, Desc, ChoiceQuestion, ScoreQuestion, NoulQuestion, Question, ChoiceAnswer, ScoreAnswer, NoulAnswer, Answer, AnswerFor, AnswersFor) |
| R2 | MET | types.ts:31-53 exact members; type tests `_noulMembersExact` (`keyof NoulAnswer = 'kind'\|'probability'`), `_noConfidenceOnNoul` + runtime `Object.keys` assertion (`tests/decision/types.test.ts:71-76`) |
| R3 | MET | types.ts:19,31-37 — `label: L`, `probabilities: Record<L, number>`; type tests `_labelsStayUnion`/`_labelIsUnion`/`_probabilitiesKeyed` prove `<const L>` keeps `'billing'\|'technical'\|'other'` (`tests/decision/types.test.ts:22-39`) |
| R4 | MET | types.ts:22 `readonly [Desc, Desc, ...Desc[]]`; negative case `@ts-expect-error` one-level rubric (`types.test.ts:64`) — tsc exit 0 proves the directive fired (unused directive would fail tsc) |
| R5 | MET | types.ts:75-101 — `q.choice`/`q.score`/`q.noul` return correct `kind` discriminants (runtime test `types.test.ts:78-97`); `<const L extends string>` on q.choice (types.ts:80) |
| R6 | MET | types.ts:104-117 — `readonly name`, single `ask({state, questions, model?})` → `Promise<Record<string, Answer>>`; fake-driver test compiles and passes (`types.test.ts:107-118`) |
| R7 | MET | `errors.ts:8-88` — base + 7 subclasses; payload fields match design table field-for-field (`docs/design/decision-maker.md:192-200`): variable / status / status+retryAfterMs / timeoutMs / cause / status+bodySummary / status; `new.target.name` naming tested for all 7 (`errors.test.ts:24-31`) |
| R8 | MET | zero imports in either decision src file (grep: only a doc-comment mention); boundary rule `.spur/rules/typescript/decision-boundaries.yaml` already scopes the future `typesafe-driver.ts` exclusion |
| R4 @core AC | MET (slice-scoped) | Answer field-set asymmetry evidenced at type level (tsc exit 0 = all `Expect<Equal<…>>` hold) and runtime (no-confidence-on-noul test). The scenario's "driver maps decoded systemOne responses" step is task 0072's deliverable — re-run the end-to-end proof there; nothing owed by 0070. |

##### Per-dimension verdicts

- **Functional traceability — PASS.** R1–R8 all MET with file:line evidence; fresh verification: `bun test tests/decision/` → 12 pass / 0 fail (47 expect calls); `tsc --noEmit` exit 0.
- **SECUA quality — PASS.** Zero `any` in both src files (only `cause?: unknown`); conditional types are distributive and unconstrained-`Q` per design verbatim; `@ts-expect-error` negative tests genuinely fire (tsc exit 0 would flag an unused directive); error `cause` identity preserved via ES2022 `super(message, options)` (tested). No I/O, no secrets, no injection surface in this slice.
- **Architecture depth — PASS.** Neutral types are import-free — no SDK re-export, rationale documented in the file header, matching the boundary rule's single-reviewable-file invariant. NoulAnswer asymmetry is load-bearing and type-enforced. Driver seam is minimal: one method, loose `Record<string, Answer>`, narrowing-cast plan documented at the seam; a fake driver satisfies it with zero type machinery. Barrel: two alphabetical `export *` lines (`src/index.ts:6-7`); collision sweep across all ai-runner src found zero name conflicts.

##### Residual risk

- The conditional types are only as correct as 0072's wire decoder is honest about them — `AnswerFor` guarantees the shape, not that the SDK payload fills it; 0072's decode tests close that gap.
- Design-doc snippet drift (finding 2) could mislead the 0072 facade implementer toward the stale one-arg call site — it fails to compile, so the risk is a confused minute, not a defect.
- `Desc` and `DecisionState` are structurally identical aliases; deliberate for readability per design, but a linter-level "don't interchange" guard does not exist (not needed at this size).

##### Disposition

PASS — no P1/P2 findings; P3 is implementer-side record hygiene to clear at done-time; P4s are advisory. Proceed to the approve(HITL) gate; 0072 owns the wire-mapping proof of the R4 @core scenario.

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-20T06:29:52.256Z todo → wip (system)
- 2026-09-20T06:57:38.088Z wip → testing (system)
- 2026-09-20T06:57:49.934Z testing → done (system)

