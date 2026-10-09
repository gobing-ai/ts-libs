---
name: Clef decision backend
status: built
updated_at: 2026-10-09
adr: ADR-037
feature: A3
---

# Clef decision backend

Implemented in feature A3. Decision: ADR-037. Package: `packages/decision-clef`.

## Exports

```typescript
export type ClefModel = 'clef' | 'clef-flash';
export interface ClefDriverOptions {
    accountId: string;
    apiToken: string;
    model?: ClefModel;          // default: clef-flash
    timeoutMs?: number;         // default: 30_000; positive finite integer
    fetch?: typeof globalThis.fetch;
}
export function createClefDriver(options: ClefDriverOptions): DecisionDriver;
```

Driver name: `clef`. Credentials are explicit and never read from process.env.
Reject blank credentials, whitespace/header control characters in token,
account IDs outside Cloudflare's 32-hex format, invalid timeout or invalid
configured model at construction using `DecisionConfigError`. Error messages
identify the field without including its value. No network call at construction.

The ai-runner barrel additionally exports its existing `validateQuestions`
and `validateAnswers` functions; no duplicate neutral validation implementation.
No vendor SDK types enter these signatures.

## Composition

Construct `createDecisionMaker({ driver: createClefDriver(options) })`.
For catalogs, register a lazy factory under `clef` through
`DecisionMakerRegistry.register`. Built-in maker lists and ai-runner backend
selection remain unchanged; no environment mapping or auto-discovery is added.
The factory's model is the default and `ask({ model })` takes precedence.
Only the short selectors above are accepted; aliases fail before HTTP.

## Request

Fixed base URL: `https://api.cloudflare.com/client/v4`. POST to
`/accounts/<accountId>/ai/run/@cf/cloudflare/<model>`; send
`Authorization: Bearer <apiToken>` and `Content-Type: application/json`.
Use one `APIClient` per driver and `rawRequest` with manual redirects,
the configured timeout and an 8 MiB response cap. A truncated response fails.
No retry loop or alternate origin is supplied.

Body: `{ model, state, questions }`; preserve text/JSON state and question IDs.
Check state for JSON-serializability and reject cycles/nonfinite values before
transport with `DecisionRequestError`; null remains supported by the neutral
contract. A whole-body encoded size above the documented 13 MiB cap also fails
before HTTP. No image/video fields are generated.

| Neutral question | Clef question |
|------------------|---------------|
| choice: prompt, labels | type: choice, instructions, criteria: labels |
| score: prompt, rubric | type: score, instructions, criteria: rubric |
| noul: prompt, yes/no | type: noul, instructions, optional criteria.true/false |

Hosted schemas require instructions. Use the question ID when prompt is
undefined, null or an empty/whitespace string; otherwise preserve the supplied
string/object/array. Omit absent binary outcome keys; preserve explicit null.
Shared validation runs first; additionally enforce 1–64 questions, IDs matching
`^[A-Za-z0-9_.-]{1,100}$`, 2–255 nonempty choice IDs, and 2–10 score levels.

## Response

Require a JSON object REST envelope with `success: true` and an object `result`.
Read `result.answers` as unknown, safely discriminate each answer, then map:

| Clef answer | Neutral answer |
|-------------|----------------|
| type: choice, choice, confidence, probabilities | kind: choice, label, confidence, probabilities |
| type: score, score, confidence, legend, probabilities | kind: score with remaining fields unchanged |
| type: noul, noul | kind: noul, probability |

Require the result's model to be a nonempty string. The published output schema
does not guarantee an exact echo of the requested short selector. Validate the mapped
answers with the shared validator: exact names/kinds, legal label and level keys,
finite probabilities/confidence in [0,1], mass within 1e-6, and bounded score.
Preserve fractional scores and provider confidence. No argmax, rounding,
probability resampling or invented noul confidence. Model/usage are not exposed
through the neutral answer contract.

## Errors

| Failure | Existing class |
|---------|----------------|
| Missing/invalid factory options | DecisionConfigError |
| Invalid request/model/provider limit/serialization | DecisionRequestError |
| HTTP 401/403 | DecisionAuthError |
| HTTP 429 | DecisionRateLimitError |
| Other HTTP 4xx | DecisionRequestError |
| HTTP 5xx, redirects or unexpected status | DecisionBackendError |
| APIClient APIError status 0 | DecisionTimeoutError |
| Other transport failure | DecisionConnectionError |
| JSON/envelope/model/answer/truncation failure | DecisionBackendError |

For 429, parse Retry-After seconds or HTTP date to nonnegative milliseconds;
missing/invalid hint stays undefined. HTTP error messages carry status and
generic category only. Never include token, serialized state, raw upstream body
or untrusted transport error text/cause in public errors. On 2xx with
`success: false`, use DecisionBackendError; do not infer status from vendor codes.
Nothing fabricates a fallback answer; consumer policy remains above the driver.

## Implementation reach and checks

- New package manifest, index/driver, tests/fixtures, README, LICENSE/NOTICE,
  tsconfig/build config and Bun lock; use existing discovery-based builder.
- Runtime deps use workspace:* and TypeScript paths cover ai-runner/infra and
  their actual transitive source closure. No hand-maintained published ranges.
- Registry/DecisionHub integration tests declare ts-ai-decision as a workspace:*
  devDependency and include its source closure in test paths; runtime dependencies
  remain ai-runner and infra. Build config clears paths as sibling packages do.
- Export shared validators from ai-runner and test their public reuse.
- Extend decision boundary rules and focused rule fixtures for reverse imports
  and the catalog direction; HTTP continues under the existing APIClient rule.
- Update root package index, package export design, shared validation docs and
  AGENTS package facts only when implementation exists. Release plumbing stays
  unchanged; document new-package bootstrap without running it.
- Offline injected-fetch tests cover both routes, all question kinds/convenience
  methods, fractional scores, null/fallback prompts, limits, malformed responses,
  each error class, timeout, Retry-After, redaction and registry composition.
- Final implementation gates: `bun run spur-check`, `bun run build`, intentional
  git diff. No live test or credentials required for offline acceptance.

## Ready-depth refinements (2026-10-09)

State and the mapped body accept JSON values only: finite scalar values, null,
dense arrays and plain/null-prototype objects. Reject cycles, undefined,
functions, symbols, BigInt, sparse arrays and custom object instances before
transport; JSON.stringify alone would lose or coerce some of them. Existing
neutral validator bodies remain unchanged. Size is measured in UTF-8 bytes;
the 8 MiB response cap is adapter policy, distinct from the provider request cap.

Use safe own-property mapping for names such as `__proto__`. Exercise the real
APIClient through injected fetch and real Response fixtures; do not mock away
timeout, redirect or body-limit behavior. Timeout fixtures wait for AbortSignal
and reject DOMException AbortError. Decode JSON outside the transport catch so
bad JSON maps to DecisionBackendError. HTTP error text/cause remains generic
and redacted. The task records named test files and requirement-to-plan mapping.

## Source contracts

Verified 2026-10-09 against primary sources. Cloudflare's hosted schemas govern
hosted behavior where model-card prose differs.

- [Announcement](https://blog.cloudflare.com/clef-decision-models/)
- [Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
- [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
- [Input schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json)
- [Output schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json)
- [REST envelope](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [Clef model card](https://huggingface.co/Cloudflare/clef)
- [Flash model card](https://huggingface.co/Cloudflare/clef-flash)
