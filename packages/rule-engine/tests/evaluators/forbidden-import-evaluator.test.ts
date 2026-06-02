import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

    test('structured config: flags forbidden specifiers and honors scope', async () => {
        const dir = join('/tmp', `rule-engine-structured-${Date.now()}`);
        mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true });
        mkdirSync(join(dir, 'packages', 'domain', 'src'), { recursive: true });
        try {
            // In scope → flagged.
            writeFileSync(join(dir, 'apps', 'cli', 'src', 'a.ts'), "import { x } from '@gobing-ai/ts-db';\n");
            // Out of scope (domain) → ignored.
            writeFileSync(join(dir, 'packages', 'domain', 'src', 'b.ts'), "import { y } from '@gobing-ai/ts-db';\n");
            const rule = makeRule({
                forbidden: [{ specifier: '@gobing-ai/ts-db' }, { specifier: '@gobing-ai/ts-db/schema' }],
                scope: { include: ['apps/**/src/**/*.ts'], exclude: ['**/tests/**'] },
            });
            const result = await new ForbiddenImportEvaluator().evaluate(rule, { workdir: dir, rule });
            expect(result.findings.map((f) => f.filePath)).toEqual(['apps/cli/src/a.ts']);
            expect(result.findings[0]?.message).toContain('@gobing-ai/ts-db');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('structured config: raw pattern entries match line text', async () => {
        const dir = join('/tmp', `rule-engine-pattern-${Date.now()}`);
        mkdirSync(join(dir, 'src'), { recursive: true });
        try {
            writeFileSync(join(dir, 'src', 'a.ts'), "const sql = 'SELECT * FROM users';\n");
            const rule = makeRule({
                forbidden: [{ pattern: 'SELECT ', matchMode: 'usage' }],
                scope: { include: ['src/**/*.ts'] },
            });
            const result = await new ForbiddenImportEvaluator().evaluate(rule, { workdir: dir, rule });
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.message).toContain('SELECT');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('structured config: throws when scope.include is missing', async () => {
        const rule = makeRule({ forbidden: [{ specifier: 'x' }] });
        await expect(new ForbiddenImportEvaluator().evaluate(rule, { workdir: '/tmp', rule })).rejects.toThrow(
            'requires string[] config "scope.include"',
        );
    });
});
