# Laya local decision backend

Concrete surface of `@gobing-ai/ts-laya-mlx` (source `packages/laya-mlx`) — the local
`DecisionDriver` for the neutral decision contract owned by `@gobing-ai/ts-ai-runner` — plus the
additive backend-selection shape that lands in `ts-ai-runner`.

Decisions: [ADR-027](../00_ADR.md#adr-027-local-laya-decision-backend-ships-as-ts-laya-mlx-and-executes-the-vendored-mlx-runtime-over-a-process-bridge),
[ADR-028](../00_ADR.md#adr-028-backend-selection-is-one-way--ts-ai-runner-never-depends-on-a-driver-package).
Mechanism: `docs/03_ARCHITECTURE.md` § laya-mlx. Neutral contract:
[`decision-maker.md`](decision-maker.md). Feature:
[J](../features/J_local-laya-decision-backend-in-ts-laya-mlx.md).

## Package

| Field | Value |
|-------|-------|
| Name | `@gobing-ai/ts-laya-mlx` |
| Source | `packages/laya-mlx` |
| Version | lockstep with the workspace |
| Exports | `.` only |
| `dependencies` | `@gobing-ai/ts-ai-runner` (`workspace:*`), `@gobing-ai/ts-runtime` (`workspace:*`) |
| `files` | `dist`, `src`, `worker`, `README.md`, `LICENSE`, `NOTICE` |
| License | Apache-2.0, with the upstream NOTICE carried forward |

No npm runtime dependency executes the model: the engine is the `laya-mlx` Python distribution on
the host, which the package drives but does not vendor, bundle, or install.

## Host prerequisites

| Requirement | Checked |
|-------------|---------|
| macOS on Apple Silicon | at construction |
| A Python interpreter resolvable from `pythonPath`, `env.LAYA_PYTHON`, or `python3` on `PATH` | at construction |
| `laya-mlx` importable by that interpreter | at worker startup, from the handshake |

Each failure is a `DecisionConfigError` naming the missing piece and the command that installs it.
None of them surface as a raw spawn failure at ask time.

## Main export

```ts
export function createLayaDriver(options?: LayaDriverOptions): DecisionDriver;

export interface LayaDriverOptions {
    /** Hugging Face model id. Default: 'convaiinnovations/laya-multilingual'. */
    modelId?: string;
    /** Explicit local artifact directory. Wins over `modelId`; no fetch is attempted. */
    modelPath?: string;
    /** Checkpoint revision pinned for resolution and cache keying. */
    revision?: string;
    /** Artifact cache root passed to the worker. Default: resolved from `env`. */
    cacheDir?: string;
    /** Interpreter that carries `laya-mlx`. Default: `env.LAYA_PYTHON`, then `python3`. */
    pythonPath?: string;
    /** Weight precision requested of the worker. Default: 'float16'. */
    dtype?: 'float32' | 'float16' | 'bfloat16';
    /** Questions per forward pass. Default: 16. */
    batchSize?: number;
    /** Budget for the startup handshake, which covers the one-time weight load. Default: 120_000. */
    startupTimeoutMs?: number;
    /** Budget for one `ask` once the worker is ready. Default: 30_000. */
    requestTimeoutMs?: number;
    /** Injected environment record — this package never reads `process.env` (ADR-011). */
    env?: Record<string, string | undefined>;
}
```

`createLayaDriver` returns a value satisfying `DecisionDriver` from `@gobing-ai/ts-ai-runner`:
`readonly name: 'laya-local'` and `ask(req)`. No `choice` / `score` / `noul` sugar — the facade
owns those.

The worker is started lazily on first `ask` and then reused for the driver's lifetime, so the
weight load is paid once rather than per call. Startup errors surface on that first call, not from
the factory.

## Environment keys

Read from the injected `env` record only.

| Key | Effect |
|-----|--------|
| `LAYA_MODEL_ID` | Default for `modelId` |
| `LAYA_MODEL_PATH` | Default for `modelPath` |
| `LAYA_CACHE_DIR` | Default for `cacheDir` |
| `LAYA_PYTHON` | Default for `pythonPath` |
| `HF_TOKEN` | Forwarded to the worker for a gated repository |

Explicit options win over env keys. Only these keys are forwarded to the child process; the
parent environment is not inherited wholesale.

## Worker protocol

One JSON object per line, both directions, over the pipe opened by
`ProcessExecutor.runStreaming()`. The worker holds one `Agent` for its lifetime.

Startup handshake, emitted once on stdout before any request is served:

```json
{ "ready": true, "model": "convaiinnovations/laya-multilingual", "revision": "…", "maxLen": 512 }
```

Request:

```json
{ "id": "1", "state": "<text>", "questions": { "<qid>": { "type": "choice", "instructions": "…", "criteria": { } } } }
```

Success — the runtime's own `predict` payload, passed through unaltered:

```json
{ "id": "1", "ok": true, "result": { "model": "laya-rl-agent", "answers": { }, "usage": { } } }
```

Failure:

```json
{ "id": "1", "ok": false, "error": { "kind": "config" | "request" | "backend", "message": "…" } }
```

`id` correlates responses to requests. Requests are issued one at a time per worker; batching
across questions happens inside a single request, not by pipelining.

## Answer mapping

The worker returns the reference implementation's answer JSON — temperature calibration, softmax,
and `confidence_from_probs` all happen there, so none of that arithmetic is restated in TypeScript.
The driver maps each entry onto the neutral shape:

| Worker `type` | Neutral answer produced |
|---------------|-------------------------|
| `choice` | `{ kind: 'choice', label: <choice>, confidence, probabilities }` |
| `score` | `{ kind: 'score', score, confidence, legend, probabilities }` |
| `noul` | `{ kind: 'noul', probability: <noul> }` |

The reference also returns a `noul` confidence and an `action.act_probability`; both are dropped,
because `NoulAnswer` carries a bare probability by contract and the neutral surface has no action
channel. Probabilities arrive already rounded to 4 decimal places.

## Errors

Thrown as the classes exported by `@gobing-ai/ts-ai-runner`.

| Condition | Class |
|-----------|-------|
| Unsupported platform, no interpreter, or `laya-mlx` not importable | `DecisionConfigError` |
| No model id, path, or cache entry resolvable | `DecisionConfigError` |
| Artifact fetch rejected for credentials | `DecisionAuthError` |
| Artifact fetch failed at the transport | `DecisionConnectionError` |
| Handshake did not arrive within `startupTimeoutMs` | `DecisionTimeoutError` |
| A request exceeded `requestTimeoutMs` | `DecisionTimeoutError` |
| Worker `error.kind = "request"` — token or option budget exceeded, malformed question | `DecisionRequestError` |
| Worker `error.kind = "backend"`, non-finite outputs, worker exited, or unparseable line | `DecisionBackendError` |

A worker that exits is not silently restarted mid-`ask`; the in-flight call rejects and the next
`ask` starts a fresh worker.

## Backend selection in `ts-ai-runner`

Additive; `createDecisionMaker({ driver })` is unchanged and still wins.

```ts
export type DecisionBackend = 'typesafe' | 'laya-local';

export interface DecisionMakerOptions {
    /** Explicit driver. When supplied, `backend` is ignored. */
    driver?: DecisionDriver;
    /** Named backend. Default: 'typesafe'. */
    backend?: DecisionBackend;
    // ...existing options unchanged
}
```

Resolution order: `driver` → `backend` → `'typesafe'`. `'laya-local'` is resolved by dynamic import
of `@gobing-ai/ts-laya-mlx` when a decision is first asked; the package is not a dependency of
`ts-ai-runner` and a missing installation rejects with `DecisionConfigError` naming the package.

`DecisionBackend` is a union so a third backend is an additive change here and a new driver package
elsewhere — no edit to the neutral types.

## Worker script

`packages/laya-mlx/worker/laya_worker.py` is published with the package. It imports `laya_mlx`,
constructs one `Agent` from the request options, emits the handshake, then serves the protocol
above in a read-line loop. It contains no model logic — every numeric path is the installed
runtime's. `packages/laya-mlx/README.md` records the supported `laya-mlx` version range and the
install command.

## Parity fixture

Two layers, so the default test run needs no interpreter and no 643 MB download, and nothing is
skipped to go green.

| Layer | Input | Runs |
|-------|-------|------|
| Protocol fixture | recorded worker request/response lines for a handful of questions, committed under `packages/laya-mlx/tests/fixtures/` | always, in `bun run test`, against a stub process |
| Full parity | the checkpoint's `validation.json` — 63 questions with recorded expectations | in the host-provisioned lane; reports the agreement count |

The protocol fixture covers request construction, line framing, correlation, answer mapping, and
every error branch — the layers this package actually owns and that can therefore drift. Full
parity is inherited from the runtime rather than re-earned, so it verifies the bridge, not the
model.
