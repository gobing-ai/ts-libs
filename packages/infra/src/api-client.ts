/**
 * Typed HTTP client builder wrapping fetch with OTel tracing.
 */
import { type Span, SpanKind } from '@opentelemetry/api';
import {
    ATTR_HTTP_REQUEST_METHOD,
    ATTR_HTTP_RESPONSE_STATUS_CODE,
    ATTR_URL_FULL,
} from '@opentelemetry/semantic-conventions';
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
}
/** HTTP error with status code and response body text. */
export class APIError extends Error {
    constructor(
        public readonly status: number,
        public readonly body: string,
    ) {
        super(`HTTP ${status}: ${body.slice(0, 200)}`);
        this.name = 'APIError';
    }
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

    constructor(config: APIClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, '');
        this.defaultHeaders = config.defaultHeaders ?? {};
        this.timeout = config.timeout ?? 30_000;
        this.fetchFn = config.fetch ?? globalThis.fetch;
    }

    private buildUrl(path: string): string {
        return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    }

    private async request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const url = this.buildUrl(path);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.defaultHeaders,
            ...opts?.headers,
        };

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
                        body: body !== undefined ? JSON.stringify(body) : undefined,
                        signal: combinedSignal,
                    });

                    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

                    getHttpClientRequestTotal().add(1, {
                        'http.request.method': method,
                        'http.response.status_code': response.status,
                    });

                    const duration = performance.now() - start;
                    getHttpClientRequestDuration().record(duration, {
                        'http.request.method': method,
                        'http.response.status_code': response.status,
                    });

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
                } catch (error) {
                    if (!(error instanceof APIError)) {
                        getHttpClientRequestErrors().add(1, {
                            'http.request.method': method,
                            'error.type': error instanceof Error ? error.name : 'Unknown',
                        });
                    }

                    throw error;
                } finally {
                    if (timer) clearTimeout(timer);
                }
            },
            { kind: SpanKind.CLIENT },
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
                        body: body ?? undefined,
                        signal: combinedSignal,
                        redirect,
                    });

                    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

                    getHttpClientRequestTotal().add(1, {
                        'http.request.method': method,
                        'http.response.status_code': response.status,
                    });

                    const duration = performance.now() - start;
                    getHttpClientRequestDuration().record(duration, {
                        'http.request.method': method,
                        'http.response.status_code': response.status,
                    });

                    if (!response.ok) {
                        getHttpClientRequestErrors().add(1, {
                            'http.request.method': method,
                            'error.type': `HTTP_${response.status}`,
                        });
                    }

                    let text = '';
                    if (maxResponseBytes !== undefined) {
                        // Read up to maxResponseBytes+1 to detect truncation.
                        const reader = response.body?.getReader();
                        if (reader) {
                            const chunks: string[] = [];
                            let total = 0;
                            const decoder = new TextDecoder();
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                const needed = maxResponseBytes + 1 - total;
                                if (needed <= 0) break;
                                const chunk = value.slice(0, needed);
                                chunks.push(decoder.decode(chunk, { stream: !done }));
                                total += chunk.length;
                                if (total > maxResponseBytes) break;
                            }
                            reader.releaseLock();
                            text = chunks.join('').slice(0, maxResponseBytes);
                        }
                    } else {
                        text = await response.text();
                    }

                    const responseHeaders: Record<string, string> = {};
                    response.headers.forEach((value, key) => {
                        responseHeaders[key] = value;
                    });

                    return { status: response.status, headers: responseHeaders, body: text };
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        getHttpClientRequestErrors().add(1, {
                            'http.request.method': method,
                            'error.type': 'Timeout',
                        });
                        throw new APIError(0, `Request timed out after ${timeoutMs}ms: ${method} ${url}`);
                    }

                    getHttpClientRequestErrors().add(1, {
                        'http.request.method': method,
                        'error.type': error instanceof Error ? error.name : 'Unknown',
                    });
                    throw error;
                } finally {
                    if (timer) clearTimeout(timer);
                }
            },
            { kind: SpanKind.CLIENT },
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

    async delete<T>(path: string, opts?: RequestOptions): Promise<T> {
        return this.request<T>('DELETE', path, undefined, opts);
    }
}
