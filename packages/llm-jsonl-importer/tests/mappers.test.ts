import { describe, expect, test } from 'bun:test';
import {
    AGY_FIELD_MAP,
    AGY_SCHEMA,
    agySplit,
    CLAUDE_FIELD_MAP,
    CLAUDE_SCHEMA,
    CODEX_FIELD_MAP,
    CODEX_SCHEMA,
    claudeSplit,
    codexSplit,
    GEMINI_FIELD_MAP,
    GEMINI_SCHEMA,
    GROK_FIELD_MAP,
    GROK_SCHEMA,
    geminiSplit,
    grokSplit,
    OMP_FIELD_MAP,
    OMP_SCHEMA,
    ompSplit,
    PI_FIELD_MAP,
    PI_SCHEMA,
    piSplit,
    stableFieldShape,
} from '../src/mappers';

// ---------------------------------------------------------------------------
// Shared utilities (exercised through split functions)
// ---------------------------------------------------------------------------

describe('stableFieldShape', () => {
    test('is order-independent', () => {
        expect(stableFieldShape({ b: 1, a: 2 })).toBe(stableFieldShape({ a: 2, b: 1 }));
    });

    test('lowercases keys', () => {
        expect(stableFieldShape({ Foo: 1, bar: 2 })).toBe('bar+foo');
    });

    test('joins with +', () => {
        expect(stableFieldShape({ z: 1, a: 2, m: 3 })).toBe('a+m+z');
    });
});

// ---------------------------------------------------------------------------
// claudeSplit
// ---------------------------------------------------------------------------

describe('claudeSplit', () => {
    test('emits a message entry for a basic user message', () => {
        const entries = claudeSplit({
            sessionId: 'sess-1',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hello',
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.targetTable).toBe('history_message');
        expect(entries[0]?.record.session_id).toBe('sess-1');
        expect(entries[0]?.record.role).toBe('user');
        expect(entries[0]?.record.record_type).toBe('user');
        expect(entries[0]?.record.disposition).toBe('keep');
        expect(entries[0]?.record.content_text).toBe('hello');
    });

    test('emits message + tool_call entries for assistant with tool_use blocks', () => {
        const entries = claudeSplit({
            sessionId: 'sess-1',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: [
                { type: 'text', text: 'running bash' },
                { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
                { type: 'tool_use', name: 'Read', input: { path: '/tmp/x' } },
            ],
        });
        expect(entries).toHaveLength(3);
        expect(entries[0]?.targetTable).toBe('history_message');
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[2]?.targetTable).toBe('history_tool_call');
        // Tool entries reference the message index
        expect(entries[1]?.record._messageSplitIndex).toBe(0);
        expect(entries[2]?.record._messageSplitIndex).toBe(0);
        // args_digest is sha256 hex, not raw args
        expect(entries[1]?.record.args_digest).toMatch(/^[a-f0-9]{64}$/);
        expect(entries[1]?.record.args_digest).not.toContain('ls -la');
        expect(entries[2]?.record.tool_name).toBe('Read');
    });

    test('does not emit tool calls for user messages', () => {
        const entries = claudeSplit({
            sessionId: 'sess-1',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: [{ type: 'tool_use', name: 'Bash', input: {} }],
        });
        // tool_use in user message should be ignored
        expect(entries).toHaveLength(1);
        expect(entries[0]?.targetTable).toBe('history_message');
    });

    test('handles turn_duration subtype', () => {
        const entries = claudeSplit({
            sessionId: 'sess-1',
            type: 'assistant',
            subtype: 'turn_duration',
            timestamp: '2026-08-07T00:00:00.000Z',
            durationMs: 1234,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.record.role).toBe('system');
        expect(entries[0]?.record.record_type).toBe('turn_duration');
        expect(entries[0]?.record.disposition).toBe('meta');
        expect(entries[0]?.record.duration_ms).toBe(1234);
    });

    test('handles attachment type', () => {
        const entries = claudeSplit({
            sessionId: 'sess-1',
            type: 'attachment',
            timestamp: '2026-08-07T00:00:00.000Z',
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.record.role).toBe('meta');
        expect(entries[0]?.record.record_type).toBe('attachment');
        expect(entries[0]?.record.disposition).toBe('meta');
    });

    test('handles file-history type', () => {
        const entries = claudeSplit({
            sessionId: 'sess-1',
            type: 'file-history-some-file',
            timestamp: '2026-08-07T00:00:00.000Z',
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.record.role).toBe('meta');
        expect(entries[0]?.record.disposition).toBe('meta');
    });

    test('maps conversation_uuid as fallback session id', () => {
        const entries = claudeSplit({
            conversation_uuid: 'conv-abc',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hi',
        });
        expect(entries[0]?.record.session_id).toBe('conv-abc');
    });

    test('falls back to unknown session id', () => {
        const entries = claudeSplit({
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hi',
        });
        expect(entries[0]?.record.session_id).toBe('unknown');
    });

    test('uses messageIndex as seq fallback', () => {
        const entries = claudeSplit({
            sessionId: 's',
            type: 'user',
            messageIndex: 5,
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hi',
        });
        expect(entries[0]?.record.seq).toBe(5);
    });

    test('extracts usage from raw fields and nested usage object', () => {
        const entries = claudeSplit({
            sessionId: 's',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            inputTokens: 100,
            outputTokens: 50,
            usage: { cacheReadTokens: 10, cache_write_tokens: 5 },
            model: 'claude-3-5-sonnet',
        });
        expect(entries[0]?.record.input_tokens).toBe(100);
        expect(entries[0]?.record.output_tokens).toBe(50);
        expect(entries[0]?.record.cache_read_tokens).toBe(10);
        expect(entries[0]?.record.cache_write_tokens).toBe(5);
        // computeCost: (100*3 + 50*15) / 1_000_000 = 0.00105
        expect(entries[0]?.record.cost_usd).toBeCloseTo(0.00105, 8);
    });

    test('detects spur provenance from cwd', () => {
        const entries = claudeSplit({
            sessionId: 's',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            cwd: '/home/user/projects/spur-work',
            content: 'hi',
        });
        expect(entries[0]?.record.provenance).toBe('spur-run');
    });

    test('ambient provenance when cwd is absent', () => {
        const entries = claudeSplit({
            sessionId: 's',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hi',
        });
        expect(entries[0]?.record.provenance).toBe('ambient');
    });

    test('args_digest handles numeric values in tool arguments', () => {
        const entries = claudeSplit({
            sessionId: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: [{ type: 'tool_use', name: 'Edit', input: { line: 42, count: 100 } }],
        });
        const tool = entries.find((e) => e.targetTable === 'history_tool_call');
        expect(tool?.record.args_digest).toMatch(/^[a-f0-9]{64}$/);
    });

    test('joins multiple text content blocks with newlines', () => {
        const entries = claudeSplit({
            sessionId: 's',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: [
                { type: 'text', text: 'first part' },
                { type: 'text', text: 'second part' },
            ],
        });
        expect(entries[0]?.record.content_text).toBe('first part\nsecond part');
    });

    test('no content_text when content is not text blocks', () => {
        const entries = claudeSplit({
            sessionId: 's',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: [{ type: 'tool_use', name: 'Bash', input: {} }],
        });
        expect(entries[0]?.record.content_text).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// piSplit
// ---------------------------------------------------------------------------

describe('piSplit', () => {
    test('emits a message entry for a basic record', () => {
        const entries = piSplit({
            id: 'sess-1',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hello',
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.targetTable).toBe('history_message');
        expect(entries[0]?.record.session_id).toBe('sess-1');
        expect(entries[0]?.record.role).toBe('user');
        expect(entries[0]?.record.content_text).toBe('hello');
    });

    test('maps cost.total to cost_usd', () => {
        const entries = piSplit({
            id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hi',
            message: { usage: { input: 10, output: 5 }, cost: { total: 0.0123 } },
        });
        expect(entries[0]?.record.cost_usd).toBe(0.0123);
        expect(entries[0]?.record.input_tokens).toBe(10);
        expect(entries[0]?.record.output_tokens).toBe(5);
    });

    test('extracts usage from message.usage for non-Claude models', () => {
        const entries = piSplit({
            id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hi',
            message: { usage: { input: 20, output: 10 } },
        });
        // computeCost with non-Claude rates: (20*1 + 10*5) / 1_000_000
        expect(entries[0]?.record.cost_usd).toBeCloseTo(0.00007, 8);
    });

    test('accepts bare record (not wrapped in message)', () => {
        const entries = piSplit({
            id: 'sess',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            text: 'direct text',
        });
        expect(entries[0]?.record.content_text).toBe('direct text');
    });

    test('emits tool calls from content blocks with toolCall', () => {
        const entries = piSplit({
            id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: [{ text: 'running' }, { toolCall: { name: 'run_command', input: { cmd: 'ls' } } }],
        });
        expect(entries).toHaveLength(2);
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[1]?.record.tool_name).toBe('run_command');
        expect(entries[1]?.record.args_digest).toMatch(/^[a-f0-9]{64}$/);
    });

    test('does not emit tool calls for user messages', () => {
        const entries = piSplit({
            id: 'sess',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: [{ toolCall: { name: 'run', arguments: {} } }],
        });
        expect(entries).toHaveLength(1);
    });

    test('falls back to unknown session id', () => {
        const entries = piSplit({
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hi',
        });
        expect(entries[0]?.record.session_id).toBe('unknown');
    });

    test('handles unknown type', () => {
        const entries = piSplit({
            id: 'sess',
            type: 'weird_type',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'hi',
        });
        expect(entries[0]?.record.role).toBe('weird_type');
    });
});

// ---------------------------------------------------------------------------
// ompSplit
// ---------------------------------------------------------------------------

describe('ompSplit', () => {
    test('emits a message entry for a basic record', () => {
        const entries = ompSplit({
            id: 'sess-1',
            type: 'user',
            ts: '2026-08-07T00:00:00.000Z',
            content: 'hello',
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.targetTable).toBe('history_message');
        expect(entries[0]?.record.session_id).toBe('sess-1');
        expect(entries[0]?.record.role).toBe('user');
        expect(entries[0]?.record.content_text).toBe('hello');
    });

    test('skips metadata event types as meta disposition', () => {
        for (const metaType of [
            'title',
            'title_change',
            'service_tier_change',
            'ttsr_injection',
            'session_init',
            'compaction',
        ]) {
            const entries = ompSplit({
                id: 'sess-1',
                type: metaType,
                ts: '2026-08-07T00:00:00.000Z',
            });
            expect(entries).toHaveLength(1);
            expect(entries[0]?.record.role).toBe('meta');
            expect(entries[0]?.record.record_type).toBe(metaType);
            expect(entries[0]?.record.disposition).toBe('meta');
            expect(entries[0]?.record.provenance).toBe('ambient');
        }
    });

    test('extracts usage from message.usage', () => {
        const entries = ompSplit({
            id: 'sess',
            type: 'assistant',
            ts: '2026-08-07T00:00:00.000Z',
            content: 'hi',
            message: { usage: { input: 30, output: 15, cacheRead: 5, cacheWrite: 3 } },
        });
        expect(entries[0]?.record.input_tokens).toBe(30);
        expect(entries[0]?.record.output_tokens).toBe(15);
        expect(entries[0]?.record.cache_read_tokens).toBe(5);
        expect(entries[0]?.record.cache_write_tokens).toBe(3);
    });

    test('emits tool calls from content blocks with toolCall', () => {
        const entries = ompSplit({
            id: 'sess',
            type: 'assistant',
            ts: '2026-08-07T00:00:00.000Z',
            content: [{ text: 'working' }, { toolCall: { name: 'Bash', input: { cmd: 'ls' } } }],
        });
        expect(entries).toHaveLength(2);
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[1]?.record.tool_name).toBe('Bash');
    });

    test('does not emit tool calls for user messages', () => {
        const entries = ompSplit({
            id: 'sess',
            type: 'user',
            ts: '2026-08-07T00:00:00.000Z',
            content: [{ toolCall: { name: 'Bash', arguments: {} } }],
        });
        expect(entries).toHaveLength(1);
    });

    test('uses raw.cost.total when message.cost is absent', () => {
        const entries = ompSplit({
            id: 'sess',
            type: 'assistant',
            ts: '2026-08-07T00:00:00.000Z',
            content: 'hi',
            cost: { total: 0.005 },
        });
        expect(entries[0]?.record.cost_usd).toBe(0.005);
    });
});

// ---------------------------------------------------------------------------
// codexSplit
// ---------------------------------------------------------------------------

describe('codexSplit', () => {
    test('emits a message entry for a basic record', () => {
        const entries = codexSplit({
            session_id: 'sess-1',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            payload: { content: 'hello' },
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.targetTable).toBe('history_message');
        expect(entries[0]?.record.session_id).toBe('sess-1');
        expect(entries[0]?.record.role).toBe('user');
        expect(entries[0]?.record.content_text).toBe('hello');
    });

    test('handles short format (no type, with instructions)', () => {
        const entries = codexSplit({
            id: 'sess',
            timestamp: '2026-08-07T00:00:00.000Z',
            instructions: 'do something',
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.record.role).toBe('meta');
        expect(entries[0]?.record.record_type).toBe('short_format');
        expect(entries[0]?.record.disposition).toBe('meta');
    });

    test('extracts token counts from payload.token_count', () => {
        const entries = codexSplit({
            session_id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            payload: { token_count: { input: 100, output: 50 } },
            model: 'gpt-4',
        });
        expect(entries[0]?.record.input_tokens).toBe(100);
        expect(entries[0]?.record.output_tokens).toBe(50);
        // computeCost with non-Claude rates: (100*1 + 50*5) / 1_000_000
        expect(entries[0]?.record.cost_usd).toBeCloseTo(0.00035, 8);
    });

    test('falls back to turn_context.payload for token counts', () => {
        const entries = codexSplit({
            session_id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            payload: { content: 'hi' },
            turn_context: { payload: { input_tokens: 200, output_tokens: 100 } },
            model: 'gpt-4',
        });
        expect(entries[0]?.record.input_tokens).toBe(200);
        expect(entries[0]?.record.output_tokens).toBe(100);
    });

    test('extracts model from raw or payload or turn_context', () => {
        const entries = codexSplit({
            session_id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            payload: { content: 'hi' },
            turn_context: { payload: { model: 'claude-4' } },
        });
        expect(entries[0]?.record.model).toBe('claude-4');
    });

    test('emits tool calls for assistant messages with response_item function_call', () => {
        const entries = codexSplit({
            session_id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            payload: {
                content: 'running',
                response_item: { function_call: { name: 'Bash', arguments: { cmd: 'ls' } } },
            },
        });
        expect(entries).toHaveLength(2);
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[1]?.record.tool_name).toBe('Bash');
        expect(entries[1]?.record.args_digest).toMatch(/^[a-f0-9]{64}$/);
    });

    test('emits tool calls from response_items array', () => {
        const entries = codexSplit({
            session_id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            payload: {
                content: 'running',
                response_items: [
                    { function_call: { name: 'Bash', arguments: { cmd: 'ls' } } },
                    { function_call: { name: 'Read', arguments: { path: 'file.ts' } } },
                ],
            },
        });
        expect(entries).toHaveLength(3);
        expect(entries[1]?.record.tool_name).toBe('Bash');
        expect(entries[2]?.record.tool_name).toBe('Read');
    });

    test('emits tool calls for any role with response_item function_call', () => {
        // Codex does not filter tool calls by role — function_call is emitted regardless.
        const entries = codexSplit({
            session_id: 'sess',
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            payload: {
                content: 'hi',
                response_item: { function_call: { name: 'Bash', arguments: {} } },
            },
        });
        expect(entries).toHaveLength(2);
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[1]?.record.tool_name).toBe('Bash');
    });

    test('falls back to raw content when payload.content is absent', () => {
        const entries = codexSplit({
            session_id: 'sess',
            type: 'assistant',
            timestamp: '2026-08-07T00:00:00.000Z',
            content: 'raw content',
            payload: {},
        });
        expect(entries[0]?.record.content_text).toBe('raw content');
    });
});

// ---------------------------------------------------------------------------
// agySplit
// ---------------------------------------------------------------------------

describe('agySplit', () => {
    test('USER_INPUT maps to user role keep', () => {
        const entries = agySplit({
            type: 'USER_INPUT',
            step_index: 1,
            created_at: '2026-08-07T00:00:00.000Z',
            content: 'user said hello',
        });
        expect(entries[0]?.record.role).toBe('user');
        expect(entries[0]?.record.disposition).toBe('keep');
        expect(entries[0]?.record.content_text).toBe('user said hello');
    });

    test('PLANNER_RESPONSE maps to assistant keep with tool_calls', () => {
        const entries = agySplit({
            type: 'PLANNER_RESPONSE',
            step_index: 3,
            created_at: '2026-08-07T00:00:00.000Z',
            content: 'plan content',
            tool_calls: [
                { name: 'run', arguments: { cmd: 'echo hi' } },
                { name: 'read', arguments: { path: 'file.ts' } },
            ],
        });
        const msg = entries.find((e) => e.targetTable === 'history_message');
        expect(msg?.record.role).toBe('assistant');
        expect(msg?.record.disposition).toBe('keep');
        expect(msg?.record.content_text).toBe('plan content');
        // All model/usage fields are null for agy
        expect(msg?.record.model).toBeNull();
        expect(msg?.record.input_tokens).toBeNull();
        expect(msg?.record.output_tokens).toBeNull();
        expect(msg?.record.cost_usd).toBeNull();
        // Tool calls
        const tools = entries.filter((e) => e.targetTable === 'history_tool_call');
        expect(tools).toHaveLength(2);
        expect(tools[0]?.record.tool_name).toBe('run');
        expect(tools[1]?.record.tool_name).toBe('read');
        expect(tools[0]?.record.args_digest).toMatch(/^[a-f0-9]{64}$/);
    });

    test('ERROR_MESSAGE maps to system keep', () => {
        const entries = agySplit({
            type: 'ERROR_MESSAGE',
            step_index: 2,
            created_at: '2026-08-07T00:00:00.000Z',
            message: 'something broke',
        });
        expect(entries[0]?.record.role).toBe('system');
        expect(entries[0]?.record.disposition).toBe('keep');
        expect(entries[0]?.record.content_text).toBe('something broke');
    });

    test('RUN_COMMAND maps to tool keep', () => {
        const entries = agySplit({
            type: 'RUN_COMMAND',
            step_index: 4,
            created_at: '2026-08-07T00:00:00.000Z',
            command: 'ls -la',
        });
        expect(entries[0]?.record.role).toBe('tool');
        expect(entries[0]?.record.disposition).toBe('keep');
        expect(entries[0]?.record.content_text).toBe('ls -la');
    });

    test('CONVERSATION_HISTORY maps to meta meta', () => {
        const entries = agySplit({
            type: 'CONVERSATION_HISTORY',
            step_index: 0,
            created_at: '2026-08-07T00:00:00.000Z',
            content: 'history',
        });
        expect(entries[0]?.record.role).toBe('meta');
        expect(entries[0]?.record.disposition).toBe('meta');
    });

    test('GENERIC maps to meta meta', () => {
        const entries = agySplit({
            type: 'GENERIC',
            step_index: 0,
            created_at: '2026-08-07T00:00:00.000Z',
            text: 'generic event',
        });
        expect(entries[0]?.record.role).toBe('meta');
        expect(entries[0]?.record.disposition).toBe('meta');
    });

    test('empty type maps to unknown unknown', () => {
        const entries = agySplit({
            type: '',
            created_at: '2026-08-07T00:00:00.000Z',
        });
        expect(entries[0]?.record.role).toBe('unknown');
        expect(entries[0]?.record.disposition).toBe('unknown');
    });

    test('unlisted but non-empty type maps to meta meta', () => {
        const entries = agySplit({
            type: 'CUSTOM_EVENT',
            created_at: '2026-08-07T00:00:00.000Z',
            content: 'custom',
        });
        expect(entries[0]?.record.role).toBe('meta');
        expect(entries[0]?.record.disposition).toBe('meta');
    });

    test('CODE_ACTION maps to tool keep', () => {
        const entries = agySplit({
            type: 'CODE_ACTION',
            step_index: 5,
            created_at: '2026-08-07T00:00:00.000Z',
            text: 'code diff',
        });
        expect(entries[0]?.record.role).toBe('tool');
        expect(entries[0]?.record.disposition).toBe('keep');
        expect(entries[0]?.record.content_text).toBe('code diff');
    });

    test('uses conversation_id as session id fallback', () => {
        const entries = agySplit({
            conversation_id: 'conv-abc',
            type: 'USER_INPUT',
            step_index: 1,
            created_at: '2026-08-07T00:00:00.000Z',
            content: 'hi',
        });
        expect(entries[0]?.record.session_id).toBe('conv-abc');
    });

    test('falls back to unknown session id', () => {
        const entries = agySplit({
            type: 'USER_INPUT',
            created_at: '2026-08-07T00:00:00.000Z',
            content: 'hi',
        });
        expect(entries[0]?.record.session_id).toBe('unknown');
    });
});

// ---------------------------------------------------------------------------
// geminiSplit
// ---------------------------------------------------------------------------

describe('geminiSplit', () => {
    const context = {
        source: 'gemini',
        sourceFile: '/home/user/.gemini/tmp/project/chats/session-abc.jsonl',
        sourceLine: 7,
        splitIndex: 0,
    };

    test('maps user content blocks into a session-scoped message', () => {
        const entries = geminiSplit(
            {
                id: 'message-1',
                type: 'user',
                timestamp: '2026-08-07T00:00:00.000Z',
                content: [{ type: 'text', text: 'hello' }],
            },
            context,
        );
        expect(entries[0]?.record.session_id).toBe('session-abc');
        expect(entries[0]?.record.seq).toBe(7);
        expect(entries[0]?.record.role).toBe('user');
        expect(entries[0]?.record.content_text).toBe('hello');
    });

    test('maps assistant usage, thoughts, and tool calls', () => {
        const entries = geminiSplit(
            {
                id: 'message-2',
                type: 'gemini',
                timestamp: '2026-08-07T00:00:01.000Z',
                model: 'gemini-3-flash-preview',
                content: 'Done.',
                thoughts: [{ subject: 'Plan', description: 'Inspect the source.' }],
                tokens: { input: 10, output: 4, cached: 2 },
                toolCalls: [
                    {
                        name: 'read_file',
                        args: { path: '/tmp/a' },
                        status: 'success',
                        timestamp: '2026-08-07T00:00:01.000Z',
                        result: 'contents',
                    },
                ],
            },
            context,
        );
        expect(entries).toHaveLength(2);
        expect(entries[0]?.record.role).toBe('assistant');
        expect(entries[0]?.record.model).toBe('gemini-3-flash-preview');
        expect(entries[0]?.record.input_tokens).toBe(10);
        expect(entries[0]?.record.cache_read_tokens).toBe(2);
        expect(entries[0]?.record.content_text).toBe('Done.\nInspect the source.');
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[1]?.record.tool_name).toBe('read_file');
        expect(entries[1]?.record.args_digest).toMatch(/^[a-f0-9]{64}$/);
        expect(entries[1]?.record.status).toBe('success');
    });

    test('maps session and state records as metadata', () => {
        const session = geminiSplit({ kind: 'main', sessionId: 'source-session', startTime: '2026-08-07' }, context);
        expect(session[0]?.record.record_type).toBe('session');
        expect(session[0]?.record.disposition).toBe('meta');

        const state = geminiSplit({ $set: { lastUpdated: '2026-08-08', summary: 'summary' } }, context);
        expect(state[0]?.record.record_type).toBe('state');
        expect(state[0]?.record.content_text).toBe('summary');
    });
});

// ---------------------------------------------------------------------------
// grokSplit
// ---------------------------------------------------------------------------

describe('grokSplit', () => {
    test('turn_completed maps to assistant', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'turn_completed',
            seq: 1,
            session_id: 'sess-1',
            usage: {
                inputTokens: 50,
                outputTokens: 25,
                cachedReadTokens: 5,
            },
            _meta: { modelId: 'grok-3' },
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.record.role).toBe('assistant');
        expect(entries[0]?.record.disposition).toBe('keep');
        expect(entries[0]?.record.record_type).toBe('turn_completed');
        expect(entries[0]?.record.input_tokens).toBe(50);
        expect(entries[0]?.record.output_tokens).toBe(25);
        expect(entries[0]?.record.cache_read_tokens).toBe(5);
        expect(entries[0]?.record.model).toBe('grok-3');
    });

    test('turn_completed with usage.modelUsage extracts model from key', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'turn_completed',
            session_id: 'sess-1',
            usage: {
                modelUsage: { 'grok-3-latest': { inputTokens: 10, outputTokens: 5 } },
            },
        });
        expect(entries[0]?.record.model).toBe('grok-3-latest');
        // inputTokens is nested inside modelUsage, not at top-level usage
        expect(entries[0]?.record.input_tokens).toBeNull();
    });

    test('tool_started emits message + tool_call', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'tool_started',
            session_id: 'sess-1',
            seq: 2,
            title: 'read_file',
            rawInput: { path: '/tmp/x' },
        });
        expect(entries).toHaveLength(2);
        expect(entries[0]?.targetTable).toBe('history_message');
        expect(entries[0]?.record.role).toBe('assistant');
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[1]?.record.tool_name).toBe('read_file');
        expect(entries[1]?.record.args_digest).toMatch(/^[a-f0-9]{64}$/);
        expect(entries[1]?.record.started_at).toBe('2026-08-07T00:00:00.000Z');
    });

    test('tool_completed emits a parent message and linked tool call', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'tool_completed',
            session_id: 'sess-1',
            seq: 2,
            title: 'read_file',
            duration_ms: 1500,
        });
        expect(entries).toHaveLength(2);
        expect(entries[0]?.targetTable).toBe('history_message');
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[1]?.record.tool_name).toBe('read_file');
        expect(entries[1]?.record.completed_at).toBe('2026-08-07T00:00:00.000Z');
        expect(entries[1]?.record.duration_ms).toBe(1500);
    });

    test('tool_call emits message + tool_call with started_at', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'tool_call',
            session_id: 'sess-1',
            seq: 3,
            title: 'Bash',
            rawInput: { cmd: 'ls' },
        });
        expect(entries).toHaveLength(2);
        expect(entries[0]?.targetTable).toBe('history_message');
        expect(entries[1]?.targetTable).toBe('history_tool_call');
        expect(entries[1]?.record.tool_name).toBe('Bash');
        expect(entries[1]?.record.started_at).toBe('2026-08-07T00:00:00.000Z');
        expect(entries[1]?.record.completed_at).toBeUndefined();
    });

    test('tool_call_update emits message + tool_call with completed_at', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'tool_call_update',
            session_id: 'sess-1',
            seq: 3,
            title: 'Bash',
            rawInput: { cmd: 'ls' },
        });
        expect(entries[1]?.record.completed_at).toBe('2026-08-07T00:00:00.000Z');
        expect(entries[1]?.record.started_at).toBeUndefined();
    });

    test('user record maps to user role', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'user',
            session_id: 'sess-1',
            seq: 1,
            content: 'hello',
        });
        expect(entries[0]?.record.role).toBe('user');
        expect(entries[0]?.record.disposition).toBe('keep');
        expect(entries[0]?.record.content_text).toBe('hello');
    });

    test('user_message record maps to user role', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'user_message',
            session_id: 'sess-1',
            seq: 1,
            content: 'hello',
        });
        expect(entries[0]?.record.role).toBe('user');
    });

    test('user_message_chunk record maps to user role', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'user_message_chunk',
            session_id: 'sess-1',
            seq: 1,
            content: 'hello',
        });
        expect(entries[0]?.record.role).toBe('user');
    });

    test('message record maps to user role', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'message',
            session_id: 'sess-1',
            seq: 1,
            content: 'hello',
        });
        expect(entries[0]?.record.role).toBe('user');
    });

    test('assistant record maps to assistant role', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'assistant',
            session_id: 'sess-1',
            seq: 1,
            content: 'response',
        });
        expect(entries[0]?.record.role).toBe('assistant');
        expect(entries[0]?.record.disposition).toBe('keep');
    });

    test('agent_message_chunk record maps to assistant role', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'agent_message_chunk',
            session_id: 'sess-1',
            seq: 1,
            content: 'chunk',
        });
        expect(entries[0]?.record.role).toBe('assistant');
    });

    test('meta types (phase_changed, reasoning, system, etc.) map to meta disposition', () => {
        const metaTypes = [
            'phase_changed',
            'reasoning',
            'system',
            'turn_started',
            'turn_ended',
            'hook_execution',
            'plan',
            'session_recap',
            'loop_started',
            'mcp_server_starting',
        ];
        for (const metaType of metaTypes) {
            const entries = grokSplit({
                ts: '2026-08-07T00:00:00.000Z',
                type: metaType,
                session_id: 'sess-1',
                seq: 1,
            });
            expect(entries[0]?.record.role).toBe('meta');
            expect(entries[0]?.record.disposition).toBe('meta');
            expect(entries[0]?.record.record_type).toBe(metaType);
        }
    });

    test('unknown record (no type discriminator) is captured with stable field shape', () => {
        const entries = grokSplit({
            timestamp: 1784274007,
            foo: 'bar',
            baz: 1,
        });
        expect(entries[0]?.record.role).toBe('unknown');
        expect(entries[0]?.record.disposition).toBe('unknown');
        // stableFieldShape of { timestamp, foo, baz } → 'baz+foo+timestamp'
        expect(entries[0]?.record.record_type).toBe('baz+foo+timestamp');
    });

    test('determined but unlisted type maps to meta meta', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'some_new_event_type',
            session_id: 'sess-1',
            seq: 1,
        });
        expect(entries[0]?.record.role).toBe('meta');
        expect(entries[0]?.record.disposition).toBe('meta');
        expect(entries[0]?.record.record_type).toBe('some_new_event_type');
    });

    test('classifies observed eventType records as metadata', () => {
        const entries = grokSplit({
            eventType: 'file-change',
            parentSessionId: 'sess-1',
            timestamp: 1784274007,
        });
        expect(entries[0]?.record.session_id).toBe('sess-1');
        expect(entries[0]?.record.record_type).toBe('file-change');
        expect(entries[0]?.record.disposition).toBe('meta');
    });

    test('classifies observed prompt and snapshot records', () => {
        const prompt = grokSplit({
            is_bash: false,
            prompt: 'Explain this code',
            session_id: 'sess-1',
            timestamp: 1784274007,
        });
        expect(prompt[0]?.record.role).toBe('user');
        expect(prompt[0]?.record.content_text).toBe('Explain this code');

        const snapshot = grokSplit({
            after_snapshots: [],
            created_at: 1784274007,
            file_snapshots: [],
            prompt_index: 1,
        });
        expect(snapshot[0]?.record.record_type).toBe('file_snapshot');
        expect(snapshot[0]?.record.disposition).toBe('meta');
    });

    test('classifies observed question-answer records as assistant messages', () => {
        const entries = grokSplit({
            answer: 'Use the shared importer.',
            askedAt: 1784274007,
            btwSessionId: 'sess-1',
            question: 'How should this be imported?',
        });
        expect(entries[0]?.record.session_id).toBe('sess-1');
        expect(entries[0]?.record.role).toBe('assistant');
        expect(entries[0]?.record.content_text).toBe('How should this be imported?\nUse the shared importer.');
    });

    test('normalizes unix second timestamps as numbers', () => {
        const entries = grokSplit({
            timestamp: 1784274007,
            type: 'user',
            session_id: 'sess-1',
            seq: 1,
            content: 'hi',
        });
        // 1784274007 seconds → 2026-07-07T???
        expect(entries[0]?.record.ts).toMatch(/^2026-/);
    });

    test('normalizes unix timestamps as numeric strings', () => {
        // Exercises normalizeTs string-numeric branch (lines 690-691)
        const entries = grokSplit({
            ts: '1784274007',
            type: 'user',
            session_id: 'sess-1',
            seq: 1,
            content: 'hi',
        });
        expect(entries[0]?.record.ts).toMatch(/^2026-/);
    });

    test('preserves non-numeric string timestamps as-is', () => {
        // Exercises normalizeTs non-numeric string branch (line 694)
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'user',
            session_id: 'sess-1',
            seq: 1,
            content: 'hi',
        });
        expect(entries[0]?.record.ts).toBe('2026-08-07T00:00:00.000Z');
    });

    test('normalizes grok updates.jsonl shape with sessionUpdate', () => {
        const entries = grokSplit({
            timestamp: 1784274045,
            method: 'session/update',
            params: {
                sessionId: 'sess-1',
                update: {
                    sessionUpdate: 'tool_call',
                    toolCallId: 'call-1',
                    title: 'read_file',
                    rawInput: { path: '/tmp/x' },
                    _meta: { 'x.ai/tool': { name: 'read_file' } },
                },
            },
        });
        expect(entries.some((e) => e.targetTable === 'history_tool_call')).toBe(true);
        expect(entries.every((e) => e.record.disposition !== 'unknown')).toBe(true);
        const tool = entries.find((e) => e.targetTable === 'history_tool_call');
        expect(tool?.record.tool_name).toBe('read_file');
    });

    test('extracts content from object with text field', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'assistant',
            session_id: 'sess-1',
            seq: 1,
            content: { text: 'nested text' },
        });
        expect(entries[0]?.record.content_text).toBe('nested text');
    });

    test('extracts content from array of blocks', () => {
        const entries = grokSplit({
            ts: '2026-08-07T00:00:00.000Z',
            type: 'assistant',
            session_id: 'sess-1',
            seq: 1,
            content: [{ text: 'part 1' }, { text: 'part 2' }],
        });
        expect(entries[0]?.record.content_text).toBe('part 1\npart 2');
    });
});

// ---------------------------------------------------------------------------
// Field maps
// ---------------------------------------------------------------------------

describe('field maps', () => {
    const MESSAGE_KEYS = [
        'session_id',
        'seq',
        'turn_index',
        'role',
        'record_type',
        'disposition',
        'ts',
        'duration_ms',
        'model',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'cost_usd',
        'content_text',
        'cwd',
        'provenance',
        'run_id',
        'task_wbs',
    ];

    const TOOL_CALL_KEYS = [
        '_messageSplitIndex',
        'session_id',
        'seq',
        'tool_name',
        'args_digest',
        'status',
        'started_at',
        'completed_at',
        'duration_ms',
        'result_bytes',
        'error_text',
    ];

    const ALL_KEYS = [...new Set([...MESSAGE_KEYS, ...TOOL_CALL_KEYS])];

    function checkFieldMap(_name: string, map: Record<string, string>) {
        expect(Object.keys(map).sort()).toEqual([...ALL_KEYS].sort());
        for (const key of ALL_KEYS) {
            expect(map[key]).toBe(key);
        }
    }

    test('CLAUDE_FIELD_MAP has all expected keys', () => {
        checkFieldMap('CLAUDE_FIELD_MAP', CLAUDE_FIELD_MAP);
    });

    test('PI_FIELD_MAP has all expected keys', () => {
        checkFieldMap('PI_FIELD_MAP', PI_FIELD_MAP);
    });

    test('OMP_FIELD_MAP has all expected keys', () => {
        checkFieldMap('OMP_FIELD_MAP', OMP_FIELD_MAP);
    });

    test('CODEX_FIELD_MAP has all expected keys', () => {
        checkFieldMap('CODEX_FIELD_MAP', CODEX_FIELD_MAP);
    });

    test('AGY_FIELD_MAP has all expected keys', () => {
        checkFieldMap('AGY_FIELD_MAP', AGY_FIELD_MAP);
    });

    test('GROK_FIELD_MAP has all expected keys', () => {
        checkFieldMap('GROK_FIELD_MAP', GROK_FIELD_MAP);
    });

    test('GEMINI_FIELD_MAP has all expected keys', () => {
        checkFieldMap('GEMINI_FIELD_MAP', GEMINI_FIELD_MAP);
    });
});

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

describe('zod schemas', () => {
    test('CLAUDE_SCHEMA passes through any object', () => {
        expect(CLAUDE_SCHEMA.parse({ a: 1 })).toEqual({ a: 1 });
        expect(CLAUDE_SCHEMA.parse({})).toEqual({});
    });

    test('PI_SCHEMA passes through any object', () => {
        expect(PI_SCHEMA.parse({ b: 2 })).toEqual({ b: 2 });
    });

    test('OMP_SCHEMA passes through any object', () => {
        expect(OMP_SCHEMA.parse({ c: 3 })).toEqual({ c: 3 });
    });

    test('CODEX_SCHEMA passes through any object', () => {
        expect(CODEX_SCHEMA.parse({ d: 4 })).toEqual({ d: 4 });
    });

    test('AGY_SCHEMA passes through any object', () => {
        expect(AGY_SCHEMA.parse({ e: 5 })).toEqual({ e: 5 });
    });

    test('GROK_SCHEMA passes through any object', () => {
        expect(GROK_SCHEMA.parse({ f: 6 })).toEqual({ f: 6 });
    });

    test('GEMINI_SCHEMA passes through any object', () => {
        expect(GEMINI_SCHEMA.parse({ g: 7 })).toEqual({ g: 7 });
    });
});
