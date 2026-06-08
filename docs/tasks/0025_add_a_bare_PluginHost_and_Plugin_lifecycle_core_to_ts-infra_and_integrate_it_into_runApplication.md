---
name: add a bare PluginHost and Plugin lifecycle core to ts-infra and integrate it into runApplication
description: add a bare PluginHost and Plugin lifecycle core to ts-infra and integrate it into runApplication
status: Done
created_at: 2026-06-08T19:26:01.968Z
updated_at: 2026-06-08T21:20:14.792Z
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

## 0025. add a bare PluginHost and Plugin lifecycle core to ts-infra and integrate it into runApplication

### Background

`@gobing-ai/ts-infra` already owns the application runtime: `runApplication` (portable
DI orchestrator in `packages/infra/src/application/`) and `runNodeApplication`
(`application-node.ts`) wire logger, EventBus, telemetry, optional DB, and optional
scheduler into a deterministic startup/shutdown lifecycle (task 0024).

Separately, the downstream Spur project built a plugin substrate in its own package
`packages/plugin-sdk` (`@gobing-ai/spur-plugin-sdk`): a `PluginHost`, a `SpurPlugin`
interface with `onLoad`/`onUnload`/`onServerStart`/`onServerStop`, nine capability
registries, a four-tier `TrustEngine`, a glob-pattern `EventRegistry` with a token-bucket
rate limiter, and a Zod manifest schema. Review of that package (Spur task 0029) found it
**over-engineered and entirely unused**: zero plugins exist on disk and not one registry
method is consumed in production code — only by the package's own tests and a thin server
route-mount shim.

The agreed direction (Robin, 2026-06-08): the plugin substrate is a **runtime** concern and
belongs next to the runtime lifecycle that ts-infra already owns. Rather than keep an unused,
heavy SDK in Spur, **upstream a bare `PluginHost` + `Plugin` core into ts-infra** so every
application built on ts-infra inherits a plugin mechanism for free — the same way they all
inherit `runApplication`. Capability registries and the trust ladder are **deferred**, not
ported; they can be re-added later as built-in plugins or a higher layer if a concrete need
appears.

This task delivers the upstream core and its `runApplication` integration. The downstream
deletion of `packages/plugin-sdk` and rewiring of spur-cli/spur-server is tracked separately
in **spur-new task 0029**, which depends on this task and consumes the result via a temporary
`bun link` until ts-infra publishes.

### Requirements

## Requirements

> Verdict badges from `/rd3:dev-verify 0025 --force` (2026-06-08). All MET.

- [x] **R1 — Bare `Plugin` interface** → **MET** | `application/plugins/types.ts:24` — `name`, `version`, `onLoad`/`onUnload`/`onStart`/`onStop`, runtime-neutral names.
- [x] **R2 — Bare `PluginHost`** → **MET** | `application/plugins/host.ts:27` — insertion-ordered `Map`, namespaced logger, EventBus ref, `register`/`unregister`/`has`/`list` + lifecycle fan-out.
- [x] **R3 — Fail-soft lifecycle fan-out** → **MET** | `host.ts:73` fail-fast `loadAll`; `host.ts:84,103,123` fail-soft `startAll`/`stopAll`/`unloadAll` (reverse for stop/unload).
- [x] **R4 — `runApplication` integration** → **MET** | `application/index.ts:226-244` (host build + load→start), `index.ts:55-59` (step-0 reverse shutdown), `index.ts:263` (exposed on runtime).
- [x] **R5 — Zero behavior change when unused** → **MET** | `index.ts:226-228` guards host construction; test `application.test.ts:424`.
- [x] **R6 — Subpath placement** → **MET** | `packages/infra/src/application/plugins/`; no Hono/fs/runtime imports; exported from portable `application` barrel (`index.ts:300-301`).
- [x] **R7 — Tests + gates** → **MET** | 24 host + 13 integration tests; `bun run check` green: biome + 8-package typecheck + 1254 tests pass / 0 fail.
- [x] **R8 — Docs/ADR** → **MET** | `docs/00_ADR.md:703-731` (2026-06-08 entry).


### Q&A

**Q1: Port the capability registries / trust ladder?** No. Bare `PluginHost` + `Plugin`
lifecycle only, first. Built-in plugins and any capability/trust layer are added later using
primitives ts-infra already has. (Robin, 2026-06-08.)

**Q2: Lifecycle hook naming?** Runtime-neutral `onStart`/`onStop`, not the Spur-era
`onServerStart`/`onServerStop` — the CLI is run-once and the server is long-lived, but both
share `start`/`stop` semantics through `runApplication`.

**Q3: Where in the startup order?** Plugins load+start after all infra services (logger,
events, telemetry, DB, scheduler-init) are ready and before/around the user `start` callback;
they stop+unload first during shutdown, before scheduler stop and DB close. This keeps plugins
able to use every infra service during their lifecycle.

**Q4: Release coordination with Spur?** `bun link` during dev (Spur links this unreleased
core); publish a new ts-infra semver; Spur bumps its catalog to the released version and
drops the link. (Robin, 2026-06-08.)

### Design

#### `Plugin` interface (target)

```ts
export interface Plugin {
    readonly name: string;
    readonly version: string;
    onLoad(host: PluginHost): void | Promise<void>;
    onUnload?(host: PluginHost): void | Promise<void>;
    onStart?(host: PluginHost): void | Promise<void>;
    onStop?(host: PluginHost): void | Promise<void>;
}
```

#### `PluginHost` (target)

```ts
export class PluginHost<TEvents extends EventMap = InfraEvents> {
    readonly logger: Logger;
    readonly events: EventBus<TEvents>;
    private readonly plugins = new Map<string, Plugin>(); // insertion-ordered

    constructor(events: EventBus<TEvents>, opts?: { logger?: Logger });

    register(plugin: Plugin): void;   // throw on duplicate name
    unregister(name: string): void;   // no-op if absent
    has(name: string): boolean;
    list(): ReadonlyArray<{ name: string; version: string }>;

    loadAll(): Promise<void>;   // fail-fast: onLoad in registration order
    startAll(): Promise<void>;  // fail-soft: onStart in registration order
    stopAll(): Promise<void>;   // fail-soft: onStop in REVERSE order
    unloadAll(): Promise<void>; // fail-soft: onUnload in REVERSE order
}
```

Fail-soft hooks catch + `logger.error` and continue (port the proven semantics from the Spur
SDK's `startServerHooks`/`stopServerHooks`). `loadAll` rethrows so a broken plugin fails the
bootstrap loudly.

#### `runApplication` integration seam

`packages/infra/src/application/index.ts` documents startup order: 1 config → … → 6 scheduler
init → 7 user `start` → 8 scheduler autoStart. Insert plugins as **6.5 / 7-wrapped**:

- **Startup:** after scheduler init, if `options.plugins` or `services.pluginHost` present,
  construct/resolve the host (over `app.events`), `await host.loadAll()`, `await host.startAll()`,
  then call the user `start(app)`. Expose `app.pluginHost`.
- **Shutdown (`performShutdown`):** new **step 0**, before the user stop callback and scheduler
  stop: `await host.stopAll()` then `await host.unloadAll()` (reverse order, fail-soft).

Add `pluginHost?: PluginHost` to `ApplicationServices` and `ApplicationRuntime`; add
`plugins?: Plugin[]` to `ApplicationBootstrapOptions`. When neither is set, no host is built (R5).

### Solution

**Chosen approach:** Upstream a bare lifecycle-only core (Plugin + PluginHost) into ts-infra's
portable `application` subpath and integrate it into `runApplication`'s existing deterministic
lifecycle. Defer capability registries and the trust ladder entirely.

Rejected alternatives:
- *Keep the substrate in Spur and just wire it* — leaves an unused 945-LOC over-engineered
  package in a downstream app and duplicates the mechanism for the next ts-infra consumer.
- *Port registries + trust now* — re-imports the speculative complexity this task exists to
  shed; no consumer needs capability gating yet (Spur ADR-012's `untrusted` tier is
  fail-closed / not loaded).

### Plan

1. **Core types + host.** Add `application/plugins/types.ts` (`Plugin`) and
   `application/plugins/host.ts` (`PluginHost`) with ordered map + fail-soft/fail-fast fan-out.
   Export from the `application` index. No runtime-specific imports.
2. **Options + runtime wiring.** Extend `ApplicationBootstrapOptions` (`plugins?`),
   `ApplicationServices` (`pluginHost?`), `ApplicationRuntime` (`pluginHost?`) in
   `application/types.ts`.
3. **Orchestrator integration.** In `application/index.ts`: construct/resolve host after
   scheduler init; `loadAll`→`startAll` before user `start`; add reverse-order
   `stopAll`→`unloadAll` as step 0 of `performShutdown`. Guard everything behind presence of
   `plugins`/`pluginHost` (R5).
4. **Node convenience subpath.** Confirm `runNodeApplication` passes `plugins`/`pluginHost`
   straight through (no extra file I/O in the portable core).
5. **Tests.** Host unit tests (register/collision/list/order; fail-fast load; fail-soft
   start/stop/unload). Orchestrator integration test (load→start ordering; reverse-order
   shutdown; no-host-when-unused).
6. **Docs/ADR.** Amend ts-libs `00_ADR.md` (+ `03`/`04` if present) recording the plugin core
   as a ts-infra runtime concern.
7. **Release coordination.** Cut a new ts-infra version; note in spur-new 0029 to switch from
   `bun link` to the released semver.

**Gate:** ts-libs `lint` · `test` · `build` green; clean `git status`.

### Review

## Review

**Verdict: PASS** (re-verified 2026-06-08 via `/rd3:dev-verify 0025 --force`) — all R1-R8 satisfied, no architectural drift.

- **R1 (Plugin interface):** `Plugin` in `plugins/types.ts:24` with `name`, `version`, `onLoad`/`onUnload`/`onStart`/`onStop`. Hooks accept `host: PluginHost`.
- **R2 (PluginHost):** Insertion-ordered `Map<string, Plugin>` (`host.ts:31`), namespaced logger, EventBus reference, `register`/`unregister`/`has`/`list`, lifecycle fan-out.
- **R3 (Fail-soft/fail-fast):** `loadAll()` fails fast (`host.ts:73`, rethrows); `startAll`/`stopAll`/`unloadAll` fail soft (log+skip). Reverse order for stop/unload.
- **R4 (runApplication integration):** Host constructed after scheduler init (`index.ts:226`), `loadAll→startAll` before user `start` (`index.ts:240-243`), `stopAll→unloadAll` step 0 of `performShutdown` (`index.ts:55-59`). Exposed on `ApplicationRuntime.pluginHost` (`index.ts:263`).
- **R5 (Zero-cost when unused):** No host constructed when no `plugins`/`pluginHost` provided (`index.ts:226-228`). Verified by `application.test.ts:424`.
- **R6 (Subpath placement):** `packages/infra/src/application/plugins/`, exported from portable `application` surface. No runtime-specific imports.
- **R7 (Tests + gates):** 24 host unit tests + 13 orchestrator integration tests. Full gate green: lint + typecheck (8 packages) + 1254 tests pass, 0 fail.
- **R8 (Docs/ADR):** ADR entry `docs/00_ADR.md:703-731` (2026-06-08).

### SECU Findings (Phase 7)

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Dual `PluginHost` declaration (interface in types.ts + class in host.ts) | Usability (P4) | application/plugins/types.ts:65 | Intentional type/impl split; no action. Optional: add a comment cross-linking the interface to its class implementation. |

- **Security:** No injection surface, no hardcoded secrets, no new dependencies, no sensitive-data leak in error logs. Clean.
- **Efficiency:** O(n) sequential lifecycle fan-out (correct for ordering deps); transient reverse-array alloc per shutdown is negligible. Clean.
- **Correctness:** Fail-fast/fail-soft split correct; reverse order correct for stop/unload; documented EventBus variance cast (`index.ts:228`) is sound. Clean.
- **Usability:** Full JSDoc, clear naming. Clean.

**Note (ADR cross-reference):** ADR-010 (2026-05) placed a *shared* plugin mechanism in `ts-runtime/plugin` for the rule/workflow engines; this task's `ts-infra` plugin core is a *separate runtime-lifecycle* concern (load/start/stop/unload for applications, not extension capability loading). The two coexist by design — ADR-010 = engine extension loading; ADR 2026-06-08 = application lifecycle plugins. No conflict, but the distinction should be kept in mind if they ever converge.


### Testing

**1252 tests pass, 0 fail. 100% line + func coverage on `plugins/host.ts`.**

- `packages/infra/tests/application/plugins/host.test.ts` — 24 tests: registration, collision, unregister, insertion order, fail-fast `loadAll`, fail-soft `startAll`/`stopAll`/`unloadAll`, reverse order for stop/unload.
- `packages/infra/tests/application.test.ts` (plugin integration block) — 10 tests: no-host-when-unused, pluginHost exposure, load-before-start ordering, reverse shutdown, plugin-stop-before-user-stop, injected host via services, fail-fast onLoad, fail-soft onStart, duplicate registration.

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References

- **Downstream consumer / sibling task:** `~/xprojects/spur-new/docs/tasks/0029_enhance_the_bootstrap_procedure_with_PluginHost_and_plugin_mechanism.md` — deletes `packages/plugin-sdk`, rewires spur-cli/spur-server onto this upstream core, and amends Spur ADR-012.
- **Prior art being upstreamed (bare-cored, not ported wholesale):** `~/xprojects/spur-new/packages/plugin-sdk/src/{host.ts,plugin.ts,events.ts}` — source of the fail-soft `startServerHooks`/`stopServerHooks` semantics.
- **Integration seam:** `packages/infra/src/application/index.ts` (startup order steps 6–8 + `performShutdown`), `packages/infra/src/application/types.ts` (`ApplicationBootstrapOptions`/`ApplicationServices`/`ApplicationRuntime`).
- **Bootstrap baseline:** ts-libs task `0024` (`runApplication` default implementation).

