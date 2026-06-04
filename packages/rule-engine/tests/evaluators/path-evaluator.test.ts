import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathEvaluator } from '../../src/evaluators/path-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

function makeRule(config: Record<string, unknown>, overrides: Partial<ConstraintRule> = {}): ConstraintRule {
    return {
        id: 'test-rule',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'path', config },
        ...overrides,
    };
}

function makeContext(workdir = '/tmp'): RuleContext {
    return { workdir, rule: makeRule({ paths: ['package.json'] }) };
}

async function tempProject(files: Record<string, string>): Promise<string> {
    const dir = join(
        tmpdir(),
        'ts-libs-rule-engine-path-evaluator',
        `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, content);
    }
    return dir;
}

describe('PathEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new PathEvaluator();
        expect(evaluator).toBeInstanceOf(PathEvaluator);
    });

    test('throws when paths config is missing', async () => {
        const evaluator = new PathEvaluator();
        const rule = makeRule({});
        const ctx = { ...makeContext(), rule };
        await expect(evaluator.evaluate(rule, ctx)).rejects.toThrow('path evaluator requires string[] config "paths"');
    });

    test('accepts single string as paths config', async () => {
        const evaluator = new PathEvaluator();
        const nonexistentDir = `/tmp/nonexistent-${Date.now()}`;
        const rule = makeRule({ paths: 'readme.md' });
        const ctx: RuleContext = { workdir: nonexistentDir, rule };
        const result = await evaluator.evaluate(rule, ctx);
        expect(result.findings.length).toBeGreaterThanOrEqual(1);
        expect(result.findings[0]?.code).toBe('path:missing');
    });

    test('accepts string array paths and reports forbidden existing paths', async () => {
        const dir = await tempProject({ 'src/forbidden.ts': 'export const x = 1;\n' });
        const evaluator = new PathEvaluator();
        const rule = makeRule({ paths: ['src/forbidden.ts'], mode: 'forbid' });
        const result = await evaluator.evaluate(rule, { workdir: dir, rule });

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.code).toBe('path:forbidden');
    });

    test('glob absent honors exclude patterns', async () => {
        const dir = await tempProject({
            'src/blocked.ts': '',
            'src/allowed.ts': '',
        });
        const evaluator = new PathEvaluator();
        const rule = makeRule({ must: 'absent' }, { include: ['src/**/*.ts'], exclude: ['src/allowed.ts'] });
        const result = await evaluator.evaluate(rule, { workdir: dir, rule });

        expect(result.findings.map((finding) => finding.filePath)).toEqual(['src/blocked.ts']);
    });
});
