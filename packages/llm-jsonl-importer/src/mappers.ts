import { z } from 'zod';
import { sha256 } from './hash';
import type { JsonObject, SplitEntry, TransformContext } from './types';

// ---------------------------------------------------------------------------
// Helper: identity field map for typed columns
// ---------------------------------------------------------------------------

/** Columns the mapper may produce for history_message (excluding framework-managed fields). */
const MESSAGE_MAPPER_KEYS: readonly string[] = [
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

/** Columns the mapper may produce for history_tool_call. */
const TOOL_CALL_MAPPER_KEYS: readonly string[] = [
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

/** Build an identity fieldMap for the given column list. */
function identityFieldMap(keys: readonly string[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const key of keys) {
        map[key] = key;
    }
    return map;
}

// ---------------------------------------------------------------------------
// Source-specific helpers
// ---------------------------------------------------------------------------

/** Build a provenance string: 'ambient' unless cwd implies a spur workspace. */
function detectProvenance(cwd?: string): 'ambient' | 'spur-run' {
    if (cwd === undefined) return 'ambient';
    return cwd.includes('/spur') || cwd.includes('/spur-new') ? 'spur-run' : 'ambient';
}

/** Compute args_digest: sha256 of stable-jsonified, key-sorted, redacted args. */
function argsDigest(args: unknown): string {
    const redacted = redactArgs(args);
    return sha256(redacted);
}

/** Redact tool arguments for digest: replace string values > 80 chars or containing secrets. */
function redactArgs(args: unknown): unknown {
    if (typeof args === 'string') {
        if (args.length > 80) return '[REDACTED:long]';
        if (/[A-Za-z0-9+/]{40,}=*|[A-Za-z0-9_-]{20,}/.test(args)) return '[REDACTED:secret]';
        return args;
    }
    if (Array.isArray(args)) return args.map(redactArgs);
    if (args !== null && typeof args === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
            result[key] = redactArgs(value);
        }
        return result;
    }
    return args;
}

// ---------------------------------------------------------------------------
// Claude mapper
// ---------------------------------------------------------------------------

/** Map a Claude Code JSONL record into one or more ETL split entries. */
export function claudeSplit(raw: Record<string, unknown>): readonly SplitEntry[] {
    const entries: SplitEntry[] = [];
    const sessionId = s(raw.sessionId, raw.conversation_uuid) ?? 'unknown';
    const seq = typeof raw.seq === 'number' ? raw.seq : typeof raw.messageIndex === 'number' ? raw.messageIndex : 0;
    const ts = s(raw.ts, raw.timestamp, raw.createdAt) ?? new Date(0).toISOString();
    const role = mapRole(raw.type ?? raw.role);
    const recordType = String(raw.type ?? '');
    const model = s(raw.model);
    const cwd = s(raw.cwd, raw.dir);

    // Check for system/turn-duration records
    if (raw.subtype === 'turn_duration' && typeof raw.durationMs === 'number') {
        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'system',
                record_type: 'turn_duration',
                disposition: 'meta',
                ts,
                duration_ms: raw.durationMs,
                content_text: null,
                provenance: detectProvenance(cwd),
            },
        });
        return entries;
    }
    if (recordType === 'attachment' || recordType.startsWith('file-history')) {
        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'meta',
                record_type: recordType,
                disposition: 'meta',
                ts,
                provenance: detectProvenance(cwd),
            },
        });
        return entries;
    }

    // Main message
    const hasUsage = typeof raw.usage === 'object' && raw.usage !== null;
    const usage = hasUsage ? (raw.usage as Record<string, unknown>) : undefined;
    const inputTokens = typeof raw.inputTokens === 'number' ? raw.inputTokens : undefined;
    const outputTokens = typeof raw.outputTokens === 'number' ? raw.outputTokens : undefined;
    const cacheRead = (usage?.cacheReadTokens ?? usage?.cache_read_tokens ?? undefined) as number | undefined;
    const cacheWrite = (usage?.cacheWriteTokens ?? usage?.cache_write_tokens ?? undefined) as number | undefined;
    const costUsd = computeCost(inputTokens, outputTokens, model);

    const contentBlocks = raw.content;
    const contentText = extractContentText(contentBlocks);

    const messageSplitIndex = entries.length;

    entries.push({
        targetTable: 'history_message',
        record: {
            session_id: sessionId,
            seq,
            turn_index: typeof raw.turnIndex === 'number' ? raw.turnIndex : undefined,
            role,
            record_type: recordType,
            disposition: 'keep',
            ts,
            duration_ms: undefined,
            model: model ?? null,
            input_tokens: inputTokens ?? null,
            output_tokens: outputTokens ?? null,
            cache_read_tokens: cacheRead ?? null,
            cache_write_tokens: cacheWrite ?? null,
            cost_usd: costUsd ?? null,
            content_text: contentText ?? null,
            cwd: cwd ?? null,
            provenance: detectProvenance(cwd),
        },
    });

    // Tool calls from content blocks
    if (Array.isArray(contentBlocks) && role === 'assistant') {
        for (const block of contentBlocks) {
            if (typeof block !== 'object' || block === null) continue;
            const b = block as Record<string, unknown>;
            if (b.type === 'tool_use') {
                entries.push({
                    targetTable: 'history_tool_call',
                    record: {
                        _messageSplitIndex: messageSplitIndex,
                        session_id: sessionId,
                        seq,
                        tool_name: String(b.name ?? ''),
                        args_digest: argsDigest(b.input),
                        status: 'ok',
                        started_at: undefined,
                        completed_at: undefined,
                        duration_ms: undefined,
                        result_bytes: undefined,
                        error_text: undefined,
                    },
                });
            }
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Pi mapper
// ---------------------------------------------------------------------------

/** Map a Pi JSONL record into one or more ETL split entries. */
export function piSplit(raw: unknown): readonly SplitEntry[] {
    const entries: SplitEntry[] = [];
    const r = raw as Record<string, unknown>;
    const sessionId = s(r.id, o(r.session).id) ?? 'unknown';
    const seq = typeof r.seq === 'number' ? r.seq : 0;
    const ts = s(r.ts, r.timestamp, r.createdAt) ?? new Date(0).toISOString();
    const role = mapRole(r.type ?? r.role);
    const recordType = String(r.type ?? '');
    const model = s(r.model, o(r.message).model);
    const cwd = s(r.cwd, r.dir);

    const msg = r.message as Record<string, unknown> | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    const inputTokens = (usage?.input ?? usage?.input_tokens ?? undefined) as number | undefined;
    const outputTokens = (usage?.output ?? usage?.output_tokens ?? undefined) as number | undefined;
    const cacheRead = (usage?.cacheRead ?? usage?.cache_read_tokens ?? undefined) as number | undefined;
    const cacheWrite = (usage?.cacheWrite ?? usage?.cache_write_tokens ?? undefined) as number | undefined;
    const costObj = (msg?.cost ?? r.cost) as Record<string, unknown> | undefined;
    const costUsd = typeof costObj?.total === 'number' ? costObj.total : computeCost(inputTokens, outputTokens, model);

    const messageSplitIndex = entries.length;

    entries.push({
        targetTable: 'history_message',
        record: {
            session_id: sessionId,
            seq,
            role,
            record_type: recordType,
            disposition: 'keep',
            ts,
            duration_ms: undefined,
            model: model ?? null,
            input_tokens: inputTokens ?? null,
            output_tokens: outputTokens ?? null,
            cache_read_tokens: cacheRead ?? null,
            cache_write_tokens: cacheWrite ?? null,
            cost_usd: costUsd ?? null,
            content_text: s(r.content, r.text, msg?.content) ?? null,
            cwd: cwd ?? null,
            provenance: detectProvenance(cwd),
        },
    });

    // Tool calls from toolCall blocks in assistant content
    if (Array.isArray(r.content) && role === 'assistant') {
        for (const block of r.content as Record<string, unknown>[]) {
            if (block?.toolCall) {
                const tc = block.toolCall as Record<string, unknown>;
                entries.push({
                    targetTable: 'history_tool_call',
                    record: {
                        _messageSplitIndex: messageSplitIndex,
                        session_id: sessionId,
                        seq,
                        tool_name: String(tc.name ?? ''),
                        args_digest: argsDigest(tc.input ?? tc.arguments),
                        status: 'ok',
                        started_at: undefined,
                        completed_at: undefined,
                        duration_ms: undefined,
                        result_bytes: undefined,
                        error_text: undefined,
                    },
                });
            }
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// OMP mapper (near-identical to pi)
// ---------------------------------------------------------------------------

/** Map an OMP JSONL record into one or more ETL split entries. */
export function ompSplit(raw: Record<string, unknown>): readonly SplitEntry[] {
    const recordType = String(raw.type ?? '');
    if (
        recordType === 'title' ||
        recordType === 'title_change' ||
        recordType === 'service_tier_change' ||
        recordType === 'ttsr_injection' ||
        recordType === 'session_init' ||
        recordType === 'compaction'
    ) {
        return [
            {
                targetTable: 'history_message',
                record: {
                    session_id: s(raw.id, o(raw.session).id) ?? 'unknown',
                    seq: typeof raw.seq === 'number' ? raw.seq : 0,
                    role: 'meta',
                    record_type: recordType,
                    disposition: 'meta',
                    ts: s(raw.ts, raw.timestamp) ?? new Date(0).toISOString(),
                    provenance: 'ambient',
                },
            },
        ];
    }

    const entries: SplitEntry[] = [];
    const sessionId = s(raw.id, o(raw.session).id) ?? 'unknown';
    const seq = typeof raw.seq === 'number' ? raw.seq : 0;
    const ts = s(raw.ts, raw.timestamp, raw.createdAt) ?? new Date(0).toISOString();
    const role = mapRole(raw.type ?? raw.role);
    const model = s(raw.model, o(raw.message).model);
    const cwd = s(raw.cwd, raw.dir);

    const msg = raw.message as Record<string, unknown> | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    const inputTokens = (usage?.input ?? usage?.input_tokens ?? undefined) as number | undefined;
    const outputTokens = (usage?.output ?? usage?.output_tokens ?? undefined) as number | undefined;
    const cacheRead = (usage?.cacheRead ?? usage?.cache_read_tokens ?? undefined) as number | undefined;
    const cacheWrite = (usage?.cacheWrite ?? usage?.cache_write_tokens ?? undefined) as number | undefined;
    const costObj = (msg?.cost ?? raw.cost) as Record<string, unknown> | undefined;
    const costUsd = typeof costObj?.total === 'number' ? costObj.total : computeCost(inputTokens, outputTokens, model);

    const messageSplitIndex = entries.length;

    entries.push({
        targetTable: 'history_message',
        record: {
            session_id: sessionId,
            seq,
            role,
            record_type: recordType,
            disposition: 'keep',
            ts,
            duration_ms: undefined,
            model: model ?? null,
            input_tokens: inputTokens ?? null,
            output_tokens: outputTokens ?? null,
            cache_read_tokens: cacheRead ?? null,
            cache_write_tokens: cacheWrite ?? null,
            cost_usd: costUsd ?? null,
            content_text: s(raw.content, raw.text, msg?.content) ?? null,
            cwd: cwd ?? null,
            provenance: detectProvenance(cwd),
        },
    });

    if (Array.isArray(raw.content) && role === 'assistant') {
        for (const block of raw.content as Record<string, unknown>[]) {
            if (block?.toolCall) {
                const tc = block.toolCall as Record<string, unknown>;
                entries.push({
                    targetTable: 'history_tool_call',
                    record: {
                        _messageSplitIndex: messageSplitIndex,
                        session_id: sessionId,
                        seq,
                        tool_name: String(tc.name ?? ''),
                        args_digest: argsDigest(tc.input ?? tc.arguments),
                        status: 'ok',
                        started_at: undefined,
                        completed_at: undefined,
                        duration_ms: undefined,
                        result_bytes: undefined,
                        error_text: undefined,
                    },
                });
            }
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Codex mapper
// ---------------------------------------------------------------------------

/** Map a Codex JSONL record into one or more ETL split entries. */
export function codexSplit(raw: Record<string, unknown>): readonly SplitEntry[] {
    const entries: SplitEntry[] = [];

    const payload = (raw.payload ?? raw) as Record<string, unknown>;
    const sessionId = s(raw.session_id, o(raw.session_meta).id, raw.id) ?? 'unknown';
    const seq = typeof raw.seq === 'number' ? raw.seq : 0;
    const ts = s(raw.timestamp, raw.ts, payload.ts) ?? new Date(0).toISOString();
    const recordType = String(raw.type ?? '');

    // Check for older short format
    if (recordType === '' && raw.id && raw.timestamp && raw.instructions) {
        return [
            {
                targetTable: 'history_message',
                record: {
                    session_id: sessionId,
                    seq,
                    role: 'meta',
                    record_type: 'short_format',
                    disposition: 'meta',
                    ts,
                    provenance: 'ambient',
                },
            },
        ];
    }

    const role = mapRole(recordType);
    const model = s(raw.model, payload.model, o(o(raw.turn_context).payload).model);
    const cwd = s(raw.cwd, raw.dir);

    const tokenCount = payload.token_count as Record<string, unknown> | undefined;
    const inputTokens = (tokenCount?.input ?? tokenCount?.input_tokens ?? undefined) as number | undefined;
    const outputTokens = (tokenCount?.output ?? tokenCount?.output_tokens ?? undefined) as number | undefined;

    const turnCtx = raw.turn_context as Record<string, unknown> | undefined;
    const turnPayload = turnCtx?.payload as Record<string, unknown> | undefined;
    const turnInputTokens = turnPayload?.input_tokens as number | undefined;
    const turnOutputTokens = turnPayload?.output_tokens as number | undefined;

    const finalInput = inputTokens !== undefined ? inputTokens : turnInputTokens;
    const finalOutput = outputTokens !== undefined ? outputTokens : turnOutputTokens;
    const costUsd = computeCost(finalInput, finalOutput, model);

    const messageSplitIndex = entries.length;

    entries.push({
        targetTable: 'history_message',
        record: {
            session_id: sessionId,
            seq,
            role,
            record_type: recordType,
            disposition: 'keep',
            ts,
            duration_ms: undefined,
            model: model ?? null,
            input_tokens: finalInput ?? null,
            output_tokens: finalOutput ?? null,
            cache_read_tokens: null,
            cache_write_tokens: null,
            cost_usd: costUsd ?? null,
            content_text: s(payload.content, payload.text, raw.content, raw.text) ?? null,
            cwd: cwd ?? null,
            provenance: detectProvenance(cwd),
        },
    });

    // Tool calls: function_call in response_item
    const responseItems = payload.response_item
        ? [payload.response_item as Record<string, unknown>]
        : Array.isArray(payload.response_items)
          ? (payload.response_items as Record<string, unknown>[])
          : [];
    for (const item of responseItems) {
        if (item.function_call) {
            const fc = item.function_call as Record<string, unknown>;
            entries.push({
                targetTable: 'history_tool_call',
                record: {
                    _messageSplitIndex: messageSplitIndex,
                    session_id: sessionId,
                    seq,
                    tool_name: String(fc.name ?? ''),
                    args_digest: argsDigest(fc.arguments),
                    status: 'ok',
                    started_at: undefined,
                    completed_at: undefined,
                    duration_ms: undefined,
                    result_bytes: undefined,
                    error_text: undefined,
                },
            });
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// AGY mapper (Antigravity CLI)
// ---------------------------------------------------------------------------

/** Map an Antigravity (AGY) JSONL record into one or more ETL split entries. */
export function agySplit(raw: Record<string, unknown>): readonly SplitEntry[] {
    const entries: SplitEntry[] = [];
    const recordType = String(raw.type ?? '');
    const sessionId = s(raw.session_id, raw.conversation_id) ?? 'unknown';
    const seq = typeof raw.seq === 'number' ? raw.seq : typeof raw.step_index === 'number' ? raw.step_index : 0;
    const ts = s(raw.created_at, raw.timestamp, raw.ts) ?? new Date(0).toISOString();

    let role: string;
    let disposition: string;
    let contentText: string | null = null;

    // Classification from task 0463 field map (agy transcript types).
    switch (recordType) {
        case 'USER_INPUT':
        case 'ASK_QUESTION':
            role = 'user';
            disposition = 'keep';
            contentText = s(raw.content, raw.text, raw.message) ?? null;
            break;
        case 'PLANNER_RESPONSE':
            role = 'assistant';
            disposition = 'keep';
            contentText = s(raw.content, raw.text, raw.message, raw.plan) ?? null;
            break;
        case 'ERROR_MESSAGE':
            role = 'system';
            disposition = 'keep';
            contentText = s(raw.content, raw.text, raw.message) ?? null;
            break;
        case 'RUN_COMMAND':
        case 'VIEW_FILE':
        case 'GREP_SEARCH':
        case 'LIST_DIRECTORY':
        case 'READ_URL_CONTENT':
            role = 'tool';
            disposition = 'keep';
            contentText = s(raw.content, raw.command, raw.file_path, raw.pattern) ?? null;
            break;
        case 'CODE_ACTION':
        case 'INVOKE_SUBAGENT':
            role = 'tool';
            disposition = 'keep';
            contentText = s(raw.content, raw.text) ?? null;
            break;
        case 'CONVERSATION_HISTORY':
        case 'CHECKPOINT':
        case 'GENERIC':
            role = 'meta';
            disposition = 'meta';
            contentText = s(raw.content, raw.text) ?? null;
            break;
        default:
            if (recordType.length === 0) {
                role = 'unknown';
                disposition = 'unknown';
            } else {
                // Known discriminator present but not in the frozen 0463 keep/meta table —
                // still a determined type; treat as meta bookkeeping rather than unknown.
                role = 'meta';
                disposition = 'meta';
                contentText = s(raw.content, raw.text) ?? null;
            }
            break;
    }

    const messageSplitIndex = entries.length;

    entries.push({
        targetTable: 'history_message',
        record: {
            session_id: sessionId,
            seq,
            role,
            record_type: recordType,
            disposition,
            ts,
            duration_ms: undefined,
            model: null,
            input_tokens: null,
            output_tokens: null,
            cache_read_tokens: null,
            cache_write_tokens: null,
            cost_usd: null,
            content_text: contentText,
            cwd: null,
            provenance: 'ambient',
        },
    });

    // Tool calls from PLANNER_RESPONSE.tool_calls[]
    if (recordType === 'PLANNER_RESPONSE' && Array.isArray(raw.tool_calls)) {
        for (const tc of raw.tool_calls as Record<string, unknown>[]) {
            entries.push({
                targetTable: 'history_tool_call',
                record: {
                    _messageSplitIndex: messageSplitIndex,
                    session_id: sessionId,
                    seq: typeof tc.step_index === 'number' ? tc.step_index : seq,
                    tool_name: String(tc.name ?? tc.tool_name ?? ''),
                    args_digest: argsDigest(tc.input ?? tc.arguments),
                    status: 'ok',
                    started_at: undefined,
                    completed_at: undefined,
                    duration_ms: undefined,
                    result_bytes: undefined,
                    error_text: undefined,
                },
            });
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Gemini mapper
// ---------------------------------------------------------------------------

/** Map Gemini CLI message, tool, and session-state events into the forensic contract tables. */
export function geminiSplit(raw: Record<string, unknown>, context?: TransformContext): readonly SplitEntry[] {
    const recordType = String(raw.type ?? (raw.kind !== undefined ? 'session' : raw.$set !== undefined ? 'state' : ''));
    const state = o(raw.$set);
    const sessionId = sessionIdFromContext(context, raw);
    const seq = context?.sourceLine ?? 0;
    const ts = s(raw.timestamp, raw.startTime, raw.lastUpdated, state.lastUpdated) ?? new Date(0).toISOString();

    if (recordType === 'session' || recordType === 'state') {
        return [
            {
                targetTable: 'history_message',
                record: {
                    session_id: sessionId,
                    seq,
                    role: 'meta',
                    record_type: recordType,
                    disposition: 'meta',
                    ts,
                    content_text: s(state.summary) ?? null,
                    provenance: detectProvenance(context?.sourceFile),
                },
            },
        ];
    }

    const role = recordType === 'gemini' ? 'assistant' : recordType === 'user' ? 'user' : 'system';
    const tokens = o(raw.tokens);
    const content = geminiContent(raw);
    const entries: SplitEntry[] = [
        {
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role,
                record_type: recordType,
                disposition: 'keep',
                ts,
                duration_ms: null,
                model: s(raw.model) ?? null,
                input_tokens: numberOrNull(tokens.input),
                output_tokens: numberOrNull(tokens.output),
                cache_read_tokens: numberOrNull(tokens.cached),
                cache_write_tokens: null,
                cost_usd: null,
                content_text: content,
                cwd: null,
                provenance: detectProvenance(context?.sourceFile),
            },
        },
    ];

    if (Array.isArray(raw.toolCalls)) {
        for (const value of raw.toolCalls) {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
            const tool = value as Record<string, unknown>;
            const status = s(tool.status) ?? 'unknown';
            const timestamp = s(tool.timestamp);
            const result = tool.result ?? tool.resultDisplay;
            entries.push({
                targetTable: 'history_tool_call',
                record: {
                    _messageSplitIndex: 0,
                    session_id: sessionId,
                    seq,
                    tool_name: s(tool.name, tool.displayName) ?? 'unknown',
                    args_digest: argsDigest(tool.args),
                    status,
                    started_at: timestamp,
                    completed_at: timestamp,
                    duration_ms: null,
                    result_bytes:
                        result === undefined ? null : new TextEncoder().encode(JSON.stringify(result)).byteLength,
                    error_text: status === 'error' ? (s(tool.resultDisplay, tool.result) ?? null) : null,
                },
            });
        }
    }

    return entries;
}

function sessionIdFromContext(context: TransformContext | undefined, raw: Record<string, unknown>): string {
    if (context !== undefined) {
        const file = context.sourceFile.split('/').at(-1);
        if (file !== undefined) return file.replace(/\.jsonl$/, '');
    }
    return s(raw.sessionId, raw.id) ?? 'unknown';
}

function geminiContent(raw: Record<string, unknown>): string | null {
    const content = extractContentText(raw.content);
    const thoughts = Array.isArray(raw.thoughts)
        ? raw.thoughts
              .map((value) => (value !== null && typeof value === 'object' ? s(o(value).description) : undefined))
              .filter((value): value is string => value !== undefined)
              .join('\n')
        : '';
    return (
        [content, thoughts].filter((value): value is string => value !== undefined && value.length > 0).join('\n') ||
        null
    );
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Grok mapper
// ---------------------------------------------------------------------------

/**
 * Grok emits two JSONL shapes per session (task 0463):
 * - `events.jsonl`: flat `{ts, type, ...}`
 * - `updates.jsonl`: JSON-RPC-like `{timestamp, method, params:{sessionId, update:{sessionUpdate,...}}}`
 *
 * Normalize both into a single view before disposition mapping.
 */
function normalizeGrokRecord(raw: Record<string, unknown>): {
    recordType: string;
    sessionId: string;
    ts: string;
    seq: number;
    body: Record<string, unknown>;
    model: string | undefined;
    contentText: string | null;
    usage: Record<string, unknown> | undefined;
    toolName: string;
    toolArgs: unknown;
    toolStatus: string;
    durationMs: number | undefined;
    errorText: string | undefined;
    hasTypeDiscriminator: boolean;
} {
    const params = raw.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    const isUpdatesShape = typeof raw.method === 'string' && params !== undefined && update !== undefined;

    const body = isUpdatesShape ? update : raw;
    const recordType = String(
        (isUpdatesShape ? update?.sessionUpdate : raw.type) ??
            raw.sessionUpdate ??
            raw.eventType ??
            (raw.file_snapshots !== undefined || raw.after_snapshots !== undefined
                ? 'file_snapshot'
                : raw.prompt !== undefined
                  ? 'user_message'
                  : raw.answer !== undefined || raw.question !== undefined
                    ? 'assistant'
                    : ''),
    );
    const sessionId =
        s(
            params?.sessionId,
            raw.session_id,
            raw.sessionId,
            raw.parentSessionId,
            raw.btwSessionId,
            (raw.params as Record<string, unknown> | undefined)?.sessionId,
        ) ?? 'unknown';
    const ts = normalizeTs(raw.ts ?? raw.timestamp ?? raw.created_at ?? raw.askedAt ?? body.ts ?? body.timestamp);
    const seq = typeof raw.seq === 'number' ? raw.seq : typeof body.seq === 'number' ? body.seq : 0;
    const meta = (body._meta ?? params?._meta ?? raw._meta) as Record<string, unknown> | undefined;
    const model = s(meta?.modelId, body.model, raw.model);
    const contentText = extractGrokContent(
        body.content ??
            body.text ??
            raw.content ??
            raw.text ??
            raw.prompt ??
            (raw.answer !== undefined || raw.question !== undefined
                ? [raw.question, raw.answer].filter((value) => typeof value === 'string').join('\n')
                : undefined),
    );
    const usage = (body.usage ?? raw.usage) as Record<string, unknown> | undefined;
    const toolMeta = meta?.['x.ai/tool'] as Record<string, unknown> | undefined;
    const toolName =
        s(body.title, body.tool_name, body.name, toolMeta?.name, toolMeta?.label, raw.tool_name, raw.name) ?? '';
    const toolArgs = body.rawInput ?? body.input ?? body.arguments ?? toolMeta?.input ?? raw.input ?? raw.arguments;
    const toolStatus = s(body.status, raw.outcome, raw.status) ?? 'ok';
    const durationMs =
        typeof body.duration_ms === 'number'
            ? body.duration_ms
            : typeof raw.duration_ms === 'number'
              ? raw.duration_ms
              : typeof usage?.apiDurationMs === 'number'
                ? (usage.apiDurationMs as number)
                : undefined;
    const errorText =
        body.error !== undefined ? String(body.error) : raw.error !== undefined ? String(raw.error) : undefined;
    const hasTypeDiscriminator = recordType.length > 0 || isUpdatesShape;

    return {
        recordType,
        sessionId,
        ts,
        seq,
        body,
        model,
        contentText,
        usage,
        toolName,
        toolArgs,
        toolStatus,
        durationMs,
        errorText,
        hasTypeDiscriminator,
    };
}

function normalizeTs(value: unknown): string {
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Grok timestamps are unix seconds (sometimes with fractional).
        const ms = value > 1e12 ? value : value * 1000;
        return new Date(ms).toISOString();
    }
    if (typeof value === 'string' && value.length > 0) {
        const asNum = Number(value);
        if (Number.isFinite(asNum) && /^\d+(\.\d+)?$/.test(value.trim())) {
            const ms = asNum > 1e12 ? asNum : asNum * 1000;
            return new Date(ms).toISOString();
        }
        return value;
    }
    return new Date(0).toISOString();
}

function extractGrokContent(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
        const c = content as Record<string, unknown>;
        if (typeof c.text === 'string') return c.text;
        if (typeof c.content === 'string') return c.content;
    }
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
            if (typeof block === 'string') parts.push(block);
            else if (block !== null && typeof block === 'object') {
                const b = block as Record<string, unknown>;
                if (typeof b.text === 'string') parts.push(b.text);
            }
        }
        return parts.length > 0 ? parts.join('\n') : null;
    }
    return null;
}

/** Bookkeeping event types from 0463 grok field map → disposition meta. */
const GROK_META_TYPES = new Set([
    'phase_changed',
    'permission_requested',
    'permission_resolved',
    'mcp_server_starting',
    'mcp_server_connected',
    'mcp_config_resolved',
    'mcp_managed_config_result',
    'mcp_transport_decode_error',
    'mcp_init_completed',
    'mcp_health_check',
    'loop_started',
    'first_token',
    'agent_thought_chunk',
    'hook_execution',
    'plan',
    'session_recap',
    'task_backgrounded',
    'task_completed',
    'retry_state',
    'auto_compact_started',
    'auto_compact_completed',
    'compaction_checkpoint',
    'image_compressed',
    'reasoning',
    'system',
    'turn_started',
    'turn_ended',
    'yolo_toggled',
]);

/** Map a Grok JSONL record into one or more ETL split entries. */
export function grokSplit(raw: Record<string, unknown>): readonly SplitEntry[] {
    const entries: SplitEntry[] = [];
    const n = normalizeGrokRecord(raw);
    const { recordType, sessionId, ts, seq } = n;

    if (recordType === 'turn_completed') {
        const usage = n.usage;
        const modelUsage = usage?.modelUsage;
        const modelFromUsage =
            modelUsage !== null && typeof modelUsage === 'object'
                ? Object.keys(modelUsage as Record<string, unknown>)[0]
                : undefined;
        const model = s(n.model, modelFromUsage);
        const inputTokens = (usage?.inputTokens ?? usage?.input ?? usage?.input_tokens) as number | undefined;
        const outputTokens = (usage?.outputTokens ?? usage?.output ?? usage?.output_tokens) as number | undefined;
        const cacheRead = (usage?.cachedReadTokens ?? usage?.cache_read_tokens) as number | undefined;

        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'assistant',
                record_type: recordType,
                disposition: 'keep',
                ts,
                duration_ms: n.durationMs ?? null,
                model: model ?? null,
                input_tokens: inputTokens ?? null,
                output_tokens: outputTokens ?? null,
                cache_read_tokens: cacheRead ?? null,
                cache_write_tokens: null,
                cost_usd: null,
                content_text: n.contentText,
                cwd: null,
                provenance: 'ambient',
            },
        });
        return entries;
    }

    if (recordType === 'tool_started') {
        const messageSplitIndex = 0;
        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'assistant',
                record_type: recordType,
                disposition: 'keep',
                ts,
                duration_ms: undefined,
                model: n.model ?? null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_write_tokens: null,
                cost_usd: null,
                content_text: n.contentText,
                cwd: null,
                provenance: 'ambient',
            },
        });
        entries.push({
            targetTable: 'history_tool_call',
            record: {
                _messageSplitIndex: messageSplitIndex,
                session_id: sessionId,
                seq,
                tool_name: n.toolName,
                args_digest: argsDigest(n.toolArgs),
                status: n.toolStatus || 'ok',
                started_at: ts,
                completed_at: undefined,
                duration_ms: undefined,
                result_bytes: undefined,
                error_text: n.errorText,
            },
        });
        return entries;
    }

    if (recordType === 'tool_completed') {
        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'assistant',
                record_type: recordType,
                disposition: 'keep',
                ts,
                duration_ms: n.durationMs ?? null,
                model: n.model ?? null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_write_tokens: null,
                cost_usd: null,
                content_text: n.contentText,
                cwd: null,
                provenance: 'ambient',
            },
        });
        entries.push({
            targetTable: 'history_tool_call',
            record: {
                _messageSplitIndex: 0,
                session_id: sessionId,
                seq,
                tool_name: n.toolName,
                args_digest: null,
                status: n.toolStatus || 'ok',
                started_at: undefined,
                completed_at: ts,
                duration_ms: n.durationMs,
                result_bytes: undefined,
                error_text: n.errorText,
            },
        });
        return entries;
    }

    if (recordType === 'tool_call' || recordType === 'tool_call_update') {
        // Pair tool_call with a parent message row so message_hash resolution works.
        const messageSplitIndex = 0;
        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'assistant',
                record_type: recordType,
                disposition: 'keep',
                ts,
                duration_ms: undefined,
                model: n.model ?? null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_write_tokens: null,
                cost_usd: null,
                content_text: n.contentText,
                cwd: null,
                provenance: 'ambient',
            },
        });
        entries.push({
            targetTable: 'history_tool_call',
            record: {
                _messageSplitIndex: messageSplitIndex,
                session_id: sessionId,
                seq,
                tool_name: n.toolName,
                args_digest: argsDigest(n.toolArgs),
                status: n.toolStatus || 'ok',
                started_at: recordType === 'tool_call' ? ts : undefined,
                completed_at: recordType === 'tool_call_update' ? ts : undefined,
                duration_ms: n.durationMs,
                result_bytes: undefined,
                error_text: n.errorText,
            },
        });
        return entries;
    }

    if (
        recordType === 'user' ||
        recordType === 'user_message' ||
        recordType === 'user_message_chunk' ||
        recordType === 'message'
    ) {
        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'user',
                record_type: recordType || 'user_message',
                disposition: 'keep',
                ts,
                duration_ms: undefined,
                model: null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_write_tokens: null,
                cost_usd: null,
                content_text: n.contentText,
                cwd: null,
                provenance: 'ambient',
            },
        });
        return entries;
    }

    if (recordType === 'assistant' || recordType === 'agent_message_chunk') {
        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'assistant',
                record_type: recordType,
                disposition: 'keep',
                ts,
                duration_ms: undefined,
                model: n.model ?? null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_write_tokens: null,
                cost_usd: null,
                content_text: n.contentText,
                cwd: null,
                provenance: 'ambient',
            },
        });
        return entries;
    }

    if (GROK_META_TYPES.has(recordType)) {
        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'meta',
                record_type: recordType,
                disposition: 'meta',
                ts,
                duration_ms: n.durationMs ?? null,
                model: n.model ?? null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_write_tokens: null,
                cost_usd: null,
                content_text: n.contentText,
                cwd: null,
                provenance: 'ambient',
            },
        });
        return entries;
    }

    // True unknown: no type discriminator (or an unlisted type with empty discriminator).
    // Capture loudly with a stable field-shape key (R6).
    if (!n.hasTypeDiscriminator || recordType.length === 0) {
        entries.push({
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role: 'unknown',
                record_type: stableFieldShape(raw as JsonObject),
                disposition: 'unknown',
                ts,
                duration_ms: undefined,
                model: null,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_write_tokens: null,
                cost_usd: null,
                content_text: n.contentText,
                cwd: null,
                provenance: 'ambient',
            },
        });
        return entries;
    }

    // Determined but unlisted type — keep as meta bookkeeping, not unknown.
    entries.push({
        targetTable: 'history_message',
        record: {
            session_id: sessionId,
            seq,
            role: 'meta',
            record_type: recordType,
            disposition: 'meta',
            ts,
            duration_ms: n.durationMs ?? null,
            model: n.model ?? null,
            input_tokens: null,
            output_tokens: null,
            cache_read_tokens: null,
            cache_write_tokens: null,
            cost_usd: null,
            content_text: n.contentText,
            cwd: null,
            provenance: 'ambient',
        },
    });
    return entries;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** Narrow an unknown JSON value to an object bag so nested lookups type-check. */
function o(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Safe string accessor: returns the first non-empty string value. */
function s(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) return value;
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return undefined;
}

function mapRole(type: unknown): string {
    const t = String(type ?? '').toLowerCase();
    if (t === 'user' || t === 'human') return 'user';
    if (t === 'assistant' || t === 'ai' || t === 'model') return 'assistant';
    if (t === 'system' || t === 'error') return 'system';
    return t || 'unknown';
}

/** Compute cost_usd from token counts and model. Conservative estimate using known rates. */
function computeCost(
    inputTokens?: number | null,
    outputTokens?: number | null,
    model?: string | null,
): number | undefined {
    if (inputTokens === undefined || inputTokens === null) return undefined;
    if (outputTokens === undefined || outputTokens === null) return undefined;
    const inputRate = model?.toLowerCase().includes('claude') ? 3 : 1;
    const outputRate = model?.toLowerCase().includes('claude') ? 15 : 5;
    return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

/** Extract text content from Claude-style content blocks. */
function extractContentText(content: unknown): string | undefined {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
            parts.push(b.text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Compute a stable field-shape key from a JSON object: sorted, lowercased, +-joined top-level keys. */
export function stableFieldShape(raw: JsonObject): string {
    return Object.keys(raw)
        .map((k) => k.toLowerCase())
        .sort()
        .join('+');
}

// ---------------------------------------------------------------------------
// Identity field maps for the six source mappers
// ---------------------------------------------------------------------------

/** Identity field map for the Claude mapper. */
export const CLAUDE_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS));
/** Identity field map for the Pi mapper. */
export const PI_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS));
/** Identity field map for the OMP mapper. */
export const OMP_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS));
/** Identity field map for the Codex mapper. */
export const CODEX_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS));
/** Identity field map for the AGY mapper. */
export const AGY_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS));
/** Identity field map for the Grok mapper. */
export const GROK_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS));
/** Identity field map for the Gemini mapper. */
export const GEMINI_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS));

// ---------------------------------------------------------------------------
// Zod schemas for the six source mappers
// ---------------------------------------------------------------------------

const passthroughSchema = z.object({}).passthrough();

/** Passthrough Zod schema for the Claude mapper. */
export const CLAUDE_SCHEMA = passthroughSchema;
/** Passthrough Zod schema for the Pi mapper. */
export const PI_SCHEMA = passthroughSchema;
/** Passthrough Zod schema for the OMP mapper. */
export const OMP_SCHEMA = passthroughSchema;
/** Passthrough Zod schema for the Codex mapper. */
export const CODEX_SCHEMA = passthroughSchema;
/** Passthrough Zod schema for the AGY mapper. */
export const AGY_SCHEMA = passthroughSchema;
/** Passthrough Zod schema for the Grok mapper. */
export const GROK_SCHEMA = passthroughSchema;
/** Passthrough Zod schema for the Gemini mapper. */
export const GEMINI_SCHEMA = passthroughSchema;
