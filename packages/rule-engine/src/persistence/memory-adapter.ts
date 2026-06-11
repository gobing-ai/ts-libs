import type { RuleEvalRunInput, RuleEvalRunUpdate, RulePersistenceAdapter, RuleRunInput } from './adapter';

/** Runtime row shape for the memory adapter. */
interface RuleRunRow extends RuleRunInput {
    status: 'running' | 'done' | 'failed';
    findingCount: number;
    fixCount: number;
    appliedFixCount: number;
    durationMs: number | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

interface RuleEvalRow extends RuleEvalRunInput {
    status: 'running' | 'done' | 'failed' | 'skipped';
    findingCount: number;
    fixCount: number;
    durationMs: number | null;
    error: string | null;
    findingsJson: string | null;
    fixesJson: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * In-memory persistence adapter for unit tests.
 * Stores rows in Maps so tests can assert on persisted state.
 */
export class MemoryRulePersistenceAdapter implements RulePersistenceAdapter {
    constructor() {
        // Explicit constructor for V8 function coverage — class implements an interface, no super().
    }

    readonly runs = new Map<string, RuleRunRow>();
    readonly evals = new Map<string, RuleEvalRow>();

    async insertRun(input: RuleRunInput): Promise<void> {
        const now = new Date().toISOString();
        this.runs.set(input.id, {
            ...input,
            status: 'running',
            findingCount: 0,
            fixCount: 0,
            appliedFixCount: 0,
            durationMs: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
        });
    }

    async updateRunStatus(
        runId: string,
        status: 'done' | 'failed',
        findingCount: number,
        fixCount: number,
        appliedFixCount: number,
        durationMs: number,
    ): Promise<void> {
        const row = this.runs.get(runId);
        if (!row) throw new Error(`Run not found: ${runId}`);
        row.status = status;
        row.findingCount = findingCount;
        row.fixCount = fixCount;
        row.appliedFixCount = appliedFixCount;
        row.durationMs = durationMs;
        row.completedAt = new Date().toISOString();
        row.updatedAt = new Date().toISOString();
    }

    async insertEvalRun(input: RuleEvalRunInput): Promise<void> {
        const now = new Date().toISOString();
        const key = `${input.runId}:${input.ruleId}`;
        this.evals.set(key, {
            ...input,
            status: 'running',
            findingCount: 0,
            fixCount: 0,
            durationMs: null,
            error: null,
            findingsJson: null,
            fixesJson: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
        });
    }

    async updateEvalRun(input: RuleEvalRunUpdate): Promise<void> {
        const key = `${input.runId}:${input.ruleId}`;
        const row = this.evals.get(key);
        if (!row) throw new Error(`Eval run not found: ${key}`);
        row.status = input.status;
        row.findingCount = input.findingCount;
        row.fixCount = input.fixCount;
        row.durationMs = input.durationMs;
        row.error = input.error ?? null;
        row.findingsJson = input.findingsJson ?? null;
        row.fixesJson = input.fixesJson ?? null;
        row.completedAt = new Date().toISOString();
        row.updatedAt = new Date().toISOString();
    }
}
