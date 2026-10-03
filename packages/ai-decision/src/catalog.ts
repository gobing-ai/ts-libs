import type { Json } from '@gobing-ai/ts-ai-runner';
import type { FileSystem } from '@gobing-ai/ts-runtime';
import { createNodeFileSystem, parseStructuredConfig } from '@gobing-ai/ts-runtime';
import { DecisionCatalogError } from './errors';
import { DEFAULT_INSTRUCTIONS_TEMPLATE, INSTRUCTIONS_PARAM, implicitInstructionsParam } from './params';
import { DecisionCatalogSchema, type ParsedCatalog, type ParsedDecision, type ParsedParamUnion } from './schema';
import type {
    CatalogDefaults,
    DecisionCatalog,
    DecisionCriteria,
    DecisionDefinition,
    DecisionParam,
    DecisionType,
    JevEntry,
} from './types';

/**
 * Catalog loading (task 0089 R5/R6): a thin layer over ts-runtime's
 * `parseStructuredConfig` (YAML parse + `$schema` validation), then the zod
 * schema, then the cross-field checks. Validation is all-or-nothing per
 * catalog — a catalog that fails any check produces no definitions.
 */

/** Same template regex as `ts-dual-workflow-engine`'s variable resolver. */
const TEMPLATE_REF = /\$\{([^}]+)\}/g;

/**
 * Options for {@link loadDecisionCatalog} and {@link parseDecisionCatalog}.
 */
export interface CatalogLoadOptions {
    /** Honour the top-level `$schema` when present. Default true. */
    validateSchema?: boolean;
    /** ts-runtime FileSystem used to read the catalog; defaults to `createNodeFileSystem()`. */
    fileSystem?: Pick<FileSystem, 'readFile'>;
}

const YAML_SOURCE_PATTERN = /\.(yaml|yml)$/;

function assertYamlSource(source: string): void {
    if (!YAML_SOURCE_PATTERN.test(source)) {
        throw new DecisionCatalogError(
            `Decision catalogs are YAML only; source "${source}" does not end in .yaml or .yml`,
            source,
        );
    }
}

/** Load and parse a YAML catalog file, returning typed decision definitions. */
export async function loadDecisionCatalog(path: string, options: CatalogLoadOptions = {}): Promise<DecisionCatalog> {
    assertYamlSource(path);
    const fileSystem = options.fileSystem ?? createNodeFileSystem();
    let content: string;
    try {
        content = await fileSystem.readFile(path);
    } catch (error) {
        throw new DecisionCatalogError(
            `Cannot read decision catalog "${path}": ${error instanceof Error ? error.message : String(error)}`,
            path,
        );
    }
    return parseDecisionCatalog(content, path, options);
}

/** Parse a catalog string (YAML) into typed decision definitions. The source must end in .yaml/.yml. */
export async function parseDecisionCatalog(
    content: string,
    source: string,
    options: CatalogLoadOptions = {},
): Promise<DecisionCatalog> {
    assertYamlSource(source);
    let raw: unknown;
    try {
        raw = await parseStructuredConfig(content, source, {
            validateSchema: options.validateSchema ?? true,
            fileSystem: options.fileSystem,
        });
    } catch (error) {
        // YAML syntax (including duplicate keys) and $schema failures are load failures:
        // wrap so callers always see DecisionCatalogError naming the source.
        throw new DecisionCatalogError(
            `Decision catalog "${source}" failed to parse or validate: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            source,
        );
    }

    const parsed = DecisionCatalogSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const fieldPath = issue?.path.map(String).join('.') ?? '';
        const decisionId = fieldPath.startsWith('decisions.') ? fieldPath.split('.')[1] : undefined;
        throw new DecisionCatalogError(
            `Invalid decision catalog "${source}"${fieldPath ? ` at ${fieldPath}` : ''}: ${issue?.message ?? 'schema mismatch'}`,
            source,
            decisionId,
            fieldPath || undefined,
        );
    }
    return buildCatalog(parsed.data, source);
}

function buildCatalog(parsed: ParsedCatalog, source: string): DecisionCatalog {
    const decisions: Record<string, DecisionDefinition> = {};
    for (const [id, raw] of Object.entries(parsed.decisions)) {
        decisions[id] = checkDecision(id, raw, source);
    }
    const defaults: CatalogDefaults = parsed.defaults ?? {};
    return { source, defaults, decisions };
}

function catalogError(source: string, decisionId: string, field: string, message: string): DecisionCatalogError {
    return new DecisionCatalogError(`Decision "${decisionId}" in "${source}": ${message}`, source, decisionId, field);
}

function normalizeParam(name: string, rawParam: ParsedParamUnion): DecisionParam {
    if (typeof rawParam === 'string') return { name, type: rawParam, required: true };
    const hasDefault = 'default' in rawParam;
    return {
        name,
        type: rawParam.type,
        required: !hasDefault,
        ...(hasDefault ? { default: rawParam.default as DecisionParam['default'] } : {}),
        ...(rawParam.values !== undefined ? { values: rawParam.values } : {}),
        ...(rawParam.description !== undefined ? { description: rawParam.description } : {}),
    };
}

function checkParam(id: string, param: DecisionParam, source: string): void {
    if (param.type === 'enum') {
        if (param.values === undefined || param.values.length < 1) {
            throw catalogError(
                source,
                id,
                `parameters.${param.name}.values`,
                'enum parameter requires at least one value',
            );
        }
    } else if (param.values !== undefined) {
        throw catalogError(
            source,
            id,
            `parameters.${param.name}.values`,
            `only enum parameters may declare values; parameter type is "${param.type}"`,
        );
    }
    if (!param.required && !defaultMatches(param)) {
        throw catalogError(
            source,
            id,
            `parameters.${param.name}.default`,
            `default ${JSON.stringify(param.default ?? null)} does not match declared type "${param.type}"` +
                (param.values ? ` with values [${param.values.join(', ')}]` : ''),
        );
    }
}

function defaultMatches(param: DecisionParam): boolean {
    const value = param.default;
    switch (param.type) {
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'enum':
            return typeof value === 'string' && param.values?.includes(value) === true;
        case 'json':
            return true; // any JSON value, including null
    }
}

function normalizeCriteria(id: string, raw: ParsedDecision, source: string): DecisionCriteria {
    const criteria = raw.criteria;
    if (raw.type === 'choice') {
        if (criteria === undefined || Array.isArray(criteria) || typeof criteria !== 'object' || criteria === null) {
            throw catalogError(source, id, 'criteria', 'choice decision requires a criteria label map');
        }
        const labels = criteria as Record<string, JevEntry>;
        if (Object.keys(labels).length < 2) {
            throw catalogError(source, id, 'criteria', 'choice criteria requires at least two labels');
        }
        return { kind: 'choice', labels };
    }
    if (raw.type === 'score') {
        if (criteria === undefined) {
            throw catalogError(source, id, 'criteria', 'score decision requires a criteria rubric list');
        }
        if (!Array.isArray(criteria)) {
            throw catalogError(source, id, 'criteria', 'score criteria must be a list of level descriptions');
        }
        if (criteria.length < 2) {
            throw catalogError(source, id, 'criteria', 'score criteria requires at least two levels');
        }
        return { kind: 'score', levels: criteria };
    }
    // noul: optional { true?, false? } (R4). The zod union may have matched the open
    // record branch, so unknown outcome keys are rejected here.
    if (criteria === undefined) return { kind: 'noul' };
    if (Array.isArray(criteria) || typeof criteria !== 'object' || criteria === null) {
        throw catalogError(source, id, 'criteria', 'noul criteria must be an object with "true"/"false" keys');
    }
    for (const key of Object.keys(criteria)) {
        if (key !== 'true' && key !== 'false') {
            throw catalogError(
                source,
                id,
                'criteria',
                `noul criteria accepts only the keys "true" and "false"; got "${key}"`,
            );
        }
    }
    const outcomes = criteria as { true?: JevEntry; false?: JevEntry };
    return {
        kind: 'noul',
        ...(outcomes.true !== undefined || outcomes.false !== undefined
            ? {
                  outcomes: {
                      ...(outcomes.true !== undefined ? { true: outcomes.true } : {}),
                      ...(outcomes.false !== undefined ? { false: outcomes.false } : {}),
                  },
              }
            : {}),
    };
}

function checkFallback(
    id: string,
    type: DecisionType,
    criteria: DecisionCriteria,
    fallback: string | number | boolean,
    source: string,
): void {
    if (type === 'choice') {
        // Own-property check: prototype keys like "constructor" must not pass as labels.
        if (criteria.kind !== 'choice' || typeof fallback !== 'string' || !Object.hasOwn(criteria.labels, fallback)) {
            const labels = criteria.kind === 'choice' ? Object.keys(criteria.labels).join(', ') : '';
            throw catalogError(
                source,
                id,
                'fallback',
                `fallback ${JSON.stringify(fallback)} is not a declared criteria label (${labels})`,
            );
        }
        return;
    }
    if (type === 'score') {
        const levelCount = criteria.kind === 'score' ? criteria.levels.length : 0;
        if (
            criteria.kind !== 'score' ||
            typeof fallback !== 'number' ||
            !Number.isInteger(fallback) ||
            fallback < 0 ||
            fallback >= levelCount
        ) {
            throw catalogError(
                source,
                id,
                'fallback',
                `fallback ${JSON.stringify(fallback)} is not an integer level in [0, ${levelCount - 1}]`,
            );
        }
        return;
    }
    if (typeof fallback !== 'boolean') {
        throw catalogError(source, id, 'fallback', `noul fallback must be a boolean; got ${JSON.stringify(fallback)}`);
    }
}

/** Collect every `${...}` reference inside string leaves of a JSON value (recursing objects/arrays). */
function collectTemplateRefs(value: JevEntry | Json, into: Set<string>): void {
    if (typeof value === 'string') {
        for (const match of value.matchAll(TEMPLATE_REF)) into.add(match[1] ?? '');
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectTemplateRefs(item, into);
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const entry of Object.values(value)) collectTemplateRefs(entry, into);
    }
}

function checkTemplateRefs(
    id: string,
    field: string,
    entry: JevEntry,
    declared: ReadonlySet<string>,
    source: string,
): void {
    const refs = new Set<string>();
    collectTemplateRefs(entry, refs);
    for (const ref of refs) {
        if (!ref.startsWith('params.')) {
            throw catalogError(
                source,
                id,
                field,
                `template ref "\${${ref}}" uses namespace "${ref.split('.')[0] ?? ''}"; only "params" is allowed`,
            );
        }
        const name = ref.slice('params.'.length);
        if (!declared.has(name)) {
            throw catalogError(source, id, field, `template ref "\${${ref}}" names an undeclared parameter`);
        }
    }
}

function checkDecision(id: string, raw: ParsedDecision, source: string): DecisionDefinition {
    const parameters: Record<string, DecisionParam> = {};
    const rawParams = raw.parameters ?? {};
    if (INSTRUCTIONS_PARAM in rawParams) {
        throw catalogError(
            source,
            id,
            'parameters.instructions',
            'the "instructions" parameter is reserved and implicit (string, default ""); it cannot be declared',
        );
    }
    for (const [name, rawParam] of Object.entries(rawParams)) {
        const param = normalizeParam(name, rawParam);
        checkParam(id, param, source);
        parameters[name] = param;
    }
    parameters[INSTRUCTIONS_PARAM] = implicitInstructionsParam();

    const criteria = normalizeCriteria(id, raw, source);
    checkFallback(id, raw.type, criteria, raw.fallback, source);

    const instructions = raw.instructions ?? DEFAULT_INSTRUCTIONS_TEMPLATE;
    const declared = new Set(Object.keys(parameters));
    checkTemplateRefs(id, 'instructions', instructions, declared, source);
    const criteriaEntries: JevEntry[] =
        criteria.kind === 'choice'
            ? Object.values(criteria.labels)
            : criteria.kind === 'score'
              ? [...criteria.levels]
              : criteria.outcomes
                ? [criteria.outcomes.true, criteria.outcomes.false].filter((e): e is JevEntry => e !== undefined)
                : [];
    for (const entry of criteriaEntries) {
        checkTemplateRefs(id, 'criteria', entry, declared, source);
    }

    return {
        id,
        source,
        type: raw.type,
        ...(raw.description !== undefined ? { description: raw.description } : {}),
        instructions,
        parameters,
        criteria,
        fallback: raw.fallback,
        ...(raw.minConfidence !== undefined ? { minConfidence: raw.minConfidence } : {}),
        ...(raw.maker !== undefined ? { maker: raw.maker } : {}),
        ...(raw.model !== undefined ? { model: raw.model } : {}),
    };
}
