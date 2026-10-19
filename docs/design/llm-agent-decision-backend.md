---
name: LLM agent decision backend and sampled-driver core
status: implemented
updated_at: 2026-10-19
adr: ADR-038, ADR-039
feature: O1
---

# LLM agent decision backend and sampled-driver core

Built for feature O1 (ADR-038, ADR-039; tasks 0114-0116). Packages: `packages/ai-runner` (core),
`packages/decision-fm` (refactor), `packages/ai-decision` (agent driver, TypeSafe driver, registry).

## Package graph after feature O1

```text
ts-ai-decision ──► ts-decision-fm ──► ts-ai-runner (contract + sampled core)
      │        ──► ts-laya-mlx    ──►      ▲
      │        ──► @typesafe-ai/sdk         │
      └────────────────────────────────────┘
ts-decision-clef ──► ts-ai-runner, ts-infra
ts-ai-runner ··(dynamic import, deprecated)··► ts-ai-decision   (typesafe bridge only)
```

No static edge points into a driver package from `ts-ai-runner`.

## Sampled-driver core (`ts-ai-runner/src/decision/sampled-driver.ts`)

Pure module: imports only sibling `types`, `errors`. Exported from the `ts-ai-runner` barrel.

```typescript
/** One ask's sampling session; opened once per ask, closed in `finally`. */
export interface SampleSession {
    /** Return one sample as a key → option-string record (parsed, not yet enum-checked). */
    sample(): Promise<Record<string, string>>;
    /** Release per-ask resources (temp schema file, scratch dir). Called on success and failure. */
    close?(): void | Promise<void>;
}

export interface SampledDriverOptions {
    readonly name: string;
    /** Samples per ask. Default 5. Ignored when `deterministic`. Positive integer. */
    readonly samples?: number;
    /** One sample; the sampler is expected to decode greedily. Default false. */
    readonly deterministic?: boolean;
    /** Max samples in flight. Default 1 (sequential). */
    readonly concurrency?: number;
    /** Prefix used in enum-violation messages. Default: `name`. fm passes `'fm'`. */
    readonly sampleLabel?: string;
    /** Open the per-ask session. Receives the rendered texts and the validated request. */
    open(ctx: {
        instructions: string;
        prompt: string;
        questions: Record<string, Question>;
        state: DecisionState;
        model?: string;
    }): Promise<SampleSession>;
    /** Override the default instructions text. */
    readonly instructions?: string;
}

export interface SampledDecisionDriver extends DecisionDriver {
    readonly estimator: { readonly kind: 'sample-frequency'; readonly samples: number; readonly greedy: boolean };
}

export function createSampledDriver(options: SampledDriverOptions): SampledDecisionDriver;

// Moved verbatim from ts-decision-fm (fm re-exports them unchanged):
export const DECISION_INSTRUCTIONS: string; // = former FM_INSTRUCTIONS text
export function formatDesc(desc: Desc | undefined): string;
export function declaredOptions(question: Question): string[];
export function buildPrompt(state: DecisionState, questions: Record<string, Question>): string;
export function buildEnumSchema(questions: Record<string, Question>): EnumSchema; // former buildFmSchema body
export function requireEnumValue(parsed: Record<string, string>, key: string, allowed: readonly string[], label?: string): string;
export function entropyConfidence(probabilities: number[]): number;
export function estimateChoice(labels: readonly string[], samples: readonly string[]): ChoiceAnswer<string>;
export function estimateScore(rubric: readonly Desc[], samples: readonly string[]): ScoreAnswer;
export function estimateNoul(samples: readonly string[]): NoulAnswer;
/** Lenient parser for unconstrained models: first balanced JSON object in prose or a ```json fence. */
export function extractJsonAnswer(text: string): Record<string, string>;
```

`ask` behaviour (order is the contract):

1. Reject an empty question map or a question with fewer than two options — `DecisionRequestError`.
2. Render `instructions` and `prompt` (`buildPrompt`).
3. `open(ctx)`; every later step runs inside `try { … } finally { session.close?.() }`.
4. Draw k samples (`k = deterministic ? 1 : samples`), at most `concurrency` in flight.
5. For each key: `requireEnumValue(sample, key, declaredOptions(q), sampleLabel)` — a violation is a
   `DecisionBackendError` naming the key; no partial answers.
6. Estimate per kind (`estimateChoice` / `estimateScore` / `estimateNoul`).

`extractJsonAnswer` failure modes, all `DecisionBackendError`: no JSON object found; object is not
flat key → string. `EnumSchema` keeps the `x-order` key (fm needs it; harmless elsewhere).

## `ts-decision-fm` after the refactor

`createFmDriver(options)` keeps its option shape, platform check at construction, and
`estimator` declaration. It becomes `createSampledDriver({ name: 'fm-local', sampleLabel: 'fm', … })`
whose `open` does: model guard (`'system'` only) → cached availability probe → `countPromptTokens`
budget check → write the schema temp file; `sample` runs `runFmRespond` + `parseFmRespond` (strict
JSON, unchanged); `close` deletes the schema file. Every previous `index.ts` export stays, re-exported
from the core where the body moved (`FM_INSTRUCTIONS` aliases `DECISION_INSTRUCTIONS`,
`buildFmSchema` aliases `buildEnumSchema`). Parity evidence: the existing decision-fm suite plus
recorded `fm respond` stdout fixtures replayed through a mocked `ProcessExecutor` produce identical
answers and identical error classes/messages.

## Agent driver (`ts-ai-decision/src/agent-driver.ts`)

Status: **shipped** in task 0115 (the `llm-agent` registry built-in landed with it).

```typescript
export interface AgentDriverOptions {
    /** Agent to sample. Default: first available agent in TIER1_PRIORITY (fm is never auto-picked, ADR-031). */
    readonly agent?: AgentName;
    /** Model id forwarded as PromptOptions.model; a per-ask `model` overrides it. */
    readonly model?: string;
    readonly samples?: number;        // default 3
    readonly deterministic?: boolean; // default false
    readonly concurrency?: number;    // default 1
    readonly timeoutMs?: number;      // per sample; default 120_000
    readonly runner?: AiRunner;       // injected for tests
    readonly detector?: AgentDetector;
    readonly fs?: FileSystem;         // scratch-dir lifecycle; default ts-runtime node FS
}

export interface AgentDecisionDriver extends SampledDecisionDriver {
    readonly name: 'llm-agent';
}

export function createAgentDriver(options?: AgentDriverOptions): AgentDecisionDriver;
```

Per ask: `open` resolves the agent (memoised after the first successful detection; none available →
`DecisionConfigError`, code `AGENT`), creates a fresh scratch directory under the runtime temp dir,
and returns a session whose `sample` calls
`runner.runPromptCommand(agent, { input: instructions + '\n\n' + prompt + JSON_REPLY_SUFFIX, model, mode: 'text' }, { cwd: scratch, timeout })`
then `extractJsonAnswer(stdout)`. Non-zero exit or `exitCode === null` → `DecisionBackendError`
(timeout → `DecisionTimeoutError`). `close` removes the scratch directory. `JSON_REPLY_SUFFIX` lists
the exact keys and allowed option strings and demands a single JSON object with no prose; it never
asks for confidence (ADR-030).

## Registry

`DecisionMakerRegistry` built-ins become `typesafe`, `fm-local`, `laya-local`, `llm-agent`.
`BuiltinMakerOptions.driverOptions` gains `'llm-agent'?: AgentDriverOptions`. Registration stays lazy:
`names()`/`has()` construct nothing; detection runs on the first `ask`, so an unavailable agent
surfaces through `DecisionHub.decide` as the declared fallback (`reason: 'no-backend'`, `hub.ts:335`). Consumers register
more instances under their own names, e.g. `registry.register('llm-haiku', () => createDecisionMaker({ driver: createAgentDriver({ agent: 'claude', model: 'haiku' }) }))`.

## TypeSafe relocation

Built in task 0116 (2026-10-19): the table is the shipped state, and the two type adaptations the
0.7.0 upgrade forced are recorded under § SDK 0.7.0 upgrade.

| Item | Before | After |
|------|--------|-------|
| `createTypesafeDriver` | `ts-ai-runner/src/decision/typesafe-driver.ts` (not exported) | `ts-ai-decision/src/typesafe-driver.ts`, exported |
| `@typesafe-ai/sdk` | `0.6.0`, `ts-ai-runner` dependency | `0.7.0`, `ts-ai-decision` dependency (see § SDK 0.7.0 upgrade) |
| spur rule `no-typesafe-sdk-import-outside-ai-runner` | allows the ai-runner file | renamed `…-outside-ai-decision`, allows only the ai-decision file |
| `createDecisionMaker({ backend: 'typesafe' })` (and the no-option default) | static driver | `@deprecated`; dynamic `import('@gobing-ai/ts-ai-decision')` → `createTypesafeDriver`, import failure → `DecisionConfigError` code `TYPESAFE_BACKEND` with `bun add @gobing-ai/ts-ai-decision` hint |
| Registry `typesafe` built-in | `createDecisionMaker({ backend: 'typesafe' })` | `createDecisionMaker({ driver: createTypesafeDriver(…) })` |

`resolveApiKey` (`TYPESAFE_API_KEY` precedence, `ts-ai-runner/src/decision/decision-maker.ts`) stays in `ts-ai-runner` and is exported; the bridge and the registry `typesafe` built-in both call it and pass the explicit key to `createTypesafeDriver`.

## SDK 0.7.0 upgrade

The relocated driver pins `@typesafe-ai/sdk` `0.7.0` (published 2026-10-14; diffed against the 0.6.0
tarball). Task 0116 R4 owns the changes.

| 0.7.0 change | Effect on the driver | Action |
|---|---|---|
| `noul` overloads require non-null instructions or criteria | `noul(question.prompt ?? null, …)` fails tsc | branch on `prompt`; no cast |
| Client-side noul check ("neither instructions nor criteria") | unreachable: neutral noul always sends `{ true, false }` criteria | none |
| `state` typed `NonNullable`, null rejected client-side | driver already sends `''` for null | none |
| Request compression defaults to zstd when `node:zlib.zstdCompress` exists (Bun 1.4.3: yes) | test fake fetch must decode `content-encoding: zstd` bodies | decode in the test helper; keep zstd in production |
| `Question` union adds `box` | `fromSdkAnswer` default branch already throws | none |
| `usage.input_tokens` nullable | not surfaced | none |
| `noul()` overloads reject an undescribed noul at the type level **and** client-side | a bare neutral noul (no prompt, no outcome descriptions) is now a `DecisionRequestError` instead of an API 422 | build the `NoulQuestion` object directly (no cast) and keep the described cases' wire shape |
| `ScoreLegend<T>` threads a recursive `SentContent` conditional | `ResultFor<Question>` no longer instantiates (TS2589) | read the legend through the non-generic `ScoreResponse` and hand it over via one documented helper; `validateAnswers` still checks the shape |
| Default request compression is zstd, and every attempt is buffered through `response.clone()` | a string/`Response.json()` fixture body is disturbed on Bun 1.4.3 ("Body already used") and a ≥1 KiB request body is compressed | test fixtures are stream-backed and the recorded body is zstd-decoded |
| `engines.node >= 22` (was `>= 20`) | Node 20 consumers of `ts-ai-decision` | CHANGELOG note |

## Not changed

- `packages/laya-mlx` directory and `@gobing-ai/ts-laya-mlx` name (ADR-039 Consequences).
- `ts-decision-clef` (already a pure external driver; it may adopt `extractJsonAnswer` later — not in scope).
- Neutral types, `validateQuestions` / `validateAnswers`, error taxonomy.
