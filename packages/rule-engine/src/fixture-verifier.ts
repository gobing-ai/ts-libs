import {
    createNodeFileSystem,
    type FileSystem,
    joinPath,
    nodeBunFactory,
    type ProcessExecutor,
    type ProcessResult,
} from '@gobing-ai/ts-runtime';
import { loadRuleFile } from './config/loader';
import { RuleEngine } from './engine';
import type { ConstraintFinding, ConstraintRule } from './types';

/** One prepared fixture case: a staged workdir plus the rules it must satisfy. */
export interface RuleFixtureCase {
    /** Fixture-relative source path this case asserts; used for the existence check and diagnostics. */
    path: string;
    /** Prepared working directory the evaluator runs in. */
    workdir: string;
    /** Rule IDs evaluated independently against this workdir. */
    ruleIds: string[];
    /** Required outcome for every selected rule. */
    expect: 'fire' | 'pass';
}

/** Options for {@link verifyRuleFixtures}. */
export interface RuleFixtureVerificationOptions {
    /** Rule file holding the selected rules. Always read from disk: the loader has no filesystem port. */
    ruleFile: string;
    /** Fixture root the case `path`s resolve under. Absent → the whole verification is skipped. */
    fixtureDir: string;
    /** Prepared cases to assert, in order. */
    cases: RuleFixtureCase[];
    /** Filesystem port for fixture checks and evaluation. Defaults to `createNodeFileSystem()`. */
    fileSystem?: FileSystem;
    /** Executor for process-backed evaluators. Defaults to `nodeBunFactory.createProcessExecutor()`. */
    processExecutor?: ProcessExecutor;
}

/** Outcome of one case/rule pair. */
export interface RuleFixtureCaseResult {
    /** Fixture-relative source path from the case declaration. */
    path: string;
    /** Rule ID this result asserts. */
    ruleId: string;
    /** Expected outcome declared by the case. */
    expect: 'fire' | 'pass';
    /** Whether the recorded evaluation matched the expectation. */
    pass: boolean;
    /** Findings the engine recorded for this pair. */
    findings: ConstraintFinding[];
    /** Process results recorded while evaluating this pair, in invocation order. */
    processes: ProcessResult[];
    /** Failure reason; absent when `pass` is true. */
    error?: string;
}

/** Aggregate verification result. */
export interface RuleFixtureVerificationResult {
    /** True when every case/rule pair passed (also true for a skipped run). */
    pass: boolean;
    /** True when the optional fixture directory is absent, so nothing was asserted. */
    skipped: boolean;
    /** Per case/rule results. */
    cases: RuleFixtureCaseResult[];
}

/**
 * Verify prepared rule fixtures against the real evaluators.
 *
 * Loads `ruleFile`, then evaluates one selected rule against one case workdir at a
 * time: expected-`fire` cases need a genuine violation, expected-`pass` cases need
 * zero findings, and evaluator errors always fail. Exit-code rules are additionally
 * asserted on the process result the evaluator produced — the recorded normal exit
 * must differ from (fire) or equal (pass) the configured `successCode` (default 0),
 * and timeout / signal / launch failure always fails.
 *
 * An absent `fixtureDir` yields `pass=true, skipped=true, cases=[]`; a present but
 * empty case set fails. Invalid configuration (no selected rule IDs, extension
 * declarations, unreadable rule file) throws.
 */
export async function verifyRuleFixtures(
    options: RuleFixtureVerificationOptions,
): Promise<RuleFixtureVerificationResult> {
    const { ruleFile, fixtureDir, cases } = options;
    const fileSystem = options.fileSystem ?? createNodeFileSystem();
    const fixtureStat = await fileSystem.stat(fixtureDir);
    if (fixtureStat === null) return { pass: true, skipped: true, cases: [] };
    if (!fixtureStat.isDirectory()) throw new Error(`Fixture root "${fixtureDir}" is not a directory`);
    if (cases.length === 0) return { pass: false, skipped: false, cases: [] };
    for (const fixtureCase of cases) {
        if (fixtureCase.ruleIds.length === 0) {
            throw new Error(`Rule fixture case "${fixtureCase.path}" selects no rule IDs`);
        }
    }

    const loaded = await loadRuleFile(ruleFile);
    if (loaded.extensions.length > 0) {
        throw new Error(
            `Rule file "${ruleFile}" declares extension modules; verifyRuleFixtures supports built-in rules only`,
        );
    }
    const rulesById = new Map(
        loaded.rules.filter((rule) => rule.enabled !== false).map((rule) => [rule.id, rule] as const),
    );

    // Captured per pair: the wrapper records the original ProcessResult so exit-code
    // rules can be asserted on the real process outcome without touching evaluators.
    const processes: ProcessResult[] = [];
    const executor = options.processExecutor ?? nodeBunFactory.createProcessExecutor();
    const engine = new RuleEngine({
        fileSystem,
        processExecutor: {
            run: async (runOptions) => {
                const result = await executor.run(runOptions);
                processes.push(result);
                return result;
            },
            runStreaming: (runOptions) => executor.runStreaming(runOptions),
        },
    });

    const results: RuleFixtureCaseResult[] = [];
    for (const fixtureCase of cases) {
        const setupError = await caseSetupError(fileSystem, fixtureDir, fixtureCase);
        for (const ruleId of fixtureCase.ruleIds) {
            const rule = rulesById.get(ruleId);
            if (setupError !== undefined || rule === undefined) {
                results.push({
                    path: fixtureCase.path,
                    ruleId,
                    expect: fixtureCase.expect,
                    pass: false,
                    findings: [],
                    processes: [],
                    error: setupError ?? `rule "${ruleId}" is not an enabled rule in "${ruleFile}"`,
                });
                continue;
            }

            processes.length = 0;
            const findings = (await engine.evaluate([rule], fixtureCase.workdir)).findings;
            const recorded = [...processes];
            const verdict = judgeCase(fixtureCase.expect, rule, findings, recorded);
            results.push({
                path: fixtureCase.path,
                ruleId,
                expect: fixtureCase.expect,
                pass: verdict.pass,
                findings,
                processes: recorded,
                ...(verdict.error !== undefined ? { error: verdict.error } : {}),
            });
        }
    }

    return { pass: results.every((result) => result.pass), skipped: false, cases: results };
}

/** Fail a case whose declared source or prepared workdir is absent. */
async function caseSetupError(
    fileSystem: FileSystem,
    fixtureDir: string,
    fixtureCase: RuleFixtureCase,
): Promise<string | undefined> {
    const sourceStat = await fileSystem.stat(joinPath(fixtureDir, fixtureCase.path));
    if (sourceStat === null) return `case source "${fixtureCase.path}" is missing under "${fixtureDir}"`;
    const workdirStat = await fileSystem.stat(fixtureCase.workdir);
    if (workdirStat === null || !workdirStat.isDirectory()) {
        return `case workdir "${fixtureCase.workdir}" is missing`;
    }
    return undefined;
}

/** Assert findings — and, for exit-code rules, the recorded process result — against the expectation. */
function judgeCase(
    expect: 'fire' | 'pass',
    rule: ConstraintRule,
    findings: ConstraintFinding[],
    processes: ProcessResult[],
): { pass: boolean; error?: string } {
    const evaluatorErrors = findings.filter((finding) => finding.kind === 'error');
    if (evaluatorErrors.length > 0) {
        return { pass: false, error: `evaluator error: ${evaluatorErrors.map((f) => f.message).join('; ')}` };
    }
    const violations = findings.filter((finding) => finding.kind !== 'error');
    if (rule.evaluator.type === 'exit-code') return judgeExitCodeCase(expect, rule, processes);
    if (expect === 'fire') {
        return violations.length > 0
            ? { pass: true }
            : { pass: false, error: 'expected fire but the rule reported no violation' };
    }
    return violations.length === 0
        ? { pass: true }
        : { pass: false, error: `expected pass but the rule reported ${violations.length} violation(s)` };
}

/** Judge an exit-code pair on the recorded normal exit versus the rule's configured `successCode`. */
function judgeExitCodeCase(
    expect: 'fire' | 'pass',
    rule: ConstraintRule,
    processes: ProcessResult[],
): { pass: boolean; error?: string } {
    const configured = rule.evaluator.config?.successCode;
    const successCode = typeof configured === 'number' ? configured : 0;
    const [execution] = processes;
    if (execution === undefined) return { pass: false, error: 'exit-code: no process result recorded' };
    const abnormal = execution.exitCode === null || (execution.outcome !== undefined && execution.outcome !== 'exit');
    if (abnormal) {
        const signal = execution.signal !== undefined ? ` (signal ${execution.signal})` : '';
        return {
            pass: false,
            error: `exit-code: process did not complete normally (outcome ${execution.outcome ?? 'unknown'}${signal})${processDiagnostics(execution)}`,
        };
    }
    // The evaluator reports a violation exactly when the exit differs from the
    // configured success code, so the exit comparison is the assertion for both halves.
    if (expect === 'fire') {
        return execution.exitCode === successCode
            ? {
                  pass: false,
                  error: `expected fire but exit ${execution.exitCode} equals successCode ${successCode}${processDiagnostics(execution)}`,
              }
            : { pass: true };
    }
    return execution.exitCode === successCode
        ? { pass: true }
        : {
              pass: false,
              error: `expected pass but exit ${execution.exitCode} differs from successCode ${successCode}${processDiagnostics(execution)}`,
          };
}

/** Append the recorded streams to an exit-code failure diagnostic. */
function processDiagnostics(execution: ProcessResult): string {
    return `\nstdout: ${execution.stdout}\nstderr: ${execution.stderr}`;
}
