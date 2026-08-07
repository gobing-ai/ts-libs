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
          readonly split: (raw: JsonObject) => readonly (JsonObject | SplitEntry)[];
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
    readonly parseErrors: readonly ImportIssue[];
    readonly validationErrors: readonly ImportIssue[];
    readonly checkpointUpdates: number;
}
