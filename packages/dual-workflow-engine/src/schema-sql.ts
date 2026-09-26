/** SQL DDL for the dual-workflow engine's persistent schema — runs, phase_runs, transition_runs, workflow_states, and action_runs tables. */
export const WORKFLOW_ENGINE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workflow_name TEXT,
    mode TEXT,
    status TEXT NOT NULL,
    agent TEXT,
    external_key TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    owner_attempt TEXT,
    owner_pid INTEGER,
    interrupt_reason TEXT,
    terminal_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_external_key
    ON runs (workflow_name, external_key)
    WHERE external_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS phase_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS transition_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    trigger TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE TABLE IF NOT EXISTS workflow_states (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    state TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS action_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    ok INTEGER,
    result_json TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (run_id) REFERENCES runs(id)
);
`.trim();

/** Guarded ALTERs adding the 0.5.0 ownership/interruption columns for databases created before them. */
export const WORKFLOW_ENGINE_MIGRATIONS_SQL = `
ALTER TABLE runs ADD COLUMN owner_attempt TEXT;
ALTER TABLE runs ADD COLUMN owner_pid INTEGER;
ALTER TABLE runs ADD COLUMN interrupt_reason TEXT;
ALTER TABLE runs ADD COLUMN terminal_reason TEXT;
`.trim();
