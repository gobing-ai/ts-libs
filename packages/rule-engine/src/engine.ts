import type { ProcessExecutor } from '@gobing-ai/ts-runtime';
import { registerBuiltins } from './host/builtins';
import { RuleEngineHost } from './host/rule-engine-host';
import type { ConstraintFinding, ConstraintRule, RuleEngineResult, RuleEvaluator } from './types';
import { createFinding } from './types';

/** Options for constructing a RuleEngine. */
export interface RuleEngineOptions {
    /** Optional executor supplied to process-backed evaluators. */
    processExecutor?: ProcessExecutor;
    /** Optional preconfigured host. */
    host?: RuleEngineHost;
}

/** Orchestrates enabled constraint rules through a typed evaluator host. */
export class RuleEngine {
    /** Capability host used by this engine. */
    readonly host: RuleEngineHost;

    constructor(options: RuleEngineOptions = {}) {
        this.host = options.host ?? new RuleEngineHost();
        registerBuiltins(this.host, options.processExecutor);
    }

    /** Register or replace an evaluator. */
    registerEvaluator(type: string, evaluator: RuleEvaluator): void {
        this.host.evaluators.register(type, evaluator, 'extension');
    }

    /** Evaluate all enabled rules against a working directory. */
    async evaluate(rules: ConstraintRule[], workdir: string): Promise<RuleEngineResult> {
        const findings: ConstraintFinding[] = [];
        const fixes = [];
        for (const rule of rules) {
            if (rule.enabled === false) continue;
            try {
                const result = await this.host.evaluators.get(rule.evaluator.type).evaluate(rule, { rule, workdir });
                findings.push(...result.findings);
                fixes.push(...result.fixes);
            } catch (error) {
                findings.push(
                    createFinding(rule, error instanceof Error ? error.message : String(error), null, {
                        code: `evaluator:${rule.evaluator.type}`,
                    }),
                );
            }
        }
        return { findings, fixes };
    }
}
