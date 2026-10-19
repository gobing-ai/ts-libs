import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleEngine } from '../../src/engine';
import { HedgePhrasesEvaluator } from '../../src/evaluators/hedge-phrases-evaluator';
import type { ConstraintRule } from '../../src/types';

function makeRule(config: Record<string, unknown>, overrides: Partial<ConstraintRule> = {}): ConstraintRule {
    return {
        id: 'no-hedged-claims',
        description: 'no uncertainty phrases',
        enabled: true,
        severity: 'warning',
        evaluator: { type: 'hedge-phrases', config },
        include: ['docs/**/*.md'],
        ...overrides,
    };
}

async function tempProject(files: Record<string, string>): Promise<string> {
    const dir = join(
        tmpdir(),
        'ts-libs-rule-engine-hedge',
        `hedge-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, content);
    }
    return dir;
}

const evaluate = async (rule: ConstraintRule, dir: string) =>
    await new HedgePhrasesEvaluator().evaluate(rule, { workdir: dir, rule });

describe('HedgePhrasesEvaluator', () => {
    test('throws on a missing or empty phrase list', async () => {
        const dir = await tempProject({ 'docs/a.md': 'it may be stale\n' });
        for (const config of [{}, { phrases: [] }, { phrases: 'it may' }]) {
            await expect(evaluate(makeRule(config), dir)).rejects.toThrow('non-empty "phrases"');
        }
    });

    test('reports the phrase with the first matching line', async () => {
        const dir = await tempProject({
            'docs/a.md': ['# t', '', 'the cache is fine', 'it may be stale', 'and it may return early', ''].join('\n'),
        });
        const result = await evaluate(makeRule({ phrases: ['it may'] }), dir);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
            ruleId: 'no-hedged-claims',
            severity: 'warning',
            filePath: 'docs/a.md',
            line: 4,
            code: 'hedge-phrases:matched',
        });
        expect(result.findings[0]?.message).toBe('uncertainty phrases detected: it may');
    });

    test('matches whole words only by default', async () => {
        const dir = await tempProject({ 'docs/a.md': 'it maybe fine\n' });
        expect((await evaluate(makeRule({ phrases: ['it may'] }), dir)).findings).toHaveLength(0);
        const partial = await evaluate(makeRule({ phrases: ['it may'], wholeWord: false }), dir);
        expect(partial.findings).toHaveLength(1);
    });

    test('is case-insensitive unless caseSensitive is set', async () => {
        const dir = await tempProject({ 'docs/a.md': 'It May be stale\n' });
        expect((await evaluate(makeRule({ phrases: ['it may'] }), dir)).findings).toHaveLength(1);
        expect((await evaluate(makeRule({ phrases: ['it may'], caseSensitive: true }), dir)).findings).toHaveLength(0);
    });

    test('reports one finding per phrase, first occurrence only', async () => {
        const dir = await tempProject({
            'docs/a.md': 'it may be stale\nmight be fine\nit may be gone\n',
        });
        const result = await evaluate(makeRule({ phrases: ['it may', 'might'] }), dir);
        expect(result.findings.map((f) => [f.message, f.line])).toEqual([
            ['uncertainty phrases detected: it may', 1],
            ['uncertainty phrases detected: might', 2],
        ]);
    });

    test('honours the rule scope', async () => {
        const dir = await tempProject({
            'docs/a.md': 'it may be stale\n',
            'docs/skip/b.md': 'it may be stale\n',
            'src/c.ts': '// it may be stale\n',
        });
        const result = await evaluate(makeRule({ phrases: ['it may'] }, { exclude: ['docs/skip/**'] }), dir);
        expect(result.findings.map((f) => f.filePath)).toEqual(['docs/a.md']);
    });

    test('treats a phrase as literal text, not a pattern', async () => {
        const dir = await tempProject({ 'docs/a.md': 'a (b) may? c\n' });
        expect((await evaluate(makeRule({ phrases: ['(b) may?'] }), dir)).findings).toHaveLength(1);
        expect((await evaluate(makeRule({ phrases: ['b.*may'] }), dir)).findings).toHaveLength(0);
    });

    test('is silent when no phrase appears', async () => {
        const dir = await tempProject({ 'docs/a.md': 'the gate exited 0\n' });
        expect((await evaluate(makeRule({ phrases: ['it may'] }), dir)).findings).toEqual([]);
    });
});

describe('hedge-phrases through the engine', () => {
    test('the registered builtin reports the phrase the way a gate caller sees it', async () => {
        const dir = await tempProject({ 'docs/tasks/0100_x.md': '# t\n\nit may be stale\n' });
        const engine = new RuleEngine();
        const result = await engine.evaluate([makeRule({ phrases: ['it may'] })], dir);
        expect(result.findings).toEqual([
            {
                ruleId: 'no-hedged-claims',
                severity: 'warning',
                message: 'uncertainty phrases detected: it may',
                filePath: 'docs/tasks/0100_x.md',
                line: 3,
                code: 'hedge-phrases:matched',
            },
        ]);
    });
});
