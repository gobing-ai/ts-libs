import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TsdocExportEvaluator } from '../../src/evaluators/tsdoc-export-evaluator';
import type { ConstraintRule } from '../../src/types';

function makeRule(overrides: Partial<ConstraintRule> = {}): ConstraintRule {
    return {
        id: 'every-export-has-tsdoc',
        description: 'tsdoc',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'tsdoc-export' },
        ...overrides,
    };
}

async function tempProject(files: Record<string, string>): Promise<string> {
    const dir = join(import.meta.dir, '.tmp', `tsdoc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, content);
    }
    return dir;
}

describe('TsdocExportEvaluator', () => {
    test('flags documented vs undocumented exports', async () => {
        const dir = await tempProject({
            'src/a.ts': [
                '/** Documented. */',
                'export function documented() {}',
                '',
                'export function undocumented() {}',
            ].join('\n'),
        });
        const rule = makeRule({ include: ['**/*.ts'] });
        const result = await new TsdocExportEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.message).toContain('"undocumented"');
        expect(result.findings[0]?.line).toBe(4);
    });

    test('respects include and exclude globs', async () => {
        const dir = await tempProject({
            'src/keep.ts': 'export const keep = 1;\n',
            'src/index.ts': 'export const skip = 1;\n',
        });
        const rule = makeRule({ include: ['**/*.ts'], exclude: ['**/index.ts'] });
        const result = await new TsdocExportEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings.map((f) => f.filePath)).toEqual(['src/keep.ts']);
    });

    test('rejects an unknown export kind', async () => {
        const dir = await tempProject({ 'src/a.ts': 'export const x = 1;\n' });
        const rule = makeRule({ evaluator: { type: 'tsdoc-export', config: { kinds: ['widget'] } } });
        await expect(new TsdocExportEvaluator().evaluate(rule, { workdir: dir, rule })).rejects.toThrow(
            'Unknown export kind',
        );
    });

    test('checks all export kinds (class, type, enum, interface)', async () => {
        const dir = await tempProject({
            'src/kinds.ts': [
                'export class UndocumentedClass {}',
                'export type UndocumentedType = string;',
                'export enum UndocumentedEnum { A }',
                'export interface UndocumentedIface { x: number }',
            ].join('\n'),
        });
        const rule = makeRule({ include: ['**/*.ts'] });
        const result = await new TsdocExportEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(4);
        const names = result.findings.map((f) => f.message).join(' ');
        expect(names).toContain('UndocumentedClass');
        expect(names).toContain('UndocumentedType');
        expect(names).toContain('UndocumentedEnum');
        expect(names).toContain('UndocumentedIface');
    });

    test('accepts single-line JSDoc comments (/** ... */)', async () => {
        const dir = await tempProject({
            'src/single.ts': [
                '/** One-liner. */ export function withOneliner() {}',
                '',
                '/** Also supported */',
                'export function withBlock() {}',
            ].join('\n'),
        });
        const rule = makeRule({ include: ['**/*.ts'] });
        const result = await new TsdocExportEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(0);
    });

    test('flags export at line 1 (no preceding line) as undocumented', async () => {
        const dir = await tempProject({
            'src/first.ts': 'export const first = 1;\n',
        });
        const rule = makeRule({ include: ['**/*.ts'] });
        const result = await new TsdocExportEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.line).toBe(1);
    });

    test('uses default include patterns when rule.include is not set', async () => {
        const dir = await tempProject({
            'src/def.ts': 'export const def = 1;\n',
        });
        const rule = makeRule({ include: undefined });
        const result = await new TsdocExportEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
    });

    test('limits checking to configured export kinds', async () => {
        const dir = await tempProject({
            'src/mixed.ts': ['export function missingFunc() {}', 'export const missingConst = 1;'].join('\n'),
        });
        const rule = makeRule({
            include: ['**/*.ts'],
            evaluator: { type: 'tsdoc-export', config: { kinds: ['function'] } },
        });
        const result = await new TsdocExportEvaluator().evaluate(rule, { workdir: dir, rule });
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.message).toContain('missingFunc');
    });
});
