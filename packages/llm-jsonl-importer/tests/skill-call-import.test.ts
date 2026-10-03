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
    options: { capabilityOrigins?: Parameters<typeof runJsonlImport>[1]['capabilityOrigins'] } = {},
): Promise<Record<string, unknown>[]> {
    const file = join(directory, `${source}-fixture-${fileSeq++}.jsonl`);
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const discovered = await realpath(file);
    const result = await runJsonlImport(source, {
        db,
        files: [discovered],
        mode: 'full',
        now: fixedNow,
        capabilityOrigins: options.capabilityOrigins,
    });
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

    test('omp: Skill toolCall produces a model row; the user wrapper is NOT ignored (E93)', async () => {
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
        expect(rows).toHaveLength(2);
        const modelRow = rows.find((row) => row.invocation_kind === 'model');
        const wrapperRow = rows.find((row) => row.invocation_kind === 'user');
        expect(modelRow).toMatchObject({
            skill_name: 'rd3:verify',
            call_id: 'call_1',
            evidence_kind: 'load',
            status: 'unknown',
            capability_kind: null,
        });
        expect(wrapperRow).toMatchObject({
            skill_name: 'sp:dev-run',
            skill_path: '/tmp/SKILL.md',
            evidence_kind: 'load',
            status: 'ok',
        });
        expect(modelRow?.invocation_id).not.toBeNull();
        expect(wrapperRow?.invocation_id).not.toBeNull();
        expect(modelRow?.invocation_id).not.toBe(wrapperRow?.invocation_id);
    });

    test('codex: marker + full-body <skill> block produce correlated request + load rows (E93)', async () => {
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
                            text: '$sp-dev-run 0736\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n</skill>',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(2);
        const request = rows.find((row) => row.evidence_kind === 'request');
        const load = rows.find((row) => row.evidence_kind === 'load');
        expect(request).toMatchObject({
            invocation_kind: 'user',
            skill_name: 'sp:dev-run',
            status: 'unknown',
            capability_kind: null,
        });
        expect(load).toMatchObject({
            invocation_kind: 'user',
            skill_name: 'sp:dev-run',
            skill_path: '/skills/sp-dev-run/SKILL.md',
            status: 'ok',
        });
        // Correlated syntax and wrapper for the same invocation share one identity.
        expect(request?.invocation_id).toBe(load?.invocation_id);
        expect(load).toMatchObject({
            invocation_kind: 'user',
            skill_name: 'sp:dev-run',
            skill_path: '/skills/sp-dev-run/SKILL.md',
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

// ---------------------------------------------------------------------------
// E93 task 1028 — capability facts, origins, invocation identity, pairing
// ---------------------------------------------------------------------------

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('capability origins (E93 AC1/AC5)', () => {
    test('origin absent: rows classify unknown capability facts', async () => {
        const rows = await importSkillRows('claude', [
            {
                type: 'assistant',
                sessionId: 's1',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'sp:dev-run' } }],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            capability_kind: null,
            origin_identity: null,
            evidence_kind: 'load',
            status: 'unknown',
        });
        expect(rows[0]?.invocation_id).not.toBeNull();
    });

    test('unique matching origin establishes capability_kind + origin_identity', async () => {
        const rows = await importSkillRows(
            'claude',
            [
                {
                    type: 'assistant',
                    sessionId: 's1',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'sp:dev-run' } }],
                    },
                },
            ],
            {
                capabilityOrigins: [
                    {
                        source: 'claude',
                        skillName: 'sp:dev-run',
                        artifactDigest: DIGEST_A,
                        capabilityKind: 'skill',
                        originIdentity: 'sp/src/skills/dev-run',
                    },
                ],
            },
        );
        expect(rows[0]).toMatchObject({
            capability_kind: 'skill',
            origin_identity: 'sp/src/skills/dev-run',
            evidence_kind: 'load',
        });
    });

    test('conflicting origins classify unknown and surface ONE bounded finding', async () => {
        const file = join(directory, 'claude-conflict.jsonl');
        const line = JSON.stringify({
            type: 'assistant',
            sessionId: 's1',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'sp:dev-run' } }],
            },
        });
        await writeFile(file, `${line}\n${line}\n${line}\n`);
        const discovered = await realpath(file);
        const result = await runJsonlImport('claude', {
            db,
            files: [discovered],
            mode: 'full',
            now: fixedNow,
            capabilityOrigins: [
                {
                    source: 'claude',
                    skillName: 'sp:dev-run',
                    artifactDigest: DIGEST_A,
                    capabilityKind: 'skill',
                    originIdentity: 'one',
                },
                {
                    source: 'claude',
                    skillName: 'sp:dev-run',
                    artifactDigest: DIGEST_B,
                    capabilityKind: 'command',
                    originIdentity: 'two',
                },
            ],
        });
        const rows = await db.queryAll<Record<string, unknown>>('SELECT * FROM history_skill_call');
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row.capability_kind).toBeNull();
            expect(row.origin_identity).toBeNull();
            expect(row.invocation_id).not.toBeNull();
        }
        expect(result.validationErrors).toHaveLength(1);
        expect(result.validationErrors[0]?.reason).toContain('capabilityOrigins');
        expect(result.validationErrors[0]?.sourceLine).toBe(1);
    });

    test('observed digest mismatching the supplied origin classifies unknown (never a guess)', async () => {
        const body = '# Dev Run\n\nReal body bytes.\n';
        const file = join(directory, 'codex-digest-mismatch.jsonl');
        const line = JSON.stringify({
            type: 'response_item',
            timestamp: '2026-05-30T00:00:00.000Z',
            payload: {
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n${body}</skill>`,
                    },
                ],
            },
        });
        await writeFile(file, `${line}\n`);
        const discovered = await realpath(file);
        const result = await runJsonlImport('codex', {
            db,
            files: [discovered],
            mode: 'full',
            now: fixedNow,
            capabilityOrigins: [
                {
                    source: 'codex',
                    skillName: 'sp:dev-run',
                    skillPath: '/skills/sp-dev-run/SKILL.md',
                    artifactDigest: DIGEST_A, // does not match the observed body
                    capabilityKind: 'skill',
                    originIdentity: 'sp/src/skills/dev-run',
                },
            ],
        });
        const rows = await db.queryAll<Record<string, unknown>>('SELECT * FROM history_skill_call ORDER BY rowid');
        const load = rows.find((row) => row.evidence_kind === 'load');
        expect(load).toMatchObject({ status: 'ok', capability_kind: null, origin_identity: null });
        // The digest mismatch is a bounded finding (deduped across the run).
        expect(result.validationErrors.length).toBeGreaterThanOrEqual(1);
        expect(result.validationErrors[0]?.reason).toContain('digest does not match');
    });

    test('matching full-body digest establishes the origin for a codex wrapper load', async () => {
        const body = '# Dev Run\n\nReal body bytes.\n';
        const { sha256Text } = await import('../src/hash');
        const rows = await importSkillRows(
            'codex',
            [
                {
                    type: 'response_item',
                    timestamp: '2026-05-30T00:00:00.000Z',
                    payload: {
                        type: 'message',
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n${body}</skill>`,
                            },
                        ],
                    },
                },
            ],
            {
                capabilityOrigins: [
                    {
                        source: 'codex',
                        skillName: 'sp:dev-run',
                        skillPath: '/skills/sp-dev-run/SKILL.md',
                        artifactDigest: sha256Text(body.trim()),
                        capabilityKind: 'skill',
                        originIdentity: 'sp/src/skills/dev-run',
                    },
                ],
            },
        );
        expect(rows.find((row) => row.evidence_kind === 'load')).toMatchObject({
            capability_kind: 'skill',
            origin_identity: 'sp/src/skills/dev-run',
            status: 'ok',
        });
    });

    test('malformed origins reject the run before any write', async () => {
        const file = join(directory, 'claude-bad-origin.jsonl');
        await writeFile(
            file,
            `${JSON.stringify({ type: 'user', sessionId: 's1', message: { role: 'user', content: 'plain' } })}\n`,
        );
        const discovered = await realpath(file);
        expect(
            runJsonlImport('claude', {
                db,
                files: [discovered],
                mode: 'full',
                now: fixedNow,
                capabilityOrigins: [
                    {
                        source: 'claude',
                        skillName: 'x',
                        artifactDigest: 'nothex',
                        capabilityKind: 'skill',
                        originIdentity: 'y',
                    },
                ],
            }),
        ).rejects.toThrow('capabilityOrigins');
    });
});

describe('E93 extraction breadth (AC2/AC3/AC4)', () => {
    test('claude: command expansion envelope is a native command request', async () => {
        const rows = await importSkillRows('claude', [
            {
                type: 'user',
                sessionId: 's1',
                timestamp: '2026-05-30T00:00:00.000Z',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<command-name>/sp:dev-run</command-name>\n<command-args>--auto</command-args>',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            skill_name: 'sp:dev-run',
            invocation_kind: 'user',
            capability_kind: 'command',
            evidence_kind: 'request',
            status: 'unknown',
            args_raw: '--auto',
        });
    });

    test('claude: repeated command expansion in one record collapses to one invocation', async () => {
        const text = '<command-name>/sp:dev-run</command-name>\n<command-name>/sp:dev-run</command-name>';
        const rows = await importSkillRows('claude', [
            { type: 'user', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text }] } },
        ]);
        expect(rows).toHaveLength(1);
    });

    test('claude: Task tool_use is a subagent delegation', async () => {
        const rows = await importSkillRows('claude', [
            {
                type: 'assistant',
                sessionId: 's1',
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'task1',
                            name: 'Task',
                            input: { subagent_type: 'sp-super-coder', prompt: 'do' },
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            skill_name: 'sp:super-coder',
            capability_kind: 'subagent',
            evidence_kind: 'delegation',
            status: 'unknown',
            call_id: 'task1',
        });
    });

    test('claude: Read on SKILL.md is an implicit load; Bash cat literal targets a SKILL.md path', async () => {
        const rows = await importSkillRows('claude', [
            {
                type: 'assistant',
                sessionId: 's1',
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'r1',
                            name: 'Read',
                            input: { file_path: '/skills/sp-dev-run/SKILL.md' },
                        },
                        {
                            type: 'tool_use',
                            id: 'b1',
                            name: 'Bash',
                            input: {
                                command:
                                    "cat /skills/sp-dev-verify/SKILL.md && sed -n '1,10p' /skills/sp-dev-run/SKILL.md",
                            },
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({
            skill_name: 'sp:dev-run',
            skill_path: '/skills/sp-dev-run/SKILL.md',
            evidence_kind: 'load',
            call_id: 'r1',
        });
        expect(rows[1]).toMatchObject({ skill_name: 'sp:dev-verify', call_id: 'b1' });
        expect(rows[2]).toMatchObject({ skill_name: 'sp:dev-run', call_id: 'b1' });
    });

    test('negatives: expansions, redirections, comments and quoted code extract nothing', async () => {
        const rows = await importSkillRows('claude', [
            {
                type: 'assistant',
                sessionId: 's1',
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'b1',
                            name: 'Bash',
                            input: { command: 'cat $(find / -name SKILL.md)' },
                        },
                        {
                            type: 'tool_use',
                            id: 'b2',
                            name: 'Bash',
                            input: { command: 'cat /skills/sp-dev-run/SKILL.md > /tmp/copy.md' },
                        },
                        {
                            type: 'tool_use',
                            id: 'b3',
                            name: 'Bash',
                            input: { command: 'echo "cat /skills/sp-dev-run/SKILL.md"' },
                        },
                        {
                            type: 'tool_use',
                            id: 'r1',
                            name: 'Read',
                            input: { file_path: '/skills/sp/dev-run/README.md' },
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(0);
    });

    test('codex: nested tools.exec_command literal is an implicit load; commented one is not', async () => {
        const rows = await importSkillRows('codex', [
            {
                type: 'response_item',
                timestamp: '2026-05-30T00:00:00.000Z',
                payload: {
                    type: 'custom_tool_call',
                    name: 'functions.exec',
                    call_id: 'fc1',
                    input: `tools.exec_command({cmd: 'cat /skills/sp-dev-run/SKILL.md', timeout_ms: 3000});\n// tools.exec_command({cmd: 'cat /skills/sp-hidden/SKILL.md'})`,
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            skill_name: 'sp:dev-run',
            skill_path: '/skills/sp-dev-run/SKILL.md',
            call_id: 'fc1',
            evidence_kind: 'load',
        });
    });

    test('codex: shell argv (serialized JSON arguments) literal read is detected', async () => {
        const rows = await importSkillRows('codex', [
            {
                type: 'response_item',
                timestamp: '2026-05-30T00:00:00.000Z',
                payload: {
                    type: 'function_call',
                    name: 'shell',
                    call_id: 'fc2',
                    arguments: JSON.stringify({ command: ['cat', '/skills/sp-dev-run/SKILL.md'] }),
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ skill_name: 'sp:dev-run', call_id: 'fc2' });
    });

    test('agy: native slash_command record is a command request; INVOKE_SUBAGENT is a delegation', async () => {
        const rows = await importSkillRows('agy', [
            {
                type: 'slash_command',
                display: '/sp-dev-run 0736 --auto',
                created_at: '2026-08-07T00:00:00.000Z',
                conversation_id: 'agy-1',
            },
            {
                type: 'PLANNER_RESPONSE',
                conversation_id: 'agy-1',
                content: 'dispatch',
                tool_calls: [{ name: 'INVOKE_SUBAGENT', args: { subagent: 'reviewer', goal: 'review' } }],
            },
        ]);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            skill_name: 'sp:dev-run',
            capability_kind: 'command',
            evidence_kind: 'request',
            invocation_kind: 'user',
        });
        expect(rows[1]).toMatchObject({
            skill_name: 'reviewer',
            capability_kind: 'subagent',
            evidence_kind: 'delegation',
            invocation_kind: 'model',
        });
    });

    test('grok: observed outcome rides the row (ok/error); unpaired attempts stay unknown', async () => {
        const rows = await importSkillRows('grok', [
            {
                method: 'session/update',
                params: {
                    sessionId: 'grok-1',
                    update: {
                        sessionUpdate: 'tool_call',
                        title: 'read',
                        rawInput: { target_file: '/tmp/x/SKILL.md' },
                        _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', namespace: 'grok_build' } },
                    },
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ skill_name: 'x', evidence_kind: 'load', status: 'unknown' });
    });
});

describe('E93 result pairing (AC4/R2)', () => {
    test('same-event result upgrades a paired Skill load; idempotent re-import writes the same', async () => {
        const file = join(directory, 'claude-pairing.jsonl');
        await writeFile(
            file,
            `${[
                JSON.stringify({
                    type: 'assistant',
                    sessionId: 's-pair',
                    ts: '2026-05-30T00:00:00.000Z',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'tool_use', id: 'sk-pair', name: 'Skill', input: { skill: 'sp:dev-run' } }],
                    },
                }),
                JSON.stringify({
                    type: 'user',
                    sessionId: 's-pair',
                    timestamp: '2026-05-30T00:00:01.000Z',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'sk-pair', content: 'loaded' }],
                    },
                }),
            ].join('\n')}\n`,
        );
        const discovered = await realpath(file);
        await runJsonlImport('claude', { db, files: [discovered], mode: 'full', now: fixedNow });
        const row = await db.queryFirst<Record<string, unknown>>('SELECT * FROM history_skill_call');
        expect(row).toMatchObject({ call_id: 'sk-pair', status: 'ok', completed_at: '2026-05-30T00:00:01.000Z' });
        const hashBefore = row?.record_hash;

        await runJsonlImport('claude', { db, files: [discovered], mode: 'incremental', now: fixedNow });
        const after = await db.queryFirst<Record<string, unknown>>('SELECT * FROM history_skill_call');
        expect(after?.record_hash).toBe(hashBefore);
        expect(after).toMatchObject({ status: 'ok', completed_at: '2026-05-30T00:00:01.000Z' });
        expect(after?.imported_at).toBe(row?.imported_at); // the skill row itself was NOT re-inserted
    });

    test('later-incremental result arrival upgrades a row imported by an earlier run (DB fallback)', async () => {
        const file = join(directory, 'claude-late.jsonl');
        const callLine = JSON.stringify({
            type: 'assistant',
            sessionId: 's-late',
            ts: '2026-05-30T00:00:00.000Z',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'sk-late', name: 'Skill', input: { skill: 'sp:dev-run' } }],
            },
        });
        await writeFile(file, `${callLine}\n`);
        const discovered = await realpath(file);
        await runJsonlImport('claude', { db, files: [discovered], mode: 'full', now: fixedNow });
        expect((await db.queryFirst<Record<string, unknown>>('SELECT status FROM history_skill_call'))?.status).toBe(
            'unknown',
        );

        // Result arrives later: append-only arrival, incremental resume.
        await writeFile(
            file,
            `${callLine}\n${JSON.stringify({
                type: 'user',
                sessionId: 's-late',
                timestamp: '2026-05-30T00:00:02.000Z',
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'sk-late', is_error: true, content: 'boom' }],
                },
            })}\n`,
        );
        await runJsonlImport('claude', { db, files: [discovered], mode: 'incremental', now: fixedNow });
        expect(
            await db.queryFirst<Record<string, unknown>>('SELECT status, completed_at FROM history_skill_call'),
        ).toMatchObject({
            status: 'error',
            completed_at: '2026-05-30T00:00:02.000Z',
        });
    });
});

// ---------------------------------------------------------------------------
// R6/AC6 quoted-signature exclusion (task 1028 test-fix) — quoted COMPLETE
// wrappers/envelopes must not fabricate invocations, and codex wrapper
// identity/error pairing disambiguation.
// ---------------------------------------------------------------------------

describe('quoted-signature exclusion (R6/AC6, 1028 test-fix)', () => {
    test('claude: fenced complete command envelope extracts nothing; the real envelope still does', async () => {
        const quoted = await importSkillRows('claude', [
            {
                type: 'user',
                sessionId: 's1',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Example session:\n```\n<command-name>/sp:dev-run</command-name>\n<command-args>--auto</command-args>\n```',
                        },
                    ],
                },
            },
        ]);
        expect(quoted).toHaveLength(0);
        const real = await importSkillRows('claude', [
            {
                type: 'user',
                sessionId: 's1',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<command-name>/sp:dev-run</command-name>\n<command-args>--auto</command-args>',
                        },
                    ],
                },
            },
        ]);
        expect(real).toHaveLength(1);
        expect(real[0]).toMatchObject({ capability_kind: 'command', evidence_kind: 'request', status: 'unknown' });
    });

    test('pi: fenced complete skill wrapper extracts nothing; real injection still loads', async () => {
        const quoted = await importSkillRows('pi', [
            {
                type: 'message',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'The wrapper looks like:\n```\n<skill name="sp-dev-run" location="/skills/sp-dev-run/SKILL.md">\n# Dev Run\n</skill>\n```',
                        },
                    ],
                },
            },
        ]);
        expect(quoted).toHaveLength(0);
        const real = await importSkillRows('pi', [
            {
                type: 'message',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<skill name="sp-dev-run" location="/skills/sp-dev-run/SKILL.md">\n# Dev Run\n</skill>',
                        },
                    ],
                },
            },
        ]);
        expect(real).toHaveLength(1);
        expect(real[0]).toMatchObject({
            evidence_kind: 'load',
            status: 'ok',
            skill_path: '/skills/sp-dev-run/SKILL.md',
        });
    });

    test('omp: wrapper quoted inside a template literal extracts nothing; real injection still loads', async () => {
        const quoted = await importSkillRows('omp', [
            {
                type: 'message',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'const demo = `<skill name="sp-dev-run" location="/skills/sp-dev-run/SKILL.md">body</skill>`;',
                        },
                    ],
                },
            },
        ]);
        expect(quoted).toHaveLength(0);
        const real = await importSkillRows('omp', [
            {
                type: 'message',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<skill name="sp-dev-run" location="/skills/sp-dev-run/SKILL.md">body</skill>',
                        },
                    ],
                },
            },
        ]);
        expect(real).toHaveLength(1);
        expect(real[0]).toMatchObject({ evidence_kind: 'load', status: 'ok' });
    });

    test('codex: fenced complete <skill> block extracts nothing; marker + fenced wrapper yields only the request', async () => {
        const quoted = await importSkillRows('codex', [
            {
                type: 'response_item',
                timestamp: '2026-05-30T00:00:00.000Z',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '```\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n# Dev Run\n</skill>\n```',
                        },
                    ],
                },
            },
        ]);
        expect(quoted).toHaveLength(0);
        // A real leading marker with only a quoted wrapper keeps its request evidence;
        // the quoted block never becomes a load row.
        const mixed = await importSkillRows('codex', [
            {
                type: 'response_item',
                timestamp: '2026-05-30T00:00:00.000Z',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '$sp-dev-run 0736\n```\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n# Dev Run\n</skill>\n```',
                        },
                    ],
                },
            },
        ]);
        expect(mixed).toHaveLength(1);
        expect(mixed[0]).toMatchObject({ evidence_kind: 'request', status: 'unknown' });
    });

    test('codex: real marker + unwrapped block stay correlated (no over-exclusion)', async () => {
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
                            text: '$sp-dev-run 0736\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n# Dev Run\n</skill>',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.invocation_id)).size).toBe(1);
    });

    test('codex: two same-name wrappers in one record get distinct invocation ids (P4 #9)', async () => {
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
                            text: '<skill>\n<name>sp-dev-run</name>\n<path>/a/SKILL.md</path>\nbody-one</skill>\n<skill>\n<name>sp-dev-run</name>\n<path>/a/SKILL.md</path>\nbody-two</skill>',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.invocation_id)).size).toBe(2);
    });

    test('codex: failing function_call_output (non-zero exit_code) pairs status error, not ok (P4 #6)', async () => {
        const file = join(directory, 'codex-error-output.jsonl');
        await writeFile(
            file,
            `${[
                JSON.stringify({
                    type: 'response_item',
                    timestamp: '2026-05-30T00:00:00.000Z',
                    payload: {
                        type: 'function_call',
                        name: 'shell',
                        call_id: 'fc-err',
                        arguments: JSON.stringify({ command: ['cat', '/skills/sp-dev-run/SKILL.md'] }),
                    },
                }),
                JSON.stringify({
                    type: 'response_item',
                    timestamp: '2026-05-30T00:00:01.000Z',
                    payload: {
                        type: 'function_call_output',
                        call_id: 'fc-err',
                        output: JSON.stringify({
                            output: 'cat: no such file or directory',
                            metadata: { exit_code: 1 },
                        }),
                    },
                }),
            ].join('\n')}\n`,
        );
        const discovered = await realpath(file);
        await runJsonlImport('codex', { db, files: [discovered], mode: 'full', now: fixedNow });
        expect(
            await db.queryFirst<Record<string, unknown>>('SELECT status, completed_at FROM history_skill_call'),
        ).toMatchObject({
            status: 'error',
            completed_at: '2026-05-30T00:00:01.000Z',
        });
    });

    // Hop-2 residual channels (fresh-verifier V1/V3/V7) and their controls
    // (V2/V8/V9/V10): the codex seam anchors complete wrapper blocks at the
    // lead position (text start, or directly below a single marker line, or
    // contiguous with an accepted block), and fence exclusion matches fence
    // length, so a 4-backtick outer fence is not closed by an inner ``` fence.

    test('codex: prose-introduced unfenced block (V1) extracts nothing', async () => {
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
                            text: 'Here is the skill format:\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n# Dev Run\n</skill>',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(0);
    });

    test('codex: template-literal line-start block (V3) extracts nothing', async () => {
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
                            text: 'const t = `\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n# Dev Run\n</skill>\n`;',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(0);
    });

    test('codex: 4-backtick outer fence around a ``` example (V7) extracts nothing', async () => {
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
                            text: '````\n```\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n# Dev Run\n</skill>\n```\n````',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(0);
    });

    test('codex: wrapper below a closed fence + marker still extracts (V2 control)', async () => {
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
                            text: '```\ncode sample\n```\n$sp-dev-run 0736\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n# Dev Run\n</skill>',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ evidence_kind: 'load', status: 'ok' });
    });

    test('codex: ~~~ fenced block extracts nothing (V8 control)', async () => {
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
                            text: '~~~\n<skill>\n<name>sp-dev-run</name>\n<path>/skills/sp-dev-run/SKILL.md</path>\n# Dev Run\n</skill>\n~~~',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(0);
    });

    test('codex: marker-only text still yields the request row (V9 control)', async () => {
        const rows = await importSkillRows('codex', [
            {
                type: 'response_item',
                timestamp: '2026-05-30T00:00:00.000Z',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'text', text: '$sp-dev-run 0736' }],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ evidence_kind: 'request', status: 'unknown' });
    });

    test('claude: envelope after blank lines still extracts (V10 control)', async () => {
        const rows = await importSkillRows('claude', [
            {
                type: 'user',
                sessionId: 's1',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '\n\n<command-name>/sp:dev-run</command-name>\n<command-args>--auto</command-args>',
                        },
                    ],
                },
            },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ capability_kind: 'command', evidence_kind: 'request', status: 'unknown' });
    });
});
