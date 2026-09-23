# @gobing-ai/ts-decision-fm

Apple on-device Foundation Model decision backend for the neutral decision
surface owned by `@gobing-ai/ts-ai-runner`: answers `choice` / `score` / `noul`
questions on-device by driving the macOS 27 `fm` command-line tool as one-shot
processes over `ts-runtime`'s `ProcessExecutor`
([ADR-029](../../docs/00_ADR.md)). Probabilities are empirical sample
frequencies — the model is never asked for a confidence
([ADR-030](../../docs/00_ADR.md)).

Part of the `@gobing-ai/ts-libs` monorepo and lockstep-versioned with it.

- **License:** Apache-2.0 (see [LICENSE](./LICENSE)).
- **No model weights or third-party code are bundled.** The engine is the `fm`
  system binary on the host.

---

## Host prerequisites

1. **Platform:** macOS on Apple Silicon (`darwin arm64`). Unsupported hosts fail
   at construction with a `DecisionConfigError`, before any process is spawned.
2. **`fm` CLI:** macOS 27+ ships `/usr/bin/fm` (validated against build
   `FoundationModels-2.0.68.1.402`). A custom path can be injected via
   `fmPath`. A missing binary is reported as `DecisionConfigError` "fm not
   found" on the first ask.
3. **System model availability:** probed once per driver with
   `fm available --model system` before the first sample and cached for the
   driver's lifetime. A model that is present but not ready raises
   `DecisionConfigError` carrying fm's reason (e.g. `modelNotReady`).

---

## Usage

```ts
import { createFmDriver } from '@gobing-ai/ts-decision-fm';

const driver = createFmDriver(); // defaults; or createFmDriver({ samples: 7 })
const answers = await driver.ask({
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
// answers.sentiment: { kind: 'choice', label, confidence, probabilities }
// answers.priority:  { kind: 'score', score, confidence, legend, probabilities }
// answers.refund:    { kind: 'noul', probability }
```

The `model` argument of `ask` accepts only `undefined` or `'system'` — the
on-device system model is the only one fm offers; anything else raises
`DecisionRequestError`.

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `samples` | `5` | Sequential `fm respond` samples per ask. Ignored when `deterministic`. |
| `deterministic` | `false` | One greedy sample (`fm respond -g`); probabilities are one-hot, confidence 1. |
| `maxPromptTokens` | `6000` | Pre-flight budget. The rendered prompt is counted with `fm count-tokens -q` before sampling; over budget raises `DecisionRequestError` and no model call runs. |
| `requestTimeoutMs` | `30000` | Budget for one `fm respond` process; expiry raises `DecisionTimeoutError`. |
| `guardrails` | omitted | `--guardrails` level (`'default'` \| `'permissive-content-transformations'`). |
| `fmPath` | `'fm'` | Executable to spawn. |
| `executor` | ts-runtime `ProcessExecutor` | Injected process seam (tests stub this). |
| `platform`, `arch` | `process.platform`, `process.arch` | Injectable host facts so tests can pin the host. |

### Backend selection (`ts-ai-runner`)

The `fm-local` backend name joins `createDecisionMaker` via `ts-ai-runner`
(task 0085); `ts-ai-runner` resolves `@gobing-ai/ts-decision-fm` through a
dynamic import, the same way `laya-local` resolves `ts-laya-mlx`. Callers who
need non-default options pass the driver explicitly:

```ts
import { createDecisionMaker } from '@gobing-ai/ts-ai-runner';
import { createFmDriver } from '@gobing-ai/ts-decision-fm';

const dm = createDecisionMaker({ driver: createFmDriver({ deterministic: true }) });
```

---

## Estimator semantics (read before trusting `confidence`)

Every probability this driver returns is a **frequency over k parsed samples**
(`estimator: { kind: 'sample-frequency' }`):

- `choice` — `probabilities[label] = count(label) / k` for every supplied label
  (unsampled labels get 0). `label` is the most frequent with ties broken by
  label declaration order.
- `score` — the same over level indices; ties go to the lower level.
- `noul` — a bare yes-probability, no `confidence` key, by contract.

`confidence` is `1 − H(p) / ln(n)` over the declared options — the Laya
reference's `confidence_from_probs` on the empirical distribution. It measures
**how much the samples agreed, not calibration**. The model is never asked for a
confidence; a self-reported one would be fabricated calibration.

Resolution limit: with k samples every probability is a multiple of 1/k, and
`confidence` has at most k+1 distinct values. k = 5 detects a 60/40 split, not a
64/36 one. In deterministic mode k = 1, so every answer is one-hot with
confidence 1.

### Latency

fm one-shot calls cost ~0.3 s warm each, so an ask costs **~0.3 s × k** (plus
one `count-tokens` call). Calls are sequential by design: parallel sampling is
out of scope and fm exposes no logprobs that would make batching worthwhile
(ADR-029).

---

## Errors

All failures surface through the `@gobing-ai/ts-ai-runner` decision error
taxonomy — never as an answer:

| Condition | Class |
|-----------|-------|
| Not darwin/arm64; `fm` not found; system model unavailable | `DecisionConfigError` |
| `model` other than `system`; prompt over `maxPromptTokens`; fewer than two options | `DecisionRequestError` |
| fm reports the context size was exceeded | `DecisionRequestError` |
| fm reports the safety guardrails were triggered | `DecisionBackendError` (not retried) |
| Other non-zero exit; non-JSON stdout; schema violation | `DecisionBackendError` |
| A sample exceeded `requestTimeoutMs` | `DecisionTimeoutError` |

Failure is all-or-nothing: one failed sample rejects the whole ask. Partial
frequencies are never returned as probabilities.

---

## Testing

The default suite is stubbed (injected `ProcessExecutor`, pinned
`darwin`/`arm64`) and runs on every platform including Linux CI. The live suite
(`tests/live.test.ts`) runs only where the system model is actually available
(darwin/arm64 and `fm available --model system` exits 0) and skips with a stated
reason everywhere else.
