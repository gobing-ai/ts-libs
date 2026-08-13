---
template: feature-impl
schema_version: 1
name: "Add rule-style extensions block to workflow YAML schema"
description: ""
status: done
type: task
profile: standard
feature_id: C1
parent_wbs: null
priority: P1
tags: ["workflow", "extensions"]
dependencies: []
ac_numbering: task-local
created_at: "2026-08-13T06:19:07.887Z"
updated_at: "2026-08-13T06:59:56.311Z"
---

## 0062. Add rule-style extensions block to workflow YAML schema

### Background
Workflow YAML can name a runner by kind (`guard: { kind: shell }`) but cannot declare the modules that implement extra kinds. Rule presets already can: `extensions.evaluators: [./file.ts]` relative to the declaring YAML, collected by `collectExtensions` and loaded by `loadExtensionsIntoHost`.

**Verified against the current tree (2026-08-12):**

- Both dialect Zod schemas are `.strict()` and have **no** `extensions` key: `packages/dual-workflow-engine/src/schema.ts` (`StateMachineWorkflowDefSchema`, `TransitionFlowWorkflowDefSchema`).
- Both hand-written `WorkflowDef` interfaces omit `extensions`: `packages/dual-workflow-engine/src/types.ts` (`StateMachineWorkflowDef`, `TransitionFlowWorkflowDef`).
- Packaged JSON schemas are hand-maintained (not generated) and also omit `extensions`; both set `"additionalProperties": false`: `packages/dual-workflow-engine/schemas/state-machine-workflow.schema.json`, `packages/dual-workflow-engine/schemas/transition-flow-workflow.schema.json`.
- `loadWorkflowExtensionsIntoHost` and `WorkflowExtensionRef` (`path` + `baseDir` + `kind` + `sourceName`) already exist in `packages/dual-workflow-engine/src/extensions.ts`. `WorkflowExtensionKind` is `'actions' | 'guards'` only (ADR-010).
- **`collectWorkflowExtensions` does not exist.** Task 0010 planned it “for future workflow-file-declared use” and then shipped only the loader. Rule-engine’s analog is `collectExtensions` in `packages/rule-engine/src/config/extensions.ts` (maps authored paths; does **not** validate them).
- Rule-engine path rules live in a **file-private** `relativeExtensionPath` Zod helper in `packages/rule-engine/src/types.ts` (not exported). It wraps `assertRelativeExtensionPath` from `@gobing-ai/ts-runtime/extension` (`packages/runtime/src/extension/extension-path.ts`). JSON-schema twin: `$defs.relativeExtensionPath` in `packages/rule-engine/schemas/preset.schema.json`.
- `loadWorkflowDef` / `WorkflowService.load` / `runFile` parse and run a def; they never collect or import extension modules (`packages/dual-workflow-engine/src/config.ts`, `src/service.ts`).
- README “Extension Loading” still shows the retired `absPath` ref shape (`packages/dual-workflow-engine/README.md`), which contradicts today’s `WorkflowExtensionRef`.
- Unknown top-level keys already fail: `tests/config.test.ts` (`initial` vs `initialState`). That regression must stay green after `extensions` becomes a known key.

Implements feature **C1**. Companion CLI wiring (`spur workflow validate|run` calling collect + the trust gate) is spur-new feature D4 / task 0533, after this package is bumped — not this task.

Out of scope: new built-in action/guard kinds; product-plugin (`plugin.json`) discovery; making `loadWorkflowDef` or `WorkflowService` auto-import modules; changing `allowExtensions`; accepting absolute / home-dir / `~` paths; a new ADR (ADR-010 already assigned schema ownership to each engine).
### Requirements
- [x] R1. Both dialect Zod schemas (`StateMachineWorkflowDefSchema`, `TransitionFlowWorkflowDefSchema`) and both packaged JSON schemas accept an optional top-level `extensions` object whose only keys are `actions` and `guards`, each an optional array of relative module path strings. The extensions object is `.strict()` / `"additionalProperties": false` (unknown keys such as `evaluators` or `plugins` fail). Existing defs with no `extensions` key still parse.

- [x] R2. `collectWorkflowExtensions(sourceName, sourceDir, extensions)` returns `WorkflowExtensionRef[]` with the authored `path` unchanged, `baseDir = sourceDir`, `sourceName` as passed, and `kind` of `'actions'` or `'guards'`. Kind order is `actions` then `guards`. `undefined` or empty arrays yield `[]`. The function does not import modules and does not resolve or rewrite paths.

- [x] R3. An empty string, an absolute path (`/…`, `\…`, `C:\…`, `C:/…`), or a `..` path segment is rejected at Zod parse time via `assertRelativeExtensionPath` (same messages as the shared helper). `loadWorkflowDef` / `loadWorkflowDefFromText` therefore throw `WorkflowValidationError` and never return those strings on the def. Collection is not the rejection site.

- [x] R4. Unknown top-level keys still fail `.strict()` parse after `extensions` is added (regression: `initial`, `plugins`, or any other undocumented field).

- [x] R5. Both `WorkflowDef` dialect interfaces include optional `extensions?: WorkflowExtensions`. `WorkflowExtensions`, `WorkflowExtensionsSchema`, and `collectWorkflowExtensions` are exported from `@gobing-ai/ts-dual-workflow-engine`. The package README documents the YAML `extensions` block as the rule-engine analog and replaces the retired `absPath` loader example with `path` + `baseDir`.
### Acceptance Criteria
```gherkin
Feature: Workflow YAML rule-style extensions

  @core
  Scenario: R1 — Schema accepts extensions.actions and extensions.guards
    Given a state-machine YAML and a transition-flow YAML each declaring
      extensions.actions: ["./exts/audit.ts"] and extensions.guards: ["./exts/flag.ts"]
    When loadWorkflowDefFromText (or StateMachineWorkflowDefSchema / TransitionFlowWorkflowDefSchema.safeParse) runs
    Then parsing succeeds and the def carries those two arrays unchanged
    And a def with no extensions key still parses
    And extensions.evaluators or any other unknown key inside extensions fails parse
    And both packaged JSON schemas declare properties.extensions and $defs.relativeExtensionPath

  @core
  Scenario: R2 — collectWorkflowExtensions builds refs against the YAML directory
    Given a workflow file at /proj/wf.yaml declaring extensions.guards: ["./exts/flag.ts"]
    When collectWorkflowExtensions("wf", "/proj", { guards: ["./exts/flag.ts"] }) runs
    Then the result is one ref: kind "guards", path "./exts/flag.ts", baseDir "/proj", sourceName "wf"
    And collectWorkflowExtensions("wf", "/proj", undefined) returns []
    And no moduleLoader is invoked

  @core
  Scenario: R3 — Absolute paths and parent traversal are rejected
    Given an extensions.actions or extensions.guards entry that is "", "/abs.ts", "C:\\x.ts", "../escape.ts", or "a/../../x.ts"
    When StateMachineWorkflowDefSchema or TransitionFlowWorkflowDefSchema parses the def
    Then safeParse fails (or loadWorkflowDefFromText throws WorkflowValidationError)
    And no module is imported

  @edge
  Scenario: R4 — Unknown top-level keys remain rejected
    Given a workflow YAML with a top-level key other than the documented fields (for example initial or plugins)
    When loadWorkflowDefFromText parses the file
    Then schema validation fails
    And a YAML that adds only a valid extensions block (no extra top-level keys) still parses

  @core
  Scenario: R5 — WorkflowDef types export the extensions field
    Given the package public entry @gobing-ai/ts-dual-workflow-engine
    When a consumer imports WorkflowDef, WorkflowExtensions, WorkflowExtensionsSchema, and collectWorkflowExtensions
    Then WorkflowDef includes optional extensions.actions and extensions.guards
    And collectWorkflowExtensions and WorkflowExtensionsSchema are runtime exports
    And the README shows a YAML extensions.actions / extensions.guards example and a loader ref using path + baseDir (not absPath)
```
### Q&A
**Q: Feature C1 numbers R4 = unknown keys and R5 = types export; the generated task had them swapped. Which wins?**
A: Feature C1 is SSOT. Task R4/R5 (requirements + AC titles) are aligned to the feature. Coverage matches on normalized scenario title.

**Q: Where are absolute / `..` paths rejected — parse, collect, or load?**
A: Parse time, same as rule-engine. Copy the private `relativeExtensionPath` Zod pattern onto `WorkflowExtensionsSchema` so it calls `assertRelativeExtensionPath`. `collectWorkflowExtensions` only maps; it does not validate. The shared loader still re-checks at import time (already shipped; not this task). Feature C1 R3’s “parsed or refs are collected” wording is loose; this task freezes parse-time as the YAML rejection site.

**Q: Can we import rule-engine’s `relativeExtensionPath`?**
A: No. It is a non-exported `const` in `packages/rule-engine/src/types.ts`. Duplicate the ~15-line Zod helper in `packages/dual-workflow-engine/src/schema.ts` and import `assertRelativeExtensionPath` from `@gobing-ai/ts-runtime/extension` (already a dependency). Copy `$defs.relativeExtensionPath` from `packages/rule-engine/schemas/preset.schema.json` into both workflow JSON schemas.

**Q: Should `loadWorkflowDef` / `WorkflowService` auto-collect and load extensions?**
A: No. That is embedder/CLI work (spur-new D4). This package only accepts the field on the def and exports `collectWorkflowExtensions` so a caller can write `collectWorkflowExtensions(def.name, dirnamePath(path), def.extensions)` and pass the refs to `loadWorkflowExtensionsIntoHost`.

**Q: Type / schema names?**
A: `WorkflowExtensions` (interface, analog of `PresetExtensions`), `WorkflowExtensionsSchema` (Zod, analog of `ExtensionsSchema` but only `actions` / `guards`). Do not reuse the rule-engine names.

**Q: New ADR?**
A: No. ADR-010 already says each engine owns its kinds and schemas. Adding a YAML field is not a new decision.

**Q: Is the README `absPath` example in scope?**
A: Yes. It is already wrong after 0060 C2. Documenting the YAML block next to a retired ref shape would ship a lying README. Replace that snippet in the same edit.

**Q: `~` / home-dir paths?**
A: Out of scope. Do not add a `~` check. `assertRelativeExtensionPath` does not treat `~` as absolute; stay identical.

**Q: JSON schema vs Zod as SSOT?**
A: Zod is what `loadWorkflowDef` enforces. JSON schemas are the editor / `$schema` artifact and must stay in lockstep (hand-edited, like today). Do not generate one from the other in this task.
### Design
## WHAT

Add an optional rule-style `extensions` block to both workflow dialects so a YAML file can list relative action/guard modules. Export a collector that turns that block into the `WorkflowExtensionRef[]` `loadWorkflowExtensionsIntoHost` already consumes.

## WHY

The loader and host registries exist (task 0010 + 0060 C2). The missing piece is the declaring document: without an `extensions` field, every extra kind has to be assembled in TypeScript by the embedder. Rule-engine already solved this on presets/rule files; copy that shape, not that package’s private helpers.

## WHERE

| File | Change |
| --- | --- |
| `packages/dual-workflow-engine/src/schema.ts` | Add private `relativeExtensionPath` + export `WorkflowExtensionsSchema`; attach `extensions: WorkflowExtensionsSchema.optional()` to both dialect objects (still `.strict()`). |
| `packages/dual-workflow-engine/src/types.ts` | Add `WorkflowExtensions`; add `readonly extensions?: WorkflowExtensions` to both dialect interfaces. Keep hand-written types (do not switch the file to `z.infer`). |
| `packages/dual-workflow-engine/src/extensions.ts` | Add `collectWorkflowExtensions` next to `loadWorkflowExtensionsIntoHost`. |
| `packages/dual-workflow-engine/src/index.ts` | Export `collectWorkflowExtensions`, `WorkflowExtensionsSchema`, type `WorkflowExtensions`. |
| `packages/dual-workflow-engine/schemas/state-machine-workflow.schema.json` | Add `properties.extensions` + `$defs.extensions` + `$defs.relativeExtensionPath`. |
| `packages/dual-workflow-engine/schemas/transition-flow-workflow.schema.json` | Same `$defs` / property. |
| `packages/dual-workflow-engine/README.md` | YAML `extensions` example (rule-engine analog); fix loader snippet `absPath` → `path` + `baseDir`. |
| `packages/dual-workflow-engine/tests/schema.test.ts` | Parse accept + reject (abs / `..` / empty / unknown nested key) on **both** dialects. |
| `packages/dual-workflow-engine/tests/config.test.ts` | `loadWorkflowDefFromText` YAML with `extensions`; keep the unknown-top-level regression. |
| `packages/dual-workflow-engine/tests/extensions.test.ts` | `collectWorkflowExtensions` mapping, `undefined` → `[]`, kind order, no import. |
| `CHANGELOG.md` | `feat` entry for `@gobing-ai/ts-dual-workflow-engine` (optional field; not breaking). |

Do **not** touch `config.ts`, `service.ts`, `host.ts`, `package.json` `exports`, spur CLI, or spur-new.

## Frozen names

```ts
export interface WorkflowExtensions {
    readonly actions?: readonly string[];
    readonly guards?: readonly string[];
}

export const WorkflowExtensionsSchema: z.ZodType; // .strict(); actions? / guards? of relativeExtensionPath

export function collectWorkflowExtensions(
    sourceName: string,
    sourceDir: string,
    extensions: WorkflowExtensions | undefined,
): WorkflowExtensionRef[];
```

Kind walk order: `['actions', 'guards']`. `sourceName` and `sourceDir` are caller-supplied (typically `def.name` and the YAML directory). Paths stay **as authored**.

Private Zod helper (in `schema.ts`, not exported):

```ts
import { assertRelativeExtensionPath } from '@gobing-ai/ts-runtime/extension';

const relativeExtensionPath = z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
        try {
            assertRelativeExtensionPath(value);
        } catch (error) {
            ctx.addIssue({
                code: 'custom',
                message: error instanceof Error ? error.message : 'invalid extension path',
            });
        }
    });
```

JSON `$defs.relativeExtensionPath` — copy rule-engine verbatim:

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Relative module path; absolute paths and '..' traversal are forbidden.",
  "not": {
    "anyOf": [
      { "pattern": "^[/\\\\]" },
      { "pattern": "^[A-Za-z]:[/\\\\]" },
      { "pattern": "(^|[/\\\\])\\.\\.([/\\\\]|$)" }
    ]
  }
}
```

`$defs.extensions`: object, `additionalProperties: false`, properties `actions` / `guards` as arrays of that `$ref`. Both packaged schemas `$ref` it from `properties.extensions`.

## Precedence / algorithm

1. YAML/JSON → existing `parseWorkflowDef` → dialect Zod (now includes `extensions`) → semantic `validateWorkflowDef` (unchanged; do not invent semantic rules for extension paths).
2. Caller that wants modules: `collectWorkflowExtensions(def.name, dirnamePath(path), def.extensions)` then `loadWorkflowExtensionsIntoHost(host, refs, { allowExtensions: true, moduleLoader, … })`.
3. Path guard is string-level only (ADR-022 symlink confinement stays on the loader’s `realPath`, unchanged).

## Anti-patterns (do not implement)

- Importing anything from `@gobing-ai/ts-rule-engine` to reuse `relativeExtensionPath` / `ExtensionsSchema` / `collectExtensions`.
- Moving this file to `src/config/extensions.ts` (0010’s planned path; the loader already lives at `src/extensions.ts`).
- Calling collect or `loadWorkflowExtensionsIntoHost` inside `loadWorkflowDef` / `WorkflowService`.
- Validating paths inside `collectWorkflowExtensions` (breaks the 0060 C2 “authored path reaches the loader” contract if someone constructs refs by hand).
- Basename-smashing or `resolve(sourceDir, path)` inside collect.
- Adding a `plugins` kind or accepting absolute / `~` paths.
- `z.infer` rewrite of `types.ts`.
- Generating JSON schema from Zod, or adding a `package.json` `exports` `./schemas/*` entry.
- Changing `allowExtensions` default or silent-dropping undeclared extensions.
- Real `import()` in new tests; collect tests are synchronous. Parse tests use `safeParse` / `loadWorkflowDefFromText`.
- New ADR, new built-in kinds, CLI flags, or edits under `.github/`.

## Handoff

- **Assumes from 0010 / 0060:** `WorkflowExtensionRef` is `{ kind, path, baseDir, sourceName }`; loader already fail-closes on `allowExtensions !== true` and re-runs `assertRelativeExtensionPath`.
- **Leaves for spur-new D4 (0533):** `spur workflow validate|run` reads the YAML directory, calls `collectWorkflowExtensions`, and passes `allowExtensions` from the CLI trust flag.
- **Leaves for a later task if wanted:** `WorkflowService.runFile` auto-load (explicitly not this WBS).
### Plan
1. Re-read `packages/dual-workflow-engine/src/schema.ts`, `src/types.ts`, `src/extensions.ts`, `src/index.ts`, both files under `schemas/`, `README.md` (Extension Loading + YAML examples), `packages/rule-engine/src/types.ts` (`relativeExtensionPath` + `ExtensionsSchema` + `PresetExtensions`), `packages/rule-engine/src/config/extensions.ts` (`collectExtensions`), `packages/rule-engine/schemas/preset.schema.json` (`$defs.relativeExtensionPath`). Confirm `collectWorkflowExtensions` is still absent before writing.
2. **R1 + R3 + R4 (schema)** — Add `relativeExtensionPath` + `WorkflowExtensionsSchema` in `schema.ts`; attach optional `extensions` to both dialect schemas. Copy `$defs.relativeExtensionPath` + `$defs.extensions` into both JSON schemas and add `properties.extensions`. Tests in `tests/schema.test.ts`: both dialects accept a valid block; reject `""`, `/abs.ts`, `C:\\x.ts`, `../escape.ts`, `a/../../x.ts`; reject `extensions: { evaluators: ["./x.ts"] }`; omit `extensions` still succeeds. Assert both JSON files contain `properties.extensions` and `$defs.relativeExtensionPath`.
3. **R4 regression** — Keep `tests/config.test.ts` unknown-top-level (`initial`) failing. Add a `loadWorkflowDefFromText` case that parses a minimal state-machine YAML with `extensions.guards: ["./exts/flag.ts"]` and reads the arrays back.
4. **R2 (collect)** — Implement `collectWorkflowExtensions` in `extensions.ts` (map only; kind order `actions` then `guards`). Tests in `tests/extensions.test.ts`: `/proj` + `./exts/flag.ts` → one `guards` ref; `undefined` → `[]`; both kinds produce two refs in order; no `moduleLoader`.
5. **R5 (exports + README)** — Export `collectWorkflowExtensions`, `WorkflowExtensionsSchema`, type `WorkflowExtensions` from `src/index.ts`. Add `WorkflowExtensions` to both dialect interfaces in `types.ts`. README: YAML `extensions` example under the existing YAML section; replace `{ kind, absPath, sourceName }` with `{ kind, path, baseDir, sourceName }`. Optional type-level `satisfies WorkflowDef` in a test if cheap; runtime `typeof collectWorkflowExtensions === 'function'` is enough.
6. **Changelog** — `CHANGELOG.md` feat line for the optional `extensions` block (not breaking).
7. Verify: `bun test packages/dual-workflow-engine/tests/schema.test.ts packages/dual-workflow-engine/tests/config.test.ts packages/dual-workflow-engine/tests/extensions.test.ts` then `bun run spur-check` and `bun run build`. No skipped tests, no `biome-ignore` to silence the gate, internal deps stay `workspace:*`.
8. Fill `## Solution` (`file:line` change-map). Stop. Do not wire `WorkflowService` or the spur CLI.
### Solution
Rule-style `extensions` block added to both workflow dialects, mirroring rule-engine presets (ADR-010 owns schema per engine; no new ADR).

| Change | Evidence |
| --- | --- |
| Private `relativeExtensionPath` zod helper wrapping shared `assertRelativeExtensionPath` (R3) | `packages/dual-workflow-engine/src/schema.ts:33` |
| `WorkflowExtensionsSchema` — `.strict()`, only `actions`/`guards` of relative paths | `packages/dual-workflow-engine/src/schema.ts:52` |
| Optional `extensions` attached to both dialect Zod schemas (still `.strict()`) | `packages/dual-workflow-engine/src/schema.ts:111` (state-machine), `:152` (transition-flow) |
| `WorkflowExtensions` interface + `extensions?: WorkflowExtensions` on both dialect types | `packages/dual-workflow-engine/src/types.ts:38`, `:86`, `:126` |
| `collectWorkflowExtensions` — kind order `actions` then `guards`, authored paths kept, no import/resolve (R2) | `packages/dual-workflow-engine/src/extensions.ts:72` |
| Barrel exports: `collectWorkflowExtensions`, `WorkflowExtensionsSchema`, type `WorkflowExtensions` (R5) | `packages/dual-workflow-engine/src/index.ts:5`, `:40`, `:71` |
| JSON schemas: `properties.extensions` + `$defs.relativeExtensionPath`/`$defs.extensions` (R1) | `packages/dual-workflow-engine/schemas/state-machine-workflow.schema.json`, `transition-flow-workflow.schema.json` |
| README: YAML `extensions` block example; loader snippet `absPath` → `path` + `baseDir` | `packages/dual-workflow-engine/README.md` (Extension Loading / Declaring extensions in YAML) |
| Tests: dialect accept/reject + JSON schema assertions | `packages/dual-workflow-engine/tests/schema.test.ts` |
| Tests: `loadWorkflowDefFromText` parse + parse-time rejection (R4 regression kept) | `packages/dual-workflow-engine/tests/config.test.ts` |
| Tests: `collectWorkflowExtensions` mapping + public-entry barrel exports | `packages/dual-workflow-engine/tests/extensions.test.ts` |
| Changelog feat entry (optional field; not breaking) | `CHANGELOG.md` |

Deliberately unchanged per scope: `config.ts`, `service.ts`, `host.ts`, `package.json` exports, spur CLI (spur-new D4 / task 0533 wires collect + trust gate after this package bumps), no `z.infer` rewrite, no JSON-schema generation.
### Testing
Independent re-verify 2026-08-12 (`/sp-dev-verify 0062 --auto --next --force --focus all --fix all`). Status was already `done`; `--force` re-audited. Implementation is uncommitted working-tree (plus this task file). `--next: no-op - task already terminal (done)`.

`--fix all` this run: (1) flipped Requirements `- [ ]` → `- [x]` (`L3.unchecked-checklist`); (2) rewrote `.spur/run/0062-verdict.json` AC `id`s to the exact C1 scenario titles (previous artifact used shortened titles, so R1/R2/R3/R5 stayed `L4.scenario-unverified` while R4 already matched).

This-run tests: `bun test packages/dual-workflow-engine/tests/schema.test.ts packages/dual-workflow-engine/tests/config.test.ts packages/dual-workflow-engine/tests/extensions.test.ts` → **101 pass / 0 fail** (exit 0). `schema.ts` 100% funcs/lines; `extensions.ts` 100% funcs/lines.

Coverage: N/A for the repo-wide gate on this subset; the three files plus `schema.ts` / `extensions.ts` are fully covered by the commands above.

**Per-Requirement Traceability**

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | MET | `packages/dual-workflow-engine/src/schema.ts:52` `WorkflowExtensionsSchema` (`.strict()`, `actions`/`guards` only); `:111` / `:152` optional `extensions` on both dialect Zod objects. JSON: `packages/dual-workflow-engine/schemas/state-machine-workflow.schema.json:67` and `packages/dual-workflow-engine/schemas/transition-flow-workflow.schema.json:61` (`properties.extensions`); both `$defs.relativeExtensionPath` / `$defs.extensions` with `additionalProperties: false`. Tests: `packages/dual-workflow-engine/tests/schema.test.ts:289` (both dialects accept arrays unchanged), `:295` (omit still parses), `:326` (packaged JSON assertion). YAML parse: `packages/dual-workflow-engine/tests/config.test.ts:187` |
| R2 | MET | `packages/dual-workflow-engine/src/extensions.ts:72` `collectWorkflowExtensions` — kind walk `['actions','guards']`, authored `path`, `baseDir = sourceDir`, `sourceName` as passed; `:77` `undefined` → `[]`. Tests: `packages/dual-workflow-engine/tests/extensions.test.ts:487` (`wf` / `/proj` / `./exts/flag.ts`), `:491` kind order, `:502` empty, `:508` no resolve/smash. Sync; no `moduleLoader` |
| R3 | MET | `packages/dual-workflow-engine/src/schema.ts:33` `relativeExtensionPath` `.min(1)` + `assertRelativeExtensionPath` (`packages/runtime/src/extension/extension-path.ts:18`). Tests: `packages/dual-workflow-engine/tests/schema.test.ts:299` empty string; `:303` `/abs.ts`, `\abs.ts`, `C:\x.ts`, `C:/x.ts`, `../escape.ts`, `a/../../x.ts`. `loadWorkflowDefFromText` throws `WorkflowValidationError`: `packages/dual-workflow-engine/tests/config.test.ts:205` `/must be relative/`. Collect does not import |
| R4 | MET | Both dialect schemas remain `.strict()` (`packages/dual-workflow-engine/src/schema.ts:113`, `:154`). Regression: `packages/dual-workflow-engine/tests/config.test.ts:181` (`initial`). With extensions present: `packages/dual-workflow-engine/tests/schema.test.ts:318`. Nested unknown keys: `:258` `evaluators`, `:264` `plugins`, `:314` |
| R5 | MET | `packages/dual-workflow-engine/src/types.ts:38` `WorkflowExtensions`; `:86` / `:126` optional `extensions?` on both dialects. Barrel: `packages/dual-workflow-engine/src/index.ts:5` `collectWorkflowExtensions`, `:40` `WorkflowExtensionsSchema`, `:71` type `WorkflowExtensions`. Test: `packages/dual-workflow-engine/tests/extensions.test.ts:515`. README YAML block + `path`/`baseDir` (not `absPath` on the ref): `packages/dual-workflow-engine/README.md:707` and `:719`. Changelog: `CHANGELOG.md:13` |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
| --- | --- | --- | --- |
| R1 — Schema accepts extensions.actions and extensions.guards | MET | test | `packages/dual-workflow-engine/tests/schema.test.ts:289` both dialects; `:295` omit; `:258` / `:314` unknown nested key; `:326` JSON `$defs`; `packages/dual-workflow-engine/tests/config.test.ts:187` YAML |
| R2 — collectWorkflowExtensions builds refs against the YAML directory | MET | test | `packages/dual-workflow-engine/tests/extensions.test.ts:487` one `guards` ref `{path:'./exts/flag.ts', baseDir:'/proj', sourceName:'wf'}`; `:502` `undefined` → `[]`; no moduleLoader |
| R3 — Absolute paths and parent traversal are rejected | MET | test | `packages/dual-workflow-engine/tests/schema.test.ts:299` + `:303`; `packages/dual-workflow-engine/tests/config.test.ts:205` parse-time `WorkflowValidationError` |
| R4 — Unknown top-level keys remain rejected | MET | test | `packages/dual-workflow-engine/tests/config.test.ts:181`; `packages/dual-workflow-engine/tests/schema.test.ts:318` (`initial` + valid `extensions` still fails) |
| R5 — WorkflowDef types export the extensions field | MET | test | `packages/dual-workflow-engine/tests/extensions.test.ts:515` barrel function + `WorkflowExtensionsSchema.safeParse`; type-level `WorkflowDef.extensions`; README `packages/dual-workflow-engine/README.md:719` |

**Design conformance:** 10/10 claims DONE (WorkflowExtensions + schema + collect signature/order; private Zod helper; JSON `$defs` copy; no auto-load in `config.ts`/`service.ts`; no rule-engine import; stay in `extensions.ts`; README YAML + `absPath` fix; CHANGELOG feat; tests as planned). `config.ts` / `service.ts` / `host.ts` / `package.json` exports untouched.

**SECUA (`--focus all`):** no P1–P3. Path guard is the shared string-level helper (S); collect is a linear map (E); parse-time reject + existing `WorkflowValidationError` wrap (C/U); engine-owned schema, ADR-010 (A). P4 leftover: README Security still says paths are validated at load time (parse time now also rejects); the `dirname` from `node:path` in the README snippet is consumer-doc, not package source.
### Review
Three-dimensional review of the 0062 patch (2026-08-13, inline pipeline driver). Inline stage provenance: stages implement/test executed inline in session `msr4x9h2-uvv8hnn8`.

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P1 | R3 rejection must throw `WorkflowValidationError` from load paths, not a raw zod error | `packages/dual-workflow-engine/tests/config.test.ts` (absolute-path case) | FIXED by construction — `loadWorkflowDefFromText` throws `WorkflowValidationError` wrapping the zod issue; test asserts `/must be relative/` passes |
| P2 | `.strict()` dialect schemas: adding `extensions` must not accidentally relax unknown-top-level rejection | `packages/dual-workflow-engine/src/schema.ts` | FIXED by construction — `extensions: WorkflowExtensionsSchema.optional()` added inside the existing `.strict()` object; new test asserts `initial` still fails with extensions present |
| P2 | JSON schemas are hand-maintained and could drift from the zod dialects | `packages/dual-workflow-engine/schemas/*.schema.json` | ACCEPTED — task scope mandates hand-maintained JSON (no zod-to-JSON generation); new test asserts `properties.extensions` + `$defs.relativeExtensionPath` exist in both |
| P3 | README snippet references `loadWorkflowDefFromText`/`workflowPath` without defining them | `packages/dual-workflow-engine/README.md` (Declaring extensions in YAML) | ACCEPTED — illustrative partial snippet, consistent with the README's existing style |
| P3 | `collectWorkflowExtensions` trusts caller-supplied `sourceName`/`sourceDir` | `packages/dual-workflow-engine/src/extensions.ts` | ACCEPTED — caller-supplied by design (same as rule-engine `collectExtensions`); loader applies the real path guard at load time |
| P4 | No semantic validation of extension paths beyond string level (symlinks) | `packages/dual-workflow-engine/src/schema.ts` | ACCEPTED — ADR-022 symlink confinement stays on the loader's `realPath`, unchanged per task scope |

Residual risk: low. All R1–R5 covered by tests (100 pass / 0 fail on the 3 test files; 1987 pass / 0 fail repo-wide via `bun run spur-check`). No new ADR needed (ADR-010 already assigns schema ownership to each engine).
### References
- Feature C1: `docs/features/C1_workflow-yaml-rule-style-extensions.md` (SSOT for R-titles and scope)
- ADR-010: `docs/00_ADR.md` — engines own kinds/schemas; shared loader + `assertRelativeExtensionPath` live in `@gobing-ai/ts-runtime/extension`
- ADR-016: plugin subpath renamed to `/extension` (same ADR file)
- Rule-engine analog (copy the *pattern*, not the symbols):
  - `packages/rule-engine/src/types.ts` — private `relativeExtensionPath`, `ExtensionsSchema`, `PresetExtensions`
  - `packages/rule-engine/src/config/extensions.ts` — `collectExtensions`
  - `packages/rule-engine/schemas/preset.schema.json` — `$defs.relativeExtensionPath`
- Workflow loader already shipped:
  - `packages/dual-workflow-engine/src/extensions.ts` — `loadWorkflowExtensionsIntoHost`, `WorkflowExtensionRef`
  - `packages/runtime/src/extension/extension-path.ts` — `assertRelativeExtensionPath`
- Prior tasks: 0010 (loader; collect deferred), 0060 C2 (authored `path` + `baseDir`, no basename smash)
- Companion (out of repo): spur-new feature D4 / task 0533 — CLI `validate`/`run` wiring after this package bump
### History
- 2026-08-13T06:48:38.323Z todo → wip (system)
- 2026-08-13T06:50:49.597Z wip → testing (system)
- 2026-08-13T06:51:27.186Z testing → done (system)
