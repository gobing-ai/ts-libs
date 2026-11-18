---
schema_version: 1
name: Implement @gobing-ai/ts-decision-openai driver for GPT-6 Luna Decisions
status: done
template: feature-impl
created_at: 2026-11-17T19:38:53.443Z
updated_at: "2026-11-18T04:05:48.125Z"
feature_id: O3
priority: P2
tags:
  - decision-openai
  - decision-maker
  - ai-runner
  - ai-decision

estimate_hours: 6
done_forced: "false"
done_reason: unforced close
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

- [x] R1. Scaffold `packages/decision-openai` (`@gobing-ai/ts-decision-openai` at current lockstep version `0.7.1`) with `package.json` (`workspace:*` runtime deps on `@gobing-ai/ts-ai-runner` and `@gobing-ai/ts-infra`; `workspace:*` devDep on `@gobing-ai/ts-ai-decision` plus `@types/bun`), `tsconfig.json` (extending `../../tooling/typescript/base.json` with transitive `compilerOptions.paths` matching `packages/decision-clef/tsconfig.json:4-16`), `tsconfig.build.json` (`paths: {}`, `rootDir: "src"`, `outDir: "dist"`), `LICENSE`, `NOTICE`, and `README.md`.
- [x] R2. Implement `createOpenAIDecisionDriver(options: OpenAIDecisionDriverOptions): DecisionDriver` in `packages/decision-openai/src/driver.ts` (`name: 'openai-luna'`, `OpenAIDecisionModel = 'gpt-6-luna'`, default model `'gpt-6-luna'`, default `baseURL: 'https://api.openai.com'`, default `timeoutMs: 30_000`, `Authorization: Bearer <apiKey>` header, `APIClient.rawRequest` transport, `fetch` injection, and `DecisionConfigError` construction guards for `options`, `apiKey`, `baseURL`, `timeoutMs`, and `model`).
- [x] R3. Map neutral `state ?? ''` (`input` field) and `choice`/`score`/`noul` questions (`instructions` fallback to question ID when prompt is null/blank, `criteria` for `choice`/`score`/`noul`) to `POST /v1/decisions` with lossless JSON validation (`assertJsonSerializable`), question count (1–400) and ID validation, and 13 MiB request / 8 MiB response caps; normalize `answers` (supporting both OpenAI's `answers: Array<{ name, type, ... }>` and keyed-map wire shapes, and both `Array<{ value, probability }>` and record probability distributions, plus optional `legend` fallback from request rubric) into `ChoiceAnswer`, `ScoreAnswer`, and `NoulAnswer` (never synthesizing `confidence` on `noul`); validate via `validateQuestions`/`validateAnswers`; and map HTTP/transport errors and model refusals (`type: 'refusal'`) to `DecisionError` subclasses without leaking credentials or raw body text.
- [x] R4. Add offline behavior and composition tests in `packages/decision-openai/tests/driver.test.ts` and `packages/decision-openai/tests/registry.test.ts` using injected `fetch` with real `APIClient`, `createDecisionMaker({ driver })`, `DecisionMakerRegistry`, and `DecisionHub`; add one-way boundary rules in `.spur/rules/typescript/decision-boundaries.yaml`; update package/design indexes (`docs/design/package-exports.md`); and pass `bun run spur-check` and `bun run build`.

### Acceptance Criteria

- [x] AC1 — GPT-6 Luna driver answers choice, score, and noul questions via POST /v1/decisions (req: R2, R3)
- [x] AC2 — Both drivers reject invalid credentials, malformed requests, and non-2xx API errors using DecisionError taxonomy (req: R2, R3)
- [x] AC3 — Both drivers integrate with DecisionMakerRegistry and monorepo package boundaries (req: R1, R4)

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

## Approach

`@gobing-ai/ts-decision-openai` mirrors the `decision-gemini` twin (both from ADR-042): a hosted GPT-6 Luna decision backend that speaks the neutral `DecisionDriver` surface (`packages/ai-runner/src/decision/types.ts`) and delegates all validation to `validateQuestions` / `validateAnswers` (`packages/ai-runner/src/decision/validation.ts`).

## Key decisions

- **Mirror decision-gemini, not decision-clef**: the two ADR-042 packages are twins sharing the same `QUESTION_ID_PATTERN` (`^[A-Za-z0-9_.-]{1,100}$`), 13 MiB request / 8 MiB response caps, 30 s default timeout, dual response envelopes (`{answers}` / `{result:{answers}}`), keyed-object and array answer shapes, and map-or-`{value,probability}[]` distributions. Reviewers can diff the packages line by line; only the provider deltas differ.
- **Provider deltas from the frozen task/design**:
  - `Authorization: Bearer <apiKey>` header instead of `x-goog-api-key`.
  - `POST /v1/decisions` on default base `https://api.openai.com` (gemini: `/v1beta/decisions` on `generativelanguage.googleapis.com`).
  - `MAX_QUESTIONS = 400` per task R3 ("question count (1–400)"), while gemini allows 1000 — the limit is per-provider, enforced locally before any transport.
  - HTTP 408 maps to `DecisionTimeoutError` per the design's shared error-mapping contract (`408`/timeout → timeout); the transport timeout path still carries `timeoutMs`, the 408 path carries the status.
  - Driver `name: 'openai-luna'`, model union `OpenAIDecisionModel = 'gpt-6-luna'`, factory `createOpenAIDecisionDriver(options)`.
- **No env reads, no drizzle, no platform APIs**: identical policy to the twin — explicit constructor args only; transport via `@gobing-ai/ts-infra` `APIClient.rawRequest`; untrusted transport error text is never leaked into typed errors.
- **Boundary rules**: three new rules in `.spur/rules/typescript/decision-boundaries.yaml` (`no-openai-driver-import-in-ai-runner`, `no-ai-decision-import-in-decision-openai`, `no-openai-dependency-in-ai-runner-manifest`), mirroring the gemini triplet; fixture verifier needs no new fixtures because it asserts declared pairs only.
- **Tsconfig**: per-package base tsconfig with transitive `paths` to sibling sources plus a `paths: {}` build variant (ADR-004/ADR-012), same as the twin.

## Verification

- Package: `bun run typecheck` clean; `bun run test` 37 pass / 0 fail (153 expect calls) including the new `[408, DecisionTimeoutError, '408']` status-mapping case and `Authorization: Bearer` header capture.
- Workspace: `bun run lint` clean; root `bun run build` all packages exit 0; `bun run spur-check` 3274 tests / 0 fail across 261 files, both rule presets clean, rule fixtures 62/62 across 6 sets.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 Package `@gobing-ai/ts-decision-openai` with `createOpenAIDecisionDriver(options): DecisionDriver`, driver name `openai-luna`, per-package tsconfigs, no platform API/env reads, docs row | MET | `packages/decision-openai/src/driver.ts:260` (`name: 'openai-luna'`), factory at `packages/decision-openai/src/driver.ts:203`; `grep -rn "process.env\|node:\|Bun.spawn\|Bun.which" src/` clean; `packages/decision-openai/tsconfig.json` + `tsconfig.build.json` exist; `docs/design/package-exports.md` row for `ts-decision-openai`; `bun.lock` records the workspace package |
| R2 GPT-6 Luna wire mapping: `state ?? ''` as `input`, noul/choice/score mapping, `POST /v1/decisions` with `Authorization: Bearer`, dual envelopes/shapes, map-or-array distributions, per-call model override | MET | `packages/decision-openai/src/driver.ts:346` (POST /v1/decisions), `:348` (Bearer header), `:409-415` (dual envelope `json.answers` / `json.result.answers`), distribution normalization and `validateAnswers` fail-closed via `validateQuestions`/`validateAnswers` imports at `packages/decision-openai/src/driver.ts:14-15`; model override test `packages/decision-openai/tests/driver.test.ts:228-232` |
| R3 Limits + taxonomy: 1..400 questions, ID pattern, 2..255 entries, 13 MiB request / 8 MiB response, 401/403 auth, 429 + Retry-After, 400/422 request, 408+timeout, network, 5xx/malformed/refusal | MET | `packages/decision-openai/src/driver.ts:38` (`MAX_QUESTIONS = 400`), `:39-40` (13/8 MiB caps), `:341` (request-size rejection), `:372` (408 → DecisionTimeoutError), `:381-382` (429 + retryAfterMs); error classes imported at `:3-15`; taxonomy tests `packages/decision-openai/tests/driver.test.ts:391-410` |
| R4 Registry integration + boundary rules | MET | `packages/decision-openai/tests/registry.test.ts` (maker `openai-hosted`, lazy/memoized, hub routing, no built-in change — `:64`, `:73`, `:91`); three new rules `no-openai-driver-import-in-ai-runner`, `no-ai-decision-import-in-decision-openai`, `no-openai-dependency-in-ai-runner-manifest` in `.spur/rules/typescript/decision-boundaries.yaml` (decision-boundaries set PASS, 6 fixtures) |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 Package mirrors decision-gemini twin with provider deltas (Bearer, /v1/decisions, gpt-6-luna, openai-luna, 1..400) and passes typecheck/tests | MET | test | `packages/decision-openai` `bun run typecheck` clean; `bun run test` 37 pass / 0 fail (153 expect calls), including 408 status case `tests/driver.test.ts:397` and header capture `tests/driver.test.ts:128` |
| AC2 Boundary rules extended with the openai triplet; doc surfaces synced | MET | command | `bun run spur-check` — decision-boundaries fixture set PASS with the openai triplet (`.spur/rules/typescript/decision-boundaries.yaml:217` `:229` `:241`), both rule presets clean; doc rows verified by the same tree the gate ran on: `docs/design/package-exports.md:22`, `AGENTS.md:24`, `README.md:39` `:86` |
| AC3 Workspace gate green with the new package | MET | command | `bun run lint` exit 0; `bun run build` all packages exit 0; `bun run spur-check`: 3274 pass / 0 fail across 261 files, rule presets clean, fixtures 62/62 across 6 sets |
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

- 2026-11-18T03:58:24.189Z todo → wip (system)
- 2026-11-18T03:59:56.836Z wip → testing (system)
- 2026-11-18T04:05:48.118Z testing → done (system)

