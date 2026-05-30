/** SQL schema owned by the LLM JSONL importer package. */
export const HISTORY_IMPORT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_import_checkpoint (
    source TEXT NOT NULL,
    source_file TEXT NOT NULL,
    last_imported_line INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, source_file)
);

CREATE TABLE IF NOT EXISTS history_import_ledger (
    record_hash TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    target_table TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_etl_pi (
    record_hash TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_etl_claude (
    record_hash TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_etl_codex (
    record_hash TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_etl_gemini (
    record_hash TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_etl_opencode (
    record_hash TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_etl_antigravity (
    record_hash TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_etl_openclaw (
    record_hash TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);
`;
