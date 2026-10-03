---
schema_version: 1
name: Scaffold ts-ai-decision and load decision catalogs
status: todo
template: feature-impl
created_at: 2026-10-03T05:42:57.272Z
updated_at: "2026-10-03T15:40:31.831Z"
feature_id: N
priority: P2
tags:
  - ai-decision
  - new-package
  - catalog
estimate_hours: 5

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

- [ ] R1. Create `packages/ai-decision` as `@gobing-ai/ts-ai-decision`:
  - lockstep version and `sideEffects: false`
  - exports `.`, `./schemas/*` and `./package.json`, the same pair just added to rule-engine. ts-runtime resolves `$schema` through `<pkg>/package.json`, which Node's resolver refuses unless exported; standard resolvers need `./schemas/*`
  - files `dist`/`src`/`schemas`/`examples`/`README.md`
  - register it in the root workspace, the root `tsconfig.json` references, the root README package list and graph, and `docs/design/package-exports.md`
- [ ] R2. Depend via `workspace:*` on `@gobing-ai/ts-ai-runner`, `@gobing-ai/ts-decision-fm`, `@gobing-ai/ts-laya-mlx` and `@gobing-ai/ts-runtime`, with matching tsconfig `paths` (ADR-004/012), plus `zod`. Import no platform API directly.
- [ ] R3. Add a spur rule in `.spur/rules/typescript/decision-boundaries.yaml` that forbids `packages/ai-runner/src`, `packages/decision-fm/src` and `packages/laya-mlx/src` from importing `@gobing-ai/ts-ai-decision`.
- [ ] R4. Ship `schemas/decision-catalog.schema.json` and a zod schema for the normative shape in the design doc. Both are strict (no unknown keys). The shape:
  - `$schema`, `version: 1`, optional `defaults {maker, model, minConfidence}`, and `decisions` keyed by id (`^[a-z][a-z0-9_-]*$`)
  - each decision has `type` (choice|score|noul), optional `description` and templated `instructions`, `parameters` (shorthand `name: type` or `{type, default?, values?, description?}`), and `criteria`:
    - choice: a label map with at least 2 labels
    - score: a list with at least 2 entries
    - noul: optional `{true, false}`
  - each decision also has a required `fallback` and optional `minConfidence`/`maker` (a registry name matching `^[a-z][a-z0-9-]*$`; registration is checked by the hub, not the loader)/`model`
- [ ] R5. Provide `loadDecisionCatalog(path, options)` and `parseDecisionCatalog(content, source, options)` on top of `parseStructuredConfig`:
  - reject any source not ending in `.yaml`/`.yml`
  - honour `$schema` when present
  - return typed decision definitions that include the implicit reserved `instructions` parameter (string, default `""`)
- [ ] R6. Reject an inconsistent catalog with `DecisionCatalogError` naming the source, decision id and field. The checks are all-or-nothing:
  - a fallback outside the answer vocabulary (choice label, score level index, noul boolean)
  - a `${...}` reference to an undeclared param or to any namespace other than `params`
  - a declared `instructions` param
  - a default that does not match its type or enum values
- [ ] R7. Provide input resolution and rendering:
  - fill defaults
  - reject unknown keys, missing required params (those without a default) and type mismatches with `DecisionInputError`
  - render `${params.<name>}` into `instructions` and criteria-description string leaves, with the default instructions template `"${params.instructions}"`
  - build the decision state from the declared params, excluding `instructions` and nulls; the state is `null` when empty

### Acceptance Criteria

- [ ] AC1 — A catalog file with several decision points loads into typed decision definitions
- [ ] AC2 — The shipped JSON Schema validates a catalog that declares it
- [ ] AC3 — Declared parameter types and defaults shape the external input
- [ ] AC4 — An inconsistent catalog fails at load time with the decision and field named
- [ ] AC5 — The new ts-ai-decision package joins the workspace with one-way dependencies on ts-ai-runner and the bundled drivers

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

- [ ] List the ways loading can fail, then write the e2e YAML fixtures for each before writing the loader. Failure cases:
  - schema violation
  - `.json` source
  - duplicate YAML key
  - fallback outside the vocabulary
  - undeclared or `${env.*}` reference
  - declared `instructions`
  - default type mismatch
  - score fallback outside the levels
- [ ] Scaffold `packages/ai-decision` from the rule-engine layout (package.json with both exports, tsconfig with sibling paths, tsconfig.build.json, README stub) and register it at the root and in `docs/design/package-exports.md`.
- [ ] Add the decision-boundaries rule for the one-way edges.
- [ ] Write the zod schema and the matching `schemas/decision-catalog.schema.json`.
- [ ] Implement the loader, the cross-field checks, input resolution, `${params.*}` rendering and state building.
- [ ] Add a tests/ e2e suite that loads real catalog files from `tests/fixtures/`, including one declaring `$schema: "@gobing-ai/ts-ai-decision/schemas/decision-catalog.schema.json"`, end to end.
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
