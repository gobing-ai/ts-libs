import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import { CapabilityRegistry } from '@gobing-ai/ts-runtime/extension';
import { type TestStubFileSystem, TestStubFixer } from '../../src/fixers/test-stub-fixer';
import type { TestPathResolver } from '../../src/resolvers/test-path-resolver';
import type { ConstraintFinding, ConstraintRule } from '../../src/types';

// ── fake dependencies ─────────────────────────────────────────────────────────

class FakeExecutor {
    async run(options: ProcessOptions): Promise<ProcessResult> {
        return {
            command: options.command,
            args: options.args ?? [],
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
        };
    }
}

/** Resolver that maps src/X.ts → tests/X.test.ts with a simple skeleton. */
class SimpleResolver implements TestPathResolver {
    readonly name = 'simple';

    resolveTestPath(srcRelPath: string): string {
        return `tests/${srcRelPath.replace(/^src\//, '').replace(/\.ts$/, '.test.ts')}`;
    }

    generateSkeleton(srcRelPath: string, _exports: []): string {
        return `// stub for ${srcRelPath}\nimport { describe, test } from 'bun:test';\ndescribe('${srcRelPath}', () => {});\n`;
    }
}

/** File-system that reports no files exist. */
const emptyFs: TestStubFileSystem = { exists: async () => false };

/** File-system that reports all files exist. */
const fullFs: TestStubFileSystem = { exists: async () => true };

function makeResolvers(): CapabilityRegistry<TestPathResolver> {
    const reg = new CapabilityRegistry<TestPathResolver>('resolver');
    reg.register('simple', new SimpleResolver(), 'builtin');
    return reg;
}

function makeRule(overrides: Partial<ConstraintRule> = {}): ConstraintRule {
    return {
        id: 'test-location',
        description: 'require tests',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'test-location', config: { resolver: 'simple' } },
        fix: { mode: 'auto' },
        ...overrides,
    };
}

function makeFinding(overrides: Partial<ConstraintFinding> = {}): ConstraintFinding {
    return {
        ruleId: 'test-location',
        severity: 'error',
        message: 'missing test',
        filePath: 'src/foo.ts',
        ...overrides,
    };
}

async function makeTempDir(): Promise<string> {
    const dir = join(
        tmpdir(),
        'ts-libs-rule-engine-test-stub-fixer',
        `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('TestStubFixer', () => {
    test('emits a create-file fix at the resolver test path', async () => {
        const dir = await makeTempDir();
        const fixer = new TestStubFixer({
            resolvers: makeResolvers(),
            processExecutor: new FakeExecutor() as never,
            fileSystem: emptyFs,
        });
        const rule = makeRule();
        const finding = makeFinding();

        const fixes = await fixer.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [finding],
            fix: { mode: 'auto' },
        });

        expect(fixes).toHaveLength(1);
        expect(fixes[0]?.filePath).toBe('tests/foo.test.ts');
        expect(fixes[0]?.start).toBe(0);
        expect(fixes[0]?.end).toBe(0);
        expect(fixes[0]?.replacement).toContain('stub for src/foo.ts');
    });

    test('skips findings whose test file already exists', async () => {
        const dir = await makeTempDir();
        const fixer = new TestStubFixer({
            resolvers: makeResolvers(),
            processExecutor: new FakeExecutor() as never,
            fileSystem: fullFs,
        });
        const rule = makeRule();
        const fixes = await fixer.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding()],
            fix: { mode: 'auto' },
        });
        expect(fixes).toHaveLength(0);
    });

    test('returns empty when fix.mode is none', async () => {
        const dir = await makeTempDir();
        const fixer = new TestStubFixer({
            resolvers: makeResolvers(),
            processExecutor: new FakeExecutor() as never,
            fileSystem: emptyFs,
        });
        const rule = makeRule();
        const fixes = await fixer.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding()],
            fix: { mode: 'none' },
        });
        expect(fixes).toHaveLength(0);
    });

    test('returns empty when resolver is not registered', async () => {
        const dir = await makeTempDir();
        const emptyResolvers = new CapabilityRegistry<TestPathResolver>('resolver');
        const fixer = new TestStubFixer({
            resolvers: emptyResolvers,
            processExecutor: new FakeExecutor() as never,
            fileSystem: emptyFs,
        });
        const rule = makeRule({ evaluator: { type: 'test-location', config: { resolver: 'typescript' } } });
        const fixes = await fixer.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding()],
            fix: { mode: 'auto' },
        });
        expect(fixes).toHaveLength(0);
    });

    test('skips findings with null filePath', async () => {
        const dir = await makeTempDir();
        const fixer = new TestStubFixer({
            resolvers: makeResolvers(),
            processExecutor: new FakeExecutor() as never,
            fileSystem: emptyFs,
        });
        const rule = makeRule();
        const fixes = await fixer.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding({ filePath: null })],
            fix: { mode: 'auto' },
        });
        expect(fixes).toHaveLength(0);
    });

    test('skips findings with absolute filePath', async () => {
        const dir = await makeTempDir();
        const fixer = new TestStubFixer({
            resolvers: makeResolvers(),
            processExecutor: new FakeExecutor() as never,
            fileSystem: emptyFs,
        });
        const rule = makeRule();
        const fixes = await fixer.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding({ filePath: '/absolute/path/foo.ts' })],
            fix: { mode: 'auto' },
        });
        expect(fixes).toHaveLength(0);
    });

    test('skips a resolver that has no generateSkeleton', async () => {
        const dir = await makeTempDir();
        // A resolver without generateSkeleton — skeleton is '' → fix skipped.
        const resolvers = new CapabilityRegistry<TestPathResolver>('resolver');
        resolvers.register(
            'no-skeleton',
            {
                name: 'no-skeleton',
                resolveTestPath: (src: string) => `tests/${src}.test.ts`,
                // no generateSkeleton
            },
            'builtin',
        );
        const fixer = new TestStubFixer({
            resolvers,
            processExecutor: new FakeExecutor() as never,
            fileSystem: emptyFs,
        });
        const rule = makeRule({ evaluator: { type: 'test-location', config: { resolver: 'no-skeleton' } } });
        const fixes = await fixer.createFixes({
            rule,
            context: { rule, workdir: dir },
            findings: [makeFinding()],
            fix: { mode: 'auto' },
        });
        expect(fixes).toHaveLength(0);
    });
});
