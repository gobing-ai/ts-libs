---
schema_version: 1
name: Implement the hosted Clef DecisionDriver package
status: done
template: feature-impl
created_at: 2026-10-09T18:32:28.066Z
updated_at: "2026-10-09T21:33:34.553Z"
feature_id: A3
priority: P2
tags:
  - clef
  - decision
  - cloudflare
estimate_hours: 8

done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0108-verdict.json
---

## 0108. Implement the hosted Clef DecisionDriver package

### Background

Deliver @gobing-ai/ts-decision-clef from packages/decision-clef as the hosted REST adapter specified by ADR-037 and docs/design/decision-clef-backend.md. Implements all feature scenarios:

- R1 — Consumers import the lockstep Clef driver package
- R2 — Model selection uses matching Clef routes and body selectors
- R3 — DecisionMaker preserves typed batch answers and probabilities
- R4 — Invalid requests and malformed responses fail at the driver boundary
- R5 — Configuration and transport failures use the decision error taxonomy
- R6 — Applications compose the backend without changing existing defaults

Verified premises: DecisionDriver exists at packages/ai-runner/src/decision/types.ts:104, shared validators at packages/ai-runner/src/decision/validation.ts:26 and :73, APIClient.rawRequest at packages/infra/src/api-client.ts:341, and custom registry registration at packages/ai-decision/src/registry.ts:48. Primary sources and transport alternatives are captured in docs/plans/2026-10-09-decision-clef-brainstorm.md.

**Refine corrections (2026-10-09)**

- Response model identity: the hosted output schemas require a model string but do not specify its spelling. Require a nonempty string; do not reject a valid answer merely because the echo differs from the request's short selector. Endpoint and request-body selectors still match exactly.
- Registry observability: the new package's registry test imports ts-ai-decision, so declare it as a workspace:* devDependency and include its source closure in test typechecking. Do not add it as a runtime dependency or change the registry built-ins.
- Serialization: shared question validation does not validate state, and JSON.stringify alone silently coerces nonfinite values or drops undefined/functions. The Clef adapter must reject invalid JSON values before transport rather than altering the neutral validators for other backends.
- Verification: tests inject fetch into the real APIClient; mocking APIClient.rawRequest would not exercise timeout, redirect, headers or response-size behavior. Preserve prototype-looking question names with Object.fromEntries or a null-prototype record.
- Environment/scope: Bun 1.3.14 is installed, the workspace is at 0.5.19, and packages/decision-clef is absent. Existing uncommitted A3 planning files belong to this feature and must be preserved. Resolve current version and task status again at implementation start.

### Requirements

- [x] R1. Add the lockstep package with createClefDriver, ClefDriverOptions and ClefModel exports; standard manifest, TypeScript configs, transitive paths, ESM build, README/legal files and Bun lock wiring.
- [x] R2. Use APIClient.rawRequest with explicit accountId/apiToken, default clef-flash and configured/per-call clef selection; match endpoint model and body model; no import-time HTTP or environment discovery.
- [x] R3. Map neutral choice/score/noul questions and the success/result REST envelope into typed answers. Preserve distributions, confidence, legends, fractional scores and bare noul probability; all facade convenience methods work.
- [x] R4. Export/reuse existing ai-runner validators and enforce hosted limits, valid IDs, instructions fallback, JSON-serializable state and request/response caps. Reject malformed responses and correspondence failures. Enforce JSON values without lossy coercion; reject cycles, nonfinite numbers, undefined/functions/BigInt and non-JSON object instances. Accept a nonempty response model string without assuming an exact spelling.
- [x] R5. Map configuration, auth, rate-limit including Retry-After, request, backend, timeout and connection errors to existing decision classes; redact credentials/state/untrusted upstream text and never fabricate answers.
- [x] R6. Preserve one-way dependencies and current backend/registry defaults; add decision boundary rules/fixtures, test explicit custom maker registration with ts-ai-decision as a workspace:* devDependency and test source paths, and document usage, provider constraints and new-package bootstrap.
- [x] R7. Complete offline behavior tests, bun run spur-check and bun run build without skipped tests or suppressions; update package export/shared validation docs and actual package indexes and verify only intentional changes.

### Acceptance Criteria

- [x] AC1 — Consumers import the lockstep Clef driver package
- [x] AC2 — Model selection uses matching Clef routes and body selectors
- [x] AC3 — DecisionMaker preserves typed batch answers and probabilities
- [x] AC4 — Invalid requests and malformed responses fail at the driver boundary
- [x] AC5 — Configuration and transport failures use the decision error taxonomy
- [x] AC6 — Applications compose the backend without changing existing defaults

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-09T18:47:42.057Z

- Transport: Workers AI REST via APIClient; explicit consumer credentials. Binding transport and local GPU hosting are outside this task.
- Models: default clef-flash, factory model overridden by ask.model; only short request selectors. The response model must be nonempty, with no exact echo requirement because the published schemas do not guarantee one.
- Validation: export existing validators, add Clef-local state/provider checks, and preserve other backends' behavior. Lossy JSON input rejects before HTTP.
- Integration: consumers explicitly inject/register Clef. Test-only ai-decision dependency enables a real registry/hub test without bundling Clef into the registry.
- Delivery: canonical workspace gates and build; no live credentials or publication are required. No open question remains.

### Design

Use the existing DecisionDriver seam and APIClient rather than an SDK or a second transport. Full contract: docs/design/decision-clef-backend.md; cross-package decision: ADR-037.

Signatures: createClefDriver(options: ClefDriverOptions): DecisionDriver; model union clef | clef-flash; accountId and apiToken required, model/timeoutMs/fetch optional. Expose existing validateQuestions and validateAnswers from the ai-runner main barrel. Implement package-local wire mapping and error translation; no new provider-neutral schema.

Dependencies: ts-decision-clef -> ts-ai-runner and ts-infra via workspace:*. Copy the actual transitive paths closure used by sibling drivers, plus infra. ai-runner never imports Clef; ai-decision gains no built-in or dependency. No platform exception or workflow change.

Rejected alternatives: REST plus Worker binding adds a second transport; local joint-head hosting requires GPU/Python provisioning; external TypeSafe SDK reuse violates its boundary.

Decisions are settled: explicit credentials, fixed Cloudflare origin, clef-flash default, per-call short model override, provider-required prompt fallback to question ID, no automatic retries, scalar fractional score preservation, generic redacted errors. Invariants: one request per ask, exact answer names, provider probabilities preserved and neutral validation reused.

Scope: packages/decision-clef; ai-runner validator barrel/tests/docs; decision rule/fixture files; bun.lock; root README/AGENTS and relevant design/package docs. No release or publication, no unrelated fixes. Budget: 8h, one cohesive diff; persist partial evidence if an external blocker appears. Implementation requireDiff: true.

Implementation details frozen by the ready audit:

- Files: packages/decision-clef/src/index.ts and driver.ts; tests/driver.test.ts and registry.test.ts; package.json, tsconfig.json and tsconfig.build.json. Shared validator bodies stay in packages/ai-runner/src/decision/validation.ts; export their existing functions from src/index.ts. Existing facade and TypeSafe driver callers retain behavior.
- Runtime dependencies: ts-ai-runner and ts-infra. Test-only dependency: ts-ai-decision plus the same Bun types convention as sibling packages. Typecheck paths cover ai-runner, infra, ai-decision, decision-fm, laya-mlx, runtime (including /bun-sqlite), db (including /bun-sqlite and /inbox), and utils as reached by current sources. Build config clears paths and uses rootDir src, just like decision-fm; the builder already discovers packages/* and orders runtime/dev workspace dependencies.
- Before JSON.stringify, recursively accept null, strings, booleans, finite numbers, dense arrays and plain/null-prototype JSON objects. Reject cycles, undefined, functions, symbols, BigInt, sparse arrays and custom object instances such as Date with DecisionRequestError. Validate the mapped request as well as state so an unserializable description cannot be silently coerced. Use TextEncoder byte length for the 13 MiB request limit. The 8 MiB response cap is our fixed adapter policy, not a claimed provider limit.
- A response model is a required nonempty string, not a guaranteed echo of clef/clef-flash. Preserve answer contents and validate correspondence; model/usage are not exposed. This overrides the earlier exact-response-model assumption in the first design draft.
- Preserve all legal question/option IDs including __proto__ through safe own-property mapping (Object.fromEntries or null-prototype records); never assign them into an ordinary object by index. Generic adapter errors carry category/status/configuration field only, with no raw body, transport cause, token or state.
- Timeout classification is APIError with status 0 from the real APIClient; other rawRequest failures are connection errors. Parse JSON after transport in a separate error boundary so SyntaxError becomes a backend error. For Retry-After: finite nonnegative numeric seconds convert to milliseconds; otherwise accept a valid HTTP date, clamped at zero against Date.now(); invalid/missing stays undefined.

### Plan

1. Precondition (R1, R6, R7): re-read the task/feature/design and current git status. Resolve the current root version, Bun version and dependency source closure. Preserve the existing A3 planning changes; confirm no new implementation/concurrent edits change these premises.
2. Package and seam (R1, R2, R6): scaffold the standard package at the current lockstep version, runtime/test dependencies and path configs; expose the existing validators from ai-runner. Use the existing discovery/build ordering and ESM fix step, not a new builder.
3. Driver (R2–R5): implement configuration, provider limits, lossless JSON checks, safe question mapping, one APIClient.rawRequest batch and matching endpoint/body model. Decode envelope and map answers; preserve fractional scores and probabilities. Separate transport, decode and shared validation error boundaries.
4. Behavior tests (R2–R5): packages/decision-clef/tests/driver.test.ts injects fetch into the real APIClient and uses actual Response objects. Assert one request, model precedence/routes/auth, all three types and convenience methods, null/empty prompt fallback, valid limit endpoints and invalid limit+1, cyclic/lossy JSON before fetch, UTF-8 body cap, malformed/missing/extra answer keys, bad probability mass and bounded fractional scores. Include __proto__ IDs, mismatched but nonempty response model spelling, truncated bodies, 401/403/429/400/500, redirects, malformed JSON/failed envelope, redaction and no fabricated answers. The timeout mock must wait for opts.signal abort and reject DOMException AbortError; exercise numeric/date/invalid Retry-After without a server.
5. Composition and rules (R1, R6): packages/decision-clef/tests/registry.test.ts uses the real DecisionMakerRegistry and DecisionHub with a custom lazy clef maker and injected fetch, proving lazy memoization/routing and unchanged built-in names. Keep ts-ai-decision test-only. Extend .spur/rules/typescript/decision-boundaries.yaml with no-clef-driver-import-in-ai-runner and no-ai-decision-import-in-decision-clef following the current forbidden-import pattern; add focused should-fire/should-pass fixtures and verify they exercise the evaluator. Check manifests for the runtime dependency direction as imports alone do not inspect dependency declarations.
6. Documentation and finish (R1, R6, R7): add README/legal files and built package indices, validator export usage docs and design status. Point new-package bootstrap to docs/PACKAGE_RELEASE.md:125; do not publish, tag or change GitHub Actions. Run targeted behavior/rule checks during implementation, then bun run spur-check and bun run build; inspect the intentional diff and persist verification evidence.

Sizing remains one cohesive 8h implementation task; priority P2. There are no prerequisite tasks or open design questions. This refinement changes the specification only; execution-owned Solution, Testing and Review remain untouched.

### Solution

Change-map (auto-generated — implement step did not record a Solution).
Each entry cites the first changed line per file (`file:line`).

| Change (`file:line`) |
|----------------------|
| `AGENTS.md:22` |
| `README.md:37` |
| `README.md:58` |
| `README.md:62` |
| `README.md:78` |
| `docs/00_ADR.md:742` |
| `docs/01_PRD.md:36` |
| `docs/02_ROADMAP.md:24` |
| `docs/03_ARCHITECTURE.md:17` |
| `docs/03_ARCHITECTURE.md:33` |
| `docs/04_DESIGN.md:30` |
| `docs/05_FEATURES.md:26` |
| `docs/PACKAGE_RELEASE.md:203` |
| `docs/PACKAGE_RELEASE.md:48` |
| `docs/PACKAGE_RELEASE.md:53` |
| `docs/PACKAGE_RELEASE.md:55` |
| `docs/PACKAGE_RELEASE.md:62` |
| `docs/design/decision-clef-backend.md:11` |
| `docs/design/decision-clef-backend.md:3` |
| `docs/features/A3_cloudflare-clef-decision-backend-in-ts-decision-clef.md:105` |
| `docs/features/A3_cloudflare-clef-decision-backend-in-ts-decision-clef.md:111` |
| `docs/features/A3_cloudflare-clef-decision-backend-in-ts-decision-clef.md:5` |
| `docs/features/A3_cloudflare-clef-decision-backend-in-ts-decision-clef.md:9` |
| `docs/features/INDEX.md:7` |
| `package.json:3` |
| `packages/ai-decision/package.json:3` |
| `packages/ai-runner/README.md:835` |
| `packages/ai-runner/package.json:3` |
| `packages/ai-runner/src/index.ts:9` |
| `packages/ai-runner/src/quota.ts:105` |
| `packages/ai-runner/src/quota.ts:110` |
| `packages/ai-runner/src/quota.ts:125` |
| `packages/ai-runner/src/quota.ts:77` |
| `packages/ai-runner/src/quota.ts:88` |
| `packages/ai-runner/tests/decision/validation.test.ts:317` |
| `packages/ai-runner/tests/quota.test.ts:98` |
| `packages/browser-automation/package.json:3` |
| `packages/db/package.json:3` |
| `packages/decision-clef/LICENSE:1` |
| `packages/decision-clef/NOTICE:1` |
| `packages/decision-clef/README.md:1` |
| `packages/decision-clef/package.json:1` |
| `packages/decision-clef/src/driver.ts:1` |
| `packages/decision-clef/src/index.ts:1` |
| `packages/decision-clef/tests/driver.test.ts:1` |
| `packages/decision-clef/tests/registry.test.ts:1` |
| `packages/decision-clef/tsconfig.build.json:1` |
| `packages/decision-clef/tsconfig.json:1` |
| `packages/decision-fm/package.json:3` |
| `packages/dual-workflow-engine/package.json:3` |
| `packages/infra/package.json:3` |
| `packages/laya-mlx/package.json:3` |
| `packages/llm-jsonl-importer/package.json:3` |
| `packages/llm-jsonl-importer/src/schema-sql.ts:7` |
| `packages/llm-jsonl-importer/tests/schema-version.test.ts:46` |
| `packages/rule-engine/package.json:3` |
| `packages/runtime/package.json:3` |
| `packages/utils/package.json:3` |
| `scripts/README.md:10` |
| `scripts/README.md:31` |
| `scripts/builder.ts:104` |
| `scripts/builder.ts:111` |
| `scripts/builder.ts:116` |
| `scripts/builder.ts:118` |
| `scripts/builder.ts:26` |
| `scripts/builder.ts:3` |
| `scripts/builder.ts:92` |
| `scripts/builder.ts:95` |
| `scripts/builder.ts:98` |
| `scripts/lib/release-commands.ts:269` |
| `scripts/lib/release-commands.ts:273` |
| `scripts/lib/release-commands.ts:302` |
| `scripts/lib/release-commands.ts:370` |
| `scripts/lib/release-commands.ts:391` |
| `scripts/lib/release-commands.ts:403` |
| `scripts/tests/release-commands.test.ts:301` |
| `scripts/tests/release-commands.test.ts:39` |
| `scripts/tests/release-commands.test.ts:496` |

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | packages/decision-clef/package.json:2-3 (name + 0.5.20, matching the 14-manifest lockstep); src/index.ts:1-2 exports createClefDriver/ClefDriverOptions/ClefModel; tsconfig.json transitive path closure; tsconfig.build.json (paths {}, rootDir src, outDir dist); dist/index.js carries the fixed ESM .js specifier; gate log shows the package typecheck exit 0 |
| R2 | MET | driver.ts:205 one APIClient on the fixed Cloudflare origin; zero process.env in src/**; driver.ts:223 model ?? configuredModel; driver.ts:292 endpoint path derived from the same resolvedModel; driver.ts:295-302 rawRequest POST with Authorization: Bearer, redirect manual and maxResponseBytes; src/quota.ts is the only ai-runner file main touched and it is not on this path |
| R3 | MET | driver.ts:103-111 instructions fallback to the question ID; driver.ts:113-141 choice/score/noul mapping via Object.fromEntries; driver.ts:366-438 envelope to typed answers on a null-prototype record; validateAnswers at driver.ts:438; tests/driver.test.ts:229-287 mixed kinds with fractional score and a bare noul probability; tests/driver.test.ts:288-316 __proto__ IDs end to end; facade sugar at :790+ |
| R4 | MET | packages/ai-runner/src/index.ts:9 re-exports the shared validators (seam blob-identical); limits driver.ts:226, :235, :245-260, :263; strict JSON gate driver.ts:53-101 with driver.ts:272 (state) and driver.ts:284 (mapped body); UTF-8 13 MiB cap driver.ts:286-289; decode/envelope driver.ts:342-438; nonempty model without echo requirement driver.ts:358-360; tests/driver.test.ts:338-509, :512-535, :536-553, :721-775 |
| R5 | MET | driver.ts:316-339 taxonomy (401/403 Auth, 429 RateLimit + parsed Retry-After, 400/404 Request, 5xx/3xx/other Backend, APIError status 0 Timeout at :306-308, other transport Connection at :309); parseRetryAfter driver.ts:154-168; redaction: generic messages, bodySummary undefined at driver.ts:331, no cause; tests/driver.test.ts:554-630, :631-646, :647-657, :658-719, :777-787; 14 invalid option shapes (12 in the badOptions table plus 2 in the per-field loop) all raise DecisionConfigError |
| R6 | MET | packages/ai-runner/package.json names no clef token; packages/decision-clef/src/** imports no @gobing-ai/ts-ai-decision (only tests/registry.test.ts, package.json:58 devDependency, tsconfig.json test path); rules .spur/rules/typescript/decision-boundaries.yaml:130,142,154 cover the reverse-import, catalog-import and ai-runner-manifest halves with should-fire/should-pass fixtures; tests/registry.test.ts:61-161 proves lazy memoisation, hub routing and unchanged built-in names; docs updated (package README, ai-runner README, docs/00_ADR.md, docs/03_ARCHITECTURE.md, docs/04_DESIGN.md, README.md, AGENTS.md) |
| R7 | MET | rebased-tree gate: 61 pre-check rules passed, 2914 pass / 0 fail / 238 files, 3 post-check rules passed (coverage-gate, every-export-has-tsdoc, and verify-confidence-level which validates this very verdict artifact); bun run build 13/13 exit 0; driver.ts 100 percent funcs / 98.22 percent lines with 6 uncovered lines (99,100,140,149,161,339); no .skip, .todo, .only, biome-ignore or eslint-disable in the package or the ai-runner validator test |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R1 — Consumers import the lockstep Clef driver package | MET | command | package.json:2-3 at 0.5.20 with exports/files/LICENSE/NOTICE; dist/index.js and dist/index.d.ts built; every new-package typecheck exit 0 in the gate log; the usage import shown at README.md:19-20 |
| R2 — Model selection uses matching Clef routes and body selectors | MET | test | tests/driver.test.ts:180-226: default route and body both clef-flash, configured clef, per-call override, invalid selector rejected with zero fetches, one request per ask |
| R3 — DecisionMaker preserves typed batch answers and probabilities | MET | test | tests/driver.test.ts:229-287 mixed-kind batch preserving fractional score, confidence, legend and bare noul probability; facade sugar :790+; correspondence enforced by validateAnswers at driver.ts:438 |
| R4 — Invalid requests and malformed responses fail at the driver boundary | MET | test | pre-transport rejections with zero fetches for question counts, option counts, empty option IDs, score levels, bad IDs, cyclic/sparse/symbol/decorated/non-enumerable/BigInt/Date/NaN/Infinity state, unserializable descriptions and an oversize body (tests/driver.test.ts:338-509); malformed JSON, failed envelope, missing result, empty model, absent or non-object answers, malformed choice/score bodies, wrong names, unnormalized mass and unknown kind all raise DecisionBackendError (:536-553, :721-775) |
| R5 — Configuration and transport failures use the decision error taxonomy | MET | test | config: tests/driver.test.ts:119-172; HTTP matrix :554-574; Retry-After numeric/date/invalid :575-630; timeout through the real APIClient with AbortSignal :631-646; connection :647-657; redaction including an undefined cause :658-719 |
| R6 — Applications compose the backend without changing existing defaults | MET | test | tests/registry.test.ts:61-161: a lazy custom clef-hosted factory memoised exactly once, hub routing and declared fallback untouched, registry names unchanged as built-ins then plus the registration, and no built-in clef maker |
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

- 2026-10-09T18:54:36.667Z todo → wip (system)
- 2026-10-09T20:28:56.633Z wip → testing (system)
- 2026-10-09T20:29:45.789Z testing → done (system)

