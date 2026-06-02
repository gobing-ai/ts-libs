import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getFs } from './fs';

/** Default time budget for a single remote schema fetch. */
const REMOTE_SCHEMA_FETCH_TIMEOUT_MS = 5_000;

export interface JsonSchemaViolation {
    path: string;
    message: string;
}

export interface JsonSchema {
    type?: string | string[];
    required?: string[];
    properties?: Record<string, JsonSchema>;
    additionalProperties?: boolean | JsonSchema;
    items?: JsonSchema;
    enum?: unknown[];
    const?: unknown;
    oneOf?: JsonSchema[];
    anyOf?: JsonSchema[];
    $ref?: string;
    $defs?: Record<string, JsonSchema>;
}

export interface StructuredConfigLoadOptions {
    validateSchema?: boolean;
    /**
     * Allow `http(s)://` `$schema` refs. Off by default: remote fetches are an SSRF/DoS surface when
     * configs are authored by third parties. Prefer bundled package-specifier refs (resolved from
     * `node_modules`). Supplying `fetch` explicitly also opts into remote resolution.
     */
    allowRemote?: boolean;
    fetch?: (input: string) => Promise<Response>;
    /**
     * Module resolver for bare package-specifier `$schema` refs (e.g.
     * `@gobing-ai/ts-rule-engine/schemas/rule-file.schema.json`). Defaults to `Bun.resolveSync`.
     * Injectable for testing.
     */
    resolve?: (specifier: string, from: string) => string;
}

export class StructuredConfigSchemaError extends Error {
    constructor(
        message: string,
        readonly violations: readonly JsonSchemaViolation[] = [],
    ) {
        super(message);
        this.name = 'StructuredConfigSchemaError';
    }
}

export async function loadStructuredConfig(path: string, options: StructuredConfigLoadOptions = {}): Promise<unknown> {
    const content = await getFs().readFile(path);
    return await parseStructuredConfig(content, path, options);
}

export async function parseStructuredConfig(
    content: string,
    source: string,
    options: StructuredConfigLoadOptions = {},
): Promise<unknown> {
    const parsed = source.endsWith('.json') ? JSON.parse(content) : parseYaml(content);
    if (options.validateSchema !== false) {
        await validateDeclaredJsonSchema(parsed, source, options);
    }
    return parsed;
}

export async function validateDeclaredJsonSchema(
    value: unknown,
    source: string,
    options: StructuredConfigLoadOptions = {},
): Promise<void> {
    if (!isObject(value)) return;
    const schemaRef = value.$schema;
    if (typeof schemaRef !== 'string' || schemaRef.length === 0) return;

    const schemaLocation = resolveSchemaRef(schemaRef, source, options.resolve);
    const schemaText = await readSchema(schemaLocation, options);
    let schema: unknown;
    try {
        schema = JSON.parse(schemaText);
    } catch (error) {
        throw new StructuredConfigSchemaError(
            `Invalid JSON schema "${schemaLocation}" referenced by "${source}": ${errorMessage(error)}`,
        );
    }

    if (!isObject(schema)) {
        throw new StructuredConfigSchemaError(
            `JSON schema "${schemaLocation}" referenced by "${source}" must be an object`,
        );
    }

    const violations = validateJsonSchema(value, schema, '', (schema.$defs ?? {}) as Record<string, JsonSchema>);
    if (violations.length > 0) {
        throw new StructuredConfigSchemaError(
            `Configuration "${source}" failed JSON schema validation against "${schemaLocation}": ${violations
                .map((violation) => `${violation.path}: ${violation.message}`)
                .join('; ')}`,
            violations,
        );
    }
}

export function validateJsonSchema(
    value: unknown,
    schema: JsonSchema,
    path = '',
    defs: Record<string, JsonSchema> = {},
): JsonSchemaViolation[] {
    const violations: JsonSchemaViolation[] = [];

    // Applicator keywords compose with their siblings (logical AND), per JSON Schema 2020-12 —
    // a node may carry `$ref`/`oneOf`/`anyOf` *and* `type`/`properties`/... and all apply.
    if (schema.$ref !== undefined) {
        const resolved = resolveRef(schema.$ref, defs, schema.$defs);
        if (resolved !== undefined) violations.push(...validateJsonSchema(value, resolved, path, defs));
    }

    if (schema.oneOf !== undefined) {
        violations.push(...validateCombinator(value, schema.oneOf, path, defs, 'oneOf'));
    }

    if (schema.anyOf !== undefined) {
        violations.push(...validateCombinator(value, schema.anyOf, path, defs, 'anyOf'));
    }

    if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
        violations.push({ path: path || '(root)', message: `expected constant ${JSON.stringify(schema.const)}` });
    }

    if (schema.enum !== undefined && !schema.enum.some((entry) => jsonEqual(value, entry))) {
        violations.push({ path: path || '(root)', message: `expected one of ${schema.enum.map(String).join(', ')}` });
    }

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some((type) => matchesType(value, type))) {
            violations.push({
                path: path || '(root)',
                message: `expected ${types.join(' or ')}, got ${typeName(value)}`,
            });
            return violations;
        }
    }

    const hasObjectKeywords =
        schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined;
    if (schema.type === 'object' || (hasObjectKeywords && isObject(value))) {
        violations.push(...validateObject(value, schema, path, defs));
    }

    if (schema.type === 'array' || (schema.items !== undefined && Array.isArray(value))) {
        violations.push(...validateArray(value, schema, path, defs));
    }

    return violations;
}

function validateObject(
    value: unknown,
    schema: JsonSchema,
    path: string,
    defs: Record<string, JsonSchema>,
): JsonSchemaViolation[] {
    if (!isObject(value)) return [{ path: path || '(root)', message: `expected object, got ${typeName(value)}` }];

    const violations: JsonSchemaViolation[] = [];
    for (const key of schema.required ?? []) {
        if (!(key in value)) {
            violations.push({ path: path ? `${path}.${key}` : key, message: `missing required field "${key}"` });
        }
    }

    const properties = schema.properties ?? {};
    for (const [key, childSchema] of Object.entries(properties)) {
        if (key in value) {
            violations.push(...validateJsonSchema(value[key], childSchema, path ? `${path}.${key}` : key, defs));
        }
    }

    if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(properties));
        for (const key of Object.keys(value)) {
            if (!allowed.has(key)) {
                violations.push({ path: path ? `${path}.${key}` : key, message: `unknown field "${key}"` });
            }
        }
    } else if (isObject(schema.additionalProperties)) {
        for (const [key, child] of Object.entries(value)) {
            if (!(key in properties)) {
                violations.push(
                    ...validateJsonSchema(child, schema.additionalProperties, path ? `${path}.${key}` : key, defs),
                );
            }
        }
    }

    return violations;
}

function validateArray(
    value: unknown,
    schema: JsonSchema,
    path: string,
    defs: Record<string, JsonSchema>,
): JsonSchemaViolation[] {
    if (!Array.isArray(value)) return [{ path: path || '(root)', message: `expected array, got ${typeName(value)}` }];
    if (schema.items === undefined) return [];
    return value.flatMap((entry, index) =>
        validateJsonSchema(entry, schema.items as JsonSchema, `${path}[${index}]`, defs),
    );
}

function validateCombinator(
    value: unknown,
    schemas: JsonSchema[],
    path: string,
    defs: Record<string, JsonSchema>,
    mode: 'oneOf' | 'anyOf',
): JsonSchemaViolation[] {
    const branchViolations = schemas.map((schema) => validateJsonSchema(value, schema, path, defs));
    const passing = branchViolations.filter((violations) => violations.length === 0).length;
    if (mode === 'anyOf' && passing >= 1) return [];
    if (mode === 'oneOf' && passing === 1) return [];

    const at = path || '(root)';
    // oneOf matching more than one branch is a failure, not a pass — report it explicitly.
    if (mode === 'oneOf' && passing > 1) {
        return [{ path: at, message: `expected to match exactly one oneOf branch, matched ${passing}` }];
    }

    // No branch matched: surface every branch's reason so the author sees all options, not just branch 0.
    const detail = branchViolations
        .map((branch, index) => `[${index}] ${branch.map((v) => `${v.path}: ${v.message}`).join(', ')}`)
        .join(' | ');
    return [
        {
            path: at,
            message: `expected to match ${mode === 'oneOf' ? 'exactly one' : 'at least one'} branch — ${detail}`,
        },
    ];
}

function resolveRef(
    ref: string,
    defs: Record<string, JsonSchema>,
    localDefs?: Record<string, JsonSchema>,
): JsonSchema | undefined {
    if (!ref.startsWith('#/$defs/')) return undefined;
    const name = ref.slice('#/$defs/'.length);
    return defs[name] ?? localDefs?.[name];
}

function resolveSchemaRef(
    schemaRef: string,
    source: string,
    resolve: ((specifier: string, from: string) => string) | undefined,
): string {
    if (isRemoteRef(schemaRef) || isAbsolute(schemaRef)) return schemaRef;
    // Relative ref — resolve against the config file's directory.
    if (schemaRef.startsWith('./') || schemaRef.startsWith('../')) {
        return join(isRemoteRef(source) ? '.' : dirname(source), schemaRef);
    }
    // Bare package specifier (e.g. "@scope/pkg/schemas/x.json") — resolve through node_modules.
    return resolvePackageSchema(schemaRef, source, resolve);
}

function resolvePackageSchema(
    specifier: string,
    source: string,
    resolve: ((specifier: string, from: string) => string) | undefined,
): string {
    const resolveFn = resolve ?? defaultResolve;
    if (resolveFn === undefined) {
        throw new StructuredConfigSchemaError(
            `Cannot resolve package schema "${specifier}" referenced by "${source}": no module resolver available`,
        );
    }
    const { pkg, subpath } = splitPackageSpecifier(specifier);
    if (subpath.length === 0) {
        throw new StructuredConfigSchemaError(
            `Package schema ref "${specifier}" referenced by "${source}" must include a path within the package`,
        );
    }
    const from = isRemoteRef(source) ? process.cwd() : dirname(source);
    try {
        // Resolve the package root via its always-present package.json, then join the subpath.
        // This sidesteps `exports` gating on arbitrary JSON subpaths.
        const manifest = resolveFn(`${pkg}/package.json`, from);
        return join(dirname(manifest), subpath);
    } catch (error) {
        throw new StructuredConfigSchemaError(
            `Cannot resolve package schema "${specifier}" referenced by "${source}": ${errorMessage(error)}`,
        );
    }
}

function splitPackageSpecifier(specifier: string): { pkg: string; subpath: string } {
    const parts = specifier.split('/');
    const segments = specifier.startsWith('@') ? 2 : 1;
    return { pkg: parts.slice(0, segments).join('/'), subpath: parts.slice(segments).join('/') };
}

async function readSchema(schemaLocation: string, options: StructuredConfigLoadOptions): Promise<string> {
    if (isRemoteRef(schemaLocation)) {
        const fetchFn = options.fetch ?? (options.allowRemote ? boundedFetch : undefined);
        if (fetchFn === undefined) {
            throw new StructuredConfigSchemaError(
                `Refusing to fetch remote JSON schema "${schemaLocation}": pass { allowRemote: true } or a fetch implementation to opt in`,
            );
        }
        const response = await fetchFn(schemaLocation);
        if (!response.ok) {
            throw new StructuredConfigSchemaError(
                `Failed to fetch JSON schema "${schemaLocation}": HTTP ${response.status}`,
            );
        }
        return await response.text();
    }
    return await getFs().readFile(schemaLocation);
}

const defaultResolve: ((specifier: string, from: string) => string) | undefined =
    typeof Bun !== 'undefined' ? (specifier, from) => Bun.resolveSync(specifier, from) : undefined;

/** Default remote fetch, time-bounded so a slow/hung schema host cannot stall config loading. */
function boundedFetch(input: string): Promise<Response> {
    return globalThis.fetch(input, { signal: AbortSignal.timeout(REMOTE_SCHEMA_FETCH_TIMEOUT_MS) });
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: string): boolean {
    if (type === 'object') return isObject(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'null') return value === null;
    return typeof value === type;
}

function typeName(value: unknown): string {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        return left.every((entry, index) => jsonEqual(entry, right[index]));
    }
    if (isObject(left) && isObject(right)) {
        const keys = Object.keys(left);
        if (keys.length !== Object.keys(right).length) return false;
        // Object member order is insignificant in JSON — compare by key, not by serialization.
        return keys.every((key) => key in right && jsonEqual(left[key], right[key]));
    }
    return false;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRemoteRef(ref: string): boolean {
    return /^https?:\/\//i.test(ref);
}
