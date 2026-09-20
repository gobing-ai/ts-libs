---
schema_version: 1
name: Export DecisionMaker from the barrel and document the capability
status: done
template: feature-impl
created_at: 2026-09-20T05:08:59.654Z
updated_at: "2026-09-20T18:10:21.079Z"
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

- [x] R1. `packages/ai-runner/src/index.ts` re-exports `createDecisionMaker`, the
      `DecisionMaker` and `DecisionMakerOptions` types, the `q` builders, `DecisionDriver`, every
      neutral question and answer type, and the `DecisionError` taxonomy.
- [x] R2. The SDK itself and every SDK type stay unexported — nothing vendor-shaped crosses the barrel.
- [x] R3. `packages/ai-runner/README.md` gains a capability section covering: what the surface is for,
      the batch `ask` example with three mixed questions against one state, the single-question sugar
      form, `TYPESAFE_API_KEY` configuration and the injected-`env` alternative, the error taxonomy,
      and a note that the yes/no answer carries no confidence because the API reports none.
- [x] R4. The README states that additional backend drivers are the intended extension point and that a
      driver implements only `ask`.
- [x] R5. Every code sample in the README typechecks against the shipped types.
- [x] R6. `docs/04_DESIGN.md` moves the `DecisionMaker` row from `planned` to `current` with the
      frontmatter version and `updated_at` bumped per `docs/99_PROJECT_CONSTITUTION.md` §6.5.
- [x] R7. `bun run spur-check` and `bun run build` both pass, and `spur feature check A2` reports no
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

Change-map for commits 2bce32c + 7a40f849 (implement hop + review P3 fix; spur-check clean, 2310 pass / 0 fail):

| Change (`file:line`) | What |
|----------------------|------|
| `packages/ai-runner/src/index.ts:6` | Barrel already re-exported decision surface (0070/0071); verified complete, no vendor leak (consumer probes → TS2305 for SDK names) |
| `packages/ai-runner/README.md:734` | Decision Making capability section: batch ask + sugar + key config/env alternative + taxonomy table + no-confidence note; drivers-are-the-extension-point (`ask`-only contract) |
| `packages/ai-runner/README.md:749,792` | 7a40f849: `state`/`key` declared in-sample → verbatim extraction compiles --strict vs built dist |
| `docs/04_DESIGN.md:5` | DecisionMaker planned→current, v1.3.0, updated_at 2026-09-20 (§6.5) |
| `docs/design/decision-maker.md:180` | 0071-owed doc fix: ConfigError snippet → real two-arg signature |

README sample typecheck method: whole-section verbatim extractor → bunx tsc --noEmit --strict against packages/ai-runner/dist/index.d.ts — PASS.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/ai-runner/src/index.ts:6-8` — barrel re-exports `./decision/decision-maker` (createDecisionMaker, DecisionMaker, DecisionMakerOptions), `./decision/errors` (full DecisionError taxonomy), `./decision/types` (q builders, DecisionDriver, every neutral question/answer type) |
| R2 | MET | grep over built declarations `dist/index.d.ts` + `dist/decision/{decision-maker,types,errors}.d.ts` for TypeSafeClient/SystemOne/ChoiceResponse/ScoreResponse/NoulResponse/TypeSafeError/APIError/@typesafe-ai → zero vendor exports (one TSDoc comment mention in types.d.ts:3 only); typesafe-driver.ts deliberately not re-exported |
| R3 | MET | `packages/ai-runner/README.md:734-811` `## Decision Making` — purpose (:736), batch `ask` with three mixed questions against one state (:744-763), single-question sugar (:765-778), `TYPESAFE_API_KEY` config + injected-`env` alternative (:789-795), error taxonomy table (:801-811), no-confidence note (:777, :780-781) |
| R4 | MET | `README.md:814-816` 'Adding a backend driver' — "Additional backend drivers are the intended extension point. A driver implements only `ask`" + custom-driver sample (:818-831) |
| R5 | MET | Whole-section verbatim extraction of all 4 ts blocks + `bunx tsc --ignoreConfig --noEmit --strict --module esnext --moduleResolution bundler --target es2022` against the built dist → exit 0 (this run). Fixed first under --fix all: two `const decisions` redeclarations (README.md:794→`explicit`, :831→`custom`) left over by 7a40f849; baseline failed TS2451 ×3, post-fix compiles clean |
| R6 | MET | `docs/04_DESIGN.md:25` — DecisionMaker row reads `current` linking `design/decision-maker.md`; frontmatter `version: 1.3.0` (:6), `updated_at: 2026-09-20` (:9) per §6.5 |
| R7 | MET | `bun run spur-check` exit 0 — Biome + per-package tsc + 2310 tests pass / 0 fail (199 files, coverage gate) + both spur rule presets `--fail-on warning` clean (this run); `bun run build` exit 0 all packages (this run); `spur feature check A2` orphan-scenario result recorded in the batch shippable gate |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R11 — the capability is exported from the barrel and documented | MET | command | Barrel reachability: `src/index.ts:6-8` exports factory/builders/neutral types/error taxonomy; declaration grep proves no @typesafe-ai/sdk type/class/error crosses (R2 evidence); README documents batch form, sugar form, key configuration, and the no-confidence yes/no answer (:734-811) and names additional backend drivers as the extension point (:816); README samples compile strict against built dist (R5 evidence) |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0073

**Scope:** commit 2bce32c — `packages/ai-runner/README.md` Decision Making section; `docs/04_DESIGN.md` planned→current + frontmatter; `docs/design/decision-maker.md:180` two-arg fix; barrel verified-not-edited
**Dimensions:** functional, security, correctness, usability, architecture
**Verdict:** PASS — no P1/P2; one P3 recorded (non-blocking per gate semantics)

##### Findings (ranked)

| # | Priority | Dimension | Finding | Location |
|---|----------|-----------|---------|----------|
| 1 | P3 (minor) | correctness / usability | The sugar and config snippets use `state` and `key` but neither identifier is introduced anywhere in the section; a verbatim whole-section extraction fails `tsc` (2× TS2304 `state`, 2× TS2304 `key`; the 3× `const decisions` redeclare is house style — `runner` is likewise declared 3× across earlier sections — and is not counted). The task's "samples extracted verbatim … PASS" claim is therefore not reproducible as stated. The API shapes themselves are honest: with the two identifiers declared, every snippet typechecks clean against dist | `packages/ai-runner/README.md:773,779,792-793` |
| 2 | P4 (advisory) | architecture | Prose says "a driver implements only `ask`"; the `DecisionDriver` contract is `{ name, ask }`. The sample correctly shows `name: 'my-backend'`, the prose omits the field | `packages/ai-runner/README.md:812-824`; `packages/ai-runner/src/decision/types.ts` (`DecisionDriver`) |
| 3 | P4 (advisory) | correctness | Design-doc snippet message `'Missing TYPESAFE_API_KEY'` is a shortened paraphrase of the shipped string ("Missing TYPESAFE_API_KEY — set it in the environment or pass options.apiKey."); the two-arg `(message, variable)` signature — the actual 0071-review P4 — is now correct | `docs/design/decision-maker.md:180`; `packages/ai-runner/src/decision/decision-maker.ts:60-64` |

##### Functional Traceability

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | barrel `export *` from the three decision modules (`packages/ai-runner/src/index.ts:8-10`, mirrored in `dist/index.d.ts`); fresh consumer probe: `createDecisionMaker`, `q`, `DecisionMaker`/`DecisionMakerOptions`, `DecisionDriver`, every neutral question/answer type + `Answer(s)For`, `DecisionError` + all 7 subclasses resolve from `@gobing-ai/ts-ai-runner` with correct shapes (tsc clean vs fresh dist) |
| R2 | MET | negative probe: importing `createTypesafeDriver` / `TypeSafeClient` / `TypesafeDriverConfig` from the barrel → TS2305 ×3; grep of the reachable dist chain (`index`/`decision-maker`/`errors`/`types` .d.ts) finds `@typesafe-ai` only inside a prose comment (`dist/decision/types.d.ts:3`); `typesafe-driver` is unreferenced from `dist/index.d.ts` |
| R3 | MET | batch `ask` with three mixed questions on one shared state leads; single-question sugar; `TYPESAFE_API_KEY` + injected-`env` config; error taxonomy table; yes/no-carries-no-confidence note; What-It-Provides table row added |
| R4 | MET | "Adding a backend driver" section present; driver sample typechecks against the real contract (P4 #2 wording nit) |
| R5 | PARTIAL | sample symbols all real and correctly typed (shimmed extraction clean), but verbatim extraction fails on the never-introduced `state`/`key` (P3 #1) |
| R6 | MET | `DecisionMaker` row planned→current; frontmatter 1.2.0→1.3.0, `updated_at` 2026-09-20; §6.5 same-change rule honored — satellite (`decision-maker.md`) and index row in one commit |
| R7 | MET | fresh this review: `bun run build` 8 packages exit 0; `bun run spur-check` 2310 pass / 0 fail; `spur feature check A2` PASS — R11 linked, no orphan scenarios (WARN is the expected pre-verdict state) |
| R11 | MET | all four AC Then-clauses verified by the probes and evidence above |

##### Per-dimension verdicts

- **Functional:** PASS except R5 PARTIAL (P3 #1, non-blocking).
- **SECUA:** PASS. Vendor-leak proof re-verified at the consumer boundary (fresh neg probe + dist-chain grep). Taxonomy table matches `errors.ts` field-for-field (variable / status / status+retryAfterMs / timeoutMs / cause / status+bodySummary / status). Injected-env example matches `DecisionMakerOptions.env` (`Record<string, string | undefined>`) and the `resolveApiKey` order apiKey→env→process env. The `{ driver }` sample comment "no TYPESAFE_API_KEY required" is honest — a caller-supplied driver short-circuits before key resolution (`decision-maker.ts` `resolveDriver`).
- **Architecture:** PASS. Docs authority order respected — 04 stays a derived pointer+status index; `decision-maker.md` is the signature SSOT and its :180 fix matches the implemented two-arg `DecisionConfigError(message, variable)` (`errors.ts`). Extension-point claim matches the `DecisionDriver` contract (one method + `name` tag). Scope is exactly the 4 committed files — zero 0070–0072 source files, barrel untouched and verified complete as landed in 0070/0071.

**Next:** two-line README fix — bind `state` in the batch snippet (hoist the inline object) and show the `key` binding in the config snippet — then R5 is fully MET; soften the Testing claim from "extracted verbatim" to match reality. Pipeline gate not blocked.

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-20T08:25:21.007Z todo → wip (system)
- 2026-09-20T09:21:03.145Z wip → testing (system)
- 2026-09-20T09:21:03.497Z testing → done (system)

