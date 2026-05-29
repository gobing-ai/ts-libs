import { afterAll, describe, expect, test } from 'bun:test';
import { getTelemetryConfig } from '../../src/telemetry/config';
import {
    _resetTelemetry,
    getResolvedConfig,
    getTracer,
    initTelemetry,
    isTelemetryEnabled,
    shutdownTelemetry,
} from '../../src/telemetry/sdk';

describe('telemetry SDK', () => {
    afterAll(async () => {
        await shutdownTelemetry();
        _resetTelemetry();
    });

    test('initTelemetry with disabled config is no-op', () => {
        initTelemetry({ enabled: false });
        expect(isTelemetryEnabled()).toBeFalse();
        _resetTelemetry();
    });

    test('initTelemetry with enabled config creates tracer', () => {
        initTelemetry({ enabled: true, serviceName: 'test-sdk' });
        // Even without OTLP exporter, local tracer should work
        const tracer = getTracer();
        expect(tracer).toBeDefined();
        _resetTelemetry();
    });

    test('getTracer returns default tracer before init', () => {
        _resetTelemetry();
        const tracer = getTracer();
        expect(tracer).toBeDefined();
    });

    test('shutdownTelemetry handles uninitialised state', async () => {
        _resetTelemetry();
        await shutdownTelemetry();
        // Should not throw
    });

    test('getTelemetryConfig returns defaults', () => {
        const config = getTelemetryConfig();
        expect(config.serviceName).toBe('ts-libs');
        expect(config.enabled).toBeTrue();
    });

    test('getResolvedConfig returns current config', () => {
        _resetTelemetry();
        initTelemetry({ enabled: true, serviceName: 'test-resolved' });
        const config = getResolvedConfig();
        expect(config.serviceName).toBe('test-resolved');
        expect(config.enabled).toBeTrue();
        _resetTelemetry();
    });

    test('shutdownTelemetry shuts down active tracerProvider', async () => {
        _resetTelemetry();
        initTelemetry({ enabled: true, serviceName: 'test-shutdown' });
        expect(isTelemetryEnabled()).toBeTrue();
        await shutdownTelemetry();
        expect(isTelemetryEnabled()).toBeFalse();
        _resetTelemetry();
    });
});
