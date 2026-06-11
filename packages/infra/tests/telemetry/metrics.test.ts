import { afterAll, describe, expect, test } from 'bun:test';
import {
    _resetMetrics,
    getEventbusEmitsTotal,
    getEventbusErrorsTotal,
    getHttpClientRequestDuration,
    getHttpClientRequestErrors,
    getHttpClientRequestTotal,
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
        getHttpClientRequestTotal();
        _resetMetrics();
        // After reset, creating again should work
        expect(isMetricsInitialized()).toBeFalse();
    });

    test('counter getters return usable counters', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-metrics' });

        const counter = getHttpClientRequestTotal();
        expect(counter).toBeDefined();
        expect(typeof counter.add).toBe('function');
    });

    test('histogram getters return usable histograms', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-metrics' });

        const histogram = getHttpClientRequestDuration();
        expect(histogram).toBeDefined();
        expect(typeof histogram.record).toBe('function');
    });

    test('all retained counter getters return instruments', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-metrics' });

        expect(getHttpClientRequestTotal()).toBeDefined();
        expect(getHttpClientRequestErrors()).toBeDefined();
        expect(getEventbusEmitsTotal()).toBeDefined();
        expect(getEventbusErrorsTotal()).toBeDefined();
        expect(getQueueJobEnqueuedTotal()).toBeDefined();
        expect(getQueueJobCompletedTotal()).toBeDefined();
        expect(getQueueJobFailedTotal()).toBeDefined();
        expect(getSchedulerJobExecutedTotal()).toBeDefined();
        expect(getSchedulerJobFailedTotal()).toBeDefined();
    });

    test('all retained histogram getters return instruments', () => {
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-metrics' });

        expect(getHttpClientRequestDuration()).toBeDefined();
        expect(getQueueJobProcessingDuration()).toBeDefined();
        expect(getSchedulerJobDuration()).toBeDefined();
    });

    test('master switch: counter getters return noop instruments when telemetry disabled', () => {
        _resetMetrics();
        initTelemetry({ enabled: false, serviceName: 'test-off' });

        const counter = getHttpClientRequestTotal();
        expect(counter).toBeDefined();
        expect(typeof counter.add).toBe('function');
        // should not throw
        counter.add(1);
    });

    test('master switch: re-enabling after disable rebuilds real instruments', () => {
        _resetMetrics();
        // First, disabled — cache stays clear
        initTelemetry({ enabled: false, serviceName: 'test-off' });
        expect(getHttpClientRequestTotal()).toBeDefined();

        // Reconfigure to enabled — initTelemetry is idempotent, so re-init
        _resetTelemetry();
        initTelemetry({ enabled: true, serviceName: 'test-on' });
        const counter = getHttpClientRequestTotal();
        expect(counter).toBeDefined();
        expect(typeof counter.add).toBe('function');
    });
});
