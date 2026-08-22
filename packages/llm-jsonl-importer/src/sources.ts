import { z } from 'zod';
import { HistoryImportError } from './errors';
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
} from './mappers';
import type { FieldTransform, JsonObject, LlmJsonlSource, SourceDefinition, TransformContext } from './types';

const sourceRecordSchema = z
    .object({
        source_record_id: z.string().min(1),
        created_at: z.string().min(1),
        content: z.string().min(1),
        role: z.string().optional(),
        model: z.string().optional(),
    })
    .passthrough();

function firstString(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) return value;
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return undefined;
}

function defaultCreatedAt(value: unknown): string {
    return firstString(value) ?? new Date(0).toISOString();
}

function defaultRecordId(value: unknown, raw: JsonObject, context: TransformContext): string {
    return (
        firstString(
            value,
            raw.id,
            raw.uuid,
            raw.message_id,
            raw.messageId,
            raw.session_id,
            raw.sessionId,
            raw.conversation_id,
        ) ?? `${context.source}:${context.sourceFile}:${context.sourceLine}:${context.splitIndex}`
    );
}

function defaultContent(value: unknown, raw: JsonObject): string | undefined {
    return firstString(value, raw.content, raw.text, raw.message, raw.prompt, raw.response, raw.output);
}

function transforms(): Readonly<Record<string, FieldTransform>> {
    return {
        source_record_id: defaultRecordId,
        created_at: defaultCreatedAt,
        content: defaultContent,
        role: (value, raw) => firstString(value, raw.role, raw.type),
        model: (value, raw) => firstString(value, raw.model, raw.model_name, raw.modelName),
    };
}

function sourceDefinition(
    source: LlmJsonlSource,
    displayName: string,
    defaultRoots: readonly string[],
    filePatterns: readonly string[],
): SourceDefinition {
    return {
        source,
        displayName,
        defaultRoots,
        filePatterns,
        targetTable: `history_etl_${source}`,
        splitConfig: source === 'pi' ? { mode: 'one-to-many', field: 'messages' } : { mode: 'one-to-one' },
        fieldMap: {
            id: 'source_record_id',
            uuid: 'source_record_id',
            message_id: 'source_record_id',
            messageId: 'source_record_id',
            session_id: 'source_record_id',
            sessionId: 'source_record_id',
            conversation_id: 'source_record_id',
            timestamp: 'created_at',
            created_at: 'created_at',
            createdAt: 'created_at',
            time: 'created_at',
            content: 'content',
            text: 'content',
            message: 'content',
            prompt: 'content',
            response: 'content',
            output: 'content',
            role: 'role',
            type: 'role',
            model: 'model',
            model_name: 'model',
            modelName: 'model',
        },
        fieldTransforms: transforms(),
        schema: sourceRecordSchema,
    };
}

/** Build a source definition with a typed custom split for the forensic contract tables. */
function customSourceDefinition(
    source: LlmJsonlSource,
    displayName: string,
    defaultRoots: readonly string[],
    filePatterns: readonly string[],
    split: (raw: JsonObject, context?: TransformContext) => readonly import('./types').SplitEntry[],
    fieldMap: Readonly<Record<string, string>>,
    schema: z.ZodType<JsonObject>,
): SourceDefinition {
    return {
        source,
        displayName,
        defaultRoots,
        filePatterns,
        targetTable: `history_etl_${source}`,
        splitConfig: { mode: 'custom', split },
        fieldMap,
        fieldTransforms: {},
        schema,
    };
}

/**
 * Pattern every importer-owned table must match.
 *
 * WHY: the table name is interpolated into generated SQL (it is not a bind
 * parameter), so it must be a safe identifier. The `history_etl_` prefix also
 * namespaces importer tables away from consumer schemas. Both built-in and
 * custom source definitions are held to this rule.
 */
export const VALID_TABLE_NAME = /^history_[a-z_]+$/;

/** Built-in source definitions keyed by source identifier. */
export const SOURCE_DEFINITIONS: Readonly<Record<LlmJsonlSource, SourceDefinition>> = {
    pi: customSourceDefinition('pi', 'Pi', ['.pi/agent/sessions'], ['*.jsonl'], piSplit, PI_FIELD_MAP, PI_SCHEMA),
    claude: customSourceDefinition(
        'claude',
        'Claude Code',
        ['.claude/projects'],
        ['*.jsonl'],
        claudeSplit,
        CLAUDE_FIELD_MAP,
        CLAUDE_SCHEMA,
    ),
    codex: customSourceDefinition(
        'codex',
        'Codex',
        ['.codex/sessions'],
        ['*.jsonl'],
        codexSplit,
        CODEX_FIELD_MAP,
        CODEX_SCHEMA,
    ),
    omp: customSourceDefinition(
        'omp',
        'OMP',
        ['.omp/agent/sessions'],
        ['*.jsonl'],
        ompSplit,
        OMP_FIELD_MAP,
        OMP_SCHEMA,
    ),
    grok: customSourceDefinition(
        'grok',
        'Grok',
        ['.grok/sessions'],
        ['*.jsonl'],
        grokSplit,
        GROK_FIELD_MAP,
        GROK_SCHEMA,
    ),
    agy: {
        ...customSourceDefinition(
            'agy',
            'Antigravity CLI',
            ['.gemini/antigravity-cli/brain'],
            ['*.jsonl'],
            agySplit,
            AGY_FIELD_MAP,
            AGY_SCHEMA,
        ),
        // agy's producer interleaves non-JSON fragments and torn tail writes into its
        // brain jsonl (task 0623: 789/89,818 lines, all unrecoverable). Skipping keeps
        // the 99%+ good records importable without degrading the whole source.
        corruptLinePolicy: 'skip',
    },
    gemini: customSourceDefinition(
        'gemini',
        'Gemini CLI',
        ['.gemini/tmp', '.config/gemini'],
        ['*.jsonl'],
        geminiSplit,
        GEMINI_FIELD_MAP,
        GEMINI_SCHEMA,
    ),
    opencode: sourceDefinition('opencode', 'OpenCode', ['.opencode', '.local/share/opencode'], ['*.jsonl']),
    antigravity: sourceDefinition('antigravity', 'Antigravity', ['.antigravity'], ['*.jsonl']),
    openclaw: sourceDefinition('openclaw', 'OpenClaw', ['.openclaw'], ['*.jsonl']),
};

/**
 * Resolve a built-in source definition by identifier.
 *
 * Throws {@link HistoryImportError} for unknown identifiers so misconfigured
 * callers fail fast at the seam instead of producing empty imports.
 */
export function getSourceDefinition(source: LlmJsonlSource): SourceDefinition {
    const definition = SOURCE_DEFINITIONS[source];
    if (definition === undefined) {
        throw new HistoryImportError(`Unknown LLM JSONL source: ${source}`, { source });
    }
    return definition;
}

/**
 * Validate a caller-supplied source definition before it enters the pipeline.
 *
 * WHY: target table names are interpolated into SQL, so both the primary
 * `targetTable` and any `splitConfig.targetTable` override must match
 * {@link VALID_TABLE_NAME}. Required structural fields are checked here so the
 * importer can assume they are present. Built-in definitions skip this — they
 * are validated by construction.
 */
export function validateSourceDefinition(definition: SourceDefinition): SourceDefinition {
    const requiredFields: ReadonlyArray<keyof SourceDefinition> = [
        'source',
        'displayName',
        'defaultRoots',
        'filePatterns',
        'targetTable',
        'splitConfig',
        'fieldMap',
        'fieldTransforms',
        'schema',
    ];
    for (const field of requiredFields) {
        if (definition[field] === undefined || definition[field] === null) {
            throw new HistoryImportError(`Source definition is missing required field: ${String(field)}`, {
                source: definition.source,
                field: String(field),
            });
        }
    }
    if (definition.filePatterns.length === 0) {
        throw new HistoryImportError('Source definition must declare at least one file pattern', {
            source: definition.source,
            field: 'filePatterns',
        });
    }
    assertValidTable(definition.targetTable, definition.source);
    if (definition.splitConfig.mode !== 'one-to-one' && definition.splitConfig.targetTable !== undefined) {
        assertValidTable(definition.splitConfig.targetTable, definition.source);
    }
    return definition;
}

/**
 * Resolve a `string | SourceDefinition` source argument into a validated
 * {@link SourceDefinition}. Strings resolve from {@link SOURCE_DEFINITIONS}
 * (unknown strings throw); objects are validated via {@link validateSourceDefinition}.
 */
export function resolveSourceDefinition(input: string | SourceDefinition): SourceDefinition {
    if (typeof input === 'string') {
        return getSourceDefinition(input as LlmJsonlSource);
    }
    return validateSourceDefinition(input);
}

function assertValidTable(table: string, source: string): void {
    if (!VALID_TABLE_NAME.test(table)) {
        throw new HistoryImportError(
            `Invalid history target table for source "${source}": ${table}. Must match ${VALID_TABLE_NAME.source}.`,
            { source, table },
        );
    }
}
