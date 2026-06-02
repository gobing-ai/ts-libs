import { parse as parseYaml } from 'yaml';
import { getFs } from './fs';

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
    fetch?: (input: string) => Promise<Response>;
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

    const schemaPath = resolveSchemaRef(schemaRef, source);
    const schemaText = await readSchema(schemaPath, options.fetch);
    let schema: unknown;
    try {
        schema = JSON.parse(schemaText);
    } catch (error) {
        throw new StructuredConfigSchemaError(
            `Invalid JSON schema "${schemaPath}" referenced by "${source}": ${errorMessage(error)}`,
        );
    }

    if (!isObject(schema)) {
        throw new StructuredConfigSchemaError(
            `JSON schema "${schemaPath}" referenced by "${source}" must be an object`,
        );
    }

    const violations = validateJsonSchema(value, schema, '', (schema.$defs ?? {}) as Record<string, JsonSchema>);
    if (violations.length > 0) {
        throw new StructuredConfigSchemaError(
            `Configuration "${source}" failed JSON schema validation against "${schemaPath}": ${violations
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
    if (schema.$ref !== undefined) {
        const resolved = resolveRef(schema.$ref, defs, schema.$defs);
        return resolved === undefined ? [] : validateJsonSchema(value, resolved, path, defs);
    }

    if (schema.oneOf !== undefined) {
        return validateCombinator(value, schema.oneOf, path, defs, 'oneOf');
    }

    if (schema.anyOf !== undefined) {
        return validateCombinator(value, schema.anyOf, path, defs, 'anyOf');
    }

    const violations: JsonSchemaViolation[] = [];
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

    if (schema.type === 'object' || (schema.properties !== undefined && isObject(value))) {
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
    return branchViolations[0] ?? [{ path: path || '(root)', message: `failed ${mode}` }];
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

function resolveSchemaRef(schemaRef: string, source: string): string {
    if (isRemoteRef(schemaRef) || isAbsolutePath(schemaRef)) return schemaRef;
    return joinPath(dirnamePath(source), schemaRef);
}

async function readSchema(
    schemaPath: string,
    fetchFn: ((input: string) => Promise<Response>) | undefined = globalThis.fetch,
): Promise<string> {
    if (isRemoteRef(schemaPath)) {
        if (fetchFn === undefined)
            throw new StructuredConfigSchemaError(`Cannot fetch remote JSON schema "${schemaPath}"`);
        const response = await fetchFn(schemaPath);
        if (!response.ok) {
            throw new StructuredConfigSchemaError(
                `Failed to fetch JSON schema "${schemaPath}": HTTP ${response.status}`,
            );
        }
        return await response.text();
    }
    return await getFs().readFile(schemaPath);
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
    return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRemoteRef(ref: string): boolean {
    return /^https?:\/\//i.test(ref);
}

function normalizeSeparators(path: string): string {
    return path.replaceAll('\\', '/');
}

function isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:\//.test(normalizeSeparators(path));
}

function dirnamePath(path: string): string {
    const input = normalizeSeparators(path);
    if (isRemoteRef(input)) return input.slice(0, input.lastIndexOf('/'));
    const index = input.lastIndexOf('/');
    if (index < 0) return '.';
    if (index === 0) return '/';
    return input.slice(0, index);
}

function joinPath(...segments: string[]): string {
    const filtered = segments.filter((segment) => segment.length > 0).map(normalizeSeparators);
    if (filtered.length === 0) return '.';
    if (isRemoteRef(filtered[0] ?? '')) return filtered.join('/').replace(/([^:])\/+/g, '$1/');
    const absolute = isAbsolutePath(filtered[0] ?? '');
    const joined = filtered.join('/').replace(/\/+/g, '/');
    return absolute ? joined : joined.replace(/^\//, '');
}
