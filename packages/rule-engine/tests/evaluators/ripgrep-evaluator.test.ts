import { describe, expect, test } from 'bun:test';
import type { ProcessExecutor, ProcessOptions } from '@gobing-ai/ts-runtime';
import { isRipgrepCompatiblePattern, RipgrepEvaluator } from '../../src/evaluators/ripgrep-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

interface FakeRunResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

function makeFakeExecutor(response: FakeRunResult): ProcessExecutor {
    return {
        run: async () => ({
            command: '',
            args: [],
            exitCode: response.exitCode,
            stdout: response.stdout,
            stderr: response.stderr,
            durationMs: 0,
        }),
        runStreaming(): never {
            throw new Error('runStreaming not implemented');
        },
    };
}

/** Executor that records the args it was handed, for asserting CLI construction. */
function captureArgs(response: FakeRunResult = { exitCode: 1, stdout: '', stderr: '' }): {
    executor: ProcessExecutor;
    args: () => string[];
} {
    let captured: string[] = [];
    const executor: ProcessExecutor = {
        run: async (opts: ProcessOptions) => {
            captured = opts.args ?? [];
            return { ...response, command: opts.command, args: opts.args ?? [], durationMs: 0 };
        },
        runStreaming(): never {
            throw new Error('runStreaming not implemented');
        },
    };
    return { executor, args: () => captured };
}

function makeRule(config: Record<string, unknown>, extras: Partial<ConstraintRule> = {}): ConstraintRule {
    return {
        id: 'rg-test',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'rg', config },
        ...extras,
    };
}

function ctx(rule: ConstraintRule, workdir = '/tmp'): RuleContext {
    return { workdir, rule };
}

/** Build an `rg --json` match event line. */
function matchEvent(file: string, line: number): string {
    return JSON.stringify({ type: 'match', data: { path: { text: file }, line_number: line } });
}

describe('RipgrepEvaluator', () => {
    test('throws when pattern config is missing', async () => {
        const rule = makeRule({});
        await expect(
            new RipgrepEvaluator(makeFakeExecutor({ exitCode: 1, stdout: '', stderr: '' })).evaluate(rule, ctx(rule)),
        ).rejects.toThrow('rg evaluator requires string config "pattern"');
    });

    test('forbid mode emits one finding per rg --json match', async () => {
        const stdout = [
            JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
            matchEvent('src/a.ts', 4),
            matchEvent('src/b.ts', 12),
            JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
        ].join('\n');
        const rule = makeRule({ pattern: 'biome-ignore' });
        const result = await new RipgrepEvaluator(makeFakeExecutor({ exitCode: 0, stdout, stderr: '' })).evaluate(
            rule,
            ctx(rule),
        );
        expect(result.findings).toHaveLength(2);
        expect(result.findings[0]?.filePath).toBe('src/a.ts');
        expect(result.findings[0]?.line).toBe(4);
        expect(result.findings[0]?.code).toBe('rg:found');
        expect(result.findings[1]?.filePath).toBe('src/b.ts');
        expect(result.findings[1]?.line).toBe(12);
    });

    test('require mode emits one finding per file printed by --files-without-match', async () => {
        const rule = makeRule({ pattern: 'license-header', mode: 'require' });
        const { executor, args } = captureArgs({ exitCode: 0, stdout: 'src/a.ts\nsrc/b.ts\n', stderr: '' });
        const result = await new RipgrepEvaluator(executor).evaluate(rule, ctx(rule));
        expect(args()).toContain('--files-without-match');
        expect(result.findings).toHaveLength(2);
        expect(result.findings[0]?.filePath).toBe('src/a.ts');
        expect(result.findings[0]?.code).toBe('rg:missing');
    });

    test('exit code 1 (no matches) is success, not an error', async () => {
        const rule = makeRule({ pattern: 'never-here' });
        const result = await new RipgrepEvaluator(makeFakeExecutor({ exitCode: 1, stdout: '', stderr: '' })).evaluate(
            rule,
            ctx(rule),
        );
        expect(result.findings).toEqual([]);
    });

    test('exit code 2 (rg error / missing binary) fails loud', async () => {
        const rule = makeRule({ pattern: '(' });
        await expect(
            new RipgrepEvaluator(makeFakeExecutor({ exitCode: 2, stdout: '', stderr: 'regex parse error' })).evaluate(
                rule,
                ctx(rule),
            ),
        ).rejects.toThrow('rg failed (exit 2): regex parse error');
    });

    test('exit code 2 from no files searched is a non-applicable scoped rule, not an evaluator error', async () => {
        const rule = makeRule(
            { pattern: 'vendors/' },
            {
                include: ['plugins/sp/**/*.md'],
            },
        );
        const result = await new RipgrepEvaluator(
            makeFakeExecutor({
                exitCode: 2,
                stdout: '',
                stderr: [
                    "rg: No files were searched, which means ripgrep probably applied a filter you didn't expect.",
                    'Running with --debug will show why files are being skipped.',
                ].join('\n'),
            }),
        ).evaluate(rule, ctx(rule));

        expect(result.findings).toEqual([]);
        expect(result.fixes).toEqual([]);
    });

    test('prunes node_modules and default-excluded trees via negated --glob, even without rule exclude', async () => {
        const rule = makeRule({ pattern: 'foo' });
        const { executor, args } = captureArgs();
        await new RipgrepEvaluator(executor).evaluate(rule, ctx(rule));
        const a = args();
        // Each --glob value follows its flag; assert the negated default-exclude globs are present.
        expect(a).toContain('--glob');
        expect(a).toContain('!**/node_modules/**');
        expect(a).toContain('!**/dist/**');
        expect(a).toContain('--json');
    });

    test('forwards rule include and exclude globs to rg', async () => {
        const rule = makeRule({ pattern: 'foo' }, {
            include: ['src/**'],
            exclude: ['src/gen/**'],
        } as Partial<ConstraintRule>);
        const { executor, args } = captureArgs();
        await new RipgrepEvaluator(executor).evaluate(rule, ctx(rule));
        const a = args();
        expect(a).toContain('src/**');
        expect(a).toContain('!src/gen/**');
    });

    test('multiline adds -U --multiline-dotall', async () => {
        const rule = makeRule({ pattern: 'a.*b', multiline: true });
        const { executor, args } = captureArgs();
        await new RipgrepEvaluator(executor).evaluate(rule, ctx(rule));
        expect(args()).toContain('-U');
        expect(args()).toContain('--multiline-dotall');
    });

    test('pattern is passed after -- so leading-dash patterns are not treated as flags', async () => {
        const rule = makeRule({ pattern: '-foo' });
        const { executor, args } = captureArgs();
        await new RipgrepEvaluator(executor).evaluate(rule, ctx(rule));
        const a = args();
        const dashDash = a.indexOf('--');
        expect(dashDash).toBeGreaterThanOrEqual(0);
        expect(a[dashDash + 1]).toBe('-foo');
    });
});

describe('isRipgrepCompatiblePattern', () => {
    test('plain patterns are compatible', () => {
        expect(isRipgrepCompatiblePattern('biome-ignore')).toEqual({ compatible: true });
        expect(isRipgrepCompatiblePattern('(?i)console\\.(log|warn)')).toEqual({ compatible: true });
        expect(isRipgrepCompatiblePattern('foo|bar')).toEqual({ compatible: true });
    });

    test('lookbehind is rejected', () => {
        expect(isRipgrepCompatiblePattern('(?<=foo)bar')).toEqual({ compatible: false, feature: 'lookbehind' });
        expect(isRipgrepCompatiblePattern('(?<!foo)bar')).toEqual({ compatible: false, feature: 'lookbehind' });
    });

    test('backreferences are rejected', () => {
        expect(isRipgrepCompatiblePattern('(a)\\1')).toEqual({ compatible: false, feature: 'backreference' });
        expect(isRipgrepCompatiblePattern('(?<g>a)\\k<g>')).toEqual({
            compatible: false,
            feature: 'named backreference',
        });
    });
});
