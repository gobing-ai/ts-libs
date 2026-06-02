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

    /** Run configured command and emit a finding unless the exit code matches `successCode`. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const command = stringConfig(config, 'command');
        const args = arrayConfig(config, 'args', []);
        const successCode = numberConfig(config, 'successCode', 0);
        const timeout = numberConfig(config, 'timeout', 60_000);
        const result = await this.executor.run({
            command,
            args,
            cwd: context.workdir,
            timeout,
            rejectOnError: false,
            label: 'exit-code',
        });
        if (result.exitCode === successCode) return { findings: [], fixes: [] };

        const template = stringConfig(
            config,
            'message',
            `Command failed (exit {code}): ${command} ${args.join(' ')}`.trim(),
        );
        const message = template.replaceAll('{code}', String(result.exitCode));
        return {
            findings: [createFinding(rule, message, null, { code: 'exit-code:failed' })],
            fixes: [],
        };
    }
}

function numberConfig(config: Record<string, unknown>, key: string, fallback: number): number {
    const value = config[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringConfig(config: Record<string, unknown>, key: string, fallback?: string): string {
    const value = config[key];
    if (typeof value === 'string') return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`exit-code evaluator requires string config "${key}"`);
}

function arrayConfig(config: Record<string, unknown>, key: string, fallback: string[]): string[] {
    const value = config[key];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
    return fallback;
}
