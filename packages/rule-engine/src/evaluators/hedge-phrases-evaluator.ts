import {
    type ConstraintFinding,
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { stringArray } from './config-access';
import { scanFiles } from './file-discovery';

/** Evaluator config shape extracted from `rule.evaluator.config`. */
interface HedgePhrasesConfig {
    phrases?: unknown;
    caseSensitive?: unknown;
    wholeWord?: unknown;
}

/**
 * Flags uncertainty / hedge phrasing in the files a rule scopes in: a claim that
 * hedges ("it may", "presumably") states no verifiable fact, so it reads as evidence
 * while pinning nothing.
 *
 * Config (`evaluator.config`):
 * - `phrases`: non-empty list of literal phrases to flag (required; a phrase is text,
 *   never a pattern)
 * - `caseSensitive`: default `false` — "It May" is the same hedge as "it may"
 * - `wholeWord`: default `true` — `it may` does not match inside `it maybe`
 *
 * One finding per file per phrase, carrying the first matching line, with the message
 * `uncertainty phrases detected: <phrase>`. Scope comes from the rule's `include` /
 * `exclude` (anchored globs), so the plane is the rule author's choice rather than a
 * built-in assumption.
 */
export class HedgePhrasesEvaluator implements RuleEvaluator {
    /**
     * No collaborators: scope and filesystem come from the rule and the context. Explicit rather
     * than implicit because Bun's coverage counts an implicit class constructor as uncovered, which
     * would keep this file under the per-file function threshold for no real gap.
     */
    constructor() {}

    /** Scan the scoped files for each configured phrase. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = (rule.evaluator.config ?? {}) as HedgePhrasesConfig;
        const phrases = stringArray(config.phrases) ?? [];
        if (phrases.length === 0) {
            throw new Error('hedge-phrases evaluator requires a non-empty "phrases" config');
        }
        const caseSensitive = config.caseSensitive === true;
        const wholeWord = config.wholeWord !== false;
        const matchers = phrases.map((phrase) => ({ phrase, pattern: toPattern(phrase, caseSensitive, wholeWord) }));
        const files = await scanFiles({
            workdir: context.workdir,
            include: rule.include,
            exclude: rule.exclude,
            matchMode: 'glob',
            ...(context.fileSystem !== undefined ? { fs: context.fileSystem } : {}),
        });

        const findings: ConstraintFinding[] = [];
        for (const { file, content } of files) {
            const lines = content.split('\n');
            for (const { phrase, pattern } of matchers) {
                const index = lines.findIndex((line) => pattern.test(line));
                if (index < 0) continue;
                findings.push(
                    createFinding(rule, `uncertainty phrases detected: ${phrase}`, file, {
                        line: index + 1,
                        code: 'hedge-phrases:matched',
                    }),
                );
            }
        }
        return { findings, fixes: [] };
    }
}

/**
 * Compile one phrase as literal text, optionally whole-word and case-insensitive. The
 * word boundary is applied only at an edge that is a word character, so a phrase like
 * `(b) may?` still matches — a trailing `\\b` after `?` could never be satisfied.
 */
function toPattern(phrase: string, caseSensitive: boolean, wholeWord: boolean): RegExp {
    const body = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lead = wholeWord && /^\w/.test(body) ? '\\b' : '';
    const tail = wholeWord && /\w$/.test(body) ? '\\b' : '';
    return new RegExp(`${lead}${body}${tail}`, caseSensitive ? 'u' : 'iu');
}
