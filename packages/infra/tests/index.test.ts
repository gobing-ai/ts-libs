import { describe, expect, test } from 'bun:test';

import * as infra from '../src/index';

describe('@gobing-ai/ts-infra barrel', () => {
    test('exports event-bus symbols', () => {
        expect(infra.EventBus).toBeDefined();
    });

    test('exports logger symbols', () => {
        expect(infra.getLogger).toBeDefined();
        expect(infra.initializeLogger).toBeDefined();
    });

    test('exports telemetry symbols', () => {
        expect(infra.initTelemetry).toBeDefined();
        expect(infra.getTracer).toBeDefined();
        expect(infra.traceAsync).toBeDefined();
        expect(infra.sanitizeSql).toBeDefined();
    });

    test('exports scheduler symbols', () => {
        expect(infra.NodeSchedulerAdapter).toBeDefined();
        expect(infra.NoopSchedulerAdapter).toBeDefined();
        expect(infra.CloudflareSchedulerAdapter).toBeDefined();
        expect(infra.initScheduler).toBeDefined();
    });

    test('exports api-client symbols', () => {
        expect(infra.APIClient).toBeDefined();
        expect(infra.APIError).toBeDefined();
    });

    test('exports job-queue types', () => {
        // Types are exported — verify the module loads
        expect(infra).toBeDefined();
    });

    test('exports events symbols', () => {
        expect(infra.createSystemBus).toBeDefined();
    });
});
