import { describe, expect, test } from 'bun:test';
import {
    attachDefaultObservers,
    attachLogObserver,
    attachTelemetryObserver,
    createLifecycleBus,
} from '../../src/event-bus/default-observers';
import { setLoggerMuted } from '../../src/logger';

// The log observer writes real output; mute it so the suite stays quiet.
setLoggerMuted(true);

describe('default observers', () => {
    test('log + telemetry observers register and emit without throwing', () => {
        const bus = createLifecycleBus();
        attachLogObserver(bus);
        attachTelemetryObserver(bus);

        expect(() => {
            void bus.emit('bus.emit.done', {
                event: 'e',
                syncCount: 1,
                asyncCount: 0,
                emitDurationMs: 1,
                errors: 0,
                severity: 'info',
            });
            void bus.emit('bus.emit.done', {
                event: 'e',
                syncCount: 1,
                asyncCount: 0,
                emitDurationMs: 1,
                errors: 2,
                severity: 'warning',
            });
            void bus.emit('bus.emit.noop', { event: 'e', severity: 'info' });
            void bus.emit('bus.handler.error', { event: 'e', mode: 'sync', error: 'x', severity: 'error' });
            void bus.emit('bus.handler.async.enqueued', { event: 'e', jobId: 'j', handlerCount: 1, severity: 'info' });
        }).not.toThrow();
    });

    test('attachDefaultObservers wires log + telemetry (no metrics — core handles those inline)', () => {
        const bus = createLifecycleBus();
        expect(() => attachDefaultObservers(bus)).not.toThrow();
        expect(() => {
            void bus.emit('bus.emit.done', {
                event: 'e',
                syncCount: 0,
                asyncCount: 0,
                emitDurationMs: 0,
                errors: 0,
                severity: 'info',
            });
        }).not.toThrow();
    });

    test('createLifecycleBus returns an independent bus instance', () => {
        const a = createLifecycleBus();
        const b = createLifecycleBus();
        expect(a).not.toBe(b);
    });
});
