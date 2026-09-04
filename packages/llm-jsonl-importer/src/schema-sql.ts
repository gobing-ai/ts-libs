/**
 * Schema version of the history import DDL.
 *
 * Guaranteed to match the package version; a bump-or-fail test enforces that
 * any modification to HISTORY_IMPORT_SCHEMA_SQL must be accompanied by a version bump.
 */
export const HISTORY_IMPORT_SCHEMA_VERSION = '0.4.56';

/**
 * DDL string that creates the history import checkpoint, ledger, and typed contract tables.
 *
 * Generic `history_etl_*` blob tables are created lazily when an accepted record actually targets
 * one. Empty scans and typed built-in mappers therefore leave no empty per-source tables behind.
 */
export const HISTORY_IMPORT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_import_checkpoint (
    source TEXT NOT NULL,
    source_file TEXT NOT NULL,
    last_imported_line INTEGER NOT NULL DEFAULT 0,
    -- File identity (0675 R1): nullable so pre-migration rows self-heal on first read.
    source_size INTEGER,
    source_mtime_ms REAL,
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
    ts                 TEXT,
    duration_ms        INTEGER,
    duration_source    TEXT,
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
    request_id         TEXT,
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
    call_id       TEXT,
    args_digest   TEXT,
    args_raw      TEXT,
    status        TEXT NOT NULL,
    started_at    TEXT,
    completed_at  TEXT,
    duration_ms   INTEGER,
    result_bytes  INTEGER,
    error_text    TEXT,
    imported_at   TEXT NOT NULL,
    -- Tool identity (0739). Appended last so a database that gained these columns
    -- via Spur's guarded ALTER converges on the same PRAGMA column order as a
    -- database created fresh from this DDL. 'unknown' is the unresolved sentinel
    -- every consumer already falls back from.
    effective_tool_name TEXT NOT NULL DEFAULT 'unknown',
    tool_name_alias     TEXT NOT NULL DEFAULT 'unknown'
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

CREATE TABLE IF NOT EXISTS history_skill_call (
    record_hash     TEXT PRIMARY KEY,
    message_hash    TEXT NOT NULL,
    source          TEXT NOT NULL,
    source_file     TEXT NOT NULL,
    source_line     INTEGER NOT NULL,
    session_id      TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    skill_name      TEXT NOT NULL,
    invocation_kind TEXT NOT NULL CHECK (invocation_kind IN ('user', 'model')),
    skill_path      TEXT,
    args_raw        TEXT,
    args_digest     TEXT,
    call_id         TEXT,
    status          TEXT,
    started_at      TEXT,
    completed_at    TEXT,
    duration_ms     REAL,
    imported_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_skill_call_session
    ON history_skill_call(source, session_id, seq);
CREATE INDEX IF NOT EXISTS idx_history_skill_call_skill_name
    ON history_skill_call(skill_name);
CREATE INDEX IF NOT EXISTS idx_history_skill_call_message_hash
    ON history_skill_call(message_hash);
CREATE INDEX IF NOT EXISTS idx_history_skill_call_invocation_kind
    ON history_skill_call(invocation_kind);
`.trim();
