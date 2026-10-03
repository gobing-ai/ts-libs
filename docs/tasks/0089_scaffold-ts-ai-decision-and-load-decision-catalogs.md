---
schema_version: 1
name: Scaffold ts-ai-decision and load decision catalogs
status: done
template: feature-impl
created_at: 2026-10-03T05:42:57.272Z
updated_at: "2026-10-03T22:03:27.794Z"
feature_id: N
priority: P2
tags:
  - ai-decision
  - new-package
  - catalog
estimate_hours: 5

done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-dev-runall-feature-n-5d1f7c/.spur/memory/evidence/0089-verdict.json
---

## 0089. Scaffold ts-ai-decision and load decision catalogs

### Background

Feature N introduces `@gobing-ai/ts-ai-decision`, a declarative catalog and hub over the `ts-ai-runner` `DecisionMaker` (ADR-033, `docs/design/ai-decision-catalog.md`). This task owns the package and the load side:
- the YAML-only, Jev-compatible catalog format
- its JSON Schema and zod schema
- `${params.*}` template validation and rendering
- the load-time consistency checks that make a catalog safe to serve

Implements: R1 — A catalog file with several decision points loads into typed decision definitions; R2 — The shipped JSON Schema validates a catalog that declares it; R3 — Declared parameter types and defaults shape the external input; R4 — An inconsistent catalog fails at load time with the decision and field named; R5 — The new ts-ai-decision package joins the workspace with one-way dependencies on ts-ai-runner and the bundled drivers.

### Requirements

- [x] R1. Create `packages/ai-decision` as `@gobing-ai/ts-ai-decision`:
  - lockstep version and `sideEffects: false`
  - exports `.`, `./schemas/*` and `./package.json`, the same pair just added to rule-engine. ts-runtime resolves `$schema` through `<pkg>/package.json`, which Node's resolver refuses unless exported; standard resolvers need `./schemas/*`
  - files `dist`/`src`/`schemas`/`examples`/`README.md`
  - register it in the root workspace, the root `tsconfig.json` references, the root README package list and graph, and `docs/design/package-exports.md`
- [x] R2. Depend via `workspace:*` on `@gobing-ai/ts-ai-runner`, `@gobing-ai/ts-decision-fm`, `@gobing-ai/ts-laya-mlx` and `@gobing-ai/ts-runtime`, with matching tsconfig `paths` (ADR-004/012), plus `zod`. Import no platform API directly.
- [x] R3. Add a spur rule in `.spur/rules/typescript/decision-boundaries.yaml` that forbids `packages/ai-runner/src`, `packages/decision-fm/src` and `packages/laya-mlx/src` from importing `@gobing-ai/ts-ai-decision`.
- [x] R4. Ship `schemas/decision-catalog.schema.json` and a zod schema for the normative shape in the design doc. Both are strict (no unknown keys). The shape:
  - `$schema`, `version: 1`, optional `defaults {maker, model, minConfidence}`, and `decisions` keyed by id (`^[a-z][a-z0-9_-]*$`)
  - each decision has `type` (choice|score|noul), optional `description` and templated `instructions`, `parameters` (shorthand `name: type` or `{type, default?, values?, description?}`), and `criteria`:
    - choice: a label map with at least 2 labels
    - score: a list with at least 2 entries
    - noul: optional `{true, false}`
  - each decision also has a required `fallback` and optional `minConfidence`/`maker` (a registry name matching `^[a-z][a-z0-9-]*$`; registration is checked by the hub, not the loader)/`model`
- [x] R5. Provide `loadDecisionCatalog(path, options)` and `parseDecisionCatalog(content, source, options)` on top of `parseStructuredConfig`:
  - reject any source not ending in `.yaml`/`.yml`
  - honour `$schema` when present
  - return typed decision definitions that include the implicit reserved `instructions` parameter (string, default `""`)
- [x] R6. Reject an inconsistent catalog with `DecisionCatalogError` naming the source, decision id and field. The checks are all-or-nothing:
  - a fallback outside the answer vocabulary (choice label, score level index, noul boolean)
  - a `${...}` reference to an undeclared param or to any namespace other than `params`
  - a declared `instructions` param
  - a default that does not match its type or enum values
- [x] R7. Provide input resolution and rendering:
  - fill defaults
  - reject unknown keys, missing required params (those without a default) and type mismatches with `DecisionInputError`
  - render `${params.<name>}` into `instructions` and criteria-description string leaves, with the default instructions template `"${params.instructions}"`
  - build the decision state from the declared params, excluding `instructions` and nulls; the state is `null` when empty

### Acceptance Criteria

- [x] AC1 — A catalog file with several decision points loads into typed decision definitions
- [x] AC2 — The shipped JSON Schema validates a catalog that declares it
- [x] AC3 — Declared parameter types and defaults shape the external input
- [x] AC4 — An inconsistent catalog fails at load time with the decision and field named
- [x] AC5 — The new ts-ai-decision package joins the workspace with one-way dependencies on ts-ai-runner and the bundled drivers

Task-local check: `bun run spur-check` and `bun run build` pass with the new package included.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

Approach: a thin layer over `ts-runtime`'s `parseStructuredConfig` (YAML parse plus `$schema` validation), followed by a zod parse and explicit cross-field checks. Reason: rule-engine already loads config this way, so this adds no YAML dependency and no platform-API exception. The `yaml` lib rejects duplicate keys, so the starting sample's repeated `default:` keys are a load error by construction.

Rejected alternatives:
- a code-first `defineDecision()` builder, which loses decisions-as-data
- hosting the catalog inside `ts-ai-runner`, which blurs the ADR-026 neutral-contract seam
- JSON catalogs, because the operator wants comments
- `{{param}}` placeholders, superseded by `${params.*}` to align with `ts-dual-workflow-engine/src/variables.ts`

Invariants:
- Validation is all-or-nothing per catalog. A catalog that fails any check produces no definitions.
- The Jev field names are `type`/`instructions`/`criteria`, and the YAML keys `true`/`false` parse as strings.
- Templating is limited:
  - only `${params.<name>}`, using the regex `/\$\{([^}]+)\}/g` as in dual-workflow-engine
  - applied only to `instructions` and criteria-description string leaves; labels, fallback, maker and model are never templated
  - no escape syntax and no `${env.*}`
- Substitution forms: strings verbatim, numbers and booleans via `String`, json via `JSON.stringify`, null as `""`.
- `instructions` is reserved and implicit: type string, default `""`. Declaring it is a load error.
- The JSON Schema and the zod schema describe the same shape, and the zod schema is the runtime source of truth.

Key signatures:
- `loadDecisionCatalog(path: string, options?: CatalogLoadOptions): Promise<DecisionCatalog>`
- `parseDecisionCatalog(content: string, source: string, options?: CatalogLoadOptions): Promise<DecisionCatalog>`
- `CatalogLoadOptions { validateSchema?; fileSystem?: Pick<FileSystem, 'readFile'> }`
- `resolveDecisionInput(decision, input): ResolvedParams`
- `renderQuestion(decision, params): JevQuestion`
- `buildState(decision, params): Record<string, Json> | null`
- `class DecisionCatalogError { source; decisionId?; field? }`
- `class DecisionInputError { decisionId; param }`

Surface detail: `docs/design/ai-decision-catalog.md` § Catalog file, § Parameters, § Variable replacement, § Load-time checks.

### Plan

- [x] List the ways loading can fail, then write the e2e YAML fixtures for each before writing the loader. Failure cases:
  - schema violation
  - `.json` source
  - duplicate YAML key
  - fallback outside the vocabulary
  - undeclared or `${env.*}` reference
  - declared `instructions`
  - default type mismatch
  - score fallback outside the levels
- [x] Scaffold `packages/ai-decision` from the rule-engine layout (package.json with both exports, tsconfig with sibling paths, tsconfig.build.json, README stub) and register it at the root and in `docs/design/package-exports.md`.
- [x] Add the decision-boundaries rule for the one-way edges.
- [x] Write the zod schema and the matching `schemas/decision-catalog.schema.json`.
- [x] Implement the loader, the cross-field checks, input resolution, `${params.*}` rendering and state building.
- [x] Add a tests/ e2e suite that loads real catalog files from `tests/fixtures/`, including one declaring `$schema: "@gobing-ai/ts-ai-decision/schemas/decision-catalog.schema.json"`, end to end.
- [x] Run `bun run spur-check` and `bun run build`.

### Solution

Both parts landed in one working tree (uncommitted; commit intentionally left to the operator).

#### Change map — part 1: `packages/ai-decision/` (new package, load side)

- `packages/ai-decision/package.json` — `@gobing-ai/ts-ai-decision`; lockstep 0.5.12, `sideEffects: false`; exports `.`, `./schemas/*`, `./package.json`; files `dist/src/schemas/examples/README.md`; `workspace:*` deps on ts-ai-runner/ts-decision-fm/ts-laya-mlx/ts-runtime + `zod ^4.1.0` (R1, R2).
- `packages/ai-decision/tsconfig.json` + `tsconfig.build.json` — package compile configs with ADR-004/012 `paths` to sibling sources.
- `packages/ai-decision/src/index.ts:1-5` — public barrel (catalog, errors, params, schema, types).
- `packages/ai-decision/src/types.ts` — typed definitions: `DecisionDefinition`, `DecisionParam`, `DecisionCriteria`, `JevQuestion`, `DecisionCatalog`.
- `packages/ai-decision/src/schema.ts` — zod runtime schema (`DecisionCatalogSchema`, strict at every level) + `DECISION_ID_PATTERN`/`PARAM_NAME_PATTERN`/`MAKER_NAME_PATTERN`; mirrors `schemas/decision-catalog.schema.json` (R4).
- `packages/ai-decision/src/catalog.ts` — `loadDecisionCatalog` (:49) / `parseDecisionCatalog` (:65) over ts-runtime `parseStructuredConfig`; YAML-only, `$schema` honoured, all-or-nothing cross-field checks (fallback vocabulary, template refs, reserved `instructions`, default type/enum match) naming decision + field (R5, R6).
- `packages/ai-decision/src/params.ts` — `resolveDecisionInput`, `renderQuestion`, `buildState`, default template `${params.instructions}` (R7).
- `packages/ai-decision/src/errors.ts` — `DecisionCatalogError` (source/decisionId/field) and `DecisionInputError` (decisionId/param).
- `packages/ai-decision/schemas/decision-catalog.schema.json` — shipped strict JSON Schema (R2, R4).
- `packages/ai-decision/examples/support.yaml` — shipped example catalog.
- `packages/ai-decision/tests/` — `catalog.test.ts` (loader + AC1–AC4 behavior, fixtures under `tests/fixtures/{valid,invalid}/`), plus `errors.test.ts`, `params.test.ts`, `schema.test.ts` (module correspondence, part 2).
- `packages/ai-decision/README.md` — package purpose and usage.
- `bun.lock` — workspace registration via `bun install`.

#### Change map — part 2: registration, rule, gates

- `tsconfig.json:29` — root `references` entry `./packages/ai-decision` (R1).
- `README.md:36` — dependency-graph node `ai-decision → runtime, ai-runner, decision-fm, laya-mlx`; `README.md:50-56` — graph edges incl. new `laya-mlx`/`decision-fm` nodes; `README.md:74` — package-list bullet under "AI & Workflow Packages"; `README.md:59` — test-count line refreshed to `2700 tests across 12 packages` (R1).
- `docs/design/package-exports.md:18` — `@gobing-ai/ts-ai-decision | . | README` row (R1).
- `.spur/rules/typescript/decision-boundaries.yaml:94-127` — three `forbidden-import` rules (R3): `no-ai-decision-import-in-ai-runner` (:94), `no-ai-decision-import-in-decision-fm` (:106), `no-ai-decision-import-in-laya-mlx` (:118). Negative-tested: a probe file importing `@gobing-ai/ts-ai-decision` under `packages/ai-runner/src` fails the pre-check with `ERROR no-ai-decision-import-in-ai-runner`; probe removed afterwards.
- `packages/ai-decision/tests/{errors,params,schema}.test.ts` — new per-module tests; `tests/catalog.e2e.test.ts` renamed to `tests/catalog.test.ts` to satisfy the flat `require-corresponding-test` convention (no rule exclusions added).
- TSDoc added to previously undocumented exports flagged by `every-export-has-tsdoc`: `packages/ai-decision/src/catalog.ts:27` (`CatalogLoadOptions`), `packages/ai-decision/src/schema.ts:13-15,44,50,64,83-88`.
- Fixups driven by the root coverage threshold (bunfig.toml 0.9/0.9): branch tests for loader error paths, lazy JSON Jev-entry schema branches, nested object/array template rendering.

#### Gate results (final tree)

```
bun run spur-check  → exit 0
Checked 507 files in 375ms. No fixes applied.
All 58 rules passed — no violations found.
2700 pass
0 fail
Ran 2700 tests across 228 files. [36.14s]
All 2 rules passed — no violations found.

bun run build → exit 0 (12/12 packages "Exited with code 0", incl. @gobing-ai/ts-ai-decision)
```

#### Acceptance criteria

- AC1 — satisfied: a multi-decision fixture loads into typed definitions with defaults and per-decision fields (`loadDecisionCatalog`, `packages/ai-decision/src/catalog.ts:49`); evidence `tests/catalog.test.ts` "loads a multi-decision catalog with defaults and per-decision fields" over `tests/fixtures/valid/catalog.yaml`.
- AC2 — satisfied: the shipped JSON Schema validates a catalog declaring it via `$schema` through ts-runtime; evidence `schemas/decision-catalog.schema.json` + `tests/catalog.test.ts` "validates a catalog that declares the bundled schema" / "rejects an unresolvable $schema by default and honours validateSchema: false".
- AC3 — satisfied: declared param types/defaults shape the external input (defaults fill, unknown/missing/type mismatches rejected, `${params.*}` rendering, state building); evidence `tests/params.test.ts` (unit) and `tests/catalog.test.ts` "resolveDecisionInput (AC3…)" / "renderQuestion (R7…)" describes.
- AC4 — satisfied: inconsistent catalogs fail at load with source, decision id and field named; evidence `tests/catalog.test.ts` "loadDecisionCatalog (AC4…)" describe plus the branch tests for choice/score/noul criteria, fallback vocabulary, template refs, reserved `instructions` and default-type checks.
- AC5 — satisfied: ts-ai-decision joins the workspace with one-way deps (ai-runner, decision-fm, laya-mlx, runtime, all `workspace:*`); evidence `package.json` dependencies, `tsconfig.json:29`, `bun.lock`, README/package-exports rows, and the enforced boundary in `.spur/rules/typescript/decision-boundaries.yaml:94-127` (probe-verified firing).

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/ai-decision/package.json:2-3` (name `@gobing-ai/ts-ai-decision`, lockstep 0.5.12), :23 `sideEffects:false`, :27-34 exports `.`/`./schemas/*`/`./package.json`, :35-41 files; `tsconfig.json:29` root reference; `README.md:36,53-56,74`; `docs/design/package-exports.md:18` — all re-read this run |
| R2 | MET | `packages/ai-decision/package.json:54-58` workspace:* on ts-ai-runner/ts-decision-fm/ts-laya-mlx/ts-runtime + zod ^4.1.0; grep `node:`/`Bun.`/`process.env` over `packages/ai-decision/src/` → zero matches this run |
| R3 | MET | `.spur/rules/typescript/decision-boundaries.yaml:94,106,118` three forbidden-import rules scoped to packages/{ai-runner,decision-fm,laya-mlx}/src — re-read this run |
| R4 | MET | `packages/ai-decision/schemas/decision-catalog.schema.json` (strict, additionalProperties:false) mirrored by zod `DecisionCatalogSchema` in `packages/ai-decision/src/schema.ts`; pinned by `tests/schema.test.ts` (pass this run) |
| R5 | MET | `packages/ai-decision/src/catalog.ts:49` `loadDecisionCatalog`, :65 `parseDecisionCatalog`, :73 over ts-runtime `parseStructuredConfig`; `packages/ai-decision/src/params.ts:14` default template `${params.instructions}`; implicit reserved `instructions` param via `implicitInstructionsParam()` (params.ts:20) |
| R6 | MET | `packages/ai-decision/src/errors.ts:6` `DecisionCatalogError {source; decisionId?; field?}`; all-or-nothing checks proven by `tests/catalog.test.ts` AC4 describe over `tests/fixtures/invalid/` — pass this run |
| R7 | MET | `packages/ai-decision/src/params.ts` `resolveDecisionInput` (Object.hasOwn unknown-key guard :61, missing-required + type mismatch → `DecisionInputError`), `renderQuestion` (:121, labels/fallback/maker never templated), `buildState` (:160, excludes instructions/nulls, null when empty) — re-read this run |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | test | `cd packages/ai-decision && bun test` → 97 pass / 0 fail (this run); "loads a multi-decision catalog with defaults and per-decision fields" over `tests/fixtures/valid/catalog.yaml` |
| AC-2 | MET | test | `tests/catalog.test.ts` "validates a catalog that declares the bundled schema" + unresolvable-$schema negative — pass this run |
| AC-3 | MET | test | `tests/params.test.ts` defaults overlay / unknown keys / missing required / type+enum mismatch / null-json — pass this run |
| AC-4 | MET | test | `tests/catalog.test.ts` AC4 describe (schema violation, fallback vocab, undeclared + env refs, declared instructions, default type mismatch) each asserting decisionId+field — pass this run |
| AC-5 | MET | test | workspace:* deps re-read (`package.json:54-58`); root `tsconfig.json:29`; boundary rules `.spur/rules/typescript/decision-boundaries.yaml:94-127` re-read this run |
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

- 2026-10-03T17:20:16.710Z todo → wip (system)
- 2026-10-03T17:50:38.692Z wip → testing (system)
- 2026-10-03T17:53:41.180Z testing → done (system)

