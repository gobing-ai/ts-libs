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

export interface APIClientConfig {
    baseUrl: string;
    defaultHeaders?: Record<string, string>;
    timeout?: number;
    fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
    headers?: Record<string, string>;
    timeout?: number;
    operationName?: string;
    signal?: AbortSignal;
}

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

                    if (timer) clearTimeout(timer);

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
                    if (timer) clearTimeout(timer);

                    if (!(error instanceof APIError)) {
                        getHttpClientRequestErrors().add(1, {
                            'http.request.method': method,
                            'error.type': error instanceof Error ? error.name : 'Unknown',
                        });
                    }

                    throw error;
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
