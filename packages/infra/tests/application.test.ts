import { afterEach, describe, expect, test } from 'bun:test';
import { runApplication } from '../src/application/index';
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

    test('closes DB adapter on stop', async () => {
        const closed = tracker();
        const db = { close: () => closed.fn() };

        const app = await runApplication(
            minimalOptions({
                services: { db },
            }),
        );

        await app.stop();
        expect(closed.calls.length).toBe(1);
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
