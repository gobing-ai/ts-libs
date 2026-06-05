import { deepMerge } from '@gobing-ai/ts-utils';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type ZodIssue, z } from 'zod';

/** Zod schema for the application configuration object, providing defaults for app, database, and logging sections. */
export const configSchema = z.object({
    app: z
        .object({
            name: z.string().default('app'),
            env: z.enum(['development', 'staging', 'production', 'test']).default('development'),
            port: z.number().int().positive().default(3000),
        })
        .default({ name: 'app', env: 'development', port: 3000 }),
    database: z
        .object({
            url: z.string().default(':memory:'),
        })
        .default({ url: ':memory:' }),
    logging: z
        .object({
            level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
            console: z.boolean().default(true),
            file: z.boolean().default(false),
            filePath: z.string().optional(),
            json: z.boolean().default(false),
        })
        .default({ level: 'info', console: true, file: false, json: false }),
});

/** Inferred TypeScript type of a validated configuration object, derived from {@link configSchema}. */
export type Config = z.output<typeof configSchema>;

const ENV_INTERPOLATION_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** Raised when a YAML text cannot be parsed as a plain object. */
export class YamlParseError extends Error {
    constructor(
        message: string,
        readonly innerError?: unknown,
    ) {
        super(message);
        this.name = 'YamlParseError';
    }
}

/** Parse YAML text into a plain object. Returns `{}` for null/undefined/empty input. */
export function parseYamlObject(text: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = parseYaml(text);
    } catch (error) {
        throw new YamlParseError(
            `YAML parsing failed: ${(error as Error).message}`,
            error instanceof Error ? error : undefined,
        );
    }
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new YamlParseError('YAML must parse to an object');
    }
    return parsed as Record<string, unknown>;
}

/** Serialize a plain object to a YAML string. */
export function stringifyYamlObject(value: Record<string, unknown>): string {
    return stringifyYaml(value);
}

/** Error thrown when configuration validation fails, carrying the Zod validation issues for diagnostics. */
export class ConfigLoadError extends Error {
    readonly issues: ZodIssue[];

    constructor(message: string, issues: ZodIssue[] = []) {
        super(message);
        this.name = 'ConfigLoadError';
        this.issues = issues;
    }
}

// These accessors read `process.env` directly and are node-bun only (ADR-008). On
// `cloudflare-workers` there is no `process`; inject config explicitly rather than calling these.

/** Returns the value of `process.env.NODE_ENV`, or `"development"` as default. Node/Bun only. */
export function getNodeEnv(): string {
    return process.env.NODE_ENV ?? 'development';
}
/** Returns `true` when `NODE_ENV` is `"test"`. Node/Bun only. */
export function isTestEnv(): boolean {
    return getNodeEnv() === 'test';
}

/** Returns `process.env` as a plain object. Node/Bun only. */
export function getProcessEnv(): Record<string, string | undefined> {
    return process.env;
}

/** Returns `process.env.DATABASE_URL`, or `undefined` if not set. Node/Bun only. */
export function getDatabaseUrl(): string | undefined {
    return process.env.DATABASE_URL;
}

/** Returns the user's home directory (`HOME`, falling back to `USERPROFILE` on Windows), or `undefined` if unset. Node/Bun only. */
export function getHomeDir(): string | undefined {
    return process.env.HOME ?? process.env.USERPROFILE;
}

/** Node-bun only: interpolates `${VAR}` from `process.env` (see note above). */
export function interpolateEnv(value: string): string {
    return value.replace(ENV_INTERPOLATION_RE, (_match, name: string) => process.env[name] ?? `\${${name}}`);
}

/** Recursively interpolates `${VAR}` environment variables in all string leaves of a nested object or array. Node/Bun only. */
export function interpolateTree(value: unknown): unknown {
    if (typeof value === 'string') return interpolateEnv(value);
    if (Array.isArray(value)) return value.map(interpolateTree);
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, interpolateTree(child)]));
    }
    return value;
}
/** Interpolates env vars, merges overrides, validates against {@link configSchema}, and returns a frozen {@link Config}. */
export function buildConfigFromObject(
    raw: Record<string, unknown>,
    options: { overrides?: Partial<Config> } = {},
): Config {
    const interpolated = interpolateTree(raw) as Record<string, unknown>;
    const merged = options.overrides
        ? deepMerge(interpolated, options.overrides as unknown as Record<string, unknown>)
        : interpolated;
    const result = configSchema.safeParse(merged);
    if (!result.success) {
        throw new ConfigLoadError('Config validation failed', result.error.issues);
    }
    return deepFreeze(result.data);
}
/** Parses a YAML configuration string into a raw object, throwing {@link ConfigLoadError} on failure. */
export function parseConfigYaml(yamlText: string): Record<string, unknown> {
    try {
        return parseYamlObject(yamlText);
    } catch (error) {
        if (error instanceof ConfigLoadError) throw error;
        throw new ConfigLoadError(`Config YAML parsing failed: ${(error as Error).message}`);
    }
}
/** Parses YAML text and builds a validated {@link Config}, equivalent to `buildConfigFromObject(parseConfigYaml(…))`. */
export function buildConfigFromYaml(yamlText: string, options: { overrides?: Partial<Config> } = {}): Config {
    return buildConfigFromObject(parseConfigYaml(yamlText), options);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T extends Record<string, unknown>>(obj: T): T {
    Object.freeze(obj);
    for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
            Object.freeze(value);
            for (const item of value) {
                if (isPlainObject(item) && !Object.isFrozen(item)) {
                    deepFreeze(item as Record<string, unknown>);
                }
            }
        } else if (isPlainObject(value) && !Object.isFrozen(value)) {
            deepFreeze(value);
        }
    }
    return obj;
}
