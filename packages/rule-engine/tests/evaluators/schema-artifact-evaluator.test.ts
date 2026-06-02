import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SchemaArtifactEvaluator } from '../../src/evaluators/schema-artifact-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

function makeRule(config: Record<string, unknown>): ConstraintRule {
    return {
        id: 'schema-artifact-test',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'schema-artifact', config },
    };
}

function makeContext(workdir: string, rule: ConstraintRule): RuleContext {
    return { workdir, rule };
}

/** Create a temp dir, run the test callback, then clean up. */
async function withTmpDir(cb: (dir: string) => Promise<void>): Promise<void> {
    const dir = join('/tmp', `schema-artifact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
        await cb(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('SchemaArtifactEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new SchemaArtifactEvaluator();
        expect(evaluator).toBeInstanceOf(SchemaArtifactEvaluator);
    });

    test('throws when file config is missing', async () => {
        const evaluator = new SchemaArtifactEvaluator();
        const rule = makeRule({});
        await expect(evaluator.evaluate(rule, makeContext('/tmp', rule))).rejects.toThrow(
            'schema-artifact evaluator requires string config "file"',
        );
    });

    test('emits missing finding when file does not exist', async () => {
        await withTmpDir(async (dir) => {
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json' });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.code).toBe('schema-artifact:missing');
            expect(result.findings[0]?.filePath).toBe('schema.json');
            expect(result.findings[0]?.message).toBe('schema artifact not found');
        });
    });

    test('emits invalid finding when file contains malformed JSON', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), '{ not valid json');
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json' });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.code).toBe('schema-artifact:invalid');
            expect(result.findings[0]?.message).toMatch(/^invalid JSON:/);
        });
    });

    test('returns no findings for a valid schema with no constraints', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({ title: 'My Schema', properties: { foo: {} } }));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json' });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toEqual([]);
            expect(result.fixes).toEqual([]);
        });
    });

    test('emits violation when requiredTitle does not match', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({ title: 'Wrong Title' }));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json', requiredTitle: 'Expected Title' });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.code).toBe('schema-artifact:violation');
            expect(result.findings[0]?.message).toContain("expected 'Expected Title'");
            expect(result.findings[0]?.message).toContain("got 'Wrong Title'");
        });
    });

    test('emits violation when requiredTitle is missing from schema', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({}));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json', requiredTitle: 'Expected Title' });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.message).toContain("got '(missing)'");
        });
    });

    test('no violation when requiredTitle matches', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({ title: 'My Title' }));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json', requiredTitle: 'My Title' });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toEqual([]);
        });
    });

    test('emits one violation per missing requiredProperty', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({ properties: { rules: {}, $schema: {} } }));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({
                file: 'schema.json',
                requiredProperties: ['rules', '$schema', 'version'],
            });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            // 'rules' and '$schema' exist; 'version' is missing.
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.message).toContain('properties.version');
        });
    });

    test('emits violation for missing $defs entry', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({ $defs: { evaluator: {}, fixConfig: {} } }));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({
                file: 'schema.json',
                requiredDefs: ['evaluator', 'fixConfig', 'constraintRule'],
            });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.message).toContain('$defs.constraintRule');
        });
    });

    test('falls back to definitions key when $defs is absent', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({ definitions: { myDef: {} } }));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json', requiredDefs: ['myDef'] });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toEqual([]);
        });
    });

    test('emits violation when requireRequiredArray is true and required is absent', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({ title: 'x' }));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json', requireRequiredArray: true });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.message).toContain("missing 'required' array");
        });
    });

    test('no violation when requireRequiredArray is true and required is present', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({ required: ['foo'] }));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json', requireRequiredArray: true });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings).toEqual([]);
        });
    });

    test('filePath on findings equals the configured file', async () => {
        await withTmpDir(async (dir) => {
            writeFileSync(join(dir, 'schema.json'), JSON.stringify({ properties: {} }));
            const evaluator = new SchemaArtifactEvaluator();
            const rule = makeRule({ file: 'schema.json', requiredProperties: ['missing'] });
            const result = await evaluator.evaluate(rule, makeContext(dir, rule));
            expect(result.findings[0]?.filePath).toBe('schema.json');
            expect(result.findings[0]?.severity).toBe('error');
        });
    });
});
