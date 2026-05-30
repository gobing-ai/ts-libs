import { resolve } from 'node:path';
import { NodeFileSystem } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';

/** Evaluates file or directory existence constraints. */
export class PathEvaluator implements RuleEvaluator {
    private readonly fs: NodeFileSystem;

    constructor() {
        this.fs = new NodeFileSystem();
    }

    /** Evaluate required or forbidden paths. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const paths = arrayConfig(config, 'paths');
        const mode = stringConfig(config, 'mode', 'require');
        const findings = [];
        for (const path of paths) {
            const exists = await this.fs.exists(resolve(context.workdir, path));
            if (mode === 'forbid' && exists) {
                findings.push(createFinding(rule, `Forbidden path exists: ${path}`, path, { code: 'path:forbidden' }));
            }
            if (mode !== 'forbid' && !exists) {
                findings.push(createFinding(rule, `Required path missing: ${path}`, path, { code: 'path:missing' }));
            }
        }
        return { findings, fixes: [] };
    }
}

function arrayConfig(config: Record<string, unknown>, key: string): string[] {
    const value = config[key];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
    if (typeof value === 'string') return [value];
    throw new Error(`path evaluator requires string[] config "${key}"`);
}

function stringConfig(config: Record<string, unknown>, key: string, fallback: string): string {
    const value = config[key];
    return typeof value === 'string' ? value : fallback;
}
