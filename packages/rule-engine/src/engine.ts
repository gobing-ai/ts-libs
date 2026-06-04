import type { ProcessExecutor } from '@gobing-ai/ts-runtime';
import {
    applyFixes as applyFixesImpl,
    builtInFixers,
    type EffectiveFix,
    FIX_MODE_RANK,
    type FixApplicationResult,
    type RuleFixerProvider,
} from './fixers/fixers';
import { registerBuiltins } from './host/builtins';
import { RuleEngineHost } from './host/rule-engine-host';
import type { ConstraintFinding, ConstraintRule, Fix, FixMode, RuleEngineResult, RuleEvaluator } from './types';
import { createFinding, SEVERITY_RANK } from './types';

/** Options for constructing a RuleEngine. */
export interface RuleEngineOptions {
    /** Optional executor supplied to process-backed evaluators. */
    processExecutor?: ProcessExecutor;
    /** Optional preconfigured host. */
    host?: RuleEngineHost;
}

/** Orchestrates enabled constraint rules through a typed evaluator host. */
export class RuleEngine {
    /** Capability host used by this engine. */
    readonly host: RuleEngineHost;

    /** Fixer providers keyed by evaluator type. */
    private readonly fixers: Map<string, RuleFixerProvider>;

    constructor(options: RuleEngineOptions = {}) {
        this.host = options.host ?? new RuleEngineHost();
        registerBuiltins(this.host, options.processExecutor);
        this.fixers = builtInFixers(this.host, options.processExecutor);
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
        const findings: ConstraintFinding[] = [];
        const fixes: Fix[] = [];

        for (const rule of rules) {
            if (rule.enabled === false) continue;

            let ruleFindings: ConstraintFinding[] = [];
            let ruleEvalFixes: Fix[] = [];
            try {
                const result = await this.host.evaluators.get(rule.evaluator.type).evaluate(rule, { rule, workdir });
                ruleFindings = result.findings;
                ruleEvalFixes = result.fixes;
            } catch (error) {
                ruleFindings = [
                    createFinding(rule, error instanceof Error ? error.message : String(error), null, {
                        code: `evaluator:${rule.evaluator.type}`,
                        kind: 'error',
                    }),
                ];
            }

            findings.push(...ruleFindings);
            fixes.push(...ruleEvalFixes);

            const ruleMode = rule.fix?.mode ?? 'none';
            const effectiveMode = effectiveFixMode(ruleMode, maxFixMode);

            if (effectiveMode !== 'none' && ruleFindings.length > 0) {
                const provider = this.fixers.get(rule.evaluator.type);
                if (provider) {
                    const effectiveFix: EffectiveFix = {
                        mode: effectiveMode,
                        ...(rule.fix?.replacement !== undefined ? { replacement: rule.fix.replacement } : {}),
                        ...(rule.fix?.params !== undefined ? { params: rule.fix.params } : {}),
                    };
                    const providerFixes = await provider.createFixes({
                        rule,
                        context: { rule, workdir },
                        findings: ruleFindings,
                        fix: effectiveFix,
                    });
                    fixes.push(...providerFixes);
                }
            }

            if (stopOnFirst && ruleFindings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[stopOnFirst])) {
                break;
            }
        }

        return { findings, fixes };
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
        return applyFixesImpl(workdir, fixes, dryRun);
    }
}

/** Return the lower-authority mode between what the rule requests and what the caller allows. */
function effectiveFixMode(ruleMode: FixMode, requestedMode: FixMode): FixMode {
    if (requestedMode === 'none' || ruleMode === 'none') return 'none';
    return FIX_MODE_RANK[ruleMode] <= FIX_MODE_RANK[requestedMode] ? ruleMode : requestedMode;
}
