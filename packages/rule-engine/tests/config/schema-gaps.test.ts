import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPresetRules, loadRuleFile } from '../../src/config/loader';
import { PresetDefinitionSchema } from '../../src/types';

async function tempRoot(files: Record<string, string>): Promise<string> {
    const root = join(await mkdtemp(join(tmpdir(), 'rule-gaps-')), 'rules');
    for (const [rel, content] of Object.entries(files)) {
        const full = join(root, rel);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, content);
    }
    return root;
}

describe('R1: severity inheritance', () => {
    test('a rule without severity inherits the file-level severity', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'sev-'));
        const file = join(dir, 'rules.yaml');
        await writeFile(
            file,
            [
                'severity: warning',
                'rules:',
                '  - id: inherits',
                '    description: d',
                '    evaluator: { type: path, config: { paths: ["x"] } }',
                '  - id: explicit',
                '    description: d',
                '    severity: error',
                '    evaluator: { type: path, config: { paths: ["x"] } }',
            ].join('\n'),
        );
        const rules = await loadRuleFile(file);
        expect(rules.find((r) => r.id === 'inherits')?.severity).toBe('warning');
        expect(rules.find((r) => r.id === 'explicit')?.severity).toBe('error');
    });

    test('falls back to error when neither rule nor file declares severity', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'sev2-'));
        const file = join(dir, 'rules.yaml');
        await writeFile(
            file,
            'rules:\n  - id: r\n    description: d\n    evaluator: { type: path, config: { paths: ["x"] } }\n',
        );
        expect((await loadRuleFile(file))[0]?.severity).toBe('error');
    });
});

describe('R3: rule de-duplication by id', () => {
    test('duplicate ids across category files collapse to one (last wins)', async () => {
        const root = await tempRoot({
            'p.yaml': 'name: p\nextends: [cat]\n',
            'cat/a.yaml':
                'rules:\n  - id: dup\n    description: first\n    evaluator: { type: path, config: { paths: ["x"] } }\n',
            'cat/b.yaml':
                'rules:\n  - id: dup\n    description: second\n    evaluator: { type: path, config: { paths: ["x"] } }\n',
        });
        const rules = await loadPresetRules('p', { roots: [root] });
        expect(rules).toHaveLength(1);
        expect(rules[0]?.description).toBe('second');
    });
});

describe('R4: fix-mode promotion guard', () => {
    test('an override that raises fix authority throws', async () => {
        const root = await tempRoot({
            'p.yaml': 'name: p\nextends: [cat]\noverrides:\n  r:\n    fix: { mode: auto }\n',
            'cat/r.yaml':
                'rules:\n  - id: r\n    description: d\n    fix: { mode: suggest }\n    evaluator: { type: path, config: { paths: ["x"] } }\n',
        });
        await expect(loadPresetRules('p', { roots: [root] })).rejects.toThrow('may only lower fix authority');
    });

    test('an override that lowers fix authority is applied', async () => {
        const root = await tempRoot({
            'p.yaml': 'name: p\nextends: [cat]\noverrides:\n  r:\n    fix: { mode: suggest }\n',
            'cat/r.yaml':
                'rules:\n  - id: r\n    description: d\n    fix: { mode: auto }\n    evaluator: { type: path, config: { paths: ["x"] } }\n',
        });
        const rules = await loadPresetRules('p', { roots: [root] });
        expect(rules[0]?.fix?.mode).toBe('suggest');
    });
});

describe('R2: extension path safety', () => {
    test('rejects absolute and traversal extension paths', () => {
        expect(
            PresetDefinitionSchema.safeParse({ name: 'p', extends: [], extensions: { evaluators: ['../e.ts'] } })
                .success,
        ).toBe(false);
        expect(
            PresetDefinitionSchema.safeParse({ name: 'p', extends: [], extensions: { evaluators: ['/abs.ts'] } })
                .success,
        ).toBe(false);
        expect(
            PresetDefinitionSchema.safeParse({ name: 'p', extends: [], extensions: { evaluators: ['./ok.ts'] } })
                .success,
        ).toBe(true);
    });

    test('rejects unknown extension kinds (strict)', () => {
        expect(
            PresetDefinitionSchema.safeParse({ name: 'p', extends: [], extensions: { plugins: ['x'] } }).success,
        ).toBe(false);
    });
});
