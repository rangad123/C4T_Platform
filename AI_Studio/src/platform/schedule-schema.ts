/**
 * Database schema of the schedules feature (migration slot 4 in db.ts). Kept in the feature's own file so
 * the shared migration list only references it. Times are stored as epoch milliseconds where the scheduler
 * compares them atomically (`next_run_at`), and as ISO strings everywhere a human or the API reads them.
 */
export const SCHEDULES_MIGRATION = `
CREATE TABLE schedules (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- 'validate' (re-run all tests) | 'generate' (analyze again)
    cadence_json TEXT NOT NULL,          -- {type:'interval',every,unit} | {type:'daily',time} | {type:'weekly',weekday,time}
    enabled INTEGER NOT NULL DEFAULT 1,
    retry_failures INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,                 -- epoch ms; compare-and-swap target for the atomic claim
    last_run_at TEXT, last_job_id TEXT,  -- the last run that actually started
    last_outcome TEXT, last_outcome_at TEXT,   -- last_outcome: started | skipped | error
    last_note TEXT,                      -- why the last tick skipped or failed (shown to the user)
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
CREATE TABLE alert_channels (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                  -- 'webhook' | 'slack'
    name TEXT NOT NULL,
    url_enc TEXT NOT NULL,               -- SecretBox-encrypted {url}; never returned by the API
    url_host TEXT NOT NULL,              -- the only part of the URL that is ever shown
    events_json TEXT NOT NULL,           -- subscribed events
    min_severity TEXT,                   -- overrides ALERT_MIN_SEVERITY for findings
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_channels_project ON alert_channels(project_id);
CREATE TABLE alert_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    channel_id TEXT, channel_name TEXT NOT NULL, channel_kind TEXT NOT NULL,
    event TEXT NOT NULL, job_id TEXT, status TEXT NOT NULL,   -- sent | failed
    http_status INTEGER, attempts INTEGER NOT NULL DEFAULT 1, error TEXT, summary TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_alert_log_project ON alert_log(project_id, id);
-- What each channel was last told per event, so an unchanged failure is not announced again.
CREATE TABLE alert_state (
    channel_id TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE, event TEXT NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY (channel_id, event)
);
CREATE TABLE run_summaries (
    job_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mode TEXT NOT NULL, trigger_kind TEXT NOT NULL, schedule_id TEXT, job_status TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    total INTEGER NOT NULL, validated INTEGER NOT NULL, needs_review INTEGER NOT NULL, failed INTEGER NOT NULL, flaky INTEGER NOT NULL,
    pass_rate REAL, duration_ms INTEGER,
    results_json TEXT NOT NULL,          -- compact per-test results (see trends.ts)
    diff_json TEXT NOT NULL              -- change versus what was known before this run
);
CREATE INDEX idx_run_summaries_project ON run_summaries(project_id, finished_at);
-- Run summaries and flaky detection read executions by job and by test.
CREATE INDEX idx_executions_job ON test_executions(job_id);
CREATE INDEX idx_executions_test ON test_executions(test_case_id, started_at);
`;
