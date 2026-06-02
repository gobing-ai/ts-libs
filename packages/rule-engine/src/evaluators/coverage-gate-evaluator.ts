import { isAbsolute, relative, resolve } from 'node:path';
import { NodeFileSystem } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';
import { matchesGlob } from './file-utils';

/** Single-file coverage extracted from an lcov record. */
interface FileCoverage {
    linesFound: number;
    linesHit: number;
}

/** Per-file threshold override with justification. */
interface CoverageExemption {
    path: string;
    threshold: number;
    reason: string;
}

/** Evaluator config shape extracted from `rule.evaluator.config`. */
interface CoverageGateConfig {
    lcovPath?: string;
    threshold?: number;
    include?: string[];
    exclude?: string[];
    exemptions?: CoverageExemption[];
}

/**
 * Coverage gate evaluator — reads an lcov tracefile and enforces per-file line
 * coverage thresholds.
 *
 * Config (`evaluator.config`):
 * - `lcovPath`: path to lcov.info (default: `coverage/lcov.info`)
 * - `threshold`: default line-coverage percentage (default: `90`)
 * - `include` / `exclude`: glob patterns scoping the check
 * - `exemptions`: per-file threshold overrides with a reason
 *
 * A missing lcov file is reported as a single non-blocking finding rather than an
 * error, so the gate degrades gracefully when coverage was not generated.
 */
export class CoverageGateEvaluator implements RuleEvaluator {
    private readonly fs: NodeFileSystem;

    constructor() {
        this.fs = new NodeFileSystem();
    }

    /** Evaluate per-file coverage against the configured threshold. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = (rule.evaluator.config ?? {}) as CoverageGateConfig;
        const lcovPath = config.lcovPath
            ? resolve(context.workdir, config.lcovPath)
            : resolve(context.workdir, 'coverage', 'lcov.info');

        if (!(await this.fs.exists(lcovPath))) {
            return {
                findings: [
                    createFinding(rule, 'No lcov file found — coverage not generated. Skipping gate.', lcovPath, {
                        code: 'coverage:missing-lcov',
                    }),
                ],
                fixes: [],
            };
        }

        const coverage = parseLcov(await this.fs.readFile(lcovPath));
        const threshold = config.threshold ?? 90;
        const exemptions = new Map((config.exemptions ?? []).map((entry) => [entry.path, entry]));
        const findings = [];

        for (const [rawPath, cov] of coverage) {
            if (cov.linesFound === 0) continue;
            const filePath = normalizeLcovSourcePath(context.workdir, rawPath);
            if (config.include !== undefined && !config.include.some((p) => matchesGlob(filePath, p))) continue;
            if (config.exclude?.some((p) => matchesGlob(filePath, p))) continue;
            if (isAlwaysExcluded(filePath)) continue;

            const pct = Math.round((cov.linesHit / cov.linesFound) * 100);
            const exemption = exemptions.get(filePath);
            const effectiveThreshold = exemption?.threshold ?? threshold;
            if (pct >= effectiveThreshold) continue;

            const message = exemption
                ? `${pct}% line coverage (exemption: ${effectiveThreshold}%, reason: ${exemption.reason})`
                : `${pct}% line coverage (threshold: ${effectiveThreshold}%)`;
            findings.push(createFinding(rule, message, filePath, { code: 'coverage:below-threshold' }));
        }

        return { findings, fixes: [] };
    }
}

/** Parse an lcov tracefile into a map of source path → coverage counts. */
function parseLcov(raw: string): Map<string, FileCoverage> {
    const result = new Map<string, FileCoverage>();
    let file: string | null = null;
    let linesFound: number | null = 0;
    let linesHit: number | null = 0;
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('SF:')) {
            file = trimmed.slice(3);
            linesFound = 0;
            linesHit = 0;
        } else if (trimmed.startsWith('LF:')) {
            linesFound = parseCount(trimmed.slice(3));
        } else if (trimmed.startsWith('LH:')) {
            linesHit = parseCount(trimmed.slice(3));
        } else if (trimmed === 'end_of_record' && file !== null) {
            // Skip records with malformed counts: a non-numeric LF:/LH: would
            // otherwise yield NaN coverage and a spurious below-threshold finding.
            if (linesFound !== null && linesHit !== null) {
                result.set(file, { linesFound, linesHit });
            }
            file = null;
        }
    }
    return result;
}

/** Parse an lcov count field; return null for non-finite or negative values. */
function parseCount(raw: string): number | null {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Standard exclusions applied regardless of config (tests, generated, deps). */
function isAlwaysExcluded(filePath: string): boolean {
    return (
        filePath.includes('node_modules') ||
        filePath.includes('.test.') ||
        filePath.includes('.spec.') ||
        filePath.includes('__tests__')
    );
}

/** Normalize an lcov `SF:` path to a workdir-relative forward-slash path. */
function normalizeLcovSourcePath(workdir: string, filePath: string): string {
    const normalized = isAbsolute(filePath) ? relative(workdir, filePath) : filePath;
    return normalized.replaceAll('\\', '/');
}
