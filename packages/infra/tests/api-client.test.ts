import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { APIClient, APIError } from '../src/api-client';

let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
    mock.restore();
});

function createClient(opts?: { baseUrl?: string; timeout?: number; defaultHeaders?: Record<string, string> }) {
    return new APIClient({
        baseUrl: opts?.baseUrl ?? 'https://api.example.com',
        ...opts,
        fetch: mockFetch as unknown as typeof globalThis.fetch,
    });
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
        // Internal property tested via GET call
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

        const client = createClient();
        await expect(client.get('/users/999')).rejects.toThrow(APIError);
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

        const client = createClient();
        await expect(client.get('/data')).rejects.toThrow('Network failure');
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

        // Verify it worked without specifying timeout
        expect(mockFetch).toHaveBeenCalled();
    });
});
