import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { discoverFiles, matchesGlob, readWorkdirFile } from './file-utils';

/** A forbidden entry: either an exact import specifier or a raw source pattern. */
type ForbiddenEntry =
    | { specifier: string; includeRequire?: boolean }
    | { pattern: string; matchMode?: 'import' | 'usage' };

/** Compiled scan entry derived from config. */
interface ScanEntry {
    regex: RegExp;
    label: string;
}

/**
 * Detects forbidden imports / API usage.
 *
 * Two config shapes are supported:
 * - Simple: `{ patterns: string[] }` — substring match against any import specifier,
 *   scoped by the rule's own `include` / `exclude`.
 * - Structured: `{ forbidden: [...], scope: { include, exclude } }` — each forbidden
 *   entry is an exact `specifier` (also matching require/dynamic forms unless
 *   `includeRequire:false`) or a raw `pattern`, scoped by `scope.include` /
 *   `scope.exclude` globs.
 */
export class ForbiddenImportEvaluator implements RuleEvaluator {
    /** Evaluate import/usage against the configured forbidden set. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        return Array.isArray(config.forbidden)
            ? this.evaluateStructured(rule, context, config)
            : this.evaluateSimple(rule, context, config);
    }

    /** Legacy path: `{ patterns: string[] }`, substring-matched against import specifiers. */
    private async evaluateSimple(
        rule: ConstraintRule,
        context: RuleContext,
        config: Record<string, unknown>,
    ): Promise<RuleEvaluationResult> {
        const forbidden = arrayConfig(config, 'patterns');
        const files = await discoverFiles({
            workdir: context.workdir,
            include: rule.include ?? ['.ts', '.tsx', '.js', '.jsx'],
            exclude: rule.exclude,
        });
        const findings = [];
        for (const file of files) {
            const lines = (await readWorkdirFile(context.workdir, file)).split('\n');
            for (const [index, line] of lines.entries()) {
                const imported = importSpecifier(line);
                if (imported === undefined) continue;
                const matched = forbidden.find((pattern) => imported.includes(pattern));
                if (matched !== undefined) {
                    findings.push(
                        createFinding(rule, `Forbidden import "${imported}" matched "${matched}"`, file, {
                            line: index + 1,
                            code: 'import:forbidden',
                        }),
                    );
                }
            }
        }
        return { findings, fixes: [] };
    }

    /** Structured path: `{ forbidden: [...], scope: { include, exclude } }`. */
    private async evaluateStructured(
        rule: ConstraintRule,
        context: RuleContext,
        config: Record<string, unknown>,
    ): Promise<RuleEvaluationResult> {
        const scope = config.scope as { include?: unknown; exclude?: unknown } | undefined;
        const include = stringArray(scope?.include);
        if (include === undefined) {
            throw new Error('forbidden-import evaluator requires string[] config "scope.include"');
        }
        const exclude = stringArray(scope?.exclude) ?? [];
        const entries = (config.forbidden as ForbiddenEntry[]).map(compileEntry);

        // Discover all source files, then apply scope globs precisely (discoverFiles'
        // include matching is intentionally loose, so it cannot do `**`-anchored scoping).
        const files = (await discoverFiles({ workdir: context.workdir }))
            .filter((file) => include.some((glob) => matchesGlob(file, glob)))
            .filter((file) => !exclude.some((glob) => matchesGlob(file, glob)));

        const findings = [];
        for (const file of files) {
            const lines = (await readWorkdirFile(context.workdir, file)).split('\n');
            for (const [index, line] of lines.entries()) {
                const hit = entries.find((entry) => entry.regex.test(line));
                if (hit !== undefined) {
                    findings.push(
                        createFinding(rule, `Forbidden import/usage of "${hit.label}"`, file, {
                            line: index + 1,
                            code: 'import:forbidden',
                        }),
                    );
                }
            }
        }
        return { findings, fixes: [] };
    }
}

/** Extract the specifier from an import/require/dynamic-import line, if any. */
function importSpecifier(line: string): string | undefined {
    return /(?:from\s+|import\s*\(|^\s*import\s*)['"](?<specifier>[^'"]+)['"]/.exec(line)?.groups?.specifier;
}

/** Compile a forbidden entry into a line-matching regex. */
function compileEntry(entry: ForbiddenEntry): ScanEntry {
    if ('specifier' in entry) {
        const spec = escapeRegExp(entry.specifier);
        const boundary = `(?:/|['"])`;
        const source =
            entry.includeRequire === false
                ? `from\\s+['"]${spec}${boundary}`
                : `(?:from\\s+|require\\(\\s*|import\\(\\s*)['"]${spec}${boundary}`;
        return { regex: new RegExp(source), label: entry.specifier };
    }
    return { regex: new RegExp(entry.pattern), label: entry.pattern };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function arrayConfig(config: Record<string, unknown>, key: string): string[] {
    const value = config[key];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
    if (typeof value === 'string') return [value];
    throw new Error(`forbidden-import evaluator requires string[] config "${key}"`);
}

function stringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}
