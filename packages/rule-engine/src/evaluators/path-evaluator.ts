import { joinPath, NodeFileSystem } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { discoverFiles, matchesGlob } from './file-utils';

/**
 * Evaluates file/directory presence constraints.
 *
 * Two config shapes are supported:
 * - Glob form: `{ must: 'present' | 'absent' }` scoped by the rule's `include` /
 *   `exclude` globs. `present` flags each include glob that matches zero files;
 *   `absent` flags each in-scope file that exists.
 * - Explicit form: `{ paths: string[], mode?: 'require' | 'forbid' }` — checks the
 *   exact paths relative to the workdir (`require` = must exist, `forbid` = must not).
 */
export class PathEvaluator implements RuleEvaluator {
    private readonly fs: NodeFileSystem;

    constructor() {
        this.fs = new NodeFileSystem();
    }

    /** Evaluate required or forbidden paths in either config form. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const must = config.must;
        if (must === 'present' || must === 'absent') {
            return this.evaluateGlob(rule, context, must);
        }
        return this.evaluateExplicit(rule, context, config);
    }

    /** Glob form driven by `must` + the rule's include/exclude globs. */
    private async evaluateGlob(
        rule: ConstraintRule,
        context: RuleContext,
        must: 'present' | 'absent',
    ): Promise<RuleEvaluationResult> {
        const include = rule.include ?? ['**'];
        const exclude = rule.exclude ?? [];
        const files = await discoverFiles({ workdir: context.workdir });
        const inScope = (file: string) =>
            include.some((glob) => matchesGlob(file, glob)) && !exclude.some((glob) => matchesGlob(file, glob));
        const findings = [];

        if (must === 'present') {
            for (const pattern of include) {
                const present = files.some(
                    (file) => matchesGlob(file, pattern) && !exclude.some((g) => matchesGlob(file, g)),
                );
                if (!present) {
                    findings.push(
                        createFinding(rule, `expected files matching "${pattern}", but none found`, pattern, {
                            code: 'path:missing',
                        }),
                    );
                }
            }
        } else {
            for (const file of files) {
                if (inScope(file)) {
                    findings.push(
                        createFinding(rule, 'file should be absent (forbidden by rule)', file, {
                            code: 'path:forbidden',
                        }),
                    );
                }
            }
        }
        return { findings, fixes: [] };
    }

    /** Explicit form: exact `paths` checked with `mode` require/forbid. */
    private async evaluateExplicit(
        rule: ConstraintRule,
        context: RuleContext,
        config: Record<string, unknown>,
    ): Promise<RuleEvaluationResult> {
        const paths = arrayConfig(config, 'paths');
        const mode = stringConfig(config, 'mode', 'require');
        const findings = [];
        for (const path of paths) {
            const exists = await this.fs.exists(joinPath(context.workdir, path));
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
    throw new Error(`path evaluator requires config "${key}" (string[]) or "must" (present|absent)`);
}

function stringConfig(config: Record<string, unknown>, key: string, fallback: string): string {
    const value = config[key];
    return typeof value === 'string' ? value : fallback;
}
