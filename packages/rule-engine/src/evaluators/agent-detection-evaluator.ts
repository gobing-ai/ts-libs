import { AgentDetector, type AgentName, isAgentName } from '@gobing-ai/ts-ai-runner';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';

/** Evaluates local availability of configured coding agents. */
export class AgentDetectionEvaluator implements RuleEvaluator {
    constructor(private readonly detector = new AgentDetector()) {}

    /** Probe required agents and emit findings for missing CLIs. */
    async evaluate(rule: ConstraintRule, _context: RuleContext): Promise<RuleEvaluationResult> {
        const agents = arrayConfig(rule.evaluator.config ?? {}, 'agents');
        const findings = [];
        for (const agent of agents) {
            if (!isAgentName(agent)) {
                findings.push(createFinding(rule, `Unknown agent: ${agent}`, null, { code: 'agent:unknown' }));
                continue;
            }
            const detected = await this.detector.detectOne(agent as AgentName);
            if (!detected.installed) {
                findings.push(createFinding(rule, `Agent unavailable: ${agent}`, null, { code: 'agent:missing' }));
            }
        }
        return { findings, fixes: [] };
    }
}

function arrayConfig(config: Record<string, unknown>, key: string): string[] {
    const value = config[key];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
    if (typeof value === 'string') return [value];
    throw new Error(`agent-detection evaluator requires string[] config "${key}"`);
}
