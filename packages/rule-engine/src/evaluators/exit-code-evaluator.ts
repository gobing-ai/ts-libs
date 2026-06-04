import { NodeProcessExecutor, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { configArray, configNumber, configString } from './file-utils';

/** Evaluates a rule by running a subprocess and checking its exit code. */
export class ExitCodeEvaluator implements RuleEvaluator {
    constructor(private readonly executor: ProcessExecutor = new NodeProcessExecutor()) {}

    /** Run configured command and emit a finding unless the exit code matches `successCode`. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const command = configString(config, 'command', undefined, { evaluator: 'exit-code' });
        const args = configArray(config, 'args', []);
        const successCode = configNumber(config, 'successCode', 0);
        const timeout = configNumber(config, 'timeout', 60_000);
        const result = await this.executor.run({
            command,
            args,
            cwd: context.workdir,
            timeout,
            rejectOnError: false,
            label: 'exit-code',
        });
        if (result.exitCode === successCode) return { findings: [], fixes: [] };

        const template = configString(
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
