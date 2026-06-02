import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { escapeRegExp, matchesGlob, scanFiles } from './file-utils';

/**
 * A forbidden entry within a boundary declaration.
 *
 * - String form: substring match against any import/export/require/dynamic-import specifier.
 * - Object form: regex `pattern` matched against the full line (mode `usage`) or import lines
 *   only (mode `import`).
 */
type ForbiddenEntry =
    | string
    | {
          /** Regex pattern to match against lines. */
          pattern: string;
          /** `import` = restrict to import/export/require lines; `usage` = any line. Default: `import`. */
          mode?: 'import' | 'usage';
          /** Explicit syntax hint (informational, not enforced differently from `mode`). */
          syntax?: string;
      };

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

        const compiled = (boundaries as unknown as BoundaryDecl[]).map((b) => compileBoundary(b));

        // Scan all files once (read up front); apply each boundary's globs in-memory below.
        const allFiles = await scanFiles({ workdir: context.workdir, matchMode: 'glob' });

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

/** Raw shape of one boundary declaration from the config. */
interface BoundaryDecl {
    scope: string;
    forbidden: ForbiddenEntry[];
    exclude?: string[];
}

/** Compile a raw boundary declaration into a scan-ready form. */
function compileBoundary(decl: BoundaryDecl): CompiledBoundary {
    return {
        scope: decl.scope,
        excludePatterns: decl.exclude ?? [],
        forbidden: decl.forbidden.map((entry) => compileEntry(entry)),
    };
}

/** Compile one forbidden entry into a regex + metadata. */
function compileEntry(entry: ForbiddenEntry): { regex: RegExp; label: string; importOnly: boolean } {
    if (typeof entry === 'string') {
        // String form: match as an import specifier substring.
        const escaped = escapeRegExp(entry);
        return {
            regex: new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*)['"](?:[^'"]*)?${escaped}(?:[^'"]*)?['"]`),
            label: entry,
            importOnly: true,
        };
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
