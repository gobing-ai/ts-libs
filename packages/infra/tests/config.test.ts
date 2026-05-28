import { describe, expect, test } from 'bun:test';
import { getTelemetryConfig } from '../src/telemetry/config';

describe('telemetry config', () => {
    test('getTelemetryConfig returns defaults with empty input', () => {
        const config = getTelemetryConfig();
        expect(config.enabled).toBeTrue();
        expect(config.serviceName).toBe('ts-libs');
        expect(config.environment).toBe('development');
        expect(config.exporterProtocol).toBe('http');
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
});
