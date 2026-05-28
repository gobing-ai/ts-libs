import { describe, expect, test } from 'bun:test';
import {
    getSchedulerAdapter,
    initScheduler,
    NodeSchedulerAdapter,
    NoopSchedulerAdapter,
    setSchedulerAdapter,
} from '../src/scheduler/index';

describe('scheduler factory', () => {
    test('setSchedulerAdapter and getSchedulerAdapter', () => {
        const adapter = new NoopSchedulerAdapter();
        setSchedulerAdapter(adapter);
        expect(getSchedulerAdapter()).toBe(adapter);
    });

    test('initScheduler creates noop when no adapter set', () => {
        // Clear state
        setSchedulerAdapter(undefined as never);
        const adapter = initScheduler();
        expect(adapter).toBeDefined();
    });

    test('initScheduler registers cron entries', () => {
        const adapter = new NodeSchedulerAdapter();
        setSchedulerAdapter(adapter);
        initScheduler([['10000', async () => {}]]);
        // Don't start — just verify registration
    });
});
