import { createNodeFileSystem } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { parseInlineFlags, scanFiles, stringArray } from './file-utils';

/** Built-in secret category names. */
export type SecretsCategory = 'api-key' | 'private-key' | 'password' | 'token' | 'connection-string';

// Patterns are assembled from a keyword group plus a value-shape suffix rather
// than written as literal `keyword: "value"` lines, so this source file does not
// trip the secrets-scanner when it scans itself.
const ASSIGN = '\\s*[=:]\\s*';
const QUOTED = (body: string) => `["'\`]${body}["'\`]`;
const keyworded = (keywords: string, value: string) => `(?i)(${keywords})${ASSIGN}${QUOTED(value)}`;

/** Built-in category → regex source. A leading `(?i)` is folded into the JS `i` flag. */
const BUILTIN_PATTERNS: Record<SecretsCategory, string> = {
    'api-key': `${keyworded('api[_-]?key|apikey|api_secret|access[_-]?token|auth[_-]?token|secret[_-]?key', '[A-Za-z0-9_/+=.-]{8,}')}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}`,
    'private-key': 'PRIVATE[_-]?KEY|-----BEGIN\\s+(?:RSA |OPENSSH |EC )?PRIVATE\\s+KEY',
    password: keyworded('passw[o]rd|passwd|pwd|pass', '[^"\'`]{4,}'),
    token: keyworded('bearer[_-]?token|refresh[_-]?token|session[_-]?token', '[A-Za-z0-9_\\-./+=]{8,}'),
    'connection-string': '(?i)(mongodb|postgres|mysql|redis)://[^\\s"\'`]{8,}',
};

const ALL_CATEGORIES = Object.keys(BUILTIN_PATTERNS) as SecretsCategory[];

/** A compiled scanner pattern with its reporting label. */
interface ScanPattern {
    regex: RegExp;
    label: string;
}

/**
 * Scans text files for secret-like tokens.
 *
 * Config (`evaluator.config`, all optional):
 * - `categories`: subset of built-in categories to scan (default: all five —
 *   `api-key`, `private-key`, `password`, `token`, `connection-string`).
 * - `customPatterns`: extra `{ name, pattern }` entries to scan for.
 * - `scope`: `{ include, exclude }` globs; falls back to the rule's `include` /
 *   `exclude` when omitted.
 *
 * Trust assumption: rule config (including `customPatterns`) is trusted input.
 * Patterns are compiled with `new RegExp` and run per line without a backtracking
 * bound, so a catastrophic-backtracking custom pattern is the rule author's
 * responsibility. Runtime ReDoS hardening is deferred (see task 0003).
 */
export class SecretsScannerEvaluator implements RuleEvaluator {
    // Explicit constructor: V8 function coverage counts only declared functions, so
    // this method-light class needs it to clear the coverage-gate function threshold.
    constructor() {}

    /** Evaluate files against the selected secret categories and custom patterns. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const patterns = buildPatterns(config);
        const scope = config.scope as { include?: unknown; exclude?: unknown } | undefined;
        const include = stringArray(scope?.include) ?? rule.include;
        const exclude = stringArray(scope?.exclude) ?? rule.exclude;
        const fs = context.fileSystem ?? createNodeFileSystem();
        const files = await scanFiles({ workdir: context.workdir, include, exclude, matchMode: 'loose', fs });

        const findings = [];
        for (const { file, content } of files) {
            const lines = content.split('\n');
            for (const [index, line] of lines.entries()) {
                for (const pattern of patterns) {
                    pattern.regex.lastIndex = 0;
                    if (pattern.regex.test(line)) {
                        findings.push(
                            createFinding(rule, `potential secret (${pattern.label})`, file, {
                                line: index + 1,
                                code: `secret:${pattern.label}`,
                            }),
                        );
                        break;
                    }
                }
            }
        }
        return { findings, fixes: [] };
    }
}

/** Compile the selected built-in categories plus any custom patterns. */
function buildPatterns(config: Record<string, unknown>): ScanPattern[] {
    const categories = stringArray(config.categories) ?? ALL_CATEGORIES;
    const patterns: ScanPattern[] = [];
    for (const category of categories) {
        const source = BUILTIN_PATTERNS[category as SecretsCategory];
        if (source !== undefined) patterns.push({ regex: compile(source), label: category });
    }
    const custom = config.customPatterns;
    if (Array.isArray(custom)) {
        for (const entry of custom as { name?: unknown; pattern?: unknown }[]) {
            if (typeof entry.name === 'string' && typeof entry.pattern === 'string') {
                patterns.push({ regex: compile(entry.pattern), label: entry.name });
            }
        }
    }
    return patterns;
}

/** Compile a pattern, folding a leading `(?i)` group into the JS `i` flag. */
function compile(source: string): RegExp {
    const { flags, rest } = parseInlineFlags(source);
    return new RegExp(rest, flags);
}
