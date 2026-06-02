import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { discoverFiles, readWorkdirFile } from './file-utils';

/**
 * Evaluates whether source files match or avoid a regex pattern.
 *
 * Trust assumption: rule config is trusted input. The `pattern` is compiled with
 * `new RegExp` and run per line without a backtracking bound, so a
 * catastrophic-backtracking pattern is the rule author's responsibility. Runtime
 * ReDoS hardening is deferred until rule packs are distributed across a wider trust
 * boundary (see task 0003).
 */
export class RegexEvaluator implements RuleEvaluator {
    // Explicit constructor: V8 function coverage counts only declared functions, so
    // this method-light class needs it to clear the coverage-gate function threshold.
    constructor() {}

    /** Evaluate regex-based presence or absence constraints. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const { pattern, flags } = normalizePattern(
            stringConfig(config, 'pattern'),
            stringConfig(config, 'flags', ''),
            config.multiline === true,
        );
        const mode = stringConfig(config, 'mode', 'forbid');
        const regex = new RegExp(pattern, flags);
        const files = await discoverFiles({ workdir: context.workdir, include: rule.include, exclude: rule.exclude });
        const findings = [];

        for (const file of files) {
            const content = await readWorkdirFile(context.workdir, file);
            if (mode === 'require') {
                regex.lastIndex = 0;
                if (!regex.test(content)) {
                    findings.push(
                        createFinding(rule, `required pattern not found: ${pattern}`, file, { code: 'regex:missing' }),
                    );
                }
                continue;
            }
            // forbid: report each matching line so findings carry precise locations.
            for (const [index, line] of content.split('\n').entries()) {
                regex.lastIndex = 0;
                if (regex.test(line)) {
                    findings.push(
                        createFinding(rule, `forbidden pattern found: ${pattern}`, file, {
                            line: index + 1,
                            code: 'regex:found',
                        }),
                    );
                }
            }
        }

        return { findings, fixes: [] };
    }
}

/**
 * Normalize a pattern + flags for JS `RegExp`.
 *
 * Accepts a leading `(?i)`/`(?im)` inline flag group (ripgrep/PCRE style) and
 * folds it into the JS flags. `multiline` adds the `s` (dotAll) flag so `.`
 * spans newlines, matching the old `--multiline` behavior. `m` is always set so
 * `^`/`$` work per line.
 */
function normalizePattern(
    rawPattern: string,
    rawFlags: string,
    multiline: boolean,
): { pattern: string; flags: string } {
    const flagSet = new Set<string>(['m']);
    for (const flag of rawFlags) {
        if ('gimsuy'.includes(flag)) flagSet.add(flag);
    }
    let pattern = rawPattern;
    const inline = /^\(\?([a-z]+)\)/.exec(pattern);
    if (inline) {
        for (const flag of inline[1] ?? '') {
            if ('imsu'.includes(flag)) flagSet.add(flag);
        }
        pattern = pattern.slice(inline[0].length);
    }
    if (multiline) flagSet.add('s');
    return { pattern, flags: [...flagSet].join('') };
}

function stringConfig(config: Record<string, unknown>, key: string, fallback?: string): string {
    const value = config[key];
    if (typeof value === 'string') return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`regex evaluator requires string config "${key}"`);
}
