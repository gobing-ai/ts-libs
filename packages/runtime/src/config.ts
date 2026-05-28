import { parse as parseYaml } from 'yaml';
import { type ZodIssue, z } from 'zod';

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

export type Config = z.output<typeof configSchema>;

const ENV_INTERPOLATION_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export class ConfigLoadError extends Error {
    readonly issues: ZodIssue[];

    constructor(message: string, issues: ZodIssue[] = []) {
        super(message);
        this.name = 'ConfigLoadError';
        this.issues = issues;
    }
}

export function getNodeEnv(): string {
    return process.env.NODE_ENV ?? 'development';
}

export function isTestEnv(): boolean {
    return getNodeEnv() === 'test';
}

export function getDatabaseUrl(): string | undefined {
    return process.env.DATABASE_URL;
}

export function interpolateEnv(value: string): string {
    return value.replace(ENV_INTERPOLATION_RE, (_match, name: string) => process.env[name] ?? `\${${name}}`);
}

export function interpolateTree(value: unknown): unknown {
    if (typeof value === 'string') return interpolateEnv(value);
    if (Array.isArray(value)) return value.map(interpolateTree);
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, interpolateTree(child)]));
    }
    return value;
}

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = deepMerge(result[key] as Record<string, unknown>, value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

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

export function deFlattenKeys(entries: Record<string, string>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, rawValue] of Object.entries(entries)) {
        const parts = key.split('.');
        let current = result;
        for (const part of parts.slice(0, -1)) {
            if (!isPlainObject(current[part])) current[part] = {};
            current = current[part] as Record<string, unknown>;
        }

        const last = parts.at(-1);
        if (last === undefined) continue;
        current[last] = parseConfigValue(rawValue);
    }
    return result;
}

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

export function parseConfigYaml(yamlText: string): Record<string, unknown> {
    try {
        const parsed = parseYaml(yamlText);
        if (parsed === null || parsed === undefined) return {};
        if (!isPlainObject(parsed)) {
            throw new ConfigLoadError('Config YAML must parse to an object');
        }
        return parsed;
    } catch (error) {
        if (error instanceof ConfigLoadError) throw error;
        throw new ConfigLoadError(`Config YAML parsing failed: ${(error as Error).message}`);
    }
}

export function buildConfigFromYaml(yamlText: string, options: { overrides?: Partial<Config> } = {}): Config {
    return buildConfigFromObject(parseConfigYaml(yamlText), options);
}

function parseConfigValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T extends Record<string, unknown>>(obj: T): T {
    Object.freeze(obj);
    for (const value of Object.values(obj)) {
        if (isPlainObject(value) && !Object.isFrozen(value)) {
            deepFreeze(value);
        }
    }
    return obj;
}
