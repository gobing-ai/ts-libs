import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metrics, trace } from '@opentelemetry/api';
import type { ApplicationConfigValidator, SchedulerOptions } from '../src/application/types';
import { ConfigValidationError, runNodeApplication } from '../src/application-node';
import { setLoggerMuted } from '../src/logger';
import type { ScheduledAction, SchedulerAdapter } from '../src/scheduler/types';
import { NodeSchedulerAdapter } from '../src/scheduler-node';
import { _resetMetrics, getHttpClientRequestTotal } from '../src/telemetry/metrics';
import { _resetNodeTelemetry } from '../src/telemetry/otel-node';
import { _resetTelemetry } from '../src/telemetry/sdk';

// ── Helpers ───────────────────────────────────────────────────────────────

function resetModules() {
    _resetTelemetry();
    // Drop global OTel registrations so a Node-telemetry test cannot leak a
    // provider into sibling suites (matches otel-node.test.ts teardown).
    trace.disable();
    metrics.disable();
    _resetNodeTelemetry();
    // Restore logger output for sibling suites. LogTape is process-global and
    // not reset here; muting only suppresses emission for this file's tests.
    setLoggerMuted(false);
}

// PluginHost grabs a `plugin-host` logger in its constructor and emits DEBUG
// lifecycle lines during loadAll/startAll — before `builtin:logger.onStart`
// calls `initializeLogger()`. LogTape is process-global, so a console sink
// left by a prior suite surfaces that fan-out on stdout. Mute for every test
// (matches scheduler-node.test.ts); resetModules restores output afterward.
beforeEach(() => {
    setLoggerMuted(true);
});

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'infra-app-test-'));
}

function writeYaml(dir: string, filename: string, content: string): string {
    const path = join(dir, filename);
    writeFileSync(path, content, 'utf-8');
    return path;
}

// ── Config loading ─────────────────────────────────────────────────────────

describe('runNodeApplication — config loading', () => {
    afterEach(resetModules);

    test('loads bootstrap config from YAML file', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'app.yaml',
            `
bootstrap:
  logging:
    level: debug
    console: false
  telemetry:
    enabled: false
app:
  name: test-app
`,
        );
        try {
            const app = await runNodeApplication({
                configLoader: {
                    configFile: configPath,
                    bootstrapSection: 'bootstrap',
                },
                start: async () => {},
            });

            expect(app.config.logging.level).toBe('debug');
            expect(app.config.telemetry.enabled).toBe(false);
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('honors YAML events.fileObserver false', async () => {
        const dir = tmpDir();
        const recorded: string[] = [];
        const configPath = writeYaml(
            dir,
            'app.yaml',
            `
bootstrap:
  events:
    fileObserver: false
  telemetry:
    enabled: false
`,
        );
        try {
            const app = await runNodeApplication({
                configLoader: { configFile: configPath, bootstrapSection: 'bootstrap' },
                services: {
                    fileObserverWriter: {
                        ensureDir() {},
                        appendFile(_path, content) {
                            recorded.push(content);
                        },
                    },
                },
                start() {},
            });

            await app.events.emit('api.request.error', { url: '/x', method: 'GET', error: 'boom' });
            expect(app.config.events.fileObserver).toBe(false);
            expect(recorded).toEqual([]);
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('validates app config with safeParse validator', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'app.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
billing:
  settlementWindowMinutes: 15
  riskLimit: 100000
`,
        );
        interface BillingConfig {
            settlementWindowMinutes: number;
            riskLimit: number;
        }

        const validator: ApplicationConfigValidator<BillingConfig> = {
            safeParse(raw: unknown) {
                if (typeof raw === 'object' && raw !== null && 'settlementWindowMinutes' in raw) {
                    return { success: true, data: raw as BillingConfig };
                }
                return { success: false, errors: [{ path: '$', message: 'missing settlementWindowMinutes' }] };
            },
        };

        try {
            const app = await runNodeApplication<BillingConfig>({
                configLoader: {
                    configFile: configPath,
                    bootstrapSection: 'bootstrap',
                    appSection: 'billing',
                    appConfig: validator,
                },
                start: async () => {},
            });

            expect(app.appConfig.settlementWindowMinutes).toBe(15);
            expect(app.appConfig.riskLimit).toBe(100000);
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('throws ConfigValidationError with file path and section on failure', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'bad.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
billing:
  badField: true
`,
        );
        const validator: ApplicationConfigValidator<unknown> = {
            safeParse(_raw: unknown) {
                return { success: false, errors: [{ path: '$', message: 'invalid config' }] };
            },
        };

        try {
            await expect(
                runNodeApplication({
                    configLoader: {
                        configFile: configPath,
                        bootstrapSection: 'bootstrap',
                        appSection: 'billing',
                        appConfig: validator,
                    },
                    start: async () => {},
                }),
            ).rejects.toThrow(ConfigValidationError);

            await expect(
                runNodeApplication({
                    configLoader: {
                        configFile: configPath,
                        bootstrapSection: 'bootstrap',
                        appSection: 'billing',
                        appConfig: validator,
                    },
                    start: async () => {},
                }),
            ).rejects.toThrow(configPath);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('validates app config with bare function validator', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'fn.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
myapp:
  count: 42
`,
        );
        try {
            const app = await runNodeApplication<{ count: number }>({
                configLoader: {
                    configFile: configPath,
                    bootstrapSection: 'bootstrap',
                    appSection: 'myapp',
                    appConfig: (raw: unknown) => {
                        const obj = raw as Record<string, unknown>;
                        return { count: Number(obj.count) };
                    },
                },
                start: async () => {},
            });

            expect(app.appConfig.count).toBe(42);
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('validates app config with validate() method', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'v.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
svc:
  name: test
`,
        );
        try {
            const app = await runNodeApplication<{ name: string }>({
                configLoader: {
                    configFile: configPath,
                    bootstrapSection: 'bootstrap',
                    appSection: 'svc',
                    appConfig: {
                        validate: (raw: unknown) => ({ name: String((raw as Record<string, unknown>).name) }),
                    },
                },
                start: async () => {},
            });

            expect(app.appConfig.name).toBe('test');
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('defaults appSection to full remaining object when not specified', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'default.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
app:
  name: default-test
`,
        );
        try {
            const app = await runNodeApplication<{ name: string }>({
                configLoader: {
                    configFile: configPath,
                    bootstrapSection: 'bootstrap',
                    appConfig: (raw: unknown) => {
                        const obj = raw as Record<string, unknown>;
                        const appObj = obj.app as Record<string, unknown>;
                        return { name: String(appObj.name) };
                    },
                },
                start: async () => {},
            });

            expect(app.appConfig.name).toBe('default-test');
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── Stop cleanup ──────────────────────────────────────────────────────────

describe('runNodeApplication — stop cleanup', () => {
    afterEach(resetModules);

    test('stop is idempotent', async () => {
        const stopped: number[] = [];
        const app = await runNodeApplication({
            stop: async () => {
                stopped.push(1);
            },
            start: async () => {},
        });

        await app.stop();
        await app.stop();

        expect(stopped.length).toBe(1);
    });
});

describe('runNodeApplication — startup failure cleanup', () => {
    afterEach(resetModules);

    // Regression: a `start` callback that throws must not leak the Node-owned
    // OTel providers that `initNodeTelemetry` registered before delegation.
    // Without the rollback in runNodeApplication, the global MeterProvider stays
    // registered after the rejection and bleeds into sibling suites.
    test('shuts down Node telemetry when start throws', async () => {
        const dir = tmpDir();
        // An OTLP endpoint makes runNodeApplication register a real provider.
        const configPath = writeYaml(
            dir,
            'tel.yaml',
            `
bootstrap:
  telemetry:
    enabled: true
    endpoint: http://localhost:4318
`,
        );
        try {
            await expect(
                runNodeApplication({
                    configLoader: { configFile: configPath, bootstrapSection: 'bootstrap' },
                    start: async () => {
                        throw new Error('boom-during-start');
                    },
                }),
            ).rejects.toThrow('boom-during-start');

            // The provider registered during the failed bootstrap was torn down:
            // shutdownNodeTelemetry() nulled the providers and called metrics.disable(),
            // reverting the global meter provider to OTel's NoopMeterProvider. Had the
            // rollback not run, the registered MeterProvider would still be installed.
            expect(metrics.getMeterProvider().constructor.name).toBe('NoopMeterProvider');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // Regression: the node-telemetry plugin must register the global meter
    // provider during loadAll, BEFORE telemetryPlugin's onStart pre-warms the
    // instrument cache (initMetrics). The OTel metrics API has no proxy
    // provider — instruments created earlier stay bound to the noop meter
    // forever, silently dropping every metric.
    test('infra instruments bind to the real meter provider, not the noop meter', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'tel-order.yaml',
            `
bootstrap:
  logging:
    console: false
  telemetry:
    enabled: true
    endpoint: http://localhost:4318
`,
        );
        _resetMetrics();
        try {
            const app = await runNodeApplication({
                configLoader: { configFile: configPath, bootstrapSection: 'bootstrap' },
                start: async () => {},
            });

            expect(getHttpClientRequestTotal().constructor.name).not.toBe('NoopCounterMetric');

            await app.stop();
        } finally {
            _resetMetrics();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── Additional coverage ───────────────────────────────────────────────────

describe('runNodeApplication — additional coverage', () => {
    afterEach(resetModules);

    test('validates app config with parse() method', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'p.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
svc:
  count: 99
`,
        );
        try {
            const app = await runNodeApplication<{ count: number }>({
                configLoader: {
                    configFile: configPath,
                    bootstrapSection: 'bootstrap',
                    appSection: 'svc',
                    appConfig: { parse: (raw: unknown) => ({ count: Number((raw as Record<string, unknown>).count) }) },
                },
                start: async () => {},
            });

            expect(app.appConfig.count).toBe(99);
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('throws on unsupported validator shape', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'bad.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
svc:
  name: test
`,
        );
        try {
            await expect(
                runNodeApplication({
                    configLoader: {
                        configFile: configPath,
                        bootstrapSection: 'bootstrap',
                        appSection: 'svc',
                        // Intentionally malformed validator
                        appConfig: {} as ApplicationConfigValidator<unknown>,
                    },
                    start: async () => {},
                }),
            ).rejects.toThrow('Unsupported validator shape');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('loads config from overrides without config file', async () => {
        const app = await runNodeApplication({
            configLoader: {
                overrides: {
                    bootstrap: {
                        logging: { level: 'trace' },
                        telemetry: { enabled: false },
                    },
                },
            },
            start: async () => {},
        });

        expect(app.config.logging.level).toBe('trace');
        await app.stop();
    });

    test('creates scheduler from YAML config', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'sched.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
  scheduler:
    enabled: true
`,
        );
        try {
            const app = await runNodeApplication({
                configLoader: {
                    configFile: configPath,
                    bootstrapSection: 'bootstrap',
                },
                start: async () => {},
            });

            expect(app.scheduler).toBeDefined();
            expect(app.config.scheduler.enabled).toBe(true);
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('runs without configLoader', async () => {
        const app = await runNodeApplication({
            start: async () => {},
        });

        expect(app.logger).toBeDefined();
        await app.stop();
    });

    test('creates a file sink directory and writes when logging.filePath is set', async () => {
        // Verifies the createFileSink wiring (mkdir + append) deterministically,
        // independent of logtape's process-global logger state.
        const dir = tmpDir();
        const logPath = join(dir, 'logs', 'app.jsonl');
        const configPath = writeYaml(
            dir,
            'logsink.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
  logging:
    console: false
    filePath: ${logPath}
`,
        );
        try {
            const app = await runNodeApplication({
                configLoader: { configFile: configPath, bootstrapSection: 'bootstrap' },
                services: {
                    // Inject a logger whose sink we control, then drive the
                    // file sink directly via the resolved config to avoid
                    // depending on logtape's global configuration state.
                    logger: {
                        info: () => {},
                        error: () => {},
                        warn: () => {},
                        debug: () => {},
                        trace: () => {},
                        fatal: () => {},
                        child() {
                            return this;
                        },
                    },
                },
                start: async (a) => {
                    a.config.logging.fileSink?.('file-sink-probe\n');
                },
            });
            await app.stop();

            expect(existsSync(logPath)).toBe(true);
            expect(readFileSync(logPath, 'utf-8')).toContain('file-sink-probe');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('runs with a configLoader that has neither configFile nor overrides', async () => {
        const app = await runNodeApplication({
            configLoader: { bootstrapSection: 'bootstrap' },
            config: { telemetry: { enabled: false }, logging: { console: false } },
            start: async () => {},
        });

        expect(app.logger).toBeDefined();
        expect(app.config.telemetry.enabled).toBe(false);
        await app.stop();
    });

    test('initializes Node telemetry from inline config with endpoint', async () => {
        const before = trace.getTracer('probe-inline');
        const app = await runNodeApplication({
            config: {
                telemetry: {
                    enabled: true,
                    endpoint: 'http://localhost:4318',
                },
                logging: { console: false },
            },
            start: async () => {},
        });

        expect(trace.getTracer('probe-inline')).not.toBe(before);
        await app.stop();
    });

    test('initializes Node telemetry exporter when telemetry.endpoint is set', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'otel.yaml',
            `
bootstrap:
  telemetry:
    enabled: true
    serviceName: otel-probe
    endpoint: http://localhost:4318
  logging:
    console: false
`,
        );
        try {
            const before = trace.getTracer('probe');
            const app = await runNodeApplication({
                configLoader: { configFile: configPath, bootstrapSection: 'bootstrap' },
                start: async () => {},
            });

            // The Node exporter registered a real global provider.
            expect(trace.getTracer('probe')).not.toBe(before);

            // Reverse-order shutdown must tear down the Node exporter too.
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('throws when database.enabled is true but driver is unsupported', async () => {
        const dir = tmpDir();
        const configPath = writeYaml(
            dir,
            'baddb.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
  database:
    enabled: true
    driver: postgres
`,
        );
        try {
            await expect(
                runNodeApplication({
                    configLoader: { configFile: configPath, bootstrapSection: 'bootstrap' },
                    start: async () => {},
                }),
            ).rejects.toThrow(ConfigValidationError);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('creates DB adapter from YAML config with bun-sqlite driver', async () => {
        const dir = tmpDir();
        const dbPath = join(dir, 'test.db');
        const configPath = writeYaml(
            dir,
            'db.yaml',
            `
bootstrap:
  telemetry:
    enabled: false
  database:
    enabled: true
    driver: bun-sqlite
    url: ${dbPath}
`,
        );
        try {
            const app = await runNodeApplication({
                configLoader: {
                    configFile: configPath,
                    bootstrapSection: 'bootstrap',
                },
                start: async () => {},
            });

            expect(app.db).toBeDefined();
            await app.stop();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── Scheduler adapter injection (0059) ─────────────────────────────────────

/** Minimal in-memory SchedulerAdapter double for injection tests. */
class FakeSchedulerAdapter implements SchedulerAdapter {
    readonly registered: Array<[string, ScheduledAction]> = [];
    started = false;
    stopped = false;
    register(cron: string, action: ScheduledAction): void {
        this.registered.push([cron, action]);
    }
    async start(): Promise<void> {
        this.started = true;
    }
    async stop(): Promise<void> {
        this.stopped = true;
    }
}

describe('runNodeApplication — scheduler adapter injection', () => {
    afterEach(resetModules);

    test('R1 — a caller-supplied adapter survives bootstrap when enabled', async () => {
        const injected = new FakeSchedulerAdapter();
        const app = await runNodeApplication({
            config: { scheduler: { enabled: true, adapter: injected } },
            start: async () => {},
        });

        // The running scheduler IS the caller's adapter, not a NodeSchedulerAdapter.
        expect(app.scheduler).toBe(injected);
        expect(app.scheduler).not.toBeInstanceOf(NodeSchedulerAdapter);
        expect(injected.started).toBe(true);
        await app.stop();
        expect(injected.stopped).toBe(true);
    });

    test('R1b — default NodeSchedulerAdapter applies when no adapter is supplied', async () => {
        const app = await runNodeApplication({
            config: { scheduler: { enabled: true } },
            start: async () => {},
        });

        expect(app.scheduler).toBeInstanceOf(NodeSchedulerAdapter);
        await app.stop();
    });

    test('R2 — drainTimeoutMs reaches the adapter via injection', async () => {
        // ADR-024: the drain bound is reachable by passing a pre-built adapter.
        // An invalid bound is rejected at the adapter constructor boundary.
        expect(() => new NodeSchedulerAdapter({ drainTimeoutMs: -1 })).toThrow(RangeError);
        expect(() => new NodeSchedulerAdapter({ drainTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);

        const adapter = new NodeSchedulerAdapter({ drainTimeoutMs: 5000 });
        const app = await runNodeApplication({
            config: { scheduler: { enabled: true, adapter } },
            start: async () => {},
        });

        expect(app.scheduler).toBe(adapter);
        await app.stop();
    });

    test('R1 — caller entries are registered when supplied via config', async () => {
        const action: ScheduledAction = async () => {};
        const injected = new FakeSchedulerAdapter();
        const entries: SchedulerOptions['entries'] = [['*/1 * * * *', action]];
        const app = await runNodeApplication({
            config: {
                scheduler: {
                    enabled: true,
                    adapter: injected,
                    entries,
                },
            },
            start: async () => {},
        });

        expect(injected.registered.length).toBe(1);
        expect(injected.registered[0]?.[0]).toBe('*/1 * * * *');
        await app.stop();
    });
});
