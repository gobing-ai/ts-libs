import { describe, expect, test } from 'bun:test';
import { attachLogObserver, attachTelemetryObserver, createLifecycleBus } from '../../src/event-bus/default-observers';
import { attachFileObserver, type FileObserverWriter } from '../../src/event-bus/file-observer';
import { setLoggerMuted } from '../../src/logger';

// The log observer (used in the coexistence test) writes real output; mute it.
setLoggerMuted(true);

/** In-memory writer capturing appended lines per path — exercises the DI seam. */
export function memoryWriter(): FileObserverWriter & { lines: (path: string) => unknown[]; dirs: string[] } {
    const files = new Map<string, string>();
    const dirs: string[] = [];
    return {
        dirs,
        ensureDir(dir: string) {
            dirs.push(dir);
        },
        appendFile(path: string, content: string) {
            files.set(path, (files.get(path) ?? '') + content);
        },
        lines(path: string) {
            return (files.get(path) ?? '')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((l) => JSON.parse(l));
        },
    };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe('attachFileObserver', () => {
    test('writes bus.emit.done with payload and lifecycle metadata', () => {
        const w = memoryWriter();
        const bus = createLifecycleBus();
        attachFileObserver(bus, '/logs/events.jsonl', w);

        void bus.emit('bus.emit.done', {
            event: 'app.startup',
            syncCount: 1,
            asyncCount: 0,
            emitDurationMs: 5,
            errors: 0,
            detail: { timestamp: 123 },
        });

        const lines = w.lines('/logs/events.jsonl');
        expect(lines).toHaveLength(1);
        const line = lines[0] as Record<string, unknown>;
        expect(line.lifecycle).toBe('bus.emit.done');
        expect(line.event).toBe('app.startup');
        expect(line.emitDurationMs).toBe(5);
        expect(line.payload).toEqual({ timestamp: 123 });
        expect(Date.parse(line.ts as string)).not.toBeNaN();
    });

    test('omits payload key when detail is absent', () => {
        const w = memoryWriter();
        const bus = createLifecycleBus();
        attachFileObserver(bus, '/logs/x.jsonl', w);

        void bus.emit('bus.emit.done', {
            event: 'db.connected',
            syncCount: 1,
            asyncCount: 0,
            emitDurationMs: 2,
            errors: 0,
        });

        expect((w.lines('/logs/x.jsonl')[0] as Record<string, unknown>).payload).toBeUndefined();
    });

    test('ensures the parent directory once', () => {
        const w = memoryWriter();
        const bus = createLifecycleBus();
        attachFileObserver(bus, '/nested/sub/events.jsonl', w);
        expect(w.dirs).toEqual(['/nested/sub']);
    });

    test('waits for async directory preparation before appending', async () => {
        const gate = deferred();
        const calls: string[] = [];
        const bus = createLifecycleBus();
        attachFileObserver(bus, '/async/events.jsonl', {
            async ensureDir(dir) {
                calls.push(`ensure:${dir}`);
                await gate.promise;
            },
            appendFile(path, content) {
                calls.push(`append:${path}:${JSON.parse(content).event}`);
            },
        });

        void bus.emit('bus.emit.done', {
            event: 'after-ready',
            syncCount: 1,
            asyncCount: 0,
            emitDurationMs: 1,
            errors: 0,
        });

        await Promise.resolve();
        expect(calls).toEqual(['ensure:/async']);

        gate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toEqual(['ensure:/async', 'append:/async/events.jsonl:after-ready']);
    });

    test('absorbs async directory preparation failures', async () => {
        const bus = createLifecycleBus();
        const calls: string[] = [];
        attachFileObserver(bus, '/broken/events.jsonl', {
            async ensureDir() {
                calls.push('ensure');
                throw new Error('mkdir failed');
            },
            appendFile() {
                calls.push('append');
            },
        });

        void bus.emit('bus.emit.noop', { event: 'ignored' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toEqual(['ensure']);
    });

    test('absorbs async append failures', async () => {
        const bus = createLifecycleBus();
        attachFileObserver(bus, '/broken/events.jsonl', {
            ensureDir() {},
            async appendFile() {
                throw new Error('append failed');
            },
        });

        void bus.emit('bus.emit.noop', { event: 'ignored' });
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('writes noop / error / async.enqueued lines', () => {
        const w = memoryWriter();
        const bus = createLifecycleBus();
        attachFileObserver(bus, '/f.jsonl', w);

        void bus.emit('bus.emit.noop', { event: 'no.listeners' });
        void bus.emit('bus.handler.error', { event: 'queue.job.failed', mode: 'sync', error: 'timeout' });
        void bus.emit('bus.handler.async.enqueued', { event: 'order.created', jobId: 'job_abc', handlerCount: 2 });

        const lines = w.lines('/f.jsonl') as Record<string, unknown>[];
        expect(lines.map((l) => l.lifecycle)).toEqual([
            'bus.emit.noop',
            'bus.handler.error',
            'bus.handler.async.enqueued',
        ]);
        expect(lines[1]?.error).toBe('timeout');
        expect(lines[2]?.jobId).toBe('job_abc');
    });

    test('appends multiple events to the same file in order', () => {
        const w = memoryWriter();
        const bus = createLifecycleBus();
        attachFileObserver(bus, '/f.jsonl', w);

        void bus.emit('bus.emit.done', { event: 'e1', syncCount: 1, asyncCount: 0, emitDurationMs: 1, errors: 0 });
        void bus.emit('bus.handler.error', { event: 'e1', mode: 'async', error: 'fail' });
        void bus.emit('bus.emit.done', { event: 'e2', syncCount: 2, asyncCount: 1, emitDurationMs: 3, errors: 0 });

        const events = (w.lines('/f.jsonl') as Record<string, unknown>[]).map((l) => l.event);
        expect(events).toEqual(['e1', 'e1', 'e2']);
    });

    test('coexists with log + telemetry observers', () => {
        const w = memoryWriter();
        const bus = createLifecycleBus();
        attachFileObserver(bus, '/combined.jsonl', w);
        attachLogObserver(bus);
        attachTelemetryObserver(bus);

        void bus.emit('bus.emit.done', { event: 'e', syncCount: 1, asyncCount: 0, emitDurationMs: 1, errors: 0 });
        expect(w.lines('/combined.jsonl')).toHaveLength(1);
    });
});
