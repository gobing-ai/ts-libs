import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenImportEvaluator } from '../../src/evaluators/forbidden-import-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

function makeRule(config: Record<string, unknown>): ConstraintRule {
    return {
        id: 'test-rule',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'forbidden-import', config },
    };
}

function makeContext(workdir = '/tmp'): RuleContext {
    return { workdir, rule: makeRule({ patterns: ['lodash'] }) };
}

describe('ForbiddenImportEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new ForbiddenImportEvaluator();
        expect(evaluator).toBeInstanceOf(ForbiddenImportEvaluator);
    });

    test('throws when patterns config is missing', async () => {
        const evaluator = new ForbiddenImportEvaluator();
        const rule = makeRule({});
        const ctx = { ...makeContext(), rule };
        await expect(evaluator.evaluate(rule, ctx)).rejects.toThrow(
            'forbidden-import evaluator requires string[] config "patterns"',
        );
    });

    test('returns empty findings for empty directory', async () => {
        const evaluator = new ForbiddenImportEvaluator();
        const tmpDir = join('/tmp', `rule-engine-test-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });
        try {
            const ctx = makeContext(tmpDir);
            const result = await evaluator.evaluate(ctx.rule, ctx);
            expect(result.findings).toEqual([]);
            expect(result.fixes).toEqual([]);
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
