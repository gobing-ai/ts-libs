---
schema_version: 1
name: Pin @typesafe-ai/sdk and add the decision-boundaries rule
status: todo
template: feature-impl
created_at: 2026-09-20T05:08:59.647Z
updated_at: "2026-09-20T05:16:52.345Z"
feature_id: A2
priority: P2
tags:
  - ai-runner
  - decision-maker
  - dependency
  - spur-rule

---

## 0069. Pin @typesafe-ai/sdk and add the decision-boundaries rule

### Background

Feature A2 introduces the workspace's first outbound-LLM-API runtime dependency:
`@typesafe-ai/sdk`, which backs the TypeSafe driver of the new `DecisionMaker` surface. The SDK
is pre-1.0 — first published 2026-09-12, with three versions in three days — so it is pinned to an
exact version rather than a caret range: every bump becomes a deliberate, reviewable step instead
of an implicit one.

This task lands first because nothing else in the feature compiles without the dependency present,
and because the boundary rule should guard the seam from the moment the SDK enters the tree rather
than being retrofitted after callers exist.

The boundary follows the ADR-005 / ADR-006 precedent that already confines `drizzle-orm` inside
`ts-db`: a cross-cutting boundary is carried by a spur rule, not by review habit. The operator
decided at the design gate that this precedent is sufficient and no new ADR entry is needed.

### Requirements

- [ ] R1. Add `"@typesafe-ai/sdk": "0.6.0"` to `dependencies` in
      `packages/ai-runner/package.json` — exact version, no `^` or `~` prefix.
- [ ] R2. Install so the workspace lockfile records the resolution, and confirm the package resolves
      from `packages/ai-runner`.
- [ ] R3. Add `.spur/rules/typescript/decision-boundaries.yaml` with rule id
      `no-typesafe-sdk-import-outside-ai-runner`, evaluator `forbidden-import`, severity `error`,
      forbidding specifier `@typesafe-ai/sdk` across `packages/**/src/**/*.ts` and excluding only
      `packages/ai-runner/src/decision/typesafe-driver.ts` (plus the standard `**/tests/**`,
      `**/*.test.ts`, `**/dist/**`).
- [ ] R4. No `tsconfig` `paths` entry is added — ADR-004 / ADR-012 govern workspace siblings, and this
      is an external package.
- [ ] R5. `spur rule validate` accepts the new file and `bun run spur-check` stays clean.

### Acceptance Criteria

```gherkin
  @core
  Scenario: R10 — the SDK dependency is pinned exactly and confined to this package
    Given the workspace manifests and the .spur rule catalog
    When the rule gate runs
    Then packages/ai-runner declares @typesafe-ai/sdk at exact 0.6.0 with no range prefix
    And a boundary rule fails the gate when any package other than ai-runner imports @typesafe-ai/sdk
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-20T05:16:52.345Z

**Exact pin, not `^0.6.0`.** Chosen by the operator during planning. The package was first
published 2026-09-12 and had three versions within three days. A caret would not admit `0.7.0`
under semver anyway, so it buys nothing here while permitting silent `0.6.x` drift on a package
whose patch cadence is measured in hours. Revisit once the SDK reaches 1.0 and a stable cadence.

**No new ADR for this dependency.** Operator decision during planning: the boundary rides the
existing ADR-005 / ADR-006 precedent — drizzle-orm confined to `ts-db` — carried by a spur rule
rather than a fresh dated entry. Deferred condition: if a second outbound-LLM-API dependency lands,
write the ADR then, covering the class rather than this one package.

**Rule scoped to the driver file, not the package.** Considered excluding all of
`packages/ai-runner`, rejected: a package-wide exclusion would let the vendor types spread across
ai-runner's own internals, which is the coupling the seam exists to prevent.

**Premises.** The workspace has no prior outbound-LLM-API runtime dependency, so this is the first
of its kind; `forbidden-import` supports the `scope.include` / `scope.exclude` shape already
used by `db-boundaries`; and the rule passing trivially until `src/decision/` exists is the
correct state, not a gap.

### Design

**WHAT** — one manifest edit plus one new rule file. No source code.

**WHY exact pin, not `^0.6.0`** — the package is four days old with three published versions. Under
semver, `^0.6.0` would not admit `0.7.0` anyway, so the caret buys nothing here while still
allowing silent `0.6.x` patch drift on a package whose patch cadence is currently measured in
hours. An exact pin makes the upgrade an explicit commit. Operator decision at the idea-eval gate.

**WHY the rule excludes one file, not the package** — scoping the exclusion to
`typesafe-driver.ts` means even a sibling `ai-runner` module must consume the `DecisionMaker`
facade rather than reaching for the SDK directly. A package-wide exclusion would let the vendor
type leak across `ai-runner`'s own internals, which is exactly the coupling the seam exists to
prevent.

**WHY `forbidden-import` and not `rg`** — the existing
`no-drizzle-import-outside-db-package` rule in `.spur/rules/typescript/db-boundaries.yaml` uses
`forbidden-import` for precisely this shape. Match it; do not invent a second dialect for the same
job.

**Note on ordering** — the rule file is written in this task but has nothing to guard until task 3
creates `src/decision/`. It passes trivially until then, which is correct: the gate should never
be red for work that has not started.

### Plan

1. Read `.spur/rules/typescript/db-boundaries.yaml` and copy the
   `no-drizzle-import-outside-db-package` rule block as the structural template.
2. Add the exact-pinned dependency to `packages/ai-runner/package.json`.
3. Install and verify the lockfile records `0.6.0`.
4. Write `.spur/rules/typescript/decision-boundaries.yaml` with the single rule.
5. Confirm no `tsconfig` path entry was added anywhere.
6. Plant a temporary `@typesafe-ai/sdk` import in another package, confirm the rule fires with
   severity error, then remove it.
7. Run `spur rule validate` and `bun run spur-check`.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
