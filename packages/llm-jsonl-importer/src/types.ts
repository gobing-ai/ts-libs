import type { DbAdapter } from '@gobing-ai/ts-db';
import type { FileSystem, RuntimePaths } from '@gobing-ai/ts-runtime';
import type { z } from 'zod';

/** Built-in source identifiers supported by the importer. */
export type LlmJsonlSource =
    | 'pi'
    | 'claude'
    | 'codex'
    | 'gemini'
    | 'opencode'
    | 'antigravity'
    | 'openclaw'
    | 'omp'
    | 'grok'
    | 'agy';

/** Import mode controlling checkpoint behavior. */
export type ImportMode = 'full' | 'incremental' | 'force-file';

/** One record emitted by a custom split, optionally routed to its own table. */
export interface SplitEntry {
    readonly targetTable?: string;
    readonly record: JsonObject;
}

/** Split strategy for turning a raw JSONL object into one or more ETL records. */
export type SplitConfig =
    | {
          readonly mode: 'one-to-one';
      }
    | {
          readonly mode: 'one-to-many';
          readonly field: string;
          readonly targetTable?: string;
      }
    | {
          readonly mode: 'custom';
          readonly split: (raw: JsonObject, context?: TransformContext) => readonly (JsonObject | SplitEntry)[];
          readonly targetTable?: string;
      };

/** JSON-compatible record used at the importer boundary. */
export type JsonObject = Record<string, unknown>;

/** Transform function for mapped canonical fields. */
export type FieldTransform = (value: unknown, raw: JsonObject, context: TransformContext) => unknown;

/** Context available while normalizing a split record. */
export interface TransformContext {
    /** Source identifier — a built-in {@link LlmJsonlSource} or a custom definition's name. */
    readonly source: string;
    readonly sourceFile: string;
    readonly sourceLine: number;
    readonly splitIndex: number;
}

/** Declarative importer configuration for one LLM history source. */
export interface SourceDefinition<TRecord extends JsonObject = JsonObject> {
    /** Source identifier — a built-in {@link LlmJsonlSource} or a custom name. Becomes the checkpoint/ledger key. */
    readonly source: string;
    readonly displayName: string;
    readonly defaultRoots: readonly string[];
    readonly filePatterns: readonly string[];
    /**
     * Policy for lines that fail JSON parsing. `'error'` (default) records a parse error and
     * degrades the import; `'skip'` counts the line and moves on — for producers whose logs
     * are known to interleave non-JSON fragments and torn tail writes (agy task 0623:
     * 789/89,818 lines unparseable, all unrecoverable garbage).
     */
    readonly corruptLinePolicy?: 'error' | 'skip';
    readonly targetTable: string;
    readonly splitConfig: SplitConfig;
    readonly fieldMap: Readonly<Record<string, string>>;
    readonly fieldTransforms: Readonly<Record<string, FieldTransform>>;
    readonly schema: z.ZodType<TRecord>;
}

/** Redaction rule applied before hashing and persistence. */
export interface RedactionRule {
    readonly name: string;
    readonly pattern: RegExp;
    readonly replacement: string;
}

/** Options for one importer run. */
export interface ImportOptions {
    readonly db: DbAdapter;
    readonly fileSystem?: FileSystem;
    readonly mode?: ImportMode;
    readonly roots?: readonly string[];
    readonly files?: readonly string[];
    readonly dryRun?: boolean;
    readonly redactionRules?: readonly RedactionRule[];
    readonly now?: () => Date;
    /**
     * Optional cwd/home anchor (ADR-023 A1 / task 0042). When set, registry `defaultRoots`
     * resolve against `paths.home` instead of the ambient working directory; explicit
     * {@link ImportOptions.roots} keep cwd semantics unchanged. Defaults to ambient cwd/home.
     */
    readonly paths?: RuntimePaths;
}

/** Structured importer error that can be reported without persisting raw input. */
export interface ImportIssue {
    readonly sourceFile: string;
    readonly sourceLine: number;
    readonly reason: string;
}

/**
 * Source-scoped full-mode reconciliation outcome (task 0504 R1). Computed by diffing the
 * current source's desired record hashes against the persisted ledger; rows no longer
 * reproduced by current source data or mapper output are stale and are removed in one
 * source-scoped batch (dry-run reports the same counts without mutating the database).
 */
export interface ReconcileSummary {
    /** Rows deleted from typed/ETL target tables (history_message / history_tool_call / history_etl_*). */
    readonly staleTargetRows: number;
    /** Rows deleted from `history_import_ledger`. */
    readonly staleLedgerRows: number;
    /** Checkpoint rows deleted for source files no longer discovered. */
    readonly staleCheckpointRows: number;
}

/** Summary produced by the importer control function. */
export interface ImportResult {
    /** Source identifier — the built-in name or custom definition name that produced this result. */
    readonly source: string;
    readonly mode: ImportMode;
    readonly scannedFiles: number;
    readonly processedLines: number;
    readonly importedRecords: number;
    readonly skippedDuplicates: number;
    readonly unknownRecords: number;
    /** Lines dropped by `corruptLinePolicy: 'skip'` instead of degrading the import. */
    readonly skippedCorruptLines: number;
    /** Files skipped whole by the incremental identity short-circuit (0675 R2); 0 elsewhere. */
    readonly skippedUnchangedFiles: number;
    readonly parseErrors: readonly ImportIssue[];
    readonly validationErrors: readonly ImportIssue[];
    readonly checkpointUpdates: number;
    /**
     * Full-mode reconciliation counts (only set when `mode === 'full'`). A second full run
     * reports zero stale rows once the database matches the current source (task 0504 R1).
     */
    readonly reconciliation?: ReconcileSummary;
}

/**
 * One normalized skill-load row targeting the `history_skill_call` typed table (0735).
 * Field names match the DAO typed-column map verbatim (snake_case): the typed insert path
 * reads `payload[column]` directly, so record keys must equal column names.
 * `invocation_kind` is `'user'` (L0 harness prefix / direct caller) or `'model'` (native
 * load tool); `skill_path` is nullable because some producers inline the skill body without
 * a resolvable path.
 */
/**
 * Split-time skill-load record routed to `history_skill_call` (0736). The importer/DAO manage
 * `record_hash`, `message_hash` (resolved from `_messageSplitIndex`), the source identity
 * columns, and `imported_at`; keeping them out of the split record also keeps them out of the
 * record_hash input, so re-imports hash identically (0736 R5 idempotency).
 */
export interface SkillCallSplitRecord {
    readonly _messageSplitIndex?: number;
    readonly session_id: string;
    readonly seq: number;
    readonly skill_name: string;
    readonly invocation_kind: 'user' | 'model';
    readonly skill_path?: string | null;
    readonly args_raw?: string | null;
    readonly args_digest?: string | null;
    readonly call_id?: string | null;
    readonly status?: string | null;
    readonly started_at?: string | null;
    readonly completed_at?: string | null;
    readonly duration_ms?: number | null;
}

/** Normalized skill-call record imported into history_skill_call. */
export interface SkillCall {
    readonly record_hash: string;
    readonly message_hash: string;
    readonly source: string;
    readonly source_file: string;
    readonly source_line: number;
    readonly session_id: string;
    readonly seq: number;
    readonly skill_name: string;
    readonly invocation_kind: 'user' | 'model';
    readonly skill_path?: string | null;
    readonly args_raw?: string | null;
    readonly args_digest?: string | null;
    readonly call_id?: string | null;
    readonly status?: string | null;
    readonly started_at?: string | null;
    readonly completed_at?: string | null;
    readonly duration_ms?: number | null;
    readonly imported_at: string;
}
