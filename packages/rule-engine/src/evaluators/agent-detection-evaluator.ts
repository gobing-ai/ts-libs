import { AgentDetector, type AgentName, isAgentName } from '@gobing-ai/ts-ai-runner';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { configArray } from './file-utils';

/** Evaluates local availability of configured coding agents. */
export class AgentDetectionEvaluator implements RuleEvaluator {
    constructor(private readonly detector = new AgentDetector()) {}

    /** Probe required agents and emit findings for missing CLIs. */
    async evaluate(rule: ConstraintRule, _context: RuleContext): Promise<RuleEvaluationResult> {
        const agents = configArray(rule.evaluator.config ?? {}, 'agents', undefined, { evaluator: 'agent-detection' });
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
