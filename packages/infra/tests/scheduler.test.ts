import { describe, expect, test } from 'bun:test';
import { CloudflareSchedulerAdapter, NodeSchedulerAdapter, NoopSchedulerAdapter } from '../src/scheduler/index';

describe('NodeSchedulerAdapter', () => {
    test('constructs without error', () => {
        const s = new NodeSchedulerAdapter();
        expect(s).toBeDefined();
    });

    test('register and start/stop without error', async () => {
        const s = new NodeSchedulerAdapter();
        s.register('5000', async () => {});
        await s.start();
        // Wait a tick for setInterval-based scheduler
        await new Promise((r) => setTimeout(r, 10));
        await s.stop();
        // Should not throw
    });

    test('register while running starts new entry', async () => {
        const s = new NodeSchedulerAdapter();
        await s.start();
        s.register('5000', async () => {});
        await new Promise((r) => setTimeout(r, 10));
        await s.stop();
    });

    test('action throwing does not crash scheduler', async () => {
        const s = new NodeSchedulerAdapter();
        s.register('1000', async () => {
            throw new Error('task failed');
        });
        await s.start();
        // Let at least one interval fire
        await new Promise((r) => setTimeout(r, 50));
        await s.stop();
    });

    test('_onScheduledTick executes action and catches errors', async () => {
        const s = new NodeSchedulerAdapter();
        let fired = false;
        const entry = {
            cron: '60000',
            action: async () => {
                fired = true;
            },
        };
        // biome-ignore lint/suspicious/noExplicitAny: test access to private method
        await (s as any)._onScheduledTick(entry);
        expect(fired).toBeTrue();
    });

    test('_onScheduledTick handles thrown errors', async () => {
        const s = new NodeSchedulerAdapter();
        const entry: { cron: string; action: () => Promise<void> } = {
            cron: '60000',
            action: async () => {
                throw new Error('fail');
            },
        };
        // biome-ignore lint/suspicious/noExplicitAny: test access to private method
        await (s as any)._onScheduledTick(entry);
    });
});

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
