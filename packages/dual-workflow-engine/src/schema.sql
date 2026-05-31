CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workflow_name TEXT,
    mode TEXT,
    status TEXT NOT NULL,
    agent TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
);

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
