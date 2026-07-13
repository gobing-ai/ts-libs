import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessExecutor } from '@gobing-ai/ts-runtime';
import { RuleEngine } from '../../src/engine';
import {
    applyFixes,
    createUnifiedDiff,
    FIX_MODE_RANK,
    PathFixerProvider,
    RegexFixerProvider,
} from '../../src/fixers/fixers';
import type { ConstraintFinding, ConstraintRule, Fix } from '../../src/types';

// ── helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
    const dir = join(tmpdir(), 'ts-libs-rule-engine-fixers', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(dir, { recursive: true });
    return dir;
}

function makeRule(overrides: Partial<ConstraintRule> = {}): ConstraintRule {
    return {
        id: 'test-rule',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'regex', config: { pattern: 'foo', flags: 'g' } },
        ...overrides,
    };
}

function makeFinding(overrides: Partial<ConstraintFinding> = {}): ConstraintFinding {
    return {
        ruleId: 'test-rule',
        severity: 'error',
        message: 'found something',
        filePath: 'src/index.ts',
        line: 1,
        ...overrides,
    };
}

function makeFix(overrides: Partial<Fix> = {}): Fix {
    return {
        ruleId: 'test-rule',
        filePath: 'src/index.ts',
        start: 0,
        end: 3,
        replacement: 'bar',
        mode: 'auto',
        ...overrides,
    };
}

// ── FIX_MODE_RANK ─────────────────────────────────────────────────────────────

describe('FIX_MODE_RANK', () => {
    test('none < suggest < auto', () => {
        expect(FIX_MODE_RANK.none).toBeLessThan(FIX_MODE_RANK.suggest);
        expect(FIX_MODE_RANK.suggest).toBeLessThan(FIX_MODE_RANK.auto);
    });
});

// ── applyFixes ────────────────────────────────────────────────────────────────

describe('applyFixes', () => {
    test('applies a byte-range replacement to a real file', async () => {
        const dir = await makeTempDir();
        const file = join(dir, 'src', 'index.ts');
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(file, 'foo bar baz');

        const fix = makeFix({ filePath: 'src/index.ts', start: 4, end: 7, replacement: 'qux' });
        const result = await applyFixes(dir, [fix]);

        expect(result.applied).toHaveLength(1);
        expect(result.deferred).toHaveLength(0);
        expect(result.changedFiles).toContain('src/index.ts');
        expect(readFileSync(file, 'utf-8')).toBe('foo qux baz');
    });

    test('dryRun does NOT write files and returns a diff', async () => {
        const dir = await makeTempDir();
        const file = join(dir, 'src', 'mod.ts');
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(file, 'hello world');

        const fix = makeFix({ filePath: 'src/mod.ts', start: 6, end: 11, replacement: 'earth' });
        const result = await applyFixes(dir, [fix], true);

        expect(result.changedFiles).toContain('src/mod.ts');
        expect(result.diff).toContain('-hello world');
        expect(result.diff).toContain('+hello earth');
        // File must NOT have changed on disk
        expect(readFileSync(file, 'utf-8')).toBe('hello world');
    });

    test('overlapping fixes: first applied, second deferred', async () => {
        const dir = await makeTempDir();
        const file = join(dir, 'src', 'overlap.ts');
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(file, 'abcdefgh');

        const fix1 = makeFix({ filePath: 'src/overlap.ts', start: 0, end: 4, replacement: 'XXXX' });
        const fix2 = makeFix({ filePath: 'src/overlap.ts', start: 2, end: 6, replacement: 'YYYY' });
        const result = await applyFixes(dir, [fix1, fix2]);

        expect(result.applied).toHaveLength(1);
        expect(result.deferred).toHaveLength(1);
    });

    test('creation fix (start=0 end=0) creates a new file', async () => {
        const dir = await makeTempDir();
        const filePath = 'new/file.ts';
        const fix: Fix = {
            ruleId: 'create-rule',
            filePath,
            start: 0,
            end: 0,
            replacement: 'export const x = 1;\n',
            mode: 'auto',
        };
        const result = await applyFixes(dir, [fix]);

        expect(result.applied).toHaveLength(1);
        expect(readFileSync(join(dir, filePath), 'utf-8')).toBe('export const x = 1;\n');
    });

    test('deletion fix (replacement="", range spans file) deletes the file', async () => {
        const dir = await makeTempDir();
        const filePath = 'to-delete.ts';
        const content = 'remove me\n';
        await writeFile(join(dir, filePath), content);

        const fix: Fix = {
            ruleId: 'delete-rule',
            filePath,
            start: 0,
            end: content.length,
            replacement: '',
            mode: 'auto',
        };
        const result = await applyFixes(dir, [fix]);

        expect(result.applied).toHaveLength(1);
        expect(existsSync(join(dir, filePath))).toBe(false);
    });

    test('fix outside workdir is deferred', async () => {
        const dir = await makeTempDir();
        const fix = makeFix({ filePath: '../escape.ts' });
        const result = await applyFixes(dir, [fix]);

        expect(result.deferred).toHaveLength(1);
        expect(result.applied).toHaveLength(0);
    });
});

// ── createUnifiedDiff ─────────────────────────────────────────────────────────

describe('createUnifiedDiff', () => {
    test('produces a diff with --- +++ @@ headers', () => {
        const diff = createUnifiedDiff('src/foo.ts', 'a\nb', 'a\nc');
        expect(diff).toContain('--- src/foo.ts');
        expect(diff).toContain('+++ src/foo.ts');
        expect(diff).toContain('@@');
        expect(diff).toContain('-b');
        expect(diff).toContain('+c');
    });
});

// ── RegexFixerProvider ────────────────────────────────────────────────────────

describe('RegexFixerProvider', () => {
    test('produces a fix when replacement is set and pattern matches', async () => {
        const dir = await makeTempDir();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'index.ts'), 'const foo = 1;\n');

        const provider = new RegexFixerProvider();
        const rule = makeRule({
            evaluator: { type: 'regex', config: { pattern: 'foo', flags: 'g' } },
            fix: { mode: 'auto', replacement: 'bar' },
        });
        const finding = makeFinding({ filePath: 'src/index.ts', line: 1 });

        const fixes = await provider.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [finding],
            fix: { mode: 'auto', replacement: 'bar' },
        });

        expect(fixes).toHaveLength(1);
        expect(fixes[0]?.replacement).toBe('bar');
        expect(fixes[0]?.filePath).toBe('src/index.ts');
    });

    test('returns empty array when replacement is not set', async () => {
        const dir = await makeTempDir();
        const provider = new RegexFixerProvider();
        const rule = makeRule();
        const fixes = await provider.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding()],
            fix: { mode: 'auto' },
        });
        expect(fixes).toHaveLength(0);
    });

    test('returns empty array when mode is none', async () => {
        const dir = await makeTempDir();
        const provider = new RegexFixerProvider();
        const rule = makeRule();
        const fixes = await provider.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding()],
            fix: { mode: 'none', replacement: 'bar' },
        });
        expect(fixes).toHaveLength(0);
    });

    test('skips finding with null filePath', async () => {
        const dir = await makeTempDir();
        const provider = new RegexFixerProvider();
        const rule = makeRule();
        const fixes = await provider.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding({ filePath: null })],
            fix: { mode: 'auto', replacement: 'bar' },
        });
        expect(fixes).toHaveLength(0);
    });
});

// ── PathFixerProvider ─────────────────────────────────────────────────────────

describe('PathFixerProvider', () => {
    test('produces a deletion fix in auto mode for must:absent files', async () => {
        const dir = await makeTempDir();
        await writeFile(join(dir, 'forbidden.ts'), 'should-not-exist\n');

        const provider = new PathFixerProvider();
        const rule = makeRule({
            evaluator: { type: 'path', config: { must: 'absent', paths: ['forbidden.ts'] } },
        });
        const finding = makeFinding({ filePath: 'forbidden.ts', line: undefined });

        const fixes = await provider.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [finding],
            fix: { mode: 'auto' },
        });

        expect(fixes).toHaveLength(1);
        expect(fixes[0]?.replacement).toBe('');
        expect(fixes[0]?.start).toBe(0);
        expect(fixes[0]?.end).toBeGreaterThan(0);
    });

    test('returns empty when mode is suggest (not auto)', async () => {
        const dir = await makeTempDir();
        const provider = new PathFixerProvider();
        const rule = makeRule({ evaluator: { type: 'path', config: { must: 'absent' } } });
        const fixes = await provider.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding({ filePath: 'forbidden.ts' })],
            fix: { mode: 'suggest' },
        });
        expect(fixes).toHaveLength(0);
    });
});

// ── RuleEngine.evaluateWithFixes ──────────────────────────────────────────────

describe('RuleEngine.evaluateWithFixes', () => {
    test('produces fixes for a rule with fix.mode auto', async () => {
        const dir = await makeTempDir();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'mod.ts'), 'const foo = 1;\n');

        const rule: ConstraintRule = {
            id: 'rename-foo',
            description: 'rename foo',
            enabled: true,
            severity: 'error',
            include: ['src'],
            evaluator: { type: 'regex', config: { mode: 'forbid', pattern: 'foo', flags: 'g' } },
            fix: { mode: 'auto', replacement: 'bar' },
        };

        const engine = new RuleEngine();
        const result = await engine.evaluateWithFixes([rule], dir);
        expect(result.findings.length).toBeGreaterThan(0);
        expect(result.fixes.length).toBeGreaterThan(0);
    });

    test('produces no fixes for a rule with fix.mode none', async () => {
        const dir = await makeTempDir();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'mod.ts'), 'const foo = 1;\n');

        const rule: ConstraintRule = {
            id: 'rename-foo-no-fix',
            description: 'rename foo',
            enabled: true,
            severity: 'error',
            include: ['src'],
            evaluator: { type: 'regex', config: { mode: 'forbid', pattern: 'foo', flags: 'g' } },
            fix: { mode: 'none' },
        };

        const engine = new RuleEngine();
        const result = await engine.evaluateWithFixes([rule], dir);
        expect(result.findings.length).toBeGreaterThan(0);
        expect(result.fixes).toHaveLength(0);
    });

    test('maxFixMode suggest downgrades auto rules to suggest', async () => {
        const dir = await makeTempDir();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'mod.ts'), 'const foo = 1;\n');

        const rule: ConstraintRule = {
            id: 'rename-foo-auto',
            description: 'rename foo',
            enabled: true,
            severity: 'error',
            include: ['src'],
            evaluator: { type: 'regex', config: { mode: 'forbid', pattern: 'foo', flags: 'g' } },
            fix: { mode: 'auto', replacement: 'bar' },
        };

        const engine = new RuleEngine();
        const result = await engine.evaluateWithFixes([rule], dir, 'suggest');
        // Fixes are still emitted — mode is downgraded to 'suggest'
        expect(result.fixes.length).toBeGreaterThan(0);
        for (const fix of result.fixes) {
            expect(fix.mode).toBe('suggest');
        }
    });

    test('maxFixMode none suppresses all fixes', async () => {
        const dir = await makeTempDir();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'mod.ts'), 'const foo = 1;\n');

        const rule: ConstraintRule = {
            id: 'rename-foo-blocked',
            description: 'rename foo',
            enabled: true,
            severity: 'error',
            include: ['src'],
            evaluator: { type: 'regex', config: { mode: 'forbid', pattern: 'foo', flags: 'g' } },
            fix: { mode: 'auto', replacement: 'bar' },
        };

        const engine = new RuleEngine();
        const result = await engine.evaluateWithFixes([rule], dir, 'none');
        expect(result.fixes).toHaveLength(0);
    });

    test('applyFixes on engine delegates to the fixer impl', async () => {
        const dir = await makeTempDir();
        const filePath = 'apply-test.ts';
        await writeFile(join(dir, filePath), 'before');
        const fix: Fix = { ruleId: 'r', filePath, start: 0, end: 6, replacement: 'after', mode: 'auto' };

        const engine = new RuleEngine();
        const appResult = await engine.applyFixes(dir, [fix]);
        expect(appResult.applied).toHaveLength(1);
        expect(readFileSync(join(dir, filePath), 'utf-8')).toBe('after');
    });
});

// ── Host fixer registry ────────────────────────────────────────────────────────

describe('host.fixers registry (builtin fixer registration)', () => {
    test('RuleEngine registers built-in fixers into host.fixers', () => {
        const engine = new RuleEngine();
        expect(engine.host.fixers.has('regex')).toBe(true);
        expect(engine.host.fixers.has('rg')).toBe(true);
        expect(engine.host.fixers.has('path')).toBe(true);
        expect(engine.host.fixers.has('file-exist')).toBe(true);
    });

    test('built-in fixer entries have origin "builtin"', () => {
        const engine = new RuleEngine();
        const entry = engine.host.fixers.getEntry('regex');
        expect(entry?.origin).toBe('builtin');
        expect(entry?.capability).toBeInstanceOf(RegexFixerProvider);
    });

    test('test-location fixer is registered when processExecutor is provided', () => {
        const exec: ProcessExecutor = {
            run: async () => ({ command: '', args: [], exitCode: 0, stdout: '', stderr: '', durationMs: 0 }),
            runStreaming(): never {
                throw new Error('runStreaming not implemented');
            },
        };
        const engine = new RuleEngine({ processExecutor: exec });
        expect(engine.host.fixers.has('test-location')).toBe(true);
        expect(engine.host.fixers.getEntry('test-location')?.origin).toBe('builtin');
    });

    test('test-location fixer is absent when processExecutor is omitted', () => {
        const engine = new RuleEngine();
        expect(engine.host.fixers.has('test-location')).toBe(false);
    });

    test('regex and rg share the same provider instance', () => {
        const engine = new RuleEngine();
        expect(engine.host.fixers.get('regex')).toBe(engine.host.fixers.get('rg'));
    });

    test('path and file-exist share the same provider instance', () => {
        const engine = new RuleEngine();
        expect(engine.host.fixers.get('path')).toBe(engine.host.fixers.get('file-exist'));
    });

    test('evaluateWithFixes uses host.fixers for fix generation', async () => {
        const dir = await makeTempDir();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'mod.ts'), 'const foo = 1;\n');

        const rule: ConstraintRule = {
            id: 'rename-foo',
            description: 'rename foo',
            enabled: true,
            severity: 'error',
            include: ['src'],
            evaluator: { type: 'regex', config: { mode: 'forbid', pattern: 'foo', flags: 'g' } },
            fix: { mode: 'auto', replacement: 'bar' },
        };

        const engine = new RuleEngine();
        const result = await engine.evaluateWithFixes([rule], dir);
        expect(result.findings.length).toBeGreaterThan(0);
        expect(result.fixes.length).toBeGreaterThan(0);
        // Verify the fix came from the host registry provider
        const regexEntry = engine.host.fixers.getEntry('regex');
        expect(regexEntry).toBeDefined();
        expect(regexEntry?.origin).toBe('builtin');
    });

    test('rule with evaluator type that has no fixer produces no provider fixes', async () => {
        const dir = await makeTempDir();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'mod.ts'), 'const foo = 1;\n');

        const rule: ConstraintRule = {
            id: 'no-fixer-evaluator',
            description: 'test',
            enabled: true,
            severity: 'error',
            include: ['src'],
            evaluator: { type: 'path', config: { must: 'present', paths: ['src/mod.ts'] } },
            // path evaluator has a fixer, but we test with an evaluator type that has none
            // by using a fake evaluator registered on the host
            fix: { mode: 'auto' },
        };

        const engine = new RuleEngine();
        // Register a fake evaluator type with no matching fixer
        engine.host.evaluators.register(
            'no-fixer-type',
            {
                evaluate: async () => ({
                    findings: [makeFinding({ filePath: 'src/mod.ts' })],
                    fixes: [],
                }),
            },
            'extension',
        );
        rule.evaluator.type = 'no-fixer-type';

        const result = await engine.evaluateWithFixes([rule], dir);
        expect(result.findings.length).toBe(1);
        // No provider fixes because no fixer registered for 'no-fixer-type'
        expect(result.fixes).toHaveLength(0);
    });
});
