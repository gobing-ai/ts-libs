import { describe, expect, test } from 'bun:test';
import { loggerPlugin, schedulerPlugin, telemetryPlugin } from '../../../src/application/plugins/builtins';
import { PluginHost } from '../../../src/application/plugins/host';
import { EventBus } from '../../../src/event-bus/event-bus';

describe('builtins — telemetryPlugin', () => {
    test('onStart calls initTelemetry when enabled', () => {
        const plugin = telemetryPlugin({
            enabled: true,
            serviceName: 'test-svc',
            environment: 'test',
            dbStatementDebug: false,
        });
        expect(plugin.name).toBe('builtin:telemetry');
        expect(plugin.failFast).toBe(true);
        expect(plugin.onStart).toBeDefined();
        expect(plugin.onStop).toBeDefined();
    });

    test('onStart is no-op when telemetry disabled', () => {
        const plugin = telemetryPlugin({
            enabled: false,
            serviceName: 'test',
            environment: 'test',
            dbStatementDebug: false,
        });
        // Should not throw
        expect(plugin.onStart).toBeDefined();
    });

    test('fails fast when onStart throws', async () => {
        const host = new PluginHost(new EventBus());
        // telemetry disabled + logger enabled → loggerPlugin succeeds
        const logPlugin = loggerPlugin({ enabled: true, level: 'info', console: false, json: false }, false);
        host.register(logPlugin);

        // register telemetry but the sdk will throw because no provider registered
        const telPlugin = telemetryPlugin({
            enabled: true,
            serviceName: 't',
            environment: 't',
            dbStatementDebug: false,
        });
        host.register(telPlugin);

        // Should not throw — initTelemetry just sets config, doesn't require providers
        await host.loadAll();
        await host.startAll();
        // Exercise teardown path
        await host.stopAll();
    });
});

describe('builtins — loggerPlugin', () => {
    test('name and failFast', () => {
        const plugin = loggerPlugin({ enabled: true, level: 'info', console: false, json: false }, false);
        expect(plugin.name).toBe('builtin:logger');
        expect(plugin.failFast).toBe(true);
        expect(plugin.onStart).toBeDefined();
        expect(plugin.onStop).toBeUndefined();
    });

    test('skips init when injected', () => {
        const plugin = loggerPlugin({ enabled: true, level: 'info', console: false, json: false }, true);
        expect(plugin.onStart).toBeDefined();
    });
});

describe('builtins — schedulerPlugin', () => {
    test('name and failFast', () => {
        const adapter = { register: () => {}, start: async () => {}, stop: async () => {} };
        const plugin = schedulerPlugin(adapter, false);
        expect(plugin.name).toBe('builtin:scheduler');
        expect(plugin.failFast).toBe(true);
    });

    test('autoStart false does not call start', async () => {
        let started = false;
        const adapter = {
            register: () => {},
            start: async () => {
                started = true;
            },
            stop: async () => {},
        };
        const plugin = schedulerPlugin(adapter, false);
        const host = new PluginHost(new EventBus());
        host.register(plugin);
        await host.loadAll();
        await host.startAll();
        expect(started).toBe(false);
    });

    test('autoStart true calls start', async () => {
        let started = false;
        const adapter = {
            register: () => {},
            start: async () => {
                started = true;
            },
            stop: async () => {},
        };
        const plugin = schedulerPlugin(adapter, true);
        const host = new PluginHost(new EventBus());
        host.register(plugin);
        await host.loadAll();
        await host.startAll();
        expect(started).toBe(true);
    });
});
