import { afterEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBufferTarget, setDefaultOutputTargets } from '../../packages/utils/src/index';
import { repoRoot } from '../config';
import { printReport, type RuleFixtureReport, runRuleFixtureChecks } from '../verify-rule-fixtures';

/** Rule file each fixture set exercises, relative to the repository root. */
const RULE_FILES = [
    '.spur/rules/typescript/lifecycle-bus-propagation.yaml',
    '.spur/rules/typescript/decision-boundaries.yaml',
    '.spur/rules/quality/verify-confidence.yaml',
    '.spur/rules/quality/evidence-citation.yaml',
    '.spur/rules/quality/changelog-verification-confidence.yaml',
] as const;

/** Fixture paths whose content is asserted to be read-only for the gate. */
const CHECKED_IN_FIXTURES = [
    '.spur/rules/fixtures/lifecycle-bus-propagation/should-pass/with-lifecycle-bus.ts',
    '.spur/rules/fixtures/decision-boundaries/should-pass/packages/ai-runner/src/no-clef.ts',
    '.spur/rules/fixtures/verify-confidence/should-pass/.spur/run/0201-verdict.json',
    '.spur/rules/fixtures/changelog-verification/should-pass/0201-high/CHANGELOG.md',
] as const;

const scratchRoots: string[] = [];

/** Allocate a throwaway repository root holding a copy of every fixture set and rule file. */
async function makeTempRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ts-libs-fixture-repo-'));
    scratchRoots.push(root);
    await cp(join(repoRoot, '.spur/rules/fixtures'), join(root, '.spur/rules/fixtures'), { recursive: true });
    for (const ruleFile of RULE_FILES) {
        const target = join(root, ruleFile);
        await mkdir(dirname(target), { recursive: true });
        await cp(join(repoRoot, ruleFile), target);
    }
    return root;
}

/** Allocate a throwaway report path outside the repository. */
async function makeReportPath(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ts-libs-fixture-report-'));
    scratchRoots.push(root);
    return join(root, 'nested/rule-fixtures-report.json');
}

/** Replace one fixture in a temp repo with another fixture's content, inverting its expectation. */
async function invertFixture(root: string, target: string, source: string): Promise<void> {
    await writeFile(join(root, target), await readFile(join(root, source)));
}

/** A zeroed count triple, used to build a synthetic report for the renderer test. */
function emptyCounts(): { total: number; fire: number; pass: number } {
    return { total: 0, fire: 0, pass: 0 };
}

afterEach(async () => {
    await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runRuleFixtureChecks', () => {
    test('asserts every current case in all five sets and writes a passing report', async () => {
        const reportPath = await makeReportPath();
        const report = await runRuleFixtureChecks(repoRoot, reportPath);

        expect(report.error).toBeUndefined();
        expect(report.pass).toBe(true);
        expect(report.totals.sets).toBe(5);
        expect(report.totals.cases).toEqual({ total: 43, fire: 20, pass: 23 });
        expect(report.totals.failed).toEqual({ total: 0, fire: 0, pass: 0 });
        expect(report.sets.map((set) => [set.set, set.cases.total])).toEqual([
            ['lifecycle-bus-propagation', 5],
            ['decision-boundaries', 6],
            ['verify-confidence', 14],
            ['evidence-citation', 9],
            ['changelog-verification', 9],
        ]);

        // Per-set and per-expectation counts are reported, not only a global pass.
        const lifecycle = report.sets[0];
        expect(lifecycle?.cases).toEqual({ total: 5, fire: 2, pass: 3 });
        expect(report.sets[2]?.cases).toEqual({ total: 14, fire: 8, pass: 6 });
        expect(report.sets[3]?.cases).toEqual({ total: 9, fire: 3, pass: 6 });
        expect(report.sets[4]?.cases).toEqual({ total: 9, fire: 4, pass: 5 });

        expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report);
    });

    test('fails a mutated lifecycle case and names its source, rule and expectation', async () => {
        const root = await makeTempRepo();
        const setDir = '.spur/rules/fixtures/lifecycle-bus-propagation';
        await invertFixture(
            root,
            `${setDir}/should-pass/with-lifecycle-bus.ts`,
            `${setDir}/should-fire/no-lifecycle-bus.ts`,
        );
        const before = await readFile(join(repoRoot, CHECKED_IN_FIXTURES[0]));
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toBeUndefined();
        const failed = report.results.filter((row) => !row.pass);
        expect(failed.map((row) => [row.source, row.ruleId, row.expect])).toEqual([
            ['should-pass/with-lifecycle-bus.ts', 'lifecycle-bus-propagation', 'pass'],
        ]);
        expect(failed[0]?.error).toContain('expected pass');
        // The gate only ever reads checked-in fixtures.
        expect(await readFile(join(repoRoot, CHECKED_IN_FIXTURES[0]))).toEqual(before);
    });

    test('fails a mutated decision-boundaries case', async () => {
        const root = await makeTempRepo();
        const setDir = '.spur/rules/fixtures/decision-boundaries';
        await invertFixture(
            root,
            `${setDir}/should-pass/packages/ai-runner/src/no-clef.ts`,
            `${setDir}/should-fire/packages/ai-runner/src/imports-clef.ts`,
        );
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        const failed = report.results.filter((row) => !row.pass);
        expect(failed.map((row) => [row.source, row.ruleId, row.expect])).toEqual([
            ['should-pass/packages/ai-runner/src/no-clef.ts', 'no-clef-driver-import-in-ai-runner', 'pass'],
        ]);
    });

    test('fails a mutated verify-confidence case', async () => {
        const root = await makeTempRepo();
        const setDir = '.spur/rules/fixtures/verify-confidence';
        await invertFixture(
            root,
            `${setDir}/should-pass/.spur/run/0201-verdict.json`,
            `${setDir}/should-fire/.spur/run/0101-verdict.json`,
        );
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        const failed = report.results.filter((row) => !row.pass);
        expect(failed.map((row) => [row.source, row.ruleId, row.expect])).toEqual([
            ['should-pass/.spur/run/0201-verdict.json', 'verify-confidence-level', 'pass'],
        ]);
    });

    test('fails a mutated changelog-verification case', async () => {
        const root = await makeTempRepo();
        const setDir = '.spur/rules/fixtures/changelog-verification';
        await invertFixture(
            root,
            `${setDir}/should-pass/0201-high/CHANGELOG.md`,
            `${setDir}/should-fire/0101-level-absent/CHANGELOG.md`,
        );
        const before = await readFile(join(repoRoot, CHECKED_IN_FIXTURES[3]));
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        const failed = report.results.filter((row) => !row.pass);
        expect(failed.map((row) => [row.source, row.ruleId, row.expect])).toEqual([
            ['should-pass/0201-high', 'changelog-verification-confidence', 'pass'],
        ]);
        expect(failed[0]?.error).toContain('expected pass but exit');
        // The gate only ever reads checked-in fixtures.
        expect(await readFile(join(repoRoot, CHECKED_IN_FIXTURES[3]))).toEqual(before);
    });

    test('fails rather than skips when a declared directory is deleted, and still writes a report', async () => {
        const root = await makeTempRepo();
        await rm(join(root, '.spur/rules/fixtures/decision-boundaries/should-pass'), { recursive: true });
        const reportPath = await makeReportPath();
        const report = await runRuleFixtureChecks(root, reportPath);

        expect(report.pass).toBe(false);
        expect(report.error).toContain('decision-boundaries/should-pass');
        expect(report.results).toEqual([]);
        expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report);
    });

    test('fails an unrecognized fixture shape instead of silently dropping it', async () => {
        const root = await makeTempRepo();
        await writeFile(join(root, '.spur/rules/fixtures/lifecycle-bus-propagation/should-pass/notes.txt'), 'x');
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('unrecognized fixture shape');
        expect(report.error).toContain('should-pass/notes.txt');
    });

    test('removes every temporary workdir after the sweep', async () => {
        const before = (await readdir(tmpdir())).filter((name) => name.startsWith('ts-libs-rule-fixtures-')).length;
        await runRuleFixtureChecks(repoRoot, await makeReportPath());
        const after = (await readdir(tmpdir())).filter((name) => name.startsWith('ts-libs-rule-fixtures-')).length;

        expect(after).toBe(before);
    });
});

describe('printReport', () => {
    test('summarizes each set and names every failing pair', () => {
        const stdout = createBufferTarget();
        const stderr = createBufferTarget();
        const restore = setDefaultOutputTargets({ stdout, stderr });
        const report: RuleFixtureReport = {
            pass: false,
            totals: { sets: 3, cases: emptyCounts(), passed: emptyCounts(), failed: emptyCounts() },
            sets: [
                {
                    set: 'verify-confidence',
                    ruleFile: '.spur/rules/quality/verify-confidence.yaml',
                    cases: { total: 14, fire: 8, pass: 6 },
                    passed: { total: 13, fire: 8, pass: 5 },
                    failed: { total: 1, fire: 0, pass: 1 },
                },
            ],
            results: [
                {
                    set: 'verify-confidence',
                    source: 'should-pass/.spur/run/0201-verdict.json',
                    ruleId: 'verify-confidence-level',
                    expect: 'pass',
                    pass: false,
                    findings: 1,
                    violations: [{ kind: 'violation', message: 'm', filePath: null }],
                    processes: [],
                    error: 'expected pass but the rule reported 1 violation(s)',
                },
            ],
        };
        try {
            printReport(report);
        } finally {
            restore();
        }

        expect(stdout.text()).toContain('FAIL  verify-confidence  cases 14 (fire 8, pass 6)  failed 1');
        expect(stdout.text()).toContain('rule-fixtures: FAIL');
        expect(stderr.text()).toContain(
            'verify-confidence  should-pass/.spur/run/0201-verdict.json  [verify-confidence-level]  expected pass',
        );
    });

    test('renders an incomplete sweep as its single reason', () => {
        const stdout = createBufferTarget();
        const stderr = createBufferTarget();
        const restore = setDefaultOutputTargets({ stdout, stderr });
        try {
            printReport({
                pass: false,
                totals: { sets: 0, cases: emptyCounts(), passed: emptyCounts(), failed: emptyCounts() },
                sets: [],
                results: [],
                error: 'declared fixture directory "verify-confidence/should-fire" is missing',
            });
        } finally {
            restore();
        }

        expect(stdout.text()).toBe('');
        expect(stderr.text()).toContain('rule-fixtures: FAIL — declared fixture directory');
    });
});

describe('runRuleFixtureChecks — fixture shapes that cannot be silently dropped', () => {
    test('fails a lifecycle set whose support file is deleted', async () => {
        const root = await makeTempRepo();
        await rm(join(root, '.spur/rules/fixtures/lifecycle-bus-propagation/should-fire/events.ts'));
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('required support file');
    });

    test('fails a decision-boundaries case under a package with no mapped rule', async () => {
        const root = await makeTempRepo();
        const target = join(root, '.spur/rules/fixtures/decision-boundaries/should-pass/packages/unknown/src/any.ts');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'export const x = 1;\n');
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('no decision-boundary rule is mapped to package "unknown"');
    });

    test('fails an unrecognized shape in the decision-boundaries set', async () => {
        const root = await makeTempRepo();
        await writeFile(join(root, '.spur/rules/fixtures/decision-boundaries/should-pass/notes.md'), 'x');
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('unrecognized fixture shape');
        expect(report.error).toContain('decision-boundaries/should-pass/notes.md');
    });

    test('fails an unrecognized shape in the verify-confidence set', async () => {
        const root = await makeTempRepo();
        await writeFile(join(root, '.spur/rules/fixtures/verify-confidence/should-fire/notes.txt'), 'x');
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('unrecognized fixture shape');
        expect(report.error).toContain('verify-confidence/should-fire/notes.txt');
    });

    test('fails an unrecognized shape in the changelog-verification set', async () => {
        const root = await makeTempRepo();
        await writeFile(join(root, '.spur/rules/fixtures/changelog-verification/should-fire/notes.md'), 'x');
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('unrecognized fixture shape');
        expect(report.error).toContain('changelog-verification/should-fire/notes.md');
    });

    test('fails a non-file fixture entry', async () => {
        const root = await makeTempRepo();
        await symlink(
            join(root, '.spur/rules/fixtures/verify-confidence/should-pass/.spur/run/0201-verdict.json'),
            join(root, '.spur/rules/fixtures/verify-confidence/should-pass/.spur/run/0202-link.json'),
        );
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('unrecognized non-file fixture entry');
    });

    test('bounds the captured streams of a verbose exit-code evaluator', async () => {
        const root = await makeTempRepo();
        const chatter =
            "i=0; while [ $i -lt 400 ]; do printf 'padpadpadpadpadpadpadpadpadpad\\n'; i=$((i+1)); done; exit 3";
        await writeFile(
            join(root, '.spur/rules/typescript/lifecycle-bus-propagation.yaml'),
            [
                'include:',
                '  - "packages/**/src/**/*.ts"',
                'rules:',
                '  - id: lifecycle-bus-propagation',
                '    description: verbose stub',
                '    evaluator:',
                '      type: exit-code',
                '      config:',
                '        command: sh',
                '        args:',
                '          - -c',
                `          - "${chatter}"`,
                '',
            ].join('\n'),
        );
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        const streams = report.results.map((row) => row.processes[0]?.stdout ?? '');
        expect(streams.some((stream) => stream.includes('truncated (') && stream.length < 2200)).toBe(true);
        // The stub exits 3 for every case, so the expected-pass rows must fail.
        expect(report.totals.failed.pass).toBeGreaterThan(0);
    });
});

describe('runRuleFixtureChecks — the declared case inventory', () => {
    test('rejects emptied failure cases and support files even when rule outcomes still match', async () => {
        for (const relative of [
            'verify-confidence/should-fire/.spur/run/0103-verdict.json',
            'lifecycle-bus-propagation/should-fire/events.ts',
        ]) {
            const root = await makeTempRepo();
            await writeFile(join(root, '.spur/rules/fixtures', relative), '');
            const report = await runRuleFixtureChecks(root, await makeReportPath());
            expect(report.pass).toBe(false);
            expect(report.results.some((row) => row.error?.includes('fixture content changed'))).toBe(true);
        }
    });

    test('fails when a declared expectation directory is emptied', async () => {
        const root = await makeTempRepo();
        const dir = join(root, '.spur/rules/fixtures/verify-confidence/should-fire');
        for (const entry of await readdir(dir)) await rm(join(dir, entry), { recursive: true, force: true });
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('declared case inventory mismatch for "verify-confidence/should-fire"');
        expect(report.error).toContain('declared 8 case(s), found 0');
    });

    test('fails when a single declared case source is deleted', async () => {
        const root = await makeTempRepo();
        await rm(join(root, '.spur/rules/fixtures/lifecycle-bus-propagation/should-fire/no-lifecycle-bus.ts'));
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('declared case inventory mismatch for "lifecycle-bus-propagation/should-fire"');
        expect(report.error).toContain('declared 2 case(s), found 1');
    });

    test('fails when a case is added without declaring it', async () => {
        const root = await makeTempRepo();
        await writeFile(
            join(root, '.spur/rules/fixtures/decision-boundaries/should-pass/packages/ai-runner/src/extra.ts'),
            'export const x = 1;\n',
        );
        const report = await runRuleFixtureChecks(root, await makeReportPath());

        expect(report.pass).toBe(false);
        expect(report.error).toContain('declared case inventory mismatch for "decision-boundaries/should-pass"');
        expect(report.error).toContain('declared 3 case(s), found 4');
    });
});
