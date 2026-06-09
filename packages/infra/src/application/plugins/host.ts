/**
 * Bare `PluginHost` — owns an insertion-ordered set of plugins and drives
 * lifecycle fan-out (load → start → stop → unload) with fail-soft semantics
 * for start/stop/unload and fail-fast for load.
 *
 * This is a runtime concern: it needs a logger and event bus, both provided
 * by the application bootstrap. No capabilities, no trust ladder.
 *
 * @module application/plugins
 */

import type { EventBus } from '../../event-bus/event-bus';
import type { EventMap } from '../../event-bus/types';
import { getLogger, type Logger } from '../../logger';
import type { Plugin, PluginSummary } from './types';

// ── PluginHost ─────────────────────────────────────────────────────────────

/**
 * Plugin host: registers plugins in insertion order and drives their lifecycle
 * fan-out (load → start → stop → unload).
 *
 * The host stores `EventBus<EventMap>` (the base event contract) rather than
 * a narrower `TEvents` subtype, because `EventBus` is invariant in its type
 * parameter and plugins only need the base contract.
 */
export class PluginHost {
    readonly logger: Logger;
    readonly events: EventBus<EventMap>;

    private readonly _plugins = new Map<string, Plugin>();

    constructor(events: EventBus<EventMap>, opts?: { logger?: Logger }) {
        this.events = events;
        this.logger = opts?.logger ?? getLogger('plugin-host');
    }

    // ── Registration ────────────────────────────────────────────────────

    /** Register a plugin. Throws on duplicate name. */
    register(plugin: Plugin): void {
        if (this._plugins.has(plugin.name)) {
            throw new Error(`Plugin already registered: ${plugin.name}`);
        }
        this._plugins.set(plugin.name, plugin);
    }

    /** Remove a plugin by name. No-op if absent. */
    unregister(name: string): void {
        this._plugins.delete(name);
    }

    /** Check whether a plugin is registered. */
    has(name: string): boolean {
        return this._plugins.has(name);
    }

    /** List registered plugins in registration order. */
    list(): readonly PluginSummary[] {
        const result: PluginSummary[] = [];
        for (const p of this._plugins.values()) {
            result.push({ name: p.name, version: p.version });
        }
        return result;
    }

    // ── Lifecycle fan-out ───────────────────────────────────────────────

    /**
     * Fail-fast: calls `onLoad` on every plugin in registration order.
     * A throwing hook aborts the bootstrap.
     */
    async loadAll(): Promise<void> {
        for (const plugin of this._plugins.values()) {
            this.logger.debug(`Loading plugin: ${plugin.name}`, { name: plugin.name });
            await plugin.onLoad(this);
        }
    }

    /**
     * Calls `onStart` on every plugin in registration order.
     * Plugins with `failFast: true` rethrow (aborting boot); others log + skip.
     */
    async startAll(): Promise<void> {
        for (const plugin of this._plugins.values()) {
            if (!plugin.onStart) continue;
            try {
                this.logger.debug(`Starting plugin: ${plugin.name}`, { name: plugin.name });
                await plugin.onStart(this);
            } catch (err) {
                if (plugin.failFast) {
                    throw err;
                }
                this.logger.error(`Plugin start hook failed: ${plugin.name}`, {
                    name: plugin.name,
                    error: (err as Error).message,
                });
            }
        }
    }

    /**
     * Fail-soft: calls `onStop` on every plugin in **reverse** registration order.
     * A throwing hook is logged + skipped.
     * `reason` is forwarded to each plugin's `onStop(host, reason?)`.
     */
    async stopAll(reason?: string): Promise<void> {
        const reversed = [...this._plugins.values()].reverse();
        for (const plugin of reversed) {
            if (!plugin.onStop) continue;
            try {
                this.logger.debug(`Stopping plugin: ${plugin.name}`, { name: plugin.name, reason });
                await plugin.onStop(this, reason);
            } catch (err) {
                this.logger.error(`Plugin stop hook failed: ${plugin.name}`, {
                    name: plugin.name,
                    error: (err as Error).message,
                });
            }
        }
    }

    /**
     * Fail-soft: calls `onUnload` on every plugin in **reverse** registration order.
     * A throwing hook is logged + skipped.
     * `reason` is forwarded to each plugin's `onUnload(host, reason?)`.
     */
    async unloadAll(reason?: string): Promise<void> {
        const reversed = [...this._plugins.values()].reverse();
        for (const plugin of reversed) {
            if (!plugin.onUnload) continue;
            try {
                this.logger.debug(`Unloading plugin: ${plugin.name}`, { name: plugin.name, reason });
                await plugin.onUnload(this, reason);
            } catch (err) {
                this.logger.error(`Plugin unload hook failed: ${plugin.name}`, {
                    name: plugin.name,
                    error: (err as Error).message,
                });
            }
        }
    }
}
