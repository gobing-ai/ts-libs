import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SecretsScannerEvaluator } from '../../src/evaluators/secrets-scanner-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

function makeRule(): ConstraintRule {
    return {
        id: 'test-rule',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'secrets-scanner' },
    };
}

function makeContext(workdir = '/tmp'): RuleContext {
    return { workdir, rule: makeRule() };
}

describe('SecretsScannerEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new SecretsScannerEvaluator();
        expect(evaluator).toBeInstanceOf(SecretsScannerEvaluator);
    });

    test('returns empty findings for empty directory', async () => {
        const evaluator = new SecretsScannerEvaluator();
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
