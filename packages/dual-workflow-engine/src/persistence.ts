import type { DbAdapter, DbBatchOp } from '@gobing-ai/ts-db';
import { RunCollisionError } from './errors';
import { WORKFLOW_ENGINE_SCHEMA_SQL } from './schema-sql';
import type {
    ActionRedactor,
    WorkflowPersistenceAdapter,
    WorkflowReseedResult,
    WorkflowRunRecord,
    WorkflowStatus,
} from './types';

/** Apply workflow-engine-owned schema to a database adapter. */
export async function applyWorkflowEngineSchema(db: DbAdapter): Promise<void> {
    for (const statement of WORKFLOW_ENGINE_SCHEMA_SQL.split(';')) {
        const sql = statement.trim();
        if (sql.length > 0) await db.exec(sql);
    }
}

/** Narrow to a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Default result redactor (task 0060 F4): shell action results keep `ok`/`exitCode`
 * but drop raw `stdout`/`stderr`, which may carry secrets, from the persisted row.
 * Non-shell results pass through unchanged.
 */
export function defaultActionRedactor(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
    if (kind !== 'shell') return payload;
    const data = isRecord(payload.data) ? { ...payload.data } : payload.data;
    if (isRecord(data)) {
        if ('stdout' in data) data.stdout = '[redacted]';
        if ('stderr' in data) data.stderr = '[redacted]';
    }
    return { ...payload, data };
}

/** Apply the caller redactor, or the built-in default when none is supplied. */
export function applyRedactor(
    redactor: ActionRedactor | undefined,
    kind: string,
    result: unknown,
): Record<string, unknown> {
    const payload = isRecord(result) ? result : { value: result };
    return redactor !== undefined ? redactor(kind, payload) : defaultActionRedactor(kind, payload);
}

/** SQLite/D1-compatible workflow persistence adapter backed by ts-db. */
export class DbWorkflowPersistenceAdapter implements WorkflowPersistenceAdapter {
    /** Memoized schema-ensure; the DDL runs at most once per adapter instance. */
    private schemaReady: Promise<void> | undefined;

    constructor(private readonly db: DbAdapter) {}

    /**
     * Apply the workflow-engine schema once per adapter, latching the in-flight
     * promise so concurrent first calls share a single DDL pass. Every public
     * read/write awaits this instead of re-running the idempotent DDL per call.
     */
    private ensureSchema(): Promise<void> {
        this.schemaReady ??= applyWorkflowEngineSchema(this.db);
        return this.schemaReady;
    }

    /** Create a run row, rejecting duplicate run ids. */
    async createRun(record: WorkflowRunRecord): Promise<void> {
        const existing = await this.loadRun(record.id);
        if (existing !== undefined) throw new RunCollisionError(record.id);
        await this.ensureSchema();
        await this.db.run(
            `INSERT INTO runs (id, workflow_name, mode, status, external_key, started_at, completed_at, metadata_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            record.id,
            record.workflow_name,
            record.mode,
            record.status,
            record.external_key ?? null,
            record.started_at,
            record.completed_at,
            record.metadata_json,
            Date.now(),
            Date.now(),
        );
    }

    /** Finalize a run with terminal status and timestamp. */
    async finalizeRun(runId: string, status: WorkflowStatus, completedAt: string): Promise<void> {
        await this.db.run(
            'UPDATE runs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
            status,
            completedAt,
            Date.now(),
            runId,
        );
    }

    /** Save one phase/state execution record. */
    async savePhase(runId: string, phase: string, status: WorkflowStatus): Promise<void> {
        const op = this.phaseRow(runId, phase, status, Date.now());
        await this.db.run(op.sql, ...op.params);
    }

    /** Save one transition record. */
    async saveTransition(runId: string, from: string, to: string, trigger: string | null): Promise<void> {
        const op = this.transitionRow(runId, from, to, trigger, Date.now());
        await this.db.run(op.sql, ...op.params);
    }

    /** Save the latest workflow state snapshot. */
    async saveWorkflowState(runId: string, state: string, data: Record<string, unknown>): Promise<void> {
        const op = this.stateRow(runId, state, data, Date.now());
        await this.db.run(op.sql, ...op.params);
    }

    async commitTransition(
        runId: string,
        from: string,
        to: string,
        trigger: string | null,
        state: string,
        data: Record<string, unknown>,
        phase?: { phase: string; status: WorkflowStatus },
    ): Promise<void> {
        await this.ensureSchema();
        const now = Date.now();
        const ops: DbBatchOp[] = [
            this.transitionRow(runId, from, to, trigger, now),
            this.stateRow(runId, state, data, now),
        ];
        if (phase) {
            ops.push(this.phaseRow(runId, phase.phase, phase.status, now));
        }
        await this.db.batch(ops);
    }

    // Row builders shared by the individual save methods and commitTransition so
    // the single-write and atomic-batch paths can never drift apart (ADR-020).

    private transitionRow(runId: string, from: string, to: string, trigger: string | null, now: number): DbBatchOp {
        return {
            sql: `INSERT INTO transition_runs (id, run_id, from_state, to_state, trigger, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
                `${runId}:transition:${from}:${to}:${crypto.randomUUID()}`,
                runId,
                from,
                to,
                trigger,
                'done',
                now,
                now,
            ],
        };
    }

    private stateRow(runId: string, state: string, data: Record<string, unknown>, now: number): DbBatchOp {
        return {
            sql: `INSERT INTO workflow_states (id, run_id, state, data_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            params: [`${runId}:state:${state}:${crypto.randomUUID()}`, runId, state, JSON.stringify(data), now, now],
        };
    }

    private phaseRow(runId: string, phase: string, status: WorkflowStatus, now: number): DbBatchOp {
        return {
            sql: `INSERT INTO phase_runs (id, run_id, phase, status, started_at, completed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
                `${runId}:phase:${phase}:${crypto.randomUUID()}`,
                runId,
                phase,
                status,
                new Date(now).toISOString(),
                status === 'running' ? null : new Date(now).toISOString(),
                now,
                now,
            ],
        };
    }

    /** Insert a running action row. Returns the row id for later finalization. The `options` arg is mirror-only (observability seam) and deliberately ignored by persistence. */
    async saveActionStart(
        runId: string,
        node: string,
        kind: string,
        _options?: Record<string, unknown>,
    ): Promise<string> {
        const id = crypto.randomUUID();
        const now = Date.now();
        await this.db.run(
            `INSERT INTO action_runs (id, run_id, node, kind, status, started_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            runId,
            node,
            kind,
            'running',
            new Date(now).toISOString(),
            now,
            now,
        );
        return id;
    }

    /** Finalize an action row with duration, ok flag, and optional redacted result. */
    async saveActionFinalize(
        actionId: string,
        status: WorkflowStatus,
        durationMs: number,
        ok: boolean,
        kind: string,
        result?: unknown,
        redactor?: ActionRedactor,
    ): Promise<void> {
        const now = Date.now();
        await this.db.run(
            `UPDATE action_runs
             SET status = ?, duration_ms = ?, ok = ?, result_json = ?, completed_at = ?, updated_at = ?
             WHERE id = ?`,
            status,
            durationMs,
            ok ? 1 : 0,
            result !== undefined ? JSON.stringify(applyRedactor(redactor, kind, result)) : null,
            new Date(now).toISOString(),
            now,
            actionId,
        );
    }

    /** Load a single run by id. */
    async loadRun(runId: string): Promise<WorkflowRunRecord | undefined> {
        await this.ensureSchema();
        const row = await this.db.queryFirst<WorkflowRunRecord>('SELECT * FROM runs WHERE id = ?', runId);
        return row ?? undefined;
    }

    /** List persisted workflow runs. */
    async listRuns(): Promise<readonly WorkflowRunRecord[]> {
        await this.ensureSchema();
        return await this.db.queryAll<WorkflowRunRecord>('SELECT * FROM runs ORDER BY started_at DESC');
    }

    /** Look up a run by its external key within a workflow definition. */
    async findRunByKey(workflowName: string, externalKey: string): Promise<WorkflowRunRecord | undefined> {
        await this.ensureSchema();
        const row = await this.db.queryFirst<WorkflowRunRecord>(
            'SELECT * FROM runs WHERE workflow_name = ? AND external_key = ?',
            workflowName,
            externalKey,
        );
        return row ?? undefined;
    }

    /** Create a run or attach to an existing one by external key. */
    async createOrAttachRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
        await this.ensureSchema();
        if (record.external_key) {
            const existing = await this.findRunByKey(record.workflow_name, record.external_key);
            if (existing) return existing;
        }
        try {
            await this.createRun(record);
        } catch (error) {
            if (record.external_key) {
                const existing = await this.findRunByKey(record.workflow_name, record.external_key);
                if (existing) return existing;
            }
            throw error;
        }
        return { ...record };
    }

    /** Force-set the current state of a run (reseed). Atomic: snapshot + `__reseed__` transition
     *  commit in one `db.batch`, and the previous snapshot's `effectiveVars` survive (task 0060 F6). */
    async reseedRun(runId: string, newState: string): Promise<WorkflowReseedResult> {
        await this.ensureSchema();
        const previous = await this.loadLatestStateSnapshot(runId);
        const now = Date.now();
        const data = {
            ...(previous?.data ?? {}),
            reseeded: true,
            reseededAt: new Date(now).toISOString(),
        };
        await this.commitTransition(runId, previous?.state ?? '', newState, '__reseed__', newState, data);
        return { fromState: previous?.state ?? null, toState: newState };
    }

    /** Load the current state name for a run. */
    async loadCurrentState(runId: string): Promise<string | undefined> {
        await this.ensureSchema();
        const row = await this.db.queryFirst<{ state: string }>(
            'SELECT state FROM workflow_states WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
            runId,
        );
        return row?.state;
    }
    /** Load the latest state snapshot (full data payload) for a run. */
    async loadLatestStateSnapshot(
        runId: string,
    ): Promise<{ state: string; data: Record<string, unknown> } | undefined> {
        await this.ensureSchema();
        const row = await this.db.queryFirst<{ state: string; data_json: string | null }>(
            'SELECT state, data_json FROM workflow_states WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
            runId,
        );
        if (row == null) return undefined;
        let data: Record<string, unknown> = {};
        if (row.data_json !== null && row.data_json.length > 0) {
            try {
                data = JSON.parse(row.data_json) as Record<string, unknown>;
            } catch {
                data = {};
            }
        }
        return { state: row.state, data };
    }

    /** List runs with status 'paused'. Ordered most-recent-first. */
    async listPausedRuns(options?: { workflowName?: string; limit?: number }): Promise<readonly WorkflowRunRecord[]> {
        await this.ensureSchema();
        const where = ["status = 'paused'"];
        const params: unknown[] = [];
        if (options?.workflowName !== undefined) {
            where.push('workflow_name = ?');
            params.push(options.workflowName);
        }
        const limit = options?.limit ?? 100;
        const sql = `SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, rowid DESC LIMIT ?`;
        params.push(limit);
        return await this.db.queryAll<WorkflowRunRecord>(sql, ...params);
    }
}

/** In-memory persistence adapter for tests and embedding. */
export class MemoryWorkflowPersistenceAdapter implements WorkflowPersistenceAdapter {
    readonly runs = new Map<string, WorkflowRunRecord>();
    readonly phases: Array<{ runId: string; phase: string; status: WorkflowStatus }> = [];
    readonly transitions: Array<{ runId: string; from: string; to: string; trigger: string | null }> = [];
    readonly states: Array<{ runId: string; state: string; data: Record<string, unknown> }> = [];

    /** Create a run row, rejecting duplicate run ids. */
    async createRun(record: WorkflowRunRecord): Promise<void> {
        if (this.runs.has(record.id)) throw new RunCollisionError(record.id);
        this.runs.set(record.id, record);
    }

    /** Finalize a run with terminal status and timestamp. */
    async finalizeRun(runId: string, status: WorkflowStatus, completedAt: string): Promise<void> {
        const run = this.runs.get(runId);
        if (run !== undefined) this.runs.set(runId, { ...run, status, completed_at: completedAt });
    }

    readonly actionRuns: Array<{
        id: string;
        runId: string;
        node: string;
        kind: string;
        status: WorkflowStatus;
        durationMs: number | null;
        ok: number | null;
        resultJson: string | null;
    }> = [];

    /** Insert a running action row. The `options` arg is mirror-only (observability seam) and deliberately ignored by the in-memory adapter. */
    async saveActionStart(
        runId: string,
        node: string,
        kind: string,
        _options?: Record<string, unknown>,
    ): Promise<string> {
        const id = crypto.randomUUID();
        this.actionRuns.push({
            id,
            runId,
            node,
            kind,
            status: 'running',
            durationMs: null,
            ok: null,
            resultJson: null,
        });
        return id;
    }

    /** Finalize an action row. */
    async saveActionFinalize(
        actionId: string,
        status: WorkflowStatus,
        durationMs: number,
        ok: boolean,
        kind: string,
        result?: unknown,
        redactor?: ActionRedactor,
    ): Promise<void> {
        const row = this.actionRuns.find((a) => a.id === actionId);
        if (row === undefined) return;
        row.status = status;
        row.durationMs = durationMs;
        row.ok = ok ? 1 : 0;
        row.resultJson = result !== undefined ? JSON.stringify(applyRedactor(redactor, kind, result)) : null;
    }

    /** Save one phase/state execution record. */
    async savePhase(runId: string, phase: string, status: WorkflowStatus): Promise<void> {
        this.phases.push({ runId, phase, status });
    }

    /** Save one transition record. */
    async saveTransition(runId: string, from: string, to: string, trigger: string | null): Promise<void> {
        this.transitions.push({ runId, from, to, trigger });
    }

    /** Save the latest workflow state snapshot. */
    async saveWorkflowState(runId: string, state: string, data: Record<string, unknown>): Promise<void> {
        this.states.push({ runId, state, data });
    }

    async commitTransition(
        runId: string,
        from: string,
        to: string,
        trigger: string | null,
        state: string,
        data: Record<string, unknown>,
        phase?: { phase: string; status: WorkflowStatus },
    ): Promise<void> {
        // Memory adapter: synchronous pushes are atomic by nature.
        this.transitions.push({ runId, from, to, trigger });
        this.states.push({ runId, state, data });
        if (phase) {
            this.phases.push({ runId, phase: phase.phase, status: phase.status });
        }
    }

    /** Load a single run by id. */
    async loadRun(runId: string): Promise<WorkflowRunRecord | undefined> {
        return this.runs.get(runId);
    }

    /** List persisted workflow runs. */
    async listRuns(): Promise<readonly WorkflowRunRecord[]> {
        return [...this.runs.values()];
    }

    /** Look up a run by its external key within a workflow definition. */
    async findRunByKey(workflowName: string, externalKey: string): Promise<WorkflowRunRecord | undefined> {
        for (const run of this.runs.values()) {
            if (run.workflow_name === workflowName && run.external_key === externalKey) return run;
        }
        return undefined;
    }

    /** Create a run or attach to an existing one by external key. */
    async createOrAttachRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
        if (record.external_key) {
            const existing = await this.findRunByKey(record.workflow_name, record.external_key);
            if (existing) return existing;
        }
        await this.createRun(record);
        return { ...record };
    }

    /** Force-set the current state of a run (reseed). */
    async reseedRun(runId: string, newState: string): Promise<WorkflowReseedResult> {
        const previous = await this.loadLatestStateSnapshot(runId);
        const data = {
            ...(previous?.data ?? {}),
            reseeded: true,
            reseededAt: new Date().toISOString(),
        };
        await this.commitTransition(runId, previous?.state ?? '', newState, '__reseed__', newState, data);
        return { fromState: previous?.state ?? null, toState: newState };
    }

    /** Load the current state name for a run. */
    async loadCurrentState(runId: string): Promise<string | undefined> {
        const last = this.states.findLast((s) => s.runId === runId);
        return last?.state;
    }
    /** Load the latest state snapshot (full data payload) for a run. */
    async loadLatestStateSnapshot(
        runId: string,
    ): Promise<{ state: string; data: Record<string, unknown> } | undefined> {
        const last = this.states.findLast((s) => s.runId === runId);
        if (last === undefined) return undefined;
        return { state: last.state, data: last.data };
    }

    /** List runs with status 'paused'. Ordered most-recent-first. */
    async listPausedRuns(options?: { workflowName?: string; limit?: number }): Promise<readonly WorkflowRunRecord[]> {
        let runs = [...this.runs.values()].filter((r) => r.status === 'paused');
        if (options?.workflowName !== undefined) {
            runs = runs.filter((r) => r.workflow_name === options.workflowName);
        }
        // Memory adapter has no updated_at tracking; use insertion order (reverse = most-recent-first).
        runs.reverse();
        return runs.slice(0, options?.limit ?? 100);
    }
}
