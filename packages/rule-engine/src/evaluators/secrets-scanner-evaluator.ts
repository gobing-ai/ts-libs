import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { discoverFiles, readWorkdirFile } from './file-utils';

/** Scans text files for high-confidence secret-like tokens. */
export class SecretsScannerEvaluator implements RuleEvaluator {
    constructor() {}

    /** Evaluate source files against bundled secret patterns. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const files = await discoverFiles({ workdir: context.workdir, include: rule.include, exclude: rule.exclude });
        const findings = [];
        const secretPattern = /(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/;
        for (const file of files) {
            const lines = (await readWorkdirFile(context.workdir, file)).split('\n');
            for (const [index, line] of lines.entries()) {
                if (secretPattern.test(line)) {
                    findings.push(
                        createFinding(rule, 'Potential secret token found', file, {
                            line: index + 1,
                            code: 'secret:token',
                        }),
                    );
                }
            }
        }
        return { findings, fixes: [] };
    }
}
