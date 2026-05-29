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
});
