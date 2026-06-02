import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoverageGateEvaluator } from '../../src/evaluators/coverage-gate-evaluator';
import type { ConstraintRule } from '../../src/types';

function makeRule(config: Record<string, unknown>): ConstraintRule {
    return {
        id: 'coverage-gate',
        description: 'coverage',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'coverage-gate', config },
    };
}

async function tempDir(): Promise<string> {
    const dir = join(
        tmpdir(),
        'ts-libs-rule-engine-coverage-gate',
        `cov-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
}

function lcov(records: { file: string; found: number; hit: number }[]): string {
    return records.map((r) => `SF:${r.file}\nLF:${r.found}\nLH:${r.hit}\nend_of_record`).join('\n');
}

describe('CoverageGateEvaluator', () => {
    test('reports a non-blocking finding when lcov is missing', async () => {
        const dir = await tempDir();
        const rule = makeRule({ lcovPath: '.coverage/lcov.info' });
        const result = await new CoverageGateEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.code).toBe('coverage:missing-lcov');
    });

    test('flags files below the threshold and passes files at or above it', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, '.coverage'), { recursive: true });
        await writeFile(
            join(dir, '.coverage', 'lcov.info'),
            lcov([
                { file: 'apps/cli/src/low.ts', found: 100, hit: 50 }, // 50% — below 90
                { file: 'apps/cli/src/high.ts', found: 100, hit: 95 }, // 95% — passes
                { file: 'apps/cli/src/empty.ts', found: 0, hit: 0 }, // skipped (no lines)
                { file: 'apps/cli/src/low.test.ts', found: 100, hit: 0 }, // skipped (test file)
            ]),
        );
        const rule = makeRule({ lcovPath: '.coverage/lcov.info', threshold: 90, include: ['apps/**'] });
        const result = await new CoverageGateEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings.map((f) => f.filePath)).toEqual(['apps/cli/src/low.ts']);
        expect(result.findings[0]?.message).toContain('50% line coverage');
    });

    test('honors per-file exemptions', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, '.coverage'), { recursive: true });
        await writeFile(
            join(dir, '.coverage', 'lcov.info'),
            lcov([{ file: 'packages/x/src/a.ts', found: 100, hit: 60 }]),
        );
        const rule = makeRule({
            lcovPath: '.coverage/lcov.info',
            threshold: 90,
            exemptions: [{ path: 'packages/x/src/a.ts', threshold: 50, reason: 'legacy' }],
        });
        const result = await new CoverageGateEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(0);
    });

    test('uses default lcovPath coverage/lcov.info when config omits lcovPath', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, 'coverage'), { recursive: true });
        await writeFile(join(dir, 'coverage', 'lcov.info'), lcov([{ file: 'src/foo.ts', found: 100, hit: 80 }]));
        const rule = makeRule({ threshold: 90, include: ['src/**'] });
        const result = await new CoverageGateEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.code).toBe('coverage:below-threshold');
    });

    test('exclude patterns scope out matching files', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, '.coverage'), { recursive: true });
        await writeFile(
            join(dir, '.coverage', 'lcov.info'),
            lcov([
                { file: 'src/keep.ts', found: 100, hit: 50 },
                { file: 'src/vendor/lib.ts', found: 100, hit: 50 },
            ]),
        );
        const rule = makeRule({
            lcovPath: '.coverage/lcov.info',
            threshold: 90,
            exclude: ['src/vendor/**'],
        });
        const result = await new CoverageGateEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.filePath).toBe('src/keep.ts');
    });

    test('flags files that fall below their exempted threshold with exemption message', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, '.coverage'), { recursive: true });
        await writeFile(
            join(dir, '.coverage', 'lcov.info'),
            lcov([{ file: 'packages/x/src/a.ts', found: 100, hit: 30 }]),
        );
        const rule = makeRule({
            lcovPath: '.coverage/lcov.info',
            threshold: 90,
            exemptions: [{ path: 'packages/x/src/a.ts', threshold: 50, reason: 'legacy' }],
        });
        const result = await new CoverageGateEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.message).toContain('exemption: 50%');
        expect(result.findings[0]?.message).toContain('reason: legacy');
    });

    test('excludes node_modules, .spec. files, and __tests__ paths by default', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, '.coverage'), { recursive: true });
        await writeFile(
            join(dir, '.coverage', 'lcov.info'),
            lcov([
                { file: 'node_modules/pkg/index.ts', found: 100, hit: 50 },
                { file: 'src/util.spec.ts', found: 100, hit: 50 },
                { file: 'src/__tests__/helper.ts', found: 100, hit: 50 },
            ]),
        );
        const rule = makeRule({ lcovPath: '.coverage/lcov.info', threshold: 90 });
        const result = await new CoverageGateEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(0);
    });

    test('relativizes absolute lcov source paths to workdir', async () => {
        const dir = await tempDir();
        await mkdir(join(dir, 'coverage'), { recursive: true });
        const absFile = join(dir, 'apps/cli/src/abs.ts');
        await writeFile(join(dir, 'coverage', 'lcov.info'), lcov([{ file: absFile, found: 100, hit: 50 }]));
        const rule = makeRule({ threshold: 90, include: ['apps/**'] });
        const result = await new CoverageGateEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.filePath).toBe('apps/cli/src/abs.ts');
    });
});
