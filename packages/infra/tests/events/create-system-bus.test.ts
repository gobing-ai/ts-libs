import { describe, expect, test } from 'bun:test';
import { createSystemBus } from '../../src/events/create-system-bus';
import { setLoggerMuted } from '../../src/logger';

setLoggerMuted(true);

/** Permissive test bus — event names and handler signatures are intentionally untyped for ergonomics. */
function bus() {
    return createSystemBus() as unknown as {
        on<TArgs extends unknown[]>(event: string, handler: (...args: TArgs) => void, opts?: { async?: boolean }): void;
        off<TArgs extends unknown[]>(event: string, handler: (...args: TArgs) => void): void;
        once<TArgs extends unknown[]>(
            event: string,
            handler: (...args: TArgs) => void,
            opts?: { async?: boolean },
        ): void;
        emit(event: string, ...args: unknown[]): Promise<void>;
        removeAllListeners(): void;
        listenerCount(event: string, mode?: 'sync' | 'async'): number;
        eventNames(): string[];
    };
}

describe('createSystemBus', () => {
    test('returns an EventBus instance', () => {
        const b = createSystemBus();
        expect(b).toBeDefined();
    });

    test('supports on/emit for sync handlers', async () => {
        const b = bus();
        const calls: string[] = [];

        b.on('test.event', (payload: string) => {
            calls.push(payload);
        });

        await b.emit('test.event', 'hello');
        expect(calls).toEqual(['hello']);
    });

    test('supports multiple handlers', async () => {
        const b = bus();
        let count = 0;

        b.on('increment', () => count++);
        b.on('increment', () => count++);

        await b.emit('increment');
        expect(count).toBe(2);
    });

    test('supports off to remove handler', async () => {
        const b = bus();
        let count = 0;

        const handler = () => {
            count++;
        };
        b.on('tick', handler);
        await b.emit('tick');
        expect(count).toBe(1);

        b.off('tick', handler);
        await b.emit('tick');
        expect(count).toBe(1);
    });

    test('supports once handler', async () => {
        const b = bus();
        let count = 0;

        b.once('init', () => count++);

        await b.emit('init');
        await b.emit('init');
        expect(count).toBe(1);
    });

    test('removeAllListeners clears all handlers', async () => {
        const b = bus();
        let count = 0;
        b.on('a', () => count++);
        b.on('b', () => count++);

        b.removeAllListeners();
        await b.emit('a');
        await b.emit('b');
        expect(count).toBe(0);
    });

    test('listenerCount returns correct count', () => {
        const b = createSystemBus();
        b.on('ev', () => {});
        b.on('ev', () => {});

        expect(b.listenerCount('ev')).toBe(2);
        expect(b.listenerCount('nonexistent')).toBe(0);
    });

    test('eventNames returns registered events', () => {
        const b = createSystemBus();
        b.on('alpha', () => {});
        b.on('beta', () => {});

        const names = b.eventNames();
        expect(names).toContain('alpha');
        expect(names).toContain('beta');
    });

    test('handles async option registration', () => {
        const b = createSystemBus();
        b.on('async.ev', () => {}, { async: true });

        expect(b.listenerCount('async.ev', 'async')).toBe(1);
        expect(b.listenerCount('async.ev', 'sync')).toBe(0);
    });
});
