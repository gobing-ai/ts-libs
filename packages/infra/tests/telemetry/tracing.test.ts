import { afterAll, describe, expect, test } from 'bun:test';
import { _resetMetrics } from '../../src/telemetry/metrics';
import { _resetTelemetry, initTelemetry, shutdownTelemetry } from '../../src/telemetry/sdk';
import {
    addSpanAttributes,
    addSpanEvent,
    getActiveSpan,
    traceAsync,
    traceSync,
    withSpan,
} from '../../src/telemetry/tracing';

describe('tracing', () => {
    afterAll(async () => {
        _resetMetrics();
        await shutdownTelemetry();
        _resetTelemetry();
    });

    test('traceAsync runs function within active span', async () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-tracing' });

        const result = await traceAsync('test.async', async (span) => {
            expect(span).toBeDefined();
            return 42;
        });
        expect(result).toBe(42);
    });

    test('traceAsync sets error status on throw', async () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-tracing' });

        await expect(
            traceAsync('test.error', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
    });

    test('traceSync runs function within active span', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-tracing' });

        const result = traceSync('test.sync', (span) => {
            expect(span).toBeDefined();
            return 'ok';
        });
        expect(result).toBe('ok');
    });

    test('traceSync sets error status on throw', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-tracing' });

        expect(() =>
            traceSync('test.sync.error', () => {
                throw new Error('crash');
            }),
        ).toThrow('crash');
    });

    test('getActiveSpan returns undefined outside active span', () => {
        _resetMetrics();
        _resetTelemetry();
        const span = getActiveSpan();
        expect(span).toBeUndefined();
    });

    test('addSpanAttributes does not throw without active span', () => {
        _resetMetrics();
        _resetTelemetry();
        addSpanAttributes({ key: 'value' });
    });

    test('addSpanAttributes sets attributes within active span', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-tracing' });

        traceSync('attr.test', () => {
            addSpanAttributes({ key: 'value' });
        });
    });

    test('addSpanEvent does not throw without active span', () => {
        _resetMetrics();
        _resetTelemetry();
        addSpanEvent('test.event', { key: 'value' });
    });

    test('addSpanEvent adds event within active span', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-tracing' });

        traceSync('event.test', () => {
            addSpanEvent('test.event', { key: 'value' });
        });
    });

    test('withSpan executes function with given span', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-tracing' });

        traceSync('outer', (span) => {
            const result = withSpan(span, () => 99);
            expect(result).toBe(99);
        });
    });
});
