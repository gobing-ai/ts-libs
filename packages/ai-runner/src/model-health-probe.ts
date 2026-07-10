/**
 * Model health probe infrastructure.
 *
 * Provides a pluggable probe interface for checking model-level liveness and
 * quota state on provider APIs. The {@link ModelHealthProbeRegistry} maps
 * provider prefixes (e.g. `volc/`, `zai/`) to probe implementations, so new
 * providers can be added without modifying {@link DoctorRunner} core (R9).
 *
 * The shipped {@link OmpModelProbe} handles all `omp`-configured providers by
 * issuing a minimal 1-token completion request and interpreting the HTTP
 * response (R3).
 */

/** Health status for a single model endpoint. */
export type ModelHealthStatus = 'available' | 'quota_exhausted' | 'rate_limited' | 'unavailable' | 'unknown';

/** Result of probing one model's health (R2). */
export interface ModelHealthResult {
    status: ModelHealthStatus;
    /** Sanitized provider error message — never contains API keys or headers. */
    detail?: string;
    /** ISO 8601 timestamp of when the probe completed. */
    checkedAt: string;
}

/** Configuration passed to a probe — the probe is a pure HTTP client (R3). */
export interface ProbeConfig {
    /** API key for the provider, resolved by the caller (DoctorRunner) from env. */
    apiKey: string;
    /** Bounded timeout in milliseconds (default 10s). A timeout resolves to `unknown` (R8). */
    timeoutMs: number;
    /** Optional endpoint override (for testing or custom deployments). */
    endpoint?: string;
}

/** Provider-agnostic probe interface (R2). */
export interface ModelHealthProbe {
    probe(provider: string, model: string, config: ProbeConfig): Promise<ModelHealthResult>;
}

/**
 * Maps provider prefixes to probe implementations (R9).
 * The provider prefix is extracted from the model string's first path segment
 * (e.g. `volc/glm-5.2` → `volc`).
 */
export class ModelHealthProbeRegistry {
    private readonly probes = new Map<string, ModelHealthProbe>();

    /** Register a probe for a provider prefix (e.g. `volc`, `zai`). */
    register(providerPrefix: string, probe: ModelHealthProbe): void {
        this.probes.set(providerPrefix, probe);
    }

    /** Resolve a probe for a model string, or `null` when no probe is registered. */
    resolve(model: string): ModelHealthProbe | null {
        const slashIndex = model.indexOf('/');
        const provider = slashIndex >= 0 ? model.slice(0, slashIndex) : model;
        return this.probes.get(provider) ?? null;
    }
}

/** Extract the provider prefix from a `provider/model` string. */
export function extractProvider(model: string): string {
    const slashIndex = model.indexOf('/');
    return slashIndex >= 0 ? model.slice(0, slashIndex) : model;
}

/** Extract the model name from a `provider/model` string. */
export function extractModelName(model: string): string {
    const slashIndex = model.indexOf('/');
    return slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
}

/** Provider configuration for omp-managed providers. */
interface OmpProviderConfig {
    baseUrl: string;
    apiType: 'openai-completions' | 'anthropic-messages';
}

/** Known omp provider configurations (baseUrl + API format). */
const OMP_PROVIDERS: Record<string, OmpProviderConfig> = {
    zai: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiType: 'openai-completions' },
    volc: { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', apiType: 'anthropic-messages' },
    minimax: { baseUrl: 'https://api.minimaxi.com/v1', apiType: 'openai-completions' },
    deepseek: { baseUrl: 'https://api.deepseek.com', apiType: 'openai-completions' },
};

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe for `omp`-configured providers (R3).
 *
 * Issues a minimal 1-token completion request (`prompt: "ping"`, `max_tokens: 1`)
 * to the provider's API and interprets the response:
 * - 200 → `available`
 * - 429 + quota body → `quota_exhausted`
 * - 429 + rate-limit body → `rate_limited`
 * - Other 4xx/5xx → `unavailable`
 * - AbortController timeout → `unknown`
 *
 * Supports both `openai-completions` and `anthropic-messages` API formats.
 * The provider→apiType mapping is built into this probe since it is specifically
 * the `OmpModelProbe` — pluggability (R9) is at the registry level.
 */
export class OmpModelProbe implements ModelHealthProbe {
    async probe(provider: string, model: string, config: ProbeConfig): Promise<ModelHealthResult> {
        const checkedAt = new Date().toISOString();
        const providerConfig = OMP_PROVIDERS[provider];

        if (!providerConfig) {
            return { status: 'unknown', detail: `unknown omp provider '${provider}'`, checkedAt };
        }

        const baseUrl = config.endpoint ?? providerConfig.baseUrl;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

        try {
            const response = await this.issueRequest(
                providerConfig.apiType,
                baseUrl,
                model,
                config.apiKey,
                controller.signal,
            );
            return await this.interpretResponse(response, checkedAt);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return { status: 'unknown', detail: 'probe timed out', checkedAt };
            }
            const message = error instanceof Error ? error.message : 'probe failed';
            return { status: 'unknown', detail: message, checkedAt };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /** Issue a minimal completion request based on the API format. */
    private async issueRequest(
        apiType: OmpProviderConfig['apiType'],
        baseUrl: string,
        model: string,
        apiKey: string,
        signal: AbortSignal,
    ): Promise<Response> {
        if (apiType === 'anthropic-messages') {
            const url = `${baseUrl}/messages`;
            return await globalThis.fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1,
                }),
                signal,
            });
        }

        // openai-completions
        const url = `${baseUrl}/chat/completions`;
        return await globalThis.fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
            }),
            signal,
        });
    }

    /** Interpret the HTTP response into a {@link ModelHealthResult}. */
    private async interpretResponse(response: Response, checkedAt: string): Promise<ModelHealthResult> {
        if (response.status === 200) {
            return { status: 'available', checkedAt };
        }

        if (response.status === 429) {
            const body = await this.parseBody(response);
            const errorType = body?.error?.type ?? body?.error?.code ?? '';
            const errorMessage = body?.error?.message ?? '';

            if (
                errorType.includes('quota') ||
                errorType.includes('insufficient_quota') ||
                errorType.includes('insufficient')
            ) {
                return { status: 'quota_exhausted', detail: errorMessage || 'quota exceeded', checkedAt };
            }
            return { status: 'rate_limited', detail: errorMessage || 'rate limited', checkedAt };
        }

        // Other 4xx/5xx → unavailable
        return { status: 'unavailable', detail: `HTTP ${response.status}`, checkedAt };
    }

    /** Best-effort JSON body parse; returns null on failure. */
    private async parseBody(
        response: Response,
    ): Promise<{ error?: { type?: string; code?: string; message?: string } } | null> {
        try {
            return (await response.json()) as { error?: { type?: string; code?: string; message?: string } };
        } catch {
            return null;
        }
    }
}

/** Default probe timeout in milliseconds (R8). */
export { DEFAULT_PROBE_TIMEOUT_MS };
