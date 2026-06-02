import { describe, expect, test } from 'bun:test';
import { CloudflareSchedulerAdapter } from '../../src/scheduler/index';

describe('CloudflareSchedulerAdapter', () => {
    test('constructs without error', () => {
        const s = new CloudflareSchedulerAdapter();
        expect(s).toBeDefined();
    });

    test('register and handleScheduledEvent', async () => {
        const s = new CloudflareSchedulerAdapter();
        let fired = false;
        s.register('* * * * *', async () => {
            fired = true;
        });

        s.handleScheduledEvent(
            { cron: '* * * * *', scheduledTime: Date.now(), waitUntil: (p: Promise<unknown>) => void p },
            { waitUntil: (p: Promise<unknown>) => void p },
        );

        // Wait for async action
        await new Promise((r) => setTimeout(r, 10));
        expect(fired).toBeTrue();
    });

    test('start and stop are no-ops', async () => {
        const s = new CloudflareSchedulerAdapter();
        await s.start();
        await s.stop();
        // Should not throw
    });

    test('a failing action rejects the promise handed to waitUntil', async () => {
        const s = new CloudflareSchedulerAdapter();
        s.register('* * * * *', async () => {
            throw new Error('action boom');
        });

        let scheduled: Promise<unknown> | undefined;
        s.handleScheduledEvent(
            { cron: '* * * * *', scheduledTime: Date.now(), waitUntil: (p: Promise<unknown>) => void p },
            {
                waitUntil: (p: Promise<unknown>) => {
                    scheduled = p;
                },
            },
        );

        // The Worker awaits the waitUntil promise; the failure must surface so
        // the runtime (and the scheduler-failed metric) sees it.
        expect(scheduled).toBeDefined();
        await expect(scheduled).rejects.toThrow('action boom');
    });

    test('unregistered cron does not dispatch', () => {
        const s = new CloudflareSchedulerAdapter();
        let called = false;
        s.register('* * * * *', async () => {
            called = true;
        });

        s.handleScheduledEvent(
            { cron: '0 0 * * *', scheduledTime: Date.now(), waitUntil: (p: Promise<unknown>) => void p },
            { waitUntil: (p: Promise<unknown>) => void p },
        );

        expect(called).toBeFalse();
    });
});
