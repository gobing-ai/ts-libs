import { createHash } from 'node:crypto';

/** Serialize JSON with sorted object keys so equivalent records hash identically. */
export function stableJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

/** Compute a SHA-256 hash for an already-normalized record. */
export function sha256(value: unknown): string {
    return createHash('sha256').update(stableJson(value)).digest('hex');
}
