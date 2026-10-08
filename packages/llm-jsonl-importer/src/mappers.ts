import { z } from 'zod';
import {
    type CapabilityOriginMatch,
    capabilityInvocationId,
    extractNestedExecCommandLiterals,
    matchCapabilityOrigin,
    parseLiteralReadTargets,
} from './capability';
import { sha256, sha256Text } from './hash';
import { applyRules } from './redaction';
import type { JsonObject, SkillCallSplitRecord, SplitEntry, TransformContext } from './types';

// ---------------------------------------------------------------------------
// Helper: identity field map for typed columns
// ---------------------------------------------------------------------------

/** Columns the mapper may produce for history_message (excluding framework-managed fields). */
const MESSAGE_MAPPER_KEYS: readonly string[] = [
    // 0678 R3 internal transport: codex token_count usage rides the mapper output to the
    // importer, which re-targets it at the latest assistant row and deletes this key.
    '_codexUsageCarrier',
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
    'request_id',
];

/** Columns the mapper may produce for history_tool_call. */
const TOOL_CALL_MAPPER_KEYS: readonly string[] = [
    '_messageSplitIndex',
    'session_id',
    'seq',
    'tool_name',
    'call_id',
    'args_digest',
    'args_raw',
    'status',
    'started_at',
    'completed_at',
    'duration_ms',
    'result_bytes',
    'error_text',
];

/** Columns the mapper may produce for history_skill_call (0736, E93 1028). */
const SKILL_CALL_MAPPER_KEYS: readonly string[] = [
    '_messageSplitIndex',
    'session_id',
    'seq',
    'skill_name',
    'invocation_kind',
    'skill_path',
    'args_raw',
    'args_digest',
    'call_id',
    'status',
    'started_at',
    'completed_at',
    'duration_ms',
    'capability_kind',
    'evidence_kind',
    'invocation_id',
    'origin_identity',
    // Classification-conflict marker (E93 1028): rides the record into the record_hash and
    // is surfaced as a bounded importer finding; the DAO typed path ignores it on insert.
    '_capabilityConflict',
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
// Skill-load extraction (0736)
// ---------------------------------------------------------------------------

/** Harness skill packages whose dialect spelling swaps ':' for '-' (storm report §10.1). */
const HARNESS_SKILL_PACKAGES = new Set(['sp', 'rd3']);

/**
 * Canonicalize a harness skill name: `sp-dev-run` / `$sp-dev-run` / `/skill:sp-dev-run` →
 * `sp:dev-run`; `rd3-*` → `rd3:*`. Only the frozen harness package set is rewritten — an
 * unqualified name like `code-review` is kept verbatim (exact structural match, 0736 R4).
 */
export function canonicalizeSkillName(raw: string): string {
    let name = raw.trim();
    if (name.startsWith('/') || name.startsWith('$')) name = name.slice(1);
    if (name.startsWith('skill:')) name = name.slice('skill:'.length);
    const canonical = name.match(/^([a-z][a-z0-9]*):([a-z0-9-]+)$/);
    if (canonical !== null && HARNESS_SKILL_PACKAGES.has(canonical[1] ?? '')) return name;
    const dialect = name.match(/^([a-z][a-z0-9]*)-([a-z0-9-]+)$/);
    if (dialect !== null && HARNESS_SKILL_PACKAGES.has(dialect[1] ?? '')) return `${dialect[1]}:${dialect[2]}`;
    return name;
}

/** Identity fields a split already computed for its parent message (skill rows join it). */
export interface SkillCallIdentity {
    readonly sessionId: string;
    readonly seq: number;
    /** Split index of the parent message entry in the same split batch (_messageSplitIndex). */
    readonly messageSplitIndex: number;
}

/**
 * Detect skill activity in one raw source record (0736 R1/R2; E93 task 1028). Dispatches on
 * the source in the transform context; unknown/deferred sources return nothing. Detection is
 * signature-driven, never keyword-based: quoted skill text, summaries, wrappers inside quotes
 * or comments, and ordinary skill-file reads outside the bounded literal grammar produce no
 * rows. E93 rows classify capability facts by precedence: native source identity (command
 * expansion envelope, native command record, delegation record), then a unique supplied
 * {@link TransformContext.capabilityOrigins} match (source + canonical name + exact path +
 * complete-artifact digest agreement), then unknown — never from a name prefix alone.
 */
export function extractSkillCalls(
    raw: JsonObject,
    context: TransformContext | undefined,
    identity: SkillCallIdentity,
): readonly SkillCallSplitRecord[] {
    switch (context?.source) {
        case 'claude':
            return detectClaudeSkillCalls(raw, identity, context);
        case 'pi':
            return detectPiSkillCalls(raw, identity, context);
        case 'omp':
            return detectOmpSkillCalls(raw, identity, context);
        case 'codex':
            return detectCodexSkillCalls(raw, identity, context);
        case 'agy':
            return detectAgySkillCalls(raw, identity, context);
        case 'gemini':
            return detectGeminiSkillCalls(raw, identity, context);
        case 'grok':
            return detectGrokSkillCalls(raw, identity, context);
        default:
            return [];
    }
}

/**
 * Route one skill-load row to `history_skill_call` exactly like tool calls route to
 * `history_tool_call`: a SplitEntry whose record the importer normalizes, hashes, dedups,
 * and inserts through the typed-column path.
 */
export function skillCallEntry(record: SkillCallSplitRecord): SplitEntry {
    // The split record's keys are exactly the history_skill_call typed columns; the index
    // signature is supplied at this boundary (runtime shape is JSON-compatible by construction).
    return { targetTable: 'history_skill_call', record: record as unknown as JsonObject };
}

/** Build a fully-populated skill row: every optional column set explicitly for hash stability.
 *
 * Status defaults to `'unknown'` (E93 1028): a request, an unpaired load, or an attempt
 * with unobserved outcome is never recorded as success. Detectors upgrade to `'ok'` only
 * on verified harness injection (a complete injected wrapper) or an observed outcome, and
 * result pairing (§8.2) upgrades call-id-bearing rows when their result arrives.
 */
function skillRecord(
    identity: SkillCallIdentity,
    skillName: string,
    invocationKind: 'user' | 'model',
    extra: Partial<SkillCallSplitRecord> = {},
): SkillCallSplitRecord {
    return {
        _messageSplitIndex: identity.messageSplitIndex,
        session_id: identity.sessionId,
        seq: identity.seq,
        skill_name: canonicalizeSkillName(skillName),
        invocation_kind: invocationKind,
        skill_path: null,
        args_raw: null,
        args_digest: null,
        call_id: null,
        status: 'unknown',
        started_at: null,
        completed_at: null,
        duration_ms: null,
        capability_kind: null,
        evidence_kind: null,
        invocation_id: null,
        origin_identity: null,
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// Capability classification helpers (E93 task 1028)
// ---------------------------------------------------------------------------

/** Per-record invocation ordinal allocator: distinct keys keep distinct ordinals, repeated keys share theirs. */
function createOrdinalAllocator(): (key: string) => number {
    const ordinals = new Map<string, number>();
    return (key) => {
        const existing = ordinals.get(key);
        if (existing !== undefined) return existing;
        const ordinal = ordinals.size;
        ordinals.set(key, ordinal);
        return ordinal;
    };
}

/** Origin match + conflict marker fields for one observable skill identity. */
function originFields(
    context: TransformContext | undefined,
    canonicalName: string,
    observable: { skillPath?: string | null; artifactDigest?: string | null },
): Pick<SkillCallSplitRecord, 'capability_kind' | 'origin_identity' | '_capabilityConflict'> {
    const origins = context?.capabilityOrigins;
    if (origins === undefined || origins.length === 0) {
        return { capability_kind: null, origin_identity: null, _capabilityConflict: undefined };
    }
    const match: CapabilityOriginMatch = matchCapabilityOrigin(
        origins,
        context?.source ?? '',
        canonicalName,
        observable,
    );
    return {
        capability_kind: match.origin?.capabilityKind ?? null,
        origin_identity: match.origin?.originIdentity ?? null,
        _capabilityConflict: match.conflict ?? undefined,
    };
}

/** Stable version-1 invocation identity for one skill row (precedence: invocation id → call id → record id+ordinal → file/line+ordinal). */
function invocationIdFor(
    context: TransformContext | undefined,
    sessionId: string,
    ref: { invocationId?: string; callId?: string; recordId?: string; ordinal: number },
): string {
    const source = context?.source ?? 'unknown';
    if (ref.invocationId !== undefined) {
        return capabilityInvocationId({ source, sessionId, kind: 'invocation', id: ref.invocationId });
    }
    if (ref.callId !== undefined) {
        return capabilityInvocationId({
            source,
            sessionId,
            kind: 'call',
            id: ref.callId,
            ordinal: ref.ordinal > 0 ? ref.ordinal : undefined,
        });
    }
    if (ref.recordId !== undefined) {
        return capabilityInvocationId({ source, sessionId, kind: 'record', id: ref.recordId, ordinal: ref.ordinal });
    }
    return capabilityInvocationId({
        source,
        sessionId,
        kind: 'line',
        file: context?.sourceFile ?? '',
        line: context?.sourceLine ?? 0,
        ordinal: ref.ordinal,
    });
}

/** Skill name from a `.../skills/<name>/SKILL.md` path; falls back to the SKILL.md sibling. */
function skillNameFromPath(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const bySkillsSegment = normalized.match(/\/skills\/([^/]+)\/SKILL\.md$/i);
    if (bySkillsSegment !== null) return bySkillsSegment[1] ?? '';
    const stem = normalized.slice(0, normalized.length - '/SKILL.md'.length);
    return stem.split('/').pop() ?? stem;
}

function detectClaudeSkillCalls(
    raw: JsonObject,
    identity: SkillCallIdentity,
    context: TransformContext,
): readonly SkillCallSplitRecord[] {
    const contentBlocks = raw.content ?? o(raw.message).content;
    if (!Array.isArray(contentBlocks)) return [];
    const rows: SkillCallSplitRecord[] = [];
    const role = mapRole(raw.type ?? o(raw.message).role);
    const recordId = s(raw.uuid, raw.id, raw.requestId);
    const ts = timestampOf(raw.timestamp, raw.ts, o(raw.message).timestamp) ?? null;
    const ordinal = createOrdinalAllocator();

    // Tool-use blocks: native Skill loads, Task delegations, and implicit SKILL.md reads
    // (Read tool / literal Bash cat/sed command) — each pairable with its tool_result by id.
    for (const block of contentBlocks) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_use') continue;
        const input = (b.input ?? {}) as Record<string, unknown>;
        const callId = s(b.id);
        const invocation =
            callId !== undefined ? { callId, ordinal: 0 } : { recordId, ordinal: ordinal(`tool:${rows.length}`) };

        if (b.name === 'Skill') {
            const skill = s(input.skill);
            if (skill === undefined) continue;
            const canonical = canonicalizeSkillName(skill);
            // caller.type "direct" = user-invoked (storm report §10.3); absence = model-invoked.
            rows.push(
                skillRecord(identity, skill, s(o(b.caller).type) === 'direct' ? 'user' : 'model', {
                    args_raw: maybeArgsRaw('claude', 'Skill', input) ?? null,
                    args_digest: argsDigest(input),
                    call_id: callId ?? null,
                    started_at: ts,
                    evidence_kind: 'load',
                    status: 'unknown',
                    invocation_id: invocationIdFor(context, identity.sessionId, invocation),
                    ...originFields(context, canonical, {}),
                }),
            );
            continue;
        }
        if (b.name === 'Task') {
            // Native delegation record: capability kind established by source identity.
            const subagent = s(input.subagent_type, input.agent_type, input.agent) ?? 'subagent';
            rows.push(
                skillRecord(identity, subagent, 'model', {
                    args_raw: maybeArgsRaw('claude', 'Task', input) ?? null,
                    args_digest: argsDigest(input),
                    call_id: callId ?? null,
                    started_at: ts,
                    ...originFields(context, canonicalizeSkillName(subagent), {}),
                    capability_kind: 'subagent',
                    evidence_kind: 'delegation',
                    status: 'unknown',
                    invocation_id: invocationIdFor(context, identity.sessionId, invocation),
                }),
            );
            continue;
        }
        if (b.name === 'Read') {
            const filePath = s(input.file_path, input.path);
            if (filePath === undefined || lastPathSegmentNorm(filePath) !== 'SKILL.md') continue;
            const canonical = canonicalizeSkillName(skillNameFromPath(filePath));
            rows.push(
                skillRecord(identity, skillNameFromPath(filePath), 'model', {
                    skill_path: filePath,
                    args_raw: maybeArgsRaw('claude', 'Read', input) ?? null,
                    args_digest: argsDigest(input),
                    call_id: callId ?? null,
                    started_at: ts,
                    evidence_kind: 'load',
                    status: 'unknown',
                    invocation_id: invocationIdFor(context, identity.sessionId, invocation),
                    ...originFields(context, canonical, { skillPath: filePath }),
                }),
            );
            continue;
        }
        if (b.name === 'Bash') {
            // Bounded literal grammar only: cat [--] <path...> / sed -n '<range>p' <path>.
            const command = s(input.command);
            if (command === undefined) continue;
            const targets = parseLiteralReadTargets(command);
            for (let i = 0; i < targets.length; i += 1) {
                const target = targets[i] ?? '';
                const canonical = canonicalizeSkillName(skillNameFromPath(target));
                rows.push(
                    skillRecord(identity, skillNameFromPath(target), 'model', {
                        skill_path: target,
                        args_raw: maybeArgsRaw('claude', 'Bash', input) ?? null,
                        args_digest: argsDigest(input),
                        call_id: callId ?? null,
                        started_at: ts,
                        evidence_kind: 'load',
                        status: 'unknown',
                        invocation_id: invocationIdFor(context, identity.sessionId, { ...invocation, ordinal: i }),
                        ...originFields(context, canonical, { skillPath: target }),
                    }),
                );
            }
        }
    }

    // User records: the `<command-name>` expansion envelope is the verified native command
    // activation. Plain user text starting with `/name` is quoted/typed text, not an
    // invocation (false-positive suppression, 0736 R4 — preserved).
    if (role === 'user') {
        const text = extractUserTextClaude(contentBlocks);
        if (text !== undefined) {
            // Only the envelope that STARTS the text is the harness injection; the
            // same shape fenced or quoted mid-text is an example, not a command (E93 R6).
            const envelope = leadingInjectionMatch(text, CLAUDE_COMMAND_NAME_ANCHORED);
            const rawName = envelope?.[1] ?? '';
            if (rawName.length > 0) {
                const canonical = canonicalizeSkillName(rawName);
                if (canonical.length > 0) {
                    rows.push(
                        skillRecord(identity, canonical, 'user', {
                            args_raw: text.match(CLAUDE_COMMAND_ARGS)?.[1]?.trim() || null,
                            started_at: ts,
                            capability_kind: 'command',
                            evidence_kind: 'request',
                            status: 'unknown',
                            invocation_id: invocationIdFor(context, identity.sessionId, {
                                recordId,
                                ordinal: ordinal(`cmd:${canonical}`),
                            }),
                        }),
                    );
                }
            }
        }
    }
    return rows;
}

/** `<command-name>` expansion envelope — claude's verified native command activation. */
const CLAUDE_COMMAND_NAME_ANCHORED = /^<command-name>([^<]+)<\/command-name>/;
const CLAUDE_COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** Concatenate text-block text, skipping tool_result blocks (their text is a result, not user intent). */
function extractUserTextClaude(contentBlocks: readonly unknown[]): string | undefined {
    const parts: string[] = [];
    for (const block of contentBlocks) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_result') continue;
        if (typeof b.text === 'string') parts.push(b.text);
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Final path segment with normalized separators — target-shape check for SKILL.md reads. */
function lastPathSegmentNorm(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/**
 * Quoted-signature context for text-signature matches (E93 §8.2: quoted/fenced
 * wrappers and catalogs are ignored — R6/AC6). A match is quoted when text
 * precedes it on its own line (inline quoting, incl. template literals) or an
 * unclosed code fence (``` / ~~~) opens earlier in the same text. A fence only
 * closes for a run of the same character at least as long as its opener
 * (CommonMark closing-fence rule), so a 4-backtick outer fence is not closed by
 * an inner ``` example fence. Real harness injections start their own text and
 * are never fenced.
 */
function isQuotedSignatureContext(text: string, matchIndex: number): boolean {
    const lineStart = text.lastIndexOf('\n', matchIndex - 1) + 1;
    if (text.slice(lineStart, matchIndex).trim().length > 0) return true;
    let openFence = '';
    for (const line of text.slice(0, lineStart).split('\n')) {
        const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fence === null) continue;
        const run = fence[1] ?? '';
        if (openFence === '') openFence = run;
        else if (run[0] === openFence[0] && run.length >= openFence.length) openFence = '';
    }
    return openFence !== '';
}

/**
 * A line that only introduces a codex skill injection — invocation-marker
 * syntax (`$name …`, `/name …`, or a `- skill: name` bullet) with no prose.
 */
function isCodexMarkerLine(line: string): boolean {
    const trimmed = line.trim();
    return CODEX_DOLLAR_MARKER.test(trimmed) || CODEX_SLASH_MARKER.test(trimmed) || /^-\s+skill:\s*\S+/.test(trimmed);
}

/**
 * Codex wrapper lead position, mirroring the anchored sibling seams: a wrapper
 * block only counts at the text position (after optional leading whitespace),
 * directly below a single invocation-marker line (the codex injection shape),
 * or contiguous with an already-accepted wrapper block (repeat injections).
 * Prose- or code-introduced blocks are quoted examples, not loads.
 */
function isCodexWrapperLeadPosition(text: string, matchIndex: number, chainStart: number | undefined): boolean {
    const before = text.slice(0, matchIndex);
    if (before.trim().length === 0) return true;
    if (chainStart !== undefined && text.slice(chainStart, matchIndex).trim().length === 0) return true;
    const lines = before.split('\n');
    if ((lines[lines.length - 1] ?? '').trim().length > 0) return false;
    if (lines.length < 2) return false;
    return isCodexMarkerLine(lines[lines.length - 2] ?? '');
}

/**
 * First unquoted match of a wrapper-shaped regex anchored at the start of the
 * text (after leading whitespace) — the position real harness injections carry
 * and quoted examples never do. Null when the only matches are quoted.
 */
function leadingInjectionMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
    const trimmed = text.trimStart();
    const offset = text.length - trimmed.length;
    const match = trimmed.match(pattern);
    if (match === null || match.index === undefined) return null;
    if (isQuotedSignatureContext(text, offset + match.index)) return null;
    return match;
}

/** pi injects skills inline: the `<skill name= location=>` wrapper in a user message is the load marker. */
const PI_SKILL_WRAPPER_ANCHORED = /^<skill\s+name="([^"]+)"(?:\s+location="([^"]*)")?\s*>/;

/** pi read-family tool names carrying implicit SKILL.md reads (bounded by verified shapes). */
const READ_FAMILY_TOOLS = new Set(['read', 'read_file', 'view']);

function detectPiSkillCalls(
    raw: JsonObject,
    identity: SkillCallIdentity,
    context: TransformContext,
): readonly SkillCallSplitRecord[] {
    const msg = raw.message as Record<string, unknown> | undefined;
    const role = piRole(msg?.role ?? raw.role ?? raw.recordType ?? raw.type);
    const recordId = s(raw.id, raw.uuid, raw.requestId);
    const ts = timestampOf(raw.timestamp, raw.ts, o(msg).timestamp) ?? null;
    const rows: SkillCallSplitRecord[] = [];
    if (role === 'user') {
        const text = extractContentText(msg?.content ?? raw.content);
        if (text === undefined) return [];
        const ordinal = createOrdinalAllocator();
        // Only the wrapper that STARTS the text is the harness injection; the same
        // shape fenced or quoted mid-text is an example, not a load (E93 R6).
        const wrapper = leadingInjectionMatch(text, PI_SKILL_WRAPPER_ANCHORED);
        if (wrapper !== null) {
            const skillPath = wrapper[2] || null;
            const canonical = canonicalizeSkillName(wrapper[1] ?? '');
            if (canonical.length > 0) {
                rows.push(
                    skillRecord(identity, canonical, 'user', {
                        skill_path: skillPath,
                        started_at: ts,
                        // The wrapper IS the harness injection — a verified (user-invoker) load.
                        evidence_kind: 'load',
                        status: 'ok',
                        invocation_id: invocationIdFor(context, identity.sessionId, {
                            recordId,
                            ordinal: ordinal(`skill:${canonical}`),
                        }),
                        ...originFields(context, canonical, { skillPath }),
                    }),
                );
            }
        }
        return rows;
    }
    if (role === 'assistant') {
        // Implicit ordinary loads: a read-family tool call targeting a SKILL.md path.
        const contentBlocks = msg?.content ?? raw.content;
        if (!Array.isArray(contentBlocks)) return [];
        for (const block of contentBlocks) {
            if (typeof block !== 'object' || block === null) continue;
            const call = normalizeOmpToolCall(block as Record<string, unknown>);
            if (call === null || !READ_FAMILY_TOOLS.has(String(call.name ?? ''))) continue;
            const args = (call.input ?? call.arguments ?? {}) as Record<string, unknown>;
            const filePath = s(args.filePath, args.file_path, args.path, args.target_file);
            if (filePath === undefined || lastPathSegmentNorm(filePath) !== 'SKILL.md') continue;
            const callId = s(call.id);
            const canonical = canonicalizeSkillName(skillNameFromPath(filePath));
            rows.push(
                skillRecord(identity, canonical, 'model', {
                    skill_path: filePath,
                    args_raw: maybeArgsRaw('pi', String(call.name ?? 'read'), args) ?? null,
                    args_digest: argsDigest(args),
                    call_id: callId ?? null,
                    started_at: ts,
                    evidence_kind: 'load',
                    status: 'unknown',
                    invocation_id: invocationIdFor(context, identity.sessionId, {
                        callId,
                        recordId: callId === undefined ? recordId : undefined,
                        ordinal: rows.length,
                    }),
                    ...originFields(context, canonical, { skillPath: filePath }),
                }),
            );
        }
    }
    return rows;
}

function detectOmpSkillCalls(
    raw: JsonObject,
    identity: SkillCallIdentity,
    context: TransformContext,
): readonly SkillCallSplitRecord[] {
    const msg = raw.message as Record<string, unknown> | undefined;
    const role = mapRole(msg?.role ?? raw.type ?? raw.role);
    const recordId = s(raw.id, raw.uuid, raw.requestId);
    const ts = timestampOf(raw.timestamp, raw.ts, o(msg).timestamp) ?? null;
    const rows: SkillCallSplitRecord[] = [];

    if (role === 'assistant') {
        const contentBlocks = msg?.content ?? raw.content;
        if (!Array.isArray(contentBlocks)) return [];
        for (const block of contentBlocks as Record<string, unknown>[]) {
            const call = normalizeOmpToolCall(block);
            if (call === null) continue;
            const input = call.input ?? call.arguments;
            if (call.name === 'Skill') {
                const skill = s((input as Record<string, unknown> | undefined)?.skill);
                if (skill === undefined) continue;
                const callId = s(call.id);
                rows.push(
                    skillRecord(identity, skill, 'model', {
                        args_raw: maybeArgsRaw('omp', 'Skill', input) ?? null,
                        args_digest: argsDigest(input),
                        call_id: callId ?? null,
                        started_at: ts,
                        evidence_kind: 'load',
                        status: 'unknown',
                        invocation_id: invocationIdFor(context, identity.sessionId, {
                            callId,
                            recordId: callId === undefined ? recordId : undefined,
                            ordinal: rows.length,
                        }),
                        ...originFields(context, canonicalizeSkillName(skill), {}),
                    }),
                );
                continue;
            }
            // Implicit ordinary loads: read-family call targeting a SKILL.md path.
            if (READ_FAMILY_TOOLS.has(String(call.name ?? ''))) {
                const args = (input ?? {}) as Record<string, unknown>;
                const filePath = s(args.filePath, args.file_path, args.path, args.target_file);
                if (filePath === undefined || lastPathSegmentNorm(filePath) !== 'SKILL.md') continue;
                const callId = s(call.id);
                const canonical = canonicalizeSkillName(skillNameFromPath(filePath));
                rows.push(
                    skillRecord(identity, canonical, 'model', {
                        skill_path: filePath,
                        args_raw: maybeArgsRaw('omp', String(call.name ?? 'read'), args) ?? null,
                        args_digest: argsDigest(args),
                        call_id: callId ?? null,
                        started_at: ts,
                        evidence_kind: 'load',
                        status: 'unknown',
                        invocation_id: invocationIdFor(context, identity.sessionId, {
                            callId,
                            recordId: callId === undefined ? recordId : undefined,
                            ordinal: rows.length,
                        }),
                        ...originFields(context, canonical, { skillPath: filePath }),
                    }),
                );
            }
        }
        return rows;
    }

    // User wrapper (shared injection protocol with pi): the load marker is NOT ignored
    // solely because omp also has a native Skill tool — signature-driven detection (E93).
    if (role === 'user') {
        const text = extractContentText(msg?.content ?? raw.content);
        if (text === undefined) return [];
        const ordinal = createOrdinalAllocator();
        // Same leading-injection rule as pi: quoted/fenced wrappers are examples (E93 R6).
        const wrapper = leadingInjectionMatch(text, PI_SKILL_WRAPPER_ANCHORED);
        if (wrapper !== null) {
            const skillPath = wrapper[2] || null;
            const canonical = canonicalizeSkillName(wrapper[1] ?? '');
            if (canonical.length > 0) {
                rows.push(
                    skillRecord(identity, canonical, 'user', {
                        skill_path: skillPath,
                        started_at: ts,
                        evidence_kind: 'load',
                        status: 'ok',
                        invocation_id: invocationIdFor(context, identity.sessionId, {
                            recordId,
                            ordinal: ordinal(`skill:${canonical}`),
                        }),
                        ...originFields(context, canonical, { skillPath }),
                    }),
                );
            }
        }
    }
    return rows;
}

/** Codex has no native load tool call: the full-body child-element `<skill>` block is the load marker. */
const CODEX_SKILL_BLOCK = /<skill>\s*<name>([^<]+)<\/name>\s*<path>([^<]+)<\/path>([\s\S]*?)<\/skill>/g;

/** Leading `$name` / `/name` invocation markers — request syntax, not logical identity. */
const CODEX_DOLLAR_MARKER = /^\$([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w./:])/;
const CODEX_SLASH_MARKER = /^\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w./:])/;

/** codex shell tool names accepted by the bounded literal read grammar. */
const CODEX_SHELL_TOOLS = new Set(['shell', 'exec_command', 'exec']);

function detectCodexSkillCalls(
    raw: JsonObject,
    identity: SkillCallIdentity,
    context: TransformContext,
): readonly SkillCallSplitRecord[] {
    const payload = (raw.payload ?? raw) as Record<string, unknown>;
    const recordType = String(raw.type ?? '');
    const payloadType = String(payload.type ?? '');
    let role: string;
    if (recordType === 'response_item') {
        role =
            payloadType === 'message'
                ? mapRole(payload.role)
                : payloadType === 'agent_message'
                  ? 'assistant'
                  : payloadType === 'function_call' || payloadType === 'custom_tool_call'
                    ? 'tool'
                    : 'meta';
    } else if (recordType === 'user' || recordType === 'assistant') {
        role = mapRole(recordType);
    } else if (recordType === 'message') {
        role = mapRole(raw.role ?? payload.role);
    } else {
        return [];
    }

    if (role === 'tool') {
        // Shell-tool reads: bounded literal `cat`/`sed -n` grammar over the call arguments,
        // plus nested `tools.exec_command({cmd: <literal>})` payloads. String-typed
        // arguments are parsed as data (serialized JSON), never regex-split (E93 §8.2).
        const toolName = String(payload.name ?? '');
        if (!CODEX_SHELL_TOOLS.has(toolName) && !toolName.endsWith('.exec')) return [];
        const callId = s(payload.call_id, payload.id);
        const argsText = s(payload.arguments, payload.input);
        if (argsText === undefined) return [];
        const rows: SkillCallSplitRecord[] = [];
        const ts = timestampOf(raw.timestamp, raw.ts, payload.created_at) ?? null;
        let command: string | null = null;
        try {
            const parsed: unknown = JSON.parse(argsText);
            if (typeof parsed === 'object' && parsed !== null) {
                const cmd = (parsed as Record<string, unknown>).command;
                if (typeof cmd === 'string') command = cmd;
                else if (Array.isArray(cmd)) command = cmd.filter((c) => typeof c === 'string').join(' ');
            }
        } catch {
            command = null; // not JSON — treated below as raw payload text for the nested grammar
        }
        const pushRead = (target: string, ordinal: number): void => {
            const canonical = canonicalizeSkillName(skillNameFromPath(target));
            rows.push(
                skillRecord(identity, canonical, 'model', {
                    skill_path: target,
                    args_raw: argsText,
                    args_digest: sha256Text(argsText),
                    call_id: callId ?? null,
                    started_at: ts,
                    evidence_kind: 'load',
                    status: 'unknown',
                    invocation_id: invocationIdFor(context, identity.sessionId, {
                        callId: callId ?? recordIdFallback(raw),
                        ordinal,
                    }),
                    ...originFields(context, canonical, { skillPath: target }),
                }),
            );
        };
        if (command !== null) {
            for (let i = 0; i < parseLiteralReadTargets(command).length; i += 1) {
                pushRead(parseLiteralReadTargets(command)[i] ?? '', i);
            }
        }
        // Nested grammar always applies to the raw payload text (exec bodies may wrap commands).
        const nestedLiterals = extractNestedExecCommandLiterals(argsText);
        let nestedOrdinal = 0;
        for (const literal of nestedLiterals) {
            for (const target of parseLiteralReadTargets(literal)) {
                pushRead(target, 1000 + nestedOrdinal);
                nestedOrdinal += 1;
            }
        }
        return rows;
    }

    if (role !== 'user') return [];
    const text = extractContentText(payload.content ?? raw.content) ?? s(payload.text, raw.text);
    if (text === undefined) return [];
    const rows: SkillCallSplitRecord[] = [];
    const recordId = s(raw.id, payload.id, raw.uuid);
    const ts = timestampOf(raw.timestamp, raw.ts) ?? null;
    const ordinal = createOrdinalAllocator();

    // Full-body wrappers: name + path + injected body. A closed wrapper is a verified
    // complete injection (successful load); the body digest enables origin agreement.
    interface CodexWrapper {
        readonly name: string;
        readonly path: string | null;
        readonly digest: string | null;
    }
    const wrappers: CodexWrapper[] = [];
    let acceptedWrapperEnd: number | undefined;
    for (const match of text.matchAll(CODEX_SKILL_BLOCK)) {
        // Fenced or inline-quoted `<skill>` blocks are transcript examples, not
        // injections (E93 R6); only structurally unquoted, lead-position blocks
        // are loads (see isCodexWrapperLeadPosition for the anchor invariants).
        const start = match.index ?? 0;
        if (isQuotedSignatureContext(text, start)) continue;
        if (!isCodexWrapperLeadPosition(text, start, acceptedWrapperEnd)) continue;
        acceptedWrapperEnd = start + match[0].length;
        const body = (match[3] ?? '').trim();
        const skillPath = match[2] || null;
        wrappers.push({
            name: canonicalizeSkillName(match[1] ?? ''),
            path: skillPath,
            digest: body.length > 0 ? sha256Text(body) : null,
        });
    }
    // Each wrapper block is its own invocation: repeat same-name wrappers get a
    // distinct ordinal (the first keeps the marker-correlation key).
    const wrapperOccurrences = new Map<string, number>();
    for (const wrapper of wrappers) {
        const occurrence = (wrapperOccurrences.get(wrapper.name) ?? 0) + 1;
        wrapperOccurrences.set(wrapper.name, occurrence);
        const ordinalKey = occurrence === 1 ? `skill:${wrapper.name}` : `skill:${wrapper.name}#${occurrence}`;
        rows.push(
            skillRecord(identity, wrapper.name, 'user', {
                skill_path: wrapper.path,
                args_digest: wrapper.digest,
                started_at: ts,
                evidence_kind: 'load',
                status: 'ok',
                invocation_id: invocationIdFor(context, identity.sessionId, {
                    recordId,
                    ordinal: ordinal(ordinalKey),
                }),
                ...originFields(context, wrapper.name, { skillPath: wrapper.path, artifactDigest: wrapper.digest }),
            }),
        );
    }

    // Leading dollar/slash markers: explicit request syntax. Evidence kind is `request`;
    // logical kind stays unknown unless the supplied origin proves it (never from spelling).
    const leadingMarker = text.match(CODEX_DOLLAR_MARKER) ?? text.match(CODEX_SLASH_MARKER);
    if (leadingMarker !== null) {
        const markerName = canonicalizeSkillName(leadingMarker[1] ?? '');
        rows.push(
            skillRecord(identity, markerName, 'user', {
                started_at: ts,
                evidence_kind: 'request',
                status: 'unknown',
                invocation_id: invocationIdFor(context, identity.sessionId, {
                    recordId,
                    ordinal: ordinal(`skill:${markerName}`),
                }),
                ...originFields(context, markerName, {}),
            }),
        );
    }
    return rows;
}

/** Fallback record identity when a codex tool record carries no call id. */
function recordIdFallback(raw: JsonObject): string {
    return s(raw.id, raw.uuid) ?? 'codex-record';
}

/** agy loads skills via `view_file` with toolAction "Viewing skill file" on a SKILL.md path. */
function detectAgySkillCalls(
    raw: JsonObject,
    identity: SkillCallIdentity,
    context: TransformContext,
): readonly SkillCallSplitRecord[] {
    const recordType = String(raw.type ?? '');
    const recordId = s(raw.id, raw.event_id, raw.request_id);
    const ts = timestampOf(raw.created_at, raw.timestamp, raw.ts) ?? null;
    const rows: SkillCallSplitRecord[] = [];

    if (recordType === 'PLANNER_RESPONSE' && Array.isArray(raw.tool_calls)) {
        for (const tc of raw.tool_calls as Record<string, unknown>[]) {
            const tool = s(tc.name, tc.tool_name);

            if (tool === 'view_file') {
                const args = (tc.args ?? tc.arguments ?? {}) as Record<string, unknown>;
                if (args.toolAction !== 'Viewing skill file') continue;
                const path = s(args.AbsolutePath, args.absolute_path);
                if (path === undefined || lastPathSegmentNorm(path) !== 'SKILL.md') continue;
                const summary = s(args.toolSummary);
                const skillName = summary?.match(/SKILL\.md for (.+)$/)?.[1] ?? skillNameFromPath(path);
                const canonical = canonicalizeSkillName(skillName);
                const callId = s(tc.id, tc.call_id);
                rows.push(
                    skillRecord(identity, canonical, 'model', {
                        skill_path: path,
                        args_raw: maybeArgsRaw('agy', 'view_file', args) ?? null,
                        args_digest: argsDigest(args),
                        call_id: callId ?? null,
                        started_at: ts,
                        evidence_kind: 'load',
                        status: 'unknown',
                        invocation_id: invocationIdFor(context, identity.sessionId, {
                            callId,
                            recordId: callId === undefined ? recordId : undefined,
                            ordinal: rows.length,
                        }),
                        ...originFields(context, canonical, { skillPath: path }),
                    }),
                );
                continue;
            }

            // Native delegation record: capability kind established by source identity.
            if (tool === 'INVOKE_SUBAGENT') {
                const args = (tc.args ?? tc.arguments ?? {}) as Record<string, unknown>;
                const subagent =
                    s(args.subagent_type, args.subagent, args.agent_name, args.agent, args.name) ?? 'subagent';
                const callId = s(tc.id, tc.call_id);
                rows.push(
                    skillRecord(identity, subagent, 'model', {
                        args_raw: maybeArgsRaw('agy', 'INVOKE_SUBAGENT', args) ?? null,
                        args_digest: argsDigest(args),
                        call_id: callId ?? null,
                        started_at: ts,
                        ...originFields(context, canonicalizeSkillName(subagent), {}),
                        capability_kind: 'subagent',
                        evidence_kind: 'delegation',
                        status: 'unknown',
                        invocation_id: invocationIdFor(context, identity.sessionId, {
                            callId,
                            recordId: callId === undefined ? recordId : undefined,
                            ordinal: rows.length,
                        }),
                    }),
                );
            }
        }
    }

    // Native slash-command record: the source's own command identity — not marker spelling.
    // Gated on a display payload, which is what guarantees the carrying message entry exists.
    if (recordType === 'slash_command') {
        const display = s(raw.display);
        if (display !== undefined) {
            const commandName = s(raw.command, raw.name) ?? display.match(/(?:^|\s)\/([a-z][a-z0-9:-]*)/)?.[1];
            if (commandName !== undefined) {
                rows.push(
                    skillRecord(identity, canonicalizeSkillName(commandName), 'user', {
                        started_at: ts,
                        capability_kind: 'command',
                        evidence_kind: 'request',
                        status: 'unknown',
                        invocation_id: invocationIdFor(context, identity.sessionId, { recordId, ordinal: 0 }),
                    }),
                );
            }
        }
    }
    return rows;
}

/** Gemini has no verified L1: the L0 harness prefix in a user message is the trigger. */
const GEMINI_L0_PREFIX = /^\s*\/((?:sp|rd3)-[a-z0-9-]+)/;

function detectGeminiSkillCalls(
    raw: JsonObject,
    identity: SkillCallIdentity,
    context: TransformContext,
): readonly SkillCallSplitRecord[] {
    if (String(raw.type ?? '') !== 'user') return [];
    const content = geminiContent(raw);
    if (content === null) return [];
    const match = content.match(GEMINI_L0_PREFIX);
    if (match === null) return [];
    const canonical = canonicalizeSkillName(match[1] ?? '');
    const recordId = s(raw.id, raw.uuid);
    const ts = timestampOf(raw.timestamp, raw.ts) ?? null;
    // Deferred-source limit: no native command/load identity exists — the row is a request
    // with unknown capability kind unless the supplied origin proves it (E93 R7).
    return [
        skillRecord(identity, canonical, 'user', {
            started_at: ts,
            evidence_kind: 'request',
            status: 'unknown',
            invocation_id: invocationIdFor(context, identity.sessionId, { recordId, ordinal: 0 }),
            ...originFields(context, canonical, {}),
        }),
    ];
}

/** grok loads skills via `read_file` (grok_build namespace) targeting a SKILL.md path. */
function detectGrokSkillCalls(
    raw: JsonObject,
    identity: SkillCallIdentity,
    context: TransformContext,
): readonly SkillCallSplitRecord[] {
    const n = normalizeGrokRecord(raw);
    if (n.recordType !== 'tool_call' || n.toolName !== 'read_file') return [];
    const meta = (n.body._meta ?? raw._meta ?? {}) as Record<string, unknown>;
    if (o(meta['x.ai/tool']).namespace !== 'grok_build') return [];
    const targetFile = s(o(n.toolArgs).target_file);
    if (targetFile === undefined || lastPathSegmentNorm(targetFile) !== 'SKILL.md') return [];
    const canonical = canonicalizeSkillName(skillNameFromPath(targetFile));
    const recordId = s(n.body.id, raw.id, raw.uuid);
    const callId = s(n.body.call_id, n.body.itemId, recordId);
    // The record carries the observed outcome inline — ride it; anything unrecognized stays
    // unknown. Read the RAW status (normalizeGrokRecord defaults its toolStatus to 'ok').
    const status = grokOutcomeStatus(typeof n.body.status === 'string' ? n.body.status : undefined);
    return [
        skillRecord(identity, canonical, 'model', {
            skill_path: targetFile,
            args_raw: maybeArgsRaw('grok', 'read_file', n.toolArgs) ?? null,
            args_digest: argsDigest(n.toolArgs),
            call_id: callId ?? null,
            started_at: n.ts ?? null,
            status,
            evidence_kind: 'load',
            invocation_id: invocationIdFor(context, identity.sessionId, { callId, ordinal: 0 }),
            ...originFields(context, canonical, { skillPath: targetFile }),
        }),
    ];
}

/** Map a grok tool outcome string onto the bounded skill status domain. */
function grokOutcomeStatus(toolStatus: string | undefined): 'ok' | 'error' | 'unknown' {
    const value = String(toolStatus ?? '').toLowerCase();
    if (value === 'ok' || value === 'success' || value === 'done' || value === 'completed') return 'ok';
    if (value === 'error' || value === 'failed') return 'error';
    return 'unknown';
}

// ---------------------------------------------------------------------------
// Source-specific helpers
// ---------------------------------------------------------------------------

// Launch provenance (`spur-run` vs `ambient`) is a fact only the import host knows:
// a session is spur-launched iff its (source, session_id) appears in the host's
// run→session mapping (spur: `history_run_session`, tasks 0557/0558). The mapper
// cannot see that, so every row imports as `ambient` and the host corrects mapped
// sessions after import. The old cwd-substring heuristic (path contains `/spur`)
// was deleted — it mislabelled ambient sessions that merely ran inside a spur
// directory (task 0559 R5).

/** Compute args_digest: sha256 of stable-jsonified, key-sorted, redacted args. */
export function argsDigest(args: unknown): string {
    const redacted = redactArgs(args);
    return sha256(redacted);
}

/** Redacted tool args: JSON shape preserved, string leaves possibly elided. */
type RedactedValue = string | number | boolean | null | RedactedValue[] | { [key: string]: RedactedValue };

/**
 * Redact tool arguments for digest: every string leaf gets the same secret
 * replacement the persistence layer applies (task 1131 R1) — no length-based
 * collapse, so two distinct long commands keep distinct digests and a token the
 * shape rules catch never leaks into the digest input.
 */
function redactArgs(args: unknown): RedactedValue {
    if (typeof args === 'string') {
        return applyRules(args);
    }
    if (Array.isArray(args)) return args.map(redactArgs);
    if (args !== null && typeof args === 'object') {
        const result: Record<string, RedactedValue> = {};
        for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
            result[key] = redactArgs(value);
        }
        return result;
    }
    // Non-object JSON leaves (number/boolean/null) pass through unchanged; JSON args
    // never reach here as undefined/bigint/symbol/function.
    return args as RedactedValue;
}

/**
 * Retained tool-call arguments: recognized shell tools keep the extracted plain
 * command (attribution compatibility, capped); every other typed tool call keeps
 * sanitized-but-valid JSON. `args_digest` is computed elsewhere from the unpruned
 * args and is unaffected; secret redaction stays at the persistence `redactRecord`
 * seam (task 0064 R5).
 */
const BASH_COMMAND_MAX_CHARS = 8192;
const GENERIC_ARGS_MAX_CHARS = 8192;

/** Extract the shell command from a bash tool's raw input; undefined when absent. */
function bashCommandOf(args: unknown): string | undefined {
    if (args === null || typeof args !== 'object') return undefined;
    const rec = args as Record<string, unknown>;
    const command = rec.command ?? rec.CommandLine ?? rec.cmd ?? rec.script;
    if (typeof command === 'string') return command;
    if (Array.isArray(command)) return command.map(String).join(' ');
    return undefined;
}

/** Bulky payload keys (normalized) pruned to an omission marker; camelCase and snake_case share one rule. */
const BULKY_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
    'content',
    'codecontent',
    'replacementcontent',
    'targetcontent',
    'filedata',
    'buffer',
    'blob',
    'image',
    'imagebase64',
]);

/** Lowercase a key and drop separators so code_content and codeContent compare equal. */
function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Tool names whose command-shaped args retain the existing plain-string representation. */
function isShellTool(toolName: string): boolean {
    return /^(?:bash|shell|cmd|command|exec|execcommand|executecommand|runcommand|shellcommand|runshellcommand)$/.test(
        normalizeKey(toolName),
    );
}

/** Sanitized tool args: JSON shape preserved, bulky payload strings elided. */
type SanitizedValue = string | number | boolean | null | SanitizedValue[] | { [key: string]: SanitizedValue };

/**
 * Sanitize any JSON value recursively through objects AND arrays: bulky payload
 * strings under known keys become `[omitted N chars]`, other strings longer than
 * 1,000 characters keep a prefix plus an explicit original-length marker, and
 * every primitive and short payload is preserved untouched (task 0064 R2).
 */
function sanitizeValue(value: unknown): SanitizedValue {
    if (typeof value === 'string') {
        return value.length > 1000 ? `${value.slice(0, 1000)}[truncated ${value.length} chars]` : value;
    }
    if (Array.isArray(value)) return value.map(sanitizeValue);
    if (value !== null && typeof value === 'object') {
        const out: Record<string, SanitizedValue> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            out[key] =
                typeof entry === 'string' && entry.length > 120 && BULKY_PAYLOAD_KEYS.has(normalizeKey(key))
                    ? `[omitted ${entry.length} chars]`
                    : sanitizeValue(entry);
        }
        return out;
    }
    // JSON leaves (number/boolean/null) pass through unchanged; JSON args never
    // reach here as undefined/bigint/symbol/function.
    return value as SanitizedValue;
}

/**
 * Serialize sanitized args within the retention ceiling without ever slicing JSON
 * text: values that still serialize past the ceiling collapse into a small valid
 * JSON wrapper carrying `_truncated`, the omitted character count, and a bounded
 * preview reduced until the wrapper itself fits (task 0064 R3/AC4).
 */
function serializeBounded(value: unknown): string {
    const serialized = JSON.stringify(sanitizeValue(value));
    if (serialized.length <= GENERIC_ARGS_MAX_CHARS) return serialized;
    let preview = serialized;
    for (;;) {
        const wrapper = JSON.stringify({
            _truncated: true,
            omittedChars: serialized.length - preview.length,
            preview,
        });
        if (wrapper.length <= GENERIC_ARGS_MAX_CHARS) return wrapper;
        preview = preview.slice(0, preview.length - (wrapper.length - GENERIC_ARGS_MAX_CHARS));
    }
}

/**
 * Return retained raw args for a typed tool call: the shell command string for
 * recognized bash/shell/exec/command tools, sanitized valid JSON otherwise, and
 * undefined when the event carries no invocation arguments.
 */
export function maybeArgsRaw(_source: string, toolName: string, args: unknown): string | undefined {
    if (args === undefined || args === null) return undefined;

    let value = args;
    if (typeof args === 'string') {
        // Pre-stringified arguments (Codex) re-enter the structured path so the
        // retained value parses and prunes like native JSON.
        try {
            value = JSON.parse(args);
        } catch {
            return args.length > BASH_COMMAND_MAX_CHARS ? args.slice(0, BASH_COMMAND_MAX_CHARS) : args;
        }
    }

    if (value !== null && typeof value === 'object') {
        const cmd = bashCommandOf(value);
        if (cmd !== undefined && isShellTool(toolName)) {
            return cmd.length > BASH_COMMAND_MAX_CHARS ? cmd.slice(0, BASH_COMMAND_MAX_CHARS) : cmd;
        }
        return serializeBounded(value);
    }

    // JSON primitives (number/boolean) retain as valid JSON scalars.
    return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Claude mapper
// ---------------------------------------------------------------------------

/** Map a Claude Code JSONL record into one or more ETL split entries. */
export function claudeSplit(raw: Record<string, unknown>, context?: TransformContext): readonly SplitEntry[] {
    const entries: SplitEntry[] = [];
    const sessionId = s(raw.sessionId, raw.conversation_uuid) ?? 'unknown';
    const seq = typeof raw.seq === 'number' ? raw.seq : typeof raw.messageIndex === 'number' ? raw.messageIndex : 0;
    const ts = timestampOf(raw.ts, raw.timestamp, raw.createdAt);
    const role = mapRole(raw.type ?? raw.role);
    const recordType = String(raw.type ?? '');
    const model = s(raw.model, o(raw.message).model);
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
                provenance: 'ambient',
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
                provenance: 'ambient',
            },
        });
        return entries;
    }

    // Main message
    const hasUsage = typeof raw.usage === 'object' && raw.usage !== null;
    const usage = (hasUsage ? raw.usage : o(raw.message).usage) as Record<string, unknown> | undefined;
    const inputTokens = ((raw.inputTokens as number | undefined) ?? usage?.input_tokens) as number | undefined;
    const outputTokens = ((raw.outputTokens as number | undefined) ?? usage?.output_tokens) as number | undefined;
    const cacheRead = (usage?.cacheReadTokens ?? usage?.cache_read_tokens ?? usage?.cache_read_input_tokens) as
        | number
        | undefined;
    const cacheWrite = (usage?.cacheWriteTokens ?? usage?.cache_write_tokens ?? usage?.cache_creation_input_tokens) as
        | number
        | undefined;
    const costUsd = computeCost(inputTokens, outputTokens, model);
    const contentBlocks = raw.content ?? o(raw.message).content;
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
            provenance: 'ambient',
            request_id: s(raw.requestId) ?? null,
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
                        call_id: s(b.id),
                        tool_name: String(b.name ?? ''),
                        args_digest: argsDigest(b.input),
                        args_raw: maybeArgsRaw('claude', String(b.name ?? ''), b.input),
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

    // Skill-load rows (0736): claude's L1 is the native Skill tool_use; L0/L2 never trigger.
    for (const record of extractSkillCalls(raw, context, { sessionId, seq, messageSplitIndex })) {
        entries.push(skillCallEntry(record));
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Pi mapper
// ---------------------------------------------------------------------------

/** Map a Pi JSONL record into one or more ETL split entries. */
export function piSplit(raw: Record<string, unknown>, context?: TransformContext): readonly SplitEntry[] {
    // Pi session files are top-level event envelopes: `{type, id, parentId, timestamp,
    // message: {role, content, model, usage, provider, ...}}`. Newer records carry `recordType`
    // instead of `type` with `role`/`text` at the top level. The top-level `id` is an event id,
    // never a session id; the session key and sequence come from the source file (context).
    const msg = raw.message as Record<string, unknown> | undefined;
    const recordType = String(raw.type ?? raw.recordType ?? '');
    const sessionId = sessionIdFromContext(context, raw);
    const seq = context?.sourceLine ?? (typeof raw.seq === 'number' ? raw.seq : 0);
    // Prefer the ISO `timestamp`; numeric epoch values are converted (task 0580 R6), never
    // stringified, and a missing ts persists as null rather than a 1970 sentinel (D4).
    const ts = timestampOf(raw.timestamp, raw.createdAt, raw.ts);

    // Meta lifecycle/custom records collapse to one meta row keyed by the source session,
    // never the unique event id, and never a guessed role.
    if (
        recordType === 'title' ||
        recordType === 'title_change' ||
        recordType === 'service_tier_change' ||
        recordType === 'session_info' ||
        recordType === 'ttsr_injection' ||
        recordType === 'session_init' ||
        recordType === 'session' ||
        recordType === 'model_change' ||
        recordType === 'thinking_level_change' ||
        recordType === 'compaction' ||
        recordType === 'custom' ||
        recordType === 'custom_message' ||
        recordType.startsWith('custom.')
    ) {
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
                    provenance: 'ambient',
                },
            },
        ];
    }

    const entries: SplitEntry[] = [];
    const role = piRole(msg?.role ?? raw.role ?? recordType);
    const model = s(raw.model, o(msg).model);
    const cwd = s(raw.cwd, raw.dir);
    const usage = (msg?.usage ?? raw.usage) as Record<string, unknown> | undefined;
    const inputTokens = (usage?.input ?? usage?.input_tokens ?? undefined) as number | undefined;
    const outputTokens = (usage?.output ?? usage?.output_tokens ?? undefined) as number | undefined;
    const cacheRead = (usage?.cacheRead ?? usage?.cache_read_tokens ?? undefined) as number | undefined;
    const cacheWrite = (usage?.cacheWrite ?? usage?.cache_write_tokens ?? undefined) as number | undefined;
    const costObj = (msg?.cost ?? raw.cost) as Record<string, unknown> | undefined;
    const costUsd = typeof costObj?.total === 'number' ? costObj.total : computeCost(inputTokens, outputTokens, model);
    const contentBlocks = msg?.content ?? raw.content;
    const durationMs = typeof msg?.duration === 'number' && Number.isFinite(msg.duration) ? msg.duration : undefined;

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
            duration_ms: durationMs,
            model: model ?? null,
            input_tokens: inputTokens ?? null,
            output_tokens: outputTokens ?? null,
            cache_read_tokens: cacheRead ?? null,
            cache_write_tokens: cacheWrite ?? null,
            cost_usd: costUsd ?? null,
            content_text: extractContentText(contentBlocks) ?? s(raw.content, raw.text, msg?.content) ?? null,
            cwd: cwd ?? null,
            provenance: 'ambient',
        },
    });

    // Tool calls from content blocks in assistant messages. normalizeOmpToolCall handles both
    // the legacy nested `{toolCall: {...}}` block and pi's flat `{type: "toolCall", id, name,
    // arguments}` block.
    if (Array.isArray(contentBlocks) && role === 'assistant') {
        for (const block of contentBlocks as Record<string, unknown>[]) {
            const call = normalizeOmpToolCall(block);
            if (call === null) continue;
            entries.push({
                targetTable: 'history_tool_call',
                record: {
                    _messageSplitIndex: messageSplitIndex,
                    session_id: sessionId,
                    seq,
                    tool_name: String(call.name ?? ''),
                    // The tool's own call id is the exact join key a toolResult's `toolCallId`
                    // matches (see ompSplit / task 0564 R1).
                    call_id: s(call.id),
                    args_digest: argsDigest(call.input ?? call.arguments),
                    args_raw: maybeArgsRaw('pi', String(call.name ?? ''), call.input ?? call.arguments),
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

    // Skill-load rows (0736): pi is inline-only — the user-message wrapper is the sole trigger.
    for (const record of extractSkillCalls(raw, context, { sessionId, seq, messageSplitIndex })) {
        entries.push(skillCallEntry(record));
    }

    return entries;
}

/**
 * Canonicalize a pi message role. pi tool results and bash executions ride user turns (Claude
 * protocol shape); everything unrecognized clamps to `unknown` so pi record types never leak
 * into the role column (task 0577 AC2).
 */
function piRole(type: unknown): string {
    const t = String(type ?? '').toLowerCase();
    if (t === 'toolresult' || t === 'tool_result' || t === 'bashexecution' || t === 'tool') return 'user';
    const mapped = mapRole(t);
    if (mapped === 'user' || mapped === 'assistant' || mapped === 'system') return mapped;
    return 'unknown';
}

// ---------------------------------------------------------------------------
// OMP mapper (near-identical to pi)
// ---------------------------------------------------------------------------

/** Map an OMP JSONL record into one or more ETL split entries. */
export function ompSplit(raw: Record<string, unknown>, context?: TransformContext): readonly SplitEntry[] {
    // Current OMP files are top-level event envelopes: `{type: "message", id, timestamp, parentId,
    // message: {role, content, model, usage, cost, duration, ...}}`. The unique top-level `id` is
    // an event id, never a session id; the session key and sequence come from the source file
    // (context) when available. The legacy direct shape keeps role/type/content at the top level.
    const msg = raw.message as Record<string, unknown> | undefined;
    const recordType = String(raw.type ?? '');
    const sessionId = sessionIdFromContext(context, raw);
    const seq = context?.sourceLine ?? (typeof raw.seq === 'number' ? raw.seq : 0);
    const ts = timestampOf(raw.ts, raw.timestamp, raw.createdAt);

    // Meta lifecycle/custom records — including the current `custom.*` events and non-message
    // lifecycle types — collapse to one meta row keyed by the source session, never the unique
    // event id, and never a guessed role.
    if (
        recordType === 'title' ||
        recordType === 'title_change' ||
        recordType === 'service_tier_change' ||
        recordType === 'ttsr_injection' ||
        recordType === 'session_init' ||
        recordType === 'session' ||
        recordType === 'model_change' ||
        recordType === 'thinking_level_change' ||
        recordType === 'compaction' ||
        recordType === 'custom' ||
        recordType === 'custom_message' ||
        recordType.startsWith('custom.')
    ) {
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
                    provenance: 'ambient',
                },
            },
        ];
    }

    const entries: SplitEntry[] = [];
    const role = mapRole(msg?.role ?? raw.type ?? raw.role);
    const model = s(raw.model, o(msg).model);
    const cwd = s(raw.cwd, raw.dir);
    const usage = (msg?.usage ?? raw.usage) as Record<string, unknown> | undefined;
    const inputTokens = (usage?.input ?? usage?.input_tokens ?? undefined) as number | undefined;
    const outputTokens = (usage?.output ?? usage?.output_tokens ?? undefined) as number | undefined;
    const cacheRead = (usage?.cacheRead ?? usage?.cache_read_tokens ?? undefined) as number | undefined;
    const cacheWrite = (usage?.cacheWrite ?? usage?.cache_write_tokens ?? undefined) as number | undefined;
    const costObj = (msg?.cost ?? raw.cost) as Record<string, unknown> | undefined;
    const costUsd = typeof costObj?.total === 'number' ? costObj.total : computeCost(inputTokens, outputTokens, model);
    const contentBlocks = msg?.content ?? raw.content;
    const durationMs = typeof msg?.duration === 'number' && Number.isFinite(msg.duration) ? msg.duration : undefined;

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
            duration_ms: durationMs,
            model: model ?? null,
            input_tokens: inputTokens ?? null,
            output_tokens: outputTokens ?? null,
            cache_read_tokens: cacheRead ?? null,
            cache_write_tokens: cacheWrite ?? null,
            cost_usd: costUsd ?? null,
            content_text: extractContentText(contentBlocks) ?? s(raw.content, raw.text, msg?.content) ?? null,
            cwd: cwd ?? null,
            provenance: 'ambient',
        },
    });

    if (Array.isArray(contentBlocks) && role === 'assistant') {
        for (const block of contentBlocks as Record<string, unknown>[]) {
            const call = normalizeOmpToolCall(block);
            if (call === null) continue;
            entries.push({
                targetTable: 'history_tool_call',
                record: {
                    _messageSplitIndex: messageSplitIndex,
                    session_id: sessionId,
                    seq,
                    tool_name: String(call.name ?? ''),
                    // Task 0564 R1: the tool's own call id is the exact join key a
                    // toolResult's `toolCallId` matches — it lets the streaming loop
                    // attach the tool's measured duration to the right row.
                    call_id: s(call.id),
                    args_digest: argsDigest(call.input ?? call.arguments),
                    args_raw: maybeArgsRaw('omp', String(call.name ?? ''), call.input ?? call.arguments),
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

    // Skill-load rows (0736): omp's L1 is the native Skill toolCall; the L2 wrapper never triggers.
    for (const record of extractSkillCalls(raw, context, { sessionId, seq, messageSplitIndex })) {
        entries.push(skillCallEntry(record));
    }

    return entries;
}

/**
 * Normalize an OMP assistant content block to a tool-call object, or null when the block is not a
 * call. Supports both the legacy nested `{toolCall: {...}}` block and the current flat
 * `{type: "toolCall", id, name, arguments}` block. Exactly one history_tool_call row is emitted
 * per call block.
 */
function normalizeOmpToolCall(block: Record<string, unknown>): Record<string, unknown> | null {
    if (typeof block !== 'object' || block === null) return null;
    const nested = o(block.toolCall);
    if (Object.keys(nested).length > 0) return nested;
    if (block.type === 'toolCall') return block;
    return null;
}

// ---------------------------------------------------------------------------
// OMP toolResult timing signals (task 0564 R1)
// ---------------------------------------------------------------------------

/** Timing signals carried by an OMP toolResult message envelope (task 0564 R1). */
export interface OmpToolResultTiming {
    /** The toolCall id this result answers — joins `toolCall.id` exactly. */
    toolCallId: string;
    /** True when the result envelope carries isError (E93 1028 skill pairing). */
    isError: boolean;
    /** The tool's own measured wall time in ms, when present and finite. */
    wallTimeMs: number | undefined;
    /** Message timestamp as epoch millis, when parseable. */
    timestampMs: number | undefined;
    /** Native start bound from pi `details.toolMetadata.startedAt` (task 1131 R2). */
    startedAtMs: number | undefined;
    /** Native completion bound from pi `details.toolMetadata.completedAt` (task 1131 R2). */
    completedAtMs: number | undefined;
}

/** Parse a message timestamp (epoch-millis number, numeric string, or ISO) to epoch millis. */
export function timestampToEpochMs(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length > 0) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return undefined;
}

/**
 * Extract toolResult timing signals from a raw OMP or pi record (task 0564 R1,
 * generalized for pi in task 1131 R2), or null when the record is not a
 * toolResult message or carries no toolCallId. Both sources emit
 * `role: "toolResult"` message envelopes with `{toolCallId, toolName, content,
 * details, isError, timestamp}`; the tool's own wall time resolves from
 * `details.wallTimeMs`, falling back to pi's `message.durationMs` and
 * `details.toolMetadata.durationMs`, and `toolCallId` joins the originating
 * `toolCall.id` exactly.
 */
export function ompToolResultTiming(raw: Record<string, unknown>): OmpToolResultTiming | null {
    const msg = o(raw.message);
    if (String(msg.role ?? '').toLowerCase() !== 'toolresult') return null;
    const toolCallId = s(msg.toolCallId);
    if (toolCallId === undefined) return null;
    const details = o(msg.details);
    const toolMetadata = o(details.toolMetadata);
    const finite = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    return {
        toolCallId,
        isError: msg.isError === true,
        wallTimeMs: finite(details.wallTimeMs) ?? finite(msg.durationMs) ?? finite(toolMetadata.durationMs),
        timestampMs: timestampToEpochMs(raw.timestamp ?? msg.timestamp),
        startedAtMs: timestampToEpochMs(toolMetadata.startedAt),
        completedAtMs: timestampToEpochMs(toolMetadata.completedAt),
    };
}

// ---------------------------------------------------------------------------
// Claude toolResult signals (task 0624 R2)
// ---------------------------------------------------------------------------

/** Signals carried by a Claude tool_result user line (task 0624 R2). */
export interface ClaudeToolResultTiming {
    /** The `toolu_…` id from the answered tool_use block — joins `tool_use.id` exactly. */
    toolCallId: string;
    /** True when the tool_result block carries is_error (E93 1028 skill pairing). */
    isError: boolean;
    /** Message timestamp as epoch millis, when parseable. */
    timestampMs: number | undefined;
    /** Native tool duration, when Claude Code emits one. */
    durationMs: number | undefined;
    /** Serialized size in bytes of the tool result payload. */
    resultBytes: number;
}

/**
 * Extract tool_result signals from a raw Claude Code record (task 0624 R2), or
 * null when the record carries no tool_result block. Claude Code emits
 * `type: "user"` lines whose `message.content` holds `{type: "tool_result",
 * tool_use_id, content}` blocks; the top-level `toolUseResult` carries the raw
 * envelope. `resultBytes` prefers the model-visible block content and falls
 * back to `toolUseResult`; both are null-safe. Some tool results carry a native
 * `durationMs` or `durationSeconds`; absent timing stays unmeasured.
 */
export function claudeToolResultTiming(raw: Record<string, unknown>): ClaudeToolResultTiming | null {
    const content = o(raw.message).content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result') continue;
        const toolCallId = s(b.tool_use_id);
        if (toolCallId === undefined) continue;
        const payload = b.content ?? raw.toolUseResult;
        const toolUseResult = o(raw.toolUseResult);
        const rawDurationMs =
            typeof toolUseResult.durationMs === 'number'
                ? toolUseResult.durationMs
                : typeof toolUseResult.durationSeconds === 'number'
                  ? toolUseResult.durationSeconds * 1_000
                  : undefined;
        // Guard the converted value, not the source: a huge durationSeconds can
        // overflow to Infinity on the * 1_000 (finite check on it alone misses it).
        const durationMs =
            typeof rawDurationMs === 'number' && Number.isFinite(rawDurationMs) ? Math.round(rawDurationMs) : undefined;
        const resultBytes = JSON.stringify(payload ?? null)?.length ?? 2;
        return {
            toolCallId,
            isError: b.is_error === true,
            timestampMs: timestampToEpochMs(raw.timestamp),
            durationMs,
            resultBytes,
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Codex mapper
// ---------------------------------------------------------------------------

/** Map a Codex JSONL record into one or more ETL split entries. */
export function codexSplit(raw: Record<string, unknown>, context?: TransformContext): readonly SplitEntry[] {
    const entries: SplitEntry[] = [];

    const payload = (raw.payload ?? raw) as Record<string, unknown>;
    const seq = typeof raw.seq === 'number' ? raw.seq : 0;
    const ts = timestampOf(raw.timestamp, raw.ts, payload.ts);
    const recordType = String(raw.type ?? '');
    const payloadType = String(payload.type ?? '');

    const isShortFormat =
        recordType === '' && raw.id !== undefined && raw.timestamp !== undefined && raw.instructions !== undefined;

    let explicitSessionId = s(raw.session_id, o(raw.session_meta).id);
    if (explicitSessionId === undefined && recordType === 'session_meta') {
        explicitSessionId = s(payload.id, o(raw.payload).id);
    }
    if (explicitSessionId === undefined && isShortFormat) {
        explicitSessionId = s(raw.id);
    }
    const pathSessionId = context?.sourceFile ? sessionIdFromSourcePath('codex', context.sourceFile) : undefined;
    const sessionId = explicitSessionId ?? pathSessionId ?? 'unknown';

    // Check for older short format
    if (isShortFormat) {
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

    // Codex JSONL is a transport envelope: the top-level `type` (response_item / event_msg /
    // turn_context / ...) is bookkeeping, never a role. Real roles live in
    // `payload.role` for response_item message items (task 0580 D1: passing recordType to
    // mapRole leaked 153k response_item / 91k event_msg rows into the role column).
    let role: string;
    let disposition: string;
    let contentText: string | null;
    let usage: Record<string, unknown> | undefined;
    if (recordType === 'response_item') {
        if (payloadType === 'message') {
            role = mapRole(payload.role);
            disposition = 'keep';
            contentText = extractContentText(payload.content) ?? s(payload.text) ?? null;
        } else if (payloadType === 'agent_message') {
            role = 'assistant';
            disposition = 'keep';
            contentText = extractContentText(payload.content) ?? s(payload.text, payload.message) ?? null;
        } else if (payloadType === 'reasoning') {
            role = 'assistant';
            disposition = 'keep';
            contentText = extractContentText(payload.summary) ?? s(payload.text) ?? null;
        } else if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
            role = 'tool';
            disposition = 'keep';
            contentText = null;
        } else {
            role = 'meta';
            disposition = 'meta';
            contentText = s(payload.text) ?? null;
        }
    } else if (recordType === 'user' || recordType === 'assistant') {
        // Legacy (pre-rollout) envelope: top-level type carried the role directly.
        role = mapRole(recordType);
        disposition = 'keep';
        contentText = extractContentText(payload.content) ?? s(raw.content, payload.text) ?? null;
    } else if (recordType === 'message') {
        role = mapRole(raw.role ?? payload.role);
        disposition = 'keep';
        contentText = extractContentText(payload.content ?? raw.content) ?? s(payload.text, raw.text) ?? null;
    } else if (recordType === 'event_msg') {
        role = 'meta';
        disposition = 'meta';
        contentText = s(payload.message, payload.text) ?? null;
        // Per-turn usage lives on token_count transport events (task 0580 R2): real files
        // carry `payload.info.last_token_usage`; the legacy `payload.token_count` path is kept.
        usage = o(o(payload.info).last_token_usage);
    } else {
        role = 'meta';
        disposition = 'meta';
        contentText = s(payload.text, raw.instructions) ?? null;
    }

    const model = s(raw.model, payload.model, o(o(raw.turn_context).payload).model);
    const cwd = s(raw.cwd, raw.dir);

    const tokenCount = payload.token_count as Record<string, unknown> | undefined;
    const usageInput = (usage?.input_tokens ?? tokenCount?.input ?? tokenCount?.input_tokens ?? undefined) as
        | number
        | undefined;
    const usageOutput = (usage?.output_tokens ?? tokenCount?.output ?? tokenCount?.output_tokens ?? undefined) as
        | number
        | undefined;
    const cacheRead = (usage?.cached_input_tokens ?? undefined) as number | undefined;

    const turnCtx = raw.turn_context as Record<string, unknown> | undefined;
    const turnPayload = turnCtx?.payload as Record<string, unknown> | undefined;
    const turnInputTokens = turnPayload?.input_tokens as number | undefined;
    const turnOutputTokens = turnPayload?.output_tokens as number | undefined;

    const finalInput = usageInput !== undefined ? usageInput : turnInputTokens;
    const finalOutput = usageOutput !== undefined ? usageOutput : turnOutputTokens;
    const costUsd = computeCost(finalInput, finalOutput, model);

    // 0678 R3: token_count events ride their OWN meta row, which never counted toward
    // step-level usage (0 of 53,406 assistant rows with usage while the source total
    // reached billions). Strip the numbers off the meta row and carry them as an
    // internal tag: the importer attributes them to the most recent assistant message
    // of the same session — that is where the usage was generated.
    const usageCarrier =
        finalInput !== undefined || finalOutput !== undefined
            ? { input: finalInput ?? null, output: finalOutput ?? null, cacheRead: cacheRead ?? null }
            : undefined;
    const stripUsage = role === 'meta' && usageCarrier !== undefined;

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
            model: model ?? null,
            input_tokens: stripUsage ? null : (finalInput ?? null),
            output_tokens: stripUsage ? null : (finalOutput ?? null),
            cache_read_tokens: stripUsage ? null : (cacheRead ?? null),
            ...(usageCarrier !== undefined ? { _codexUsageCarrier: usageCarrier } : {}),
            cache_write_tokens: null,
            cost_usd: costUsd ?? null,
            content_text: contentText,
            cwd: cwd ?? null,
            provenance: 'ambient',
        },
    });

    // Tool calls. Live rollouts emit each call as its own response_item whose payload IS the
    // item (`payload.type === "function_call" | "custom_tool_call"`, name/call_id/arguments or
    // input at payload level); the legacy nested `payload.response_item[_s]` shape is kept.
    const toolItems: Record<string, unknown>[] = [];
    if (
        (recordType === 'response_item' || recordType === 'function_call' || recordType === 'custom_tool_call') &&
        (payloadType === 'function_call' || payloadType === 'custom_tool_call')
    ) {
        toolItems.push(payload);
    } else if (payload.response_item) {
        toolItems.push(payload.response_item as Record<string, unknown>);
    } else if (Array.isArray(payload.response_items)) {
        toolItems.push(...(payload.response_items as Record<string, unknown>[]));
    }
    for (const item of toolItems) {
        const fc = (item.function_call as Record<string, unknown> | undefined) ?? item;
        const toolName = s(fc.name) ?? '';
        const args = fc.arguments ?? fc.input;
        entries.push({
            targetTable: 'history_tool_call',
            record: {
                _messageSplitIndex: messageSplitIndex,
                session_id: sessionId,
                seq,
                tool_name: toolName,
                call_id: s(fc.call_id),
                args_digest: argsDigest(args),
                args_raw: maybeArgsRaw('codex', toolName, args),
                status: 'ok',
                started_at: undefined,
                completed_at: undefined,
                duration_ms: undefined,
                result_bytes: undefined,
                error_text: undefined,
            },
        });
    }

    // Skill-load rows (0736): codex has no native load call — the child-element block is the trigger.
    for (const record of extractSkillCalls(raw, context, { sessionId, seq, messageSplitIndex })) {
        entries.push(skillCallEntry(record));
    }

    return entries;
}

// ---------------------------------------------------------------------------
// AGY mapper (Antigravity CLI)
// ---------------------------------------------------------------------------

/** Map an Antigravity (AGY) JSONL record into one or more ETL split entries. */
export function agySplit(raw: Record<string, unknown>, context?: TransformContext): readonly SplitEntry[] {
    const entries: SplitEntry[] = [];
    const recordType = String(raw.type ?? '');
    const explicitSessionId = s(raw.session_id, raw.conversation_id, raw.conversationId);
    const pathSessionId = context?.sourceFile ? sessionIdFromSourcePath('agy', context.sourceFile) : undefined;
    const sessionId = explicitSessionId ?? pathSessionId ?? 'unknown';
    const seq =
        typeof raw.seq === 'number'
            ? raw.seq
            : typeof raw.step_index === 'number'
              ? raw.step_index
              : (context?.sourceLine ?? 0);
    const ts = timestampOf(raw.created_at, raw.timestamp, raw.ts);

    let role: string;
    let disposition: string;
    let contentText: string | null = null;
    let messageRecordType = recordType;

    // history.jsonl prompt index: {display, timestamp, workspace, conversationId?, type?}.
    // One branch covers absent type, 'slash_command', 'shell', and any future producer type.
    // `display` never appears on legacy brain transcripts, so this cannot collide with 0463.
    if (raw.display !== undefined) {
        role = 'user';
        disposition = 'keep';
        contentText = s(raw.display) ?? null;
        messageRecordType = recordType.length > 0 ? recordType : 'USER_INPUT';
    } else {
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
    }

    const messageSplitIndex = entries.length;

    entries.push({
        targetTable: 'history_message',
        record: {
            session_id: sessionId,
            seq,
            role,
            record_type: messageRecordType,
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
            cwd: s(raw.workspace, raw.cwd) ?? null,
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
                    args_raw: maybeArgsRaw('agy', String(tc.name ?? tc.tool_name ?? ''), tc.input ?? tc.arguments),
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

    // Skill-load rows (0736): agy's L1 is the view_file "Viewing skill file" tool call.
    for (const record of extractSkillCalls(raw, context, { sessionId, seq, messageSplitIndex })) {
        entries.push(skillCallEntry(record));
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
    const ts = timestampOf(raw.timestamp, raw.startTime, raw.lastUpdated, state.lastUpdated);

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
                    provenance: 'ambient',
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
                provenance: 'ambient',
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
                    args_raw: maybeArgsRaw('gemini', s(tool.name, tool.displayName) ?? '', tool.args),
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

    // Skill-load rows (0736): gemini has no verified L1 — the L0 prefix in a user message triggers.
    // messageSplitIndex stays the literal 0, matching the gemini tool-call linkage above.
    for (const record of extractSkillCalls(raw, context, { sessionId, seq, messageSplitIndex: 0 })) {
        entries.push(skillCallEntry(record));
    }

    return entries;
}

// ---------------------------------------------------------------------------
// DeepSeek dsh mapper (task 0067)
// ---------------------------------------------------------------------------

/**
 * Map one DeepSeek dsh `session.v3.jsonl` line into forensic ETL entries (task 0067 R2).
 *
 * dsh layout: line 1 is the session header `{type:"session", version:3, id, createdAt, cwd, ...}` and is
 * persisted as one `history_message` metadata row (role/disposition `meta`) carrying session
 * identity, cwd and creation time;
 *
 * any remaining lines are append-only events `{type, seq, time, data}` whose
 * vocabulary is plugin-extensible. Only chat events (`user/message`,
 * `assistant/message`) become conversational `keep` rows (content is an array of
 * `{text}` blocks — the existing extractContentText joined-text rule); every
 * unrecognized event type (compaction/*, hook/*, turn/*, session/title, …) is
 * tolerated and skipped, and torn crash tails never reach the mapper because
 * the source registers `corruptLinePolicy: 'skip'`. Session identity comes from
 * the `session-<uuid>` dir path (stateless — message events carry no session id),
 * mirroring the agy/codex path-identity precedent.
 */
export function dshSplit(raw: Record<string, unknown>, context?: TransformContext): readonly SplitEntry[] {
    const recordType = String(raw.type ?? '');

    // Session header: bookkeeping meta row carrying cwd/createdAt for the session.
    if (recordType === 'session') {
        const sessionId = s(raw.id) ?? sessionIdFromSourcePath('deepseek', context?.sourceFile ?? '') ?? 'unknown';
        return [
            {
                targetTable: 'history_message',
                record: {
                    session_id: sessionId,
                    seq: 0,
                    role: 'meta',
                    record_type: 'session',
                    disposition: 'meta',
                    ts: timestampOf(raw.createdAt),
                    cwd: s(raw.cwd) ?? null,
                    content_text: null,
                    provenance: 'ambient',
                },
            },
        ];
    }

    // Chat events only — unknown plugin-extensible types are dropped, not records.
    if (recordType !== 'user/message' && recordType !== 'assistant/message') return [];

    const data = o(raw.data);
    const msg = o(data.message);
    const seq = typeof raw.seq === 'number' ? raw.seq : (context?.sourceLine ?? 0);
    const sessionId = sessionIdFromSourcePath('deepseek', context?.sourceFile ?? '') ?? 'unknown';
    const role = recordType === 'user/message' ? 'user' : 'assistant';
    const source = o(data.source ?? msg.source);
    const model = s(source.model, o(data.model ?? msg.model).model);
    const usage = (data.usage ?? msg.usage) as Record<string, unknown> | undefined;
    // Task 0067 R2: the message id is the record identity — it rides the normalized
    // record into the record_hash, so identity derives from `data.message.id` when
    // present and falls back to the importer's line-derived record hash when absent.
    const messageId = s(msg.id, data.id);

    return [
        {
            targetTable: 'history_message',
            record: {
                session_id: sessionId,
                seq,
                role,
                record_type: recordType,
                disposition: 'keep',
                ...(messageId !== undefined ? { source_record_id: messageId } : {}),
                ts: timestampOf(raw.time, data.time, msg.time),
                duration_ms: null,
                model: model ?? null,
                input_tokens: numberOrNull(usage?.input_tokens ?? usage?.input) ?? null,
                output_tokens: numberOrNull(usage?.output_tokens ?? usage?.output) ?? null,
                cache_read_tokens: null,
                cache_write_tokens: null,
                cost_usd: null,
                content_text: extractContentText(data.content ?? msg.content) ?? s(data.text, msg.text) ?? null,
                cwd: null,
                provenance: 'ambient',
            },
        },
    ];
}

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const AGY_BRAIN_REGEX = new RegExp(`(?:^|\\/)brain\\/(${UUID_PATTERN})(?:\\/|$)`, 'i');
/** DSH session-dir identity: `<normalized-abs-cwd>--/session-<uuid>/`. */
const DSH_SESSION_REGEX = new RegExp(`(?:^|\\/)session-(${UUID_PATTERN})(?:\\/|$)`, 'i');
const CODEX_ROLLOUT_REGEX = new RegExp(`(?:^|-|_)(${UUID_PATTERN})$`, 'i');

/**
 * Pure helper extracting canonical session identity from source transcript paths (task 0638 R4).
 *
 * Normalizes POSIX/Windows separators and returns only valid UUID-shaped identifiers:
 * - agy: segment immediately following `/brain/`
 * - codex: trailing UUID before `.jsonl` in a filename beginning with `rollout-`
 */
export function sessionIdFromSourcePath(source: string, sourceFile: string): string | undefined {
    const normalized = sourceFile.replace(/\\/g, '/');
    const sLower = source.toLowerCase();
    if (sLower === 'agy' || sLower === 'antigravity') {
        const match = normalized.match(AGY_BRAIN_REGEX);
        return match?.[1];
    }
    if (sLower === 'deepseek') {
        const match = normalized.match(DSH_SESSION_REGEX);
        return match?.[1];
    }
    if (sLower === 'codex') {
        const basename = normalized.split('/').at(-1) ?? '';
        if (basename.startsWith('rollout-') && basename.endsWith('.jsonl')) {
            const stem = basename.slice(0, -6);
            const match = stem.match(CODEX_ROLLOUT_REGEX);
            return match?.[1];
        }
    }
    return undefined;
}

function sessionIdFromContext(context: TransformContext | undefined, raw: Record<string, unknown>): string {
    if (context !== undefined) {
        const file = context.sourceFile.split('/').at(-1);
        if (file !== undefined) return file.replace(/\.jsonl$/, '');
    }
    return s(raw.sessionId, raw.id) ?? 'unknown';
}

function geminiContent(raw: Record<string, unknown>): string | null {
    const content = extractContentText(raw.content) ?? s(raw.text);
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
    ts: string | undefined;
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
    // The tool's real name is `_meta["x.ai/tool"].name` (or `kind`); `title` is a human label
    // like "Read `/path`" — used only as a last resort, stripped at the first backtick so the
    // argument payload never pollutes tool_name (task 0580 D3).
    const titleFallback = s(body.title)?.split('`')[0]?.trim();
    const toolName =
        s(toolMeta?.name, body.kind, body.tool_name, body.name, raw.tool_name, raw.name) ??
        (titleFallback !== undefined && titleFallback.length > 0 && titleFallback.length <= 40 ? titleFallback : '');
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

function normalizeTs(value: unknown): string | undefined {
    return timestampOf(value);
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
export function grokSplit(raw: Record<string, unknown>, context?: TransformContext): readonly SplitEntry[] {
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
                // 0678 R2: the producer measures API latency itself — mapping is honest
                // signal, not synthesis from adjacent timestamps.
                duration_ms: n.durationMs ?? usage?.apiDurationMs ?? null,
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
                args_raw: maybeArgsRaw('grok', n.toolName, n.toolArgs),
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
                args_raw: undefined,
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
                args_raw: maybeArgsRaw('grok', n.toolName, n.toolArgs),
                status: n.toolStatus || 'ok',
                started_at: recordType === 'tool_call' ? ts : undefined,
                completed_at: recordType === 'tool_call_update' ? ts : undefined,
                duration_ms: n.durationMs,
                result_bytes: undefined,
                error_text: n.errorText,
            },
        });
        // Skill-load rows (0736): grok's L1 is a grok_build read_file targeting SKILL.md.
        for (const record of extractSkillCalls(raw, context, { sessionId, seq, messageSplitIndex })) {
            entries.push(skillCallEntry(record));
        }
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
/**
 * First usable timestamp: an ISO-ish string passes through, a finite number (or digit-string)
 * is converted from epoch seconds/millis (>1e12 treated as ms). Returns undefined when nothing
 * usable exists — mappers must persist null ts rather than a 1970 sentinel (task 0580 D4).
 */
function timestampOf(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
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
    }
    return undefined;
}

function mapRole(type: unknown): string {
    const t = String(type ?? '').toLowerCase();
    if (t === 'user' || t === 'human' || t === 'developer') return 'user';
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
        // Claude emits {type:"text",text}; codex emits {type:"input_text"|"output_text"|
        // "summary_text",text} — any block carrying a string `text` is text content.
        if (typeof b.text === 'string') {
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
export const CLAUDE_FIELD_MAP = identityFieldMap(
    MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS, SKILL_CALL_MAPPER_KEYS),
);
/** Identity field map for the Pi mapper. */
export const PI_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS, SKILL_CALL_MAPPER_KEYS));
/** Identity field map for the OMP mapper. */
export const OMP_FIELD_MAP = identityFieldMap(
    MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS, SKILL_CALL_MAPPER_KEYS),
);
/** Identity field map for the Codex mapper. */
export const CODEX_FIELD_MAP = identityFieldMap(
    MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS, SKILL_CALL_MAPPER_KEYS),
);
/** Identity field map for the AGY mapper. */
export const AGY_FIELD_MAP = identityFieldMap(
    MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS, SKILL_CALL_MAPPER_KEYS),
);
/** Identity field map for the Grok mapper. */
export const GROK_FIELD_MAP = identityFieldMap(
    MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS, SKILL_CALL_MAPPER_KEYS),
);
/** Identity field map for the Gemini mapper. */
export const GEMINI_FIELD_MAP = identityFieldMap(
    MESSAGE_MAPPER_KEYS.concat(TOOL_CALL_MAPPER_KEYS, SKILL_CALL_MAPPER_KEYS),
);
/** Identity field map for the DeepSeek dsh mapper — message rows only, no tool-call rows. */
export const DSH_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS.concat(['source_record_id']));

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
/** Passthrough Zod schema for the DeepSeek dsh mapper. */
export const DSH_SCHEMA = passthroughSchema;
