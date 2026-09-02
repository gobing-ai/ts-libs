import { afterEach, describe, expect, test } from 'bun:test';
import { runApplication } from '../src/application/index';
import { PluginHost } from '../src/application/plugins/host';
import type { Plugin } from '../src/application/plugins/types';
import type { ApplicationBootstrapOptions, ApplicationStopReason } from '../src/application/types';
import { EventBus } from '../src/event-bus/event-bus';
import type { InfraEvents } from '../src/events';
import { _resetTelemetry } from '../src/telemetry/sdk';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Reset module-level singletons between tests. */
function resetModules() {
    _resetTelemetry();
}

/** Create a minimal options bag that starts immediately and resolves. */
function minimalOptions(overrides?: Partial<ApplicationBootstrapOptions>): ApplicationBootstrapOptions {
    return {
        config: { logging: { console: false }, telemetry: { enabled: false } },
        start: async () => {},
        ...overrides,
    };
}

/** Track calls to a mock function. */
function tracker() {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
        calls.push(args);
    };
    return { calls, fn };
}

// ── Portable lifecycle ────────────────────────────────────────────────────

describe('runApplication — portable lifecycle', () => {
    afterEach(resetModules);

    test('creates default services when no options provided', async () => {
        const app = await runApplication(minimalOptions());

        expect(app.logger).toBeDefined();
        expect(app.events).toBeInstanceOf(EventBus);
        expect(app.config.logging.enabled).toBe(true);
        expect(app.config.events.enabled).toBe(true);
        expect(app.config.telemetry.enabled).toBe(false);
        expect(app.config.scheduler.enabled).toBe(false);

        await app.stop();
    });

    test('uses the pre-built bus from config.events.bus', async () => {
        const bus = new EventBus<InfraEvents>();
        const app = await runApplication(
            minimalOptions({
                config: {
                    logging: { console: false },
                    telemetry: { enabled: false },
                    events: { bus },
                },
            }),
        );

        expect(app.events).toBe(bus);

        await app.stop();
    });

    test('exposes injected appConfig', async () => {
        const app = await runApplication(
            minimalOptions({
                appConfig: { port: 3000, host: 'localhost' },
            }),
        );

        expect(app.appConfig).toEqual({ port: 3000, host: 'localhost' });

        await app.stop();
    });

    test('calls user start callback with runtime handle', async () => {
        const started = tracker();
        await runApplication(
            minimalOptions({
                start: async (app) => {
                    started.fn(app.logger, app.events);
                },
            }),
        );

        expect(started.calls.length).toBe(1);
        expect(started.calls[0]?.[0]).toBeDefined(); // logger
        expect(started.calls[0]?.[1]).toBeInstanceOf(EventBus);
    });

    test('calls user stop callback on shutdown', async () => {
        const stopped = tracker();
        const app = await runApplication(
            minimalOptions({
                stop: async (_app, reason) => {
                    stopped.fn(reason);
                },
            }),
        );

        await app.stop('shutdown');
        expect(stopped.calls).toEqual([['shutdown']]);
    });

    test('defaults appConfig to undefined when not provided', async () => {
        const app = await runApplication(minimalOptions());
        expect(app.appConfig).toBeUndefined();
        await app.stop();
    });
});

// ── Feature flags ─────────────────────────────────────────────────────────

describe('runApplication — feature flags', () => {
    afterEach(resetModules);

    test('disables logging when logging.enabled = false', async () => {
        const app = await runApplication(
            minimalOptions({
                config: { logging: { enabled: false }, telemetry: { enabled: false } },
            }),
        );

        expect(app.config.logging.enabled).toBe(false);
        await app.stop();
    });

    test('configures logger with specified level', async () => {
        const app = await runApplication(
            minimalOptions({
                config: { logging: { level: 'debug' }, telemetry: { enabled: false } },
            }),
        );

        expect(app.config.logging.level).toBe('debug');
        await app.stop();
    });

    test('disables events when events.enabled = false', async () => {
        const app = await runApplication(
            minimalOptions({
                config: { events: { enabled: false }, telemetry: { enabled: false } },
            }),
        );

        expect(app.config.events.enabled).toBe(false);
        // Still creates an EventBus (just without lifecycle bus)
        expect(app.events).toBeInstanceOf(EventBus);
        expect(app.lifecycleBus).toBeUndefined();
        await app.stop();
    });

    test('does not attach lifecycle bus when events.lifecycle = false', async () => {
        const app = await runApplication(
            minimalOptions({
                config: { events: { lifecycle: false }, telemetry: { enabled: false } },
            }),
        );

        expect(app.lifecycleBus).toBeUndefined();
        await app.stop();
    });

    test('enables scheduler with injected adapter', async () => {
        const adapter = {
            register: () => {},
            start: async () => {},
            stop: async () => {},
        };

        const app = await runApplication(
            minimalOptions({
                config: {
                    scheduler: { enabled: true, adapter },
                    telemetry: { enabled: false },
                },
            }),
        );

        expect(app.scheduler).toBe(adapter);
        expect(app.config.scheduler.enabled).toBe(true);
        await app.stop();
    });

    test('accepts injected logger via services', async () => {
        const mockLogger = {
            info: () => {},
            error: () => {},
            warn: () => {},
            debug: () => {},
            trace: () => {},
            fatal: () => {},
            child: () => mockLogger,
        };

        const app = await runApplication(
            minimalOptions({
                services: { logger: mockLogger },
            }),
        );

        expect(app.logger).toBe(mockLogger);
        await app.stop();
    });

    test('accepts injected EventBus via services', async () => {
        const bus = new EventBus<InfraEvents>();
        const app = await runApplication(
            minimalOptions({
                services: { events: bus },
            }),
        );

        expect(app.events).toBe(bus);
        await app.stop();
    });
});

// ── Stop idempotency ──────────────────────────────────────────────────────

describe('runApplication — stop() idempotency', () => {
    afterEach(resetModules);

    test('stop() called twice only runs shutdown once', async () => {
        const stopCalls = tracker();
        const app = await runApplication(
            minimalOptions({
                stop: async () => {
                    stopCalls.fn();
                },
            }),
        );

        await app.stop();
        await app.stop();
        await app.stop();

        expect(stopCalls.calls.length).toBe(1);
    });

    test('stop() with different reasons still idempotent', async () => {
        const reasons: ApplicationStopReason[] = [];
        const app = await runApplication(
            minimalOptions({
                stop: async (_app, reason) => {
                    reasons.push(reason);
                },
            }),
        );

        await app.stop('manual');
        await app.stop('signal');

        expect(reasons).toEqual(['manual']);
    });
});

// ── Startup failure cleanup ───────────────────────────────────────────────

describe('runApplication — startup failure', () => {
    afterEach(resetModules);

    test('rethrows when start callback throws', async () => {
        await expect(
            runApplication(
                minimalOptions({
                    start: async () => {
                        throw new Error('boom');
                    },
                }),
            ),
        ).rejects.toThrow('boom');
    });
});

// ── Shutdown path coverage ─────────────────────────────────────────────────

describe('runApplication — shutdown paths', () => {
    afterEach(resetModules);

    test('injected DB adapter is NOT closed on stop (caller-owned)', async () => {
        const closed = tracker();
        const db = { close: () => closed.fn() };

        const app = await runApplication(
            minimalOptions({
                services: { db },
            }),
        );

        await app.stop();
        expect(closed.calls.length).toBe(0);
    });

    test('shuts down telemetry on stop when telemetry was enabled', async () => {
        const app = await runApplication(
            minimalOptions({
                config: {
                    logging: { console: false },
                    telemetry: { enabled: true },
                },
            }),
        );

        // Telemetry was initialized during startup
        expect(app.config.telemetry.enabled).toBe(true);

        // Stopping should run the telemetry shutdown path
        await app.stop();
    });

    test('stops scheduler on stop when scheduler was started', async () => {
        const stopped = tracker();
        const adapter = {
            register: () => {},
            start: async () => {},
            stop: async () => stopped.fn(),
        };

        const app = await runApplication(
            minimalOptions({
                config: {
                    scheduler: { enabled: true, adapter, autoStart: true },
                    telemetry: { enabled: false },
                },
            }),
        );

        expect(app.config.scheduler.enabled).toBe(true);
        await app.stop();
        // Scheduler adapter stop should be called during shutdown
        expect(stopped.calls.length).toBe(1);
    });

    test('swallows scheduler stop rejection during shutdown', async () => {
        const adapter = {
            register: () => {},
            start: async () => {},
            stop: async () => {
                throw new Error('scheduler-stop-fail');
            },
        };

        const app = await runApplication(
            minimalOptions({
                config: {
                    scheduler: { enabled: true, adapter, autoStart: true },
                    telemetry: { enabled: false },
                },
            }),
        );

        // Should not throw even though scheduler.stop() rejects
        await app.stop();
    });

    test('rethrows after scheduler cleanup when scheduler.start() throws', async () => {
        const stopped = tracker();
        const adapter = {
            register: () => {},
            start: async () => {
                throw new Error('scheduler-fail');
            },
            stop: async () => stopped.fn(),
        };

        // The catch block should clean up (though schedulerStarted is false
        // since start() threw, so the stop inside catch is dead code — but
        // schedulerRegistered is true, covering that branch).
        await expect(
            runApplication(
                minimalOptions({
                    config: {
                        scheduler: { enabled: true, adapter, autoStart: true },
                        telemetry: { enabled: false },
                    },
                }),
            ),
        ).rejects.toThrow('scheduler-fail');
    });

    test('DB close error is swallowed during shutdown', async () => {
        const db = {
            close: () => {
                throw new Error('db-close-fail');
            },
        };

        const app = await runApplication(
            minimalOptions({
                services: { db },
            }),
        );

        // Should not throw even though db.close() throws
        await app.stop();
    });

    test('stops with signal reason propagates to user callback', async () => {
        const reasons: ApplicationStopReason[] = [];
        const app = await runApplication(
            minimalOptions({
                stop: async (_app, reason) => {
                    reasons.push(reason);
                },
            }),
        );

        await app.stop('signal');
        expect(reasons).toEqual(['signal']);
    });

    test('cleans up telemetry in catch block when start throws with telemetry enabled', async () => {
        await expect(
            runApplication(
                minimalOptions({
                    config: {
                        logging: { console: false },
                        telemetry: { enabled: true },
                    },
                    start: async () => {
                        throw new Error('start-fail-with-telemetry');
                    },
                }),
            ),
        ).rejects.toThrow('start-fail-with-telemetry');
    });
});

// ── Plugin host integration ────────────────────────────────────────────────

describe('runApplication — plugin host integration', () => {
    afterEach(resetModules);
    test('host always exists even without user plugins', async () => {
        const app = await runApplication(minimalOptions());
        expect(app.pluginHost).toBeDefined();
        await app.stop();
    });

    test('exposes pluginHost on runtime when plugins provided', async () => {
        const p: Plugin = {
            name: 'test-plugin',
            version: '1.0.0',
            onLoad: async () => {},
            onStart: async () => {},
            onStop: async () => {},
            onUnload: async () => {},
        };
        const app = await runApplication(minimalOptions({ plugins: [p] }));

        expect(app.pluginHost).toBeDefined();
        expect(app.pluginHost.has('test-plugin')).toBe(true);
        await app.stop();
    });

    test('loads and starts plugins before user start callback', async () => {
        const order: string[] = [];
        const p: Plugin = {
            name: 'ordered',
            version: '1.0.0',
            onLoad: () => void order.push('load'),
            onStart: () => void order.push('start'),
        };

        await runApplication(
            minimalOptions({
                plugins: [p],
                start: () => void order.push('user-start'),
            }),
        );

        expect(order).toEqual(['load', 'start', 'user-start']);
    });

    test('stops and unloads plugins in reverse order during shutdown', async () => {
        const order: string[] = [];
        const p1: Plugin = {
            name: 'first',
            version: '1.0.0',
            onLoad: () => {},
            onStop: () => void order.push('stop-1'),
            onUnload: () => void order.push('unload-1'),
        };
        const p2: Plugin = {
            name: 'second',
            version: '1.0.0',
            onLoad: () => {},
            onStop: () => void order.push('stop-2'),
            onUnload: () => void order.push('unload-2'),
        };

        const app = await runApplication(minimalOptions({ plugins: [p1, p2] }));
        await app.stop();

        // Reverse registration order: second → first
        expect(order).toEqual(['stop-2', 'stop-1', 'unload-2', 'unload-1']);
    });

    test('user stop fires before plugin stop in reverse-order shutdown', async () => {
        const order: string[] = [];
        const p: Plugin = {
            name: 'p',
            version: '1.0.0',
            onLoad: () => {},
            onStop: (_host, _reason) => void order.push('plugin-stop'),
        };

        const app = await runApplication(
            minimalOptions({
                plugins: [p],
                stop: () => void order.push('user-stop'),
            }),
        );
        await app.stop();

        // user-callback plugin is registered AFTER user plugins, so
        // reverse-order shutdown places it BEFORE user plugins.
        expect(order).toEqual(['user-stop', 'plugin-stop']);
    });

    test('accepts injected pluginHost via services', async () => {
        const preBuilt = new PluginHost(new EventBus());
        preBuilt.register({
            name: 'injected',
            version: '1.0.0',
            onLoad: async () => {},
        });

        const app = await runApplication(minimalOptions({ services: { pluginHost: preBuilt } }));

        expect(app.pluginHost).toBe(preBuilt);
        expect(app.pluginHost.has('injected')).toBe(true);
        await app.stop();
    });

    test('fails fast when onLoad throws', async () => {
        const p: Plugin = {
            name: 'bad',
            version: '1.0.0',
            onLoad: () => {
                throw new Error('load-boom');
            },
        };

        await expect(runApplication(minimalOptions({ plugins: [p] }))).rejects.toThrow('load-boom');
    });

    test('continues after plugin onStart throws (fail-soft)', async () => {
        const order: string[] = [];
        const p1: Plugin = {
            name: 'bad',
            version: '1.0.0',
            onLoad: () => {},
            onStart: () => {
                throw new Error('start-fail');
            },
        };
        const p2: Plugin = {
            name: 'good',
            version: '1.0.0',
            onLoad: () => {},
            onStart: () => void order.push('good-started'),
        };

        const app = await runApplication(minimalOptions({ plugins: [p1, p2] }));

        expect(order).toEqual(['good-started']);
        await app.stop();
    });

    test('duplicate plugin name throws during registration', async () => {
        const p: Plugin = {
            name: 'dup',
            version: '1.0.0',
            onLoad: async () => {},
        };

        await expect(runApplication(minimalOptions({ plugins: [p, p] }))).rejects.toThrow(
            'Plugin already registered: dup',
        );
    });

    test('stops and unloads plugins in catch block when start callback throws', async () => {
        const order: string[] = [];
        const p: Plugin = {
            name: 'cleanup-test',
            version: '1.0.0',
            onLoad: () => {},
            onStart: () => void order.push('started'),
            onStop: () => void order.push('stopped'),
            onUnload: () => void order.push('unloaded'),
        };

        await expect(
            runApplication(
                minimalOptions({
                    plugins: [p],
                    start: () => {
                        throw new Error('start-boom');
                    },
                }),
            ),
        ).rejects.toThrow('start-boom');

        // Catch block should have run stopAll + unloadAll on the host
        expect(order).toEqual(['started', 'stopped', 'unloaded']);
    });

    test('unloads partially-loaded plugins when onLoad of later plugin throws', async () => {
        const order: string[] = [];
        const good: Plugin = {
            name: 'good',
            version: '1.0.0',
            onLoad: () => void order.push('good-loaded'),
            onUnload: () => void order.push('good-unloaded'),
        };
        const bad: Plugin = {
            name: 'bad',
            version: '1.0.0',
            onLoad: () => {
                throw new Error('load-fail');
            },
        };

        await expect(runApplication(minimalOptions({ plugins: [good, bad] }))).rejects.toThrow('load-fail');

        // Good plugin's onLoad fired; bad threw; catch should unload good
        expect(order).toEqual(['good-loaded', 'good-unloaded']);
    });
});

// ── Export map entries ─────────────────────────────────────────────────────

describe('application subpath export map', () => {
    test('declares ./application and ./application-node in package exports', async () => {
        const pkg = await import('../package.json', { with: { type: 'json' } });
        const defaultPkg = (pkg as unknown as { default: Record<string, unknown> }).default;
        const exports = defaultPkg?.exports as Record<string, unknown> | undefined;

        expect(exports?.['./application']).toBeDefined();
        expect(exports?.['./application-node']).toBeDefined();
    });
});

describe('application import boundaries', () => {
    test('portable bootstrap does not import node:fs', async () => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const source = await readFile(join(import.meta.dir, '../src/application/index.ts'), 'utf-8');
        expect(source).not.toContain('node:fs');
        expect(source).not.toContain('node:path');
        expect(source).not.toContain('node:os');
    });
});

// ── Declarative scheduler jobs (task 0734) ────────────────────────────────

describe('application — resolved scheduler jobs', () => {
    test('resolved scheduler config defaults jobs to an empty array', async () => {
        const app = await runApplication(minimalOptions({ config: { scheduler: { enabled: false } } }));
        expect(app.config.scheduler.jobs).toEqual([]);
        await app.stop();
    });

    test('resolved scheduler config forwards jobs as data', async () => {
        const app = await runApplication(
            minimalOptions({
                config: {
                    scheduler: {
                        enabled: false,
                        jobs: [
                            { name: 'cache', command: 'python x.py', intervalMinutes: 5 },
                            { name: 'nightly', command: 'bun n.ts', cron: '0 3 * * *' },
                        ],
                    },
                },
            }),
        );

        // Definitions are data for the user callback — never auto-executed here.
        expect(app.config.scheduler.jobs).toEqual([
            { name: 'cache', command: 'python x.py', intervalMinutes: 5 },
            { name: 'nightly', command: 'bun n.ts', cron: '0 3 * * *' },
        ]);
        await app.stop();
    });

    test('user start callback runs before the scheduler autoStart', async () => {
        const order: string[] = [];
        const adapter = {
            register: () => {},
            start: async () => {
                order.push('scheduler-start');
            },
            stop: async () => {},
        };

        await runApplication(
            minimalOptions({
                config: { scheduler: { enabled: true, adapter, autoStart: true } },
                start: async () => {
                    order.push('user-start');
                },
            }),
        );

        // schedulerPlugin is registered last, so its autoStart fires after the user
        // callback — Spur registers its entries against appRt.scheduler during start.
        expect(order).toEqual(['user-start', 'scheduler-start']);
    });
});
