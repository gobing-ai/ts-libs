import { NodeProcessExecutor, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { DEFAULT_EXCLUDES, matchesGlob } from './file-utils';

/**
 * Evaluates source code against an ast-grep pattern using the `sg` CLI.
 *
 * ## Options (in `evaluator.config`)
 * - `pattern` — ast-grep pattern to search for (required).
 * - `language` — language for ast-grep parsing (default: `typescript`).
 *
 * Scope is forwarded to `sg` via `--globs` so the subprocess **prunes during traversal**
 * rather than walking everything and filtering after:
 * - the rule's `include` globs become positive `--globs` patterns;
 * - {@link DEFAULT_EXCLUDES} (`node_modules`, `dist`, …) and the rule's `exclude` globs
 *   become negated `--globs '!…'` patterns, so heavy generated trees are never descended
 *   into even when a rule forgets to exclude them. ast-grep takes the later glob on
 *   precedence, so exclusions are appended after includes.
 *
 * The rule's `exclude` is also re-applied in-process as a belt-and-suspenders against any
 * difference between ast-grep's glob semantics and {@link matchesGlob}.
 */
export class SgEvaluator implements RuleEvaluator {
    private readonly executor: ProcessExecutor;

    constructor(executor: ProcessExecutor = new NodeProcessExecutor()) {
        this.executor = executor;
    }

    /** Run sg and emit one finding per matched AST node. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const pattern = config.pattern;
        if (typeof pattern !== 'string' || pattern.length === 0) {
            throw new Error('sg evaluator requires string config "pattern"');
        }

        const language = typeof config.language === 'string' ? config.language : 'typescript';
        const include = rule.include ?? [];
        const exclude = rule.exclude ?? [];

        const args: string[] = ['run', '--pattern', pattern, '--lang', language, '--json'];
        // Positive include globs first.
        for (const glob of include) {
            args.push('--globs', glob);
        }
        // Negated globs prune at traversal time. Default excludes go first so a rule's own
        // exclude (later → higher precedence in ast-grep) can still re-include if intended.
        for (const dir of DEFAULT_EXCLUDES) {
            args.push('--globs', `!**/${dir}/**`);
        }
        for (const glob of exclude) {
            args.push('--globs', `!${glob}`);
        }

        const result = await this.executor.run({
            command: 'sg',
            args,
            cwd: context.workdir,
            timeout: 60_000,
            rejectOnError: false,
            label: 'sg',
        });

        const stdout = result.stdout.trim();

        if (stdout.length === 0) {
            if (result.exitCode !== 0 && result.exitCode !== null && result.stderr.trim().length > 0) {
                throw new Error(`sg failed: ${result.stderr.trim()}`);
            }
            return { findings: [], fixes: [] };
        }

        const matches = parseSgJson(stdout);
        const findings = [];
        for (const match of matches) {
            if (exclude.some((glob) => matchesGlob(match.file, glob))) continue;
            findings.push(
                createFinding(rule, 'matched sg pattern', match.file, {
                    line: match.line,
                    code: 'sg:match',
                }),
            );
        }

        return { findings, fixes: [] };
    }
}

/** Parsed sg match entry. */
interface SgMatch {
    file: string;
    line: number;
    text: string;
}

/**
 * Parse `sg --json` output.
 *
 * Handles both a JSON array (sg >= 0.40) and newline-delimited JSON objects
 * (older sg or `--json=stream`). Returns workdir-relative file paths as-is
 * since sg emits paths relative to cwd.
 */
function parseSgJson(stdout: string): SgMatch[] {
    // Try JSON array first (newer sg).
    try {
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed)) {
            return parsed.flatMap((event) => {
                const file = typeof event.file === 'string' ? event.file : '';
                if (!file) return [];
                return [
                    {
                        file,
                        line: (event.range?.start?.line ?? 0) + 1,
                        text: typeof event.text === 'string' ? event.text.trim() : '',
                    },
                ];
            });
        }
    } catch {
        // Fall through to line-delimited parsing.
    }

    // Fallback: newline-delimited JSON.
    const results: SgMatch[] = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const event = JSON.parse(trimmed);
            const file = typeof event.file === 'string' ? event.file : '';
            if (!file) continue;
            results.push({
                file,
                line: (event.range?.start?.line ?? 0) + 1,
                text: typeof event.text === 'string' ? event.text.trim() : '',
            });
        } catch {
            // Skip unparseable lines.
        }
    }
    return results;
}
