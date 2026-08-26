import { createDbAdapter, type DbAdapter, type DbBatchOp } from '@gobing-ai/ts-db';
import {
    ambientRuntimePaths,
    createNodeFileSystem,
    type FileSystem,
    joinPath,
    type RuntimePaths,
} from '@gobing-ai/ts-runtime';
import { sha256 } from './hash';
import {
    applyHistoryImportSchema,
    deleteCheckpointOperation,
    type OpenCodeMessageRow,
    type OpenCodePartRow,
    type OpenCodeQueuedEntry,
    openCodeBulkWriteOperations,
    openCodeDeleteOperations,
    readOpenCodeExistingEntries,
    readOpenCodeMessages,
    readOpenCodeParts,
} from './jsonl-importer-dao';
import { maybeArgsRaw } from './mappers';
import { redactRecord } from './redaction';
import type { ImportIssue, ImportMode, ImportResult, JsonObject, ReconcileSummary, RedactionRule } from './types';

const SOURCE = 'opencode';
const PAGE_SIZE = 250;

interface PreparedEntry {
    targetTable: 'history_message' | 'history_tool_call';
    splitIndex: number;
    record: JsonObject;
    recordHash: string;
}

/** Dependencies and mode controls for importing OpenCode's SQLite history. */
export interface OpenCodeImportOptions {
    db: DbAdapter;
    sourceDatabase?: string;
    fileSystem?: FileSystem;
    paths?: RuntimePaths;
    mode?: ImportMode;
    dryRun?: boolean;
    redactionRules?: readonly RedactionRule[];
    now?: () => Date;
}

/** Import OpenCode's current SQLite history store into the forensic contract tables. */
export async function runOpenCodeImport(options: OpenCodeImportOptions): Promise<ImportResult> {
    const paths = options.paths ?? ambientRuntimePaths();
    const sourceDatabase = options.sourceDatabase ?? joinPath(paths.home, '.local/share/opencode/opencode.db');
    const fileSystem = options.fileSystem ?? createNodeFileSystem();
    const mode = options.mode ?? 'incremental';

    if (!(await fileSystem.exists(sourceDatabase))) return emptyResult(mode);

    await applyHistoryImportSchema(options.db);
    const sourceDb = await createDbAdapter({ driver: 'bun-sqlite', url: sourceDatabase });
    const parseErrors: ImportIssue[] = [];
    const validationErrors: ImportIssue[] = [];
    let processedLines = 0;
    let importedRecords = 0;
    let skippedDuplicates = 0;
    let checkpointUpdates = 0;
    let lastTime = -1;
    let lastId = '';
    const existingBySourceFile = await readOpenCodeExistingEntries(options.db);
    // Source files still present in the OpenCode store this pass (R1, task 0504). Files with
    // no valid role produce no entries and are deliberately NOT marked seen, so their old
    // derived rows are swept as no-longer-reproduced in full mode.
    const seenSourceFiles = new Set<string>();
    const operations: DbBatchOp[] = [];
    // Full-mode reconciliation counters (R1, task 0504): stale rows from BOTH sources —
    // per-file hash-diff deletes (changed messages) and the vanished-file sweep below. Dry-run
    // counts the identical totals the write would delete, so `--dry-run` is an exact preview.
    // Declared here (outside `try`) because the result is returned after `finally` closes the
    // source database.
    let staleTargetRows = 0;
    let staleLedgerRows = 0;
    let staleCheckpointRows = 0;
    let reconciliation: ReconcileSummary | undefined;

    try {
        while (true) {
            const messages = await readOpenCodeMessages(sourceDb, lastTime, lastId, PAGE_SIZE);
            if (messages.length === 0) break;

            const parts = await readOpenCodeParts(
                sourceDb,
                messages.map((message) => message.id),
            );
            const partsByMessage = groupParts(parts);
            const queuedEntries: OpenCodeQueuedEntry[] = [];
            const checkpointFiles: string[] = [];

            for (const message of messages) {
                processedLines += 1;
                const sourceFile = `${sourceDatabase}#message/${message.id}`;
                const data = parseObject(message.data, sourceFile, parseErrors);
                if (data === undefined) continue;
                const messageParts = (partsByMessage.get(message.id) ?? [])
                    .map((part) => parseObject(part.data, sourceFile, parseErrors))
                    .filter((part): part is JsonObject => part !== undefined);
                const entries = prepareEntries(message, data, messageParts, sourceFile, options.redactionRules);
                if (entries.length === 0) {
                    validationErrors.push({ sourceFile, sourceLine: 1, reason: 'OpenCode message has no valid role' });
                    continue;
                }
                seenSourceFiles.add(sourceFile);

                const existing = existingBySourceFile.get(sourceFile) ?? [];
                if (sameHashes(existing, entries)) {
                    skippedDuplicates += entries.length;
                    continue;
                }

                if (mode === 'full') {
                    // Per-file mapper drift: the old derived rows for this source file are
                    // stale and are deleted before the new entries are written.
                    staleTargetRows += existing.length;
                    staleLedgerRows += existing.length;
                }
                if (!options.dryRun) {
                    operations.push(...openCodeDeleteOperations(existing));
                    for (const entry of entries) {
                        queuedEntries.push({ ...entry, sourceFile });
                    }
                    checkpointFiles.push(sourceFile);
                    checkpointUpdates += 1;
                    existingBySourceFile.set(
                        sourceFile,
                        entries.map((entry) => ({ record_hash: entry.recordHash, target_table: entry.targetTable })),
                    );
                }
                importedRecords += entries.length;
            }

            if (queuedEntries.length > 0) {
                operations.push(...openCodeBulkWriteOperations(queuedEntries, checkpointFiles, options.now));
            }

            const tail = messages.at(-1);
            if (tail === undefined) break;
            lastTime = tail.time_created;
            lastId = tail.id;
        }
        // Full-mode reconciliation (R1, task 0504): messages deleted from the OpenCode store
        // leave stale derived rows behind. Sweep ledger/target rows and checkpoints for source
        // files never seen this pass, merged into the SAME source-scoped batch as the writes.
        if (mode === 'full') {
            for (const [sourceFile, entries] of existingBySourceFile) {
                if (seenSourceFiles.has(sourceFile)) continue;
                staleLedgerRows += entries.length;
                staleTargetRows += entries.length;
                staleCheckpointRows += 1;
                if (!options.dryRun) {
                    operations.push(...openCodeDeleteOperations(entries));
                    operations.push(deleteCheckpointOperation(SOURCE, sourceFile));
                }
            }
            reconciliation = { staleTargetRows, staleLedgerRows, staleCheckpointRows };
        }
        if (operations.length > 0) await options.db.batch(operations);
    } finally {
        sourceDb.close();
    }

    return {
        source: SOURCE,
        mode,
        scannedFiles: 1,
        processedLines,
        importedRecords,
        skippedDuplicates,
        skippedCorruptLines: 0,
        skippedUnchangedFiles: 0,
        unknownRecords: 0,
        parseErrors,
        validationErrors,
        checkpointUpdates,
        reconciliation,
    };
}

function groupParts(parts: readonly OpenCodePartRow[]): Map<string, OpenCodePartRow[]> {
    const grouped = new Map<string, OpenCodePartRow[]>();
    for (const part of parts) {
        const group = grouped.get(part.message_id) ?? [];
        group.push(part);
        grouped.set(part.message_id, group);
    }
    return grouped;
}

function prepareEntries(
    row: OpenCodeMessageRow,
    data: JsonObject,
    parts: readonly JsonObject[],
    sourceFile: string,
    redactionRules?: readonly RedactionRule[],
): PreparedEntry[] {
    const rawRole = stringValue(data.role);
    if (rawRole === undefined) return [];
    const role = rawRole === 'user' || rawRole === 'assistant' ? rawRole : 'meta';
    const time = objectValue(data.time);
    const created = numberValue(time.created) ?? row.time_created;
    const completed = numberValue(time.completed);
    const tokens = objectValue(data.tokens);
    const cache = objectValue(tokens.cache);
    const path = objectValue(data.path);
    const content = parts
        .filter((part) => part.type === 'text' || part.type === 'reasoning')
        .map((part) => stringValue(part.text))
        .filter((text): text is string => text !== undefined)
        .join('\n');
    const modelId = stringValue(data.modelID) ?? stringValue(objectValue(data.model).id);

    const messageRecord = redactRecord(
        {
            source: SOURCE,
            source_file: sourceFile,
            source_line: 1,
            session_id: row.session_id,
            seq: created,
            turn_index: null,
            role,
            record_type: rawRole,
            disposition: role === 'meta' ? 'meta' : 'keep',
            ts: isoTime(created),
            duration_ms: completed === undefined ? null : Math.max(0, completed - created),
            model: modelId ?? null,
            input_tokens: numberValue(tokens.input) ?? null,
            output_tokens: numberValue(tokens.output) ?? null,
            cache_read_tokens: numberValue(cache.read) ?? null,
            cache_write_tokens: numberValue(cache.write) ?? null,
            cost_usd: numberValue(data.cost) ?? null,
            content_text: content.length > 0 ? content : null,
            cwd: stringValue(path.cwd) ?? row.directory,
            provenance: 'ambient',
            run_id: null,
            task_wbs: null,
        },
        redactionRules,
    );
    const messageHash = recordHash(sourceFile, 0, messageRecord);
    const entries: PreparedEntry[] = [
        { targetTable: 'history_message', splitIndex: 0, record: messageRecord, recordHash: messageHash },
    ];

    for (const part of parts) {
        if (part.type !== 'tool') continue;
        const state = objectValue(part.state);
        const toolTime = objectValue(state.time);
        const started = numberValue(toolTime.start);
        const completedAt = numberValue(toolTime.end);
        const output = stringValue(state.output);
        const status = stringValue(state.status) ?? 'unknown';
        const splitIndex = entries.length;
        const toolRecord = redactRecord(
            {
                message_hash: messageHash,
                source: SOURCE,
                source_file: sourceFile,
                source_line: 1,
                session_id: row.session_id,
                seq: started ?? created,
                tool_name: stringValue(part.tool) ?? 'unknown',
                args_raw: maybeArgsRaw(SOURCE, stringValue(part.tool) ?? 'unknown', state.input),
                args_digest: sha256(state.input ?? null),
                status,
                started_at: started === undefined ? null : isoTime(started),
                completed_at: completedAt === undefined ? null : isoTime(completedAt),
                duration_ms:
                    started === undefined || completedAt === undefined ? null : Math.max(0, completedAt - started),
                result_bytes: output === undefined ? null : new TextEncoder().encode(output).byteLength,
                error_text: status === 'error' ? (stringValue(state.error) ?? output ?? null) : null,
            },
            redactionRules,
        );
        entries.push({
            targetTable: 'history_tool_call',
            splitIndex,
            record: toolRecord,
            recordHash: recordHash(sourceFile, splitIndex, toolRecord),
        });
    }
    return entries;
}

function recordHash(sourceFile: string, splitIndex: number, record: JsonObject): string {
    return sha256({ source: SOURCE, sourceFile, sourceLine: 1, splitIndex, record });
}

function sameHashes(existing: readonly { record_hash: string }[], entries: readonly PreparedEntry[]): boolean {
    if (existing.length !== entries.length) return false;
    const hashes = new Set(existing.map((row) => row.record_hash));
    return entries.every((entry) => hashes.has(entry.recordHash));
}

function parseObject(value: string, sourceFile: string, issues: ImportIssue[]): JsonObject | undefined {
    try {
        const parsed = JSON.parse(value);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject;
    } catch (error) {
        issues.push({ sourceFile, sourceLine: 1, reason: error instanceof Error ? error.message : 'Invalid JSON' });
        return undefined;
    }
    issues.push({ sourceFile, sourceLine: 1, reason: 'OpenCode JSON value must be an object' });
    return undefined;
}

function objectValue(value: unknown): JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isoTime(value: number): string {
    return new Date(value).toISOString();
}

function emptyResult(mode: ImportMode): ImportResult {
    return {
        source: SOURCE,
        mode,
        scannedFiles: 0,
        processedLines: 0,
        importedRecords: 0,
        skippedDuplicates: 0,
        skippedCorruptLines: 0,
        skippedUnchangedFiles: 0,
        unknownRecords: 0,
        parseErrors: [],
        validationErrors: [],
        checkpointUpdates: 0,
    };
}
