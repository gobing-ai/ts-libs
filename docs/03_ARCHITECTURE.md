---
name: Architecture
doc: 03_ARCHITECTURE
owns: HOW — module boundaries, data flow, runtime model, invariants, rationale-in-depth
authority: derived
version: 1.4.0
derived_from: [00_ADR, 01_PRD]
owner: Robin Min
updated_at: 2026-09-20
read_before: cross-package, seam, or schema work
edit_rules: 99 §6.4
sync: [T1]
---

# Architecture

## ai-runner

`@gobing-ai/ts-ai-runner` owns coding-agent shims, installation and health detection, prompt execution,
message storage, and team orchestration over `ts-runtime` process abstractions. Its batch-first
`DecisionMaker` validates question/answer correspondence for both TypeSafe and injected drivers.

## db

`@gobing-ai/ts-db` is the drizzle-free persistence facade: typed adapters and DAOs on the main export,
with schema construction and migrations isolated behind explicit subpaths.

## dual-workflow-engine

`@gobing-ai/ts-dual-workflow-engine` combines state-machine transitions with action-flow execution,
persistence seams, lifecycle events, and resumable run state.

HITL actions, automatic-mode policy, evidence gathering, and DecisionMaker responder wiring belong
in consuming applications such as Spur (ADR-026). The engine exposes the neutral `HitlResponder`
contract and never imports ai-runner. Action audit completion precedes routing; pause snapshots
retain variables, transition counts and the last action's `ok` bit without copying raw result data.

## infra

`@gobing-ai/ts-infra` is the infrastructure backbone — typed event bus, structured logger,
OpenTelemetry instrumention, API client, queue/scheduler contracts, and a plugin-driven
application bootstrap.

### Package layout

```
src/
├── application/           ← Plugin-driven DI bootstrap (portable core)
│   ├── index.ts               runApplication — deterministic startup → shutdown
│   ├── types.ts               ApplicationBootstrapOptions, ApplicationRuntime, …
│   └── plugins/
│       ├── types.ts           Plugin, PluginHost interface (runtime-neutral)
│       ├── host.ts            PluginHost class — insertion-ordered, fail-fast/soft
│       └── builtins.ts        Built-in service plugins (logger, telemetry, scheduler, …)
├── application-node.ts    ← Node/Bun convenience bootstrap (subpath)
├── event-bus/             ← Typed EventBus<TEvents> with sync/async dispatch
├── telemetry/             ← OTel SDK, metrics, tracing, SQL sanitizer, OTLP exporter
├── scheduler/             ← SchedulerAdapter contract, factory, noop, Node/CF adapters
├── job-queue/             ← JobQueue + QueueConsumer interfaces, DB-backed impl
├── logger.ts              ← LogTape-backed structured logger
└── api-client.ts          ← Typed HTTP client with OTel auto-instrumentation
```

### Subpath strategy (ADR-014)

The main barrel (`.`) stays portable — no `node:*`, no filesystem, no platform-specific
adapters. Runtime-specific wiring lives behind explicit subpaths:

| Subpath                    | What it adds                                                       |
|----------------------------|-------------------------------------------------------------------|
| `./application`            | Portable `runApplication`                                         |
| `./application-node`       | YAML config, file log sink, Bun SQLite, Node OTel, Node scheduler |
| `./job-queue-db`           | DB-backed job queue + consumer (depends on `@gobing-ai/ts-db`)    |
| `./otel-node`              | `initNodeTelemetry` / `shutdownNodeTelemetry` for OTLP export     |
| `./scheduler-node`         | `NodeSchedulerAdapter` (interval + real five-field cron, local time)  |
| `./scheduler-cloudflare`   | `CloudflareSchedulerAdapter` (Workers Cron Trigger)                |

**Scheduler ownership ([Spur task 0734](https://github.com/gobing-ai/spur/blob/main/docs/tasks4/0734_configurable-scheduler-jobs-interval-real-cron-in-ts-libs-ad.md)).** The `NodeSchedulerAdapter` preserves the three legacy
interval cadences (a positive ms string, `* * * * *`, and the step-N wildcard form) and adds real
five-field cron evaluated in local wall-clock time with self-rescheduling `setTimeout` (no overlap,
missed occurrences skipped, delays beyond the platform timer maximum chunked). The cron grammar
lives in the internal `scheduler/cron.ts` seam shared with `application-node.ts`, which validates
`bootstrap.scheduler.jobs` (`SchedulerJobConfig`: non-empty `name`/`command` plus exactly one of
`intervalMinutes` or a cron string) before the user `start` callback. `runNodeApplication` owns
scheduler lifecycle and job validation; the consuming application binds a job's `command` to its
own handler — ts-infra never executes it directly.

### Application bootstrap — lifecycle

Startup is a deterministic A→Z fan-out driven by the `PluginHost`:

```
register: logger → telemetry → [user plugins] → user-callback → scheduler
execute:  loadAll() → startAll()                              ← failFast services rethrow
```

Shutdown is the reverse fan-out, carrying an optional stop `reason`:

```
stopAll(reason) → unloadAll(reason)   ← reverse registration order, fail-soft
```

Services that the bootstrap *creates* (Node subpath: Bun SQLite adapter, Node OTel
exporter) are closed automatically via their plugin's `onStop`. Services the caller
*injects* (`services.db`, `services.logger`, `services.events`) are caller-owned —
the bootstrap never closes them. `stop()` is idempotent.

### Key architectural decisions

| Decision                                          | Rationale                                                                 |
|---------------------------------------------------|---------------------------------------------------------------------------|
| Plugin host non-generic (`EventBus<EventMap>`)    | `EventBus` is invariant in `TEvents`; plugins need only the base contract |
| Teardown reason typed as `string` on core         | Plugin core stays runtime-neutral; `ApplicationStopReason` assignable     |
| Caller-injected DB not closed by bootstrap        | One rule: close what you create, never close what you were handed         |
| `loadAll` fail-fast, start/stop/unload fail-soft  | Load is precondition validation (must abort); start/stop is best-effort   |
## laya-mlx (accepted design — ADR-027/ADR-028; not yet built)

`@gobing-ai/ts-laya-mlx` is the local backend for the neutral decision surface: it answers
`choice` / `score` / `noul` questions on-device from the open-weight Laya multilingual checkpoint,
behind the same `DecisionDriver` seam that `ts-ai-runner` already exposes. It exists so a decision
costs no network round-trip and no API key, and so the seam introduced with the TypeSafe driver
carries a second, independently written backend.

**Dependency direction.** One edge only: `ts-laya-mlx` → `ts-ai-runner` (for the neutral types and
the error taxonomy). `ts-ai-runner` declares no dependency on `ts-laya-mlx` and imports nothing from
it at module scope; its named-backend selector resolves the local driver when a decision is first
asked (ADR-028). A boundary rule makes the invariant mechanically checkable.

**Execution model.** A long-lived worker process runs the vendored `laya-mlx` Python runtime,
which loads the checkpoint once and then answers batches over JSON lines on stdin/stdout. The
TypeScript side owns the protocol, the process lifecycle, and the translation to neutral answers;
it owns no numeric code. `ts-runtime`'s `ProcessExecutor.runStreaming()` is the only process seam
used, so the platform-API ownership rule (ADR-011/ADR-014) holds unchanged. Genuine MLX executes
the model, which is what keeps the package name honest. The same bridge shape is what any future
CLI-backed backend would reuse.

**Pipeline.** A `DecisionDriver.ask` call becomes one worker request carrying the state and the
question map in the shape the runtime already accepts. The worker tokenizes, builds the marked
sequence (state, then rendered options, one marker per option), collates the padded batch, runs the
model, divides per-question logits by the calibration temperature for that question type and option
count, softmaxes, and returns its own answer JSON. The TypeScript side maps that onto the neutral
answer shape — including dropping the `noul` confidence the reference computes but the neutral
contract deliberately does not carry — and translates failures into the decision error taxonomy.

**Model artifacts.** Resolution and caching are delegated to the worker's snapshot download, driven
by driver options: a default model id, an explicit local-path override that suppresses any fetch,
and a cache directory. Weights are never bundled into the tarball, which carries only the
Apache-2.0 licence and the upstream NOTICE.

**Invariants** (checkable):

- No file under `packages/ai-runner/src/**` imports `@gobing-ai/ts-laya-mlx`, and the `ts-ai-runner`
  manifest lists it in no dependency field.
- Process spawning inside `packages/laya-mlx/src/**` goes through `ts-runtime`'s `ProcessExecutor`;
  the package imports no `node:child_process` and calls no `Bun.spawn` directly.
- `packages/laya-mlx` produces neutral answer values only; a `noul` answer carries a bare
  yes-probability and no `confidence` field, matching the hosted driver.
- The published tarball contains no `.safetensors` or other weight artifact.
- Answers agree with the checkpoint's shipped 63-question validation fixture; the fixture, not a
  hand-written expectation, is the correctness reference.
- A missing interpreter, a missing runtime package, or an unsupported platform surfaces as a
  configuration error at construction — never as a raw spawn failure at ask time.

## decision-fm (built 2026-09-23 — ADR-029/ADR-030/ADR-031)

`@gobing-ai/ts-decision-fm` is the third backend for the neutral decision surface. It answers
`choice` / `score` / `noul` questions with Apple's on-device Foundation Model through the `fm`
command-line tool that ships with macOS 27, behind the same `DecisionDriver` seam as the TypeSafe
and Laya drivers. It exists so a decision costs no install, no key and no network on any macOS 27
Apple Silicon host.

**Dependency direction.** As for laya-mlx: `ts-decision-fm` → `ts-ai-runner` and `ts-runtime` only.
`ts-ai-runner` names the backend `fm-local` and resolves it by dynamic import when a decision is
first asked (ADR-028).

**Execution model.** No worker and no server. Each sample is one short-lived `fm respond --schema`
process run through `ts-runtime`'s `ProcessExecutor`. The driver renders the state and question map
into one prompt, and generates one object schema whose properties are the question keys, each
constrained to that question's labels, levels or yes/no. So one process answers the whole map for
one sample. Guided generation makes stdout schema-conformant JSON; the driver still validates it.

**Probability model.** `fm` exposes no log-probabilities, so the driver draws k samples, sequentially
by default, and counts outcomes (ADR-030). Probabilities are label frequencies, and `confidence` is
normalized entropy over that empirical distribution. Latency is linear in k.

**Guards.** Before sampling, `fm count-tokens` checks the rendered prompt against a token budget
below the model's ~8K context. The host platform and `fm available --model system` are checked once
per driver. Guardrail refusals, context overflow, model unavailability and schema mismatches become
decision errors, never answers.

**`fm` as an agent.** Separately, `ts-ai-runner` gains an `fm` shim marked text-only and left out
of automatic selection (ADR-031). The shim and the driver share no code: the shim builds argv for
the generic runner, and the driver owns its own decision prompt and schema.

**Invariants** (checkable):

- No file under `packages/ai-runner/src/**` imports `@gobing-ai/ts-decision-fm`, and the
  `ts-ai-runner` manifest lists it in no dependency field.
- Process spawning inside `packages/decision-fm/src/**` goes through `ProcessExecutor`; no
  `node:child_process`, `Bun.spawn` or `process.env` access.
- No prompt or schema the driver emits requests a confidence, probability or certainty field from
  the model.
- Every generated object schema carries `x-order` listing all of its properties.
- A `noul` answer carries a bare probability and no `confidence`.
- Tests run green on Linux with no `fm`; live-model tests run only when the host passes the
  capability check.

## llm-jsonl-importer

`@gobing-ai/ts-llm-jsonl-importer` provides source-neutral JSONL ingestion, mapping, redaction, hashing,
and persistence for LLM-agent history exports. Import runs accept a cooperative `AbortSignal`
([Spur feature A21](https://github.com/gobing-ai/spur/blob/main/docs/features/A21_reusable-execution-deadlines-and-unlimited-jobs.md) / [Spur ADR-112](https://github.com/gobing-ai/spur/blob/main/docs/00_ADR.md)): cancellation is observed at safe boundaries only — in-flight batches settle
atomically before the run rejects with `ImportCancelledError`, no invocation-owned write lands after
settlement, and incremental resume continues from the last committed checkpoint. The containing
process remains the hard fallback for blocking synchronous work.

## rule-engine

`@gobing-ai/ts-rule-engine` owns constraint schemas, configuration loading, rule evaluation, fixers,
formatters, and host/persistence extension seams.

## runtime

`@gobing-ai/ts-runtime` owns platform detection, `FileSystem`, `ProcessExecutor`, config loading,
path utilities, and optional process inventory.

### Process execution + registry (spur#0264)

- **`ProcessExecutor`** — canonical spawn contract (`run` / `runStreaming`). Concrete Node/Bun impl:
  `NodeProcessExecutor` (execa + `Bun.spawn`). Obtained via `RuntimeFactory.createProcessExecutor`.
- **`ProcessRegistry`** (optional, additive) — in-process list/subscribe of **all** executor
  invocations with minimum metadata (`ProcessExecution`: id, command/args, timestamps, source,
  optional team/agent, exit info). Default impl: `InMemoryProcessRegistry` /
  `createInMemoryProcessRegistry()`.
- Inject the same registry into every executor that should appear in one watch list
  (`ProcessExecutorConfig.registry`). No registry ⇒ prior behavior unchanged.
- Not durable across restarts; retention capped (default 1000). Cloudflare has no process execution.
- **Owned deadline containment (Spur A21)** — on Unix a finite `timeout` or abort `signal` puts the run
  under one executor-owned process-group escalation (group `SIGTERM` → `killGraceMs` grace →
  group `SIGKILL`), so completion reaps descendants that outlive the leader while holding pipes
  or locks; `timeout: null` is explicit unlimited and invalid values are rejected before spawn.
  Semantics: `packages/runtime/README.md` (“Deadlines, cancellation, and process-group containment”).

## utils

`@gobing-ai/ts-utils` is the zero-dependency base layer for errors, output, API responses, cursors,
dates, origins, access roles, and object helpers.
