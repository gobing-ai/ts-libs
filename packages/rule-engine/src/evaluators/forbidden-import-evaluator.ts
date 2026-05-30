import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { discoverFiles, readWorkdirFile } from './file-utils';

/** Detects imports matching forbidden package or path prefixes. */
export class ForbiddenImportEvaluator implements RuleEvaluator {
    constructor() {}

    /** Evaluate import declarations against configured forbidden prefixes. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
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
                const imported = /(?:from\s+|import\s*\(|^\s*import\s*)['"](?<specifier>[^'"]+)['"]/.exec(line)?.groups
                    ?.specifier;
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
}

function arrayConfig(config: Record<string, unknown>, key: string): string[] {
    const value = config[key];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
    if (typeof value === 'string') return [value];
    throw new Error(`forbidden-import evaluator requires string[] config "${key}"`);
}
