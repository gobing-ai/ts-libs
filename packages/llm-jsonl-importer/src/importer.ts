import type { DbBatchOp } from '@gobing-ai/ts-db';
import {
    ambientRuntimePaths,
    createNodeFileSystem,
    type FileSystem,
    type RuntimePaths,
    resolvePath,
    walkDir,
} from '@gobing-ai/ts-runtime';
import { sha256 } from './hash';
import {
    applyHistoryImportSchema,
    checkpointUpsertOp,
    ensureTargetTables,
    ledgerExistingHashes,
    ledgerInsertOp,
    readCheckpoint,
    reconcileFullImport,
    recordInsertOp,
    resetCheckpoints,
    targetTableFor,
    toolCallDurationUpdateOp,
} from './jsonl-importer-dao';
import { type OmpToolResultTiming, ompToolResultTiming, timestampToEpochMs } from './mappers';
import { redactRecord } from './redaction';
import { resolveSourceDefinition } from './sources';
import type {
    ImportIssue,
    ImportOptions,
    ImportResult,
    JsonObject,
    ReconcileSummary,
    SourceDefinition,
    TransformContext,
} from './types';

interface SplitRecord {
    readonly targetTable: string;
    readonly raw: JsonObject;
}

// ---------------------------------------------------------------------------
// Task 0564 R1 — tool-call duration attach (omp)
//
// A toolCall row is emitted while handling its assistant message (SplitEntry is
// insert-only, so the duration cannot ride the mapper's split path); the
// duration arrives on a LATER toolResult line. The attach therefore lives in the
// streaming loop, keyed on (source, session_id, call_id) per the frozen contract:
//   - `details.wallTimeMs` is the tool's own measured wall time — used as-is,
//     rounded, NEVER clamped or second-guessed (guards are fallback-only);
//   - otherwise the fallback `toolResult.timestamp − toolCall message timestamp`
//     when both are parseable AND the delta is in [0, 3_600_000]; an implausible
//     delta stays NULL so the unmeasured count stays honest;
//   - started_at / completed_at are written alongside a FALLBACK figure so it is
//     auditable (wallTimeMs rows keep both NULL — the two stay distinguishable);
//   - an unmatched toolCallId attaches nothing and never fails the import.
//
// The in-memory map covers the common (fresh-import) case without extra queries;
// a toolResult whose tool-call line was imported by an earlier checkpointed run
// (resume) resolves through a DB lookup instead, so a mid-file checkpoint loses
// no earlier duration.
// ---------------------------------------------------------------------------

interface PendingToolCall {
    readonly recordHash: string;
    /** Assistant-message timestamp (epoch ms) — the fallback's start bound. */
    readonly messageTsMs: number | undefined;
}

const TOOL_CALL_KEY_SEP = '\u0000';

function toolCallKey(source: string, sessionId: string, callId: string): string {
    return `${source}${TOOL_CALL_KEY_SEP}${sessionId}${TOOL_CALL_KEY_SEP}${callId}`;
}

/** Resolve a tool-call row this run did not see (its line is behind the checkpoint). */
async function resolveToolCallRow(
    db: ImportOptions['db'],
    source: string,
    sessionId: string,
    callId: string,
): Promise<PendingToolCall | undefined> {
    const row = await db.queryFirst<{ recordHash: string; messageTs: string | null }>(
        `SELECT tc.record_hash AS recordHash, m.ts AS messageTs
         FROM history_tool_call tc
         LEFT JOIN history_message m ON m.record_hash = tc.message_hash
         WHERE tc.source = ? AND tc.session_id = ? AND tc.call_id = ?`,
        source,
        sessionId,
        callId,
    );
    if (row === undefined || row === null) return undefined;
    return { recordHash: row.recordHash, messageTsMs: timestampToEpochMs(row.messageTs) };
}

/**
 * Compute the attachable duration for a toolResult, or null when nothing should
 * be written (implausible fallback delta → row stays NULL → counts unmeasured).
 */
function attachableDuration(
    timing: OmpToolResultTiming,
    messageTsMs: number | undefined,
): { startedAt: string | null; completedAt: string | null; durationMs: number } | null {
    if (timing.wallTimeMs !== undefined) {
        // The tool's own measurement — no clamping, no sanity check.
        return { startedAt: null, completedAt: null, durationMs: Math.round(timing.wallTimeMs) };
    }
    if (timing.timestampMs === undefined || messageTsMs === undefined) return null;
    const delta = timing.timestampMs - messageTsMs;
    // Guard rails apply to the fallback ONLY: negative or > 1h is implausible.
    if (!Number.isFinite(delta) || delta < 0 || delta > 3_600_000) return null;
    return {
        startedAt: new Date(messageTsMs).toISOString(),
        completedAt: new Date(timing.timestampMs).toISOString(),
        durationMs: Math.round(delta),
    };
}

/** Run the JSONL import pipeline for one source.
 *
 * @param source - Either a built-in source identifier resolved from the
 *   registry, or a fully-specified {@link SourceDefinition} for a custom
 *   source. Unknown strings throw {@link HistoryImportError}; custom
 *   definitions are validated before any I/O.
 * @param options - Importer options (database, roots/files, mode, etc.).
 */
export async function runJsonlImport(source: string | SourceDefinition, options: ImportOptions): Promise<ImportResult> {
    const definition = resolveSourceDefinition(source);
    const resolvedSource = definition.source;
    const fileSystem = options.fileSystem ?? createNodeFileSystem();
    await applyHistoryImportSchema(options.db);
    await ensureTargetTables(options.db, definition);

    const mode = options.mode ?? 'incremental';
    const files = await discoverFiles(definition, options.roots, options.files, fileSystem, options.paths);
    if (mode === 'full' && !options.dryRun) {
        await resetCheckpoints(options.db, resolvedSource, files);
    }

    const parseErrors: ImportIssue[] = [];
    const validationErrors: ImportIssue[] = [];
    let processedLines = 0;
    let importedRecords = 0;
    let skippedDuplicates = 0;
    let unknownRecords = 0;
    let checkpointUpdates = 0;
    // Full-mode desired set (R1, task 0504): every record hash the current source produces.
    // ReconcileFullImport diffs this against the persisted ledger to retire stale rows.
    const desiredHashes = new Set<string>();

    // Task 0564 R1: tool-call rows emitted by earlier assistant lines, keyed by
    // (source, session_id, call_id) so a later toolResult line can attach its duration.
    const toolCallRows = new Map<string, PendingToolCall>();

    for (const file of files) {
        const checkpoint = mode === 'incremental' ? await readCheckpoint(options.db, resolvedSource, file) : 0;
        let lineNumber = 0;
        for await (const rawLine of readLines(fileSystem, file)) {
            lineNumber += 1;
            const line = rawLine.trim();
            if (line.length === 0 || lineNumber <= checkpoint) continue;
            processedLines += 1;

            const raw = parseJsonLine(line, file, lineNumber, parseErrors);
            if (raw === undefined) continue;

            const splitRecords = splitRawRecord(definition, raw, {
                source: resolvedSource,
                sourceFile: file,
                sourceLine: lineNumber,
                splitIndex: 0,
            });
            let lineSucceeded = false;
            // Atomic per-record acceptance (R2, task 0504): a schema-invalid split rejects the
            // WHOLE line, so no partially accepted rows (or orphaned tool-call rows with a
            // dangling message_hash) can be left behind by one bad split.
            let lineRejected = false;

            // First pass: normalize, validate, redact, compute recordHash for every entry.
            interface PreparedEntry {
                readonly split: SplitRecord;
                readonly splitIndex: number;
                readonly normalized: JsonObject;
                readonly recordHash: string;
            }
            const prepared: PreparedEntry[] = [];
            for (let splitIndex = 0; splitIndex < splitRecords.length; splitIndex += 1) {
                const split = splitRecords[splitIndex];
                if (split === undefined) continue;
                const normalized = normalizeRecord(definition, split.raw, {
                    source: resolvedSource,
                    sourceFile: file,
                    sourceLine: lineNumber,
                    splitIndex,
                });
                const parsed = definition.schema.safeParse(normalized);
                if (!parsed.success) {
                    validationErrors.push({
                        sourceFile: file,
                        sourceLine: lineNumber,
                        reason: parsed.error.issues.map((issue) => issue.message).join('; '),
                    });
                    lineRejected = true;
                    continue;
                }

                const redacted = redactRecord(parsed.data, options.redactionRules);
                lineSucceeded = true;
                const recordHash = sha256({
                    source: resolvedSource,
                    sourceFile: file,
                    sourceLine: lineNumber,
                    splitIndex,
                    record: redacted,
                });
                desiredHashes.add(recordHash);
                prepared.push({ split, splitIndex, normalized: redacted, recordHash });
            }

            // A rejected line is reported (validationErrors above) but never persisted — no
            // second pass, no checkpoint advance, no partial rows from this record.
            if (lineRejected) continue;

            // Task 0564 R1 (omp): register this line's tool-call rows for later duration
            // attach. Runs over ALL prepared entries — including duplicates — because a
            // re-imported line's row already exists and its duration UPDATE still targets
            // the same deterministic record_hash. The assistant message timestamp is the
            // fallback's start bound; every call in one message shares it.
            if (definition.source === 'omp') {
                const assistantTs = new Map<string, number | undefined>();
                for (const entry of prepared) {
                    if (
                        entry.split.targetTable === 'history_message' &&
                        entry.normalized.role === 'assistant' &&
                        typeof entry.normalized.session_id === 'string'
                    ) {
                        assistantTs.set(
                            `${entry.normalized.session_id}${TOOL_CALL_KEY_SEP}${entry.normalized.seq}`,
                            timestampToEpochMs(entry.normalized.ts),
                        );
                    }
                }
                for (const entry of prepared) {
                    const callId = entry.normalized.call_id;
                    if (
                        entry.split.targetTable === 'history_tool_call' &&
                        typeof callId === 'string' &&
                        callId.length > 0 &&
                        typeof entry.normalized.session_id === 'string'
                    ) {
                        toolCallRows.set(toolCallKey(resolvedSource, entry.normalized.session_id, callId), {
                            recordHash: entry.recordHash,
                            messageTsMs: assistantTs.get(
                                `${entry.normalized.session_id}${TOOL_CALL_KEY_SEP}${entry.normalized.seq}`,
                            ),
                        });
                    }
                }
            }

            // Chunked ledger lookup (task 0060 F9): one `IN (...)` query per ≤200 hashes
            // instead of a SELECT per record; duplicates are dropped before the write pass.
            const existing = await ledgerExistingHashes(
                options.db,
                prepared.map((e) => e.recordHash),
            );
            const accepted = prepared.filter((entry) => {
                if (existing.has(entry.recordHash)) {
                    skippedDuplicates += 1;
                    return false;
                }
                return true;
            });

            // Second pass: resolve _messageSplitIndex → message_hash, then batch.
            const recordHashBySplitIndex = new Map(prepared.map((e) => [e.splitIndex, e.recordHash] as const));
            const ops: DbBatchOp[] = [];
            for (const entry of accepted) {
                const { split, splitIndex, normalized, recordHash } = entry;
                if (normalized.disposition === 'unknown') {
                    unknownRecords += 1;
                }
                // Resolve _messageSplitIndex if present (tool call → parent message linkage).
                const msgSplitIdx = normalized._messageSplitIndex as number | undefined;
                delete normalized._messageSplitIndex;
                if (msgSplitIdx !== undefined && typeof msgSplitIdx === 'number') {
                    const msgHash = recordHashBySplitIndex.get(msgSplitIdx);
                    if (msgHash !== undefined) {
                        normalized.message_hash = msgHash;
                    }
                }
                if (!options.dryRun) {
                    // Record row + ledger row join one batch op pair — a crash between the two
                    // writes is impossible (task 0060 F9).
                    ops.push(
                        recordInsertOp(
                            split.targetTable,
                            recordHash,
                            file,
                            lineNumber,
                            splitIndex,
                            normalized,
                            options.now,
                        ),
                    );
                    ops.push(
                        ledgerInsertOp(
                            recordHash,
                            resolvedSource,
                            file,
                            lineNumber,
                            splitIndex,
                            split.targetTable,
                            options.now,
                        ),
                    );
                }
                importedRecords += 1;
            }

            if (!options.dryRun && lineSucceeded) {
                // Task 0564 R1 (omp): attach tool durations from this line's toolResult
                // message. Unmatched toolCallIds attach nothing and never fail the import;
                // an implausible fallback delta stays NULL (unmeasured). The UPDATEs ride
                // this line's batch — idempotent, so re-imports and post-resume tail
                // reprocessing write the same values.
                if (definition.source === 'omp') {
                    const timing = ompToolResultTiming(raw);
                    if (timing !== null) {
                        const resultEntry = prepared.find(
                            (entry) =>
                                entry.split.targetTable === 'history_message' && entry.normalized.role === 'toolresult',
                        );
                        const sessionId = resultEntry?.normalized.session_id;
                        if (typeof sessionId === 'string') {
                            let pending = toolCallRows.get(toolCallKey(resolvedSource, sessionId, timing.toolCallId));
                            if (pending === undefined) {
                                // The tool-call line sits behind this run's checkpoint — the
                                // row exists from an earlier import; resolve it from the DB.
                                pending = await resolveToolCallRow(
                                    options.db,
                                    resolvedSource,
                                    sessionId,
                                    timing.toolCallId,
                                );
                            }
                            if (pending !== undefined) {
                                const duration = attachableDuration(timing, pending.messageTsMs);
                                if (duration !== null) {
                                    ops.push(
                                        toolCallDurationUpdateOp(
                                            pending.recordHash,
                                            duration.startedAt,
                                            duration.completedAt,
                                            duration.durationMs,
                                        ),
                                    );
                                }
                            }
                        }
                    }
                }
                // Checkpoint upsert joins the same batch so an accepted line can never be
                // re-imported after a mid-batch crash.
                ops.push(checkpointUpsertOp(resolvedSource, file, lineNumber, options.now));
                if (ops.length > 0) {
                    await options.db.batch(ops);
                    checkpointUpdates += 1;
                }
            }
        }
    }

    // Full-mode reconciliation (R1, task 0504): diff the desired hash set against the
    // persisted ledger and retire stale derived rows (target, tool, ledger, checkpoint) in
    // one source-scoped batch. Dry-run computes the identical counts without mutation.
    let reconciliation: ReconcileSummary | undefined;
    if (mode === 'full') {
        reconciliation = await reconcileFullImport(
            options.db,
            resolvedSource,
            desiredHashes,
            files,
            options.dryRun ?? false,
        );
    }

    return {
        source: resolvedSource,
        mode,
        scannedFiles: files.length,
        processedLines,
        importedRecords,
        skippedDuplicates,
        unknownRecords,
        parseErrors,
        validationErrors,
        checkpointUpdates,
        reconciliation,
    };
}

function parseJsonLine(
    line: string,
    sourceFile: string,
    sourceLine: number,
    parseErrors: ImportIssue[],
): JsonObject | undefined {
    try {
        const value = JSON.parse(line);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            parseErrors.push({ sourceFile, sourceLine, reason: 'JSONL row must be an object' });
            return undefined;
        }
        return value as JsonObject;
    } catch (error) {
        parseErrors.push({ sourceFile, sourceLine, reason: error instanceof Error ? error.message : 'Invalid JSON' });
        return undefined;
    }
}

function splitRawRecord(
    definition: SourceDefinition,
    raw: JsonObject,
    context: TransformContext,
): readonly SplitRecord[] {
    const targetTable = targetTableFor(definition.targetTable);
    if (definition.splitConfig.mode === 'one-to-one') {
        return [{ targetTable, raw }];
    }
    if (definition.splitConfig.mode === 'custom') {
        const config = definition.splitConfig;
        const configTable = config.targetTable !== undefined ? targetTableFor(config.targetTable) : undefined;
        return config.split(raw, context).map((entry) => {
            // Normalize: SplitEntry has a `record` property, bare object is the record itself.
            const hasTargetTable =
                'targetTable' in entry && typeof (entry as { targetTable: unknown }).targetTable === 'string';
            const record = hasTargetTable ? (entry as { record: JsonObject }).record : (entry as JsonObject);
            const entryTable = hasTargetTable ? (entry as { targetTable?: string }).targetTable : undefined;
            // Resolution order: entry → splitConfig → definition
            const table = entryTable ?? configTable ?? targetTable;
            return { targetTable: targetTableFor(table), raw: record };
        });
    }

    const config = definition.splitConfig;
    const nested = raw[config.field];
    if (!Array.isArray(nested)) {
        return [{ targetTable, raw }];
    }
    return nested
        .filter((entry): entry is JsonObject => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => ({
            targetTable: targetTableFor(config.targetTable ?? definition.targetTable),
            raw: { ...raw, ...entry },
        }));
}

function normalizeRecord(definition: SourceDefinition, raw: JsonObject, context: TransformContext): JsonObject {
    const normalized: JsonObject = {};
    for (const [rawKey, targetKey] of Object.entries(definition.fieldMap)) {
        if (rawKey in raw) normalized[targetKey] = raw[rawKey];
    }
    for (const [targetKey, transform] of Object.entries(definition.fieldTransforms)) {
        normalized[targetKey] = transform(normalized[targetKey], raw, context);
    }
    normalized.source = context.source;
    normalized.source_file = context.sourceFile;
    normalized.source_line = context.sourceLine;
    normalized.split_index = context.splitIndex;
    return normalized;
}

async function discoverFiles(
    definition: SourceDefinition,
    roots: readonly string[] | undefined,
    files: readonly string[] | undefined,
    fileSystem: FileSystem,
    paths: RuntimePaths | undefined,
): Promise<readonly string[]> {
    if (files !== undefined && files.length > 0) {
        return files
            .map((file) => resolvePath(file))
            .map((file) => normalizeSourceFilePath(file, fileSystem))
            .sort();
    }

    // Root resolution splits by provenance (ADR-023 A1 / task 0042):
    //  - explicit caller-supplied `roots` → cwd semantics: resolve against `paths.cwd` when
    //    injected, else ambient cwd (the pre-seam behaviour — R4 additive-only).
    //  - registry `defaultRoots` → home-relative: resolve against `paths.home`.
    //    Previously both kinds anchored to ambient cwd, so a cwd ≠ $HOME silently skipped every
    //    registry source because the home-relative paths never existed relative to cwd.
    const ambient = paths ?? ambientRuntimePaths();
    const resolvedRoots =
        roots !== undefined
            ? roots.map((root) => resolvePath(ambient.cwd, root))
            : definition.defaultRoots.map((root) => resolvePath(ambient.home, root));
    const found = new Set<string>();
    for (const root of resolvedRoots) {
        if (!(await fileSystem.exists(root))) continue;
        const stat = await fileSystem.stat(root);
        if (stat === null) continue;
        if (stat.isFile()) {
            if (matchesPattern(root, definition.filePatterns)) found.add(normalizeSourceFilePath(root, fileSystem));
            continue;
        }
        for (const file of await walkDir(root, fileSystem)) {
            if (matchesPattern(file, definition.filePatterns)) found.add(normalizeSourceFilePath(file, fileSystem));
        }
    }
    return [...found].sort();
}

/**
 * Normalize a discovered source file path to its canonical real-path identity.
 *
 * WHY: the same physical session file is reachable via a symlinked path and via its
 * real path (every agent history dir under `$HOME` is a symlink into the dotfiles
 * tree here). Without normalization, the checkpoint, ledger, and record_hash keys
 * diverge, yielding duplicate checkpoint rows and silent full-corpus re-imports.
 * `realPath` is optional on `FileSystem`: injected and in-memory test doubles may
 * omit it, and a path that does not exist on disk has no realpath. Fall back to the
 * original path in either case — never throw, never bypass the injected FileSystem.
 */
function normalizeSourceFilePath(path: string, fileSystem: FileSystem): string {
    if (!fileSystem.realPath) return path;
    try {
        return fileSystem.realPath(path);
    } catch {
        return path;
    }
}

function matchesPattern(path: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => {
        if (pattern === '*.jsonl') return path.endsWith('.jsonl');
        if (pattern === '*.json') return path.endsWith('.json');
        return path.endsWith(pattern.replace(/^\*/, ''));
    });
}

/**
 * Yield lines from a file, streaming when the FileSystem supports it.
 *
 * WHY: large JSONL history files (100MB+) must not be loaded into memory all at
 * once. When `fileSystem.readFileStream` is available, lines are streamed from
 * disk in chunks. Otherwise, falls back to `readFile` + `split` — same behavior
 * as before, preserving parity for stubs like CF Workers.
 */
async function* readLines(fileSystem: FileSystem, file: string): AsyncGenerator<string> {
    if (fileSystem.readFileStream) {
        yield* fileSystem.readFileStream(file);
        return;
    }
    const content = await fileSystem.readFile(file);
    for (const line of content.split(/\r?\n/)) {
        yield line;
    }
}
