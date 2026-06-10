/**
 * Typed HTTP client builder wrapping fetch with OTel tracing.
 */
import { type Span, SpanKind } from '@opentelemetry/api';
import {
    ATTR_HTTP_REQUEST_METHOD,
    ATTR_HTTP_RESPONSE_STATUS_CODE,
    ATTR_URL_FULL,
} from '@opentelemetry/semantic-conventions';
import type { EventBus } from './event-bus/event-bus';
import type { ApiClientEvents } from './events';
import {
    getHttpClientRequestDuration,
    getHttpClientRequestErrors,
    getHttpClientRequestTotal,
} from './telemetry/metrics';
import { traceAsync } from './telemetry/tracing';

// ── Types ───────────────────────────────────────────────────────────

/** Configuration for {@link APIClient}: base URL, default headers, timeout, and optional custom fetch. */
export interface APIClientConfig {
    baseUrl: string;
    defaultHeaders?: Record<string, string>;
    timeout?: number;
    fetch?: typeof globalThis.fetch;
    /**
     * Optional bus for `api.request.error` events. Emitted on network errors,
     * timeouts, and (for the JSON methods) non-2xx responses. `rawRequest`
     * returns non-2xx statuses normally, so it emits only on network/timeout.
     */
    events?: EventBus<ApiClientEvents>;
}
/** Per-request overrides: headers, timeout, operation name, and abort signal. */
export interface RequestOptions {
    headers?: Record<string, string>;
    timeout?: number;
    operationName?: string;
    signal?: AbortSignal;
}

/** Options for {@link APIClient.rawRequest}: extends RequestOptions with redirect policy and response-size cap. */
export interface RawRequestOptions extends RequestOptions {
    /** Redirect policy (default `'manual'`). */
    redirect?: 'follow' | 'error' | 'manual';
    maxResponseBytes?: number;
}

/** Raw HTTP response returned by {@link APIClient.rawRequest} for all status codes. */
export interface RawHttpResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
    /** True when `maxResponseBytes` capped the body. Omitted when no cap was applied. */
    truncated?: boolean;
}
/**
 * HTTP error with status code and response body text.
 * Timeouts are reported with `status === 0` (no response was received).
 */
export class APIError extends Error {
    constructor(
        public readonly status: number,
        public readonly body: string,
    ) {
        super(`HTTP ${status}: ${body.slice(0, 200)}`);
        this.name = 'APIError';
    }
}

// ── Body reading ────────────────────────────────────────────────────

/**
 * Read a response body capped at `maxResponseBytes` (UTF-8 bytes). Returns the
 * decoded text and whether the body was truncated. Falls back to `text()` with
 * a character cap when the response exposes no readable stream.
 */
async function readBodyCapped(
    response: Response,
    maxResponseBytes: number,
): Promise<{ text: string; truncated?: boolean }> {
    const reader = response.body?.getReader();
    if (!reader) {
        const full = await response.text();
        if (full.length > maxResponseBytes) {
            return { text: full.slice(0, maxResponseBytes), truncated: true };
        }
        return { text: full };
    }

    const chunks: string[] = [];
    const decoder = new TextDecoder();
    let total = 0;
    let truncated = false;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxResponseBytes - total;
        if (value.length > remaining) {
            // The streaming decoder holds back a trailing partial multibyte
            // sequence, which is then dropped — the cap is a byte budget.
            chunks.push(decoder.decode(value.slice(0, remaining), { stream: true }));
            truncated = true;
            break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
        total += value.length;
    }
    if (truncated) {
        // Stop the underlying stream instead of letting it keep downloading.
        await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
    return { text: chunks.join(''), ...(truncated ? { truncated } : {}) };
}

// ── Client ──────────────────────────────────────────────────────────

/**
 * Typed HTTP client builder wrapping fetch with automatic JSON serialization,
 * timeout support, and OpenTelemetry tracing on every request.
 *
 * @example
 * ```ts
 * const client = new APIClient({ baseUrl: 'https://api.example.com' });
 * const data = await client.get<User>('/users/1');
 * ```
 */
export class APIClient {
    private readonly baseUrl: string;
    private readonly defaultHeaders: Record<string, string>;
    private readonly timeout: number;
    private readonly fetchFn: typeof globalThis.fetch;
    private readonly events: EventBus<ApiClientEvents> | undefined;

    constructor(config: APIClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, '');
        this.defaultHeaders = config.defaultHeaders ?? {};
        this.timeout = config.timeout ?? 30_000;
        this.fetchFn = config.fetch ?? globalThis.fetch;
        this.events = config.events;
    }

    private buildUrl(path: string): string {
        return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    }

    private emitRequestError(method: string, url: string, error: string, status?: number): void {
        void this.events?.emit('api.request.error', {
            url,
            method,
            ...(status !== undefined ? { status } : {}),
            error,
        });
    }

    /**
     * Shared request lifecycle: span + attributes, timeout/abort wiring,
     * total/duration/error metrics, the fetch call, and timeout-vs-abort error
     * mapping. `consume` owns response handling (parse/throw policy).
     */
    private async runRequest<T>(
        method: string,
        url: string,
        headers: Record<string, string>,
        body: string | undefined,
        opts: RequestOptions | undefined,
        redirect: RawRequestOptions['redirect'] | undefined,
        consume: (response: Response, span: Span) => Promise<T>,
    ): Promise<T> {
        const operationName = opts?.operationName ?? `HTTP ${method} ${url}`;

        return traceAsync(
            operationName,
            async (span: Span) => {
                span.setAttribute(ATTR_HTTP_REQUEST_METHOD, method);
                span.setAttribute(ATTR_URL_FULL, url);

                const controller = new AbortController();
                const timeoutMs = opts?.timeout ?? this.timeout;
                let timer: ReturnType<typeof setTimeout> | undefined;

                if (timeoutMs > 0) {
                    timer = setTimeout(() => controller.abort(), timeoutMs);
                }

                const combinedSignal = opts?.signal
                    ? AbortSignal.any([opts.signal, controller.signal])
                    : controller.signal;

                try {
                    const start = performance.now();

                    const response = await this.fetchFn(url, {
                        method,
                        headers,
                        body,
                        signal: combinedSignal,
                        ...(redirect ? { redirect } : {}),
                    });

                    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

                    getHttpClientRequestTotal().add(1, {
                        'http.request.method': method,
                        'http.response.status_code': response.status,
                    });
                    getHttpClientRequestDuration().record(performance.now() - start, {
                        'http.request.method': method,
                        'http.response.status_code': response.status,
                    });

                    return await consume(response, span);
                } catch (error) {
                    // Timeout (our own AbortController fired) — but never relabel a
                    // caller-initiated abort via opts.signal as a timeout.
                    if (error instanceof DOMException && error.name === 'AbortError' && !opts?.signal?.aborted) {
                        getHttpClientRequestErrors().add(1, {
                            'http.request.method': method,
                            'error.type': 'Timeout',
                        });
                        const timeoutError = new APIError(
                            0,
                            `Request timed out after ${timeoutMs}ms: ${method} ${url}`,
                        );
                        this.emitRequestError(method, url, timeoutError.message);
                        throw timeoutError;
                    }

                    if (!(error instanceof APIError)) {
                        getHttpClientRequestErrors().add(1, {
                            'http.request.method': method,
                            'error.type': error instanceof Error ? error.name : 'Unknown',
                        });
                    }
                    this.emitRequestError(
                        method,
                        url,
                        error instanceof Error ? error.message : String(error),
                        error instanceof APIError && error.status > 0 ? error.status : undefined,
                    );

                    throw error;
                } finally {
                    if (timer) clearTimeout(timer);
                }
            },
            { kind: SpanKind.CLIENT },
        );
    }

    private async request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const url = this.buildUrl(path);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.defaultHeaders,
            ...opts?.headers,
        };

        return this.runRequest<T>(
            method,
            url,
            headers,
            body !== undefined ? JSON.stringify(body) : undefined,
            opts,
            undefined,
            async (response) => {
                if (!response.ok) {
                    const text = await response.text();
                    getHttpClientRequestErrors().add(1, {
                        'http.request.method': method,
                        'error.type': `HTTP_${response.status}`,
                    });
                    throw new APIError(response.status, text);
                }

                const contentType = response.headers.get('content-type') ?? '';
                if (contentType.includes('application/json')) {
                    return (await response.json()) as T;
                }

                return (await response.text()) as unknown as T;
            },
        );
    }

    /**
     * Make a raw HTTP request returning status, headers, and body for ALL status codes.
     * Never throws on HTTP status codes (2xx, 4xx, 5xx all return a {@link RawHttpResponse}).
     * Throws only on network/timeout errors.
     *
     * Deliberately does NOT force Content-Type: application/json — callers pass raw
     * string bodies and set their own content-type header.
     */
    async rawRequest(method: string, path: string, body?: string, opts?: RawRequestOptions): Promise<RawHttpResponse> {
        const url = this.buildUrl(path);
        const headers: Record<string, string> = {
            ...this.defaultHeaders,
            ...opts?.headers,
        };
        const redirect = opts?.redirect ?? 'manual';
        const maxResponseBytes = opts?.maxResponseBytes;

        return this.runRequest<RawHttpResponse>(
            method,
            url,
            headers,
            body ?? undefined,
            opts,
            redirect,
            async (response) => {
                if (!response.ok) {
                    getHttpClientRequestErrors().add(1, {
                        'http.request.method': method,
                        'error.type': `HTTP_${response.status}`,
                    });
                }

                let text: string;
                let truncated: boolean | undefined;
                if (maxResponseBytes !== undefined) {
                    ({ text, truncated } = await readBodyCapped(response, maxResponseBytes));
                } else {
                    text = await response.text();
                }

                const responseHeaders: Record<string, string> = {};
                response.headers.forEach((value, key) => {
                    responseHeaders[key] = value;
                });

                return {
                    status: response.status,
                    headers: responseHeaders,
                    body: text,
                    ...(truncated !== undefined ? { truncated } : {}),
                };
            },
        );
    }

    async get<T>(path: string, opts?: RequestOptions): Promise<T> {
        return this.request<T>('GET', path, undefined, opts);
    }

    async post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        return this.request<T>('POST', path, body, opts);
    }

    async put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        return this.request<T>('PUT', path, body, opts);
    }

    async patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        return this.request<T>('PATCH', path, body, opts);
    }

    async delete<T>(path: string, opts?: RequestOptions): Promise<T> {
        return this.request<T>('DELETE', path, undefined, opts);
    }
}
