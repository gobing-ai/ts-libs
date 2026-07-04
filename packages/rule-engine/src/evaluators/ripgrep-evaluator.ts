import { NodeProcessExecutor, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { configString, DEFAULT_EXCLUDES } from './file-utils';

/**
 * Evaluates source files against a regex using the `rg` (ripgrep) CLI.
 *
 * This is the real ripgrep-backed engine registered under the `rg` rule type. Unlike
 * the {@link import('./regex-evaluator').RegexEvaluator} (`regex` type, JS `RegExp`),
 * it runs ripgrep's linear-time Rust regex engine: ReDoS-immune, parallel, and pruning
 * heavy trees during traversal. The dialect differs from JS `RegExp` — no lookbehind or
 * backreferences — so rule patterns must be ripgrep-compatible (enforced by the
 * `rg-dialect` spur rule; see {@link isRipgrepCompatiblePattern}).
 *
 * ## Options (in `evaluator.config`)
 * - `pattern` — ripgrep regex to search for (required).
 * - `mode` — `forbid` (default): each match is a finding. `require`: a finding per file
 *   that lacks the pattern.
 * - `multiline` — when `true`, patterns may span lines (`rg -U --multiline-dotall`).
 *
 * Inline flags like `(?i)` are passed through to ripgrep, which supports them natively.
 *
 * The rule's `include` globs and `exclude` globs (plus {@link DEFAULT_EXCLUDES}) are
 * forwarded as `--glob` / `--glob '!…'` so ripgrep prunes during traversal rather than
 * walking everything — the same skip-list the in-process discovery path uses, applied
 * regardless of whether the workspace is a git repo or has a `.gitignore`.
 */
export class RipgrepEvaluator implements RuleEvaluator {
    private readonly executor: ProcessExecutor;

    constructor(executor: ProcessExecutor = new NodeProcessExecutor()) {
        this.executor = executor;
    }

    /** Run ripgrep and emit findings for matches (forbid) or absent files (require). */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const pattern = configString(config, 'pattern', undefined, { evaluator: 'rg' });
        const mode = configString(config, 'mode', 'forbid');
        const multiline = config.multiline === true;

        const args = buildArgs(pattern, mode, multiline, rule.include ?? [], rule.exclude ?? []);
        const result = await this.executor.run({
            command: 'rg',
            args,
            cwd: context.workdir,
            timeout: 60_000,
            rejectOnError: false,
            label: 'rg',
        });

        // ripgrep exits 0 with matches, 1 when none, 2 on error. A scoped rule whose
        // positive globs match no files also exits 2 with "No files were searched";
        // that means "this rule is not applicable in this repo", not a broken
        // evaluator. Keep all other exit-2 cases loud.
        if (result.exitCode !== 0 && result.exitCode !== 1) {
            const detail = result.stderr.trim();
            if (isNoFilesSearched(detail)) return { findings: [], fixes: [] };
            throw new Error(`rg failed (exit ${result.exitCode})${detail.length > 0 ? `: ${detail}` : ''}`);
        }

        return mode === 'require'
            ? { findings: requireFindings(rule, pattern, result.stdout), fixes: [] }
            : { findings: forbidFindings(rule, pattern, result.stdout), fixes: [] };
    }
}

function isNoFilesSearched(stderr: string): boolean {
    return stderr.includes('No files were searched');
}

/** Build the ripgrep argument list for the given mode and scope. */
function buildArgs(pattern: string, mode: string, multiline: boolean, include: string[], exclude: string[]): string[] {
    const args: string[] = [];
    if (multiline) args.push('-U', '--multiline-dotall');

    if (mode === 'require') {
        // Files lacking the pattern, one path per line.
        args.push('--files-without-match');
    } else {
        // Structured events carrying file + line_number for precise findings.
        args.push('--json');
    }

    // Scope: includes as positive globs, DEFAULT_EXCLUDES + rule excludes as negated globs
    // so ripgrep prunes during traversal (not after) regardless of .gitignore presence.
    for (const glob of include) args.push('--glob', glob);
    for (const dir of DEFAULT_EXCLUDES) args.push('--glob', `!**/${dir}/**`);
    for (const glob of exclude) args.push('--glob', `!${glob}`);

    // `--` guards against a pattern that begins with `-`.
    args.push('--', pattern);
    return args;
}

/** Parse `rg --json` match events into one finding per matched line. */
function forbidFindings(rule: ConstraintRule, pattern: string, stdout: string): ReturnType<typeof createFinding>[] {
    const findings: ReturnType<typeof createFinding>[] = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let event: RipgrepEvent;
        try {
            event = JSON.parse(trimmed) as RipgrepEvent;
        } catch {
            continue; // Skip non-JSON noise.
        }
        if (event.type !== 'match') continue;
        const file = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        if (typeof file !== 'string' || typeof lineNumber !== 'number') continue;
        findings.push(
            createFinding(rule, `forbidden pattern found: ${pattern}`, file, {
                line: lineNumber,
                code: 'rg:found',
            }),
        );
    }
    return findings;
}

/** Build one finding per file path printed by `rg --files-without-match`. */
function requireFindings(rule: ConstraintRule, pattern: string, stdout: string): ReturnType<typeof createFinding>[] {
    const findings: ReturnType<typeof createFinding>[] = [];
    for (const line of stdout.split('\n')) {
        const file = line.trim();
        if (file.length === 0) continue;
        findings.push(createFinding(rule, `required pattern not found: ${pattern}`, file, { code: 'rg:missing' }));
    }
    return findings;
}

/** Minimal shape of a `rg --json` event (only the fields this evaluator reads). */
interface RipgrepEvent {
    type: string;
    data?: {
        path?: { text?: string };
        line_number?: number;
    };
}

/** JS-`RegExp`-only constructs that ripgrep's Rust regex engine does not support. */
const JS_ONLY_REGEX_FEATURES: { readonly name: string; readonly test: RegExp }[] = [
    { name: 'lookbehind', test: /\(\?<[=!]/ },
    { name: 'backreference', test: /\\[1-9]/ },
    { name: 'named backreference', test: /\\k<[^>]+>/ },
];

/**
 * Report whether a regex `pattern` is safe to run under ripgrep's engine.
 *
 * ripgrep's Rust `regex` crate is linear-time and therefore omits features that require
 * backtracking — lookbehind and backreferences. A pattern using them works under the JS
 * `regex` evaluator but fails to compile under `rg`. The `rg-dialect` spur rule and the
 * downstream rule-file converter use this to keep incompatible patterns on the `regex`
 * type instead of silently breaking them on `rg`.
 *
 * @returns `{ compatible: true }` or `{ compatible: false, feature }` naming the first
 *   unsupported construct found.
 */
export function isRipgrepCompatiblePattern(
    pattern: string,
): { compatible: true } | { compatible: false; feature: string } {
    for (const { name, test } of JS_ONLY_REGEX_FEATURES) {
        if (test.test(pattern)) return { compatible: false, feature: name };
    }
    return { compatible: true };
}
