import { afterEach, describe, expect, test } from 'bun:test';
import { metrics, trace } from '@opentelemetry/api';
import { _resetNodeTelemetry, initNodeTelemetry, shutdownNodeTelemetry } from '../../src/telemetry/otel-node';

describe('otel-node helper', () => {
    afterEach(() => {
        // Drop global registrations so each test starts from a clean slate.
        trace.disable();
        metrics.disable();
        _resetNodeTelemetry();
    });

    test('initNodeTelemetry registers a global tracer provider', () => {
        // Before init: the global tracer is the no-op default.
        const before = trace.getTracer('probe');
        initNodeTelemetry({ serviceName: 'test-svc', endpoint: 'http://localhost:4318' });
        const after = trace.getTracer('probe');

        // A real SDK provider yields a different tracer than the no-op default.
        expect(after).not.toBe(before);
        // The instrumentation surface works against it without throwing.
        const span = after.startSpan('unit');
        expect(span).toBeDefined();
        span.end();
    });

    test('initNodeTelemetry registers a global meter provider', () => {
        const before = metrics.getMeter('probe');
        initNodeTelemetry({ serviceName: 'test-svc' });
        const after = metrics.getMeter('probe');

        expect(after).not.toBe(before);
        const counter = after.createCounter('unit.count');
        expect(() => counter.add(1)).not.toThrow();
    });

    test('metrics:false wires traces only', () => {
        const meterBefore = metrics.getMeter('probe');
        initNodeTelemetry({ serviceName: 'traces-only', metrics: false });

        // Tracer is installed...
        const span = trace.getTracer('probe').startSpan('unit');
        expect(span).toBeDefined();
        span.end();
        // ...but no global meter provider was set.
        expect(metrics.getMeter('probe')).toBe(meterBefore);
    });

    test('initNodeTelemetry is idempotent until shutdown', () => {
        initNodeTelemetry({ serviceName: 'first' });
        const tracer = trace.getTracer('probe');
        // Second call is a no-op — does not swap the provider.
        initNodeTelemetry({ serviceName: 'second' });
        expect(trace.getTracer('probe')).toBe(tracer);
    });

    test('shutdownNodeTelemetry flushes and tears down both providers', async () => {
        initNodeTelemetry({ serviceName: 'test-svc' });
        await expect(shutdownNodeTelemetry()).resolves.toBeUndefined();
        // After shutdown a fresh init works again (proves state was cleared).
        initNodeTelemetry({ serviceName: 'restart' });
        const span = trace.getTracer('probe').startSpan('after-restart');
        expect(span).toBeDefined();
        span.end();
    });

    test('shutdownNodeTelemetry is safe when nothing was initialised', async () => {
        _resetNodeTelemetry();
        await expect(shutdownNodeTelemetry()).resolves.toBeUndefined();
    });

    test('endpoint trailing slash is normalised', () => {
        // Both forms must construct without throwing on the appended signal path.
        expect(() => initNodeTelemetry({ serviceName: 'a', endpoint: 'http://collector:4318/' })).not.toThrow();
        _resetNodeTelemetry();
        expect(() => initNodeTelemetry({ serviceName: 'b', endpoint: 'http://collector:4318' })).not.toThrow();
    });
});
