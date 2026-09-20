---
schema_version: 1
name: Pin @typesafe-ai/sdk and add the decision-boundaries rule
status: done
template: feature-impl
created_at: 2026-09-20T05:08:59.647Z
updated_at: "2026-09-20T06:29:20.091Z"
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

- [x] R1. Add `"@typesafe-ai/sdk": "0.6.0"` to `dependencies` in
      `packages/ai-runner/package.json` — exact version, no `^` or `~` prefix.
- [x] R2. Install so the workspace lockfile records the resolution, and confirm the package resolves
      from `packages/ai-runner`.
- [x] R3. Add `.spur/rules/typescript/decision-boundaries.yaml` with rule id
      `no-typesafe-sdk-import-outside-ai-runner`, evaluator `forbidden-import`, severity `error`,
      forbidding specifier `@typesafe-ai/sdk` across `packages/**/src/**/*.ts` and excluding only
      `packages/ai-runner/src/decision/typesafe-driver.ts` (plus the standard `**/tests/**`,
      `**/*.test.ts`, `**/dist/**`).
- [x] R4. No `tsconfig` `paths` entry is added — ADR-004 / ADR-012 govern workspace siblings, and this
      is an external package.
- [x] R5. `spur rule validate` accepts the new file and `bun run spur-check` stays clean.

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

Change-map for commit c7ced52 (implement hop; spur-check 2274 pass / 0 fail):

| Change (`file:line`) | What |
|----------------------|------|
| `packages/ai-runner/package.json:52` | Adds `"@typesafe-ai/sdk": "0.6.0"` to `dependencies` — exact pin, no range prefix (R1) |
| `bun.lock:20` | ai-runner dependency list records the new package |
| `bun.lock:307` | Lockfile resolution `@typesafe-ai/sdk@0.6.0` with integrity hash (R2) |
| `.spur/rules/typescript/decision-boundaries.yaml:8` | Rule `no-typesafe-sdk-import-outside-ai-runner`: `forbidden-import`, severity `error`, specifier `@typesafe-ai/sdk` (R3) |
| `.spur/rules/typescript/decision-boundaries.yaml:19` | Scope: include `packages/**/src/**/*.ts`; exclude only `packages/ai-runner/src/decision/typesafe-driver.ts` + standard `**/tests/**`, `**/*.test.ts`, `**/dist/**` (R3) |

R4 (no tsconfig paths) holds by omission — zero `typesafe` matches across all tsconfigs. Rationale: boundary rides the ADR-005/006 drizzle precedent via a spur rule; single-file exclusion keeps vendor types out of ai-runner internals.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/ai-runner/package.json:52` — `"@typesafe-ai/sdk": "0.6.0"`, exact, no `^`/`~` prefix (git show c7ced52 diff confirms added in `dependencies`) |
| R2 | MET | `bun.lock:20` (ai-runner deps) + `bun.lock:307` (pinned resolution `@typesafe-ai/sdk@0.6.0` w/ integrity hash); `bun -e require.resolve('@typesafe-ai/sdk')` from `packages/ai-runner` → `node_modules/.bun/@typesafe-ai+sdk@0.6.0/.../dist/index.cjs`, exit 0 |
| R3 | MET | `spur rule validate .spur/rules/typescript/decision-boundaries.yaml` → exit 0, "rules: 1"; manifest parsed: id `no-typesafe-sdk-import-outside-ai-runner`, evaluator `forbidden-import`, severity `error`, forbidden specifier `@typesafe-ai/sdk`, scope.include `packages/**/src/**/*.ts`, scope.exclude only `packages/ai-runner/src/decision/typesafe-driver.ts` + `**/tests/**` + `**/*.test.ts` + `**/dist/**` (rule file lines 8-27) |
| R4 | MET | `grep -rn typesafe tsconfig*.json packages/*/tsconfig*.json` → exit 1, zero matches; no paths entry added (commit c7ced52 touches only rule file, bun.lock, ai-runner package.json) |
| R5 | MET | `spur rule validate` → exit 0; `bun run spur-check` → exit 0, `2274 pass / 0 fail` across 195 files; baseline `spur rule run` → exit 0, "All 50 rules passed — no violations found" |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R10 — the SDK dependency is pinned exactly and confined to this package | MET | test | Manifest side: `packages/ai-runner/package.json:52` declares exact 0.6.0 (no range prefix); `spur rule run` clean baseline exit 0. Boundary side (negative test): planted `import { makeDecision } from "@typesafe-ai/sdk"` in `packages/ts-runtime/src/__verify_0069_boundary_probe__.ts` → `spur rule run` exit 1 with `ERROR no-typesafe-sdk-import-outside-ai-runner packages/ts-runtime/src/__verify_0069_boundary_probe__.ts:1 Forbidden import/usage of "@typesafe-ai/sdk"`; probe file deleted, tree restored (git status shows only the pre-existing task-doc modification) |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0069

**Scope:** commit c7ced52 vs main tree 7dbeb17 (packages/ai-runner/package.json, bun.lock, .spur/rules/typescript/decision-boundaries.yaml) + task-doc status flip
**Dimensions:** functional, security, efficiency, correctness, usability, architecture
**Verdict:** PASS

##### Findings (ranked)

| # | Priority | Dimension | Finding | Location |
|---|----------|-----------|---------|----------|
| 1 | P4 (advisory) | correctness | Two unrelated no-op re-encodings ride in the commit: literal em-dash → `\u2014` escape in `description` and `release` script strings. Semantically identical JSON (formatter rewrite); pure diff noise. | `packages/ai-runner/package.json:4,48` |
| 2 | P4 (advisory) | architecture | The single-file exclusion targets `packages/ai-runner/src/decision/typesafe-driver.ts`, which does not exist yet (created by task 0070). If that path drifts, the rule fails *loudly* on the driver file itself (fail-safe, not fail-open) — residual risk is a one-line exclusion fix at 0070, not a silent bypass. | `.spur/rules/typescript/decision-boundaries.yaml:24` |
| 3 | P4 (advisory) | correctness | Rule passes trivially until `src/decision/` exists — explicitly sanctioned by the spec's "Note on ordering"; the gate is never red for work not started. | `.spur/rules/typescript/decision-boundaries.yaml:1` |

##### Functional Traceability

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `packages/ai-runner/package.json:48` — `"@typesafe-ai/sdk": "0.6.0"`, exact, no `^`/`~` |
| R2 | MET | `bun.lock:19,307` — workspace dep + `"@typesafe-ai/sdk@0.6.0"` resolution; `require.resolve` from `packages/ai-runner` → `node_modules/.bun/@typesafe-ai+sdk@0.6.0/dist/index.cjs` |
| R3 | MET | `.spur/rules/typescript/decision-boundaries.yaml:8-26` — id `no-typesafe-sdk-import-outside-ai-runner`, `forbidden-import`, severity `error`, specifier `@typesafe-ai/sdk`, include `packages/**/src/**/*.ts`, exclude only `typesafe-driver.ts` + `**/tests/**`, `**/*.test.ts`, `**/dist/**` |
| R4 | MET | grep for `typesafe` across all `tsconfig*.json`: zero hits; no paths entry in diff |
| R5 | MET | `spur rule validate` EXIT 0 (rule in validated 50); `bun run spur-check` EXIT 0 (lint + pre-check + 2274 tests pass + post-check); pre-check: "All 50 rules passed" |
| AC R10 | MET | Pin exact evidenced (R1); negative test: planted `import … from '@typesafe-ai/sdk'` in `packages/db/src/zz-negative-test.ts` → rule fired `ERROR no-typesafe-sdk-import-outside-ai-runner …:1 Forbidden import/usage`, exit 1, temp file removed — the gate fails when any package other than ai-runner imports the SDK |

##### SECUA Quality

No P1–P3 defects. Dependency confined to one manifest; lockfile carries exactly one resolution (2 references = declaration + resolved record); zero source imports exist yet; no secret/network surface in the diff (rule file and manifest only). Gate evidence above is fresh and reproduced in this session.

##### Architecture Depth

Boundary is isomorphic to the ADR-005/ADR-006 precedent (`no-drizzle-import-outside-db-package` in `db-boundaries.yaml`): same `forbidden-import` evaluator, same `packages/**/src/**/*.ts` scope, same standard excludes — one dialect, not a second one. The single-file exclusion is deliberately *stricter* than the drizzle package-wide exclusion per the recorded Q&A (prevents vendor types spreading across ai-runner's own internals) and fails safe if the driver path drifts. AGENTS.md boundaries respected: `workspace:*` rule n/a (external dep), tsconfig paths correctly absent (ADR-004/012 govern workspace siblings, not npm packages), rule auto-discovered via `.spur/rules/**/*.yaml` config paths — no preset edit needed. No new ADR per the operator decision recorded in the task Q&A, with the documented deferred condition (second outbound-LLM dep ⇒ write the class-level ADR).

**Next:** none — proceed to task 0070; keep the exclusion path in sync when `typesafe-driver.ts` lands.

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-20T06:06:30.404Z todo → wip (system)
- 2026-09-20T06:29:08.046Z wip → testing (system)
- 2026-09-20T06:29:20.091Z testing → done (system)

