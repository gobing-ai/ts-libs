import { describe, expect, test } from 'bun:test';
import { initScheduler, NoopSchedulerAdapter } from '../../src/scheduler/index';

describe('scheduler factory', () => {
    test('returns the injected adapter', () => {
        const adapter = new NoopSchedulerAdapter();
        expect(initScheduler(adapter)).toBe(adapter);
    });

    test('defaults to a noop adapter when none is injected', () => {
        const adapter = initScheduler();
        expect(adapter).toBeInstanceOf(NoopSchedulerAdapter);
    });

    test('noop adapter start and stop work', async () => {
        const adapter = initScheduler();
        await adapter.start();
        await adapter.stop();
    });

    test('registers cron entries on the resolved adapter', () => {
        const registered: string[] = [];
        const adapter = new NoopSchedulerAdapter();
        adapter.register = (cron: string) => {
            registered.push(cron);
        };

        initScheduler(adapter, [['* * * * *', async () => {}]]);
        expect(registered).toEqual(['* * * * *']);
    });
});
