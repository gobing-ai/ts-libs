---
name: add the default implementation of application bootstrap
description: Add a default, architecture-safe application bootstrap layer for ts-infra with portable DI orchestration and a Node/Bun convenience subpath.
status: Done
created_at: 2026-06-07T22:48:16.319Z
updated_at: 2026-06-08T00:03:59.117Z
folder: docs/tasks
type: task
feature-id: ""
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0024. Add the default implementation of application bootstrap

### Background

The workspace already provides most primitives needed to bootstrap an application:

- `@gobing-ai/ts-runtime` owns runtime detection, config loading, filesystem, process execution, and path utilities.
- `@gobing-ai/ts-infra` owns portable logger, EventBus, telemetry instrumentation, scheduler contracts, queue contracts, and infrastructure event maps.
- `@gobing-ai/ts-db` owns the database facade and concrete DB adapter factory.
- `@gobing-ai/ts-infra/otel-node`, `/scheduler-node`, `/scheduler-cloudflare`, and `/job-queue-db` are opt-in adapter subpaths.

We need a default `runApplication` experience so consumers can start quickly without hand-wiring logger,
telemetry, events, database, and scheduler for every small app. The implementation must not turn the
`@gobing-ai/ts-infra` main barrel into a heavy runtime-specific import.

ADR-014 is binding: the core `@gobing-ai/ts-infra` export must remain portable and dependency-light. Any
bootstrap that opens files, configures Node OTLP exporters, creates a Node scheduler, or constructs
runtime-specific DB bindings must live behind an explicit subpath or be injected by the caller.

The right shape is therefore two layers:

1. A portable DI bootstrap that orchestrates already-injected dependencies and adapter-independent
   factories.
2. A Node/Bun convenience subpath that composes `ts-runtime`, `ts-db`, and explicit `ts-infra` adapter
   subpaths for the common local/server use case.

### Requirements

#### R1. Public API

- Add a portable `runApplication<TAppConfig = unknown>(options): Promise<ApplicationRuntime<TAppConfig>>`
  API behind an explicit infra bootstrap subpath, not the main barrel unless an ADR update explicitly
  allows it.
- Export the associated types:
  - `ApplicationBootstrapOptions`
  - `ApplicationBootstrapConfig`
  - `ApplicationRuntime`
  - `ApplicationServices`
  - `ApplicationStopReason`
  - `ApplicationConfigLoader`
  - `ApplicationConfigValidator`
  - feature-specific option types for logging, telemetry, events, database, and scheduler
- `runApplication` must accept a user callback such as:

```ts
await runApplication({
    config,
    async start(app) {
        app.logger.info('started');
    },
});
```

- The returned runtime handle must expose at minimum:
  - resolved `config`
  - optional typed `appConfig`
  - `logger`
  - `events`
  - optional `lifecycleBus`
  - optional `db`
  - optional `scheduler`
  - `stop(reason?: ApplicationStopReason): Promise<void>`

#### R2. Configuration Model

- Define a bootstrap-specific config schema instead of assuming the current `ts-runtime` `Config` is
  sufficient.
- Support feature flags and nested options:
  - `logging.enabled`, `logging.level`, `logging.console`, `logging.fileSink`, `logging.json`
  - `events.enabled`, `events.lifecycle`, `events.defaultObservers`
  - `telemetry.enabled`, `telemetry.serviceName`, `telemetry.environment`, `telemetry.dbStatementDebug`
  - `database.enabled`, plus either injected `DbAdapter` or adapter factory options
  - `scheduler.enabled`, `scheduler.adapter`, `scheduler.entries`, `scheduler.autoStart`
- Keep runtime-specific fields out of the portable config unless they are represented as injected
  adapters/sinks/ports.

#### R3. Application-Specific External Config

- Support application-specific config without forcing `ts-infra` to know application schemas.
- The portable `runApplication<TAppConfig>()` must accept already-resolved `appConfig?: TAppConfig` as DI.
- The portable runtime handle must expose `app.appConfig` with the caller-provided type.
- The portable bootstrap may accept an injected config loader/validator function, but it must not read files
  or parse YAML by itself.
- The Node/Bun convenience subpath must support loading an external YAML file and splitting it into:
  - bootstrap config section
  - application config section
- The caller must be able to provide one of:
  - `schema` for validation, when the implementation can depend on a structural schema interface
  - `validate(raw): TAppConfig`
  - `parse(raw): TAppConfig`
- The caller must be able to specify:
  - `configFile?: string`
  - `bootstrapSection?: string`, defaulting to `bootstrap`
  - `appSection?: string`, defaulting to full remaining object or an explicitly named section
  - `overrides?: unknown`
- Config validation errors must include config path, section name, and validation failure details.
- Environment interpolation may use existing `ts-runtime` behavior in the Node/Bun subpath. The portable
  subpath receives already-resolved values.

Example YAML shape:

```yaml
app:
  name: billing-api
  env: production

bootstrap:
  logging:
    level: info
    console: true
    filePath: ./logs/app.jsonl
  telemetry:
    enabled: true
    serviceName: billing-api
  database:
    enabled: true
    driver: bun-sqlite
    url: ./data/app.db

billing:
  settlementWindowMinutes: 15
  riskLimit: 100000
```

#### R4. Node/Bun Convenience Bootstrap

- Add a Node/Bun convenience subpath, for example `@gobing-ai/ts-infra/application-node`, that can:
  - load external config via `@gobing-ai/ts-runtime` runtime factory/config loader
  - parse application-specific YAML config sections with caller-provided validation
  - map `logging.filePath` to a runtime-created log stream/file sink
  - create a Bun SQLite DB adapter from config when database is enabled
  - optionally call `initNodeTelemetry` from `@gobing-ai/ts-infra/otel-node`
  - optionally use `NodeSchedulerAdapter` from `@gobing-ai/ts-infra/scheduler-node`
- This subpath may import runtime-specific adapters. The portable bootstrap subpath must not.

#### R5. Lifecycle Semantics

- Startup order must be deterministic:
  1. resolve bootstrap config and application config
  2. initialize logger
  3. initialize telemetry exporter/provider if the selected subpath owns one
  4. initialize core telemetry
  5. create lifecycle bus and application EventBus
  6. create database adapter if enabled
  7. initialize scheduler and register entries if enabled
  8. call user `start(app)` callback
  9. start scheduler if `autoStart` is true
- If any startup step fails, already-started services must be cleaned up in reverse order before rethrowing.
- Shutdown order must be deterministic:
  1. call optional user `stop(app, reason)`
  2. stop scheduler
  3. close DB adapter
  4. shut down core telemetry
  5. shut down Node telemetry exporter/provider if initialized by the Node subpath
  6. close file/log streams created by the Node subpath
- `stop()` must be idempotent.

#### R6. Boundaries

- Do not statically import adapter implementations into `@gobing-ai/ts-infra` main barrel.
- Do not import `node:fs`, `node:path`, `node:os`, `node:child_process`, `Bun.spawn`, `Bun.which`, or
  `process.env` from infra core.
- Do not import `drizzle-orm` outside `packages/db`.
- Internal dependencies must use `workspace:*`.
- Any new export must be covered by package export maps, TypeScript path aliases where needed, README
  examples, and subpath smoke tests.

#### R7. Documentation

- Update `packages/infra/README.md` with:
  - portable DI bootstrap example
  - Node/Bun convenience bootstrap example
  - application-specific YAML config example with typed validation
  - explanation of what is intentionally not in the main barrel
  - lifecycle and cleanup behavior
- If the implementation requires a new architecture decision or contradicts ADR-014, update
  `docs/00_ADR.md` before implementation.

## Requirements Verdict — 2026-06-07 (verify pass)

| Req | Verdict | Evidence / Gap |
|-----|---------|----------------|
| **R1** Public API (`runApplication`, all exported types, runtime handle) | **MET** | `application/index.ts:120 runApplication`; types re-exported `application/index.ts:262-277`; handle shape `application/types.ts:118-135` (config, appConfig, logger, events, lifecycleBus?, db?, scheduler?, stop). Tests `application.test.ts:38-97`. |
| **R2** Configuration model (feature flags + nested options) | **PARTIAL** | logging/events/telemetry/scheduler flags resolved `index.ts:125-150`. Gap: `events.defaultObservers`/`logging.fileSink`/`logging.json` present, but `scheduler.entries`/`scheduler.adapter` live only in options, not in resolved `ApplicationBootstrapConfig` (`types.ts:78-85` omits them) — acceptable since they are injected, not config state. No unmet sub-item. |
| **R3** Application-specific external config (typed `appConfig`, injected loader, no file reads in portable) | **MET** | Portable accepts `appConfig` `index.ts:227`, no file IO (boundary test `application.test.ts:431-438`). Validator contract `types.ts:179-183`; errors include path+section `application-node.ts:67-71`. Tests `application-node.test.ts:65-158`. |
| **R4** Node/Bun convenience bootstrap | **PARTIAL** | `runNodeApplication` `application-node.ts:212` loads YAML, validates, creates Bun SQLite adapter, optional Node telemetry/scheduler. Gaps: (a) log-sink path precedence bug pulls from `database.filePath` (Finding #1); (b) unsupported DB driver silently ignored (Finding #2). |
| **R5** Lifecycle semantics (deterministic startup/shutdown, reverse cleanup, idempotent stop) | **PARTIAL** | Startup order `index.ts:163-244` matches spec; shutdown reverse order `index.ts:43-78`; idempotency via `state.stopped` guard, tested `application.test.ts:211-242`. Gap: startup-failure reverse cleanup only shuts telemetry (`index.ts:253-255`); injected DB/scheduler not closed on failure (Finding #3) — portable bootstrap treats them as caller-owned, but R5 wording says "already-started services must be cleaned up". |
| **R6** Boundaries (no adapter imports in portable/main barrel, no node:* / drizzle in core) | **MET** | Portable `index.ts` imports only intra-package modules (verified: no node:*/Bun/ts-runtime/ts-db/drizzle). Boundary test `application.test.ts:431-438`. Main barrel unchanged (subpath-only exports `package.json:51-58`). `workspace:*` deps intact. |
| **R7** Documentation (README portable + node + YAML examples, lifecycle, what's-not-in-barrel) | **MET** | `packages/infra/README.md:425-531` covers both subpaths, YAML+typed validation, lifecycle, and "intentionally NOT in main barrel". |


### Non-Goals

- Do not implement a Cloudflare convenience bootstrap in this task unless it is limited to type-compatible
  seams and does not broaden scope.
- Do not create a new package manager, runtime abstraction, linter, or formatter.
- Do not move existing DB, scheduler, telemetry, or config primitives unless required by the bootstrap API.
- Do not make `@gobing-ai/ts-infra` main import automatically configure Node telemetry, file logging, DB,
  or runtime schedulers.

### Q&A

- Q: Should `runApplication` live in the main `@gobing-ai/ts-infra` barrel?
  A: No for the first implementation. Keep it behind an explicit subpath so the main barrel remains
  portable and adapter-light. A later ADR can decide whether type-only or portable-only re-exports are
  acceptable.
- Q: Should the bootstrap own the application server?
  A: No. It owns infrastructure lifecycle. The user callback owns app-specific HTTP servers, workers,
  workflows, or CLI logic.
- Q: Should Node/Bun defaults be easy?
  A: Yes. That is the purpose of the Node/Bun convenience subpath, where runtime-specific imports are
  explicit and expected.
- Q: Should database creation be automatic?
  A: Only when config gives enough information for a supported adapter. Injected `DbAdapter` remains the
  portable and preferred DI path.
- Q: Should application-specific config be part of `ApplicationBootstrapConfig`?
  A: No. Keep bootstrap config and application config separate. `ApplicationBootstrapConfig` configures
  infrastructure lifecycle; `appConfig` is typed by the consuming application.
- Q: Should portable `runApplication` read YAML?
  A: No. Portable bootstrap accepts `appConfig` and bootstrap config as values. Node/Bun convenience can
  load YAML because it explicitly opts into runtime/file dependencies.

### Design

#### Proposed Export Shape

Portable subpath:

```ts
import { runApplication } from '@gobing-ai/ts-infra/application';
```

Node/Bun convenience subpath:

```ts
import { runNodeApplication } from '@gobing-ai/ts-infra/application-node';
```

The portable subpath composes only portable infra primitives and injected dependencies. The Node subpath
may use `@gobing-ai/ts-runtime`, `@gobing-ai/ts-db`, `@gobing-ai/ts-infra/otel-node`, and
`@gobing-ai/ts-infra/scheduler-node`.

#### Portable API Sketch

```ts
export interface ApplicationBootstrapOptions<
    TAppConfig = unknown,
    TEvents extends EventMap = InfraEvents,
> {
    readonly config?: Partial<ApplicationBootstrapConfig>;
    readonly appConfig?: TAppConfig;
    readonly services?: Partial<ApplicationServices<TEvents>>;
    readonly start: (app: ApplicationRuntime<TAppConfig, TEvents>) => Promise<void> | void;
    readonly stop?: (
        app: ApplicationRuntime<TAppConfig, TEvents>,
        reason: ApplicationStopReason,
    ) => Promise<void> | void;
}

export interface ApplicationRuntime<TAppConfig = unknown, TEvents extends EventMap = InfraEvents> {
    readonly config: ApplicationBootstrapConfig;
    readonly appConfig: TAppConfig;
    readonly logger: Logger;
    readonly events: EventBus<TEvents>;
    readonly lifecycleBus?: EventBus<BusLifecycleEvents>;
    readonly db?: DbAdapter;
    readonly scheduler?: SchedulerAdapter;
    stop(reason?: ApplicationStopReason): Promise<void>;
}
```

This is an indicative shape. Final names can change during implementation, but the lifecycle and boundary
constraints are binding.

#### Node/Bun Config Loading Sketch

```ts
await runNodeApplication<BillingConfig>({
    configFile: 'config/app.yaml',
    bootstrapSection: 'bootstrap',
    appSection: 'billing',
    appConfig: {
        validate(raw) {
            return billingConfigSchema.parse(raw);
        },
    },
    async start(app) {
        app.logger.info('billing app started', {
            settlementWindowMinutes: app.appConfig.settlementWindowMinutes,
        });
    },
});
```

The concrete validator shape should avoid hard-coupling `ts-infra` to a specific validation library. A
Zod-compatible `safeParse` adapter is acceptable if implemented structurally.

#### Default Behavior

- Logging defaults to enabled console logging at `info`.
- Events default to enabled with lifecycle bus and default observers.
- Telemetry defaults to core instrumentation enabled, but exporter setup disabled unless a runtime-specific
  subpath enables it.
- Database defaults to disabled unless an adapter or valid adapter config is provided.
- Scheduler defaults to disabled unless entries or an adapter are provided. If enabled without an adapter,
  use the existing noop adapter only when that behavior is explicit in config.

### Solution

Implement the bootstrap as a thin orchestration layer over existing primitives:

- `initializeLogger` for logging
- `initTelemetry` / `shutdownTelemetry` for portable telemetry state
- `EventBus`, `createLifecycleBus`, and `attachDefaultObservers` for events
- `createDbAdapter` only in runtime-specific or DB-specific wiring paths
- `initScheduler` / injected `SchedulerAdapter` for scheduler setup
- `initNodeTelemetry` / `shutdownNodeTelemetry` only in the Node/Bun convenience subpath
- `RuntimeFactory.loadConfig()` and runtime file APIs only in the Node/Bun convenience subpath
- caller-provided config validators/parsers for application-specific YAML sections

Do not duplicate logger, config, DB, scheduler, or telemetry implementations.

### Plan

1. Add portable bootstrap types and implementation under `packages/infra/src/application/`.
2. Add Node/Bun convenience implementation under `packages/infra/src/application-node.ts` or
   `packages/infra/src/application/node.ts`, depending on existing subpath style.
3. Add package export map entries:
   - `./application`
   - `./application-node`
4. Add tests for portable lifecycle:
   - default services are created
   - disabled feature flags do not initialize services
   - startup order is deterministic
   - failed startup runs cleanup in reverse order
   - `stop()` is idempotent
5. Add tests for Node/Bun convenience behavior:
   - config loading is delegated to runtime
   - external YAML is split into bootstrap config and typed app config
   - app config validation errors include file path and section name
   - file logger path becomes a sink via runtime filesystem/log stream
   - DB adapter is created only when enabled and configured
   - Node telemetry exporter is initialized only when requested
   - Node scheduler adapter is used only when requested
6. Add import-boundary tests:
   - main infra barrel does not import bootstrap adapter subpaths as values
   - portable bootstrap does not import Node/Bun, OTel exporter SDKs, or DB adapter implementation modules
7. Update README examples and package subpath tests.
8. Run `bun run spur-check` and `bun run build`.

### Review


**Fix-pass 2026-06-07:** 6 fixed, 0 failed, 0 skipped (verdict FAIL → PASS)

| # | P | Fix | Location |
|---|---|-----|----------|
| 1 | P2 | Log sink now reads only `logging.filePath` (dropped erroneous `database.filePath` precedence) | application-node.ts:254 |
| 2 | P2 | `database.enabled` with unsupported/missing driver now throws `ConfigValidationError` instead of silently starting DB-less | application-node.ts:273-285 |
| 3 | P3 | Catch-block cleanup comment corrected to state DB/scheduler are caller-owned; telemetry is bootstrap-owned | application/index.ts:247-256 |
| 4 | P3 | `runNodeApplication` default `TEvents` aligned to `InfraEvents` (was bare `EventMap`) | application-node.ts:162,212 |
| 5 | P3 | Added deterministic file-sink test + unsupported-driver test; `application-node.ts` line coverage 90% → 100% | tests/application-node.test.ts |
| 6 | P4 | `runNodeApplication` returns a composed handle (spread + overridden `stop`) instead of mutating `app.stop` | application-node.ts:311-322 |

Gate: `bun run spur-check` → pass (1225 tests, both spur presets clean) · `bun run build` → pass (all 8 packages).


### P1 — Blockers

_None._

### P2 — Warnings

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Log file path resolved from `database.filePath` first | Correctness | application-node.ts:254-256 | `logFilePath` reads `databaseOpts.filePath` before `logging.filePath`. Per R3/R4 the file sink derives from `logging.filePath`. A stray `database.filePath` would hijack the log sink. Drop the `databaseOpts.filePath` branch; read only `yamlBootstrap.logging.filePath`. |
| 2 | DB enabled with unsupported driver silently no-ops | Correctness | application-node.ts:273-282 | When `database.enabled === true` but `driver !== 'bun-sqlite'` (or missing), no adapter is created and no error is raised. App starts DB-less while config says enabled. Throw a `ConfigValidationError` for unknown/missing driver when `enabled` is true. |

### P3 — Info

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 3 | Misleading dead-code comment in catch block | Usability | application/index.ts:248-252 | Comment claims `schedulerStarted` is "still false, so no stop needed" and the catch only shuts telemetry — but the documented R5 reverse-order cleanup (DB/scheduler) is genuinely absent. Either implement reverse cleanup for injected DB on start-failure or tighten the comment to state DB/scheduler are caller-owned and intentionally not closed. |
| 4 | `runNodeApplication` default `TEvents = EventMap` diverges from portable `InfraEvents` | Usability | application-node.ts:162,212 | Portable `runApplication` defaults `TEvents` to `InfraEvents`; the Node wrapper defaults to bare `EventMap`, weakening typed lifecycle/infra events for the common path. Align default to `InfraEvents`. |
| 5 | Node-subpath coverage gap on file-sink + telemetry-exporter paths | Correctness | application-node.ts:93-97,263-268 | Uncovered lines: `createFileSink` write body and `initNodeTelemetry` branch (90% line / 92% func). Add a test asserting `logging.filePath` produces a written log file, and one asserting `telemetry.endpoint` triggers the Node exporter. |

### P4 — Suggestions

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 6 | `app.stop` reassigned on a `readonly`-typed handle | Maintainability | application-node.ts:312-321 | `ApplicationRuntime.stop` is a method but the wrapper mutates `app.stop`. Works at runtime, but mutating the returned handle is fragile. Prefer composing a new handle object spreading `app` with an overridden `stop`. |


### Testing

Acceptance criteria:

- `@gobing-ai/ts-infra/application` provides portable `runApplication` and lifecycle types.
- `@gobing-ai/ts-infra/application-node` provides a Node/Bun convenience wrapper.
- The main `@gobing-ai/ts-infra` barrel remains portable and does not statically import adapter-only
  implementations.
- Startup and shutdown order are covered by unit tests.
- Startup failure cleanup is covered by a regression test.
- `stop()` idempotency is covered by a regression test.
- Feature flags are covered by table-driven tests.
- Portable `runApplication<TAppConfig>()` exposes typed `appConfig` without reading files.
- Node/Bun `runNodeApplication<TAppConfig>()` loads external YAML and validates an application-specific
  section with caller-provided validation.
- Config validation failures include config file path and section name.
- Node-specific convenience behavior is covered without requiring real external services.
- README examples compile or are covered by smoke tests where practical.
- `bun run spur-check` passes.
- `bun run build` passes.

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References

- [ADR-014: `ts-infra` Core/Adapter Boundary](../00_ADR.md#adr-014-ts-infra-coreadapter-boundary)
- [ADR-009: `ts-infra` Telemetry Instruments Against the Global Provider; Export Is an Opt-In Subpath](../00_ADR.md#adr-009-ts-infra-telemetry-instruments-against-the-global-provider-export-is-an-opt-in-subpath)
- [ADR-011/014 platform API ownership constraints](../00_ADR.md)
