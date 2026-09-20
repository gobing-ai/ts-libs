# DecisionMaker

Provider-neutral structured-decision surface in `@gobing-ai/ts-ai-runner`. Callers get typed
judgments — a selected label, a rubric score, or a yes-probability — instead of free
text they must parse. The only current backend driver wraps `@typesafe-ai/sdk` (TypeSafe AI's Jev /
System One family); the driver seam exists so traditional-LLM and local-model backends can land
without touching callers.

Runtime validation establishes answer shape and correspondence, not empirical calibration. Consuming
applications own evidence selection, acceptance policy, fallback, and quality evaluation. In particular,
Spur owns its optional DecisionMaker HITL responder integration; the workflow engine remains independent
of ai-runner (ADR-026).

Feature: [A2](../features/A2_provider-neutral-decisionmaker-over-typesafe-jev-in-ts-ai-runner.md).

## Core design decision: drivers implement only `ask()`

`DecisionMaker` (public, 4 members) and `DecisionDriver` (internal seam, 1 member) are
**separate types**:

```
caller ──> DecisionMaker ──────────────────────────> DecisionDriver ──> backend
           ask()      ─── passthrough ────────────>  ask()
           choice()   ─┐
           score()    ─┼─ wrap one question, unwrap ─┘
           noul()     ─┘  one answer  (written ONCE, here)
```

`choice` / `score` / `noul` are *not* part of the driver contract. They are implemented exactly
once in the facade as `ask()` with a single-entry question map, unwrapping the single answer. A
driver therefore implements **one** method.

This is what makes the deferred drivers (I11) cheap and is the direct answer to premise **P4**: a
future local-model driver needs to satisfy one batch entry point, not re-derive three conveniences.
It also means the sugar can never drift from the batch path — there is only one code path.

## Module layout

New directory `packages/ai-runner/src/decision/`, matching the existing `src/agents/` precedent:

| File | Owns |
|---|---|
| `types.ts` | Provider-neutral state / question / answer types, the `q` question builders, `DecisionDriver` |
| `decision-maker.ts` | `DecisionMaker`, `createDecisionMaker()`, the three sugar methods over `ask()` |
| `typesafe-driver.ts` | `DecisionDriver` over `@typesafe-ai/sdk`; neutral ⇄ SDK mapping; the only file importing the SDK |
| `errors.ts` | `DecisionError` taxonomy + SDK-error mapping |
| `validation.ts` | Shared runtime question and answer validation for default and custom drivers |

Barrel re-exports from `src/index.ts`. Tests in `packages/ai-runner/tests/decision/`.

## Provider-neutral types

Deliberately **not** re-exported from the SDK — re-exporting its types would make callers bind to
the vendor and deliver no independence (I3). Neutral vocabulary (`kind`, `labels`, `rubric`,
`probability`) keeps the mapping explicit and reviewable in one file.

```ts
type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
type DecisionState = string | Json[] | { [k: string]: Json } | null
type Desc = string | Json[] | { [k: string]: Json } | null   // null = label left undescribed

type ChoiceQuestion<L extends string> = { kind: 'choice'; prompt?: Desc; labels: Record<L, Desc> }
type ScoreQuestion                    = { kind: 'score';  prompt?: Desc; rubric: readonly [Desc, Desc, ...Desc[]] }
type NoulQuestion                     = { kind: 'noul';   prompt?: Desc; yes?: Desc; no?: Desc }
type Question = ChoiceQuestion<string> | ScoreQuestion | NoulQuestion

type ChoiceAnswer<L extends string> = {
  kind: 'choice'; label: L; confidence: number; probabilities: Record<L, number>
}
type ScoreAnswer = {
  kind: 'score'; score: number; confidence: number
  legend: Record<number, Desc>; probabilities: Record<number, number>
}
type NoulAnswer = { kind: 'noul'; probability: number }   // no confidence — the API returns none (R4)

type AnswerFor<Q> =
  Q extends ChoiceQuestion<infer L> ? ChoiceAnswer<L> :
  Q extends ScoreQuestion ? ScoreAnswer :
  Q extends NoulQuestion ? NoulAnswer : never
type AnswersFor<Q extends Record<string, Question>> = { readonly [K in keyof Q]: AnswerFor<Q[K]> }
```

`NoulAnswer` having no `confidence` is a load-bearing constraint, not an omission: the wire
response carries only a probability, and synthesizing a confidence would fabricate calibration
data. R4 pins this.

### Question builders

`q.choice` / `q.score` / `q.noul` build questions for the batch path. Namespaced under `q` to
avoid colliding with the identically-named `DecisionMaker` methods.

```ts
export const q = {
  choice: <const L extends string>(prompt: Desc, labels: Record<L, Desc>): ChoiceQuestion<L> => …,
  score:  (prompt: Desc, rubric: readonly [Desc, Desc, ...Desc[]]): ScoreQuestion => …,
  noul:   (prompt?: Desc, outcomes?: { yes?: Desc; no?: Desc }): NoulQuestion => …,
}
```

## The two contracts

```ts
interface DecisionDriver {                       // internal seam — 1 member
  readonly name: string
  ask(req: { state: DecisionState; questions: Record<string, Question>; model?: string }):
    Promise<Record<string, ChoiceAnswer<string> | ScoreAnswer | NoulAnswer>>
}

interface DecisionMaker {                        // public surface — 4 members
  readonly driver: string
  ask<const Q extends Record<string, Question>>(
    req: { state: DecisionState; questions: Q; model?: string }): Promise<AnswersFor<Q>>
  choice<const L extends string>(
    state: DecisionState, prompt: Desc, labels: Record<L, Desc>): Promise<ChoiceAnswer<L>>
  score(state: DecisionState, prompt: Desc,
    rubric: readonly [Desc, Desc, ...Desc[]]): Promise<ScoreAnswer>
  noul(state: DecisionState, prompt?: Desc,
    outcomes?: { yes?: Desc; no?: Desc }): Promise<NoulAnswer>
}

function createDecisionMaker(options?: DecisionMakerOptions): DecisionMaker
```

The driver's looser return type is narrowed to `AnswersFor<Q>` after runtime validation at the facade
boundary. Question names and kinds, allowed labels, probability/legend keys, finite numeric bounds,
and zero-indexed score range are checked for both default and custom drivers. The TypeSafe driver also
checks its decoded response before returning it. Malformed questions raise `DecisionRequestError`;
malformed answers raise `DecisionBackendError`. Dictionary construction preserves arbitrary own keys.

```ts
interface DecisionMakerOptions {
  driver?: DecisionDriver                          // default: TypeSafe driver (R1, R8)
  env?: Record<string, string | undefined>         // default: getProcessEnv() — matches doctor-runner.ts:107
  apiKey?: string                                  // explicit override, wins over env
  model?: string                                   // default: SDK default, jev-latest
  baseURL?: string
  timeoutMs?: number
  maxRetries?: number
  fetch?: typeof fetch                             // injected for tests (R7)
}
```

## Caller-facing shape

```ts
const dm = createDecisionMaker()

// batch — one request, three questions, state sent once (R2)
const a = await dm.ask({
  state: ticket,
  questions: {
    category: q.choice('What is this ticket about?', { billing: null, technical: null, other: null }),
    urgency:  q.score('How urgent is it?', ['not urgent', 'this week', 'immediate']),
    refund:   q.noul('Is the customer asking for a refund?'),
  },
})
a.category.label      // 'billing' | 'technical' | 'other'  — inferred from the labels
a.urgency.score       // number
a.refund.probability  // number

// sugar — one question, one request (R3)
const cat = await dm.choice(ticket, 'What is this ticket about?',
  { billing: null, technical: null, other: null })
```

## TypeSafe driver mapping

Sole importer of `@typesafe-ai/sdk`. Constructs `new TypeSafeClient({ apiKey, baseURL, timeout,
retry, fetch, defaultModel })` once per driver instance and calls
`client.systemOne({ state, questions, model? })` once per `ask()`.

| Neutral | SDK |
|---|---|
| `q.choice(prompt, labels)` | `choice(prompt, labels)` → `ChoiceQuestion` |
| `q.score(prompt, rubric)` | `score(prompt, rubric)` → `ScoreQuestion` |
| `q.noul(prompt, {yes,no})` | `noul(prompt, { true: yes, false: no })` → `NoulQuestion` |
| `ChoiceAnswer` | `ChoiceResponse` → `{ label: r.choice, confidence, probabilities }` |
| `ScoreAnswer` | `ScoreResponse` → `{ score, confidence, legend, probabilities }` |
| `NoulAnswer` | `NoulResponse` → `{ probability: r.noul }` (drops nothing; adds nothing) |

`SystemOneResult.usage` and `.model` are not surfaced in v1 — noted as a deliberate omission, easy
to add behind an options flag if a consumer needs cost accounting.

### Key resolution (R5, R6)

```ts
const env = options.env ?? getProcessEnv()                    // ts-runtime; gateway-backed
const apiKey = options.apiKey ?? env.TYPESAFE_API_KEY
if (!apiKey) throw new DecisionConfigError('Missing TYPESAFE_API_KEY', 'TYPESAFE_API_KEY')  // before any fetch (R6)
```

`apiKey` is always passed **explicitly** to `TypeSafeClient`, so the SDK's own
`TYPESAFE_API_KEY` self-resolution never runs. No file in this feature touches `process.env` —
`env-var-hygiene` (`.spur/rules/typescript/env-var-hygiene.yaml`) forbids it outside
`packages/utils/src/env.ts`, and the injected-record form is the sanctioned pattern.

## Error taxonomy (R9)

`DecisionError` base; no raw SDK error class escapes the default driver, including question-builder
errors. Exceptions thrown by a custom driver itself still propagate.

| SDK | Package | Carries |
|---|---|---|
| `AuthenticationError` / `PermissionDeniedError` | `DecisionAuthError` | status |
| `RateLimitError` | `DecisionRateLimitError` | status, `retryAfterMs` |
| `APITimeoutError` | `DecisionTimeoutError` | `timeoutMs` |
| `APIConnectionError` | `DecisionConnectionError` | cause |
| `BadRequestError` / `UnprocessableEntityError` | `DecisionRequestError` | status, body summary |
| `InternalServerError` | `DecisionBackendError` | status |
| — (missing key) | `DecisionConfigError` | variable name |

## Dependency & boundary

`packages/ai-runner/package.json` gains `"@typesafe-ai/sdk": "0.6.0"` — exact, no caret, per the
approved gate decision. External package, so no `tsconfig` `paths` entry is needed (ADR-004/012
govern workspace siblings only).

New `.spur/rules/typescript/decision-boundaries.yaml`, modelled on `no-drizzle-import-outside-db-package`:

```yaml
rules:
  - id: no-typesafe-sdk-import-outside-ai-runner
    description: "@typesafe-ai/sdk is an internal detail of @gobing-ai/ts-ai-runner's TypeSafe
      DecisionMaker driver. No other package may import it — consume the DecisionMaker facade
      instead (ADR-005/ADR-006 precedent)."
    severity: error
    evaluator:
      type: forbidden-import
      config:
        forbidden:
          - specifier: "@typesafe-ai/sdk"
        scope:
          include: ["packages/**/src/**/*.ts"]
          exclude: ["packages/ai-runner/src/decision/typesafe-driver.ts", "**/tests/**", "**/*.test.ts", "**/dist/**"]
```

Scoped to the single driver file rather than the whole package, so even a sibling `ai-runner`
module has to go through the seam.

## Test strategy

All tests run against an injected `fetch` returning recorded `systemOne` payloads — no network, no
live key (R7). Per-file line coverage ≥ 90% (`.spur/rules/quality/coverage-gate.yaml`).

| Test | Proves |
|---|---|
| batch request shape | one request; state once; three questions keyed as given (R2) |
| sugar request shape | one request, exactly one question, unwrapped answer (R3) |
| answer decoding | choice/score/noul field-for-field; `NoulAnswer` has no `confidence` key (R4) |
| key injection | key from injected record; `apiKey` reaches the client; no `process.env` read (R5) |
| missing key | rejects `DecisionConfigError`; injected fetch never called (R6) |
| option pass-through | model/timeout/retry/baseURL reach client config (R7) |
| driver substitution | a fake driver with no SDK import satisfies all four members unchanged (R8) |
| error mapping | each SDK failure → its package error with status/retry-after (R9) |
| gate | exact pin present; boundary rule fires on a planted foreign import (R10) |

## Deliberate omissions

- `client.models.list()` — no consumer.
- `usage` / cost accounting — add behind an option when someone needs it.
- Streaming, browser use, custom logger — out of scope.
- No new ADR: the dependency boundary rides existing ADR-005/ADR-006 precedent via the spur rule.
  Flag for approval if you would rather have a dated ADR entry for the first outbound-LLM-API
  runtime dependency in the workspace.
