---
schema_version: 1
name: Implement @gobing-ai/ts-decision-gemini driver for Gemini Decision 1
status: todo
template: feature-impl
created_at: 2026-11-17T19:38:53.441Z
updated_at: "2026-11-17T22:12:34.954Z"
feature_id: O3
priority: P2
tags:
  - decision-gemini
  - decision-maker
  - ai-runner
  - ai-decision

estimate_hours: 6
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

- [ ] R1. Scaffold `packages/decision-gemini` (`@gobing-ai/ts-decision-gemini` at current lockstep version `0.7.1`) with `package.json` (`workspace:*` runtime deps on `@gobing-ai/ts-ai-runner` and `@gobing-ai/ts-infra`; `workspace:*` devDep on `@gobing-ai/ts-ai-decision` plus `@types/bun`), `tsconfig.json` (extending `../../tooling/typescript/base.json` with transitive `compilerOptions.paths` matching `packages/decision-clef/tsconfig.json:4-16`), `tsconfig.build.json` (`paths: {}`, `rootDir: "src"`, `outDir: "dist"`), `LICENSE`, `NOTICE`, and `README.md`.
- [ ] R2. Implement `createGeminiDecisionDriver(options: GeminiDecisionDriverOptions): DecisionDriver` in `packages/decision-gemini/src/driver.ts` (`name: 'gemini-decision'`, `GeminiDecisionModel = 'gemini-decision-1'`, default model `'gemini-decision-1'`, default `baseURL: 'https://generativelanguage.googleapis.com'`, default `timeoutMs: 30_000`, `x-goog-api-key` header, `APIClient.rawRequest` transport, `fetch` injection, and `DecisionConfigError` construction guards for `options`, `apiKey`, `baseURL`, `timeoutMs`, and `model`).
- [ ] R3. Map neutral `state ?? ''` (`input` field) and `choice`/`score`/`noul` questions (`instructions` fallback to question ID when prompt is null/blank, `criteria` for `choice`/`score`/`noul`) to `POST /v1beta/decisions` with lossless JSON validation (`assertJsonSerializable`), question count (1–1000) and ID validation, and 13 MiB request / 8 MiB response caps; normalize `answers` (supporting both keyed-map and `answers[]` array wire shapes, and both map and `{ value, probability }[]` probability distributions, plus optional `legend` fallback from request rubric) into `ChoiceAnswer`, `ScoreAnswer`, and `NoulAnswer` (never synthesizing `confidence` on `noul`); validate via `validateQuestions`/`validateAnswers`; and map HTTP/transport errors (`401`/`403` → `DecisionAuthError`, `429` + `Retry-After` → `DecisionRateLimitError`, `400`/`422`/4xx → `DecisionRequestError`, `APIError(status=0)` → `DecisionTimeoutError`, network error → `DecisionConnectionError`, 3xx/5xx/malformed JSON/refusal → `DecisionBackendError`) without leaking credentials or raw body text.
- [ ] R4. Add offline behavior and composition tests in `packages/decision-gemini/tests/driver.test.ts` and `packages/decision-gemini/tests/registry.test.ts` using injected `fetch` with real `APIClient`, `createDecisionMaker({ driver })`, `DecisionMakerRegistry`, and `DecisionHub`; add one-way boundary rules in `.spur/rules/typescript/decision-boundaries.yaml`; update package/design indexes (`docs/design/package-exports.md`); and pass `bun run spur-check` and `bun run build`.

### Acceptance Criteria

- [ ] AC1 — Gemini Decision 1 driver answers choice, score, and noul questions via POST /v1beta/decisions (req: R2, R3)
- [ ] AC2 — Both drivers reject invalid credentials, malformed requests, and non-2xx API errors using DecisionError taxonomy (req: R2, R3)
- [ ] AC3 — Both drivers integrate with DecisionMakerRegistry and monorepo package boundaries (req: R1, R4)

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

- [ ] 1. Precondition & scaffolding (R1): Verify lockstep version (`0.7.1`) in `package.json:3`; create `packages/decision-gemini/{package.json,tsconfig.json,tsconfig.build.json,LICENSE,NOTICE,README.md}` matching `packages/decision-clef/` conventions (`build` script must be `'tsc -p tsconfig.build.json && bun ../../scripts/builder.ts fix-dist-esm-extensions dist'` per `esm-build-conventions.yaml:38`). Run `bun install` if needed so workspace links resolve.
- [ ] 2. Driver implementation (R2, R3): Implement `packages/decision-gemini/src/driver.ts` and `packages/decision-gemini/src/index.ts` with `createGeminiDecisionDriver`, `GeminiDecisionDriverOptions`, `GeminiDecisionModel`, `assertJsonSerializable`, request/response size caps, `/v1beta/decisions` wire mapping (`input`, `x-goog-api-key`), answer normalization, `validateQuestions`/`validateAnswers`, and `DecisionError` mapping.
- [ ] 3. Offline unit & registry tests (R2, R3, R4): Create `packages/decision-gemini/tests/driver.test.ts` (construction validation, `choice`/`score`/`noul` batch + sugar methods, `baseURL` override, both object-map and array response shapes, `__proto__` question IDs, lossy/circular JSON rejection, 13 MiB/8 MiB caps, 401/403/429 `Retry-After`/400/500/302/timeout/network/refusal errors, credential redaction) and `packages/decision-gemini/tests/registry.test.ts` (`DecisionMakerRegistry` custom registration, `DecisionHub` routing and fallback).
- [ ] 4. Boundary rules & docs (R1, R4): Add `no-gemini-driver-import-in-ai-runner`, `no-ai-decision-import-in-decision-gemini`, and `no-gemini-dependency-in-ai-runner-manifest` to `.spur/rules/typescript/decision-boundaries.yaml`; update `docs/design/package-exports.md` and `AGENTS.md`/`README.md` package tables if applicable; run `bun run spur-check` and `bun run build`.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
