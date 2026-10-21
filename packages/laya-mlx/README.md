# @gobing-ai/ts-laya-mlx

Local Laya decision backend for the neutral decision surface owned by
`@gobing-ai/ts-ai-runner`: answers `choice` / `score` / `noul` questions
on-device by driving the vendored [`laya-mlx`](https://github.com/mizorewww/laya-mlx)
Python runtime as a long-lived JSON-lines worker over `ts-runtime`'s
`ProcessExecutor` ([ADR-027](../../docs/00_ADR.md)).

Part of the `@gobing-ai/ts-libs` monorepo and lockstep-versioned with it.

- **License:** Apache-2.0 (see [LICENSE](./LICENSE)).
- **Attribution:** derived from `laya-mlx` by mizorewww, upstream revision
  `fc1df62828a3fedf4d8229fdac1cbd85f1cdf337` (see [NOTICE](./NOTICE)).
- **No model weights are redistributed.** Model weights are resolved and cached by
  the worker at run time from Hugging Face and never enter the published tarball.

---

## Host prerequisites

> **Notice:** This is the only package in the workspace with specific host architecture constraints.

1. **Platform:** macOS on Apple Silicon (`darwin arm64`). The published manifest sets `"os": ["darwin"]`, so a dependent that lists this package under `optionalDependencies` (including `@gobing-ai/ts-ai-decision`) does not install it on other operating systems. Unsupported platforms fail fast at construction time before any process is spawned.
2. **Python (core `mlx-python` only):** Python 3.10+ carrying the `laya-mlx` runtime (resolvable via `pythonPath`, injected `env.LAYA_PYTHON`, or `python3` on `PATH`). Core `mlx-native` needs no Python.
3. **Worker script (core `mlx-python` only):** the package ships `worker/laya_worker.py` and finds it relative to its own module. A host that **bundles** this package into a single file (e.g. `bun build`) relocates the module, so it must ship the script itself and point at it with the `workerScript` option or injected `env.LAYA_WORKER_SCRIPT`. A missing script fails the ask with `DecisionConfigError` (`variable: 'LAYA_WORKER_SCRIPT'`) naming the path it tried, which the decision hub maps to the declared fallback.
4. **Supported runtime range:** `laya-mlx 0.1.x` (validated against upstream `0.1.0` @ `fc1df62828a3fedf4d8229fdac1cbd85f1cdf337`).
5. **Install command:**
   ```sh
   pip install laya-mlx
   # or with uv:
   uv pip install laya-mlx
   ```

---

## Execution core and model selection

Both cores run Apple MLX on Metal and return identical neutral answers; pick per host.

| Option | Env (injected) | Values | Default |
| --- | --- | --- | --- |
| `core` | `LAYA_CORE` | `mlx-python` · `mlx-native` · `auto` | `mlx-python` |
| `modelPath` | `LAYA_MODEL_PATH` | local checkpoint dir (fine-tuned) — wins over `modelId` | — |
| `modelId` | `LAYA_MODEL_ID` | Hugging Face repo id | `convaiinnovations/laya-multilingual` |

- **`mlx-python`** — warm `laya-mlx` Python child process over JSON lines. Lowest latency and memory.
- **`mlx-native`** — in-process [`@johnhenry/laya`](https://github.com/johnhenry/laya-js) via libmlxc FFI;
  no Python, no child process. Does not support `cacheDir`/`LAYA_CACHE_DIR` (set `HF_HUB_CACHE` for the
  process instead) or `dtype: 'bfloat16'`; both are rejected as `DecisionConfigError`.
- **`auto`** — loads the native core on first ask; any native load failure falls back to `mlx-python`.

Measured on an Apple Silicon Mac (official checkpoint, f16, 3-question batch, 20 warm asks):

| Core | Cold (load + first ask) | Warm p50 | Resident memory |
| --- | --- | --- | --- |
| `mlx-python` | ~0.8–1.0 s | ~10 ms | ~1.15 GB (78 MB host + ~1.07 GB worker) |
| `mlx-native` | ~0.8–1.0 s | ~22 ms | ~1.78 GB (all in host process) |

```ts
createLayaDriver({ core: 'mlx-native', modelPath: '/models/laya-ft-kk' });
```

The returned driver implements `dispose()`, which closes the client it was built with — the
`mlx-python` worker is held warm for the client's lifetime, and its open pipes otherwise keep a
one-shot parent process alive after the last answer. Call it through `maker.dispose()` (from
`createDecisionMaker`) or `registry.dispose('laya-local')`.

---

## Backend selection (`ts-ai-runner`)

Downstream applications using `createDecisionMaker` from `@gobing-ai/ts-ai-runner`
can select the local backend without editing decision call sites:

```ts
import { createDecisionMaker, q } from '@gobing-ai/ts-ai-runner';

// 1. Hosted TypeSafe backend (default):
const hosted = createDecisionMaker({
    backend: 'typesafe', // or omitted
    apiKey: process.env.TYPESAFE_API_KEY,
});

// 2. Local Laya on-device backend:
const local = createDecisionMaker({
    backend: 'laya-local',
});

// All call sites are 100% identical and substitutable:
const result = await local.choice('customer inquiry', 'Select team', {
    billing: 'Invoices, payments, refunds',
    tech: 'Technical issues, system bugs',
    sales: 'Pricing, new contracts',
});
console.log(result.label); // "billing" | "tech" | "sales"
```

Resolution order: `options.driver` (custom driver double) → `options.backend` (`'typesafe' | 'laya-local'`) → `'typesafe'` (default).
`ts-ai-runner` resolves `@gobing-ai/ts-laya-mlx` via dynamic import on first `ask`; missing installations reject with a descriptive `DecisionConfigError`.

---

## Hosted SDK vs Local Driver substitution reference

| Dimension | Hosted TypeSafe (`ts-ai-runner`) | Local Laya (`ts-laya-mlx`) | Notes |
|-----------|----------------------------------|---------------------------|-------|
| **Factory** | `createTypesafeDriver(config)` | `createLayaDriver(options)` | Both return `DecisionDriver` with single `ask()` method. |
| **Release** | none (stateless HTTP) | `dispose()` closes the warm worker | A `laya-local` maker must be disposed or a one-shot parent never exits. |
| **Driver name** | `'typesafe'` | `'laya-local'` | Available on `driver.name`. |
| **Credentials** | `apiKey: string` (`TYPESAFE_API_KEY`) | `env.HF_TOKEN` (optional) | Local inference needs no key; token only for gated HF repos. |
| **Model selector** | `model?: string` | `modelId?: string` | Default: `'convaiinnovations/laya-multilingual'`. |
| **Offline path** | `baseURL?: string` (custom proxy) | `modelPath?: string` (local weights) | Explicit local path suppresses all network fetches. |
| **Cache root** | N/A (stateless HTTP) | `cacheDir?: string` (`LAYA_CACHE_DIR`) | Reuses cached weights across driver instances. |
| **Timeouts** | `timeoutMs?: number` (per request) | `requestTimeoutMs`, `startupTimeoutMs` | Independent budgets for inference vs weight loading. |
| **Choice answer** | `{ kind: 'choice', label, confidence, probabilities }` | `{ kind: 'choice', label, confidence, probabilities }` | Identical shape and probability distributions. |
| **Score answer** | `{ kind: 'score', score, confidence, legend, probabilities }` | `{ kind: 'score', score, confidence, legend, probabilities }` | Identical shape with 0-indexed rubric scores. |
| **Noul answer** | `{ kind: 'noul', probability }` | `{ kind: 'noul', probability }` | Binary yes/no probability. |

### Intentional divergences

1. **Noul confidence dropped:**
   The reference Python implementation computes a `confidence` field for binary `noul` decisions (`max(p, 1-p)`). This field is deliberately dropped by `mapWorkerAnswer`.
   *Reason:* For binary decisions, the probability already expresses confidence. Synthesizing or passing this field would make local answers type-incompatible with the hosted SDK and violate substitutability.
2. **Action probability dropped:**
   The reference Python model returns an `action: { act_probability }` channel. This field is stripped from all neutral answers.
   *Reason:* The provider-neutral decision contract has no action channel; exposing it would bind callers to model-internal details.
3. **Hardware lock:**
   The local driver requires Apple Silicon macOS due to MLX dependency, whereas the hosted driver runs on any Node/Bun runtime.
4. **Environment isolation:**
   All configuration is passed via explicit `options.env` records rather than ambient `process.env` access ([ADR-011](../../docs/00_ADR.md)).

---

## Worker protocol (terminal debugging)

The driver communicates with `worker/laya_worker.py` over stdin/stdout using UTF-8 LF-delimited JSON Lines. You can test and debug the bridge directly in a shell:

```sh
# 1. Start worker with model checkpoint
python3 worker/laya_worker.py --model convaiinnovations/laya-multilingual

# Output: worker emits readiness handshake:
{"ready": true, "model": "convaiinnovations/laya-multilingual", "revision": null, "maxLen": 512}

# 2. Send a request line on stdin:
{"id": "req-1", "state": "Invoice was double billed", "questions": {"dept": {"type": "choice", "instructions": "Pick team", "criteria": {"billing": "Refunds", "support": "Other"}}}}

# Output: worker prints response line:
{"id": "req-1", "ok": true, "result": {"model": "laya", "answers": {"dept": {"type": "choice", "choice": "billing", "confidence": 0.9942, "probabilities": {"billing": 0.9942, "support": 0.0058}}}}}
```

### Error categorization

The worker classifies errors into three kinds:
- `config` → Configuration or startup failures (missing parameters, unsupported dtype). Maps to `DecisionConfigError`.
- `request` → Malformed request syntax or invalid question specifications. Maps to `DecisionRequestError`.
- `backend` → Model numeric failures (e.g. non-finite logits). Maps to `DecisionBackendError`.

---

## Parity verification (two-layer check)

To keep CI fast and runnable on arbitrary platforms without downloading model weights or requiring Python, correctness is validated in two layers:

1. **Protocol fixture layer (`bun test`):**
   Runs automatically in the default test suite. Exercises request construction, line framing, correlation, answer mapping, and error translation against committed recorded lines in `tests/fixtures/protocol-lines.json` with zero skipped tests.

2. **Full parity layer (`bun run parity`):**
   Selected explicitly via `bun run parity` (or `bun scripts/full-parity.ts`) on a provisioned Apple Silicon host with `laya-mlx` and weights installed. Runs the 16 parity cases (63 questions) and reports agreement against recorded validation expectations.

### Numerical tolerance (0.0001)

The full parity runner checks probability outputs with a tolerance of **0.0001** (`1e-4`), not exact floating-point equality.
**Reason:** The Python worker rounds output probabilities to 4 decimal places, and differences in floating-point representations across precision modes (e.g. `float16` vs `float32`) and hardware backends affect least-significant digits. A 0.0001 tolerance accommodates these representation differences while guaranteeing identical categorical decisions (argmax label and score agreement).

---

## Attribution

Derived from [`laya-mlx`](https://github.com/mizorewww/laya-mlx) by mizorewww, upstream source revision `fc1df62828a3fedf4d8229fdac1cbd85f1cdf337`, licensed under Apache 2.0.
Upstream NOTICE is carried forward in [NOTICE](./NOTICE) in compliance with Section 4(d) of the Apache License 2.0.
