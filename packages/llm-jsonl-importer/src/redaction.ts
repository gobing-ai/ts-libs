import type { JsonObject, RedactionRule } from './types';

/** Default redaction rules for common token, key, and email shapes in agent logs. */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
    {
        name: 'api-key',
        pattern: /\b(?:sk|pk|ghp|github_pat|xox[baprs])-[-_a-zA-Z0-9]{12,}\b/g,
        replacement: '[REDACTED:token]',
    },
    {
        name: 'assignment-secret',
        pattern: /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"',\s}]+/gi,
        replacement: '[REDACTED:secret]',
    },
    {
        name: 'email',
        pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        replacement: '[REDACTED:email]',
    },
];

/** Redact supported scalar and composite JSON values recursively. */
export function redactValue(value: unknown, rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES): unknown {
    if (typeof value === 'string') {
        return rules.reduce((current, rule) => current.replace(rule.pattern, rule.replacement), value);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactValue(entry, rules));
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as JsonObject).map(([key, entry]) => [key, redactValue(entry, rules)]),
        );
    }
    return value;
}

/** Redact a normalized ETL record before hashing or writing it to the database. */
export function redactRecord<TRecord extends JsonObject>(
    record: TRecord,
    rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES,
): TRecord {
    return redactValue(record, rules) as TRecord;
}
