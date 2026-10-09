---
schema_version: 1
name: Implement the hosted Clef DecisionDriver package
status: done
template: feature-impl
created_at: 2026-10-09T18:32:28.066Z
updated_at: "2026-10-09T21:59:41.859Z"
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

**Verification fixes (2026-10-09)**

- `packages/decision-clef/src/driver.ts:71` rejects accessors, symbol and hidden array properties before transport. Recursive serialization errors retain the state/request category without key paths.
- `packages/decision-clef/src/driver.ts:165` rejects Retry-After millisecond overflow and numeric non-date hints.
- `packages/decision-clef/src/driver.ts:225` redacts invalid request identifiers; `packages/decision-clef/src/driver.ts:382` reports malformed backend answers without upstream names. Shared validator bodies remain unchanged.
- `packages/decision-clef/tests/driver.test.ts:450`, `packages/decision-clef/tests/driver.test.ts:628` and `packages/decision-clef/tests/driver.test.ts:697` exercise lossy arrays/accessors, invalid/overflow retry hints and identifier leakage.

- `packages/decision-clef/src/driver.ts:445` translates shared answer-validation failures into a generic backend error while retaining HTTP status, preventing requested IDs from leaking on invalid probabilities.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/decision-clef/package.json:2` names the lockstep package; `packages/decision-clef/src/index.ts:1` exports the factory/options/model. Fresh build and built ESM import passed; 14 workspace manifests share the root version. Evidence: @gobing-ai/ts-libs `.spur/run/0108-verify-package.log` line 1. |
| R2 | MET | `packages/decision-clef/src/driver.ts:216` constructs the fixed-origin APIClient; `packages/decision-clef/src/driver.ts:307` uses the resolved model for the route and rawRequest. `packages/decision-clef/tests/driver.test.ts:180` covers default/configured/per-call model, Authorization and one request per ask; these tests passed in the fresh full suite. |
| R3 | MET | `packages/decision-clef/tests/driver.test.ts:229` verifies mixed choice/score/noul mapping, fractional scores and provider probabilities; `packages/decision-clef/tests/driver.test.ts:288` verifies prototype-looking IDs; `packages/decision-clef/tests/driver.test.ts:859` covers all facade convenience methods. Full suite passed. |
| R4 | MET | `packages/ai-runner/src/index.ts:9` exports the unchanged validators; `packages/ai-runner/tests/decision/validation.test.ts:318` exercises public exports. `packages/decision-clef/src/driver.ts:71` rejects accessors and lossy array properties; `packages/decision-clef/tests/driver.test.ts:435` exercises invalid state, limits and body bounds; malformed responses and correspondence tests also passed. |
| R5 | MET | `packages/decision-clef/src/driver.ts:165` handles finite Retry-After milliseconds; `packages/decision-clef/src/driver.ts:318` separates timeout/connection from HTTP taxonomy. `packages/decision-clef/tests/driver.test.ts:628` exercises invalid/overflow retry hints; `packages/decision-clef/tests/driver.test.ts:697` proves state/request/upstream identifier redaction; shared answer-validation failures are redacted at packages/decision-clef/src/driver.ts:445; existing auth, HTTP, timeout and connection tests passed. |
| R6 | MET | `packages/decision-clef/tests/registry.test.ts:61` proves lazy custom registration, memoization and hub routing; `packages/decision-clef/tests/registry.test.ts:96` proves unchanged built-ins. `.spur/rules/typescript/decision-boundaries.yaml:130` defines the new directions. Six evaluator positive/negative controls passed, including the manifest rule, and the package dependency check passed. Evidence: @gobing-ai/ts-libs `.spur/run/0108-verify-rules-before.json` lines 1-50. |
| R7 | MET | Fresh bun run spur-check: 2915 tests passed, zero failed, 61 pre-check and 3 post-check rules passed. Fresh workspace build succeeded. Driver coverage: 100 percent functions, 98.26 percent lines. Evidence: @gobing-ai/ts-libs `.spur/run/0108-verify-check.log` lines 46-268; @gobing-ai/ts-libs `.spur/run/0108-verify-build.log` line 1. No tests skipped or suppressions added; git diff --check passed. Reissued verdict/confidence and evidence in .spur/run/0108-verify-answer.txt:1-29 and .spur/run/0108-verdict.json:1-3; prior snapshots retained. Shippable A3 check passed with its only task done. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R1 — Consumers import the lockstep Clef driver package | MET | command | Fresh workspace build and built ESM factory import; 14 lockstep manifests and correct runtime/test dependencies. `packages/decision-clef/package.json:2`; Evidence: @gobing-ai/ts-libs `.spur/run/0108-verify-package.log` line 1. |
| R2 — Model selection uses matching Clef routes and body selectors | MET | test | `packages/decision-clef/tests/driver.test.ts:180` default/configured/per-call routes, body selector, auth and single request; fresh full suite passed. |
| R3 — DecisionMaker preserves typed batch answers and probabilities | MET | test | `packages/decision-clef/tests/driver.test.ts:229` mixed batch, fractional score, confidence and bare noul; `packages/decision-clef/tests/driver.test.ts:859` convenience methods; fresh full suite passed. |
| R4 — Invalid requests and malformed responses fail at the driver boundary | MET | test | `packages/decision-clef/tests/driver.test.ts:435` lossless JSON and size bounds; `packages/decision-clef/tests/driver.test.ts:449` hidden/symbol array properties and accessors rejected without fetch; existing limit/envelope/answer correspondence tests passed in the full suite. |
| R5 — Configuration and transport failures use the decision error taxonomy | MET | test | `packages/decision-clef/tests/driver.test.ts:119` configuration matrix; `packages/decision-clef/tests/driver.test.ts:628` invalid retry hints; `packages/decision-clef/tests/driver.test.ts:697` redaction; real APIClient abort/network/HTTP tests passed in the full suite. |
| R6 — Applications compose the backend without changing existing defaults | MET | test | `packages/decision-clef/tests/registry.test.ts:61` lazy maker and hub routing; `packages/decision-clef/tests/registry.test.ts:96` unchanged built-ins; fallback test at `packages/decision-clef/tests/registry.test.ts:141`; full suite passed. |
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

