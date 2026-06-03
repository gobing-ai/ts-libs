import { resolve } from 'node:path';
import { getFs, walkDir } from '@gobing-ai/ts-runtime';
import { HistoryImportError } from './errors';
import { sha256 } from './hash';
import { redactRecord } from './redaction';
import { HISTORY_IMPORT_SCHEMA_SQL } from './schema-sql';
import { getSourceDefinition } from './sources';
import type {
    ImportIssue,
    ImportOptions,
    ImportResult,
    JsonObject,
    LlmJsonlSource,
    SourceDefinition,
    TransformContext,
} from './types';

interface SplitRecord {
    readonly targetTable: string;
    readonly raw: JsonObject;
}

interface CheckpointRow {
    readonly last_imported_line: number;
}

const VALID_TABLE_NAME = /^history_etl_[a-z_]+$/;

/** Apply importer-owned schema to the target database. */
export async function applyHistoryImportSchema(db: ImportOptions['db']): Promise<void> {
    for (const statement of HISTORY_IMPORT_SCHEMA_SQL.split(';')) {
        const sql = statement.trim();
        if (sql.length > 0) {
            await db.exec(sql);
        }
    }
}

/** Run the JSONL import pipeline for one source definition. */
export async function runJsonlImport(source: LlmJsonlSource, options: ImportOptions): Promise<ImportResult> {
    const definition = getSourceDefinition(source);
    await applyHistoryImportSchema(options.db);

    const mode = options.mode ?? 'incremental';
    const files = await discoverFiles(definition, options.roots, options.files);
    if (mode === 'full' && !options.dryRun) {
        await resetCheckpoints(options.db, source, files);
    }

    const parseErrors: ImportIssue[] = [];
    const validationErrors: ImportIssue[] = [];
    let processedLines = 0;
    let importedRecords = 0;
    let skippedDuplicates = 0;
    let checkpointUpdates = 0;

    for (const file of files) {
        const checkpoint = mode === 'incremental' ? await readCheckpoint(options.db, source, file) : 0;
        const lines = (await getFs().readFile(file)).split(/\r?\n/);

        for (let index = 0; index < lines.length; index += 1) {
            const lineNumber = index + 1;
            const line = lines[index]?.trim();
            if (line === undefined || line.length === 0 || lineNumber <= checkpoint) continue;
            processedLines += 1;

            const raw = parseJsonLine(line, file, lineNumber, parseErrors);
            if (raw === undefined) continue;

            const splitRecords = splitRawRecord(definition, raw);
            let lineSucceeded = false;

            for (let splitIndex = 0; splitIndex < splitRecords.length; splitIndex += 1) {
                const split = splitRecords[splitIndex];
                if (split === undefined) continue;
                const normalized = normalizeRecord(definition, split.raw, {
                    source,
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
                    continue;
                }

                const redacted = redactRecord(parsed.data, options.redactionRules);
                lineSucceeded = true;
                const recordHash = sha256({
                    source,
                    sourceFile: file,
                    sourceLine: lineNumber,
                    splitIndex,
                    record: redacted,
                });
                if (await ledgerExists(options.db, recordHash)) {
                    skippedDuplicates += 1;
                    continue;
                }
                if (!options.dryRun) {
                    await insertRecord(
                        options.db,
                        split.targetTable,
                        recordHash,
                        file,
                        lineNumber,
                        splitIndex,
                        redacted,
                        options.now,
                    );
                    await insertLedger(
                        options.db,
                        recordHash,
                        source,
                        file,
                        lineNumber,
                        splitIndex,
                        split.targetTable,
                        options.now,
                    );
                }
                importedRecords += 1;
            }

            if (lineSucceeded && !options.dryRun) {
                await writeCheckpoint(options.db, source, file, lineNumber, options.now);
                checkpointUpdates += 1;
            }
        }
    }

    return {
        source,
        mode,
        scannedFiles: files.length,
        processedLines,
        importedRecords,
        skippedDuplicates,
        parseErrors,
        validationErrors,
        checkpointUpdates,
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

function splitRawRecord(definition: SourceDefinition, raw: JsonObject): readonly SplitRecord[] {
    const targetTable = targetTableFor(definition.targetTable);
    if (definition.splitConfig.mode === 'one-to-one') {
        return [{ targetTable, raw }];
    }
    if (definition.splitConfig.mode === 'custom') {
        const config = definition.splitConfig;
        return config.split(raw).map((entry) => ({
            targetTable: targetTableFor(config.targetTable ?? definition.targetTable),
            raw: entry,
        }));
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
): Promise<readonly string[]> {
    if (files !== undefined && files.length > 0) {
        return files.map((file) => resolve(file)).sort();
    }

    const fs = getFs();
    const resolvedRoots = (roots ?? definition.defaultRoots).map((root) => resolve(root));
    const found = new Set<string>();
    for (const root of resolvedRoots) {
        if (!(await fs.exists(root))) continue;
        const stat = await fs.stat(root);
        if (stat === null) continue;
        if (stat.isFile()) {
            if (matchesPattern(root, definition.filePatterns)) found.add(root);
            continue;
        }
        for (const file of await walkDir(root)) {
            if (matchesPattern(file, definition.filePatterns)) found.add(file);
        }
    }
    return [...found].sort();
}

function matchesPattern(path: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => {
        if (pattern === '*.jsonl') return path.endsWith('.jsonl');
        if (pattern === '*.json') return path.endsWith('.json');
        return path.endsWith(pattern.replace(/^\*/, ''));
    });
}

async function readCheckpoint(db: ImportOptions['db'], source: string, sourceFile: string): Promise<number> {
    const row = await db.queryFirst<CheckpointRow>(
        'SELECT last_imported_line FROM history_import_checkpoint WHERE source = ? AND source_file = ?',
        source,
        sourceFile,
    );
    return row?.last_imported_line ?? 0;
}

async function resetCheckpoints(db: ImportOptions['db'], source: string, files: readonly string[]): Promise<void> {
    for (const file of files) {
        await db.run('DELETE FROM history_import_checkpoint WHERE source = ? AND source_file = ?', source, file);
    }
}

async function writeCheckpoint(
    db: ImportOptions['db'],
    source: string,
    sourceFile: string,
    line: number,
    now: ImportOptions['now'],
): Promise<void> {
    await db.run(
        `INSERT INTO history_import_checkpoint (source, source_file, last_imported_line, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source, source_file) DO UPDATE SET
            last_imported_line = excluded.last_imported_line,
            updated_at = excluded.updated_at`,
        source,
        sourceFile,
        line,
        timestamp(now),
    );
}

async function ledgerExists(db: ImportOptions['db'], recordHash: string): Promise<boolean> {
    const row = await db.queryFirst<{ record_hash: string }>(
        'SELECT record_hash FROM history_import_ledger WHERE record_hash = ?',
        recordHash,
    );
    return row !== undefined && row !== null;
}

async function insertRecord(
    db: ImportOptions['db'],
    targetTable: string,
    recordHash: string,
    sourceFile: string,
    sourceLine: number,
    splitIndex: number,
    payload: JsonObject,
    now: ImportOptions['now'],
): Promise<void> {
    const table = targetTableFor(targetTable);
    await db.run(
        `INSERT INTO ${table} (record_hash, source_file, source_line, split_index, payload_json, imported_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        recordHash,
        sourceFile,
        sourceLine,
        splitIndex,
        JSON.stringify(payload),
        timestamp(now),
    );
}

async function insertLedger(
    db: ImportOptions['db'],
    recordHash: string,
    source: string,
    sourceFile: string,
    sourceLine: number,
    splitIndex: number,
    targetTable: string,
    now: ImportOptions['now'],
): Promise<void> {
    await db.run(
        `INSERT INTO history_import_ledger (record_hash, source, source_file, source_line, split_index, target_table, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        recordHash,
        source,
        sourceFile,
        sourceLine,
        splitIndex,
        targetTable,
        timestamp(now),
    );
}

function targetTableFor(table: string): string {
    if (!VALID_TABLE_NAME.test(table)) {
        throw new HistoryImportError(`Invalid history ETL target table: ${table}`, { table });
    }
    return table;
}

function timestamp(now: ImportOptions['now']): string {
    return (now?.() ?? new Date()).toISOString();
}
