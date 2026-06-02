import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPresetRules } from '../../src/config/loader';
import { ExitCodeEvaluator } from '../../src/evaluators/exit-code-evaluator';
import { PathEvaluator } from '../../src/evaluators/path-evaluator';
import { RegexEvaluator } from '../../src/evaluators/regex-evaluator';
import type { ConstraintRule } from '../../src/types';

async function tempProject(files: Record<string, string> = {}): Promise<string> {
    const dir = join(
        tmpdir(),
        'ts-libs-rule-engine-parity',
        `parity-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, content);
    }
    await mkdir(dir, { recursive: true });
    return dir;
}

function rule(evaluator: ConstraintRule['evaluator'], overrides: Partial<ConstraintRule> = {}): ConstraintRule {
    return { id: 'r', description: 'd', enabled: true, severity: 'error', evaluator, ...overrides };
}

class FakeExecutor {
    constructor(private readonly exitCode: number) {}
    async run() {
        return { command: '', args: [], exitCode: this.exitCode, stdout: '', stderr: '', durationMs: 1 };
    }
}

describe('path evaluator — glob (must) form', () => {
    test('must:present flags an include glob with no matching files', async () => {
        const dir = await tempProject({ 'src/a.ts': '' });
        const r = rule({ type: 'path', config: { must: 'present' } }, { include: ['src/**/*.missing'] });
        const result = await new PathEvaluator().evaluate(r, { workdir: dir, rule: r });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.code).toBe('path:missing');
    });

    test('must:absent flags in-scope files that exist', async () => {
        const dir = await tempProject({ 'src/forbidden.ts': '' });
        const r = rule({ type: 'path', config: { must: 'absent' } }, { include: ['src/**/*.ts'] });
        const result = await new PathEvaluator().evaluate(r, { workdir: dir, rule: r });
        expect(result.findings.map((f) => f.filePath)).toEqual(['src/forbidden.ts']);
    });
});

describe('exit-code evaluator — successCode + message template', () => {
    test('successCode treats a non-zero exit as success', async () => {
        const r = rule({ type: 'exit-code', config: { command: 'x', successCode: 1 } });
        const ev = new ExitCodeEvaluator(new FakeExecutor(1) as never);
        expect((await ev.evaluate(r, { workdir: '/tmp', rule: r })).findings).toEqual([]);
    });

    test('message template interpolates {code}', async () => {
        const r = rule({ type: 'exit-code', config: { command: 'x', message: 'failed with {code}' } });
        const ev = new ExitCodeEvaluator(new FakeExecutor(3) as never);
        const result = await ev.evaluate(r, { workdir: '/tmp', rule: r });
        expect(result.findings[0]?.message).toBe('failed with 3');
    });
});

describe('regex evaluator — inline flags + multiline', () => {
    test('honors a leading (?i) inline flag group', async () => {
        const dir = await tempProject({ 'a.ts': 'const X = 1;\n' });
        const r = rule({ type: 'regex', config: { pattern: '(?i)const x' } }, { include: ['a.ts'] });
        const result = await new RegexEvaluator().evaluate(r, { workdir: dir, rule: r });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.line).toBe(1);
    });

    test('multiline enables dotAll so . spans newlines', async () => {
        const dir = await tempProject({ 'a.ts': 'start\nmiddle\nend\n' });
        const r = rule(
            { type: 'regex', config: { pattern: 'start.*end', multiline: true, mode: 'require' } },
            { include: ['a.ts'] },
        );
        const result = await new RegexEvaluator().evaluate(r, { workdir: dir, rule: r });
        expect(result.findings).toEqual([]); // pattern present → require satisfied
    });
});

describe('loader — file-level exclude merge', () => {
    test('unions file-level and rule-level excludes', async () => {
        const dir = await tempProject();
        await mkdir(join(dir, '.spur', 'rules', 'quality'), { recursive: true });
        await writeFile(join(dir, '.spur', 'rules', 'recommended.yaml'), 'name: recommended\nextends:\n  - quality\n');
        await writeFile(
            join(dir, '.spur', 'rules', 'quality', 'r.yaml'),
            [
                'exclude: ["**/file-level/**"]',
                'rules:',
                '  - id: x',
                '    description: d',
                '    exclude: ["**/rule-level/**"]',
                '    evaluator: { type: path, config: { paths: ["p"] } }',
            ].join('\n'),
        );
        const rules = await loadPresetRules('recommended', { roots: [join(dir, '.spur', 'rules')] });
        expect(rules[0]?.exclude).toEqual(['**/file-level/**', '**/rule-level/**']);
    });
});

describe('loader — preset cycle detection', () => {
    test('throws on a circular preset extends chain', async () => {
        const dir = await tempProject();
        const root = join(dir, '.spur', 'rules');
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'a.yaml'), 'name: a\nextends:\n  - b\n');
        await writeFile(join(root, 'b.yaml'), 'name: b\nextends:\n  - a\n');
        await expect(loadPresetRules('a', { roots: [root] })).rejects.toThrow('Circular preset dependency');
    });
});
