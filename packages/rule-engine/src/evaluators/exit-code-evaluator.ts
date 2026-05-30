import { NodeProcessExecutor, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';

/** Evaluates a rule by running a subprocess and checking its exit code. */
export class ExitCodeEvaluator implements RuleEvaluator {
    constructor(private readonly executor: ProcessExecutor = new NodeProcessExecutor()) {}

    /** Run configured command and emit a finding on non-zero exit. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const command = stringConfig(config, 'command');
        const args = arrayConfig(config, 'args', []);
        const result = await this.executor.run({ command, args, cwd: context.workdir, rejectOnError: false });
        if (result.exitCode === 0) return { findings: [], fixes: [] };
        return {
            findings: [
                createFinding(rule, `Command failed: ${command} ${args.join(' ')}`.trim(), null, {
                    code: 'exit-code:failed',
                }),
            ],
            fixes: [],
        };
    }
}

function stringConfig(config: Record<string, unknown>, key: string): string {
    const value = config[key];
    if (typeof value === 'string') return value;
    throw new Error(`exit-code evaluator requires string config "${key}"`);
}

function arrayConfig(config: Record<string, unknown>, key: string, fallback: string[]): string[] {
    const value = config[key];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
    return fallback;
}
