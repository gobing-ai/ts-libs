import { describe, expect, test } from 'bun:test';
import {
    getSchedulerAdapter,
    initScheduler,
    NoopSchedulerAdapter,
    resetSchedulerAdapter,
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

    test('resetSchedulerAdapter clears the singleton', () => {
        const adapter = new NoopSchedulerAdapter();
        setSchedulerAdapter(adapter);
        expect(getSchedulerAdapter()).toBe(adapter);

        resetSchedulerAdapter();
        expect(getSchedulerAdapter()).toBeUndefined();
    });

    test('initScheduler noop adapter start and stop work', async () => {
        resetSchedulerAdapter();
        const adapter = initScheduler();
        await adapter.start();
        await adapter.stop();
    });

    test('initScheduler registers cron entries', () => {
        resetSchedulerAdapter();
        const adapter = initScheduler([['* * * * *', async () => {}]]);
        expect(adapter).toBeDefined();
    });
});
