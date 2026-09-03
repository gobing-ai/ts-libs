import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { canonicalizeSkillName, runJsonlImport, runOpenCodeImport, type SkillCallSplitRecord } from '../src';
import { applyHistoryImportSchema } from '../src/jsonl-importer-dao';

const fixedNow = () => new Date('2026-08-07T00:00:00.000Z');

let db: DbAdapter;
let directory: string;
let fileSeq = 0;

beforeEach(async () => {
    db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
    directory = await mkdtemp(join(tmpdir(), 'llm-jsonl-importer-0736-'));
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

/** Import one source's fixture lines through the real pipeline and return the skill rows. */
async function importSkillRows(
    source: Parameters<typeof runJsonlImport>[0],
    lines: readonly unknown[],
): Promise<Record<string, unknown>[]> {
    const file = join(directory, `${source}-fixture-${fileSeq++}.jsonl`);
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const discovered = await realpath(file);
    const result = await runJsonlImport(source, { db, files: [discovered], mode: 'full', now: fixedNow });
    expect(result.validationErrors).toEqual([]);
    expect(result.parseErrors).toEqual([]);
    return db.queryAll<Record<string, unknown>>('SELECT * FROM history_skill_call ORDER BY rowid');
}

describe('canonicalizeSkillName (0736 R3)', () => {
    test('maps every harness dialect to the canonical package:name form', () => {
        expect(canonicalizeSkillName('sp-dev-run')).toBe('sp:dev-run');
        expect(canonicalizeSkillName('/sp-dev-verify')).toBe('sp:dev-verify');
        expect(canonicalizeSkillName('$sp-dev-run')).toBe('sp:dev-run');
        expect(canonicalizeSkillName('skill:sp-dev-run')).toBe('sp:dev-run');
        expect(canonicalizeSkillName('rd3-dev-run')).toBe('rd3:dev-run');
        expect(canonicalizeSkillName('sp:dev-run')).toBe('sp:dev-run');
    });

    test('keeps unqualified names verbatim (exact structural match, no heuristic rewrites)', () => {
        expect(canonicalizeSkillName('code-review')).toBe('code-review');
        expect(canonicalizeSkillName('some-skill-name')).toBe('some-skill-name');
    });
});

describe('per-agent skill-load extraction (0736 R1/R2, AC1–AC3)', () => {
    test('claude: assistant Skill tool_use produces a model row with args (AC1)', async () => {
        const rows = await importSkillRows('claude', [
            {
                type: 'assistant',
                sessionId: 'session-claude',
                ts: '2026-05-30T00:00:00.000Z',
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'tu_1',
                            name: 'Skill',
                            input: { skill: 'sp:dev-run', args: '0736 --auto' },
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            session_id: 'session-claude',
            skill_name: 'sp:dev-run',
            invocation_kind: 'model',
            call_id: 'tu_1',
        });
        expect(String(rows[0]?.args_raw)).toContain('0736');
        // message_hash links to the parent message row emitted by the same line.
        expect(rows[0]?.message_hash).toBeString();
    });

    test('claude: caller.type direct marks a user-invoked load', async () => {
        const rows = await importSkillRows('claude', [
            {
                type: 'assistant',
                sessionId: 'session-claude-direct',
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'tu_2',
                            name: 'Skill',
                            caller: { type: 'direct' },
                            input: { skill: 'sp:dev-verify' },
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ invocation_kind: 'user', skill_name: 'sp:dev-verify' });
    });

    test('pi: user-message <skill> wrapper produces a user row with name and path (AC2)', async () => {
        const rows = await importSkillRows('pi', [
            {
                type: 'message',
                timestamp: '2026-05-30T00:00:00.000Z',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<skill name="sp-dev-run" location="/home/x/.agents/skills/sp-dev-run/SKILL.md">\nbody',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            invocation_kind: 'user',
            skill_name: 'sp:dev-run',
            skill_path: '/home/x/.agents/skills/sp-dev-run/SKILL.md',
        });
    });

    test('omp: Skill toolCall produces a model row; the L2 wrapper does not trigger', async () => {
        const rows = await importSkillRows('omp', [
            {
                type: 'message',
                message: {
                    role: 'assistant',
                    content: [{ type: 'toolCall', id: 'call_1', name: 'Skill', arguments: { skill: 'rd3-verify' } }],
                },
            },
            {
                type: 'message',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<skill name="sp-dev-run" location="/tmp/SKILL.md">\nomp inline copy',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ invocation_kind: 'model', skill_name: 'rd3:verify', call_id: 'call_1' });
    });

    test('codex: child-element <skill> block produces a user row with path', async () => {
        const rows = await importSkillRows('codex', [
            {
                type: 'response_item',
                timestamp: '2026-05-30T00:00:00.000Z',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '$sp-dev-run 0736\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp/dev-run/SKILL.md</path>\n</skill>',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            invocation_kind: 'user',
            skill_name: 'sp:dev-run',
            skill_path: '/skills/sp/dev-run/SKILL.md',
        });
    });

    test('agy: view_file "Viewing skill file" produces a model row named from the summary', async () => {
        const rows = await importSkillRows('agy', [
            {
                type: 'PLANNER_RESPONSE',
                conversation_id: 'conv-agy',
                content: 'loading',
                tool_calls: [
                    {
                        name: 'view_file',
                        args: {
                            AbsolutePath: '/brain/agent/skills/sp-dev-run/SKILL.md',
                            toolAction: 'Viewing skill file',
                            toolSummary: 'View SKILL.md for sp-dev-run',
                        },
                    },
                ],
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            invocation_kind: 'model',
            skill_name: 'sp:dev-run',
            skill_path: '/brain/agent/skills/sp-dev-run/SKILL.md',
        });
    });

    test('gemini: L0 harness prefix in a user message produces a user row', async () => {
        const rows = await importSkillRows('gemini', [
            {
                id: 'message-g1',
                type: 'user',
                timestamp: '2026-05-30T00:00:00.000Z',
                content: [{ type: 'text', text: '/sp-dev-run 0736 --auto' }],
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ invocation_kind: 'user', skill_name: 'sp:dev-run' });
    });

    test('grok: grok_build read_file targeting SKILL.md produces a model row', async () => {
        const rows = await importSkillRows('grok', [
            {
                method: 'session/update',
                params: {
                    sessionId: 'session-grok',
                    update: {
                        sessionUpdate: 'tool_call',
                        title: 'Read `/skills/sp-dev-run/SKILL.md`',
                        rawInput: { target_file: '/skills/sp-dev-run/SKILL.md' },
                        _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', namespace: 'grok_build' } },
                    },
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            invocation_kind: 'model',
            skill_name: 'sp:dev-run',
            skill_path: '/skills/sp-dev-run/SKILL.md',
        });
    });

    test('grok: read_file outside the grok_build namespace produces nothing', async () => {
        const rows = await importSkillRows('grok', [
            {
                method: 'session/update',
                params: {
                    sessionId: 'session-grok-other',
                    update: {
                        sessionUpdate: 'tool_call',
                        title: 'Read `/tmp/SKILL.md`',
                        rawInput: { target_file: '/tmp/SKILL.md' },
                        _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', namespace: 'other' } },
                    },
                },
            },
        ]);
        expect(rows).toHaveLength(0);
    });
});

describe('false-positive suppression (0736 R4, AC4)', () => {
    test('prose quoting a wrapper fragment produces zero rows', async () => {
        const rows = await importSkillRows('pi', [
            {
                type: 'message',
                message: {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'the wrapper looks like <skill name= followed by a location attribute' },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(0);
    });

    test('the L0 prefix does not trigger for agents that have an L1', async () => {
        const claudeRows = await importSkillRows('claude', [
            {
                type: 'user',
                sessionId: 's-l0',
                message: { role: 'user', content: [{ type: 'text', text: '/sp:dev-run 0736' }] },
            },
        ]);
        expect(claudeRows).toHaveLength(0);
    });
});

describe('idempotency and dry-run (0736 R5, AC5)', () => {
    test('re-importing the same file yields no duplicate skill rows', async () => {
        const file = join(directory, 'claude-idem.jsonl');
        const line = JSON.stringify({
            type: 'assistant',
            sessionId: 'session-idem',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tu_i', name: 'Skill', input: { skill: 'sp:dev-run' } }],
            },
        });
        await writeFile(file, `${line}\n`);
        const discovered = await realpath(file);

        const first = await runJsonlImport('claude', { db, files: [discovered], mode: 'full', now: fixedNow });
        const second = await runJsonlImport('claude', { db, files: [discovered], mode: 'full', now: fixedNow });
        expect(first.importedRecords).toBe(3); // message + tool_call + skill_call
        expect(second.importedRecords).toBe(0);
        expect(second.skippedDuplicates).toBe(3);

        const rows = await db.queryAll<Record<string, unknown>>('SELECT * FROM history_skill_call');
        expect(rows).toHaveLength(1);
    });

    test('dry-run imports nothing', async () => {
        const file = join(directory, 'claude-dry.jsonl');
        await writeFile(
            file,
            `${JSON.stringify({
                type: 'assistant',
                sessionId: 'session-dry',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'tu_d', name: 'Skill', input: { skill: 'sp:dev-run' } }],
                },
            })}\n`,
        );
        const discovered = await realpath(file);
        await applyHistoryImportSchema(db);
        const result = await runJsonlImport('claude', {
            db,
            files: [discovered],
            mode: 'full',
            dryRun: true,
            now: fixedNow,
        });
        expect(result.importedRecords).toBe(3);
        const rows = await db.queryAll<Record<string, unknown>>('SELECT * FROM history_skill_call');
        expect(rows).toHaveLength(0);
    });
});

describe('opencode native skill tool (0736 R2, AC3)', () => {
    test('a skill part produces a history_skill_call row instead of a tool-call row', async () => {
        const dbPath = join(directory, 'opencode.db');
        const source = await createDbAdapter({ driver: 'bun-sqlite', url: dbPath });
        await source.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)');
        await source.exec(
            'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
        );
        await source.exec(
            'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
        );
        const started = Date.parse('2026-05-30T00:00:00.000Z');
        await source.run('INSERT INTO session (id, directory) VALUES (?, ?)', 'session-1', '/work/project');
        await source.run(
            'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
            'msg_1',
            'session-1',
            started,
            JSON.stringify({ role: 'assistant', time: { created: started / 1000 } }),
        );
        await source.run(
            'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
            'part_1',
            'msg_1',
            'session-1',
            started,
            JSON.stringify({
                type: 'tool',
                tool: 'skill',
                state: {
                    status: 'done',
                    input: { name: 'sp-dev-run' },
                    time: { start: started / 1000, end: started / 1000 + 5 },
                },
            }),
        );
        await source.close();

        const result = await runOpenCodeImport({ db, sourceDatabase: dbPath, mode: 'full', now: fixedNow });
        expect(result.validationErrors).toEqual([]);
        const rows = await db.queryAll<Record<string, unknown>>('SELECT * FROM history_skill_call');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            invocation_kind: 'model',
            skill_name: 'sp-dev-run',
            message_hash: expect.any(String),
        });
        // The load must not double-count as a generic tool call.
        const toolRows = await db.queryAll<Record<string, unknown>>('SELECT * FROM history_tool_call');
        expect(toolRows).toHaveLength(0);
    });
});

/** Type-level guard: the split record shape stays aligned with the DAO-managed row contract. */
describe('split record contract (0736)', () => {
    test('SkillCallSplitRecord carries only split-side columns', () => {
        const record: SkillCallSplitRecord = {
            _messageSplitIndex: 0,
            session_id: 's',
            seq: 0,
            skill_name: 'sp:dev-run',
            invocation_kind: 'user',
            skill_path: null,
            args_raw: null,
            args_digest: null,
            call_id: null,
            status: 'ok',
            started_at: null,
            completed_at: null,
            duration_ms: null,
        };
        expect(Object.keys(record)).not.toContain('record_hash');
        expect(Object.keys(record)).not.toContain('imported_at');
    });
});
