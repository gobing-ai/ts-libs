# Brainstorm — Default Application Bootstrap (`runApplication`)

- **Task:** `docs/tasks/0024_add_the_default_implementation_of_application_bootstrap.md`
- **Date:** 2026-06-07
- **Decision:** Approach 3b — plugin-based bootstrap on the existing `ts-runtime` plugin core.

## Problem

Provide a one-call entry point `runApplication(options)` that wires the standard
subsystems behind feature flags + per-feature options, with sensible defaults and
graceful shutdown. The 6 named features (logger, external config, DB, EventBus,
telemetry, scheduler) are a **sample, not a closed set** — extensibility is required.

## Grounding (verified existing primitives)

- **DI container:** `RuntimeContext` (ts-runtime) — `register`/`get`/`require`/`dispose`;
  `createRuntimeContextFromFactory()` auto-wires `config`/`fileSystem`/`processExecutor`.
- **Config:** `configSchema` (Zod) with `app`/`database`/`logging`, env interpolation,
  YAML load, `deepFreeze`.
- **Subsystem lifecycles (ts-infra):** `initializeLogger`, `initTelemetry`/`shutdownTelemetry`,
  `initMetrics`/`shutdownMetrics`, `initScheduler` + `adapter.start()`,
  `createLifecycleBus`/`attachDefaultObservers`.
- **Plugin core (ts-runtime, ADR-010):** `CapabilityRegistry<T>` (generic named store,
  replace-by-name, builtin/extension origin, insertion order) + `loadExtensionModules`
  (trust-gated dynamic loader). **No lifecycle/ordering** — that is net-new.

## Key constraints

- `ts-infra` and `ts-runtime` are **siblings** today (`runtime → utils`; `infra → db → utils`).
- ADR-011: ts-infra must not open files; `fileSystem` is injected.
- ADR-010: single-source the plugin core in `ts-runtime`; new domains define their own
  capability type over `CapabilityRegistry`.

## Decisions (operator-confirmed)

| Decision | Choice |
|---|---|
| Approach | **3b** — plugin builder on existing plugin core |
| Composition root location | **`ts-infra`** (per task), new `src/bootstrap/` |
| Boundary | **Add `ts-infra → ts-runtime` dependency** + write a new dated ADR entry first |
| Registry | Host `CapabilityRegistry<BootstrapFeature>`; file-declared features via `loadExtensionModules` |
| Ordering | **`dependsOn` topological sort**; teardown in reverse topological order |
| Deferral | **Both** — lazy thunks (config-time) for config/fileSystem + `provide()` post-start late binding, with not-ready guards |

## Proposed shape

```ts
interface BootstrapContext {
  config: Config;
  fileSystem?: FileSystem;                                  // may be deferred
  require<T>(key: string): T;                               // resolves lazy thunks; throws if not ready
  provide<T>(key: string, svc: T | (() => Promise<T>)): void; // post-start late binding
  logger: Logger;
}

interface BootstrapFeature {
  name: string;
  dependsOn?: string[];                                     // topological ordering
  setup(ctx: BootstrapContext): void | Promise<void>;
  teardown?(ctx: BootstrapContext): void | Promise<void>;
}

interface RunApplicationOptions {
  config?: Config | (() => Promise<Config>);
  fileSystem?: FileSystem | (() => Promise<FileSystem>);    // lazy thunk (config-time deferral)
  features?: BootstrapFeature[];                            // defaults = the 6, replaceable/extendable
  enabled?: Partial<Record<string, boolean>>;              // flag layer over features
  allowExtensions?: boolean;                                // reuse loadExtensionModules trust gate
  extensions?: ExtensionRef[];
}

async function runApplication(opts: RunApplicationOptions): Promise<AppHandle>;
// AppHandle: { context, provide(), shutdown() /* reverse-topological teardown */, registry }
```

## Net-new work (not provided by the plugin core)

1. New ADR entry sanctioning `ts-infra → ts-runtime`.
2. `BootstrapFeature` capability type + host on `CapabilityRegistry`.
3. Topological sort by `dependsOn`; lifecycle loop (`setup` all → run → `teardown` LIFO).
4. Lazy-resolution + late-binding container semantics with not-ready guards.
5. 6 default features wrapping existing `init*`/`shutdown*`.
6. DB connect/dispose seam (ts-db barrel exposes none today) — add or inject a handle.
7. Spur rule + tsconfig `paths` update for the new dependency edge.

## Rejected alternatives

- **Approach 1 (infra-local AppContext, flag bag):** simplest, no new edge, but a *closed*
  feature set — fails the "sample, not limit" + "leverage plugin mechanism" requirements.
- **Approach 2 (root in ts-runtime, extend RuntimeContext):** inverts the dep graph
  (runtime→infra), contradicts ADR-011's intent and the task's placement.

## Open implementation questions

1. **Config schema home** for telemetry/scheduler/eventBus sections: extend `configSchema`
   in ts-runtime vs. infra-local feature-option types. Lean infra-local to keep infra
   self-contained.
2. **DB connect/dispose seam**: add documented adapter lifecycle vs. inject ready handle.
3. **not-ready guard semantics**: throw vs. await-until-provided for `require()` of a
   late-bound service.

## Next step

`/rd3:dev-plan` on this file → ADR draft + WBS.
