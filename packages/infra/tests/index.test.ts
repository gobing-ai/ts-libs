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
        expect(infra.NoopSchedulerAdapter).toBeDefined();
        expect(infra.initScheduler).toBeDefined();
    });

    test('exports api-client symbols', () => {
        expect(infra.APIClient).toBeDefined();
        expect(infra.APIError).toBeDefined();
    });

    test('exports job-queue contracts only', () => {
        expect('DBJobQueue' in infra).toBe(false);
        expect('DBQueueConsumer' in infra).toBe(false);
    });

    test('does not export runtime-specific scheduler adapters from the main barrel', () => {
        expect('NodeSchedulerAdapter' in infra).toBe(false);
        expect('CloudflareSchedulerAdapter' in infra).toBe(false);
    });
});
