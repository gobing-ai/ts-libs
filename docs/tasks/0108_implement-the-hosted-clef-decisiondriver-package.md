---
schema_version: 1
name: Implement the hosted Clef DecisionDriver package
status: done
template: feature-impl
created_at: 2026-10-09T18:32:28.066Z
updated_at: "2026-10-09T20:29:45.795Z"
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
| `docs/03_ARCHITECTURE.md:17` |
| `docs/03_ARCHITECTURE.md:33` |
| `docs/04_DESIGN.md:30` |
| `docs/design/decision-clef-backend.md:11` |
| `docs/design/decision-clef-backend.md:3` |
| `packages/ai-runner/README.md:835` |
| `packages/ai-runner/src/index.ts:9` |
| `packages/ai-runner/tests/decision/validation.test.ts:317` |
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

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | packages/decision-clef/package.json:2-3 (name + lockstep 0.5.19 == root package.json:3), exports/main/types plus files (LICENSE, NOTICE); src/index.ts:1-2 exports createClefDriver/ClefDriverOptions/ClefModel; tsconfig.json:4-17 transitive paths closure; tsconfig.build.json mirrors decision-fm (paths {}, rootDir src); dist/index.js ESM specifier; bun.lock:79-90,301; gate log "@gobing-ai/ts-decision-clef typecheck: Exited with code 0" |
| R2 | MET | driver.ts:205-207 one APIClient, fixed https://api.cloudflare.com/client/v4; zero process.env in src/**; driver.ts:223 model ?? configuredModel and :292 path from the same resolvedModel; :295-301 rawRequest POST + Authorization: Bearer + redirect manual + maxResponseBytes; tests driver.test.ts:180-226 (default clef-flash, configured clef, per-call override, invalid selector pre-transport, callCount()===1) |
| R3 | MET | driver.ts:113-142 mapQuestion (choice/score/noul), :103-111 instructions fallback to question ID, :366-438 envelope to typed answers on a null-prototype record; validateAnswers at :438; tests driver.test.ts:229-316 assert fractional score 1.5, confidence 0.85, legend, noul probability 0.75 with no confidence, __proto__ IDs end to end; facade sugar :790+ |
| R4 | MET | ai-runner/src/index.ts:9 re-exports the shared validators; limits driver.ts:226-231 (1-64), :235-238 (ID pattern), :245-260 (2-255 options, nonempty), :262-268 (2-10 levels); strict JSON gate :53-101 plus :272 (state) and :286 (mapped body) rejecting cycles/nonfinite/undefined/function/symbol/BigInt/sparse-and-decorated arrays/non-plain instances; UTF-8 13 MiB cap :286-290; decode/envelope/answer checks :342-438; nonempty model without echo requirement :358-360; tests :317-509, :512-535, :721-775 |
| R5 | MET | driver.ts:305-339 taxonomy (400/404 Request, 401/403 Auth, 429 RateLimit+Retry-After, 5xx/3xx/other Backend, APIError status 0 Timeout, other transport Connection); Retry-After :154-167; redaction -- generic messages, bodySummary undefined at :331, no cause at :305-309; tests :554-719 incl. cause === undefined and :777-787 never fabricates |
| R6 | MET | ai-runner/package.json names no clef token; packages/decision-clef/src/** imports no @gobing-ai/ts-ai-decision; rules .spur/rules/typescript/decision-boundaries.yaml:130,142,154 plus fixtures should-fire/ and should-pass/; tests/registry.test.ts uses the real DecisionMakerRegistry and DecisionHub with a test-only ts-ai-decision devDependency (package.json:59) and test path (tsconfig.json:5); docs updated (package README bootstrap to docs/PACKAGE_RELEASE.md:125, ai-runner README shared validators, docs/00_ADR.md:742, docs/03_ARCHITECTURE.md, docs/04_DESIGN.md:30, README.md, AGENTS.md:22) |
| R7 | MET | digest-bound gate log: 2902 pass / 0 fail / 8556 expect() calls / 238 files, 61 pre-check + 2 post-check rules passed, closing proof-digest sha256:02873316...b164d7 == certified digest, matched by .spur/run/0108-check-receipt.json status PASS; coverage cross-check lcov LF:338 LH:332 reproduces 98.22 percent with uncovered 99-100,140,149,161; no .skip/biome-ignore/commented assertions; bun run build 13/13 exit 0 (.spur/run/0108-build.log) |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R1 — Consumers import the lockstep Clef driver package | MET | command | package.json:2-3 name/version lockstep with root 0.5.19; exports/files/LICENSE/NOTICE present; dist/index.js and dist/index.d.ts built; new-package typecheck exit 0 in the gate log; usage import in packages/decision-clef/README.md:22-23 |
| R2 — Model selection uses matching Clef routes and body selectors | MET | test | driver.test.ts:180-226: default route .../@cf/cloudflare/clef-flash with body model clef-flash; configured clef; per-call model clef overrides route and body; invalid selector rejected with callCount()===0; driver.ts:292 proves endpoint and body derive from one resolvedModel |
| R3 — DecisionMaker preserves typed batch answers and probabilities | MET | test | mixed-kind batch driver.test.ts:229-287 (choice/score/noul, fractional score, preserved confidence, bare noul probability); facade sugar :790-820; correspondence enforced by validateAnswers (driver.ts:438) |
| R4 — Invalid requests and malformed responses fail at the driver boundary | MET | test | pre-transport rejections at callCount()===0: 65/0 questions, 1/256 options, empty option ID, 11 score levels, bad IDs, cyclic/sparse/symbol/decorated-array/non-enumerable/BigInt/Date/NaN/Infinity state, unserializable description, 13 MiB body (driver.test.ts:338-509); malformed JSON / success:false / missing result / empty model / absent or non-object answers / malformed choice-score / wrong names / unnormalized mass / unknown kind to DecisionBackendError (:536-553, :721-775) |
| R5 — Configuration and transport failures use the decision error taxonomy | MET | test | config: driver.test.ts:119-172 (13 bad option shapes to DecisionConfigError, field named, value omitted); HTTP matrix :554-574 (401/403/429/400/404/500/503/302); Retry-After :575-630; timeout via the real APIClient + AbortSignal :631-646; connection :647-657; redaction :658-719 |
| R6 — Applications compose the backend without changing existing defaults | MET | test | tests/registry.test.ts:86-197: lazy custom clef-hosted factory memoised exactly once, hub routing and fallback untouched; registry.names() stays typesafe/fm-local/laya-local before and adds clef-hosted after, registry.has('clef')===false; ai-runner backend selectors unchanged |
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

