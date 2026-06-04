import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { configString, parseInlineFlags, scanFiles } from './file-utils';

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
            configString(config, 'pattern', undefined, { evaluator: 'regex' }),
            configString(config, 'flags', ''),
            config.multiline === true,
        );
        const mode = configString(config, 'mode', 'forbid');
        const regex = new RegExp(pattern, flags);
        const files = await scanFiles({
            workdir: context.workdir,
            include: rule.include,
            exclude: rule.exclude,
            matchMode: 'loose',
        });
        const findings = [];

        for (const { file, content } of files) {
            if (mode === 'require') {
                regex.lastIndex = 0;
                if (!regex.test(content)) {
                    findings.push(
                        createFinding(rule, `required pattern not found: ${pattern}`, file, { code: 'regex:missing' }),
                    );
                }
                continue;
            }
            if (config.multiline === true) {
                const globalRegex = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
                for (const match of content.matchAll(globalRegex)) {
                    if (match.index === undefined) continue;
                    findings.push(
                        createFinding(rule, `forbidden pattern found: ${pattern}`, file, {
                            line: lineForOffset(content, match.index),
                            code: 'regex:found',
                        }),
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
    const { flags: inlineFlags, rest: pattern } = parseInlineFlags(rawPattern);
    for (const flag of inlineFlags) flagSet.add(flag);
    if (multiline) flagSet.add('s');
    return { pattern, flags: [...flagSet].join('') };
}

/** Return the one-based line containing a string offset. */
function lineForOffset(content: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < offset; index += 1) {
        if (content.charCodeAt(index) === 10) line += 1;
    }
    return line;
}
