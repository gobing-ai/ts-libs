import type { DecisionDriver } from './types';

/** Configuration the facade resolves (key per R7) and forwards to the TypeSafe driver. */
export interface TypesafeDriverConfig {
    apiKey: string;
    model?: string;
    baseURL?: string;
    timeoutMs?: number;
    maxRetries?: number;
    fetch?: typeof fetch;
}

// ponytail: only the lazy-construction slot exists in 0071 — client wiring and
// neutral⇄SDK mapping land in task 0072. Until then first use without a custom
// driver throws here, after key resolution has already succeeded.
export function createTypesafeDriver(_config: TypesafeDriverConfig): DecisionDriver {
    throw new Error('createTypesafeDriver: TypeSafe driver is delivered by task 0072');
}
