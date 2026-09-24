import type { JsonObject, RedactionRule } from './types';

/** Default redaction rules for common token, key, and email shapes in agent logs. */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
    {
        // Task 0086 R5: vendor-specific token shapes. The underscore form
        // deliberately requires a live/test infix — a bare sk_/pk_ prefix would
        // redact DB identifiers like pk_customer_orders_id in code snippets.
        name: 'api-key',
        pattern:
            /\b(?:(?:sk|pk|ghp|github_pat|xox[baprs])-[-_a-zA-Z0-9]{12,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,})\b/g,
        replacement: '[REDACTED:token]',
    },
    {
        name: 'github-token',
        pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
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
    {
        name: 'xai-key',
        pattern: /\bxai-[A-Za-z0-9_-]{12,}\b/g,
        replacement: '[REDACTED:token]',
    },
    {
        name: 'aws-access-key-id',
        pattern: /\bAKIA[0-9A-Z]{16}\b/g,
        replacement: '[REDACTED:aws-key]',
    },
    {
        name: 'bearer-token',
        pattern: /\bBearer\s+[A-Za-z0-9._\-=]+\b/g,
        replacement: '[REDACTED:bearer]',
    },
];

/**
 * Keys whose string values are secrets regardless of shape (task 0086 R5).
 * Anchored so usage-analytics keys (tokens_used, token_count, max_tokens) are
 * NOT redacted — those appear in LLM usage records.
 */
const SECRET_KEY =
    /^(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|authorization)$/i;

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
            Object.entries(value as JsonObject).map(([key, entry]) => [
                key,
                SECRET_KEY.test(key) && typeof entry === 'string' ? '[REDACTED:secret]' : redactValue(entry, rules),
            ]),
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
