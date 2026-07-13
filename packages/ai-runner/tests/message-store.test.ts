import { describe, expect, test } from 'bun:test';
import type { DrainedMessage, MessageStore } from '../src';

/**
 * Type-level + runtime checks for the ai-runner-owned `MessageStore` port
 * (ADR-023 A4).
 * R1/R2: the port exposes the four orchestrator operations and the drained
 * view carries only the fields ai-runner consumes (`id`, `fromId`, `body`).
 */

describe('MessageStore port', () => {
    test('a minimal in-memory store implements the port without an adapter', async () => {
        const drained: DrainedMessage = { id: 'msg-1', fromId: null, body: 'hello' };

        const store: MessageStore = {
            enqueue: async (_fromId, _toId, _body) => 'msg-1',
            drainPending: async () => [drained],
            markDelivered: async () => {},
            markFailed: async () => {},
        };

        expect(Object.keys(drained).sort()).toEqual(['body', 'fromId', 'id']);
        expect(await store.enqueue(null, 'coder', 'hello')).toBe('msg-1');
        expect(await store.drainPending('coder')).toEqual([drained]);
        await store.markDelivered('msg-1');
        await store.markFailed('msg-1', 'boom');
    });
});
