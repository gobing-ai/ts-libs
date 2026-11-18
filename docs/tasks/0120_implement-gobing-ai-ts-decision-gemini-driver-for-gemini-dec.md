---
schema_version: 1
name: Implement @gobing-ai/ts-decision-gemini driver for Gemini Decision 1
status: done
template: feature-impl
created_at: 2026-11-17T19:38:53.441Z
updated_at: "2026-11-18T06:44:25.006Z"
feature_id: O3
priority: P2
tags:
  - decision-gemini
  - decision-maker
  - ai-runner
  - ai-decision

estimate_hours: 6
done_forced: "false"
done_reason: unforced close
---

## 0120. Implement @gobing-ai/ts-decision-gemini driver for Gemini Decision 1

### Background

Implements feature O3 scenarios R1, R3, and R4 for Google's Gemini Decision 1 (`gemini-decision-1`) Decisions API (`POST https://generativelanguage.googleapis.com/v1beta/decisions`). Follows ADR-042 (`docs/00_ADR.md:890-904`) and the ADR-037 `packages/decision-clef` pattern (`packages/decision-clef/src/driver.ts:1-459`) over `@gobing-ai/ts-infra` `APIClient` and `@gobing-ai/ts-ai-runner` validators/errors.

Verified premises against current tree:
- `DecisionDriver` seam at `packages/ai-runner/src/decision/types.ts:104`, shared `validateQuestions` / `validateAnswers` at `packages/ai-runner/src/decision/validation.ts:26` and `:73` (re-exported from `packages/ai-runner/src/index.ts`).
- `APIClient.rawRequest` at `packages/infra/src/api-client.ts:341`.
- `DecisionMakerRegistry.register` at `packages/ai-decision/src/registry.ts:158`.
- Sibling package configuration at `packages/decision-clef/package.json:1-64`, `packages/decision-clef/tsconfig.json:1-19`, and `packages/decision-clef/tsconfig.build.json:1-17`.

**Refine corrections (2026-11-17)**
- `tsconfig` path wiring (R1, Plan): Task originally claimed "update root `tsconfig.json` paths" → `tsconfig.json:1-32` uses project `references` only (no `paths`, and `decision-clef`/`decision-fm`/`laya-mlx` are not listed in root `references`), while `packages/decision-clef/tsconfig.json:1-19` extends `../../tooling/typescript/base.json` with transitive `compilerOptions.paths` and `tsconfig.build.json:13` sets `"paths": {}` → Corrected R1, Design, and Plan to configure per-package `tsconfig.json` and `tsconfig.build.json` only.
- Wire-schema normalization & transport guards (R2, R3, Design): Task originally left response envelope/distribution normalization and JSON/size guards implicit → `packages/decision-clef/src/driver.ts:53-112`, `:165-179`, `:317-456` enforces lossless JSON (`assertJsonSerializable`), 13 MiB request / 8 MiB response caps, `Object.create(null)` answer maps, `APIError(status=0)` timeout mapping, and `Retry-After` parsing → Frozen in R2/R3/Design, accepting both keyed-object and array (`answers[]` / `probabilities[]`) wire shapes from `POST /v1beta/decisions`.
- Package manifest & boundary rules (R1, R4, Plan): Added `LICENSE` and `NOTICE` to package files (`packages/decision-clef/package.json:35-41`) and specified `.spur/rules/typescript/decision-boundaries.yaml` one-way import/manifest rules (`no-gemini-driver-import-in-ai-runner`, `no-ai-decision-import-in-decision-gemini`, `no-gemini-dependency-in-ai-runner-manifest`).

### Requirements

- [x] R1. Scaffold `packages/decision-gemini` (`@gobing-ai/ts-decision-gemini` at current lockstep version `0.7.1`) with `package.json` (`workspace:*` runtime deps on `@gobing-ai/ts-ai-runner` and `@gobing-ai/ts-infra`; `workspace:*` devDep on `@gobing-ai/ts-ai-decision` plus `@types/bun`), `tsconfig.json` (extending `../../tooling/typescript/base.json` with transitive `compilerOptions.paths` matching `packages/decision-clef/tsconfig.json:4-16`), `tsconfig.build.json` (`paths: {}`, `rootDir: "src"`, `outDir: "dist"`), `LICENSE`, `NOTICE`, and `README.md`.
- [x] R2. Implement `createGeminiDecisionDriver(options: GeminiDecisionDriverOptions): DecisionDriver` in `packages/decision-gemini/src/driver.ts` (`name: 'gemini-decision'`, `GeminiDecisionModel = 'gemini-decision-1'`, default model `'gemini-decision-1'`, default `baseURL: 'https://generativelanguage.googleapis.com'`, default `timeoutMs: 30_000`, `x-goog-api-key` header, `APIClient.rawRequest` transport, `fetch` injection, and `DecisionConfigError` construction guards for `options`, `apiKey`, `baseURL`, `timeoutMs`, and `model`).
- [x] R3. Map neutral `state ?? ''` (`input` field) and `choice`/`score`/`noul` questions (`instructions` fallback to question ID when prompt is null/blank, `criteria` for `choice`/`score`/`noul`) to `POST /v1beta/decisions` with lossless JSON validation (`assertJsonSerializable`), question count (1–1000) and ID validation, and 13 MiB request / 8 MiB response caps; normalize `answers` (supporting both keyed-map and `answers[]` array wire shapes, and both map and `{ value, probability }[]` probability distributions, plus optional `legend` fallback from request rubric) into `ChoiceAnswer`, `ScoreAnswer`, and `NoulAnswer` (never synthesizing `confidence` on `noul`); validate via `validateQuestions`/`validateAnswers`; and map HTTP/transport errors (`401`/`403` → `DecisionAuthError`, `429` + `Retry-After` → `DecisionRateLimitError`, `400`/`422`/4xx → `DecisionRequestError`, `APIError(status=0)` → `DecisionTimeoutError`, network error → `DecisionConnectionError`, 3xx/5xx/malformed JSON/refusal → `DecisionBackendError`) without leaking credentials or raw body text.
- [x] R4. Add offline behavior and composition tests in `packages/decision-gemini/tests/driver.test.ts` and `packages/decision-gemini/tests/registry.test.ts` using injected `fetch` with real `APIClient`, `createDecisionMaker({ driver })`, `DecisionMakerRegistry`, and `DecisionHub`; add one-way boundary rules in `.spur/rules/typescript/decision-boundaries.yaml`; update package/design indexes (`docs/design/package-exports.md`); and pass `bun run spur-check` and `bun run build`.

### Acceptance Criteria

- [x] AC1 — Gemini Decision 1 driver answers choice, score, and noul questions via POST /v1beta/decisions (req: R2, R3)
- [x] AC2 — Both drivers reject invalid credentials, malformed requests, and non-2xx API errors using DecisionError taxonomy (req: R2, R3)
- [x] AC3 — Both drivers integrate with DecisionMakerRegistry and monorepo package boundaries (req: R1, R4)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-11-17T22:12:34.466Z

#### Q&A entry — 2026-11-17T14:11:00-08:00

- **Package & boundary:** Ships as standalone `@gobing-ai/ts-decision-gemini` (`packages/decision-gemini`) per ADR-042. `ts-ai-decision` is a `devDependency` only (for `registry.test.ts`); `DecisionMakerRegistry` built-ins remain unchanged.
- **Endpoint & auth:** `POST /v1beta/decisions` against configurable `baseURL` (default `https://generativelanguage.googleapis.com`) using `x-goog-api-key: <apiKey>`. No `process.env` reads inside the driver.
- **Wire payload & response:** Request body sends `{ model: resolvedModel, input: state ?? '', questions }`. Response parser accepts top-level `{ answers }` or `{ result: { answers } }`, with `answers` as a keyed object or `Array<{ name, type, ... }>` and `probabilities` as a record or `Array<{ value, probability }>`, validating final answers through `validateAnswers(questions, answers)`.

### Design

Standalone hosted package `packages/decision-gemini` per ADR-042 (`docs/00_ADR.md:890-904`) and `docs/design/gemini-and-openai-decision-backends.md:1-79`, mirroring `packages/decision-clef/src/driver.ts:1-459`.

#### Frozen API & Signatures (`packages/decision-gemini/src/index.ts`, `src/driver.ts`)
- `export type GeminiDecisionModel = 'gemini-decision-1';`
- `export interface GeminiDecisionDriverOptions { apiKey: string; model?: GeminiDecisionModel; baseURL?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch; }`
- `export function createGeminiDecisionDriver(options: GeminiDecisionDriverOptions): DecisionDriver;`
- Driver `name`: `'gemini-decision'`.

#### Construction & Transport Invariants
- Validate `options` (non-null object), `apiKey` (non-empty string, no whitespace or C0/DEL control chars → `DecisionConfigError(..., 'apiKey')`), `baseURL` (when provided, valid `http:` or `https:` URL with no credentials/query/hash → `DecisionConfigError(..., 'baseURL')`), `timeoutMs` (positive safe integer, default `30_000` → `DecisionConfigError(..., 'timeoutMs')`), `model` (`'gemini-decision-1'` when provided → `DecisionConfigError(..., 'model')`).
- Construct one `APIClient({ baseUrl: normalizedBaseUrl, timeout: timeoutMs, fetch: customFetch })` from `@gobing-ai/ts-infra`.
- Per-call `ask({ state, questions, model })`:
  1. Call `validateQuestions(questions)` (rethrow as `DecisionRequestError`).
  2. Verify `model === undefined || model === 'gemini-decision-1'` (else `DecisionRequestError`).
  3. Enforce question count `1..1000`, question ID pattern `/^[A-Za-z0-9_.-]{1,100}$/`, choice label count `2..255` (non-empty keys), score rubric length `2..255`.
  4. Validate `assertJsonSerializable(state ?? null, 'state')` and mapped request `{ model: resolvedModel, input: state ?? '', questions: mappedQuestions }`; enforce `MAX_REQUEST_BODY_BYTES = 13 * 1024 * 1024` via `TextEncoder`.
  5. Send `client.rawRequest('POST', '/v1beta/decisions', bodyString, { headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, redirect: 'manual', maxResponseBytes: 8 * 1024 * 1024 })`.
  6. Normalize answers into `Object.create(null)` record (preserving `__proto__` keys), supporting `choice` (`choice` or `label`), `score` (`score`, `confidence`, `probabilities`, and `legend` defaulting to indexed request `rubric` when omitted on wire), and `noul` (`noul` or `probability` number → `NoulAnswer { kind: 'noul', probability }`, ignoring any wire `confidence`). Reject `type: 'refusal'` or unknown types with `DecisionBackendError`.
  7. Run `validateAnswers(questions, answers)` (rethrow as `DecisionBackendError`).

#### Anti-Patterns (Do Not Implement)
- Do **not** import `@google/genai`, `node:fs`, `process.env`, or call `fetch()` / `globalThis.fetch()` directly (`external-api-boundaries.yaml`).
- Do **not** import `@gobing-ai/ts-ai-decision` in `packages/decision-gemini/src/**` (test-only `devDependency`).
- Do **not** modify `packages/ai-runner` or `packages/ai-decision` built-in maker registrations.
- Do **not** add `packages/decision-gemini` to root `tsconfig.json` `references`.

### Plan

- [x] 1. Precondition & scaffolding (R1): Verify lockstep version (`0.7.1`) in `package.json:3`; create `packages/decision-gemini/{package.json,tsconfig.json,tsconfig.build.json,LICENSE,NOTICE,README.md}` matching `packages/decision-clef/` conventions (`build` script must be `'tsc -p tsconfig.build.json && bun ../../scripts/builder.ts fix-dist-esm-extensions dist'` per `esm-build-conventions.yaml:38`). Run `bun install` if needed so workspace links resolve.
- [x] 2. Driver implementation (R2, R3): Implement `packages/decision-gemini/src/driver.ts` and `packages/decision-gemini/src/index.ts` with `createGeminiDecisionDriver`, `GeminiDecisionDriverOptions`, `GeminiDecisionModel`, `assertJsonSerializable`, request/response size caps, `/v1beta/decisions` wire mapping (`input`, `x-goog-api-key`), answer normalization, `validateQuestions`/`validateAnswers`, and `DecisionError` mapping.
- [x] 3. Offline unit & registry tests (R2, R3, R4): Create `packages/decision-gemini/tests/driver.test.ts` (construction validation, `choice`/`score`/`noul` batch + sugar methods, `baseURL` override, both object-map and array response shapes, `__proto__` question IDs, lossy/circular JSON rejection, 13 MiB/8 MiB caps, 401/403/408/429 `Retry-After`/400/500/302/timeout/network/refusal errors, credential redaction) and `packages/decision-gemini/tests/registry.test.ts` (`DecisionMakerRegistry` custom registration, `DecisionHub` routing and fallback).
- [x] 4. Boundary rules & docs (R1, R4): Add `no-gemini-driver-import-in-ai-runner`, `no-ai-decision-import-in-decision-gemini`, and `no-gemini-dependency-in-ai-runner-manifest` to `.spur/rules/typescript/decision-boundaries.yaml`; update `docs/design/package-exports.md` and `AGENTS.md`/`README.md` package tables if applicable; run `bun run spur-check` and `bun run build`.

### Solution

Implemented `@gobing-ai/ts-decision-gemini` (`packages/decision-gemini`) per the frozen task design: a consumer-injected `DecisionDriver` for the hosted Gemini Decisions API over the portable `ts-infra` `APIClient` seam (ADR-042), mirroring the `decision-clef` pattern.

**Surface**
- `createGeminiDecisionDriver(options: GeminiDecisionDriverOptions)` → `DecisionDriver` named `gemini-decision`; options `apiKey` (required), `model` (default `'gemini-decision-1'`), `baseURL` (http/https only, no credentials/query/hash, trailing slash normalized), `timeoutMs` (default `30_000`), `fetch` injection. All validation at construction via `DecisionConfigError` (`variable` names the offender); no env reads, no network.
- Wire contract: `POST {baseURL}/v1beta/decisions`, body `{ model, input, questions }` (absent state maps to `''`, prompt fallback = question ID), header `x-goog-api-key`; limits: 1..1000 questions, IDs `^[A-Za-z0-9_.-]{1,100}$`, 2..255 choice labels / score levels, 13 MiB request cap, 8 MiB response cap.
- Error taxonomy identical to clef: timeout → `DecisionTimeoutError(timeoutMs)`, network → `DecisionConnectionError`, 401/403 → auth, 429 → rate limit with parsed `Retry-After` (seconds or HTTP-date), 4xx → request, 5xx/redirect/truncated/malformed → backend. Untrusted transport/response text is never leaked through error messages.
- Response parser accepts both envelopes (`{ answers }`, `{ result: { answers } }`), keyed-object and `[{ name, type, ... }]` answer shapes, map and `{ value, probability }[]` distributions; missing score legend defaults to the request rubric indexed 0-based; noul keeps only the bare probability (wire `confidence` ignored); `refusal`/unknown types fail closed; `validateQuestions`/`validateAnswers` guard both ends.

**Files**
- `packages/decision-gemini/{package.json,tsconfig.json,tsconfig.build.json,LICENSE,NOTICE,README.md}`
- `packages/decision-gemini/src/{index.ts,driver.ts}`
- `packages/decision-gemini/tests/{driver.test.ts,registry.test.ts}` — 37 tests: construction validation, wire shape, per-call model override, question/ID/label/level limits, state serialization hardening (circular, null-prototype, accessor, symbol keys, sparse arrays, non-finite, bigint), 13 MiB/8 MiB caps, status mapping (timeout via real APIClient abort, connection, 401/403/400/404/422/500/503/302, 429 retry variants), envelope/answer-shape/alias/legend-fallback parsing, refusal/unknown rejection, correspondence and mass validation, registry/hub composition (lazy factory, memoization, override routing, fallback path).
- Boundary rules R7: `no-gemini-driver-import-in-ai-runner`, `no-ai-decision-import-in-decision-gemini`, `no-gemini-dependency-in-ai-runner-manifest` in `.spur/rules/typescript/decision-boundaries.yaml`.
- Doc sync: `docs/design/package-exports.md`, root `README.md` (mermaid + package list), `AGENTS.md` package table.

**Verification**
- `packages/decision-gemini`: `tsc --noEmit` clean, biome clean, `bun run build` clean.
- Worktree-wide `bun run spur-check` PASS: lint (biome --error-on-warnings + per-package tsc), `spur rule run` both presets (6 rules, no violations), 3237 tests / 0 fail (37 new), `bun run build` all 14 packages, rule fixtures 62/62 PASS.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/decision-gemini/package.json:1-64`, `packages/decision-gemini/tsconfig.json:1-19`, `packages/decision-gemini/tsconfig.build.json:1-17`, `packages/decision-gemini/LICENSE:1`, `packages/decision-gemini/NOTICE:1`, `packages/decision-gemini/README.md:1-90` |
| R2 | MET | `packages/decision-gemini/src/driver.ts:213-267` (`createGeminiDecisionDriver`, `name: 'gemini-decision'`, `DecisionConfigError` guards, `APIClient` construction), `packages/decision-gemini/src/index.ts:1-6` |
| R3 | MET | `packages/decision-gemini/src/driver.ts:188-207` (duplicate probability rejection), `packages/decision-gemini/src/driver.ts:271-533` (`POST /v1beta/decisions`, `x-goog-api-key`, 1..1000 limit, 13 MiB/8 MiB caps, HTTP 408 timeout at `packages/decision-gemini/src/driver.ts:385-387`, duplicate answer `name` rejection at `packages/decision-gemini/src/driver.ts:450-452`, `validateQuestions`/`validateAnswers`) |
| R4 | MET | `packages/decision-gemini/tests/driver.test.ts:1-717` (34 unit tests including 408 timeout and duplicate answer/probability rejection), `packages/decision-gemini/tests/registry.test.ts:1-160` (4 registry/hub tests), `.spur/rules/typescript/decision-boundaries.yaml:180-215`, `docs/design/package-exports.md:21`; fix-pass touched `.spur/run/0120-verdict.json:1-64` and `.spur/run/0120-verify-answer.txt:1-26` |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — Gemini Decision 1 driver answers choice, score, and noul questions via POST /v1beta/decisions | MET | test | `packages/decision-gemini/tests/driver.test.ts:122-222` and `packages/decision-gemini/tests/driver.test.ts:463-575` (38/38 tests pass in `packages/decision-gemini`) |
| AC2 — Both drivers reject invalid credentials, malformed requests, and non-2xx API errors using DecisionError taxonomy | MET | test | `packages/decision-gemini/tests/driver.test.ts:55-119`, `packages/decision-gemini/tests/driver.test.ts:238-460` (including HTTP 408 timeout at `packages/decision-gemini/tests/driver.test.ts:392`), and `packages/decision-gemini/tests/driver.test.ts:509-695` (including duplicate array answer/probability rejection at `packages/decision-gemini/tests/driver.test.ts:509-552`) |
| AC3 — Both drivers integrate with DecisionMakerRegistry and monorepo package boundaries | MET | test | `packages/decision-gemini/tests/registry.test.ts:60-160`, `.spur/rules/typescript/decision-boundaries.yaml:180-215`, `docs/design/package-exports.md:21`, `bun run spur-check` and `bun run build` exit 0 |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | — | — | No findings (verify verdict PASS) |

### References

- Feature: `docs/features/O3_gemini-decision-1-and-gpt-6-luna-decisionmaker-drivers.md`
- ADR: `docs/00_ADR.md:890-904` (ADR-042)
- Design: `docs/design/gemini-and-openai-decision-backends.md`
- Sibling task: `0121` (`@gobing-ai/ts-decision-openai`) / `0120` (`@gobing-ai/ts-decision-gemini`)

### History

- 2026-11-18T03:45:36.056Z todo → wip (system)
- 2026-11-18T03:48:46.248Z wip → testing (system)
- 2026-11-18T03:48:46.818Z testing → done (system)

