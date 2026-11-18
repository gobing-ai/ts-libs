# @gobing-ai/ts-decision-gemini

Google Gemini Decision 1 decision backend for the neutral decision surface
owned by `@gobing-ai/ts-ai-runner`: answers `choice` / `score` / `noul`
questions through the hosted Gemini Decisions API over the portable
`@gobing-ai/ts-infra` `APIClient` seam ([ADR-042](../../docs/00_ADR.md)).

Part of the `@gobing-ai/ts-libs` monorepo and lockstep-versioned with it.

- **License:** Apache-2.0 (see [LICENSE](./LICENSE)).
- **No model weights or third-party SDKs are bundled.** It drives the Gemini
  Decisions REST API directly via `@gobing-ai/ts-infra`.

---

## Usage

```ts
import { createDecisionMaker } from '@gobing-ai/ts-ai-runner';
import { createGeminiDecisionDriver } from '@gobing-ai/ts-decision-gemini';

const driver = createGeminiDecisionDriver({
    apiKey: 'google_api_key_secret',
    model: 'gemini-decision-1', // default; the only hosted selector today
});

const dm = createDecisionMaker({ driver });

const answers = await dm.ask({
    state: { ticket: 'Billing portal 500s on invoice download' },
    questions: {
        triage: {
            kind: 'choice',
            prompt: 'Route this ticket',
            labels: { bug: 'Broken behavior', billing: 'Money related' },
        },
        severity: {
            kind: 'score',
            prompt: 'How severe is this?',
            rubric: ['low', 'medium', 'high'],
        },
        escalate: {
            kind: 'noul',
            prompt: 'Escalate to on-call?',
            yes: 'page the on-call',
            no: 'queue for business hours',
        },
    },
});
// answers.triage: { kind: 'choice', label, confidence, probabilities }
// answers.severity: { kind: 'score', score, confidence, legend, probabilities }
// answers.escalate: { kind: 'noul', probability }
```

### Options

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | yes | — | Google API key; sent as `x-goog-api-key`. Blank, whitespace, or control characters are rejected. |
| `model` | no | `'gemini-decision-1'` | The only hosted selector today; per-call `ask({ model })` wins. |
| `baseURL` | no | Gemini endpoint | `http:`/`https:` origin only; no credentials, query, or hash. |
| `timeoutMs` | no | `30000` | Positive integer; a single request budget. |
| `fetch` | no | global | Injected transport for tests. |

### Environment policy

The driver reads **no environment variables** — credentials and endpoints are
always explicit constructor arguments, matching the `decision-clef` /
`decision-fm` pattern. Compose them yourself if you source keys from the
environment.

## Wire contract

- `POST {baseURL}/v1beta/decisions`, JSON body
  `{ model, input, questions: { <id>: { type, instructions, criteria } } }`.
- Question constraints: `1..1000` questions, IDs matching
  `^[A-Za-z0-9_.-]{1,100}$`, `2..255` choice labels or score levels.
- Request bodies above 13 MiB and responses above 8 MiB are rejected before
  parsing (same caps as `decision-clef`).
- The response parser accepts both envelope shapes (`{ answers }` and
  `{ result: { answers } }`) and both answer shapes (keyed object and
  `[{ name, type, ... }]` entries); distributions may be maps or
  `{ value, probability }[]`. Anything else fails closed through
  `validateAnswers`.

## Error taxonomy

Errors come from `@gobing-ai/ts-ai-runner` and mirror `decision-clef`:

- `DecisionConfigError` — invalid construction options (`field` names the offender).
- `DecisionRequestError` — invalid caller input (questions, state, model) or 4xx.
- `DecisionAuthError` — HTTP 401/403.
- `DecisionRateLimitError` — HTTP 429, with `retryAfterMs` when `Retry-After` parses.
- `DecisionTimeoutError` — transport timeout (`timeoutMs` field).
- `DecisionConnectionError` — network failure.
- `DecisionBackendError` — 5xx, malformed responses, oversized payloads, unknown answer types.

## Registry integration

The driver is a plain `DecisionDriver`; register a named maker in a
`DecisionMakerRegistry` (built via `createDecisionMaker({ driver })`) and the
`DecisionHub` resolves it lazily and memoizes it like any built-in.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
