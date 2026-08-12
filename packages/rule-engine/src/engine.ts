import type { BusLifecycleEvents, Logger } from '@gobing-ai/ts-infra';
import { addSpanEvent, EventBus, getLogger, traceAsync } from '@gobing-ai/ts-infra';
import { createNodeFileSystem, type FileSystem, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import type { RuleEngineEvents } from './events';
import {
    applyFixes as applyFixesImpl,
    type EffectiveFix,
    FIX_MODE_RANK,
    type FixApplicationResult,
    registerBuiltinFixers,
} from './fixers/fixers';
import { registerBuiltins } from './host/builtins';
import { RuleEngineHost } from './host/rule-engine-host';
import type { RulePersistenceAdapter } from './persistence/adapter';
import type { ConstraintFinding, ConstraintRule, Fix, FixMode, RuleEngineResult, RuleEvaluator } from './types';
import { createFinding, SEVERITY_RANK } from './types';

/** Options for constructing a RuleEngine. */
export interface RuleEngineOptions {
    /** Optional executor supplied to process-backed evaluators. */
    processExecutor?: ProcessExecutor;
    /**
     * Filesystem port (ADR-011 union-return {@link FileSystem}); defaults to
     * `createNodeFileSystem()`. Threaded through {@link RuleContext} to every
     * evaluator and fixer provider so hosts can inject a virtual fs in tests.
     */
    fileSystem?: FileSystem;
    /** Optional preconfigured host. */
    host?: RuleEngineHost;
    /** Optional event bus for structured run observability (R-A4). */
    events?: EventBus<RuleEngineEvents>;
    /**
     * Optional lifecycle bus to bridge rule events into the application
     * System Events stream (R2). When `events` is omitted the engine
     * constructs an internal `EventBus<RuleEngineEvents>` parented to this
     * bus so `rule.*` prefixes appear in the JSONL log.
     */
    lifecycleBus?: EventBus<BusLifecycleEvents>;
    /** Optional logger; defaults to the shared `rule-engine` category logger. */
    logger?: Logger;
    /** Optional persistence adapter for durable run/eval history. */
    persistence?: RulePersistenceAdapter;
    /** Caller-provided run ID; engine generates one if absent. */
    runId?: string;
    /** Caller metadata for the run row (preset, failOn, source info, etc.). */
    runMeta?: Record<string, unknown>;
}

/** Orchestrates enabled constraint rules through a typed evaluator host. */
export class RuleEngine {
    /** Capability host used by this engine. */
    readonly host: RuleEngineHost;

    private readonly events: EventBus<RuleEngineEvents> | undefined;
    private readonly logger: Logger;
    private readonly persistence: RulePersistenceAdapter | undefined;
    private readonly runId: string;
    private readonly runMeta: Record<string, unknown> | undefined;
    private readonly fileSystem: FileSystem;

    constructor(options: RuleEngineOptions = {}) {
        this.host = options.host ?? new RuleEngineHost();
        registerBuiltins(this.host, options.processExecutor);
        registerBuiltinFixers(this.host, options.processExecutor);
        this.events =
            options.events ??
            (options.lifecycleBus ? new EventBus<RuleEngineEvents>({ lifecycleBus: options.lifecycleBus }) : undefined);
        this.logger = options.logger ?? getLogger('rule-engine');
        this.persistence = options.persistence;
        this.runId = options.runId ?? crypto.randomUUID();
        this.runMeta = options.runMeta;
        this.fileSystem = options.fileSystem ?? createNodeFileSystem();
    }

    /** Register or replace an evaluator. */
    registerEvaluator(type: string, evaluator: RuleEvaluator): void {
        this.host.evaluators.register(type, evaluator, 'extension');
    }

    /**
     * Evaluate all enabled rules against a working directory.
     *
     * Thin delegate to {@link evaluateWithFixes} with `maxFixMode = 'none'`; the fix
     * branch in that path is short-circuited by `effectiveFixMode` so callers see only
     * findings, never auto-generated fixes. Keeps the rule loop and error-finding
     * semantics in one place.
     */
    async evaluate(
        rules: ConstraintRule[],
        workdir: string,
        stopOnFirst?: 'error' | 'warning' | 'info',
    ): Promise<RuleEngineResult> {
        return this.evaluateWithFixes(rules, workdir, 'none', stopOnFirst);
    }

    /**
     * Evaluate all enabled rules and collect candidate fixes.
     *
     * For each rule with findings and a non-none fix mode, looks up the fixer
     * provider by evaluator type and calls `createFixes`. The effective fix mode
     * is the minimum of the rule's configured mode and `maxFixMode`.
     *
     * When `options.persistence` is set, this method writes a run row before
     * evaluation and per-rule eval rows during the loop. A `done`/`failed`
     * status is written after the loop completes.
     *
     * @param rules - Normalized rule definitions to evaluate.
     * @param workdir - Working directory to scan.
     * @param maxFixMode - Highest fix authority requested by the caller.
     * @param stopOnFirst - When set, stop evaluating rules after the first rule
     *   whose findings meet/exceed this severity threshold. Undefined = exhaustive
     *   (today's behavior, zero breaking change).
     * @returns Findings plus fixes allowed by the requested authority.
     */
    async evaluateWithFixes(
        rules: ConstraintRule[],
        workdir: string,
        maxFixMode: FixMode = 'auto',
        stopOnFirst?: 'error' | 'warning' | 'info',
    ): Promise<RuleEngineResult> {
        const enabledRules = rules.filter((r) => r.enabled !== false);
        const runStartMs = Date.now();

        // Insert the run row before any evaluation.
        const runMeta = this.runMeta ?? {};
        await this.persistence?.insertRun({
            id: this.runId,
            sourceKind: (runMeta.sourceKind as 'preset' | 'file') ?? 'preset',
            sourceValue: runMeta.sourceValue as string | undefined,
            preset: runMeta.preset as string | undefined,
            ruleCount: enabledRules.length,
            failOn: runMeta.failOn as string | undefined,
            stopOnFirst: runMeta.stopOnFirst as string | undefined,
            fixMode: maxFixMode,
            dryRun: (runMeta.dryRun as boolean) ?? false,
            metadataJson: runMeta.metadataJson as string | undefined,
        });

        return await traceAsync(
            'rule.run',
            async () => {
                this.logger.info('rule run started', { enabled: enabledRules.length, total: rules.length });
                addSpanEvent('rule.run.start', { rules: enabledRules.length, total: rules.length });
                void this.events?.emit('rule.run.start', {
                    rules: enabledRules.length,
                    total: rules.length,
                    severity: 'info',
                });

                const findings: ConstraintFinding[] = [];
                const fixes: Fix[] = [];
                let index = 0;
                let stoppedEarlyLocal = false;

                for (const rule of rules) {
                    if (rule.enabled === false) continue;
                    index++;

                    // Persist eval start.
                    await this.persistence?.insertEvalRun({
                        id: `${this.runId}:${rule.id}`,
                        runId: this.runId,
                        ruleId: rule.id,
                        severity: rule.severity,
                        evaluator: rule.evaluator.type,
                    });

                    const evalStartMs = Date.now();
                    this.logger.debug('eval start', { ruleId: rule.id, index, total: enabledRules.length });
                    addSpanEvent('rule.eval.start', { ruleId: rule.id, index, total: enabledRules.length });
                    void this.events?.emit('rule.eval.start', {
                        ruleId: rule.id,
                        index,
                        total: enabledRules.length,
                        severity: 'info',
                    });

                    let ruleFindings: ConstraintFinding[] = [];
                    let ruleEvalFixes: Fix[] = [];
                    let evalError: string | undefined;
                    try {
                        const result = await this.host.evaluators
                            .get(rule.evaluator.type)
                            .evaluate(rule, { rule, workdir, fileSystem: this.fileSystem });
                        ruleFindings = result.findings;
                        ruleEvalFixes = result.fixes;
                    } catch (error) {
                        evalError = error instanceof Error ? error.message : String(error);
                        ruleFindings = [
                            createFinding(rule, evalError, null, {
                                code: `evaluator:${rule.evaluator.type}`,
                                kind: 'error',
                            }),
                        ];
                        addSpanEvent('rule.eval.error', { ruleId: rule.id, error: evalError });
                        void this.events?.emit('rule.eval.error', {
                            ruleId: rule.id,
                            error: evalError,
                            severity: 'error',
                        });
                    }

                    const durationMs = Date.now() - evalStartMs;
                    addSpanEvent('rule.eval.done', {
                        ruleId: rule.id,
                        findings: ruleFindings.length,
                        durationMs,
                    });
                    void this.events?.emit('rule.eval.done', {
                        ruleId: rule.id,
                        findings: ruleFindings.length,
                        durationMs,
                        details: ruleFindings,
                        severity: 'info',
                    });

                    // Persist eval completion.
                    await this.persistence?.updateEvalRun({
                        runId: this.runId,
                        ruleId: rule.id,
                        status: evalError ? 'failed' : 'done',
                        findingCount: ruleFindings.length,
                        fixCount: ruleEvalFixes.length,
                        durationMs,
                        ...(evalError ? { error: evalError } : {}),
                    });

                    findings.push(...ruleFindings);
                    fixes.push(...ruleEvalFixes);

                    const ruleMode = rule.fix?.mode ?? 'none';
                    const effectiveMode = effectiveFixMode(ruleMode, maxFixMode);

                    if (effectiveMode !== 'none' && ruleFindings.length > 0) {
                        const provider = this.host.fixers.getEntry(rule.evaluator.type)?.capability;
                        if (provider) {
                            const effectiveFix: EffectiveFix = {
                                mode: effectiveMode,
                                ...(rule.fix?.replacement !== undefined ? { replacement: rule.fix.replacement } : {}),
                                ...(rule.fix?.params !== undefined ? { params: rule.fix.params } : {}),
                            };
                            const providerFixes = await provider.createFixes({
                                rule,
                                context: { rule, workdir, fileSystem: this.fileSystem },
                                findings: ruleFindings,
                                fix: effectiveFix,
                            });
                            fixes.push(...providerFixes);
                        }
                    }

                    if (
                        stopOnFirst &&
                        ruleFindings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[stopOnFirst])
                    ) {
                        stoppedEarlyLocal = true;
                        break;
                    }
                }

                const runDurationMs = Date.now() - runStartMs;
                this.logger.info('rule run done', {
                    rules: enabledRules.length,
                    findings: findings.length,
                    durationMs: runDurationMs,
                    stoppedEarly: stoppedEarlyLocal,
                });
                addSpanEvent('rule.run.done', {
                    rules: enabledRules.length,
                    findings: findings.length,
                    durationMs: runDurationMs,
                    stoppedEarly: stoppedEarlyLocal,
                });
                void this.events?.emit('rule.run.done', {
                    rules: enabledRules.length,
                    findings: findings.length,
                    durationMs: runDurationMs,
                    stoppedEarly: stoppedEarlyLocal,
                    severity: 'info',
                });

                // Finalize the run row.
                await this.persistence?.updateRunStatus(
                    this.runId,
                    'done',
                    findings.length,
                    fixes.length,
                    0, // appliedFixCount — set by the caller after applying fixes
                    runDurationMs,
                );

                return { findings, fixes };
            },
            { attributes: { 'rule.count': enabledRules.length } },
        );
    }

    /**
     * Apply or preview candidate byte-range fixes.
     *
     * @param workdir - Working directory that fix file paths are relative to.
     * @param fixes - Fixes to apply.
     * @param dryRun - When true, return a diff without writing files.
     * @returns Application details and optional diff.
     */
    async applyFixes(workdir: string, fixes: readonly Fix[], dryRun = false): Promise<FixApplicationResult> {
        return applyFixesImpl(workdir, fixes, dryRun, this.fileSystem);
    }
}

/** Return the lower-authority mode between what the rule requests and what the caller allows. */
function effectiveFixMode(ruleMode: FixMode, requestedMode: FixMode): FixMode {
    if (requestedMode === 'none' || ruleMode === 'none') return 'none';
    return FIX_MODE_RANK[ruleMode] <= FIX_MODE_RANK[requestedMode] ? ruleMode : requestedMode;
}
