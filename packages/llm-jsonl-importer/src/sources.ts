import { z } from 'zod';
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

/** Built-in source definitions keyed by source identifier. */
export const SOURCE_DEFINITIONS: Readonly<Record<LlmJsonlSource, SourceDefinition>> = {
    pi: sourceDefinition('pi', 'Pi', ['.pi/history', '.pi'], ['*.jsonl', '*.json']),
    claude: sourceDefinition('claude', 'Claude Code', ['.claude/projects', '.claude'], ['*.jsonl']),
    codex: sourceDefinition('codex', 'Codex', ['.codex/sessions', '.codex'], ['*.jsonl']),
    gemini: sourceDefinition('gemini', 'Gemini CLI', ['.gemini', '.config/gemini'], ['*.jsonl']),
    opencode: sourceDefinition('opencode', 'OpenCode', ['.opencode', '.local/share/opencode'], ['*.jsonl']),
    antigravity: sourceDefinition('antigravity', 'Antigravity', ['.antigravity'], ['*.jsonl']),
    openclaw: sourceDefinition('openclaw', 'OpenClaw', ['.openclaw'], ['*.jsonl']),
};

/** Resolve a built-in source definition by identifier. */
export function getSourceDefinition(source: LlmJsonlSource): SourceDefinition {
    return SOURCE_DEFINITIONS[source];
}
