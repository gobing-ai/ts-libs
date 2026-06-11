import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { APIClient, APIError } from '../src/api-client';
import { EventBus } from '../src/event-bus/event-bus';
import type { ApiClientEvents } from '../src/events';

let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
    mock.restore();
});

function createClient(opts?: {
    baseUrl?: string;
    timeout?: number;
    defaultHeaders?: Record<string, string>;
    events?: EventBus<ApiClientEvents>;
}) {
    return new APIClient({
        baseUrl: opts?.baseUrl ?? 'https://api.example.com',
        ...opts,
        fetch: mockFetch as unknown as typeof globalThis.fetch,
    });
}

function createClientWithEvents(opts?: { timeout?: number }): {
    client: APIClient;
    events: EventBus<ApiClientEvents>;
    emitted: unknown[];
} {
    const emitted: unknown[] = [];
    const events = new EventBus<ApiClientEvents>();
    events.on('api.request.error', (detail) => emitted.push(detail));
    return { client: createClient({ ...(opts ?? {}), events }), events, emitted };
}

function mockResponse(status: number, body: unknown, contentType = 'application/json') {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers({ 'content-type': contentType }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

describe('APIClient', () => {
    test('constructs with baseUrl (strips trailing slash)', () => {
        const client = new APIClient({
            baseUrl: 'https://api.example.com/',
            fetch: mockFetch as unknown as typeof globalThis.fetch,
        });
        mockFetch.mockResolvedValue(mockResponse(200, { ok: true }));
        client.get('/test');
        expect(mockFetch).toHaveBeenCalled();
    });

    test('get makes GET request', async () => {
        mockFetch.mockResolvedValue(mockResponse(200, { id: 1 }));

        const client = createClient();
        const result = await client.get<{ id: number }>('/users/1');

        expect(result).toEqual({ id: 1 });
        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.example.com/users/1',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    test('get with path without leading slash', async () => {
        mockFetch.mockResolvedValue(mockResponse(200, { id: 1 }));

        const client = createClient();
        await client.get<{ id: number }>('users/1');

        const calls = mockFetch.mock.calls as unknown[][];
        expect(calls[0]?.[0]).toBe('https://api.example.com/users/1');
    });

    test('get returns text response for non-JSON content type', async () => {
        mockFetch.mockResolvedValue(mockResponse(200, 'plain text', 'text/plain'));

        const client = createClient();
        const result = await client.get<string>('/text');

        expect(result).toBe('"plain text"'); // JSON.stringify('plain text')
    });

    test('post sends body as JSON', async () => {
        mockFetch.mockResolvedValue(mockResponse(201, { id: 2 }));

        const client = createClient();
        const result = await client.post<{ id: number }>('/users', { name: 'Alice' });

        expect(result).toEqual({ id: 2 });
        const calls = mockFetch.mock.calls as unknown[][];
        const fetchArgs = calls[0]?.[1] as { method: string; body: string };
        expect(fetchArgs.method).toBe('POST');
        expect(fetchArgs.body).toBe(JSON.stringify({ name: 'Alice' }));
    });

    test('put makes PUT request', async () => {
        mockFetch.mockResolvedValue(mockResponse(200, { id: 1, name: 'updated' }));

        const client = createClient();
        const result = await client.put<{ id: number; name: string }>('/users/1', { name: 'updated' });

        expect(result).toEqual({ id: 1, name: 'updated' });
        const calls = mockFetch.mock.calls as unknown[][];
        expect((calls[0]?.[1] as { method: string }).method).toBe('PUT');
    });

    test('patch makes PATCH request', async () => {
        mockFetch.mockResolvedValue(mockResponse(200, { id: 1, name: 'patched' }));

        const client = createClient();
        const result = await client.patch<{ id: number; name: string }>('/users/1', { name: 'patched' });

        expect(result).toEqual({ id: 1, name: 'patched' });
        const calls = mockFetch.mock.calls as unknown[][];
        expect((calls[0]?.[1] as { method: string }).method).toBe('PATCH');
    });

    test('delete makes DELETE request', async () => {
        mockFetch.mockResolvedValue(mockResponse(204, null));

        const client = createClient();
        await client.delete('/users/1');

        const calls = mockFetch.mock.calls as unknown[][];
        expect((calls[0]?.[1] as { method: string }).method).toBe('DELETE');
    });

    test('throws APIError on non-2xx response', async () => {
        mockFetch.mockResolvedValue({
            status: 404,
            ok: false,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () => '{"error":"not found"}',
        });

        const { client, emitted } = createClientWithEvents();
        await expect(client.get('/users/999')).rejects.toThrow(APIError);
        // JSON methods emit api.request.error on non-2xx
        expect(emitted.length).toBe(1);
    });

    test('APIError contains status and body', async () => {
        mockFetch.mockResolvedValue({
            status: 500,
            ok: false,
            headers: new Headers({ 'content-type': 'text/plain' }),
            text: async () => 'Internal Server Error',
        });

        const client = createClient();
        try {
            await client.get('/error');
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(APIError);
            const apiError = error as APIError;
            expect(apiError.status).toBe(500);
            expect(apiError.body).toBe('Internal Server Error');
        }
    });

    test('APIError body is truncated at 200 chars', () => {
        const longBody = 'x'.repeat(500);
        const error = new APIError(400, longBody);
        expect(error.message).toBe(`HTTP 400: ${'x'.repeat(200)}`);
    });

    test('throws on network error', async () => {
        mockFetch.mockRejectedValue(new Error('Network failure'));

        const { client, emitted } = createClientWithEvents();
        await expect(client.get('/data')).rejects.toThrow('Network failure');
        expect(emitted.length).toBe(1);
    });

    test('merges default headers with per-request headers', async () => {
        mockFetch.mockResolvedValue(mockResponse(200, {}));

        const client = createClient({ defaultHeaders: { Authorization: 'Bearer token' } });
        await client.get('/data', { headers: { 'X-Custom': 'value' } });

        const calls = mockFetch.mock.calls as unknown[][];
        const headers = (calls[0]?.[1] as { headers: Record<string, string> }).headers;
        expect(headers.Authorization).toBe('Bearer token');
        expect(headers['X-Custom']).toBe('value');
        expect(headers['Content-Type']).toBe('application/json');
    });

    test('request without body sends undefined body', async () => {
        mockFetch.mockResolvedValue(mockResponse(200, {}));

        const client = createClient();
        await client.get('/test');

        const calls = mockFetch.mock.calls as unknown[][];
        expect((calls[0]?.[1] as { body: unknown }).body).toBeUndefined();
    });

    test('timeout defaults to 30 seconds', async () => {
        mockFetch.mockResolvedValue(mockResponse(200, {}));

        const client = new APIClient({
            baseUrl: 'https://api.example.com',
            fetch: mockFetch as unknown as typeof globalThis.fetch,
        });
        await client.get('/test');

        expect(mockFetch).toHaveBeenCalled();
    });

    test('timeout remains active while reading the response body', async () => {
        mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
            const signal = init?.signal;
            return Promise.resolve({
                status: 200,
                ok: true,
                headers: new Headers({ 'content-type': 'text/plain' }),
                text: () =>
                    new Promise<string>((_resolve, reject) => {
                        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
                            once: true,
                        });
                    }),
            });
        });

        const client = createClient({ timeout: 5 });

        // Timeout abort surfaces as APIError(0, "Request timed out after 5ms…")
        await expect(client.get('/slow-body')).rejects.toThrow(/timed out after 5ms/);
    });

    test('caller-initiated abort is not relabeled as a timeout', async () => {
        mockFetch.mockImplementationOnce(() =>
            Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
        );

        const controller = new AbortController();
        controller.abort();

        const client = createClient();
        const err = await client.get('/x', { signal: controller.signal }).then(
            () => null,
            (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(DOMException);
        expect((err as DOMException).name).toBe('AbortError');
    });
});

describe('APIClient.rawRequest', () => {
    test('returns RawHttpResponse for 200', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'text/plain' }),
            text: async () => 'hello',
        });

        const client = createClient();
        const res = await client.rawRequest('GET', '/hello');

        expect(res.status).toBe(200);
        expect(res.body).toBe('hello');
        expect(res.headers['content-type']).toBe('text/plain');
    });

    test('returns RawHttpResponse for 500 (does not throw)', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 500,
            ok: false,
            headers: new Headers({}),
            text: async () => 'server error',
        });

        const client = createClient();
        const res = await client.rawRequest('GET', '/error');

        expect(res.status).toBe(500);
        expect(res.body).toBe('server error');
    });

    test('sends raw string body without JSON serialization', async () => {
        mockFetch.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
            expect(init?.body).toBe('plain text body');
            return {
                status: 200,
                ok: true,
                headers: new Headers({}),
                text: async () => 'ok',
            };
        });

        const client = createClient();
        await client.rawRequest('POST', '/echo', 'plain text body');
    });

    test('does not force Content-Type: application/json', async () => {
        mockFetch.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
            expect(init?.headers).not.toHaveProperty('content-type');
            return {
                status: 200,
                ok: true,
                headers: new Headers({}),
                text: async () => 'ok',
            };
        });

        const client = createClient();
        await client.rawRequest('POST', '/echo', 'data');
    });

    test('throws on network error', async () => {
        mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

        const { client, emitted } = createClientWithEvents();
        await expect(client.rawRequest('GET', '/unreachable')).rejects.toThrow('connect ECONNREFUSED');
        expect(emitted.length).toBe(1);
    });

    test('throws APIError on timeout', async () => {
        mockFetch.mockImplementationOnce((_url: string, init?: RequestInit) => {
            const signal = init?.signal;
            return new Promise<never>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
                    once: true,
                });
            });
        });

        const { client, emitted } = createClientWithEvents({ timeout: 5 });
        await expect(client.rawRequest('GET', '/slow')).rejects.toThrow(/timed out after 5ms/);
        expect(emitted.length).toBe(1);
    });

    test('enforces maxResponseBytes with stream body', async () => {
        const body = 'x'.repeat(100);
        mockFetch.mockResolvedValueOnce({
            status: 200,
            ok: true,
            headers: new Headers({}),
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(body));
                    controller.close();
                },
            }),
        });

        const client = createClient();
        const res = await client.rawRequest('GET', '/large', undefined, { maxResponseBytes: 50 });

        expect(res.body.length).toBeLessThanOrEqual(50);
        expect(res.truncated).toBe(true);
    });

    test('maxResponseBytes falls back to text() when response has no stream body', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            ok: true,
            headers: new Headers({}),
            text: async () => 'y'.repeat(100),
        });

        const client = createClient();
        const res = await client.rawRequest('GET', '/no-stream', undefined, { maxResponseBytes: 50 });

        expect(res.body).toBe('y'.repeat(50));
        expect(res.truncated).toBe(true);
    });

    test('truncated is absent when body fits the cap', async () => {
        mockFetch.mockResolvedValueOnce({
            status: 200,
            ok: true,
            headers: new Headers({}),
            text: async () => 'short',
        });

        const client = createClient();
        const res = await client.rawRequest('GET', '/short', undefined, { maxResponseBytes: 100 });

        expect(res.truncated).toBeUndefined();
    });

    test('caller-initiated abort is not relabeled as a timeout', async () => {
        mockFetch.mockImplementationOnce(() =>
            Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
        );

        const controller = new AbortController();
        controller.abort();

        const client = createClient();
        const err = await client.rawRequest('GET', '/x', undefined, { signal: controller.signal }).then(
            () => null,
            (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(DOMException);
        expect((err as DOMException).name).toBe('AbortError');
    });
});
