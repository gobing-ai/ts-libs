/** Narrow to a non-array object literal. Excludes arrays and `null`, unlike a bare `typeof === object`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `source` into `target`, returning a new object. Nested plain objects merge;
 * arrays and scalars from `source` replace the target wholesale (a source array overrides, never
 * extends). Inputs are not mutated.
 *
 * A `__proto__` key in `source` is skipped: plain assignment would invoke the inherited
 * `__proto__` setter and hand the returned object an attacker-controlled prototype, so
 * `deepMerge(defaults, JSON.parse(userInput))` could resolve absent keys through it. Sibling
 * keys like `constructor` need no guard here — `result` is a fresh object at every level
 * (`{ ...target }`), so assigning them shadows an own property rather than mutating
 * `Object.prototype`.
 */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (key === '__proto__') continue;
        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = deepMerge(result[key] as Record<string, unknown>, value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Flatten a nested object into dot-delimited keys with JSON-stringified leaf values — e.g.
 * `{ a: { b: 1 } }` → `{ "a.b": "1" }`. Inverse of {@link deFlattenKeys}.
 */
export function flattenKeys(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (isPlainObject(value)) {
            Object.assign(result, flattenKeys(value, fullKey));
        } else {
            result[fullKey] = JSON.stringify(value);
        }
    }
    return result;
}

/**
 * Rebuild a nested object from dot-delimited keys, parsing each leaf as JSON (falling back to the
 * raw string). Inverse of {@link flattenKeys}.
 */
export function deFlattenKeys(entries: Record<string, string>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, rawValue] of Object.entries(entries)) {
        const parts = key.split('.');
        // Prototype-pollution guard: navigating `current['__proto__']` resolves to
        // `Object.prototype` (isPlainObject true), so a later assign would land on the global
        // prototype; `constructor`/`prototype` segments let hostile input pivot through
        // `Function.prototype`. Skipping (symmetric with deepMerge) makes deflate of hostile
        // input a no-op rather than a throw callers must catch.
        if (parts.some((part) => part === '__proto__' || part === 'constructor' || part === 'prototype')) continue;
        let current = result;
        for (const part of parts.slice(0, -1)) {
            if (!isPlainObject(current[part])) current[part] = {};
            current = current[part] as Record<string, unknown>;
        }

        const last = parts.at(-1);
        if (last === undefined) continue;
        current[last] = parseJsonValue(rawValue);
    }
    return result;
}

/** Parse a string as JSON, returning the original string if it is not valid JSON. */
function parseJsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}
