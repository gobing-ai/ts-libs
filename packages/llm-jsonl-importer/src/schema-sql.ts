/**
 * DDL string that creates the history import checkpoint, ledger, and typed contract tables.
 *
 * WHY: per-source `history_etl_*` blob tables are no longer hard-coded here. They are created
 * dynamically by {@link ensureTargetTables} / {@link ETL_TABLE_DDL} looping every entry of
 * {@link SOURCE_DEFINITIONS}, so adding a new built-in source needs no edit to this file. This
 * single-owner rule closes the R16 drift where `omp` / `grok` / `agy` existed only via import-time
 * DDL while the seven other sources were duplicated in the static string.
 */
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

CREATE TABLE IF NOT EXISTS history_message (
    record_hash        TEXT PRIMARY KEY,
    source             TEXT NOT NULL,
    source_file        TEXT NOT NULL,
    source_line        INTEGER NOT NULL,
    session_id         TEXT NOT NULL,
    seq                INTEGER NOT NULL,
    turn_index         INTEGER,
    role               TEXT NOT NULL,
    record_type        TEXT NOT NULL,
    disposition        TEXT NOT NULL,
    ts                 TEXT NOT NULL,
    duration_ms        INTEGER,
    model              TEXT,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    cost_usd           REAL,
    content_text       TEXT,
    cwd                TEXT,
    provenance         TEXT NOT NULL,
    run_id             TEXT,
    task_wbs           TEXT,
    imported_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_tool_call (
    record_hash   TEXT PRIMARY KEY,
    message_hash  TEXT NOT NULL,
    source        TEXT NOT NULL,
    source_file   TEXT NOT NULL,
    source_line   INTEGER NOT NULL,
    session_id    TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    tool_name     TEXT NOT NULL,
    args_digest   TEXT,
    args_raw      TEXT,
    status        TEXT NOT NULL,
    started_at    TEXT,
    completed_at  TEXT,
    duration_ms   INTEGER,
    result_bytes  INTEGER,
    error_text    TEXT,
    imported_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_message_session
    ON history_message(source, session_id, seq);
CREATE INDEX IF NOT EXISTS idx_history_message_ts
    ON history_message(ts);
CREATE INDEX IF NOT EXISTS idx_history_tool_call_session
    ON history_tool_call(source, session_id, seq);
CREATE INDEX IF NOT EXISTS idx_history_tool_call_tool_name
    ON history_tool_call(tool_name);
CREATE INDEX IF NOT EXISTS idx_history_tool_call_message_hash
    ON history_tool_call(message_hash);
`.trim();
