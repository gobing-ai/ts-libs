---
schema_version: 1
name: Implement @gobing-ai/ts-decision-openai driver for GPT-6 Luna Decisions
status: todo
template: feature-impl
created_at: 2026-11-17T19:38:53.443Z
updated_at: "2026-11-17T22:12:51.733Z"
feature_id: O3
priority: P2
tags:
  - decision-openai
  - decision-maker
  - ai-runner
  - ai-decision

estimate_hours: 6
---

## 0121. Implement @gobing-ai/ts-decision-openai driver for GPT-6 Luna Decisions

### Background

Implements feature O3 scenarios R2, R3, and R4 for OpenAI's GPT-6 Luna Decisions (`gpt-6-luna`) API (`POST https://api.openai.com/v1/decisions`). Follows ADR-042 (`docs/00_ADR.md:890-904`) and the ADR-037 `packages/decision-clef` pattern (`packages/decision-clef/src/driver.ts:1-459`) over `@gobing-ai/ts-infra` `APIClient` and `@gobing-ai/ts-ai-runner` validators/errors.

Verified premises against current tree:
- `DecisionDriver` seam at `packages/ai-runner/src/decision/types.ts:104`, shared `validateQuestions` / `validateAnswers` at `packages/ai-runner/src/decision/validation.ts:26` and `:73` (re-exported from `packages/ai-runner/src/index.ts`).
- `APIClient.rawRequest` at `packages/infra/src/api-client.ts:341`.
- `DecisionMakerRegistry.register` at `packages/ai-decision/src/registry.ts:158`.
- Sibling package configuration at `packages/decision-clef/package.json:1-64`, `packages/decision-clef/tsconfig.json:1-19`, and `packages/decision-clef/tsconfig.build.json:1-17`.

**Refine corrections (2026-11-17)**
- `tsconfig` path wiring (R1, Plan): Task originally claimed "update root `tsconfig.json` paths" → `tsconfig.json:1-32` uses project `references` only (no `paths`, and `decision-clef`/`decision-fm`/`laya-mlx` are not listed in root `references`), while `packages/decision-clef/tsconfig.json:1-19` extends `../../tooling/typescript/base.json` with transitive `compilerOptions.paths` and `tsconfig.build.json:13` sets `"paths": {}` → Corrected R1, Design, and Plan to configure per-package `tsconfig.json` and `tsconfig.build.json` only.
- Wire-schema normalization & transport guards (R2, R3, Design): Task originally left response `answers[]` / `probabilities[]` array vs keyed-map shapes and JSON/size guards implicit → `packages/decision-clef/src/driver.ts:53-112`, `:165-179`, `:317-456` enforces lossless JSON (`assertJsonSerializable`), 13 MiB request / 8 MiB response caps, `Object.create(null)` answer maps, `APIError(status=0)` timeout mapping, and `Retry-After` parsing → Frozen in R2/R3/Design, accepting both `answers[]` array (`{ name, type, ... }`) and keyed-map shapes plus `probabilities` as `{ value, probability }[]` or record from `POST /v1/decisions`.
- Package manifest & boundary rules (R1, R4, Plan): Added `LICENSE` and `NOTICE` to package files (`packages/decision-clef/package.json:35-41`) and specified `.spur/rules/typescript/decision-boundaries.yaml` one-way import/manifest rules (`no-openai-driver-import-in-ai-runner`, `no-ai-decision-import-in-decision-openai`, `no-openai-dependency-in-ai-runner-manifest`).

### Requirements

- [ ] R1. Scaffold `packages/decision-openai` (`@gobing-ai/ts-decision-openai` at current lockstep version `0.7.1`) with `package.json` (`workspace:*` runtime deps on `@gobing-ai/ts-ai-runner` and `@gobing-ai/ts-infra`; `workspace:*` devDep on `@gobing-ai/ts-ai-decision` plus `@types/bun`), `tsconfig.json` (extending `../../tooling/typescript/base.json` with transitive `compilerOptions.paths` matching `packages/decision-clef/tsconfig.json:4-16`), `tsconfig.build.json` (`paths: {}`, `rootDir: "src"`, `outDir: "dist"`), `LICENSE`, `NOTICE`, and `README.md`.
- [ ] R2. Implement `createOpenAIDecisionDriver(options: OpenAIDecisionDriverOptions): DecisionDriver` in `packages/decision-openai/src/driver.ts` (`name: 'openai-luna'`, `OpenAIDecisionModel = 'gpt-6-luna'`, default model `'gpt-6-luna'`, default `baseURL: 'https://api.openai.com'`, default `timeoutMs: 30_000`, `Authorization: Bearer <apiKey>` header, `APIClient.rawRequest` transport, `fetch` injection, and `DecisionConfigError` construction guards for `options`, `apiKey`, `baseURL`, `timeoutMs`, and `model`).
- [ ] R3. Map neutral `state ?? ''` (`input` field) and `choice`/`score`/`noul` questions (`instructions` fallback to question ID when prompt is null/blank, `criteria` for `choice`/`score`/`noul`) to `POST /v1/decisions` with lossless JSON validation (`assertJsonSerializable`), question count (1–400) and ID validation, and 13 MiB request / 8 MiB response caps; normalize `answers` (supporting both OpenAI's `answers: Array<{ name, type, ... }>` and keyed-map wire shapes, and both `Array<{ value, probability }>` and record probability distributions, plus optional `legend` fallback from request rubric) into `ChoiceAnswer`, `ScoreAnswer`, and `NoulAnswer` (never synthesizing `confidence` on `noul`); validate via `validateQuestions`/`validateAnswers`; and map HTTP/transport errors and model refusals (`type: 'refusal'`) to `DecisionError` subclasses without leaking credentials or raw body text.
- [ ] R4. Add offline behavior and composition tests in `packages/decision-openai/tests/driver.test.ts` and `packages/decision-openai/tests/registry.test.ts` using injected `fetch` with real `APIClient`, `createDecisionMaker({ driver })`, `DecisionMakerRegistry`, and `DecisionHub`; add one-way boundary rules in `.spur/rules/typescript/decision-boundaries.yaml`; update package/design indexes (`docs/design/package-exports.md`); and pass `bun run spur-check` and `bun run build`.

### Acceptance Criteria

- [ ] AC1 — GPT-6 Luna driver answers choice, score, and noul questions via POST /v1/decisions (req: R2, R3)
- [ ] AC2 — Both drivers reject invalid credentials, malformed requests, and non-2xx API errors using DecisionError taxonomy (req: R2, R3)
- [ ] AC3 — Both drivers integrate with DecisionMakerRegistry and monorepo package boundaries (req: R1, R4)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-11-17T22:12:51.234Z

#### Q&A entry — 2026-11-17T14:11:30-08:00

- **Package & boundary:** Ships as standalone `@gobing-ai/ts-decision-openai` (`packages/decision-openai`) per ADR-042. `ts-ai-decision` is a `devDependency` only (for `registry.test.ts`); `DecisionMakerRegistry` built-ins remain unchanged.
- **Endpoint & auth:** `POST /v1/decisions` against configurable `baseURL` (default `https://api.openai.com`) using `Authorization: Bearer <apiKey>`. No `process.env` reads inside the driver.
- **Wire payload & response:** Request body sends `{ model: resolvedModel, input: state ?? '', questions }` (up to 400 questions per OpenAI `/v1/decisions` limit). Response parser accepts `answers` as `Array<{ name, type, ... }>` or keyed record, and `probabilities` as `Array<{ value, probability }>` or keyed record, rejecting `type: 'refusal'` with `DecisionBackendError` and validating final answers through `validateAnswers(questions, answers)`.

### Design

Standalone hosted package `packages/decision-openai` per ADR-042 (`docs/00_ADR.md:890-904`) and `docs/design/gemini-and-openai-decision-backends.md:1-79`, mirroring `packages/decision-clef/src/driver.ts:1-459`.

#### Frozen API & Signatures (`packages/decision-openai/src/index.ts`, `src/driver.ts`)
- `export type OpenAIDecisionModel = 'gpt-6-luna';`
- `export interface OpenAIDecisionDriverOptions { apiKey: string; model?: OpenAIDecisionModel; baseURL?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch; }`
- `export function createOpenAIDecisionDriver(options: OpenAIDecisionDriverOptions): DecisionDriver;`
- Driver `name`: `'openai-luna'`.

#### Construction & Transport Invariants
- Validate `options` (non-null object), `apiKey` (non-empty string, no whitespace or C0/DEL control chars → `DecisionConfigError(..., 'apiKey')`), `baseURL` (when provided, valid `http:` or `https:` URL with no credentials/query/hash → `DecisionConfigError(..., 'baseURL')`), `timeoutMs` (positive safe integer, default `30_000` → `DecisionConfigError(..., 'timeoutMs')`), `model` (`'gpt-6-luna'` when provided → `DecisionConfigError(..., 'model')`).
- Construct one `APIClient({ baseUrl: normalizedBaseUrl, timeout: timeoutMs, fetch: customFetch })` from `@gobing-ai/ts-infra`.
- Per-call `ask({ state, questions, model })`:
  1. Call `validateQuestions(questions)` (rethrow as `DecisionRequestError`).
  2. Verify `model === undefined || model === 'gpt-6-luna'` (else `DecisionRequestError`).
  3. Enforce question count `1..400` (OpenAI `/v1/decisions` dictionary limit), question ID pattern `/^[A-Za-z0-9_.-]{1,100}$/`, choice label count `2..255` (non-empty keys), score rubric length `2..255`.
  4. Validate `assertJsonSerializable(state ?? null, 'state')` and mapped request `{ model: resolvedModel, input: state ?? '', questions: mappedQuestions }`; enforce `MAX_REQUEST_BODY_BYTES = 13 * 1024 * 1024` via `TextEncoder`.
  5. Send `client.rawRequest('POST', '/v1/decisions', bodyString, { headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }, redirect: 'manual', maxResponseBytes: 8 * 1024 * 1024 })`.
  6. Normalize `answers` (whether returned as `Array<{ name: string, type: string, ... }>` or keyed object) into `Object.create(null)` record (preserving `__proto__` keys and rejecting duplicate `name` entries in array form), supporting `choice` (`choice` or `label`, `probabilities` as `{ value, probability }[]` or record), `score` (`score`, `confidence`, `probabilities`, and `legend` defaulting to indexed request `rubric` when omitted on wire), and `noul` (`noul` or `probability` number → `NoulAnswer { kind: 'noul', probability }`). Reject `type: 'refusal'` or unknown types with `DecisionBackendError`.
  7. Run `validateAnswers(questions, answers)` (rethrow as `DecisionBackendError`).

#### Anti-Patterns (Do Not Implement)
- Do **not** import `openai`, `node:fs`, `process.env`, or call `fetch()` / `globalThis.fetch()` directly (`external-api-boundaries.yaml`).
- Do **not** import `@gobing-ai/ts-ai-decision` in `packages/decision-openai/src/**` (test-only `devDependency`).
- Do **not** modify `packages/ai-runner` or `packages/ai-decision` built-in maker registrations.
- Do **not** add `packages/decision-openai` to root `tsconfig.json` `references`.
- Note on shared files with sibling task `0120`: `.spur/rules/typescript/decision-boundaries.yaml` and `docs/design/package-exports.md` are touched by both `0120` and `0121`; preserve `0120`'s entries when editing.

### Plan

- [ ] 1. Precondition & scaffolding (R1): Verify lockstep version (`0.7.1`) in `package.json:3`; create `packages/decision-openai/{package.json,tsconfig.json,tsconfig.build.json,LICENSE,NOTICE,README.md}` matching `packages/decision-clef/` conventions (`build` script must be `'tsc -p tsconfig.build.json && bun ../../scripts/builder.ts fix-dist-esm-extensions dist'` per `esm-build-conventions.yaml:38`). Run `bun install` if needed so workspace links resolve.
- [ ] 2. Driver implementation (R2, R3): Implement `packages/decision-openai/src/driver.ts` and `packages/decision-openai/src/index.ts` with `createOpenAIDecisionDriver`, `OpenAIDecisionDriverOptions`, `OpenAIDecisionModel`, `assertJsonSerializable`, request/response size caps, `/v1/decisions` wire mapping (`input`, `Authorization: Bearer`), `answers[]` + `probabilities[]` and map normalization, `validateQuestions`/`validateAnswers`, and `DecisionError` mapping (including `type: 'refusal'`).
- [ ] 3. Offline unit & registry tests (R2, R3, R4): Create `packages/decision-openai/tests/driver.test.ts` (construction validation, `choice`/`score`/`noul` batch + sugar methods, `baseURL` override, both `answers[]` array and keyed-map response shapes, `{ value, probability }[]` probabilities, `__proto__` question IDs, lossy/circular JSON rejection, 1–400 question limit, 13 MiB/8 MiB caps, 401/403/429 `Retry-After`/400/500/302/timeout/network/refusal errors, credential redaction) and `packages/decision-openai/tests/registry.test.ts` (`DecisionMakerRegistry` custom registration, `DecisionHub` routing and fallback).
- [ ] 4. Boundary rules & docs (R1, R4): Add `no-openai-driver-import-in-ai-runner`, `no-ai-decision-import-in-decision-openai`, and `no-openai-dependency-in-ai-runner-manifest` to `.spur/rules/typescript/decision-boundaries.yaml`; update `docs/design/package-exports.md` and `AGENTS.md`/`README.md` package tables if applicable; run `bun run spur-check` and `bun run build`.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
