import { afterAll, describe, expect, test } from 'bun:test';
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
} from '../../src/telemetry/metrics';
import { _resetTelemetry, initTelemetry, shutdownTelemetry } from '../../src/telemetry/sdk';

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
