/**
 * Typed accessors for a rule's `evaluator.config` bag and inline-flag parsing.
 *
 * Required keys fail loudly (throw, naming the evaluator) so misconfigured rules
 * surface at evaluation time rather than silently scanning the wrong set.
 */

/** Return the value as a `string[]` when every item is a string, otherwise undefined. */
export function stringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

/** Optional accessor context — names the evaluator in "required config" errors for rule authors. */
export interface ConfigAccessorOptions {
    /** Evaluator name surfaced in the error, e.g. `"regex evaluator requires string config \"pattern\""`. */
    evaluator?: string;
}

function requiredConfigError(kind: string, key: string, evaluator?: string): Error {
    const who = evaluator !== undefined ? `${evaluator} evaluator` : 'evaluator';
    return new Error(`${who} requires ${kind} config "${key}"`);
}

/**
 * Read a string entry from a rule's evaluator config. Returns the value when it is a string,
 * the `fallback` when one is supplied, otherwise throws — so required keys fail loudly.
 */
export function configString(
    config: Record<string, unknown>,
    key: string,
    fallback?: string,
    options: ConfigAccessorOptions = {},
): string {
    const value = config[key];
    if (typeof value === 'string') return value;
    if (fallback !== undefined) return fallback;
    throw requiredConfigError('string', key, options.evaluator);
}

/**
 * Read a string-array entry from a rule's evaluator config. A bare string is coerced to a
 * single-element array. Returns the `fallback` when one is supplied and the value is absent;
 * otherwise throws — so required keys fail loudly.
 */
export function configArray(
    config: Record<string, unknown>,
    key: string,
    fallback?: string[],
    options: ConfigAccessorOptions = {},
): string[] {
    const value = config[key];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[];
    if (typeof value === 'string') return [value];
    if (fallback !== undefined) return fallback;
    throw requiredConfigError('string[]', key, options.evaluator);
}

/** Read a finite-number entry from a rule's evaluator config, falling back when absent or invalid. */
export function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
    const value = config[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Split a leading ripgrep/PCRE-style `(?flags)` inline group off a regex source.
 *
 * Returns the JS-relevant flags found in the group (filtered to `imsu`) and the
 * remaining source with the group removed. When no leading group is present, returns
 * empty flags and the source unchanged. Shared by evaluators that accept inline flags.
 */
export function parseInlineFlags(source: string): { flags: string; rest: string } {
    const match = /^\(\?([a-z]+)\)/.exec(source);
    if (!match) return { flags: '', rest: source };
    const flags = [...(match[1] ?? '')].filter((flag) => 'imsu'.includes(flag)).join('');
    return { flags, rest: source.slice(match[0].length) };
}
