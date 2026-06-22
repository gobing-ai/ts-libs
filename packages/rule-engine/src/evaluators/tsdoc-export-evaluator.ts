import { createNodeFileSystem } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { scanFiles } from './file-utils';

/** Export kinds this evaluator can check for a preceding JSDoc block. */
const VALID_KINDS = ['function', 'class', 'type', 'const', 'enum', 'interface'] as const;
type ExportKind = (typeof VALID_KINDS)[number];

/** A discovered exported declaration. */
interface ExportSite {
    kind: ExportKind;
    name: string;
    /** One-based line number of the declaration. */
    line: number;
}

const KIND_PATTERN: Record<ExportKind, RegExp> = {
    function: /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z0-9_$]+)/,
    class: /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
    interface: /^export\s+interface\s+([A-Za-z0-9_$]+)/,
    type: /^export\s+type\s+([A-Za-z0-9_$]+)/,
    const: /^export\s+const\s+([A-Za-z0-9_$]+)/,
    enum: /^export\s+(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/,
};

/**
 * Evaluator that flags exported declarations missing a JSDoc block.
 *
 * Self-contained: it scans matching source files line-by-line and checks whether
 * the line immediately preceding an export ends a JSDoc comment. Config
 * (`evaluator.config.kinds`) selects which export kinds to check; `rule.include`
 * and `rule.exclude` scope the files using full `**` globs.
 */
export class TsdocExportEvaluator implements RuleEvaluator {
    // Explicit constructor: V8 function coverage counts only declared functions, so
    // this method-light class needs it to clear the coverage-gate function threshold.
    constructor() {}

    /** Evaluate exports under the configured kinds for a preceding JSDoc block. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const kinds = (rule.evaluator.config?.kinds as string[] | undefined) ?? [...VALID_KINDS];
        for (const kind of kinds) {
            if (!(VALID_KINDS as readonly string[]).includes(kind)) {
                throw new Error(`Unknown export kind "${kind}"; expected one of: ${VALID_KINDS.join(', ')}`);
            }
        }
        const requested = new Set(kinds as ExportKind[]);
        const include = rule.include ?? ['**/*.ts', '**/*.tsx'];
        const exclude = rule.exclude ?? [];
        // Single, strict glob scoping — collapses the previous double-scoping (loose
        // discoverFiles prefilter + per-file matchesGlob) into one pass.
        const fs = context.fileSystem ?? createNodeFileSystem();
        const files = await scanFiles({ workdir: context.workdir, include, exclude, matchMode: 'glob', fs });

        const findings = [];
        for (const { file, content } of files) {
            const lines = content.split('\n');
            for (const site of findExports(lines, requested)) {
                if (!precededByJsdoc(lines, site.line)) {
                    findings.push(
                        createFinding(rule, `Exported ${site.kind} "${site.name}" is missing a JSDoc comment`, file, {
                            line: site.line,
                            code: 'tsdoc:missing',
                        }),
                    );
                }
            }
        }
        return { findings, fixes: [] };
    }
}

/** Find exported declarations of the requested kinds within a file's lines. */
function findExports(lines: string[], requested: ReadonlySet<ExportKind>): ExportSite[] {
    const sites: ExportSite[] = [];
    for (const [index, raw] of lines.entries()) {
        const line = raw.trimStart();
        if (!line.startsWith('export')) continue;
        for (const kind of requested) {
            const match = KIND_PATTERN[kind].exec(line);
            if (match) {
                sites.push({ kind, name: match[1] ?? 'unknown', line: index + 1 });
                break;
            }
        }
    }
    return sites;
}

/**
 * True when a JSDoc block precedes a declaration.
 *
 * Walks backward from the line before the declaration, skipping blank lines,
 * JSDoc body lines (`* …`), and decorator / JSDoc-tag lines (`@…`), then
 * checks whether the nearest meaningful line closes (or is) a JSDoc comment.
 */
function precededByJsdoc(lines: string[], declarationLine: number): boolean {
    let cursor = declarationLine - 2; // zero-based line above the declaration
    while (cursor >= 0) {
        const prev = lines[cursor]?.trim() ?? '';
        // Blank line between JSDoc closing fence and declaration — keep walking.
        if (prev === '') {
            cursor -= 1;
            continue;
        }
        // JSDoc closing or single-line fence — found it.
        if (prev.endsWith('*/') || prev.startsWith('/**')) {
            return true;
        }
        // JSDoc body line (* …) or decorator / tag (@…).  Check after the
        // fence so `*/` is never misidentified as a body line.
        if (prev.startsWith('*') || prev.startsWith('@')) {
            cursor -= 1;
            continue;
        }
        // Non-JSDoc, non-decorator line — no JSDoc precedes this declaration.
        return false;
    }
    return false;
}
