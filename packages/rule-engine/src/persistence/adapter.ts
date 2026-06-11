import type { FixMode } from '../types';

/** Input for inserting a rule run row (engine caller provides run metadata). */
export interface RuleRunInput {
    id: string;
    preset?: string;
    sourceKind: 'preset' | 'file';
    sourceValue?: string;
    ruleCount: number;
    failOn?: string;
    stopOnFirst?: string;
    fixMode: FixMode;
    dryRun: boolean;
    metadataJson?: string;
}

/** Input for inserting a per-rule eval row. */
export interface RuleEvalRunInput {
    id: string;
    runId: string;
    ruleId: string;
    severity: string;
    evaluator: string;
}

/** Input for updating a per-rule eval row after evaluation completes. */
export interface RuleEvalRunUpdate {
    runId: string;
    ruleId: string;
    status: 'done' | 'failed' | 'skipped';
    findingCount: number;
    fixCount: number;
    durationMs: number;
    /** Evaluator error message, if status is 'failed'. */
    error?: string;
    /** Bounded JSON for findings. */
    findingsJson?: string;
    /** Bounded JSON for fixes. */
    fixesJson?: string;
}

/**
 * Persistence adapter contract for the rule engine.
 * Implementations write directly to a durable store; the engine does NOT
 * use EventBus subscribers for durability.
 */
export interface RulePersistenceAdapter {
    /** Insert a run row as 'running'. Must be idempotent. */
    insertRun(input: RuleRunInput): Promise<void>;

    /** Finalize a run row after evaluation completes. */
    updateRunStatus(
        runId: string,
        status: 'done' | 'failed',
        findingCount: number,
        fixCount: number,
        appliedFixCount: number,
        durationMs: number,
    ): Promise<void>;

    /** Insert a per-rule eval row as 'running'. Must be idempotent. */
    insertEvalRun(input: RuleEvalRunInput): Promise<void>;

    /** Finalize a per-rule eval row after evaluation completes. */
    updateEvalRun(input: RuleEvalRunUpdate): Promise<void>;
}
