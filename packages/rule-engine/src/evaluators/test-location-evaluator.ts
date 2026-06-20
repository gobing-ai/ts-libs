import { createNodeFileSystem } from '@gobing-ai/ts-runtime';
import type { CapabilityRegistry } from '@gobing-ai/ts-runtime/extension';
import { type TestPathResolver, TypeScriptTestPathResolver } from '../resolvers/test-path-resolver';
import {
    type ConstraintFinding,
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { discoverFiles, matchesGlob } from './file-utils';

/** Evaluator config shape extracted from `rule.evaluator.config`. */
interface TestLocationConfig {
    expected?: string;
    forbid?: string[];
    requireCorrespondingTest?: boolean;
    resolver?: string;
}

/**
 * Evaluator that enforces where test files live and, optionally, that every
 * source file has a corresponding test.
 *
 * Config (`evaluator.config`):
 * - `expected`: glob the test files must match (required)
 * - `forbid`: globs where tests must not live (e.g. `**\/__tests__/**`)
 * - `requireCorrespondingTest`: when true, flags source files (from `rule.include`)
 *   that lack a test at the resolver's conventional path
 * - `resolver`: language resolver name (`typescript` default, or `python`/`go`/`rust`)
 *
 * Discovery walks the workdir and applies `**` globs precisely, so it stays
 * self-contained (no `rg --files` shell-out).
 */
export class TestLocationEvaluator implements RuleEvaluator {
    /** Optional resolver registry; when absent, the TypeScript convention is used. */
    constructor(private readonly resolvers?: CapabilityRegistry<TestPathResolver>) {}

    /** Evaluate test-file placement and optional coverage of source files. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = (rule.evaluator.config ?? {}) as TestLocationConfig;
        const expected = config.expected;
        if (typeof expected !== 'string' || expected.length === 0) {
            throw new Error('test-location evaluator requires a non-empty "expected" config');
        }
        const forbid = config.forbid ?? [];
        const include = rule.include ?? ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'];
        const exclude = rule.exclude ?? [];
        const findings: ConstraintFinding[] = [];
        const fs = context.fileSystem ?? createNodeFileSystem();
        const allFiles = await discoverFiles({ workdir: context.workdir, fs });

        const testPatterns = config.requireCorrespondingTest ? [expected] : include;
        const testFiles = allFiles.filter((file) => testPatterns.some((pattern) => matchesGlob(file, pattern)));

        for (const file of testFiles) {
            if (exclude.some((pattern) => matchesGlob(file, pattern))) continue;
            const violated = forbid.find((pattern) => matchesGlob(file, pattern));
            if (violated !== undefined) {
                findings.push(
                    createFinding(rule, `test file in forbidden location (matches "${violated}")`, file, {
                        code: 'test-location:forbidden',
                    }),
                );
                continue;
            }
            if (!matchesGlob(file, expected)) {
                findings.push(
                    createFinding(rule, `test file outside expected location (expected "${expected}")`, file, {
                        code: 'test-location:unexpected',
                    }),
                );
            }
        }

        if (config.requireCorrespondingTest) {
            const resolver = this.selectResolver(config.resolver);
            const srcPatterns = rule.include ?? ['**/*.ts', '**/*.tsx'];
            const testSet = new Set(testFiles);
            for (const srcFile of allFiles) {
                if (!srcPatterns.some((pattern) => matchesGlob(srcFile, pattern))) continue;
                if (exclude.some((pattern) => matchesGlob(srcFile, pattern))) continue;
                const testPath = resolver.resolveTestPath(srcFile);
                if (testPath === srcFile) continue;
                if (!testSet.has(testPath)) {
                    findings.push(
                        createFinding(rule, `no corresponding test → ${testPath}`, srcFile, {
                            code: 'test-location:missing',
                        }),
                    );
                }
            }
        }

        return { findings, fixes: [] };
    }

    /**
     * Pick the resolver named in config (default `typescript`).
     *
     * Falls back to the built-in TypeScript convention when no registry was
     * injected; throws if a named resolver is requested but not registered.
     */
    private selectResolver(name = 'typescript'): TestPathResolver {
        if (this.resolvers === undefined) {
            if (name !== 'typescript') {
                throw new Error(`test-location resolver "${name}" requested but no resolver registry is available`);
            }
            return TYPESCRIPT_FALLBACK;
        }
        return this.resolvers.get(name);
    }
}

/** Built-in TypeScript convention used when no resolver registry is injected. */
const TYPESCRIPT_FALLBACK: TestPathResolver = new TypeScriptTestPathResolver();
