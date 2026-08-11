import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { HistoryImportError, runJsonlImport } from '../src';
import { applyHistoryImportSchema, insertRecord, targetTableFor } from '../src/jsonl-importer-dao';
import { agySplit, claudeSplit, grokSplit, piSplit, stableFieldShape } from '../src/mappers';
import { HISTORY_IMPORT_SCHEMA_SQL } from '../src/schema-sql';
import { getSourceDefinition, SOURCE_DEFINITIONS, VALID_TABLE_NAME } from '../src/sources';

const fixedNow = () => new Date('2026-08-07T00:00:00.000Z');

async function fixtureFile(lines: readonly string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'forensic-contract-'));
    const file = join(dir, 'session.jsonl');
    await writeFile(file, `${lines.join('\n')}\n`);
    return file;
}

describe('R2 VALID_TABLE_NAME admits contract tables', () => {
    test('accepts history_message and history_tool_call', () => {
        expect(VALID_TABLE_NAME.test('history_message')).toBe(true);
        expect(VALID_TABLE_NAME.test('history_tool_call')).toBe(true);
        expect(targetTableFor('history_message')).toBe('history_message');
        expect(targetTableFor('history_tool_call')).toBe('history_tool_call');
    });

    test('rejects space, quote, semicolon, uppercase, and leading digit', () => {
        for (const bad of [
            'history message',
            "history_message'",
            'history_message;drop',
            'History_message',
            '1history_msg',
        ]) {
            expect(VALID_TABLE_NAME.test(bad)).toBe(false);
            expect(() => targetTableFor(bad)).toThrow(HistoryImportError);
        }
    });
});

describe('R3 typed schema + typed insert', () => {
    let db: DbAdapter;

    beforeEach(async () => {
        db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        await applyHistoryImportSchema(db);
    });

    test('schema SQL declares history_message and history_tool_call with tool_name column', () => {
        expect(HISTORY_IMPORT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS history_message');
        expect(HISTORY_IMPORT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS history_tool_call');
        expect(HISTORY_IMPORT_SCHEMA_SQL).toContain('tool_name');
        expect(HISTORY_IMPORT_SCHEMA_SQL).toContain('idx_history_tool_call_tool_name');
    });

    test('applyHistoryImportSchema creates contract tables', async () => {
        const tables = await db.queryAll<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        );
        const names = tables.map((t) => t.name);
        expect(names).toContain('history_message');
        expect(names).toContain('history_tool_call');
    });

    test('typed insert populates real columns and GROUP BY tool_name works without JSON extract', async () => {
        await insertRecord(
            db,
            'history_tool_call',
            'tc-hash-1',
            '/tmp/a.jsonl',
            1,
            1,
            {
                message_hash: 'msg-1',
                source: 'claude',
                source_file: '/tmp/a.jsonl',
                source_line: 1,
                session_id: 's1',
                seq: 1,
                tool_name: 'Bash',
                args_digest: 'deadbeef',
                status: 'ok',
                duration_ms: 12,
            },
            fixedNow,
        );
        await insertRecord(
            db,
            'history_tool_call',
            'tc-hash-2',
            '/tmp/a.jsonl',
            2,
            1,
            {
                message_hash: 'msg-1',
                source: 'claude',
                source_file: '/tmp/a.jsonl',
                source_line: 2,
                session_id: 's1',
                seq: 2,
                tool_name: 'Bash',
                args_digest: 'cafebabe',
                status: 'ok',
                duration_ms: 8,
            },
            fixedNow,
        );

        const rows = await db.queryAll<{ tool_name: string; total_ms: number }>(
            'SELECT tool_name, SUM(duration_ms) AS total_ms FROM history_tool_call GROUP BY tool_name',
        );
        expect(rows).toEqual([{ tool_name: 'Bash', total_ms: 20 }]);
    });

    test('typed insert throws on unknown mapper keys', async () => {
        await expect(
            insertRecord(
                db,
                'history_message',
                'bad-hash',
                '/tmp/a.jsonl',
                1,
                0,
                { session_id: 's', not_a_column: true },
                fixedNow,
            ),
        ).rejects.toThrow(/unknown columns/);
    });
});

describe('R1 per-entry targetTable fan-out', () => {
    let db: DbAdapter;

    beforeEach(async () => {
        db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
    });

    test('one Claude assistant line fans into history_message + history_tool_call rows', async () => {
        const file = await fixtureFile([
            JSON.stringify({
                sessionId: 'sess-claude',
                type: 'assistant',
                timestamp: '2026-08-07T00:00:00.000Z',
                messageIndex: 1,
                content: [
                    { type: 'text', text: 'running bash' },
                    { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
                    { type: 'tool_use', name: 'Read', input: { path: '/tmp/x' } },
                ],
            }),
        ]);

        const result = await runJsonlImport('claude', { db, files: [file], mode: 'full', now: fixedNow });
        expect(result.importedRecords).toBe(3);

        const messages = await db.queryAll<{ record_hash: string; content_text: string }>(
            'SELECT record_hash, content_text FROM history_message',
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]?.content_text).toContain('running bash');

        const tools = await db.queryAll<{ tool_name: string; message_hash: string; args_digest: string | null }>(
            'SELECT tool_name, message_hash, args_digest FROM history_tool_call ORDER BY tool_name',
        );
        expect(tools).toHaveLength(2);
        expect(tools.map((t) => t.tool_name).sort()).toEqual(['Bash', 'Read']);
        // R4 join: every tool row references the parent message hash.
        expect(tools.every((t) => t.message_hash === messages[0]?.record_hash)).toBe(true);
        // R8: args_digest is sha256 hex, never raw args.
        for (const t of tools) {
            expect(t.args_digest).toMatch(/^[a-f0-9]{64}$/);
            expect(t.args_digest).not.toContain('ls -la');
        }
    });

    test('entry omitting targetTable falls back to definition targetTable via custom bare objects', async () => {
        // A one-to-one generic source still lands in its definition target table.
        const file = await fixtureFile([
            JSON.stringify({ id: 'g1', timestamp: '2026-08-07T00:00:00.000Z', content: 'hello' }),
        ]);
        const result = await runJsonlImport('antigravity', { db, files: [file], mode: 'full', now: fixedNow });
        expect(result.importedRecords).toBe(1);
        const rows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_antigravity');
        expect(rows).toHaveLength(1);
    });
});

describe('R5 source registry covers six in-scope agents', () => {
    test('SOURCE_DEFINITIONS includes omp, grok, agy with correct roots/patterns', () => {
        for (const source of ['pi', 'claude', 'codex', 'omp', 'grok', 'agy'] as const) {
            expect(SOURCE_DEFINITIONS[source]).toBeDefined();
            const def = getSourceDefinition(source);
            expect(def.splitConfig.mode).toBe('custom');
            expect(def.filePatterns).toEqual(['*.jsonl']);
        }
        expect(getSourceDefinition('pi').defaultRoots).toEqual(['.pi/agent/sessions']);
        expect(getSourceDefinition('claude').defaultRoots).toEqual(['.claude/projects']);
        expect(getSourceDefinition('codex').defaultRoots).toEqual(['.codex/sessions']);
        expect(getSourceDefinition('omp').defaultRoots).toEqual(['.omp/agent/sessions']);
        expect(getSourceDefinition('grok').defaultRoots).toEqual(['.grok/sessions']);
        expect(getSourceDefinition('agy').defaultRoots).toEqual(['.gemini/antigravity-cli/brain']);
    });

    test('pi patterns no longer include bare *.json', () => {
        expect(getSourceDefinition('pi').filePatterns).not.toContain('*.json');
    });
});

describe('R6 unknown capture + stable field shape', () => {
    let db: DbAdapter;

    beforeEach(async () => {
        db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
    });

    test('stableFieldShape is order-independent', () => {
        expect(stableFieldShape({ b: 1, a: 2 })).toBe(stableFieldShape({ a: 2, b: 1 }));
        expect(stableFieldShape({ Foo: 1, bar: 2 })).toBe('bar+foo');
    });

    test('grok record with no type discriminator is unknown and counted', async () => {
        const file = await fixtureFile([JSON.stringify({ timestamp: 1784274007, foo: 'bar', baz: 1 })]);
        const result = await runJsonlImport('grok', { db, files: [file], mode: 'full', now: fixedNow });
        expect(result.importedRecords).toBe(1);
        expect(result.unknownRecords).toBe(1);
        const rows = await db.queryAll<{ disposition: string; record_type: string }>(
            'SELECT disposition, record_type FROM history_message',
        );
        expect(rows[0]?.disposition).toBe('unknown');
        expect(rows[0]?.record_type).toBe('baz+foo+timestamp');
    });

    test('grok updates.jsonl tool_call unwraps sessionUpdate and is not unknown', () => {
        const entries = grokSplit({
            timestamp: 1784274045,
            method: 'session/update',
            params: {
                sessionId: 'sess-1',
                update: {
                    sessionUpdate: 'tool_call',
                    toolCallId: 'call-1',
                    title: 'read_file',
                    rawInput: { path: '/tmp/secret-token-aaaaaaaaaaaaaaaaaaaa' },
                    _meta: { 'x.ai/tool': { name: 'read_file' } },
                },
            },
        });
        expect(entries.some((e) => e.targetTable === 'history_tool_call')).toBe(true);
        expect(entries.every((e) => e.record.disposition !== 'unknown')).toBe(true);
        const tool = entries.find((e) => e.targetTable === 'history_tool_call');
        expect(tool?.record.tool_name).toBe('read_file');
        expect(String(tool?.record.args_digest)).toMatch(/^[a-f0-9]{64}$/);
    });

    test('grok phase_changed is meta, not unknown', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'phase_changed',
            phase: 'planning',
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.record.disposition).toBe('meta');
        expect(entries[0]?.record.record_type).toBe('phase_changed');
    });
});

describe('R4/R8 mapper contracts', () => {
    test('claudeSplit emits message + tool_call entries joined by _messageSplitIndex', () => {
        const entries = claudeSplit({
            sessionId: 's',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: [{ type: 'tool_use', name: 'Edit', input: { path: 'a.ts' } }],
        });
        expect(entries[0]?.targetTable).toBe('history_message');
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[1]?.record._messageSplitIndex).toBe(0);
        expect(entries[1]?.record).not.toHaveProperty('input');
        expect(entries[1]?.record).not.toHaveProperty('arguments');
    });

    test('piSplit maps cost.total to cost_usd', () => {
        const entries = piSplit({
            id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hi',
            message: { usage: { input: 10, output: 5 }, cost: { total: 0.0123 } },
        });
        expect(entries[0]?.record.cost_usd).toBe(0.0123);
        expect(entries[0]?.record.input_tokens).toBe(10);
    });

    test('agy keeps model/usage null and never invents duration_ms', () => {
        const entries = agySplit({
            type: 'PLANNER_RESPONSE',
            step_index: 3,
            created_at: '2026-08-07T00:00:00.000Z',
            content: 'plan',
            tool_calls: [{ name: 'run', arguments: { cmd: 'echo hi' } }],
        });
        const msg = entries.find((e) => e.targetTable === 'history_message');
        expect(msg?.record.model).toBeNull();
        expect(msg?.record.input_tokens).toBeNull();
        expect(msg?.record.output_tokens).toBeNull();
        expect(msg?.record.duration_ms).toBeUndefined();
        const tool = entries.find((e) => e.targetTable === 'history_tool_call');
        expect(tool?.record.args_digest).toMatch(/^[a-f0-9]{64}$/);
    });
});
