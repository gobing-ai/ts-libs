import { describe, expect, test } from 'bun:test';
import { _resetMetrics } from '../../src/telemetry/metrics';
import {
    _resetTelemetry,
    getResolvedConfig,
    getTelemetryConfig,
    initTelemetry,
    shutdownTelemetry,
} from '../../src/telemetry/sdk';
import { traceAsync } from '../../src/telemetry/tracing';

describe('telemetry config', () => {
    test('getTelemetryConfig returns defaults with empty input', () => {
        const config = getTelemetryConfig();
        expect(config.enabled).toBeTrue();
        expect(config.serviceName).toBe('ts-libs');
        expect(config.environment).toBe('development');
        expect(config.dbStatementDebug).toBeFalse();
    });

    test('getTelemetryConfig overrides enabled', () => {
        const config = getTelemetryConfig({ enabled: false });
        expect(config.enabled).toBeFalse();
    });

    test('getTelemetryConfig overrides service name', () => {
        const config = getTelemetryConfig({ serviceName: 'my-app' });
        expect(config.serviceName).toBe('my-app');
    });

    test('getTelemetryConfig uses appEnv fallback', () => {
        const config = getTelemetryConfig({ appEnv: 'production' });
        expect(config.environment).toBe('production');
    });

    test('getTelemetryConfig prefers environment over appEnv', () => {
        const config = getTelemetryConfig({ environment: 'staging', appEnv: 'production' });
        expect(config.environment).toBe('staging');
    });

    test('master switch: enabled=false suppresses tracing', async () => {
        _resetMetrics();
        _resetTelemetry();
        initTelemetry({ enabled: false, serviceName: 'test-master-switch' });

        expect(getResolvedConfig().enabled).toBe(false);
        let sawSpan = false;
        await traceAsync('suppressed-test', async (span) => {
            sawSpan = true;
            expect(span.isRecording()).toBe(false);
            return 42;
        });
        expect(sawSpan).toBe(true);

        await shutdownTelemetry();
        _resetTelemetry();
        _resetMetrics();
    });
});
