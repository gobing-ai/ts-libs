import { describe, expect, test } from 'bun:test';
import { NoopSchedulerAdapter } from '../../src/scheduler/index';

describe('NoopSchedulerAdapter', () => {
    test('constructs without error', () => {
        const s = new NoopSchedulerAdapter();
        expect(s).toBeDefined();
    });

    test('register and start/stop are no-ops', async () => {
        const s = new NoopSchedulerAdapter();
        s.register('* * * * *', async () => {});
        await s.start();
        await s.stop();
        // Should not throw
    });
});
