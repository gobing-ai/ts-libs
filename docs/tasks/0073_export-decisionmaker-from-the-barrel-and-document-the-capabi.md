---
schema_version: 1
name: Export DecisionMaker from the barrel and document the capability
status: todo
template: feature-impl
created_at: 2026-09-20T05:08:59.654Z
updated_at: "2026-09-20T05:16:53.587Z"
feature_id: A2
priority: P2
tags:
  - ai-runner
  - decision-maker
  - docs
  - surface

dependencies: ["0071", "0072"]
---

## 0073. Export DecisionMaker from the barrel and document the capability

### Background

Closes the feature's public surface. Until the barrel re-exports it, the
`DecisionMaker` work is unreachable from outside the package; until the README documents it,
nobody knows the capability exists or how the batch path differs from the convenience methods.

This is deliberately last so the barrel exports a finished surface in one edit rather than growing
across the earlier tasks, and so the README example can be written against the real, working API.

The README example is load-bearing rather than decorative: it is the first place a reader learns
that many questions against one shared state cost one request, which is the whole reason the
interface is shaped the way it is.

### Requirements

- [ ] R1. `packages/ai-runner/src/index.ts` re-exports `createDecisionMaker`, the
      `DecisionMaker` and `DecisionMakerOptions` types, the `q` builders, `DecisionDriver`, every
      neutral question and answer type, and the `DecisionError` taxonomy.
- [ ] R2. The SDK itself and every SDK type stay unexported — nothing vendor-shaped crosses the barrel.
- [ ] R3. `packages/ai-runner/README.md` gains a capability section covering: what the surface is for,
      the batch `ask` example with three mixed questions against one state, the single-question sugar
      form, `TYPESAFE_API_KEY` configuration and the injected-`env` alternative, the error taxonomy,
      and a note that the yes/no answer carries no confidence because the API reports none.
- [ ] R4. The README states that additional backend drivers are the intended extension point and that a
      driver implements only `ask`.
- [ ] R5. Every code sample in the README typechecks against the shipped types.
- [ ] R6. `docs/04_DESIGN.md` moves the `DecisionMaker` row from `planned` to `current` with the
      frontmatter version and `updated_at` bumped per `docs/99_PROJECT_CONSTITUTION.md` §6.5.
- [ ] R7. `bun run spur-check` and `bun run build` both pass, and `spur feature check A2` reports no
      orphan scenarios.

### Acceptance Criteria

```gherkin
  @core
  Scenario: R11 — the capability is exported from the barrel and documented
    Given the completed DecisionMaker implementation
    When the package barrel and README are inspected
    Then createDecisionMaker, the question builders, the neutral types, and the error taxonomy are all reachable from the package entry point
    And no @typesafe-ai/sdk type, class, or error is exported through it
    And the README documents the batch form, the single-question form, key configuration, and that the yes/no answer carries no confidence
    And it identifies an additional backend driver as the intended extension point
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-20T05:16:53.586Z

**Barrel export last, in one edit.** Considered exporting incrementally from each earlier task,
rejected: several edits to the same file plus a window where a partial public surface is reachable.
One edit against a finished surface is smaller and safer.

**Nothing vendor-shaped crosses the barrel.** If an SDK type were re-exported, callers could bind
to it and the provider independence established over the four preceding tasks would be lost at the
final step. Checked against the generated declarations, not only the source.

**README leads with the batch form.** A reader who meets `choice(state, prompt, labels)` first
will reach for it three times in a row and pay three round trips. Showing `ask` first, with the
shared state visible, teaches the cost model alongside the API.

**Feature scenario R11 added during planning.** The scope committed to the barrel export and the
README capability section, but the authored acceptance criteria covered neither — R1 through R10
stopped at the implementation surface. R11 closes that gap rather than leaving this task's work
unverifiable against the feature.

**Design index row flips to `current` in this task.** The surface is only real once exported, so
flipping it here keeps `docs/04_DESIGN.md` honest at every commit instead of optimistic from the
first one.

**Premises.** Every code sample in the README must typecheck against the shipped declarations, so
the samples are extracted and compiled rather than trusted; and `docs/99_PROJECT_CONSTITUTION.md`
§6.5 governs the frontmatter version and date bump on `docs/04_DESIGN.md`.

### Design

**WHAT** — one barrel edit, one README section, one index-row status change.

**WHY the barrel is last** — exporting incrementally from the earlier tasks would mean several
edits to the same file and a window where a partial surface is publicly reachable. One edit against
a finished surface is both smaller and safer.

**WHY nothing vendor-shaped crosses the barrel** — if an SDK type were re-exported, callers could
bind to it and the provider independence the feature exists for would be lost at the last step,
after four tasks spent establishing it. R2 guards the seam at its outermost edge.

**WHY the README leads with the batch example** — a reader who meets `choice(state, prompt, labels)`
first will reach for it three times in a row and pay three round trips. Showing `ask` first, with
the shared state visible, teaches the cost model in the same breath as the API.

**WHY the index row flips to current here** — the surface is only real once it is exported. Flipping
it in this task keeps `docs/04_DESIGN.md` honest at every commit rather than optimistic from the
first one.

### Plan

1. Add the re-exports to `packages/ai-runner/src/index.ts`.
2. Verify no SDK type or error class is reachable through the barrel.
3. Write the README capability section, leading with the batch example.
4. Extract the README samples into a typecheck fixture, or otherwise verify they compile.
5. Flip the `docs/04_DESIGN.md` row to `current` and bump the frontmatter version and date.
6. Run `bun run spur-check`, `bun run build`, and `spur feature check A2`.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
