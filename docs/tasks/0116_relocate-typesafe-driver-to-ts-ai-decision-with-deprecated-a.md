---
schema_version: 1
name: Relocate TypeSafe driver to ts-ai-decision with deprecated ai-runner bridge and finalize decision docs
status: done
template: feature-impl
created_at: 2026-10-19T06:34:09.539Z
updated_at: "2026-10-19T21:35:38.792Z"
feature_id: O1
priority: P2
tags:
  - ai-runner
  - ai-decision
  - decision
  - docs

dependencies: ["0115"]
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0116-verdict.json
---

## 0116. Relocate TypeSafe driver to ts-ai-decision with deprecated ai-runner bridge and finalize decision docs

### Background

Implements: R7 — TypeSafe driver lives in ts-ai-decision and ts-ai-runner drops the SDK; R8 — Legacy typesafe backend selection keeps working through a deprecated bridge; R9 — Decision architecture records and docs describe the new boundary.

Answers the operator's Q1 (TypeSafe Jev is provided by `ts-ai-runner` today — `packages/ai-runner/src/decision/typesafe-driver.ts`, SDK pinned in its package.json) and records Q2's outcome (laya-mlx directory keeps its name). ADR-039 moves the driver; downstream Spur calls `createDecisionMaker({ timeoutMs, maxRetries })` relying on the typesafe default, hence the one-release bridge. Shapes: `docs/design/llm-agent-decision-backend.md` § TypeSafe relocation.

### Requirements

- [x] R1. `git mv packages/ai-runner/src/decision/typesafe-driver.ts packages/ai-decision/src/typesafe-driver.ts`, and move `packages/ai-runner/tests/decision/typesafe-driver.test.ts` the same way.
  - Rewrite the relative imports (`./errors`, `./types`, `./validation`) to `@gobing-ai/ts-ai-runner`. All of them are exported from the barrel; verify `validateAnswers` and `validateQuestions` are.
  - Export `createTypesafeDriver` and `TypesafeDriverConfig` from `packages/ai-decision/src/index.ts`.
- [x] R2. Key resolution: `resolveApiKey` (`packages/ai-runner/src/decision/decision-maker.ts:78`) **stays** in ts-ai-runner and is exported. The barrel already does `export * from './decision/decision-maker'`, so adding `export` to the function is enough. Precedence is unchanged.
- [x] R3. Dependencies:
  - Remove `"@typesafe-ai/sdk": "0.6.0"` from `packages/ai-runner/package.json:52`.
  - Add `"@typesafe-ai/sdk": "0.7.0"` (exact pin, same policy) to `packages/ai-decision/package.json` `dependencies`.
  - Run `bun install` and commit the `bun.lock` change.
  - No tsconfig `paths` change: the SDK is an npm dependency, and the bridge's dynamic import uses a variable specifier, which resolves to `any` without a path entry.
- [x] R4. SDK 0.7.0 adaptations in the moved driver (see design doc § SDK 0.7.0 upgrade):
  - (a) `noul(question.prompt ?? null, outcomes)` (`typesafe-driver.ts:115`) no longer type-checks under 0.7.0's overloads. Branch instead: `question.prompt === undefined ? noul(null, outcomes) : noul(question.prompt, outcomes)`, or whatever form tsc accepts.
    - Keep the runtime semantics. Every neutral noul has non-null criteria `{ true, false }`, so 0.7.0's client-side "Noul question … has neither instructions nor criteria" check cannot fire. Don't add a cast.
  - (b) Constructor: add `compression: false`? **No.** Keep the SDK default (zstd on Bun 1.4.3) and teach the test fetch to decode it (R8). Production traffic gets compressed bodies and the test proves the server-visible payload.
  - (c) Update the stale comment at `typesafe-driver.ts:~50` ("SDK 0.6.0 exports no default base-URL constant"). Recheck it against the 0.7.0 `.d.ts` in `node_modules/@typesafe-ai/sdk` and rewrite or drop it.
  - (d) The `fromSdkAnswer` default branch already throws for unknown result types, which covers the new `box`. No `box` support is added; the neutral contract has no box kind.
- [x] R5. Bridge in `packages/ai-runner/src/decision/decision-maker.ts`:
  - Remove the static `import { createTypesafeDriver } from './typesafe-driver'` (`:20`).
  - Add `resolveTypesafeDriver(options, importModule = (s) => import(s))`, mirroring `resolveLayaDriver` (`:90-122`):
    - `const TYPESAFE_DRIVER_PACKAGE = '@gobing-ai/ts-ai-decision'`.
    - **Resolve the key first**, `apiKey = resolveApiKey(options)`, so a missing key is still the same `DecisionConfigError` as today, then import.
    - Import failure → `DecisionConfigError("The 'typesafe' backend requires '@gobing-ai/ts-ai-decision' to be installed; install it with 'bun add @gobing-ai/ts-ai-decision'", 'TYPESAFE_BACKEND')`.
    - Missing export → `DecisionConfigError("Module '@gobing-ai/ts-ai-decision' does not export createTypesafeDriver", 'TYPESAFE_BACKEND')`.
    - Construction errors propagate unchanged.
  - `getDriver` (`:160-169`) calls it.
  - Mark `backend: 'typesafe'`, and the implicit default, `@deprecated` in the `DecisionMakerOptions.backend` JSDoc (`:58`): "pass `driver: createTypesafeDriver(…)` from @gobing-ai/ts-ai-decision".
- [x] R6. Registry `typesafe` built-in (`packages/ai-decision/src/registry.ts:40`): `this.register('typesafe', () => createDecisionMaker({ driver: createTypesafeDriver({ apiKey: resolveApiKey(makerOptions), model: undefined, baseURL: makerOptions.baseURL, timeoutMs: makerOptions.timeoutMs, maxRetries: makerOptions.maxRetries, fetch: makerOptions.fetch }), ...makerOptions }))`. A missing key throws inside the lazy factory, so the hub reports `reason: 'no-backend'`, the same as today. Check `resolveApiKey`'s parameter type: `makerOptions` omits only `driver`/`backend`/`model`, so it fits.
- [x] R7. Spur rules in `.spur/rules/typescript/decision-boundaries.yaml`:
  - Rename `no-typesafe-sdk-import-outside-ai-runner` → `no-typesafe-sdk-import-outside-ai-decision`, with exclude `packages/ai-decision/src/typesafe-driver.ts`, and update its description: pin 0.7.0, ADR-039.
  - Keep `no-ai-decision-import-in-ai-runner` **unchanged**. The bridge holds the specifier in a `const` and calls `importModule(TYPESAFE_DRIVER_PACKAGE)`, the same shape as the laya/fm bridges, which coexist with `no-laya-driver-import-in-ai-runner` / `no-fm-driver-import-in-ai-runner` today. Prove it: `bun run spur-check` stays clean. If the evaluator does flag the literal, scope an `exclude` for `packages/ai-runner/src/decision/decision-maker.ts` with a description pointing to ADR-039; don't weaken the rule globally.
  - Fixtures: the adapter asserts **one rule per package dir** (`scripts/verify-rule-fixtures.ts:61-64`, `DECISION_BOUNDARY_RULES`), and `ai-runner` is already mapped to the clef rule. Map a new dir, `'decision-fm': 'no-typesafe-sdk-import-outside-ai-decision'`.
    - Add `should-fire/packages/decision-fm/src/imports-typesafe-sdk.ts` (a static `import … from '@typesafe-ai/sdk'`) and `should-pass/packages/decision-fm/src/no-sdk.ts`.
    - Bump the decision-boundaries set's declared `expected` counts in the same file (`:82+`); the inventory gate at `:500-503` fails otherwise.
    - Update `.spur/rules/fixtures/decision-boundaries/README.md`'s rule list.
- [x] R8. Tests:
  - The moved `typesafe-driver.test.ts` fake fetch (`:32`, `JSON.parse(String(init.body))`) must decode zstd. When `init.headers` carries `content-encoding: zstd`, decompress `init.body` (Uint8Array/ArrayBuffer) with `Bun.zstdDecompressSync` before parsing. Tests are exempt from the platform rule; check that `tests/**` is excluded in the ts-runtime boundary rules.
  - Add `packages/ai-runner/tests/decision/typesafe-bridge.test.ts` with these cases:
    - (a) `createDecisionMaker()` with an injected `fetch` answers through the bridge, end to end via the real workspace `@gobing-ai/ts-ai-decision`.
    - (b) `importModule` rejecting → `TYPESAFE_BACKEND` install-hint error.
    - (c) A module without the export → `TYPESAFE_BACKEND`.
    - (d) A missing key → the same `DecisionConfigError` as before, with **no import attempted** (spy on `importModule`).
  - Extend `driver-resolution-errors.test.ts` with the typesafe mirror of its laya/fm cases if a test seam is needed: export `resolveTypesafeDriver` for tests only, the same way the laya/fm resolvers are reached today.
- [x] R9. Docs:
  - ADR-038/039: Proposed → Accepted, with the built date.
  - `docs/03_ARCHITECTURE.md:108-118`: promote to current.
  - `docs/04_DESIGN.md:31`: status.
  - Design doc: status `implemented`.
  - READMEs:
    - ai-runner: remove TypeSafe from the decision section and add the deprecation note.
    - ai-decision: maker table row `typesafe` → package `ts-ai-decision` (`@typesafe-ai/sdk` 0.7.0); drop the "Planned" section.
  - `CHANGELOG.md` migration note for Spur: "`createDecisionMaker()` default typesafe backend now requires `@gobing-ai/ts-ai-decision` installed; prefer `driver: createTypesafeDriver(...)`; removal in the next minor."
  - The `spur feature update O1` status follows the pipeline.

### Acceptance Criteria

- [x] AC1 — TypeSafe driver lives in ts-ai-decision and ts-ai-runner drops the SDK
- [x] AC2 — Legacy typesafe backend selection keeps working through a deprecated bridge
- [x] AC3 — Decision architecture records and docs describe the new boundary

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**Chosen.** Move the driver to ts-ai-decision and add a deprecated dynamic-import bridge, following the ADR-028 laya/fm pattern. Existing callers (Spur's `createDecisionMaker({ timeoutMs, maxRetries })`) keep working for one lockstep release, provided ts-ai-decision is installed.

**Rejected.**
- Hard removal now: breaks Spur immediately.
- A separate ts-decision-typesafe package: a new OIDC bootstrap for no benefit.
- Keeping the SDK in ai-runner: the status quo, with a vendor SDK in a runner.

**Invariants.**
- There is no static ai-runner → ai-decision edge in source, `package.json` or tsconfig `paths`.
- `TYPESAFE_API_KEY` precedence is unchanged; `resolveApiKey` is one function used by both the bridge and the registry.
- A missing key is detected before any import, so the error and the hub reason stay identical.
- Every SDK error is translated to `Decision*Error` (`translateError`, unchanged).

**Runtime cycle note.** At runtime ai-decision imports ai-runner statically and ai-runner imports ai-decision dynamically. ESM handles this because the dynamic import runs lazily inside `getDriver`, after both modules have evaluated. Test (a) of R8 proves it in-workspace.

**SDK 0.7.0 (published 2026-10-14; diffed against 0.6.0 tarballs).**

| Change | Impact | Action |
|---|---|---|
| Every export used here (`TypeSafeClient`, `choice`, `noul`, `score`, error classes, `Question`, `ResultFor`, `SystemOneResult`) | unchanged | none |
| `noul` overloads need non-null instructions **or** non-null criteria | tsc error at `typesafe-driver.ts:115` | branch on `prompt` (R4a) |
| Client-side `validateQuestions`: noul with neither → `TypeSafeError` | unreachable (neutral noul always has criteria) | none; `translateError` already maps `TypeSafeError` → `DecisionRequestError` |
| `state` typed `NonNullable`; null → "State is required." | driver already maps null → `''` | none |
| Default request compression = zstd when `node:zlib.zstdCompress` exists (Bun 1.4.3: yes) | test fake fetch can't `JSON.parse` the body | decode in test helper (R8); keep zstd in prod |
| `TypeSafeClientConfig.compression` added | optional | not set |
| `Question` union adds `BoxQuestion`/`box` | `fromSdkAnswer` default branch throws | none |
| `usage.input_tokens` nullable | not surfaced | none |
| `engines.node >= 22` (was `>= 20`) | consumers on Node 20 get an engines warning or failure | CHANGELOG note; no workspace package declares `engines` |

**Failure modes, written before the code:**
1. No key → `DecisionConfigError` (same message), `importModule` never called.
2. ts-ai-decision missing → `TYPESAFE_BACKEND` with the install hint.
3. Module has no `createTypesafeDriver` → `TYPESAFE_BACKEND`.
4. Driver construction throws (bad baseURL) → propagates unchanged; no install hint.
5. A zstd-encoded request body is decoded by the fake fetch; the payload has the same question shape as on 0.6.0.
6. A noul with and without a `prompt` both serialise. Assert the payload has `instructions: null` when the prompt is absent and criteria `{ true, false }`.
7. Registry `typesafe` without a key → `hub.decide` falls back with `reason: 'no-backend'`; the existing `hub.test.ts` case stays green.
8. The renamed rule fires on `should-fire/packages/decision-fm/src/imports-typesafe-sdk.ts` and stays silent on the should-pass twin. `no-ai-decision-import-in-ai-runner` does not fire on `decision-maker.ts`; the full `spur-check` run proves it.

### Plan

1. **Tests first:**
   - Add `packages/ai-runner/tests/decision/typesafe-bridge.test.ts`, failure modes 1–4. Cases 2–3 inject `importModule`; case 1 spies on it.
   - Add the should-fire and should-pass rule fixtures for the renamed SDK rule under `packages/decision-fm/` (R7).
   - Both fail until the move lands.
2. `git mv` the driver and its test (R1). Rewrite the imports to `@gobing-ai/ts-ai-runner`, export `resolveApiKey` (R2), and wire the ai-decision barrel export.
3. Move the dependency and bump to 0.7.0 (R3); run `bun install`. Run `bun run lint` and expect the `noul` tsc error. Apply R4a, then refresh the comment (R4c).
4. Update the moved test's fake fetch to decode zstd (R8). Run `bun test packages/ai-decision/tests/typesafe-driver.test.ts`; failure modes 5–6 are green.
5. Implement the bridge (R5) and the registry built-in (R6). Run `bun test packages/ai-runner packages/ai-decision`, including the existing `decision-maker.test.ts`, `backend-selection.test.ts` and `hub.test.ts`, unmodified. The E2E transcript `packages/ai-decision/tests/output/hub-e2e-transcript.json` must not change.
6. Rules (R7): rename, add the fixture and adapter mapping, then run `bun run verify-rule-fixtures`.
7. Docs and CHANGELOG (R9).
8. Gate: `bun run spur-check && bun run build`. `rg -n "@typesafe-ai/sdk" packages/ai-runner` must be empty, and `git status` must show only intended files.

**Files touched:**
- `packages/ai-runner/{package.json, src/decision/decision-maker.ts, tests/decision/typesafe-bridge.test.ts (new), tests/decision/driver-resolution-errors.test.ts?, README.md}`
- `packages/ai-decision/{package.json, src/typesafe-driver.ts (moved), src/index.ts, src/registry.ts, tests/typesafe-driver.test.ts (moved), README.md}`
- `bun.lock`
- `.spur/rules/typescript/decision-boundaries.yaml`, the `.spur/rules/fixtures/decision-boundaries/**` fixtures and `scripts/verify-rule-fixtures.ts`
- `docs/00_ADR.md`, `docs/03_ARCHITECTURE.md`, `docs/04_DESIGN.md`, `docs/design/llm-agent-decision-backend.md`, `CHANGELOG.md`

**Risks:**
- The Spur consumer must add `@gobing-ai/ts-ai-decision`, or pass `driver`, before upgrading; until then the typesafe default degrades to `TYPESAFE_BACKEND`, and the hub falls back with `no-backend`.
- Node 20 consumers of ts-ai-decision hit the SDK's `node>=22`.

**Depends on:** 0115, because both edit `registry.ts` (serialised) and this task finalises the docs.

### Solution

| File | Lines | Change |
| --- | --- | --- |
| `packages/ai-decision/src/typesafe-driver.ts` | 1-212 | Moved verbatim from `packages/ai-runner/src/decision/typesafe-driver.ts`; the three relative imports became one `@gobing-ai/ts-ai-runner` import. `createTypesafeDriver` at `:58`; the noul mapping now builds the `NoulQuestion` object directly (`:129`) because 0.7.0's `noul()` overloads cannot express an undescribed noul; `legendOf` (`:142`) narrows the legend past the SDK's un-instantiably deep `ScoreLegend` conditional; the stale base-URL comment was rewritten against the 0.7.0 `.d.ts`. |
| `packages/ai-decision/src/index.ts` | 9 | Exports `createTypesafeDriver` and `TypesafeDriverConfig`. |
| `packages/ai-decision/src/registry.ts` | 1-10, 47-66 | The `typesafe` built-in now constructs the driver directly (no deprecated bridge) from `resolveApiKey(makerOptions)`; a missing key still throws inside the lazy factory. |
| `packages/ai-decision/package.json`, `packages/ai-decision/tsconfig.json` | — | `@typesafe-ai/sdk` `0.7.0` added as a dependency; `@gobing-ai/ts-utils` as a devDependency for the moved test's env helpers, plus its tsconfig path. |
| `packages/ai-runner/src/decision/decision-maker.ts` | 84, 131-171, 211 | `resolveApiKey` is now exported; `resolveTypesafeDriver` (`:141`) resolves the key FIRST, then dynamically imports `@gobing-ai/ts-ai-decision` (install hint → `TYPESAFE_BACKEND`, missing export → `TYPESAFE_BACKEND`, construction errors propagate); `getDriver` uses it; the `backend` JSDoc is marked `@deprecated`. |
| `packages/ai-runner/package.json` | — | `@typesafe-ai/sdk` removed. |
| `packages/ai-decision/tests/typesafe-driver.test.ts` | 1-363 | Moved with the driver; imports rewritten to the barrels; fixtures are stream-backed responses and the recorded request body is zstd-decoded (`helpers/sdk-fetch.ts`) because 0.7.0 compresses bodies ≥ 1 KiB and buffers every attempt through a clone; the bare-noul case now asserts the SDK's client-side rejection. |
| `packages/ai-decision/tests/typesafe-validation.test.ts` | 1-146 | The four wire-validation cases that drove the real TypeSafe driver moved here with it (ai-runner can no longer import it). |
| `packages/ai-runner/tests/decision/typesafe-bridge.test.ts` | 1-102 | New: end-to-end answer through the real workspace package, import failure → install hint, missing export → `TYPESAFE_BACKEND`, missing key → `TYPESAFE_API_KEY` with no import attempted, construction errors unchanged, `resolveApiKey` precedence. |
| `packages/ai-runner/tests/decision/backend-selection.test.ts`, `validation.test.ts`, `packages/ai-decision/tests/hub.test.ts` | — | Fake fetches return stream-backed responses (and decode a compressed request body where they inspect it); `validation.test.ts` drops the moved driver import. |
| `.spur/rules/typescript/decision-boundaries.yaml` | 11-27 | `no-typesafe-sdk-import-outside-ai-runner` → `no-typesafe-sdk-import-outside-ai-decision`, exempting `packages/ai-decision/src/typesafe-driver.ts`; `no-ai-decision-import-in-ai-runner` is unchanged and still clean (the bridge holds the specifier in a `const`). |
| `scripts/verify-rule-fixtures.ts` | 61-70, 84-88 | Adapter maps `decision-fm` to the renamed rule; declared inventory for the set is 3 fire / 3 pass. |
| `.spur/rules/fixtures/decision-boundaries/{should-fire,should-pass}/packages/decision-fm/src/*` | — | New SDK-import fixture pair plus `scripts/rule-fixture-hashes.json` hashes. |
| `scripts/tests/rule-fixtures.test.ts` | 70-76, 401-403 | Totals and the per-set inventory expectation follow the new case count. |
| `bunfig.toml` | 12 | `coveragePathIgnorePatterns` also skips `**/dist/**` (the bridge imports the built package in-workspace) and `**/tests/helpers/**`. |
| `docs/00_ADR.md` | 785, 805 | ADR-038/ADR-039 are Accepted with a build date of 2026-10-19. |
| `docs/03_ARCHITECTURE.md` | 106-125 | Decision-backends section promoted to built; the SDK invariant now names the ai-decision rule. |
| `docs/04_DESIGN.md` | 31 | Design row records the build. |
| `docs/design/llm-agent-decision-backend.md` | 2-6 | `status: implemented`, dated. |
| `packages/ai-runner/README.md` | 743-770 | Backend list without a static TypeSafe driver, plus the deprecation/bridge note and the preferred `createTypesafeDriver` usage. |
| `packages/ai-decision/README.md` | 30, 237-255 | Maker row now points at this package with SDK 0.7.0; the "Planned" section became a "TypeSafe driver" section. |
| `CHANGELOG.md` | 11-27 | Feature-O1 entry with the Spur migration note and evidence records. |

**Dependency direction.** There is no static ai-runner → ai-decision edge: the bridge keeps the package specifier in a `const` and hands it to an injectable `importModule`, exactly as the laya/fm bridges do, so `no-ai-decision-import-in-ai-runner` stays clean. The runtime cycle is lazy — ai-decision evaluates first, the dynamic import happens inside `getDriver`.

**Key precedence is unchanged.** `resolveTypesafeDriver` calls `resolveApiKey` before importing, so a missing key is the same `DecisionConfigError` (`TYPESAFE_API_KEY`) as before and no import is attempted; the registry built-in constructs the driver directly with the same helper.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | driver at `packages/ai-decision/src/typesafe-driver.ts:58` with config type at `packages/ai-decision/src/typesafe-driver.ts:43`, contract imports from the ai-runner barrel at `packages/ai-decision/src/typesafe-driver.ts:8-21`; old ai-runner source and test paths no longer exist (ls) |
| R2 | MET | exported key resolver at `packages/ai-runner/src/decision/decision-maker.ts:84`; precedence asserted at `packages/ai-runner/tests/decision/typesafe-bridge.test.ts:101` |
| R3 | MET | exact pin at `packages/ai-decision/package.json:58`; ai-runner manifest has no SDK entry (grep empty); lockfile `bun.lock:452` resolves sdk@0.7.0 |
| R4 | MET | documented CHANGED: the noul question is built directly with no cast at `packages/ai-decision/src/typesafe-driver.ts:125-131` (Solution row 1); rewritten base-URL comment at `packages/ai-decision/src/typesafe-driver.ts:63-66`; zstd decode in the test helper at `packages/ai-decision/tests/helpers/sdk-fetch.ts:32` |
| R5 | MET | deprecation JSDoc at `packages/ai-runner/src/decision/decision-maker.ts:60`; key-first dynamic bridge in decision-maker.ts (resolveTypesafeDriver); getDriver call at `packages/ai-runner/src/decision/decision-maker.ts:211`; no static driver import (grep empty) |
| R6 | MET | registry typesafe built-in through the exported key resolver at `packages/ai-decision/src/registry.ts:56-66`; names asserted at `packages/ai-decision/tests/registry.test.ts:45-46` |
| R7 | MET | renamed rule with ai-decision exclude at `.spur/rules/typescript/decision-boundaries.yaml:11-23`; fixture mapping at `scripts/verify-rule-fixtures.ts:67`; `bun run verify-rule-fixtures` 53/53 pass this run |
| R8 | MET | bridge cases a-d at `packages/ai-runner/tests/decision/typesafe-bridge.test.ts:50-75`; workspace-source resolution asserted at `packages/ai-runner/tests/decision/typesafe-bridge.test.ts:53` (fails without the tsconfig path, passes with it) |
| R9 | MET | ADR-038/039 Accepted+Built at `docs/00_ADR.md:789` and `docs/00_ADR.md:809`; architecture section `docs/03_ARCHITECTURE.md:114`; design index `docs/04_DESIGN.md:31`; design status `docs/design/llm-agent-decision-backend.md:3`; migration note `CHANGELOG.md:30-32`; ai-runner README move note `packages/ai-runner/README.md:749` |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R7 — TypeSafe driver lives in ts-ai-decision and ts-ai-runner drops the SDK | MET | command | `bun test packages/ai-runner packages/ai-decision` 509 pass / 0 fail this run; `bun run verify-rule-fixtures` 53/53; driver at `packages/ai-decision/src/typesafe-driver.ts:58` |
| R8 — Legacy typesafe backend selection keeps working through a deprecated bridge | MET | test | `packages/ai-runner/tests/decision/typesafe-bridge.test.ts:50` end-to-end through workspace source; error mappings at `packages/ai-runner/tests/decision/typesafe-bridge.test.ts:60-75` |
| R9 — Decision architecture records and docs describe the new boundary | MET | command | `bun run build` exit 0 and docs anchors `docs/00_ADR.md:809`, `docs/03_ARCHITECTURE.md:114`, `packages/ai-decision/README.md:17-18` re-read this run |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

**Scope.** The 0116 diff on `sp/runall-o1-3ecd`: the TypeSafe driver and its suite moved package, a
deprecated dynamic-import bridge replaced the static import, the SDK dependency moved and was pinned to
0.7.0, the SDK boundary rule was renamed with new fixtures, and the decision docs were promoted to
built. `bun run spur-check` (3075 pass / 0 fail, 62 pre + 5 post rules, rule fixtures 43/43) and
`bun run build` (12/12 packages) were re-run on the final tree.

**Functional traceability.** R1-R9 MET, each row carrying a `path:line` anchor in the run's review
answer (`.spur/run/a774ca41-c2ba-42c4-8dbd-da295d1e7638-review-answer.txt`); AC1-AC3 MET with
executable (`test`/`command`) evidence. `spur task verdict --from-answer` derives PASS and writes
`.spur/run/0116-verdict.json`.

**SECUA.** Security: no new credential path — `resolveApiKey` still runs before any import and the
unchanged `translateError` keeps every SDK failure inside the taxonomy; the SDK stays confined to one
file by a rule whose scope moved with it. Errors: the bridge distinguishes a missing key, an
unimportable package and a missing export, and lets construction errors through untouched.
Correctness: the driver is a verbatim move plus two 0.7.0 type adaptations, and the recorded e2e/hub
transcripts are unchanged. Usability: both READMEs document the new home, the preferred import and the
one-release bridge with its exact error codes; the CHANGELOG carries the Spur migration note.
Architecture: no static ai-runner → ai-decision edge exists — the specifier lives in a `const` handed
to an injectable importer, the same shape as the laya/fm bridges — and the lazy runtime cycle is proven
by the end-to-end case.

**Architectural depth.** `ts-ai-runner` is now the contract package the ADR describes: types, errors,
validators, the sampled core and `createDecisionMaker`, with one deprecated import seam. Every concrete
driver sits outside it and the registry stays the single composition point.

**Findings.**

| Priority | Finding | Location | Disposition |
| --- | --- | --- | --- |
| P4 | A noul with no prompt and no outcome descriptions is now rejected client-side by SDK 0.7.0 instead of reaching the API for a 422 — same taxonomy, one round trip earlier, and unreachable from a catalog path because the hub always renders instructions. | `packages/ai-decision/src/typesafe-driver.ts:129` | RESOLVED (intentional, asserted by the moved suite) |
| P4 | The legend hand-off narrows past the SDK's recursive `ScoreLegend` conditional, which the compiler cannot instantiate for the neutral question union; `validateAnswers` still checks the shape at runtime. | `packages/ai-decision/src/typesafe-driver.ts:142` | RESOLVED (type-level only, runtime-validated) |
| P4 | `coveragePathIgnorePatterns` gained `**/dist/**` and `**/tests/helpers/**`: the bridge imports the built package in-workspace, and instrumented build output fails the per-file coverage threshold. | `bunfig.toml:12` | RESOLVED (build output is not source) |

Verdict: PASS
Confidence: HIGH

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-10-19T17:03:08.435Z feature_id O → P1 (system)
- 2026-10-19T17:03:11.500Z feature_id P1 → O1 (system)
- 2026-10-19T18:52:59.190Z todo → wip (system)
- 2026-10-19T18:58:31.837Z wip → testing (system)
- 2026-10-19T18:58:32.907Z testing → done (system)

