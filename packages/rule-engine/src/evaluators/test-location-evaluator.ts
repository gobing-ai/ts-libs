import {
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
}

/**
 * Evaluator that enforces where test files live and, optionally, that every
 * source file has a corresponding test.
 *
 * Config (`evaluator.config`):
 * - `expected`: glob the test files must match (required)
 * - `forbid`: globs where tests must not live (e.g. `**\/__tests__/**`)
 * - `requireCorrespondingTest`: when true, flags source files (from `rule.include`)
 *   that lack a test at the TypeScript-conventional path
 *
 * Discovery walks the workdir and applies `**` globs precisely, so it stays
 * self-contained (no `rg --files` shell-out).
 */
export class TestLocationEvaluator implements RuleEvaluator {
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
        const allFiles = await discoverFiles({ workdir: context.workdir });
        const findings = [];

        const testPatterns = config.requireCorrespondingTest ? [expected] : include;
        const testFiles = allFiles.filter((file) => testPatterns.some((pattern) => matchesGlob(file, pattern)));

        for (const file of testFiles) {
            if (exclude.some((pattern) => matchesGlob(file, pattern))) continue;
            const violated = forbid.find((pattern) => matchesGlob(file, pattern));
            if (violated !== undefined) {
                findings.push(
                    createFinding(
                        rule,
                        `Test file "${file}" is in a forbidden location (matches "${violated}")`,
                        file,
                        {
                            code: 'test-location:forbidden',
                        },
                    ),
                );
                continue;
            }
            if (!matchesGlob(file, expected)) {
                findings.push(
                    createFinding(rule, `Test file "${file}" does not match expected pattern "${expected}"`, file, {
                        code: 'test-location:unexpected',
                    }),
                );
            }
        }

        if (config.requireCorrespondingTest) {
            const srcPatterns = rule.include ?? ['**/*.ts', '**/*.tsx'];
            const testSet = new Set(testFiles);
            for (const srcFile of allFiles) {
                if (!srcPatterns.some((pattern) => matchesGlob(srcFile, pattern))) continue;
                if (exclude.some((pattern) => matchesGlob(srcFile, pattern))) continue;
                const testPath = resolveTestPath(srcFile);
                if (testPath === srcFile) continue;
                if (!testSet.has(testPath)) {
                    findings.push(
                        createFinding(
                            rule,
                            `Source file "${srcFile}" has no corresponding test → ${testPath}`,
                            srcFile,
                            {
                                code: 'test-location:missing',
                            },
                        ),
                    );
                }
            }
        }

        return { findings, fixes: [] };
    }
}

/**
 * Map a TypeScript source path to its conventional test path.
 *
 *   packages/core/src/foo/bar.ts → packages/core/tests/foo/bar.test.ts
 *   src/foo/bar.ts               → tests/foo/bar.test.ts
 */
function resolveTestPath(srcRelPath: string): string {
    if (srcRelPath.includes('.test.') || srcRelPath.includes('.spec.')) return srcRelPath;
    const srcIdx = srcRelPath.indexOf('/src/');
    if (srcIdx !== -1) {
        const pkg = srcRelPath.slice(0, srcIdx);
        const rel = srcRelPath.slice(srcIdx + '/src/'.length).replace(/\.(ts|tsx|js|jsx)$/, '.test.ts');
        return `${pkg}/tests/${rel}`;
    }
    const withoutExt = srcRelPath.replace(/\.(ts|tsx|js|jsx)$/, '');
    return `tests/${withoutExt.replace(/^src\//, '')}.test.ts`;
}
