import { afterAll, describe, expect, test } from 'bun:test';
import { extractSqlOperation, sanitizeSql } from '../src/telemetry/db-sanitize';
import {
    _resetMetrics,
    getDbOperationDuration,
    getDbOperationErrors,
    getDbOperationTotal,
    getEventbusEmitsTotal,
    getEventbusErrorsTotal,
    getHttpClientRequestDuration,
    getHttpClientRequestErrors,
    getHttpClientRequestTotal,
    getHttpServerRequestDuration,
    getHttpServerRequestErrors,
    getHttpServerRequestTotal,
    getQueueJobCompletedTotal,
    getQueueJobEnqueuedTotal,
    getQueueJobFailedTotal,
    getQueueJobProcessingDuration,
    getSchedulerJobDuration,
    getSchedulerJobExecutedTotal,
    getSchedulerJobFailedTotal,
    initMetrics,
    isMetricsInitialized,
    shutdownMetrics,
} from '../src/telemetry/metrics';
import { _resetTelemetry, initTelemetry, shutdownTelemetry } from '../src/telemetry/sdk';
import {
    addSpanAttributes,
    addSpanEvent,
    getActiveSpan,
    traceAsync,
    traceSync,
    withSpan,
} from '../src/telemetry/tracing';

describe('sanitizeSql', () => {
    test('replaces string literals with ?', () => {
        expect(sanitizeSql("SELECT * FROM users WHERE name = 'Alice'")).toBe('SELECT * FROM users WHERE name = ?');
    });

    test('replaces double-quoted strings', () => {
        expect(sanitizeSql('SELECT * FROM users WHERE name = "Bob"')).toBe('SELECT * FROM users WHERE name = ?');
    });

    test('replaces numeric literals', () => {
        expect(sanitizeSql('SELECT * FROM users WHERE id = 42')).toBe('SELECT * FROM users WHERE id = ?');
    });

    test('replaces float literals', () => {
        expect(sanitizeSql('SELECT * FROM products WHERE price = 3.14')).toBe('SELECT * FROM products WHERE price = ?');
    });

    test('preserves SQL structure and keywords', () => {
        const result = sanitizeSql("INSERT INTO queue_jobs (id, type) VALUES ('123', 'test')");
        expect(result).toContain('INSERT INTO queue_jobs');
        expect(result).toContain('VALUES');
        expect(result).not.toContain('123');
        expect(result).not.toContain('test');
    });

    test('handles parameterized placeholders', () => {
        expect(sanitizeSql('SELECT * FROM users WHERE id = ? AND name = ?')).toBe(
            'SELECT * FROM users WHERE id = ? AND name = ?',
        );
    });

    test('handles empty string', () => {
        expect(sanitizeSql('')).toBe('');
    });

    test('handles escaped quotes in literals', () => {
        expect(sanitizeSql("SELECT * FROM t WHERE name = 'O''Brien'")).toBe('SELECT * FROM t WHERE name = ?');
    });
});

describe('extractSqlOperation', () => {
    test('extracts SELECT', () => {
        expect(extractSqlOperation('SELECT * FROM users')).toBe('SELECT');
    });

    test('extracts INSERT', () => {
        expect(extractSqlOperation('INSERT INTO users VALUES (1, 2)')).toBe('INSERT');
    });

    test('extracts UPDATE', () => {
        expect(extractSqlOperation('UPDATE users SET name = ?')).toBe('UPDATE');
    });

    test('extracts DELETE', () => {
        expect(extractSqlOperation('DELETE FROM users')).toBe('DELETE');
    });

    test('extracts CREATE', () => {
        expect(extractSqlOperation('CREATE TABLE test (id INTEGER)')).toBe('CREATE');
    });

    test('extracts ALTER', () => {
        expect(extractSqlOperation('ALTER TABLE test ADD COLUMN name TEXT')).toBe('ALTER');
    });

    test('extracts DROP', () => {
        expect(extractSqlOperation('DROP TABLE test')).toBe('DROP');
    });

    test('extracts PRAGMA', () => {
        expect(extractSqlOperation('PRAGMA table_info(users)')).toBe('PRAGMA');
    });

    test('returns undefined for unknown', () => {
        expect(extractSqlOperation('FOO bar')).toBeUndefined();
    });

    test('handles leading whitespace', () => {
        expect(extractSqlOperation('   SELECT 1')).toBe('SELECT');
    });
});

describe('metrics', () => {
    afterAll(async () => {
        _resetMetrics();
        await shutdownTelemetry();
        _resetTelemetry();
    });

    test('isMetricsInitialized returns false before init', () => {
        _resetMetrics();
        expect(isMetricsInitialized()).toBeFalse();
    });

    test('initMetrics sets initialized flag', () => {
        _resetMetrics();
        initMetrics();
        expect(isMetricsInitialized()).toBeTrue();
    });

    test('initMetrics is idempotent', () => {
        _resetMetrics();
        initMetrics();
        initMetrics();
        expect(isMetricsInitialized()).toBeTrue();
    });

    test('shutdownMetrics resets flag', async () => {
        _resetMetrics();
        initMetrics();
        expect(isMetricsInitialized()).toBeTrue();
        await shutdownMetrics();
        expect(isMetricsInitialized()).toBeFalse();
    });

    test('_resetMetrics clears instruments and disables', () => {
        _resetMetrics();
        initMetrics();
        // Create an instrument to populate cache
        getHttpServerRequestTotal();
        _resetMetrics();
        // After reset, creating again should work
        expect(isMetricsInitialized()).toBeFalse();
    });

    test('instrument getters return defined objects', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-metrics' });

        const counter = getHttpServerRequestTotal();
        expect(counter).toBeDefined();
        expect(typeof counter.add).toBe('function');
    });

    test('histogram getters return defined objects', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-metrics' });

        const histogram = getHttpServerRequestDuration();
        expect(histogram).toBeDefined();
        expect(typeof histogram.record).toBe('function');
    });

    test('all counter instrument getters return instruments', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-metrics' });

        expect(getHttpServerRequestTotal()).toBeDefined();
        expect(getHttpServerRequestErrors()).toBeDefined();
        expect(getHttpClientRequestTotal()).toBeDefined();
        expect(getHttpClientRequestErrors()).toBeDefined();
        expect(getDbOperationTotal()).toBeDefined();
        expect(getDbOperationErrors()).toBeDefined();
        expect(getEventbusEmitsTotal()).toBeDefined();
        expect(getEventbusErrorsTotal()).toBeDefined();
        expect(getQueueJobEnqueuedTotal()).toBeDefined();
        expect(getQueueJobCompletedTotal()).toBeDefined();
        expect(getQueueJobFailedTotal()).toBeDefined();
        expect(getSchedulerJobExecutedTotal()).toBeDefined();
        expect(getSchedulerJobFailedTotal()).toBeDefined();
    });

    test('all histogram instrument getters return instruments', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-metrics' });

        expect(getHttpServerRequestDuration()).toBeDefined();
        expect(getHttpClientRequestDuration()).toBeDefined();
        expect(getDbOperationDuration()).toBeDefined();
        expect(getQueueJobProcessingDuration()).toBeDefined();
        expect(getSchedulerJobDuration()).toBeDefined();
    });
});

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
