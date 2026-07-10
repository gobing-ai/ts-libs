import { describe, expect, mock, test } from 'bun:test';
import { extractModelName, extractProvider, ModelHealthProbeRegistry, OmpModelProbe } from '../src/model-health-probe';

// --- fetch mocking helpers ---------------------------------------------------

type FetchResponse = {
    status: number;
    body?: unknown;
};

function mockFetch(responses: FetchResponse | ((url: string, init?: RequestInit) => FetchResponse)): void {
    const responder = typeof responses === 'function' ? responses : () => responses;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const r = responder(urlStr, init);
        return new Response(r.body ? JSON.stringify(r.body) : null, {
            status: r.status,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof globalThis.fetch;
}
function mockFetchAbort(): void {
    globalThis.fetch = mock(async () => {
        throw new DOMException('The operation was aborted', 'AbortError');
    }) as unknown as typeof globalThis.fetch;
}

// --- extractProvider / extractModelName --------------------------------------

describe('extractProvider', () => {
    test('extracts the provider prefix from a provider/model string', () => {
        expect(extractProvider('zai/glm-5.2')).toBe('zai');
        expect(extractProvider('volc/glm-5.2')).toBe('volc');
    });

    test('returns the entire string when no slash is present', () => {
        expect(extractProvider('glm-5.2')).toBe('glm-5.2');
    });
});

describe('extractModelName', () => {
    test('extracts the model name from a provider/model string', () => {
        expect(extractModelName('zai/glm-5.2')).toBe('glm-5.2');
        expect(extractModelName('deepseek/deepseek-v4-pro')).toBe('deepseek-v4-pro');
    });

    test('returns the entire string when no slash is present', () => {
        expect(extractModelName('glm-5.2')).toBe('glm-5.2');
    });
});

// --- ModelHealthProbeRegistry -------------------------------------------------

describe('ModelHealthProbeRegistry', () => {
    test('resolve returns the registered probe for a matching provider prefix', () => {
        const registry = new ModelHealthProbeRegistry();
        const probe = {} as OmpModelProbe;
        registry.register('zai', probe);
        expect(registry.resolve('zai/glm-5.2')).toBe(probe);
    });

    test('resolve returns null when no probe is registered for the provider', () => {
        const registry = new ModelHealthProbeRegistry();
        expect(registry.resolve('unknown/model')).toBeNull();
    });
});

// --- OmpModelProbe -----------------------------------------------------------

describe('OmpModelProbe', () => {
    const probe = new OmpModelProbe();
    const config = { apiKey: 'test-key', timeoutMs: 5000 };

    test('200 response → available', async () => {
        mockFetch({ status: 200, body: { id: 'chatcmpl-1' } });
        const result = await probe.probe('zai', 'zai/glm-5.2', config);
        expect(result.status).toBe('available');
        expect(result.checkedAt).toBeTruthy();
    });

    test('429 with quota error type → quota_exhausted', async () => {
        mockFetch({
            status: 429,
            body: { error: { type: 'insufficient_quota', message: 'You exceeded your current quota' } },
        });
        const result = await probe.probe('zai', 'zai/glm-5.2', config);
        expect(result.status).toBe('quota_exhausted');
        expect(result.detail).toContain('quota');
    });

    test('429 with rate-limit error type → rate_limited', async () => {
        mockFetch({
            status: 429,
            body: { error: { type: 'rate_limit_exceeded', message: 'Too many requests' } },
        });
        const result = await probe.probe('zai', 'zai/glm-5.2', config);
        expect(result.status).toBe('rate_limited');
        expect(result.detail).toContain('Too many requests');
    });

    test('500 response → unavailable', async () => {
        mockFetch({ status: 500, body: { error: { message: 'Internal server error' } } });
        const result = await probe.probe('zai', 'zai/glm-5.2', config);
        expect(result.status).toBe('unavailable');
        expect(result.detail).toBe('HTTP 500');
    });

    test('AbortController timeout → unknown', async () => {
        mockFetchAbort();
        const result = await probe.probe('zai', 'zai/glm-5.2', { apiKey: 'test-key', timeoutMs: 50 });
        expect(result.status).toBe('unknown');
        expect(result.detail).toBe('probe timed out');
    });

    test('unknown provider → unknown with detail', async () => {
        const result = await probe.probe('unknown-provider', 'unknown-provider/model', config);
        expect(result.status).toBe('unknown');
        expect(result.detail).toContain('unknown-provider');
    });

    test('anthropic-messages API format sends correct headers and body', async () => {
        let capturedUrl = '';
        let capturedHeaders: Record<string, string> = {};
        let capturedBody: string | undefined;

        globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
            capturedUrl = typeof url === 'string' ? url : url.toString();
            capturedHeaders = init?.headers as Record<string, string>;
            capturedBody = init?.body as string | undefined;
            return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const result = await probe.probe('volc', 'volc/glm-5.2', config);

        expect(capturedUrl).toBe('https://ark.cn-beijing.volces.com/api/coding/messages');
        expect(capturedHeaders['x-api-key']).toBe('test-key');
        expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
        const body = JSON.parse(capturedBody as string);
        expect(body.model).toBe('volc/glm-5.2');
        expect(body.max_tokens).toBe(1);
        expect(body.messages[0].content).toBe('ping');
        expect(result.status).toBe('available');
    });

    test('probe timeout fires AbortController and returns unknown', async () => {
        // Fake timer: invoke the abort callback synchronously when setTimeout is called.
        const originalSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = ((cb: (...args: unknown[]) => void) => {
            cb();
            return 0 as unknown as NodeJS.Timeout;
        }) as typeof globalThis.setTimeout;

        // fetch hangs until the abort signal fires, then rejects with AbortError.
        globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
            const signal = init?.signal;
            if (signal?.aborted) {
                throw new DOMException('The operation was aborted', 'AbortError');
            }
            return new Promise<Response>((_, reject) => {
                signal?.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted', 'AbortError'));
                });
            });
        }) as unknown as typeof globalThis.fetch;

        try {
            const result = await probe.probe('zai', 'zai/glm-5.2', config);
            expect(result.status).toBe('unknown');
            expect(result.detail).toBe('probe timed out');
        } finally {
            globalThis.setTimeout = originalSetTimeout;
        }
    });
});
