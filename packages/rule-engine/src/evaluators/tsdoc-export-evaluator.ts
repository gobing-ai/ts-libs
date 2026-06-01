import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { discoverFiles, matchesGlob, readWorkdirFile } from './file-utils';

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
    function: /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
    class: /^export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
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
    constructor() {
        // V8 function coverage requires explicit constructor
    }
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
        const files = await discoverFiles({ workdir: context.workdir, include: ['.ts', '.tsx'] });

        const findings = [];
        for (const file of files) {
            if (!include.some((pattern) => matchesGlob(file, pattern))) continue;
            if (exclude.some((pattern) => matchesGlob(file, pattern))) continue;
            const lines = (await readWorkdirFile(context.workdir, file)).split('\n');
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

/** True when the line immediately above a declaration closes a JSDoc block. */
function precededByJsdoc(lines: string[], declarationLine: number): boolean {
    const prev = lines[declarationLine - 2]?.trim();
    return prev !== undefined && (prev.endsWith('*/') || prev.startsWith('/**'));
}
