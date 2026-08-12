---
name: Architecture
doc: 03_ARCHITECTURE
owns: HOW — module boundaries, data flow, runtime model, invariants, rationale-in-depth
authority: derived
version: 1.1.0
derived_from: [00_ADR, 01_PRD]
owner: Robin Min
updated_at: 2026-08-12
read_before: cross-package, seam, or schema work
edit_rules: 99 §6.4
sync: [T1]
---

# Architecture

## ai-runner

`@gobing-ai/ts-ai-runner` owns coding-agent shims, installation and health detection, prompt execution,
message storage, and team orchestration over `ts-runtime` process abstractions.

## db

`@gobing-ai/ts-db` is the drizzle-free persistence facade: typed adapters and DAOs on the main export,
with schema construction and migrations isolated behind explicit subpaths.

## dual-workflow-engine

`@gobing-ai/ts-dual-workflow-engine` combines state-machine transitions with action-flow execution,
persistence seams, lifecycle events, and resumable run state.

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
| `./scheduler-node`         | `NodeSchedulerAdapter` (interval-based)                           |
| `./scheduler-cloudflare`   | `CloudflareSchedulerAdapter` (Workers Cron Trigger)                |

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
## llm-jsonl-importer

`@gobing-ai/ts-llm-jsonl-importer` provides source-neutral JSONL ingestion, mapping, redaction, hashing,
and persistence for LLM-agent history exports.

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

## utils

`@gobing-ai/ts-utils` is the zero-dependency base layer for errors, output, API responses, cursors,
dates, origins, access roles, and object helpers.
