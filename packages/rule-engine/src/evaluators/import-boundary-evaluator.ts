import { createNodeFileSystem } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { escapeRegExp, matchesGlob, scanFiles } from './file-utils';

/** A compiled boundary ready for file scanning. */
interface CompiledBoundary {
    scope: string;
    excludePatterns: string[];
    forbidden: Array<{ regex: RegExp; label: string; importOnly: boolean }>;
}

/**
 * Enforces architectural import boundaries without spawning a subprocess.
 *
 * Files matching a boundary's `scope` glob are scanned in-memory. Each forbidden
 * entry is either a string (matched as an import-specifier substring) or an object
 * with a `pattern` regex and an optional `mode` (`import` | `usage`).
 *
 * ## Options (in `evaluator.config`)
 * - `boundaries` — non-empty array of boundary declarations:
 *   - `scope` — glob pattern selecting files this boundary applies to.
 *   - `forbidden` — array of strings or `{ pattern, mode?, syntax? }` objects.
 *   - `exclude` — optional globs within the scope to ignore.
 *
 * Trust assumption: rule config is trusted input. A `pattern` is compiled with
 * `new RegExp` and run per line without a backtracking bound, so a
 * catastrophic-backtracking pattern is the rule author's responsibility. Runtime
 * ReDoS hardening is deferred (see task 0003).
 */
export class ImportBoundaryEvaluator implements RuleEvaluator {
    /** Evaluate import boundaries across all in-scope files. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const boundaries = config.boundaries;
        if (!Array.isArray(boundaries) || boundaries.length === 0) {
            throw new Error('import-boundary evaluator requires non-empty array config "boundaries"');
        }

        const compiled = boundaries.map((boundary, index) => compileBoundary(boundary, index));

        // Scan all files once (read up front); apply each boundary's globs in-memory below.
        const fs = context.fileSystem ?? createNodeFileSystem();
        const allFiles = await scanFiles({ workdir: context.workdir, matchMode: 'glob', fs });

        const findings = [];
        for (const boundary of compiled) {
            const inScope = allFiles
                .filter(({ file }) => matchesGlob(file, boundary.scope))
                .filter(({ file }) => !boundary.excludePatterns.some((ex) => matchesGlob(file, ex)));

            for (const { file, content } of inScope) {
                const lines = content.split('\n');
                for (const [index, line] of lines.entries()) {
                    for (const entry of boundary.forbidden) {
                        if (entry.importOnly && !isImportLine(line)) continue;
                        if (entry.regex.test(line)) {
                            findings.push(
                                createFinding(rule, `forbidden in boundary "${boundary.scope}": ${entry.label}`, file, {
                                    line: index + 1,
                                    code: 'import-boundary:violation',
                                }),
                            );
                        }
                    }
                }
            }
        }

        return { findings, fixes: [] };
    }
}

/** Compile a raw boundary declaration into a scan-ready form. */
function compileBoundary(decl: unknown, index: number): CompiledBoundary {
    if (!isRecord(decl)) {
        throw new Error(`import-boundary evaluator requires object config "boundaries[${index}]"`);
    }
    const scope = decl.scope;
    if (typeof scope !== 'string' || scope.length === 0) {
        throw new Error(`import-boundary evaluator requires string config "boundaries[${index}].scope"`);
    }
    const forbidden = decl.forbidden;
    if (!Array.isArray(forbidden) || forbidden.length === 0) {
        throw new Error(`import-boundary evaluator requires non-empty array config "boundaries[${index}].forbidden"`);
    }
    const exclude = decl.exclude;
    if (exclude !== undefined && !isStringArray(exclude)) {
        throw new Error(`import-boundary evaluator requires string[] config "boundaries[${index}].exclude"`);
    }

    return {
        scope,
        excludePatterns: exclude ?? [],
        forbidden: forbidden.map((entry, entryIndex) => compileEntry(entry, index, entryIndex)),
    };
}

/** Compile one forbidden entry into a regex + metadata. */
function compileEntry(
    entry: unknown,
    boundaryIndex: number,
    entryIndex: number,
): { regex: RegExp; label: string; importOnly: boolean } {
    if (typeof entry === 'string') {
        // String form: match as an import specifier substring.
        const escaped = escapeRegExp(entry);
        return {
            regex: new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*)['"](?:[^'"]*)?${escaped}(?:[^'"]*)?['"]`),
            label: entry,
            importOnly: true,
        };
    }

    if (!isRecord(entry) || typeof entry.pattern !== 'string' || entry.pattern.length === 0) {
        throw new Error(
            `import-boundary evaluator requires string config "boundaries[${boundaryIndex}].forbidden[${entryIndex}].pattern"`,
        );
    }
    if (entry.mode !== undefined && entry.mode !== 'import' && entry.mode !== 'usage') {
        throw new Error(
            `import-boundary evaluator requires "import" or "usage" config "boundaries[${boundaryIndex}].forbidden[${entryIndex}].mode"`,
        );
    }

    // Object form with `pattern`.
    const importOnly = (entry.mode ?? 'import') !== 'usage';
    return {
        regex: new RegExp(entry.pattern),
        label: entry.pattern,
        importOnly,
    };
}

/** Return true when a source line is an import/export/require/dynamic-import statement. */
function isImportLine(line: string): boolean {
    return /(?:^\s*import\b|^\s*export\b.*\bfrom\b|(?:from|require|import)\s*\(?\s*['"])/.test(line);
}

/** Return true when value is a plain object-ish config record. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Return true when every array item is a string. */
function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
