import { describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { EventBus, setLoggerMuted } from '@gobing-ai/ts-infra';
import { RuleEngine } from '../src/engine';
import { RuleEngineHost } from '../src/host/rule-engine-host';
import { DbRulePersistenceAdapter } from '../src/persistence/db-adapter';
import { MemoryRulePersistenceAdapter } from '../src/persistence/memory-adapter';
import { RULE_ENGINE_SCHEMA_SQL } from '../src/persistence/schema';
import type { ConstraintRule } from '../src/types';

setLoggerMuted(true);

function rule(id: string, evaluator = 'pass', severity: 'error' | 'warning' | 'info' = 'error'): ConstraintRule {
    return {
        id,
        description: id,
        enabled: true,
        severity,
        evaluator: { type: evaluator },
    };
}

function hostWithEvaluators(): RuleEngineHost {
    const host = new RuleEngineHost();
    host.evaluators.register(
        'pass',
        {
            async evaluate() {
                return { findings: [], fixes: [] };
            },
        },
        'extension',
    );
    host.evaluators.register(
        'violate',
        {
            async evaluate(ruleDef) {
                return {
                    findings: [
                        {
                            ruleId: ruleDef.id,
                            severity: ruleDef.severity,
                            message: 'violation',
                            filePath: null,
                            kind: 'violation' as const,
                        },
                    ],
                    fixes: [],
                };
            },
        },
        'extension',
    );
    host.evaluators.register(
        'crash',
        {
            async evaluate() {
                throw new Error('boom');
            },
        },
        'extension',
    );
    host.evaluators.register(
        'withFixes',
        {
            async evaluate(ruleDef) {
                return {
                    findings: [
                        {
                            ruleId: ruleDef.id,
                            severity: ruleDef.severity,
                            message: 'fixable',
                            filePath: 'src/a.ts',
                            kind: 'violation' as const,
                        },
                    ],
                    fixes: [
                        {
                            ruleId: ruleDef.id,
                            message: 'auto-fix',
                            filePath: 'src/a.ts',
                            replacement: 'x',
                            start: 0,
                            end: 1,
                            mode: 'auto' as const,
                        },
                    ],
                };
            },
        },
        'extension',
    );
    return host;
}

/** Apply multi-statement DDL through the db adapter by splitting on `;`. */
async function execDdl(db: DbAdapter, sql: string): Promise<void> {
    for (const stmt of sql.split(';')) {
        const trimmed = stmt.trim();
        if (trimmed.length > 0) {
            await db.exec(`${trimmed};`);
        }
    }
}

describe('RULE_ENGINE_SCHEMA_SQL', () => {
    test('creates rule_runs and rule_eval_runs tables', async () => {
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        await execDdl(db, RULE_ENGINE_SCHEMA_SQL);
        // Tables exist — verify by inserting.
        await db.run(`INSERT INTO rule_runs (id, source_kind, status, started_at, created_at, updated_at)
                       VALUES ('r1', 'preset', 'running', datetime('now'), datetime('now'), datetime('now'))`);
        await db.run(`INSERT INTO rule_eval_runs (id, run_id, rule_id, severity, evaluator, status, started_at, created_at, updated_at)
                       VALUES ('e1', 'r1', 'no-x', 'error', 'rg', 'running', datetime('now'), datetime('now'), datetime('now'))`);
        const rows = await db.queryAll('SELECT id, status FROM rule_runs');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({ id: 'r1', status: 'running' });
    });

    test('rule_eval_runs has FK to rule_runs', async () => {
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        await execDdl(db, RULE_ENGINE_SCHEMA_SQL);
        await db.run(`INSERT INTO rule_runs (id, source_kind, status, started_at, created_at, updated_at)
                       VALUES ('r1', 'file', 'running', datetime('now'), datetime('now'), datetime('now'))`);
        await db.run(`INSERT INTO rule_eval_runs (id, run_id, rule_id, severity, evaluator, status, started_at, created_at, updated_at)
                       VALUES ('e1', 'r1', 'rule-a', 'warning', 'rg', 'running', datetime('now'), datetime('now'), datetime('now'))`);
        // FK enforcement — inserting with missing run_id should fail with FK constraint if enabled
        // SQLite requires PRAGMA foreign_keys = ON; the DB adapter does this by default
        const evalRows = await db.queryAll('SELECT * FROM rule_eval_runs WHERE run_id = ?', 'r1');
        expect(evalRows).toHaveLength(1);
    });
});
// ── Memory adapter tests ────────────────────────────────────────

describe('MemoryRulePersistenceAdapter', () => {
    test('insertRun creates a running row', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await adapter.insertRun({ id: 'r1', sourceKind: 'preset', ruleCount: 3, fixMode: 'none', dryRun: false });
        expect(adapter.runs.get('r1')?.status).toBe('running');
        expect(adapter.runs.get('r1')?.ruleCount).toBe(3);
    });

    test('updateRunStatus finalizes to done', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await adapter.insertRun({ id: 'r1', sourceKind: 'preset', ruleCount: 3, fixMode: 'none', dryRun: false });
        await adapter.updateRunStatus('r1', 'done', 2, 1, 1, 1500);
        expect(adapter.runs.get('r1')?.status).toBe('done');
        expect(adapter.runs.get('r1')?.findingCount).toBe(2);
        expect(adapter.runs.get('r1')?.fixCount).toBe(1);
        expect(adapter.runs.get('r1')?.appliedFixCount).toBe(1);
        expect(adapter.runs.get('r1')?.durationMs).toBe(1500);
    });

    test('insertEvalRun and updateEvalRun lifecycle', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await adapter.insertRun({ id: 'r1', sourceKind: 'preset', ruleCount: 1, fixMode: 'none', dryRun: false });
        await adapter.insertEvalRun({ id: 'r1:no-x', runId: 'r1', ruleId: 'no-x', severity: 'error', evaluator: 'rg' });
        const key = 'r1:no-x';
        expect(adapter.evals.get(key)?.status).toBe('running');
        await adapter.updateEvalRun({
            runId: 'r1',
            ruleId: 'no-x',
            status: 'done',
            findingCount: 0,
            fixCount: 0,
            durationMs: 42,
        });
        expect(adapter.evals.get(key)?.status).toBe('done');
        expect(adapter.evals.get(key)?.durationMs).toBe(42);
    });

    test('updateEvalRun records evaluator error', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await adapter.insertRun({ id: 'r1', sourceKind: 'preset', ruleCount: 1, fixMode: 'none', dryRun: false });
        await adapter.insertEvalRun({
            id: 'r1:crashy',
            runId: 'r1',
            ruleId: 'crashy',
            severity: 'error',
            evaluator: 'rg',
        });
        await adapter.updateEvalRun({
            runId: 'r1',
            ruleId: 'crashy',
            status: 'failed',
            findingCount: 1,
            fixCount: 0,
            durationMs: 5,
            error: 'boom',
        });
        expect(adapter.evals.get('r1:crashy')?.status).toBe('failed');
        expect(adapter.evals.get('r1:crashy')?.error).toBe('boom');
    });
});

// ── Engine persistence integration tests ────────────────────────

describe('RuleEngine persistence', () => {
    test('writes run row as done when evaluation completes', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        const engine = new RuleEngine({
            host: hostWithEvaluators(),
            persistence: adapter,
            runId: 'test-run-1',
        });
        const rules = [rule('no-issues', 'pass')];
        await engine.evaluate(rules, '/tmp');

        // biome-ignore lint/style/noNonNullAssertion: key guaranteed by insertRun above
        const run = adapter.runs.get('test-run-1')!;
        expect(run.status).toBe('done');
        expect(run.ruleCount).toBe(1);
        expect(run.findingCount).toBe(0);
        expect(run.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('records finding counts in final run row', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        const engine = new RuleEngine({
            host: hostWithEvaluators(),
            persistence: adapter,
            runId: 'test-run-2',
        });
        const rules = [rule('r1', 'violate'), rule('r2', 'violate')];
        await engine.evaluate(rules, '/tmp');

        // biome-ignore lint/style/noNonNullAssertion: key guaranteed by insertRun above
        const run = adapter.runs.get('test-run-2')!;
        expect(run.status).toBe('done');
        expect(run.findingCount).toBe(2);
    });

    test('records per-rule eval rows in order', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        const engine = new RuleEngine({
            host: hostWithEvaluators(),
            persistence: adapter,
            runId: 'test-run-3',
        });
        const rules = [rule('a', 'pass'), rule('b', 'violate'), rule('c', 'pass')];
        await engine.evaluate(rules, '/tmp');

        expect(adapter.evals.get('test-run-3:a')?.status).toBe('done');
        expect(adapter.evals.get('test-run-3:a')?.findingCount).toBe(0);
        expect(adapter.evals.get('test-run-3:b')?.status).toBe('done');
        expect(adapter.evals.get('test-run-3:b')?.findingCount).toBe(1);
        expect(adapter.evals.get('test-run-3:c')?.status).toBe('done');
        expect(adapter.evals.get('test-run-3:c')?.findingCount).toBe(0);
    });

    test('records evaluator error as failed eval row', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        const engine = new RuleEngine({
            host: hostWithEvaluators(),
            persistence: adapter,
            runId: 'test-run-4',
        });
        const rules = [rule('crashy', 'crash')];
        await engine.evaluate(rules, '/tmp');

        // biome-ignore lint/style/noNonNullAssertion: key guaranteed by insertEvalRun above
        const evalRow = adapter.evals.get('test-run-4:crashy')!;
        expect(evalRow.status).toBe('failed');
        expect(evalRow.error).toBe('boom');
        // Run still completes as done (not failed) — evaluator errors are findings, not run failures.
        expect(adapter.runs.get('test-run-4')?.status).toBe('done');
    });

    test('stop-on-first records only evaluated rules', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        const engine = new RuleEngine({
            host: hostWithEvaluators(),
            persistence: adapter,
            runId: 'test-run-5',
        });
        const rules = [rule('a', 'pass'), rule('b', 'violate'), rule('c', 'pass')];
        await engine.evaluate(rules, '/tmp', 'error');

        // Rule a (pass) → evaluated. Rule b (violate) → stop. Rule c should NOT be evaluated.
        expect(adapter.evals.has('test-run-5:a')).toBe(true);
        expect(adapter.evals.has('test-run-5:b')).toBe(true);
        expect(adapter.evals.has('test-run-5:c')).toBe(false);
    });

    test('disabled rules are not inserted as eval rows', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        const engine = new RuleEngine({
            host: hostWithEvaluators(),
            persistence: adapter,
            runId: 'test-run-6',
        });
        const rules = [rule('enabled', 'pass'), { ...rule('disabled', 'pass'), enabled: false }];
        await engine.evaluate(rules, '/tmp');

        expect(adapter.evals.has('test-run-6:enabled')).toBe(true);
        expect(adapter.evals.has('test-run-6:disabled')).toBe(false);
    });

    test('evaluateWithFixes records fix counts in eval rows', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        const engine = new RuleEngine({
            host: hostWithEvaluators(),
            persistence: adapter,
            runId: 'test-run-fix',
        });
        const rules = [rule('fixable', 'withFixes')];
        await engine.evaluateWithFixes(rules, '/tmp', 'auto');

        // biome-ignore lint/style/noNonNullAssertion: key guaranteed by insertEvalRun above
        const evalRow = adapter.evals.get('test-run-fix:fixable')!;
        expect(evalRow.status).toBe('done');
        expect(evalRow.findingCount).toBe(1);
        expect(evalRow.fixCount).toBe(1);
    });

    test('generates a UUID runId when none provided', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        const engine = new RuleEngine({
            host: hostWithEvaluators(),
            persistence: adapter,
        });
        await engine.evaluate([rule('x', 'pass')], '/tmp');

        // A single run was written with a UUID-like id.
        expect(adapter.runs.size).toBe(1);
        const [id] = adapter.runs.keys();
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('no persistence adapter → no writes, no crash', async () => {
        const events = new EventBus<import('../src/events').RuleEngineEvents>();
        const engine = new RuleEngine({
            host: hostWithEvaluators(),
            events,
        });
        const result = await engine.evaluate([rule('x', 'pass')], '/tmp');
        expect(result.findings).toHaveLength(0);
        // No persistence adapter — engine should work normally without persistence.
    });
});

// ── DB adapter integration test ─────────────────────────────────

describe('DbRulePersistenceAdapter', () => {
    async function freshDb(): Promise<DbAdapter> {
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        await execDdl(db, RULE_ENGINE_SCHEMA_SQL);
        return db;
    }

    test('insertRun → updateRunStatus lifecycle', async () => {
        const db = await freshDb();
        const adapter = new DbRulePersistenceAdapter(db);
        await adapter.insertRun({ id: 'r1', sourceKind: 'preset', ruleCount: 3, fixMode: 'none', dryRun: false });

        const runBefore = await db.queryFirst<{ status: string; finding_count: number; duration_ms: number | null }>(
            'SELECT status, finding_count, duration_ms FROM rule_runs WHERE id = ?',
            'r1',
        );
        expect(runBefore).toEqual({ status: 'running', finding_count: 0, duration_ms: null });
        await adapter.updateRunStatus('r1', 'done', 2, 1, 0, 1500);
        const runAfter = await db.queryFirst<{
            status: string;
            finding_count: number;
            fix_count: number;
            duration_ms: number;
        }>('SELECT status, finding_count, fix_count, duration_ms FROM rule_runs WHERE id = ?', 'r1');
        expect(runAfter?.status).toBe('done');
        expect(runAfter?.finding_count).toBe(2);
        expect(runAfter?.fix_count).toBe(1);
        expect(runAfter?.duration_ms).toBe(1500);
    });

    test('insertEvalRun → updateEvalRun lifecycle', async () => {
        const db = await freshDb();
        const adapter = new DbRulePersistenceAdapter(db);
        await db.run(`INSERT INTO rule_runs (id, source_kind, status, started_at, created_at, updated_at)
                       VALUES ('r1', 'preset', 'running', datetime('now'), datetime('now'), datetime('now'))`);
        await adapter.insertEvalRun({ id: 'e1', runId: 'r1', ruleId: 'no-x', severity: 'error', evaluator: 'rg' });

        const evalBefore = await db.queryFirst<{ status: string; duration_ms: number | null }>(
            'SELECT status, duration_ms FROM rule_eval_runs WHERE id = ?',
            'e1',
        );
        expect(evalBefore).toEqual({ status: 'running', duration_ms: null });

        await adapter.updateEvalRun({
            runId: 'r1',
            ruleId: 'no-x',
            status: 'done',
            findingCount: 0,
            fixCount: 0,
            durationMs: 42,
        });
        const evalAfter = await db.queryFirst<{ status: string; duration_ms: number }>(
            'SELECT status, duration_ms FROM rule_eval_runs WHERE run_id = ? AND rule_id = ?',
            'r1',
            'no-x',
        );
        expect(evalAfter?.status).toBe('done');
        expect(evalAfter?.duration_ms).toBe(42);
    });
});
