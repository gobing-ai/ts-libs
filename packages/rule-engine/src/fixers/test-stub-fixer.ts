/**
 * Fixer that generates test file skeletons for source files missing tests.
 *
 * Resolver-aware: selects the correct {@link TestPathResolver} from
 * `rule.evaluator.config.resolver`. Passes empty exports to the resolver's
 * `generateSkeleton` — AST / sg discovery is intentionally omitted here to
 * keep the shared package dependency-free; callers that need export-aware
 * skeletons should register a custom resolver that performs its own discovery.
 * Never overwrites an existing test file.
 *
 * @module rule-engine/fixers/test-stub-fixer
 */

import { createNodeFileSystem, isAbsolutePath, joinPath, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import type { CapabilityRegistry } from '@gobing-ai/ts-runtime/extension';
import type { TestPathResolver } from '../resolvers/test-path-resolver';
import type { Fix } from '../types';
import type { RuleFixerInput, RuleFixerProvider } from './fixers';

/** File-system seam for dependency injection in tests. */
export interface TestStubFileSystem {
    /** Resolve to true if the path exists on disk. */
    exists(path: string): boolean | Promise<boolean>;
}

/** Real file-system implementation backed by the runtime FileSystem seam. */
export const realFileSystem: TestStubFileSystem = createNodeFileSystem();

/** Dependencies injected into {@link TestStubFixer}. */
export interface TestStubFixerDeps {
    /** Resolver registry from the engine host. */
    readonly resolvers: CapabilityRegistry<TestPathResolver>;
    /** Process executor (reserved for future export discovery). */
    readonly processExecutor: ProcessExecutor;
    /** Optional file-system override for testing. */
    readonly fileSystem?: TestStubFileSystem;
}

/** Normalize a finding path to a repository-relative POSIX path, or return null when invalid. */
function normalizeFindingPath(filePath: string): string | null {
    if (!filePath || isAbsolutePath(filePath)) return null;
    const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null;
    return normalized;
}

/**
 * Fixer provider for the `test-location` evaluator.
 *
 * Emits a create-file Fix (start=0, end=0) for each finding whose source file
 * has no corresponding test file yet. The test path and skeleton content are
 * produced by the resolver named in `rule.evaluator.config.resolver`
 * (default: `typescript`).
 */
export class TestStubFixer implements RuleFixerProvider {
    private readonly resolvers: CapabilityRegistry<TestPathResolver>;
    private readonly fs: TestStubFileSystem;

    constructor(deps: TestStubFixerDeps) {
        this.resolvers = deps.resolvers;
        // processExecutor is accepted for interface parity but export discovery
        // is not performed in this shared-package implementation — see module doc.
        this.fs = deps.fileSystem ?? realFileSystem;
    }

    /** Produce create-file fixes for missing test stubs. */
    async createFixes(input: RuleFixerInput): Promise<Fix[]> {
        const { rule, context, findings, fix } = input;

        if (fix.mode === 'none') return [];

        const resolverName = (rule.evaluator.config?.resolver as string | undefined) ?? 'typescript';
        let resolver: TestPathResolver;
        try {
            resolver = this.resolvers.get(resolverName);
        } catch {
            // Resolver not registered — return no fixes rather than silently falling back.
            return [];
        }

        const result: Fix[] = [];

        for (const finding of findings) {
            if (!finding.filePath) continue;

            const srcRelPath = normalizeFindingPath(finding.filePath);
            if (!srcRelPath) continue;

            let testRelPath: string;
            try {
                testRelPath = resolver.resolveTestPath(srcRelPath);
            } catch {
                continue;
            }

            const absTestPath = joinPath(context.workdir, testRelPath);
            if (await this.fs.exists(absTestPath)) continue;

            // Export discovery is intentionally omitted — pass empty exports array.
            // Resolvers that need per-export stubs should perform their own discovery.
            const skeleton = resolver.generateSkeleton?.(srcRelPath, []) ?? '';
            if (!skeleton) continue;

            result.push({
                ruleId: rule.id,
                filePath: testRelPath,
                start: 0,
                end: 0,
                replacement: skeleton,
                // fix.mode !== 'none' is guaranteed by the guard at the top of this method.
                mode: fix.mode as Exclude<typeof fix.mode, 'none'>,
            });
        }

        return result;
    }
}
