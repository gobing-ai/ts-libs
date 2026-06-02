import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestLocationEvaluator } from '../../src/evaluators/test-location-evaluator';
import type { ConstraintRule } from '../../src/types';

function makeRule(config: Record<string, unknown>, overrides: Partial<ConstraintRule> = {}): ConstraintRule {
    return {
        id: 'test-location',
        description: 'test location',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'test-location', config },
        ...overrides,
    };
}

async function tempProject(files: Record<string, string>): Promise<string> {
    const dir = join(
        tmpdir(),
        'ts-libs-rule-engine-test-location',
        `tloc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, content);
    }
    return dir;
}

describe('TestLocationEvaluator', () => {
    test('throws when expected is missing', async () => {
        const dir = await tempProject({ 'a.ts': '' });
        const rule = makeRule({});
        await expect(new TestLocationEvaluator().evaluate(rule, { workdir: dir, rule })).rejects.toThrow(
            'requires a non-empty "expected"',
        );
    });

    test('flags tests in forbidden locations', async () => {
        const dir = await tempProject({
            'packages/x/src/__tests__/a.test.ts': '',
            'packages/x/tests/b.test.ts': '',
        });
        const rule = makeRule(
            { expected: '**/tests/**/*.test.ts', forbid: ['**/__tests__/**'] },
            { include: ['**/*.test.ts'] },
        );
        const result = await new TestLocationEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.code).toBe('test-location:forbidden');
        expect(result.findings[0]?.filePath).toBe('packages/x/src/__tests__/a.test.ts');
    });

    test('requireCorrespondingTest flags source files without a test', async () => {
        const dir = await tempProject({
            'packages/x/src/a.ts': 'export const a = 1;\n',
            'packages/x/src/b.ts': 'export const b = 1;\n',
            'packages/x/tests/a.test.ts': '',
        });
        const rule = makeRule(
            { expected: '**/*.test.*', requireCorrespondingTest: true },
            { include: ['packages/**/src/**/*.ts'] },
        );
        const result = await new TestLocationEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings.map((f) => f.filePath)).toEqual(['packages/x/src/b.ts']);
        expect(result.findings[0]?.message).toContain('packages/x/tests/b.test.ts');
    });

    test('flags test files in unexpected (non-matching expected) locations', async () => {
        const dir = await tempProject({
            'packages/x/src/some.test.ts': '',
            'packages/x/tests/b.test.ts': '',
        });
        const rule = makeRule({ expected: '**/tests/**/*.test.ts' }, { include: ['**/*.test.ts'] });
        const result = await new TestLocationEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.code).toBe('test-location:unexpected');
        expect(result.findings[0]?.filePath).toBe('packages/x/src/some.test.ts');
    });

    test('exclude patterns filter test files from location checks', async () => {
        const dir = await tempProject({
            'packages/x/tests/a.test.ts': '',
            'packages/x/tests/b.test.ts': '',
        });
        const rule = makeRule(
            { expected: '**/tests/**/*.test.ts' },
            { include: ['**/*.test.ts'], exclude: ['packages/x/tests/b.test.ts'] },
        );
        const result = await new TestLocationEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(0);
    });

    test('requireCorrespondingTest handles source files without /src/ prefix', async () => {
        const dir = await tempProject({
            'apps/cli/foo.ts': 'export const x = 1;\n',
            'tests/apps/cli/foo.test.ts': '',
        });
        const rule = makeRule(
            { expected: '**/*.test.*', requireCorrespondingTest: true },
            { include: ['apps/**/*.ts'] },
        );
        const result = await new TestLocationEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(0);
    });

    test('requireCorrespondingTest skips source files that are already test files', async () => {
        const dir = await tempProject({
            'packages/x/src/a.ts': 'export const a = 1;\n',
            'packages/x/tests/a.test.ts': '',
        });
        const rule = makeRule(
            { expected: '**/*.test.*', requireCorrespondingTest: true },
            { include: ['packages/**/*.ts'] },
        );
        const result = await new TestLocationEvaluator().evaluate(rule, { workdir: dir, rule });
        // a.ts has a.test.ts → no finding; a.test.ts is a test file → resolveTestPath returns itself → skipped
        expect(result.findings).toHaveLength(0);
    });

    test('requireCorrespondingTest respects exclude patterns for source files', async () => {
        const dir = await tempProject({
            'packages/x/vendor/lib.ts': 'export const v = 1;\n',
        });
        const rule = makeRule(
            { expected: '**/*.test.*', requireCorrespondingTest: true },
            { include: ['packages/**/*.ts'], exclude: ['**/vendor/**'] },
        );
        const result = await new TestLocationEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(0);
    });
});
