import type { Json } from '@gobing-ai/ts-ai-runner';
import { DecisionInputError } from './errors';
import type { DecisionDefinition, DecisionParam, JevEntry, JevQuestion, ResolvedParams } from './types';

/**
 * Parameter resolution, `${params.*}` rendering and state building
 * (task 0089 R7; design § Parameters, § Variable replacement).
 */

/** The reserved per-decision parameter carrying the caller's text; authors cannot declare it. */
export const INSTRUCTIONS_PARAM = 'instructions';

/** Authored-instructions default: the caller's text passed through unchanged. */
export const DEFAULT_INSTRUCTIONS_TEMPLATE = `\${params.instructions}`;

/** Same regex as `ts-dual-workflow-engine`'s variable resolver (design § Variable replacement). */
const TEMPLATE_REF = /\$\{([^}]+)\}/g;

/** The implicit reserved `instructions` parameter: type string, default "". */
export function implicitInstructionsParam(): DecisionParam {
    return { name: INSTRUCTIONS_PARAM, type: 'string', required: false, default: '' };
}

function expectTypeMatch(decision: DecisionDefinition, param: DecisionParam, value: Json): void {
    const expects = param.values !== undefined ? `one of [${param.values.join(', ')}]` : param.type;
    let ok: boolean;
    switch (param.type) {
        case 'string':
            ok = typeof value === 'string';
            break;
        case 'number':
            ok = typeof value === 'number' && Number.isFinite(value);
            break;
        case 'boolean':
            ok = typeof value === 'boolean';
            break;
        case 'enum':
            ok = typeof value === 'string' && param.values?.includes(value) === true;
            break;
        case 'json':
            return; // any JSON value is accepted
    }
    if (!ok) {
        throw new DecisionInputError(
            `Parameter "${param.name}" of decision "${decision.id}" expects ${expects}, got ${JSON.stringify(value)}`,
            decision.id,
            param.name,
        );
    }
}

/**
 * Resolve one decision's parameters: declared defaults overlaid by input, plus the
 * implicit `instructions` (default ""). Unknown keys, missing required parameters
 * (those without a default) and type mismatches throw {@link DecisionInputError}.
 * An explicitly supplied `null` is a provided value (type-checked like any other).
 */
export function resolveDecisionInput(decision: DecisionDefinition, input: Record<string, Json> = {}): ResolvedParams {
    const params: ResolvedParams = {};
    for (const key of Object.keys(input)) {
        // Own-property check: input keys like "constructor" must not resolve via the prototype chain.
        if (!Object.hasOwn(decision.parameters, key)) {
            throw new DecisionInputError(
                `Unknown parameter "${key}" for decision "${decision.id}"; declared parameters: ` +
                    `${Object.keys(decision.parameters).join(', ')}`,
                decision.id,
                key,
            );
        }
    }
    for (const param of Object.values(decision.parameters)) {
        const supplied = param.name in input ? input[param.name] : undefined;
        if (supplied === undefined && param.required) {
            throw new DecisionInputError(
                `Missing required parameter "${param.name}" for decision "${decision.id}"`,
                decision.id,
                param.name,
            );
        }
        const value: Json = supplied !== undefined ? supplied : (param.default ?? null);
        expectTypeMatch(decision, param, value);
        params[param.name] = value;
    }
    return params;
}

function substitute(decisionId: string, ref: string, params: ResolvedParams): string {
    if (!ref.startsWith('params.')) {
        throw new DecisionInputError(`Template ref "\${${ref}}" must use the "params" namespace`, decisionId, ref);
    }
    const name = ref.slice('params.'.length);
    const value = params[name];
    // Substitution forms (design § Variable replacement): strings verbatim, numbers and
    // booleans via String, json via JSON.stringify, null as "".
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
}

function renderEntryValue(decisionId: string, value: Json, params: ResolvedParams): Json {
    if (typeof value === 'string') {
        return value.replace(TEMPLATE_REF, (_match, ref: string) => substitute(decisionId, ref, params));
    }
    if (Array.isArray(value)) return value.map((item) => renderEntryValue(decisionId, item, params));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, renderEntryValue(decisionId, entry, params)]),
        );
    }
    return value;
}

function renderEntry(decisionId: string, entry: JevEntry, params: ResolvedParams): JevEntry {
    return renderEntryValue(decisionId, entry, params) as JevEntry;
}

/**
 * Render the decision's Jev question: `${params.<name>}` substitution applied to
 * `instructions` and to criteria-description string leaves. Labels, `fallback`,
 * `maker` and `model` are never templated, so the answer vocabulary stays static.
 */
export function renderQuestion(decision: DecisionDefinition, params: ResolvedParams): JevQuestion {
    const instructions = renderEntry(decision.id, decision.instructions, params);
    const criteria = decision.criteria;
    switch (criteria.kind) {
        case 'choice': {
            const rendered: Record<string, JevEntry> = {};
            for (const [label, entry] of Object.entries(criteria.labels)) {
                rendered[label] = renderEntry(decision.id, entry, params);
            }
            return { type: 'choice', instructions, criteria: rendered };
        }
        case 'score':
            return {
                type: 'score',
                instructions,
                criteria: criteria.levels.map((entry) => renderEntry(decision.id, entry, params)),
            };
        case 'noul': {
            const outcomes = criteria.outcomes;
            if (outcomes === undefined) return { type: 'noul', instructions };
            return {
                type: 'noul',
                instructions,
                criteria: {
                    ...(outcomes.true !== undefined ? { true: renderEntry(decision.id, outcomes.true, params) } : {}),
                    ...(outcomes.false !== undefined
                        ? { false: renderEntry(decision.id, outcomes.false, params) }
                        : {}),
                },
            };
        }
    }
}

/**
 * Build the Jev `state` from the resolved declared parameters, excluding
 * `instructions` and null values; null when nothing remains.
 */
export function buildState(decision: DecisionDefinition, params: ResolvedParams): Record<string, Json> | null {
    const state: Record<string, Json> = {};
    for (const param of Object.values(decision.parameters)) {
        if (param.name === INSTRUCTIONS_PARAM) continue;
        const value = params[param.name];
        if (value === null || value === undefined) continue;
        state[param.name] = value;
    }
    return Object.keys(state).length === 0 ? null : state;
}
