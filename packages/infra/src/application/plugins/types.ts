/**
 * Portable plugin lifecycle contract.
 *
 * The `Plugin` interface is a minimal runtime-neutral lifecycle contract:
 * no capabilities, no trust ladder, no manifest schema — just `onLoad` / `onUnload`
 * and `onStart` / `onStop` hooks. Names are deliberately runtime-neutral so
 * CLI and long-lived server apps share the same semantics.
 *
 * @module application/plugins
 */

import type { EventBus } from '../../event-bus/event-bus';
import type { EventMap } from '../../event-bus/types';
import type { Logger } from '../../logger';

// ── Plugin contract ────────────────────────────────────────────────────────

/**
 * Minimal plugin lifecycle contract.
 *
 * All hooks receive the host reference so a plugin can access the runtime
 * logger, event bus, and other plugins.
 */
export interface Plugin {
    /** Unique name. Used for dedup and lookup in the host. */
    readonly name: string;

    /** Semver-compatible version string. Informational only in this cut. */
    readonly version: string;

    /**
     * Called during `PluginHost.loadAll()` — fail-fast.
     * A throwing `onLoad` aborts the bootstrap.
     */
    onLoad(host: PluginHost): void | Promise<void>;

    /** Called during `PluginHost.unloadAll()` — fail-soft. */
    onUnload?(host: PluginHost): void | Promise<void>;

    /** Called during `PluginHost.startAll()` — fail-soft. */
    onStart?(host: PluginHost): void | Promise<void>;

    /** Called during `PluginHost.stopAll()` — fail-soft. */
    onStop?(host: PluginHost): void | Promise<void>;
}

// ── Plugin host public shape ───────────────────────────────────────────────

/**
 * Summary view of a registered plugin (no references, just metadata).
 */
export interface PluginSummary {
    readonly name: string;
    readonly version: string;
}

// ── PluginHost structural interface ────────────────────────────────────────

/**
 * Structural contract for the plugin host.
 *
 * This is the shape exposed on `ApplicationRuntime.pluginHost`. Consumers
 * that need to register/unregister plugins at runtime use this interface.
 */
export interface PluginHost {
    readonly logger: Logger;
    readonly events: EventBus<EventMap>;

    register(plugin: Plugin): void;
    unregister(name: string): void;
    has(name: string): boolean;
    list(): readonly PluginSummary[];

    loadAll(): Promise<void>;
    startAll(): Promise<void>;
    stopAll(): Promise<void>;
    unloadAll(): Promise<void>;
}
