import type { DbAdapter } from '@gobing-ai/ts-db';

import type { RuleEvalRunInput, RuleEvalRunUpdate, RulePersistenceAdapter, RuleRunInput } from './adapter';

/** Persist engine run/eval rows to SQLite via a ts-db DbAdapter. */
export class DbRulePersistenceAdapter implements RulePersistenceAdapter {
    constructor(private readonly db: DbAdapter) {}

    async insertRun(input: RuleRunInput): Promise<void> {
        const now = new Date().toISOString();
        await this.db.run(
            `INSERT INTO rule_runs (id, preset, source_kind, source_value, status, rule_count,
             fail_on, stop_on_first, fix_mode, dry_run, metadata_json, started_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            input.id,
            input.preset ?? null,
            input.sourceKind,
            input.sourceValue ?? null,
            input.ruleCount,
            input.failOn ?? null,
            input.stopOnFirst ?? null,
            input.fixMode,
            input.dryRun ? 1 : 0,
            input.metadataJson ?? '{}',
            now,
            now,
            now,
        );
    }

    async updateRunStatus(
        runId: string,
        status: 'done' | 'failed',
        findingCount: number,
        fixCount: number,
        appliedFixCount: number,
        durationMs: number,
    ): Promise<void> {
        const now = new Date().toISOString();
        await this.db.run(
            `UPDATE rule_runs
             SET status = ?, finding_count = ?, fix_count = ?, applied_fix_count = ?,
                 duration_ms = ?, completed_at = ?, updated_at = ?
             WHERE id = ?`,
            status,
            findingCount,
            fixCount,
            appliedFixCount,
            durationMs,
            now,
            now,
            runId,
        );
    }

    async insertEvalRun(input: RuleEvalRunInput): Promise<void> {
        const now = new Date().toISOString();
        await this.db.run(
            `INSERT INTO rule_eval_runs (id, run_id, rule_id, severity, evaluator, status,
             started_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
            input.id,
            input.runId,
            input.ruleId,
            input.severity,
            input.evaluator,
            now,
            now,
            now,
        );
    }

    async updateEvalRun(input: RuleEvalRunUpdate): Promise<void> {
        const now = new Date().toISOString();
        await this.db.run(
            `UPDATE rule_eval_runs
             SET status = ?, finding_count = ?, fix_count = ?, duration_ms = ?,
                 error = ?, findings_json = ?, fixes_json = ?, completed_at = ?, updated_at = ?
             WHERE run_id = ? AND rule_id = ?`,
            input.status,
            input.findingCount,
            input.fixCount,
            input.durationMs,
            input.error ?? null,
            input.findingsJson ?? null,
            input.fixesJson ?? null,
            now,
            now,
            input.runId,
            input.ruleId,
        );
    }
}
