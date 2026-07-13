import type { Mock } from 'bun:test';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { APIClient } from '../src/api-client';
import { EventBus } from '../src/event-bus/event-bus';
import type { BusLifecycleEvents } from '../src/event-bus/types';
import type { ApiClientEvents } from '../src/events';

let mockFetch: Mock<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>;

beforeEach(() => {
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
    mock.restore();
});

function mockResponse(status: number, body: unknown, contentType = 'application/json') {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers({ 'content-type': contentType }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/**
 * R5: APIClient accepts an optional `lifecycleBus`. When `events` is omitted
 * the client constructs an internal `EventBus<ApiClientEvents>` parented to
 * it so `api.request.error` bridges into the System Events stream.
 */
describe('APIClient — lifecycle bus propagation (R5)', () => {
    test('api.request.error reaches the parent lifecycle bus', async () => {
        const seen: string[] = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (d) => seen.push(d.event));
        const events = new EventBus<ApiClientEvents>({ lifecycleBus });

        const client = new APIClient({
            baseUrl: 'https://api.example.com',
            fetch: mockFetch as unknown as typeof globalThis.fetch,
            events,
            lifecycleBus,
        });

        mockFetch.mockResolvedValueOnce(mockResponse(500, { error: 'server failed' }));
        await expect(client.get('/x')).rejects.toThrow('server failed');

        expect(seen).toContain('api.request.error');
    });

    test('no lifecycleBus — requests still succeed, no propagation', async () => {
        const client = new APIClient({
            baseUrl: 'https://api.example.com',
            fetch: mockFetch as unknown as typeof globalThis.fetch,
        });

        mockFetch.mockResolvedValueOnce(mockResponse(200, { ok: true }));
        const result = await client.get('/x');
        expect(result).toEqual({ ok: true });
    });
});
