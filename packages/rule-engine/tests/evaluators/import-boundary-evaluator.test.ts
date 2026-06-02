import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImportBoundaryEvaluator } from '../../src/evaluators/import-boundary-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

function makeRule(config: Record<string, unknown>): ConstraintRule {
    return {
        id: 'import-boundary-test',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'import-boundary', config },
    };
}

function makeContext(workdir: string, rule: ConstraintRule): RuleContext {
    return { workdir, rule };
}

async function withTmpDir(cb: (dir: string) => Promise<void>): Promise<void> {
    const dir = join('/tmp', `import-boundary-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
        await cb(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('ImportBoundaryEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new ImportBoundaryEvaluator();
        expect(evaluator).toBeInstanceOf(ImportBoundaryEvaluator);
    });

    test('throws when boundaries config is missing', async () => {
        const evaluator = new ImportBoundaryEvaluator();
        const rule = makeRule({});
        await expect(evaluator.evaluate(rule, makeContext('/tmp', rule))).rejects.toThrow(
            'import-boundary evaluator requires non-empty array config "boundaries"',
        );
    });

    test('throws when boundaries is an empty array', async () => {
        const evaluator = new ImportBoundaryEvaluator();
        const rule = makeRule({ boundaries: [] });
        await expect(evaluator.evaluate(rule, makeContext('/tmp', rule))).rejects.toThrow(
            'import-boundary evaluator requires non-empty array config "boundaries"',
        );
    });

    test('throws actionable errors for malformed boundary declarations', async () => {
        const evaluator = new ImportBoundaryEvaluator();
        const missingScope = makeRule({ boundaries: [{ forbidden: ['@internal/db'] }] });
        await expect(evaluator.evaluate(missingScope, makeContext('/tmp', missingScope))).rejects.toThrow(
            'boundaries[0].scope',
        );

        const missingForbidden = makeRule({ boundaries: [{ scope: 'src/**/*.ts' }] });
        await expect(evaluator.evaluate(missingForbidden, makeContext('/tmp', missingForbidden))).rejects.toThrow(
            'boundaries[0].forbidden',
        );

        const badMode = makeRule({
            boundaries: [{ scope: 'src/**/*.ts', forbidden: [{ pattern: 'legacy-api', mode: 'invalid' }] }],
        });
        await expect(evaluator.evaluate(badMode, makeContext('/tmp', badMode))).rejects.toThrow(
            'boundaries[0].forbidden[0].mode',
        );
    });

    test('returns no findings for empty directory', async () => {
        await withTmpDir(async (dir) => {
            mkdirSync(join(dir, 'src'), { recursive: true });
            const evaluator = new ImportBoundaryEvaluator();
            const rule = makeRule({
                boundaries: [{ scope: 'apps/**/*.ts', forbidden: ['@internal/db'] }],
            });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toEqual([]);
            expect(result.fixes).toEqual([]);
        });
    });

    test('detects forbidden string import specifier in scope', async () => {
        await withTmpDir(async (dir) => {
            mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true });
            writeFileSync(join(dir, 'apps', 'cli', 'src', 'index.ts'), "import { db } from '@internal/db';\n");
            const evaluator = new ImportBoundaryEvaluator();
            const rule = makeRule({
                boundaries: [{ scope: 'apps/**/*.ts', forbidden: ['@internal/db'] }],
            });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.filePath).toBe('apps/cli/src/index.ts');
            expect(result.findings[0]?.line).toBe(1);
            expect(result.findings[0]?.code).toBe('import-boundary:violation');
            expect(result.findings[0]?.message).toContain('apps/**/*.ts');
            expect(result.findings[0]?.severity).toBe('error');
        });
    });

    test('does not flag files outside scope', async () => {
        await withTmpDir(async (dir) => {
            mkdirSync(join(dir, 'packages', 'domain', 'src'), { recursive: true });
            // This file is NOT inside 'apps/**' scope.
            writeFileSync(join(dir, 'packages', 'domain', 'src', 'a.ts'), "import { db } from '@internal/db';\n");
            const evaluator = new ImportBoundaryEvaluator();
            const rule = makeRule({
                boundaries: [{ scope: 'apps/**/*.ts', forbidden: ['@internal/db'] }],
            });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toEqual([]);
        });
    });

    test('exclude globs within boundary suppress findings', async () => {
        await withTmpDir(async (dir) => {
            mkdirSync(join(dir, 'apps', 'cli', 'src'), { recursive: true });
            mkdirSync(join(dir, 'apps', 'cli', 'tests'), { recursive: true });
            writeFileSync(join(dir, 'apps', 'cli', 'src', 'index.ts'), "import { db } from '@internal/db';\n");
            // Test file should be excluded.
            writeFileSync(join(dir, 'apps', 'cli', 'tests', 'index.test.ts'), "import { db } from '@internal/db';\n");
            const evaluator = new ImportBoundaryEvaluator();
            const rule = makeRule({
                boundaries: [
                    {
                        scope: 'apps/**/*.ts',
                        forbidden: ['@internal/db'],
                        exclude: ['apps/**/tests/**'],
                    },
                ],
            });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.filePath).toBe('apps/cli/src/index.ts');
        });
    });

    test('object forbidden entry with pattern matches via regex', async () => {
        await withTmpDir(async (dir) => {
            mkdirSync(join(dir, 'src'), { recursive: true });
            writeFileSync(join(dir, 'src', 'a.ts'), "import something from '@scope/pkg-v2';\n");
            const evaluator = new ImportBoundaryEvaluator();
            const rule = makeRule({
                boundaries: [
                    {
                        scope: 'src/**/*.ts',
                        forbidden: [{ pattern: '@scope/pkg-v2' }],
                    },
                ],
            });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.code).toBe('import-boundary:violation');
        });
    });

    test('usage mode matches any line, not just imports', async () => {
        await withTmpDir(async (dir) => {
            mkdirSync(join(dir, 'src'), { recursive: true });
            writeFileSync(join(dir, 'src', 'b.ts'), 'const x = someFunc(); // calls legacy-api\nconst y = 1;\n');
            const evaluator = new ImportBoundaryEvaluator();
            const rule = makeRule({
                boundaries: [
                    {
                        scope: 'src/**/*.ts',
                        forbidden: [{ pattern: 'legacy-api', mode: 'usage' }],
                    },
                ],
            });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.line).toBe(1);
        });
    });

    test('emits one finding per matching line across multiple files', async () => {
        await withTmpDir(async (dir) => {
            mkdirSync(join(dir, 'apps', 'a', 'src'), { recursive: true });
            mkdirSync(join(dir, 'apps', 'b', 'src'), { recursive: true });
            writeFileSync(join(dir, 'apps', 'a', 'src', 'x.ts'), "import { foo } from 'forbidden-pkg';\n");
            writeFileSync(join(dir, 'apps', 'b', 'src', 'y.ts'), "import { bar } from 'forbidden-pkg';\n");
            const evaluator = new ImportBoundaryEvaluator();
            const rule = makeRule({
                boundaries: [{ scope: 'apps/**/*.ts', forbidden: ['forbidden-pkg'] }],
            });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(2);
            const paths = result.findings.map((f) => f.filePath).sort();
            expect(paths).toEqual(['apps/a/src/x.ts', 'apps/b/src/y.ts']);
        });
    });
});
