import { describe, expect, test } from 'bun:test';
import { EventBus } from '../../src/event-bus/event-bus';
import type { QueueEvents } from '../../src/events';
import { setLoggerMuted } from '../../src/logger';
import {
    ActionRegistry,
    createDefaultRegistry,
    HealthPingAction,
    type HealthPingWriter,
    LogAction,
    QueueStatsAction,
    type SchedulerAction,
    toScheduledAction,
} from '../../src/scheduler/action';

setLoggerMuted(true);

describe('ActionRegistry', () => {
    test('registers and resolves actions by name', () => {
        const a = new LogAction('log-a');
        const reg = new ActionRegistry([a]);
        expect(reg.get('log-a')).toBe(a);
        expect(reg.has('log-a')).toBe(true);
        expect(reg.names()).toEqual(['log-a']);
    });

    test('rejects duplicate names', () => {
        const reg = new ActionRegistry([new LogAction('dup')]);
        expect(() => reg.register(new LogAction('dup'))).toThrow('Duplicate scheduler action name');
    });
});

describe('toScheduledAction', () => {
    test('bridges a SchedulerAction to a no-arg ScheduledAction', async () => {
        let ran = false;
        const action: SchedulerAction = {
            name: 'x',
            async execute() {
                ran = true;
            },
        };
        await toScheduledAction(action)();
        expect(ran).toBe(true);
    });
});

describe('QueueStatsAction', () => {
    test('queries the DAO and emits queue.stats on the bus', async () => {
        const bus = new EventBus<QueueEvents>();
        let emitted: { pending: number; severity: string } | undefined;
        bus.on('queue.stats', (s) => {
            emitted = s;
        });

        const stats = { pending: 3, processing: 1, completed: 9, failed: 2 };
        const action = new QueueStatsAction(async () => ({ getStats: async () => stats }), bus);
        await action.execute();

        expect(emitted).toEqual({ ...stats, severity: 'info' });
    });
});

describe('HealthPingAction', () => {
    test('writes a heartbeat via the injected writer', async () => {
        const writes: Array<{ path: string; content: string }> = [];
        const writer: HealthPingWriter = {
            writeFile(path, content) {
                writes.push({ path, content });
            },
        };
        await new HealthPingAction(writer, '/tmp/hb.json').execute();

        expect(writes).toHaveLength(1);
        expect(writes[0]?.path).toBe('/tmp/hb.json');
        const parsed = JSON.parse(writes[0]?.content ?? '{}');
        expect(parsed.jobName).toBe('health-ping');
        expect(Date.parse(parsed.lastRun)).not.toBeNaN();
    });
});

describe('createDefaultRegistry (opt-in)', () => {
    test('registers only LogAction by default — no side-effecting actions auto-wired', () => {
        const reg = createDefaultRegistry();
        expect(reg.names()).toEqual(['log']);
    });

    test('includes queue-stats only when a DAO provider is supplied', () => {
        const reg = createDefaultRegistry({
            queueStatsDaoProvider: async () => ({
                getStats: async () => ({ pending: 0, processing: 0, completed: 0, failed: 0 }),
            }),
        });
        expect(reg.names()).toContain('queue-stats');
    });

    test('includes health-ping only when a writer is supplied', () => {
        const reg = createDefaultRegistry({ healthPingWriter: { writeFile() {} } });
        expect(reg.names()).toContain('health-ping');
    });
});
