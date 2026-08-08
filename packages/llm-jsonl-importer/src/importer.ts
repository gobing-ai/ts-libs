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
    ensureTargetTables,
    insertLedger,
    insertRecord,
    ledgerExists,
    readCheckpoint,
    resetCheckpoints,
    targetTableFor,
    writeCheckpoint,
} from './jsonl-importer-dao';
import { redactRecord } from './redaction';
import { resolveSourceDefinition } from './sources';
import type { ImportIssue, ImportOptions, ImportResult, JsonObject, SourceDefinition, TransformContext } from './types';

interface SplitRecord {
    readonly targetTable: string;
    readonly raw: JsonObject;
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

            const splitRecords = splitRawRecord(definition, raw);
            let lineSucceeded = false;

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
                if (await ledgerExists(options.db, recordHash)) {
                    skippedDuplicates += 1;
                    continue;
                }
                prepared.push({ split, splitIndex, normalized: redacted, recordHash });
            }

            // Second pass: resolve _messageSplitIndex → message_hash, then insert.
            const recordHashBySplitIndex = new Map(prepared.map((e) => [e.splitIndex, e.recordHash] as const));
            for (const entry of prepared) {
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
                    await insertRecord(
                        options.db,
                        split.targetTable,
                        recordHash,
                        file,
                        lineNumber,
                        splitIndex,
                        normalized,
                        options.now,
                    );
                    await insertLedger(
                        options.db,
                        recordHash,
                        resolvedSource,
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
                await writeCheckpoint(options.db, resolvedSource, file, lineNumber, options.now);
                checkpointUpdates += 1;
            }
        }
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
        const configTable = config.targetTable !== undefined ? targetTableFor(config.targetTable) : undefined;
        return config.split(raw).map((entry) => {
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
