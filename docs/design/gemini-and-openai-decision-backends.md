---
name: Gemini Decision 1 and GPT-6 Luna decision backends
status: planned
updated_at: 2026-11-17
adr: ADR-042
feature: O3
---

# Gemini Decision 1 and GPT-6 Luna Decision Backends

Planned in feature O3. Decision: ADR-042. Packages: `packages/decision-gemini` and `packages/decision-openai`.

## Exports

### `@gobing-ai/ts-decision-gemini`

```typescript
export type GeminiDecisionModel = 'gemini-decision-1';
export interface GeminiDecisionDriverOptions {
    apiKey: string;
    model?: GeminiDecisionModel; // default: 'gemini-decision-1'
    baseURL?: string;            // default: 'https://generativelanguage.googleapis.com'
    timeoutMs?: number;          // default: 30_000; positive finite integer
    fetch?: typeof globalThis.fetch;
}
export function createGeminiDecisionDriver(options: GeminiDecisionDriverOptions): DecisionDriver;
```

- Driver `name`: `'gemini-decision'`.
- Transport: `APIClient` (`@gobing-ai/ts-infra`) sending `POST /v1beta/decisions` with header `x-goog-api-key: <apiKey>`.

### `@gobing-ai/ts-decision-openai`

```typescript
export type OpenAIDecisionModel = 'gpt-6-luna';
export interface OpenAIDecisionDriverOptions {
    apiKey: string;
    model?: OpenAIDecisionModel; // default: 'gpt-6-luna'
    baseURL?: string;            // default: 'https://api.openai.com'
    timeoutMs?: number;          // default: 30_000; positive finite integer
    fetch?: typeof globalThis.fetch;
}
export function createOpenAIDecisionDriver(options: OpenAIDecisionDriverOptions): DecisionDriver;
```

- Driver `name`: `'openai-luna'`.
- Transport: `APIClient` (`@gobing-ai/ts-infra`) sending `POST /v1/decisions` with header `Authorization: Bearer <apiKey>`.

## Shared Contract & Validation

- Credentials are explicit and never read from `process.env` directly inside the driver.
- Reject blank `apiKey`, whitespace/control characters in `apiKey`, invalid `baseURL`, non-positive/non-integer `timeoutMs`, or unsupported configured `model` at construction with `DecisionConfigError` (naming the field without leaking its value).
- Validate outgoing questions via `validateQuestions` and incoming answers via `validateAnswers` from `@gobing-ai/ts-ai-runner`.
- Map HTTP/transport errors (`401`/`403` -> `DecisionAuthError`, `429` -> `DecisionRateLimitError`, `400`/`422` -> `DecisionRequestError`, `408`/timeout -> `DecisionTimeoutError`, network -> `DecisionConnectionError`, `5xx`/malformed response/refusal -> `DecisionBackendError`).

## Wire Mapping

- `state ?? ''` is sent as `input` (string, JSON array, or JSON object).
- `questions`:
  - `noul`: `{ type: 'noul', instructions, criteria? }` -> `NoulAnswer { kind: 'noul', probability }` (no `confidence` synthesized).
  - `choice`: `{ type: 'choice', instructions, criteria: Record<string, string> }` -> `ChoiceAnswer { kind: 'choice', label, confidence, probabilities }`.
  - `score`: `{ type: 'score', instructions, criteria / levels }` -> `ScoreAnswer { kind: 'score', score, confidence, legend, probabilities }`.

## Composition

- `createDecisionMaker({ driver: createGeminiDecisionDriver(opts) })`
- `createDecisionMaker({ driver: createOpenAIDecisionDriver(opts) })`
- `DecisionMakerRegistry.register('gemini-decision', ...)` / `DecisionMakerRegistry.register('openai-luna', ...)`
