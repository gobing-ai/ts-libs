import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { discoverFiles, readWorkdirFile } from './file-utils';

/** Evaluates whether source files match or avoid a regex pattern. */
export class RegexEvaluator implements RuleEvaluator {
    constructor() {}

    /** Evaluate regex-based presence or absence constraints. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const pattern = stringConfig(config, 'pattern');
        const mode = stringConfig(config, 'mode', 'forbid');
        const flags = stringConfig(config, 'flags', 'm');
        const regex = new RegExp(pattern, flags);
        const files = await discoverFiles({ workdir: context.workdir, include: rule.include, exclude: rule.exclude });
        const findings = [];

        for (const file of files) {
            const content = await readWorkdirFile(context.workdir, file);
            regex.lastIndex = 0;
            const match = regex.exec(content);
            if (mode === 'require' && match === null) {
                findings.push(
                    createFinding(rule, `Required pattern not found: ${pattern}`, file, { code: 'regex:missing' }),
                );
            }
            if (mode !== 'require' && match !== null) {
                findings.push(
                    createFinding(rule, `Forbidden pattern found: ${pattern}`, file, { code: 'regex:found' }),
                );
            }
        }

        return { findings, fixes: [] };
    }
}

function stringConfig(config: Record<string, unknown>, key: string, fallback?: string): string {
    const value = config[key];
    if (typeof value === 'string') return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`regex evaluator requires string config "${key}"`);
}
