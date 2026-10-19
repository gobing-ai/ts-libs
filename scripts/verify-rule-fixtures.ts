#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
// Repository tooling, not a package consumer: reach the workspace source directly so the gate needs
// no prior `bun run build` (the root tsconfig declares no paths to workspace packages, and each
// package's `exports` points at its unbuilt `dist/`).
import {
    type RuleFixtureCase,
    type RuleFixtureCaseResult,
    verifyRuleFixtures,
} from '../packages/rule-engine/src/fixture-verifier';
import { echo, echoError } from '../packages/utils/src/index';
import { repoRoot as projectRoot } from './config';
import fixtureHashes from './rule-fixture-hashes.json';

/** Required outcome for a case: a genuine violation, or silence. */
type Expectation = 'fire' | 'pass';

/** Both declared expectation classes; a set missing either one fails rather than skips. */
const EXPECTATIONS: readonly Expectation[] = ['fire', 'pass'];

/** Fixture directory backing each expectation class. */
const EXPECTATION_DIRS: Readonly<Record<Expectation, string>> = {
    fire: 'should-fire',
    pass: 'should-pass',
};

/** Fixture root, relative to the repository root. */
const FIXTURES_ROOT = '.spur/rules/fixtures';

/** Rule ID backing the lifecycle-bus-propagation fixture set. */
const LIFECYCLE_RULE_ID = 'lifecycle-bus-propagation';

/** Support file every lifecycle fixture stages beside its asserted source. */
const LIFECYCLE_SUPPORT_FILE = 'events.ts';

/** Package directory the lifecycle evaluator derives its package scope from. */
const LIFECYCLE_STAGE_ROOT = 'packages/demo/src';

/** Directory under an expectation holding one multi-file crossfile case. */
const LIFECYCLE_CROSSFILE_DIR = 'crossfile';

/** Rule ID backing the verify-confidence fixture set. */
const VERIFY_CONFIDENCE_RULE_ID = 'verify-confidence-level';

/** Rule ID backing the evidence-citation fixture set. */
const EVIDENCE_CITATION_RULE_ID = 'evidence-citation';

/** Rule ID backing the changelog-verification fixture set. */
const CHANGELOG_RULE_ID = 'changelog-verification-confidence';

/** Rule ID backing the changelog-claim-citation fixture set. */
const CHANGELOG_CLAIM_RULE_ID = 'changelog-claim-citation';

/** File every changelog-plane case stages at its workdir root. */
const CHANGELOG_FIXTURE_FILE = 'CHANGELOG.md';

/**
 * Decision-boundary rule asserted per package directory. The manifest-direction rule
 * (`no-clef-dependency-in-ai-runner-manifest`) is deliberately absent: its subject is a
 * package.json, which cannot be duplicated into a fixture without a second source of truth.
 */
const DECISION_BOUNDARY_RULES: Readonly<Record<string, string>> = {
    'ai-runner': 'no-clef-driver-import-in-ai-runner',
    'decision-clef': 'no-ai-decision-import-in-decision-clef',
    // The SDK rule's subject moved to ai-decision in ADR-039; decision-fm is the stand-in package
    // directory because ai-decision owns the exempt file the rule must NOT fire on.
    'decision-fm': 'no-typesafe-sdk-import-outside-ai-decision',
};

/** A declared fixture set: the rule file it exercises, its case inventory, and where its cases live. */
interface FixtureSetDeclaration {
    /** Set directory name under {@link FIXTURES_ROOT}. */
    set: string;
    /** Rule file, relative to the repository root. */
    ruleFile: string;
    /**
     * Case/rule pairs each expectation class must declare. The adapter plans cases from disk, so
     * without this a deleted (or added) fixture is invisible: the plan simply shrinks and every
     * remaining pair passes. The counts make the inventory explicit, so a reduced set fails by name
     * instead of passing vacuously.
     */
    expected: Readonly<Record<Expectation, number>>;
}

/** The declared fixture sets this gate asserts, with their declared case inventory. */
const FIXTURE_SETS: readonly FixtureSetDeclaration[] = [
    {
        set: 'lifecycle-bus-propagation',
        ruleFile: '.spur/rules/typescript/lifecycle-bus-propagation.yaml',
        expected: { fire: 2, pass: 3 },
    },
    {
        set: 'decision-boundaries',
        ruleFile: '.spur/rules/typescript/decision-boundaries.yaml',
        expected: { fire: 3, pass: 3 },
    },
    {
        set: 'verify-confidence',
        ruleFile: '.spur/rules/quality/verify-confidence.yaml',
        expected: { fire: 14, pass: 10 },
    },
    {
        set: 'evidence-citation',
        ruleFile: '.spur/rules/quality/evidence-citation.yaml',
        expected: { fire: 3, pass: 6 },
    },
    {
        set: 'changelog-verification',
        ruleFile: '.spur/rules/quality/changelog-verification-confidence.yaml',
        expected: { fire: 4, pass: 5 },
    },
    {
        set: 'changelog-claim-citation',
        ruleFile: '.spur/rules/quality/changelog-claim-citation.yaml',
        expected: { fire: 3, pass: 6 },
    },
];

/** A single fixture file and where it lands inside the case workdir. */
interface StagedFile {
    /** Workdir-relative destination path. */
    relative: string;
    /** Absolute path of the checked-in fixture file (only ever read). */
    absolute: string;
}

/** One planned assertion: the fixture source it asserts and the files staged for it. */
interface PlannedCase {
    /** Set-relative source path, used for the existence check and every diagnostic. */
    source: string;
    /** Rule IDs asserted for this case. */
    ruleIds: readonly string[];
    /** Required outcome for every asserted rule. */
    expect: Expectation;
    /** Files staged into the case workdir. */
    files: readonly StagedFile[];
}

/** Counts for a case/rule subset, split by expectation. */
export interface RuleFixtureCounts {
    /** Every counted case/rule pair. */
    total: number;
    /** Expected-fire pairs. */
    fire: number;
    /** Expected-pass pairs. */
    pass: number;
}

/** One set's summary row. */
export interface RuleFixtureSetReport {
    /** Fixture set directory name. */
    set: string;
    /** Rule file the set exercises, relative to the repository root. */
    ruleFile: string;
    /** Case/rule pairs asserted. */
    cases: RuleFixtureCounts;
    /** Case/rule pairs that matched their expectation. */
    passed: RuleFixtureCounts;
    /** Case/rule pairs that did not match their expectation. */
    failed: RuleFixtureCounts;
}

/** One case/rule result, with temp paths stripped and captured streams bounded. */
export interface RuleFixtureResultRow {
    /** Fixture set the case belongs to. */
    set: string;
    /** Set-relative source path the case asserts. */
    source: string;
    /** Rule ID asserted. */
    ruleId: string;
    /** Required outcome. */
    expect: Expectation;
    /** Whether the recorded evaluation matched the expectation. */
    pass: boolean;
    /** Number of findings recorded for the pair. */
    findings: number;
    /** Recorded findings, projected to their diagnostic fields. */
    violations: readonly {
        /** `error` for an evaluator error, otherwise `violation`. */
        kind: string;
        /** Evaluator message. */
        message: string;
        /** Path the finding names, when one was recorded. */
        filePath: string | null;
        /** One-based line number, when recorded. */
        line?: number;
    }[];
    /** Process outcomes recorded while evaluating the pair. */
    processes: readonly {
        /** Exit code, or null when no normal exit was observed. */
        exitCode: number | null;
        /** Terminal classification of the run. */
        outcome?: string;
        /** Terminating signal, when recorded. */
        signal?: string;
        /** Bounded stdout. */
        stdout: string;
        /** Bounded stderr. */
        stderr: string;
    }[];
    /** Failure reason; absent when the pair passed. */
    error?: string;
}

/** The machine-readable report capturing one sweep of every fixture set. */
export interface RuleFixtureReport {
    /** True when every asserted case/rule pair matched its expectation. */
    pass: boolean;
    /** Aggregate counts across all sets. */
    totals: {
        /** Number of fixture sets asserted. */
        sets: number;
        /** Every asserted case/rule pair. */
        cases: RuleFixtureCounts;
        /** Case/rule pairs that matched their expectation. */
        passed: RuleFixtureCounts;
        /** Case/rule pairs that did not match their expectation. */
        failed: RuleFixtureCounts;
    };
    /** Per-set summaries. */
    sets: RuleFixtureSetReport[];
    /** Per case/rule rows in evaluation order. */
    results: RuleFixtureResultRow[];
    /** Set when the sweep could not complete (invalid configuration or I/O failure). */
    error?: string;
}

/** Characters of captured process output retained per stream in the report. */
const STREAM_LIMIT = 2000;

/** Recursively collect regular files under `root`, hidden entries included, in sorted order. */
async function walkRelativeFiles(root: string, label: string): Promise<string[]> {
    const found: string[] = [];

    async function visit(prefix: string): Promise<void> {
        const entries = await readdir(join(root, prefix), { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                await visit(relative);
                continue;
            }
            if (!entry.isFile()) {
                throw new Error(`unrecognized non-file fixture entry "${label}/${relative}"`);
            }
            found.push(relative);
        }
    }

    await visit('');
    return found;
}

/** Assert a set directory and both expectation classes exist, so deletion cannot skip the gate. */
async function assertSetDirectories(setDir: string, set: string): Promise<void> {
    const directories = [setDir, ...EXPECTATIONS.map((expect) => join(setDir, EXPECTATION_DIRS[expect]))];
    for (const directory of directories) {
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
        if (entries === null) {
            const relative = directory === setDir ? '' : directory.slice(setDir.length + 1);
            throw new Error(`declared fixture directory "${set}${relative === '' ? '' : `/${relative}`}" is missing`);
        }
    }
}

/** Plan the lifecycle-bus-propagation set: flat source cases plus one crossfile group. */
async function planLifecycleCases(setDir: string, expect: Expectation): Promise<PlannedCase[]> {
    const expectDirName = EXPECTATION_DIRS[expect];
    const label = `lifecycle-bus-propagation/${expectDirName}`;
    const expectDir = join(setDir, expectDirName);
    const files = await walkRelativeFiles(expectDir, label);
    const support = files.find((relative) => relative === LIFECYCLE_SUPPORT_FILE);
    if (support === undefined) {
        throw new Error(`${label}: required support file "${LIFECYCLE_SUPPORT_FILE}" is missing`);
    }
    const supportFile: StagedFile = {
        relative: `${LIFECYCLE_STAGE_ROOT}/${LIFECYCLE_SUPPORT_FILE}`,
        absolute: join(expectDir, LIFECYCLE_SUPPORT_FILE),
    };

    const planned: PlannedCase[] = [];
    for (const relative of files) {
        if (relative.startsWith(`${LIFECYCLE_CROSSFILE_DIR}/`)) continue;
        if (relative === LIFECYCLE_SUPPORT_FILE) continue;
        if (relative.includes('/') || !relative.endsWith('.ts')) {
            throw new Error(
                `unrecognized fixture shape "${label}/${relative}": a lifecycle case is a flat .ts source, "${LIFECYCLE_SUPPORT_FILE}" support, or a "${LIFECYCLE_CROSSFILE_DIR}/" group`,
            );
        }
        planned.push({
            source: `${expectDirName}/${relative}`,
            ruleIds: [LIFECYCLE_RULE_ID],
            expect,
            files: [
                { relative: `${LIFECYCLE_STAGE_ROOT}/${relative}`, absolute: join(expectDir, relative) },
                supportFile,
            ],
        });
    }

    const crossfile = files.filter((relative) => relative.startsWith(`${LIFECYCLE_CROSSFILE_DIR}/`));
    if (crossfile.length > 0) {
        planned.push({
            source: `${expectDirName}/${LIFECYCLE_CROSSFILE_DIR}`,
            ruleIds: [LIFECYCLE_RULE_ID],
            expect,
            files: crossfile.map((relative) => ({
                relative: relative.slice(LIFECYCLE_CROSSFILE_DIR.length + 1),
                absolute: join(expectDir, relative),
            })),
        });
    }

    return planned;
}

/** Plan the decision-boundaries set: one case per source, mapped to its package's rule. */
async function planDecisionBoundaryCases(setDir: string, expect: Expectation): Promise<PlannedCase[]> {
    const expectDirName = EXPECTATION_DIRS[expect];
    const label = `decision-boundaries/${expectDirName}`;
    const expectDir = join(setDir, expectDirName);
    const files = await walkRelativeFiles(expectDir, label);

    return files.map((relative) => {
        const [, packageName, fileName] = /^packages\/([^/]+)\/src\/(.+\.ts)$/.exec(relative) ?? [];
        if (packageName === undefined || fileName === undefined) {
            throw new Error(
                `unrecognized fixture shape "${label}/${relative}": a decision-boundaries case is packages/<pkg>/src/<file>.ts`,
            );
        }
        const ruleId = DECISION_BOUNDARY_RULES[packageName];
        if (ruleId === undefined) {
            throw new Error(`no decision-boundary rule is mapped to package "${packageName}" (${label}/${relative})`);
        }
        return {
            source: `${expectDirName}/${relative}`,
            ruleIds: [ruleId],
            expect,
            files: [{ relative, absolute: join(expectDir, relative) }],
        };
    });
}

/**
 * Plan a verdict-plane set (verify-confidence, evidence-citation): each staged
 * verdict JSON is one isolated case on the `.spur/run|memory/evidence` plane.
 */
async function planVerdictPlaneCases(
    set: string,
    ruleId: string,
    setDir: string,
    expect: Expectation,
): Promise<PlannedCase[]> {
    const expectDirName = EXPECTATION_DIRS[expect];
    const label = `${set}/${expectDirName}`;
    const expectDir = join(setDir, expectDirName);
    const files = await walkRelativeFiles(expectDir, label);

    return files.map((relative) => {
        if (!/^\.spur\/(?:run|memory\/evidence)\/[^/]+\.json$/.test(relative)) {
            throw new Error(
                `unrecognized fixture shape "${label}/${relative}": a ${set} case is .spur/run/<file>.json or .spur/memory/evidence/<file>.json`,
            );
        }
        return {
            source: `${expectDirName}/${relative}`,
            ruleIds: [ruleId],
            expect,
            files: [{ relative, absolute: join(expectDir, relative) }],
        };
    });
}

/** Plan a changelog-plane set: each case is a directory holding one whole CHANGELOG.md. */
async function planChangelogCases(
    set: string,
    ruleId: string,
    setDir: string,
    expect: Expectation,
): Promise<PlannedCase[]> {
    const expectDirName = EXPECTATION_DIRS[expect];
    const label = `${set}/${expectDirName}`;
    const expectDir = join(setDir, expectDirName);
    const entries = await readdir(expectDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    const planned: PlannedCase[] = [];
    for (const entry of entries) {
        // The rule reads the one file at the workdir root, so the case directory carries the id and
        // the copy inside it always stages as CHANGELOG.md. A symlink is neither, and is rejected
        // rather than followed: it would take the pinned content outside the fixture set.
        const contents = entry.isDirectory() ? await readdir(join(expectDir, entry.name)) : [];
        if (!contents.includes(CHANGELOG_FIXTURE_FILE)) {
            throw new Error(
                `unrecognized fixture shape "${label}/${entry.name}": a ${set} case is a directory holding "${CHANGELOG_FIXTURE_FILE}"`,
            );
        }
        planned.push({
            source: `${expectDirName}/${entry.name}`,
            ruleIds: [ruleId],
            expect,
            files: [
                { relative: CHANGELOG_FIXTURE_FILE, absolute: join(expectDir, entry.name, CHANGELOG_FIXTURE_FILE) },
            ],
        });
    }

    return planned;
}

/** Shape planners, keyed by fixture set directory name. */
const SET_PLANNERS: Readonly<Record<string, (setDir: string, expect: Expectation) => Promise<PlannedCase[]>>> = {
    'lifecycle-bus-propagation': planLifecycleCases,
    'decision-boundaries': planDecisionBoundaryCases,
    'verify-confidence': (setDir, expect) =>
        planVerdictPlaneCases('verify-confidence', VERIFY_CONFIDENCE_RULE_ID, setDir, expect),
    'evidence-citation': (setDir, expect) =>
        planVerdictPlaneCases('evidence-citation', EVIDENCE_CITATION_RULE_ID, setDir, expect),
    'changelog-verification': (setDir, expect) =>
        planChangelogCases('changelog-verification', CHANGELOG_RULE_ID, setDir, expect),
    'changelog-claim-citation': (setDir, expect) =>
        planChangelogCases('changelog-claim-citation', CHANGELOG_CLAIM_RULE_ID, setDir, expect),
};

/** Stage one planned case into a scratch workdir and return its engine declaration. */
async function stageCase(
    scratchRoot: string,
    set: string,
    index: number,
    planned: PlannedCase,
): Promise<RuleFixtureCase> {
    const workdir = join(scratchRoot, set, `case-${index}`);
    for (const file of planned.files) {
        const target = join(workdir, file.relative);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(file.absolute, target);
    }
    return { path: planned.source, workdir, ruleIds: [...planned.ruleIds], expect: planned.expect };
}

/** Bound a captured stream so one failing evaluator cannot flood the report. */
function boundedStream(stream: string): string {
    if (stream.length <= STREAM_LIMIT) return stream;
    return `${stream.slice(0, STREAM_LIMIT)}\n… truncated (${stream.length - STREAM_LIMIT} chars omitted)`;
}

/** Project an engine case result into a temp-path-free report row. */
function toResultRow(set: string, result: RuleFixtureCaseResult): RuleFixtureResultRow {
    return {
        set,
        source: result.path,
        ruleId: result.ruleId,
        expect: result.expect,
        pass: result.pass,
        findings: result.findings.length,
        violations: result.findings.map((finding) => ({
            kind: finding.kind ?? 'violation',
            message: boundedStream(finding.message),
            filePath: finding.filePath,
            ...(finding.line === undefined ? {} : { line: finding.line }),
        })),
        processes: result.processes.map((process) => ({
            exitCode: process.exitCode,
            ...(process.outcome === undefined ? {} : { outcome: process.outcome }),
            ...(process.signal === undefined ? {} : { signal: process.signal }),
            stdout: boundedStream(process.stdout),
            stderr: boundedStream(process.stderr),
        })),
        ...(result.error === undefined ? {} : { error: result.error }),
    };
}

/** Tally counts for one row subset. */
function tally(rows: readonly RuleFixtureResultRow[]): RuleFixtureCounts {
    return {
        total: rows.length,
        fire: rows.filter((row) => row.expect === 'fire').length,
        pass: rows.filter((row) => row.expect === 'pass').length,
    };
}

/** A zeroed count triple, used when the sweep cannot complete. */
function emptyCounts(): RuleFixtureCounts {
    return { total: 0, fire: 0, pass: 0 };
}

/** Assemble the failure report written when the sweep throws. */
function failureReport(error: unknown): RuleFixtureReport {
    return {
        pass: false,
        totals: { sets: 0, cases: emptyCounts(), passed: emptyCounts(), failed: emptyCounts() },
        sets: [],
        results: [],
        error: error instanceof Error ? error.message : String(error),
    };
}

/** Sweep every fixture set and collect the report; throws only on a scratch or report-write failure. */
async function collectReport(repoRoot: string): Promise<RuleFixtureReport> {
    const fixturesRoot = join(repoRoot, FIXTURES_ROOT);
    const scratchRoot = await mkdtemp(join(tmpdir(), 'ts-libs-rule-fixtures-'));
    const sets: RuleFixtureSetReport[] = [];
    const results: RuleFixtureResultRow[] = [];

    try {
        for (const declaration of FIXTURE_SETS) {
            const planner = SET_PLANNERS[declaration.set];
            if (planner === undefined) throw new Error(`no fixture-shape planner for set "${declaration.set}"`);
            const setDir = join(fixturesRoot, declaration.set);
            await assertSetDirectories(setDir, declaration.set);

            const planned: PlannedCase[] = [];
            for (const expect of EXPECTATIONS) {
                const plannedForExpectation = await planner(setDir, expect);
                const declared = declaration.expected[expect];
                if (plannedForExpectation.length !== declared) {
                    throw new Error(
                        `declared case inventory mismatch for "${declaration.set}/${EXPECTATION_DIRS[expect]}": declared ${declared} case(s), found ${plannedForExpectation.length} — a fixture case was deleted or added; update the fixture and its declaration in scripts/verify-rule-fixtures.ts together`,
                    );
                }
                planned.push(...plannedForExpectation);
            }

            const cases: RuleFixtureCase[] = [];
            for (const [index, entry] of planned.entries()) {
                cases.push(await stageCase(scratchRoot, declaration.set, index, entry));
            }

            const verification = await verifyRuleFixtures({
                ruleFile: join(repoRoot, declaration.ruleFile),
                fixtureDir: setDir,
                cases,
            });

            // Pin support files too: an empty failure fixture can still satisfy a fail-closed rule.
            for (const [index, entry] of planned.entries()) {
                for (const file of entry.files) {
                    const source = relative(fixturesRoot, file.absolute).split(sep).join('/');
                    const expected = (fixtureHashes as Record<string, string>)[source];
                    const actual = createHash('sha256')
                        .update(await readFile(join(cases[index].workdir, file.relative)))
                        .digest('hex');
                    if (actual === expected) continue;
                    for (const result of verification.cases.filter((result) => result.path === entry.source)) {
                        result.pass = false;
                        result.error =
                            `${result.error ?? ''}\nfixture content changed: ${source}; update scripts/rule-fixture-hashes.json with intentional fixture edits`.trim();
                    }
                }
            }

            const setRows = verification.cases.map((result) => toResultRow(declaration.set, result));
            results.push(...setRows);
            sets.push({
                set: declaration.set,
                ruleFile: declaration.ruleFile,
                cases: tally(setRows),
                passed: tally(setRows.filter((row) => row.pass)),
                failed: tally(setRows.filter((row) => !row.pass)),
            });
        }

        const failedRows = results.filter((row) => !row.pass);
        return {
            pass: failedRows.length === 0 && results.length > 0,
            totals: {
                sets: sets.length,
                cases: tally(results),
                passed: tally(results.filter((row) => row.pass)),
                failed: tally(failedRows),
            },
            sets,
            results,
        };
    } finally {
        await rm(scratchRoot, { recursive: true, force: true });
    }
}

/**
 * Verify the repository's rule fixtures against the real evaluators and write the JSON report.
 *
 * Enumerates all three declared fixture sets from disk, stages every case into a scratch workdir
 * under the OS temp dir, and asserts each case/rule pair through {@link verifyRuleFixtures}.
 * Checked-in fixtures are only ever read, and no case evaluates the live repository. A missing
 * declared directory, an unrecognized fixture shape, or an invalid rule file fails the sweep with
 * a named reason and a written report rather than skipping it.
 *
 * @param repoRoot - Repository root the declared fixture sets and rule files resolve under.
 * @param reportPath - Report path; parent directories are created when absent.
 * @returns The report written to `reportPath`.
 */
export async function runRuleFixtureChecks(repoRoot: string, reportPath: string): Promise<RuleFixtureReport> {
    let report: RuleFixtureReport;
    try {
        report = await collectReport(repoRoot);
    } catch (error) {
        report = failureReport(error);
    }
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
}

/**
 * Print the per-set summary and every failing pair.
 *
 * @param report - Report to render; a sweep that could not complete prints its single reason line.
 */
export function printReport(report: RuleFixtureReport): void {
    if (report.error !== undefined) {
        echoError(`rule-fixtures: FAIL — ${report.error}`);
        return;
    }
    for (const set of report.sets) {
        const counts = `cases ${set.cases.total} (fire ${set.cases.fire}, pass ${set.cases.pass})`;
        echo(`${set.failed.total === 0 ? 'PASS' : 'FAIL'}  ${set.set}  ${counts}  failed ${set.failed.total}`);
    }
    for (const row of report.results) {
        if (row.pass) continue;
        const actual = row.error ?? `${row.violations.length} finding(s)`;
        echoError(`${row.set}  ${row.source}  [${row.ruleId}]  expected ${row.expect} — ${actual}`);
    }
    echo(
        `rule-fixtures: ${report.pass ? 'PASS' : 'FAIL'} — ${report.totals.passed.total}/${report.totals.cases.total} pair(s) across ${report.totals.sets} set(s)`,
    );
}

// Guarded so the integration test can import the runner without starting a sweep.
if (import.meta.main) {
    const report = await runRuleFixtureChecks(projectRoot, join(projectRoot, '.spur/run/rule-fixtures-report.json'));
    printReport(report);
    process.exit(report.pass ? 0 : 1);
}
