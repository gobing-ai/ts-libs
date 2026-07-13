import { describe, expect, test } from 'bun:test';
import type { ProcessExecutor, ProcessOptions } from '@gobing-ai/ts-runtime';
import { SgEvaluator } from '../../src/evaluators/sg-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

/** Minimal ProcessExecutor stub for injection. */
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

function makeRule(config: Record<string, unknown>, extras: Partial<ConstraintRule> = {}): ConstraintRule {
    return {
        id: 'sg-test',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'sg', config },
        ...extras,
    };
}

function makeContext(workdir = '/tmp', rule?: ConstraintRule): RuleContext {
    const r = rule ?? makeRule({ pattern: 'console.log($$$)' });
    return { workdir, rule: r };
}

describe('SgEvaluator', () => {
    test('constructs with default executor', () => {
        const evaluator = new SgEvaluator();
        expect(evaluator).toBeInstanceOf(SgEvaluator);
    });

    test('throws when pattern config is missing', async () => {
        const executor = makeFakeExecutor({ exitCode: 0, stdout: '', stderr: '' });
        const evaluator = new SgEvaluator(executor);
        const rule = makeRule({});
        await expect(evaluator.evaluate(rule, makeContext('/tmp', rule))).rejects.toThrow(
            'sg evaluator requires string config "pattern"',
        );
    });

    test('throws when pattern is empty string', async () => {
        const executor = makeFakeExecutor({ exitCode: 0, stdout: '', stderr: '' });
        const evaluator = new SgEvaluator(executor);
        const rule = makeRule({ pattern: '' });
        await expect(evaluator.evaluate(rule, makeContext('/tmp', rule))).rejects.toThrow(
            'sg evaluator requires string config "pattern"',
        );
    });

    test('returns no findings when sg produces empty stdout', async () => {
        const executor = makeFakeExecutor({ exitCode: 0, stdout: '', stderr: '' });
        const evaluator = new SgEvaluator(executor);
        const rule = makeRule({ pattern: 'console.log($$$)' });
        const result = await evaluator.evaluate(rule, makeContext('/tmp', rule));
        expect(result.findings).toEqual([]);
        expect(result.fixes).toEqual([]);
    });

    test('throws when sg exits non-zero with stderr and no stdout', async () => {
        const executor = makeFakeExecutor({ exitCode: 1, stdout: '', stderr: 'parse error: bad pattern' });
        const evaluator = new SgEvaluator(executor);
        const rule = makeRule({ pattern: '$BAD((' });
        await expect(evaluator.evaluate(rule, makeContext('/tmp', rule))).rejects.toThrow(
            'sg failed: parse error: bad pattern',
        );
    });

    test('parses JSON array output and emits one finding per match', async () => {
        const sgOutput = JSON.stringify([
            { file: 'src/a.ts', range: { start: { line: 4 } }, text: 'console.log(x)' },
            { file: 'src/b.ts', range: { start: { line: 12 } }, text: 'console.log(y)' },
        ]);
        const executor = makeFakeExecutor({ exitCode: 0, stdout: sgOutput, stderr: '' });
        const evaluator = new SgEvaluator(executor);
        const rule = makeRule({ pattern: 'console.log($$$)' });
        const result = await evaluator.evaluate(rule, makeContext('/tmp', rule));
        expect(result.findings).toHaveLength(2);
        expect(result.findings[0]?.filePath).toBe('src/a.ts');
        expect(result.findings[0]?.line).toBe(5); // 0-based + 1
        expect(result.findings[0]?.code).toBe('sg:match');
        expect(result.findings[0]?.message).toBe('matched sg pattern');
        expect(result.findings[0]?.severity).toBe('error');
        expect(result.findings[1]?.filePath).toBe('src/b.ts');
        expect(result.findings[1]?.line).toBe(13);
    });

    test('parses newline-delimited JSON output (older sg)', async () => {
        const sgOutput = [
            JSON.stringify({ file: 'src/c.ts', range: { start: { line: 2 } }, text: 'console.log(z)' }),
            JSON.stringify({ file: 'src/d.ts', range: { start: { line: 7 } }, text: 'console.log(w)' }),
        ].join('\n');
        const executor = makeFakeExecutor({ exitCode: 0, stdout: sgOutput, stderr: '' });
        const evaluator = new SgEvaluator(executor);
        const rule = makeRule({ pattern: 'console.log($$$)' });
        const result = await evaluator.evaluate(rule, makeContext('/tmp', rule));
        expect(result.findings).toHaveLength(2);
        expect(result.findings[0]?.filePath).toBe('src/c.ts');
        expect(result.findings[0]?.line).toBe(3);
        expect(result.findings[1]?.filePath).toBe('src/d.ts');
        expect(result.findings[1]?.line).toBe(8);
    });

    test('exclude globs drop matching files from findings', async () => {
        const sgOutput = JSON.stringify([
            { file: 'src/a.ts', range: { start: { line: 0 } }, text: 'console.log(x)' },
            { file: 'tests/b.test.ts', range: { start: { line: 0 } }, text: 'console.log(x)' },
        ]);
        const executor = makeFakeExecutor({ exitCode: 0, stdout: sgOutput, stderr: '' });
        const evaluator = new SgEvaluator(executor);
        const rule = makeRule({ pattern: 'console.log($$$)' }, { exclude: ['tests/**'] } as Partial<ConstraintRule>);
        const result = await evaluator.evaluate(rule, makeContext('/tmp', rule));
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.filePath).toBe('src/a.ts');
    });

    /** Capture the args handed to the sg subprocess so we can assert on glob forwarding. */
    function captureArgs(): { executor: ProcessExecutor; args: () => string[] } {
        let captured: string[] = [];
        const executor: ProcessExecutor = {
            run: async (opts: ProcessOptions) => {
                captured = opts.args ?? [];
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                    command: opts.command,
                    args: opts.args ?? [],
                    durationMs: 0,
                };
            },
            runStreaming(): never {
                throw new Error('runStreaming not implemented');
            },
        };
        return { executor, args: () => captured };
    }

    /** Read the values of every `--globs <value>` pair from a flat arg list. */
    function globValues(args: string[]): string[] {
        const values: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
            if (args[i] === '--globs' && i + 1 < args.length) values.push(args[i + 1] as string);
        }
        return values;
    }

    test('forwards include globs to sg as --globs values (not the rejected --glob)', async () => {
        const { executor, args } = captureArgs();
        const rule = makeRule({ pattern: 'foo($$$)' }, { include: ['src/**/*.ts'] } as Partial<ConstraintRule>);
        await new SgEvaluator(executor).evaluate(rule, makeContext('/tmp', rule));
        // ast-grep 0.40+ rejects the singular `--glob`; the flag must be `--globs`.
        expect(args()).not.toContain('--glob=src/**/*.ts');
        expect(globValues(args())).toContain('src/**/*.ts');
    });

    test('prunes node_modules and other heavy trees at traversal time even when the rule omits exclude', async () => {
        // The perf-critical guarantee: sg must be told to skip node_modules during the walk,
        // not after — and without the rule author having to remember.
        const { executor, args } = captureArgs();
        const rule = makeRule({ pattern: 'foo($$$)' }); // no include, no exclude
        await new SgEvaluator(executor).evaluate(rule, makeContext('/tmp', rule));
        const globs = globValues(args());
        expect(globs).toContain('!**/node_modules/**');
        expect(globs).toContain('!**/dist/**');
        expect(globs).toContain('!**/.git/**');
    });

    test('forwards the rule exclude globs as negated --globs (prune during traversal)', async () => {
        const { executor, args } = captureArgs();
        const rule = makeRule({ pattern: 'foo($$$)' }, { exclude: ['vendor/**'] } as Partial<ConstraintRule>);
        await new SgEvaluator(executor).evaluate(rule, makeContext('/tmp', rule));
        expect(globValues(args())).toContain('!vendor/**');
    });
});
