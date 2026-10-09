# @gobing-ai/ts-decision-clef

Hosted Cloudflare Clef decision backend for the neutral decision surface
owned by `@gobing-ai/ts-ai-runner`: answers `choice` / `score` / `noul`
questions through Cloudflare Workers AI REST API over the portable
`@gobing-ai/ts-infra` `APIClient` seam ([ADR-037](../../docs/00_ADR.md)).

Part of the `@gobing-ai/ts-libs` monorepo and lockstep-versioned with it.

- **License:** Apache-2.0 (see [LICENSE](./LICENSE)).
- **No model weights or third-party SDKs are bundled.** It drives Cloudflare Workers AI
  REST directly via `@gobing-ai/ts-infra`.

---

## Usage

```ts
import { createDecisionMaker } from '@gobing-ai/ts-ai-runner';
import { createClefDriver } from '@gobing-ai/ts-decision-clef';

const driver = createClefDriver({
    accountId: '0123456789abcdef0123456789abcdef',
    apiToken: 'cf_api_token_secret',
    model: 'clef-flash', // default; or 'clef'
});

const dm = createDecisionMaker({ driver });

const answers = await dm.ask({
    state: 'Customer was billed twice for invoice INV-42.',
    questions: {
        sentiment: {
            kind: 'choice',
            prompt: 'Sentiment of the message',
            labels: { positive: 'Praise', negative: 'Complaint' },
        },
        priority: {
            kind: 'score',
            prompt: 'Queue priority',
            rubric: ['Routine — normal SLA', 'Critical — customer blocked'],
        },
        refund: { kind: 'noul', prompt: 'Refund the duplicate charge?' },
    },
});
```

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `accountId` | required | Cloudflare Account ID (32-character hexadecimal string). |
| `apiToken` | required | Cloudflare API Token (no whitespace or control characters). |
| `model` | `'clef-flash'` | Default model selector (`'clef'` \| `'clef-flash'`). |
| `timeoutMs` | `30000` | Request timeout in milliseconds (positive integer). |
| `fetch` | `globalThis.fetch` | Custom fetch implementation (injected for tests). |

---

## Provider constraints

1. **Question limits:** 1–64 questions per request.
2. **Question IDs:** must match `/^[A-Za-z0-9_.-]{1,100}$/`.
3. **Choice options:** 2–255 non-empty choice label keys per question.
4. **Score levels:** 2–10 rubric levels per question.
5. **JSON serializability:** `state` and question contents must be strict JSON values. Cycles, non-finite numbers (`NaN`, `Infinity`), `BigInt`, `undefined`, functions, symbols, sparse arrays, hidden or extra array properties, accessors, and custom object instances (e.g. `Date`) are rejected before transport with `DecisionRequestError`.
6. **Payload bounds:** request bodies cannot exceed 13 MiB; responses exceeding 8 MiB are rejected with `DecisionBackendError`.
7. **Instructions fallback:** when a question prompt is omitted, null, or empty whitespace, the question ID is used as the instructions field.

---

## Errors

All failures map to the `@gobing-ai/ts-ai-runner` decision error taxonomy:

| Condition | Class |
|-----------|-------|
| Invalid account ID, API token, timeout, or model at construction | `DecisionConfigError` |
| Invalid question structure, ID format, limits, un-serializable state, body > 13 MiB, or HTTP 4xx | `DecisionRequestError` |
| HTTP 401 / 403 | `DecisionAuthError` |
| HTTP 429 (preserves `Retry-After` hint in ms) | `DecisionRateLimitError` |
| Request timeout | `DecisionTimeoutError` |
| Network or connection failure | `DecisionConnectionError` |
| HTTP 5xx, redirects, malformed JSON, envelope failure, missing model, response > 8 MiB | `DecisionBackendError` |

Error messages are redacted: credentials, state, and untrusted upstream text are never exposed.

---

## Release and bootstrap

Releases are lockstep and automated via GitHub Actions OIDC Trusted Publishing.
For initial package bootstrap on npm, refer to [docs/PACKAGE_RELEASE.md](../../docs/PACKAGE_RELEASE.md#2-publish-the-first-version-manually):

```bash
bun scripts/builder.ts publish-packages --bootstrap @gobing-ai/ts-decision-clef
```
