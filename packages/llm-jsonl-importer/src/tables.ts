import { TYPED_HISTORY_TABLES } from './jsonl-importer-dao';
import { SOURCE_DEFINITIONS } from './sources';

/** Bookkeeping tables owned and maintained by the importer. */
export const BOOKKEEPING_HISTORY_TABLES = ['history_import_checkpoint', 'history_import_ledger'] as const;

/**
 * Complete list of tables owned by the importer:
 * - 3 typed contract tables (history_message, history_tool_call, history_skill_call)
 * - 2 bookkeeping tables (history_import_checkpoint, history_import_ledger)
 * - 10 per-source raw ETL landing tables (history_etl_<source>)
 *
 * Total: 15 tables.
 * Sourced dynamically from static declarations so adding a source upstream automatically
 * includes its landing table without downstream duplication.
 */
export const IMPORTER_OWNED_TABLES: readonly string[] = [
    ...TYPED_HISTORY_TABLES,
    ...BOOKKEEPING_HISTORY_TABLES,
    ...Object.values(SOURCE_DEFINITIONS).map((def) => def.targetTable),
];
