---
schema_version: 1
name: Neutral decision types, q builders, driver contract, and error taxonomy
status: todo
template: feature-impl
created_at: 2026-09-20T05:08:59.651Z
updated_at: "2026-09-20T05:16:52.655Z"
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

- [ ] R1. Create `packages/ai-runner/src/decision/types.ts` exporting `Json`,
      `DecisionState`, `Desc`, `ChoiceQuestion<L>`, `ScoreQuestion`, `NoulQuestion`,
      `Question`, `ChoiceAnswer<L>`, `ScoreAnswer`, `NoulAnswer`, `Answer`, `AnswerFor<Q>`,
      `AnswersFor<Q>`.
- [ ] R2. `NoulAnswer` has exactly the members `kind` and `probability` — no `confidence`.
      `ChoiceAnswer` carries `kind`, `label`, `confidence`, `probabilities`. `ScoreAnswer`
      carries `kind`, `score`, `confidence`, `legend`, `probabilities`.
- [ ] R3. `ChoiceAnswer<L>['label']` is typed as `L`, and `probabilities` is keyed by `L` — so a
      caller passing a literal label map gets a union-typed label back, not `string`.
- [ ] R4. `ScoreQuestion['rubric']` is typed `readonly [Desc, Desc, ...Desc[]]` — at least two levels,
      enforced at compile time.
- [ ] R5. Export a `q` namespace object with `q.choice`, `q.score`, `q.noul` builders returning the
      corresponding question objects with the correct `kind` discriminant. `q.choice` infers the label
      union from its `labels` argument.
- [ ] R6. Export `DecisionDriver` with a readonly `name` and a single `ask` method taking
      `{ state, questions, model? }` and returning `Promise<Record<string, Answer>>`.
- [ ] R7. Create `packages/ai-runner/src/decision/errors.ts` exporting a `DecisionError` base plus
      `DecisionConfigError`, `DecisionAuthError`, `DecisionRateLimitError`,
      `DecisionTimeoutError`, `DecisionConnectionError`, `DecisionRequestError`,
      `DecisionBackendError`, each carrying the fields named in the design document.
- [ ] R8. No import of `@typesafe-ai/sdk` in either file — the boundary rule must stay green.

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
