# Apple `fm` decision backend and agent

This document gives the concrete surface for two additions:
- `@gobing-ai/ts-decision-fm` (source `packages/decision-fm`), a `DecisionDriver` over Apple's
  on-device Foundation Model through the macOS 27 `fm` command-line tool.
- The `fm` agent and the `fm-local` backend name that land in `@gobing-ai/ts-ai-runner`.

Decisions: [ADR-029](../00_ADR.md#adr-029-apple-fm-decision-backend-ships-as-ts-decision-fm-over-a-one-shot-process-bridge),
[ADR-030](../00_ADR.md#adr-030-fm-answer-probabilities-are-empirical-sample-frequencies),
[ADR-031](../00_ADR.md#adr-031-fm-joins-ts-ai-runner-as-a-text-only-agent-excluded-from-auto-selection),
and [ADR-028](../00_ADR.md#adr-028-backend-selection-is-one-way--ts-ai-runner-never-depends-on-a-driver-package) for the one-way selection rule.
Mechanism: `docs/03_ARCHITECTURE.md` § decision-fm. Neutral contract:
[`decision-maker.md`](decision-maker.md). Feature:
[K](../features/K_apple-fm-on-device-agent-and-ts-decision-fm-decision-backend.md).

## `fm` CLI facts this design relies on

Observed against `/usr/bin/fm` on macOS 27.0 (26A428), build `FoundationModels-2.0.68.1.402`,
on 2026-09-23. `fm` is beta-era tooling: anything below is pinned to that build and re-verified when
the build changes.

| Fact | Observation | Consequence |
|------|-------------|-------------|
| No `--version` flag | `fm --version` prints `Unknown option` and exits 0 | Version comes from `what -q /usr/bin/fm` (`PROGRAM:fm  PROJECT:FoundationModels-2.0.68.1.402`; exits 1 when the file is absent) |
| Availability probe | `fm available --model system` exits 0 with `System model available`; exits 1 with `System model unavailable: <reason>` | Bare `fm available` always exits 0, so it is never used as the probe |
| Models | only `system` | `--model pcc` (Private Cloud Compute) is not offered; out of scope |
| Guided generation | `fm respond --schema <file>` prints one JSON object on stdout | Schema-conformant output; still validated |
| `x-order` required | a hand-written object schema without `x-order` fails: `Invalid schema … The data couldn't be read because it is missing.` | Every generated schema lists its properties under `x-order` |
| `enum` on string properties | honoured when `x-order` is present | Labels and levels are enum-constrained |
| Mixed question map | one schema holding a choice, a score and a noul property answered in a single call (5/5 valid); output key order varies despite `x-order` | Parse by key, never by position |
| Sampling | default sampling varies across calls (10 draws → 9/1 split); `-g` is deterministic | k-sample estimator; `-g` for deterministic mode |
| Latency | ~0.3 s per warm one-shot call | k sequential samples are affordable at small k |
| Context | a 7,007-token prompt succeeds; an 8,407-token prompt fails: `The session's transcript exceeded the model's context size.` | Pre-flight budget via `fm count-tokens -q` |
| Guardrails | some inputs fail: `The model's safety guardrails were triggered.` | Typed failure, never an answer |
| Sessions | `--save-transcript <file>` then `--resume <file>` continues the conversation; `--resume` on a missing file exits 1 (`Unable to read transcript at …`) | Maps onto `sessionDir` / `sessionId` in the agent shim |
| `fm serve` | OpenAI-style chat completions; ignores `logprobs`/`top_logprobs`; rejects `n>1` with 400; always streams SSE | Not used |

## Package

| Field | Value |
|-------|-------|
| Name | `@gobing-ai/ts-decision-fm` |
| Source | `packages/decision-fm` |
| Version | lockstep with the workspace |
| Exports | `.` only |
| `dependencies` | `@gobing-ai/ts-ai-runner` (`workspace:*`), `@gobing-ai/ts-runtime` (`workspace:*`) |
| `files` | `dist`, `src`, `README.md` |
| License | same as the workspace; no third-party code or weights are bundled |

No npm dependency runs the model. The engine is the `fm` system binary on the host.

## Host prerequisites

| Requirement | Checked |
|-------------|---------|
| `darwin` on `arm64` | at construction, from the injected platform info |
| `fm` resolvable (`fmPath`, default `fm` on `PATH`) | on first `ask`, before any sample |
| `fm available --model system` exits 0 | on first `ask`; cached for the driver's lifetime |

Each failure raises a `DecisionConfigError` that names the missing piece. A model that is present
but not ready reports the reason `fm` printed, for example `modelNotReady`. No raw spawn error
reaches the caller.

## Main export

```ts
export function createFmDriver(options?: FmDriverOptions): FmDecisionDriver;

export interface FmDecisionDriver extends DecisionDriver {
    readonly name: 'fm-local';
    /** Declared estimator — how every probability this driver returns was produced (ADR-030). */
    readonly estimator: { readonly kind: 'sample-frequency'; readonly samples: number; readonly greedy: boolean };
}

export interface FmDriverOptions {
    /** Samples per ask. Default: 5. Ignored when `deterministic` is true. */
    samples?: number;
    /** One greedy sample (`fm respond -g`); probabilities are one-hot. Default: false. */
    deterministic?: boolean;
    /** Prompt-token budget checked with `fm count-tokens` before sampling. Default: 6_000. */
    maxPromptTokens?: number;
    /** Budget for one `fm respond` process. Default: 30_000. */
    requestTimeoutMs?: number;
    /** `--guardrails` level. Default: omitted (fm's `default`). */
    guardrails?: 'default' | 'permissive-content-transformations';
    /** Executable. Default: 'fm'. */
    fmPath?: string;
    /** Injected process seam. Default: ts-runtime's ProcessExecutor. */
    executor?: ProcessExecutor;
    /** Host platform, injectable so tests pin the host. Default: `process.platform` (as laya-mlx). */
    platform?: string;
    /** Host architecture. Default: `process.arch`. */
    arch?: string;
}
```

The `model` argument of `DecisionDriver.ask` must be `undefined` or `'system'`. Any other value
raises a `DecisionRequestError`. The driver adds no `choice` / `score` / `noul` convenience
methods, because the facade already provides them.

## Request construction

For each `ask({ state, questions })`:

1. **Instructions** (`-i`): a fixed text telling the model to answer every question from the
   supplied state. It never asks for confidence, certainty or a probability.
2. **Prompt** (positional argument — ts-runtime `ProcessExecutor.run` has no stdin input, and the
   pre-flight token budget keeps the argument far below `ARG_MAX`): the state rendered as text (JSON-stringified when structured), followed by
   one block per question key. Each block holds the prompt `Desc`, then the options with their
   descriptions:
   - `choice` options are the label keys.
   - `score` options are the level indices `0…n-1` with the rubric text.
   - `noul` options are `yes` / `no` with any outcome descriptions.
3. **Schema** (a temp file written through the ts-runtime `FileSystem` under
   `getProcessEnv().TMPDIR ?? '/tmp'`, named with `crypto.randomUUID()`, passed as `--schema` and
   deleted in `finally`):

   ```json
   {
     "type": "object",
     "title": "Decision",
     "x-order": ["<key1>", "<key2>"],
     "required": ["<key1>", "<key2>"],
     "additionalProperties": false,
     "properties": {
       "<choice key>": { "type": "string", "enum": ["<label>", "..."] },
       "<score key>":  { "type": "string", "enum": ["0", "1", "..."] },
       "<noul key>":   { "type": "string", "enum": ["yes", "no"] }
     }
   }
   ```

   Score levels are string enums, so every question uses the same constrained-string path. The
   driver converts them back to numbers.
4. **Pre-flight:** `fm count-tokens -q -i <instructions> <prompt>` (verified 2026-09-23: prints a bare
   integer). A count above
   `maxPromptTokens` raises `DecisionRequestError` naming both numbers, and `fm respond` is never run.
5. **Sampling:** run `fm respond --no-stream --schema <file> -i <instructions> <prompt>`, adding `-g` in
   deterministic mode. It runs `samples` times, sequentially.

Each call answers the whole question map, so one ask costs k processes, not k × questions.

## Probability estimation

Per question, over the k parsed samples:

| Question | Neutral answer |
|----------|----------------|
| `choice` | `probabilities[label] = count(label) / k` for every supplied label (unsampled labels get `0`); `label` = the most frequent, ties broken by label declaration order; `confidence = 1 − H(p) / ln(n)` over the n labels |
| `score` | the same over levels: `probabilities[level]`, `score` = the most frequent level, ties to the lower level; `confidence` by the same formula |
| `noul` | `{ kind: 'noul', probability: count(yes) / k }`; no `confidence` key |

The confidence formula is the Laya reference's `confidence_from_probs` applied to the empirical
distribution. It measures how much the samples agreed, not calibration. The README states this,
along with the resolution limit: with k samples, probabilities are multiples of 1/k. In
deterministic mode k = 1, so every answer is one-hot with confidence 1.

## Errors

These are thrown as the classes exported by `@gobing-ai/ts-ai-runner`.

| Condition | Class |
|-----------|-------|
| Not darwin/arm64, `fm` not found, or system model unavailable | `DecisionConfigError` |
| `model` other than `system`; prompt over `maxPromptTokens`; a question with fewer than two options | `DecisionRequestError` |
| `fm` reports that the context size was exceeded | `DecisionRequestError` |
| `fm` reports that the safety guardrails were triggered | `DecisionBackendError` (message carries the fm text; the ask is not retried) |
| Non-zero exit with any other stderr; stdout not JSON; JSON violating the schema | `DecisionBackendError` |
| A sample exceeded `requestTimeoutMs` | `DecisionTimeoutError` |

Failure is all-or-nothing: if any one of the k samples fails, the whole `ask` rejects. Partial
frequencies are never returned as probabilities.

## Backend selection in `ts-ai-runner`

This is an additive change to the existing selector.

```ts
export type DecisionBackend = 'typesafe' | 'laya-local' | 'fm-local';
```

`'fm-local'` is resolved the same way as `'laya-local'`, by a dynamic import of
`@gobing-ai/ts-decision-fm` when a decision is first asked. `backend` selects the driver with
default options; callers who need non-default options pass `driver: createFmDriver({...})`. If the
package is missing, the call rejects with `DecisionConfigError` naming the package and the
`bun add` command. `.spur/rules/typescript/decision-boundaries.yaml` gains two rules that mirror
the laya ones:
- `no-fm-driver-import-in-ai-runner`: forbids `@gobing-ai/ts-decision-fm` under
  `packages/ai-runner/src/**`.
- `decision-fm-process-executor-only`: forbids `node:child_process` / `child_process` under
  `packages/decision-fm/src/**`.

## `fm` agent in `ts-ai-runner`

| Surface | `fm` value |
|---------|------------|
| `AgentName` | `'fm'` |
| `command` / `tier` | `fm` / `1` |
| `getHelpCommand` | `fm --help` |
| `getVersionCommand` | `what -q /usr/bin/fm`. It prints `PROGRAM:fm  PROJECT:FoundationModels-2.0.68.1.402` once per binary slice (three identical lines observed); `VERSION_PATTERN` matches `2.0.68` and `AgentDetector` reports the first line unchanged, as it does for every agent. Linux has no `/usr/bin/fm`, so detection reports not installed |
| `getPromptCommand` | `fm respond --no-stream <input>`, plus `-m <model>` when given. `mode: 'json'` has no schema to pass and is ignored, with a note |
| sessions | the transcript file is the session. With `sessionDir` and no `sessionId`, the call starts a new session: `--save-transcript <sessionDir>/fm-session.json`. With `sessionId`, it resumes that session and saves back to the same file: `--resume <file> --save-transcript <file>`, where `<file>` is `<sessionDir>/<sessionId>.json`, or `<sessionId>.json` in the working directory when `sessionDir` is unset. A missing file makes `fm` exit 1 with `Unable to read transcript at …`, and that surfaces as a failed run, never a silent fresh start (ADR-047 R5: the session path suppresses `continue`). The shim stays pure, with no filesystem probe |
| `continue: true` without a session | degrades to a fresh call (no implicit transcript); noted in the capability row |
| `getAuthCommand` | `fm available --model system`, with `AUTH_PATTERNS.fm = { positive: /System model available/, negative: /unavailable/ }`. Doctor reports "authenticated" to mean "model available" and "unauthenticated" for a non-zero exit. `DoctorResult` carries no probe text, so the reason (`modelNotReady`, …) surfaces through the decision driver's `DecisionConfigError`, not the doctor row |
| `textOnly` | `true`: a new optional `AgentShim` field, absent (false) for every other agent |
| `TIER1_PRIORITY` | **not listed** |
| `DISPLAY_ORDER` | appended after `deepseek` |
| `AGENT_SESSION_CAPABILITY.fm` | `supportsResumeById: true`, `supportsSessionDir: true`, `supportsPersistentStdin: false` (note: `fm chat` is interactive only), `supportsStructuredOutput: false` (note: `--schema` needs a schema file the generic `PromptOptions` cannot carry), `verifiedAgainst: 'FoundationModels-2.0.68.1.402'` |

`textOnly` is exported through `getAgentShim(name).textOnly`, so callers that dispatch tool-using
work (for example, anything that expects the agent to write a file) can refuse `fm` explicitly.
`llm-jsonl-importer` gains no `fm` source, because `fm` transcripts are single JSON documents, not
JSONL history.

## Testing

- **Stubbed (all platforms, CI):** an injected `ProcessExecutor` returns scripted stdout/stderr/exit
  for `count-tokens`, `available` and `respond`. Platform facts are injected and pinned to
  `darwin/arm64`, following the laya-mlx CI fix (commit 3c264301). This covers argv shape, schema
  `x-order`/`enum`, frequency maths, tie-breaks, noul shape and every row of the error table.
- **Live (capable hosts only):** gated by a runtime check (darwin/arm64 plus
  `fm available --model system` exits 0). It skips with a stated reason otherwise, and never
  fails because the host lacks `fm`. It covers one choice, one score and one noul question, the
  schema acceptance of a real `fm`, and a transcript resume through the agent shim.
- **Boundary:** `bun run spur-check` enforces both new decision-boundary rules.
