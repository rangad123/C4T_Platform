-- AI Studio: PostgreSQL baseline schema (POSTGRES_S3_MIGRATION.md §5.3).
--
-- Equal to SQLite migration slots 1-37 plus the schema changes made outside them (§1.3: addActorColumns,
-- addCacheColumns, ensureScannerTables). A PostgreSQL database starts here and records schema_version 37;
-- later slots are written in the portable subset. tests/pg-baseline-unit.test.ts compares this file with a fresh SQLite database,
-- so a new SQLite migration without a change here fails the fast tier.
--
-- Mapping (§1.2, phase 1): every INTEGER is BIGINT (epoch milliseconds overflow INTEGER); 0/1 flags stay numbers; REAL is
-- DOUBLE PRECISION (SQLite's REAL is 8 bytes, PostgreSQL's is 4); dates and JSON stay TEXT. AUTOINCREMENT ids are identity
-- columns BY DEFAULT, so the copy tool can keep the ids. The tables ordered by insertion (`db.dialect.insertionOrder`) get a
-- `seq` identity column, which the copy fills from SQLite's rowid. Create the database with LC_COLLATE 'C' so text sorts as on SQLite.

CREATE TABLE schema_version (
    version BIGINT NOT NULL
);

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL,
    role TEXT,
    password_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    sso_subject TEXT,
    last_sign_in_at TEXT,
    updated_at TEXT,
    project_access TEXT NOT NULL DEFAULT 'all',
    c4t_role TEXT,
    organization_id TEXT,
    UNIQUE (email)
);

CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT,
    synced_at TEXT NOT NULL
);

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    organization_id TEXT REFERENCES organizations(id),
    platforms TEXT NOT NULL DEFAULT '["web"]',
    testing_modes TEXT NOT NULL DEFAULT '["agent","code"]',
    code_engines TEXT NOT NULL DEFAULT '{"web":"playwright"}',
    c4t_project_id TEXT
);
CREATE INDEX idx_projects_organization ON projects (organization_id);

CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    origin TEXT NOT NULL,
    config_json TEXT NOT NULL,
    credentials_enc TEXT,
    app_model_json TEXT,
    model_updated_at TEXT,
    created_at TEXT NOT NULL,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE environments (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_base_url TEXT,
    variables_json TEXT,
    is_default BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE test_suites (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, slug)
);

CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    options_json TEXT NOT NULL,
    progress_json TEXT NOT NULL,
    counters_json TEXT NOT NULL,
    error TEXT,
    attempts BIGINT NOT NULL DEFAULT 0,
    lease_until BIGINT,
    cancel_requested BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    lease_owner TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_jobs_status ON generation_jobs (status, created_at);

CREATE TABLE test_cases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    suite_id TEXT NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
    test_key TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    type TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    validation_status TEXT NOT NULL,
    validation_reason TEXT,
    framework TEXT NOT NULL,
    attempts BIGINT NOT NULL DEFAULT 0,
    spec_json TEXT NOT NULL,
    generation_meta_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, test_key)
);
CREATE INDEX idx_tests_project ON test_cases (project_id, validation_status);

CREATE TABLE generated_scripts (
    id TEXT PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    framework TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    storage_path TEXT,
    version BIGINT NOT NULL,
    is_current BIGINT NOT NULL DEFAULT 1,
    executable BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_scripts_test ON generated_scripts (test_case_id, is_current);
CREATE UNIQUE INDEX idx_scripts_version ON generated_scripts (test_case_id, framework, version);

CREATE TABLE test_executions (
    id TEXT PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    script_id TEXT REFERENCES generated_scripts(id) ON DELETE SET NULL,
    job_id TEXT,
    attempt BIGINT NOT NULL,
    status TEXT NOT NULL,
    duration_ms BIGINT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    variant TEXT,
    environment TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_exec_environment ON test_executions (test_case_id, environment);
CREATE INDEX idx_exec_variant ON test_executions (test_case_id, variant);
CREATE INDEX idx_executions_job ON test_executions (job_id);
CREATE INDEX idx_executions_test ON test_executions (test_case_id, started_at);

CREATE TABLE test_execution_steps (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES test_executions(id) ON DELETE CASCADE,
    idx BIGINT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT
);

CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    subject TEXT,
    status TEXT NOT NULL,
    summary TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE agent_actions (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    args_json TEXT,
    ok BIGINT NOT NULL,
    observation TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE agent_events (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    kind TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_events_job ON agent_events (job_id, id);

CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_id TEXT,
    test_case_id TEXT,
    execution_id TEXT,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    size BIGINT,
    created_at TEXT NOT NULL,
    pruned_at TEXT,
    pruned_reason TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_artifacts_project_pruned ON artifacts (project_id, pruned_at);
CREATE INDEX idx_artifacts_test ON artifacts (test_case_id);

CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    cadence_json TEXT NOT NULL,
    enabled BIGINT NOT NULL DEFAULT 1,
    retry_failures BIGINT NOT NULL DEFAULT 1,
    next_run_at BIGINT,
    last_run_at TEXT,
    last_job_id TEXT,
    last_outcome TEXT,
    last_outcome_at TEXT,
    last_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    environment TEXT,
    confirm_production BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX idx_schedules_due ON schedules (enabled, next_run_at);

CREATE TABLE alert_channels (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    url_enc TEXT NOT NULL,
    url_host TEXT NOT NULL,
    events_json TEXT NOT NULL,
    min_severity TEXT,
    enabled BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_channels_project ON alert_channels (project_id);

CREATE TABLE alert_log (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    channel_id TEXT,
    channel_name TEXT NOT NULL,
    channel_kind TEXT NOT NULL,
    event TEXT NOT NULL,
    job_id TEXT,
    status TEXT NOT NULL,
    http_status BIGINT,
    attempts BIGINT NOT NULL DEFAULT 1,
    error TEXT,
    summary TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_alert_log_project ON alert_log (project_id, id);

CREATE TABLE alert_state (
    channel_id TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (channel_id, event)
);

CREATE TABLE run_summaries (
    job_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    schedule_id TEXT,
    job_status TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    total BIGINT NOT NULL,
    validated BIGINT NOT NULL,
    needs_review BIGINT NOT NULL,
    failed BIGINT NOT NULL,
    flaky BIGINT NOT NULL,
    pass_rate DOUBLE PRECISION,
    duration_ms BIGINT,
    results_json TEXT NOT NULL,
    diff_json TEXT NOT NULL,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_run_summaries_project ON run_summaries (project_id, finished_at);

CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_integrations_project ON integrations (project_id);

CREATE TABLE issue_links (
    id TEXT PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_issue_links_once ON issue_links (test_case_id, integration_id) WHERE integration_id IS NOT NULL;
CREATE INDEX idx_issue_links_test ON issue_links (test_case_id);

CREATE TABLE perf_metrics (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    execution_id TEXT,
    metric TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    unit TEXT NOT NULL,
    budget DOUBLE PRECISION,
    at TEXT NOT NULL
);
CREATE INDEX idx_perf_project ON perf_metrics (project_id, at);
CREATE INDEX idx_perf_test ON perf_metrics (test_case_id, at);

CREATE TABLE project_roles (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    roles_enc TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE api_snapshots (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    complete BIGINT NOT NULL,
    operations_json TEXT NOT NULL,
    UNIQUE (project_id, job_id)
);
CREATE INDEX idx_api_snapshots_project ON api_snapshots (project_id, id);

CREATE TABLE site_memory (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin TEXT NOT NULL,
    version BIGINT NOT NULL,
    updated_at TEXT NOT NULL,
    job_id TEXT,
    size_bytes BIGINT NOT NULL,
    knowledge_json TEXT NOT NULL,
    changes_json TEXT,
    PRIMARY KEY (project_id, origin)
);

CREATE TABLE project_environments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_base_url TEXT,
    production BIGINT NOT NULL DEFAULT 0,
    is_default BIGINT NOT NULL DEFAULT 0,
    use_project_accounts BIGINT NOT NULL DEFAULT 1,
    variables_json TEXT NOT NULL DEFAULT '{}',
    secrets_enc TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, name)
);

CREATE TABLE test_data_sets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    rows_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, name)
);

CREATE TABLE healing_proposals (
    id TEXT PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    job_id TEXT,
    step_index BIGINT NOT NULL,
    old_locator_json TEXT NOT NULL,
    new_locator_json TEXT NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    confidence_label TEXT NOT NULL,
    reason TEXT NOT NULL,
    old_description TEXT NOT NULL,
    new_description TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_healing_test ON healing_proposals (test_case_id, status);

CREATE TABLE trigger_tokens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT,
    token_hash TEXT NOT NULL,
    hint TEXT NOT NULL,
    allow_url BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    last_run_at BIGINT,
    revoked_at TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY,
    UNIQUE (token_hash)
);
CREATE INDEX idx_trigger_tokens_project ON trigger_tokens (project_id);

CREATE TABLE trigger_runs (
    job_id TEXT PRIMARY KEY REFERENCES generation_jobs(id) ON DELETE CASCADE,
    token_id TEXT NOT NULL REFERENCES trigger_tokens(id) ON DELETE CASCADE,
    commit_sha TEXT,
    environment TEXT,
    callback_enc TEXT,
    callback_state TEXT NOT NULL,
    callback_detail TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_trigger_runs_token ON trigger_runs (token_id);

CREATE TABLE cleanup_ledger (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    test_case_id TEXT REFERENCES test_cases(id) ON DELETE SET NULL,
    test_key TEXT NOT NULL,
    seq BIGINT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    record_id TEXT NOT NULL,
    delete_path TEXT,
    origin TEXT,
    environment TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    attempts BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    cleaned_at TEXT
);
CREATE INDEX idx_cleanup_project ON cleanup_ledger (project_id, id);
CREATE INDEX idx_cleanup_test ON cleanup_ledger (test_case_id, id);

CREATE TABLE cleanup_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    cleanup_after BIGINT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE runbooks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_runbooks_project ON runbooks (project_id);

CREATE TABLE runbook_runs (
    id TEXT PRIMARY KEY,
    runbook_id TEXT NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    runbook_name TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    any_failure BIGINT NOT NULL DEFAULT 0,
    trigger_kind TEXT NOT NULL,
    trigger_ref TEXT,
    trigger_label TEXT,
    owner TEXT NOT NULL,
    heartbeat_at BIGINT NOT NULL,
    cancel_requested BIGINT NOT NULL DEFAULT 0,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE UNIQUE INDEX idx_runbook_runs_one_active ON runbook_runs (project_id) WHERE status = 'running';
CREATE INDEX idx_runbook_runs_runbook ON runbook_runs (runbook_id, created_at);

CREATE TABLE runbook_run_steps (
    run_id TEXT NOT NULL REFERENCES runbook_runs(id) ON DELETE CASCADE,
    idx BIGINT NOT NULL,
    step_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    job_id TEXT,
    reason TEXT,
    measured TEXT,
    detail_json TEXT,
    started_at TEXT,
    finished_at TEXT,
    PRIMARY KEY (run_id, idx)
);

CREATE TABLE runbook_schedule_links (
    schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
    runbook_id TEXT NOT NULL
);

CREATE TABLE runbook_token_links (
    token_id TEXT PRIMARY KEY REFERENCES trigger_tokens(id) ON DELETE CASCADE,
    runbook_id TEXT NOT NULL
);

CREATE TABLE manual_cases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    area TEXT NOT NULL,
    priority TEXT NOT NULL,
    requirement TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL,
    linked_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_manual_cases_project ON manual_cases (project_id);

CREATE TABLE releases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    snapshot_json TEXT,
    snapshot_at TEXT,
    frozen_json TEXT,
    signed_at TEXT,
    signed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_releases_project ON releases (project_id, created_at);

CREATE TABLE release_results (
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL REFERENCES manual_cases(id) ON DELETE CASCADE,
    result TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    by_name TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    issue_provider TEXT,
    issue_external_id TEXT,
    issue_url TEXT,
    PRIMARY KEY (release_id, case_id)
);

CREATE TABLE release_audit (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    by_name TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    override BIGINT NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL,
    actor TEXT
);
CREATE INDEX idx_release_audit ON release_audit (release_id, id);

CREATE TABLE retention_policies (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    enabled BIGINT NOT NULL DEFAULT 0,
    keep_days BIGINT NOT NULL,
    keep_failed_days BIGINT NOT NULL,
    keep_latest_runs BIGINT NOT NULL,
    max_artifact_mb BIGINT,
    updated_at TEXT NOT NULL
);

CREATE TABLE retention_log (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    files BIGINT NOT NULL,
    bytes BIGINT NOT NULL,
    errors BIGINT NOT NULL DEFAULT 0,
    error_sample TEXT
);
CREATE INDEX idx_retention_log_project ON retention_log (project_id, id);

CREATE TABLE restore_needs (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_restore_needs_project ON restore_needs (project_id);

CREATE TABLE ai_usage (
    job_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    day TEXT NOT NULL,
    calls BIGINT NOT NULL DEFAULT 0,
    failed_calls BIGINT NOT NULL DEFAULT 0,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    images BIGINT NOT NULL DEFAULT 0,
    estimated_calls BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens BIGINT NOT NULL DEFAULT 0,
    cache_write_tokens BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, purpose, model, day)
);
CREATE INDEX idx_ai_usage_day ON ai_usage (day, project_id);
CREATE INDEX idx_ai_usage_project ON ai_usage (project_id, day);

CREATE TABLE ai_prices (
    model TEXT PRIMARY KEY,
    input_per_mtok DOUBLE PRECISION NOT NULL,
    output_per_mtok DOUBLE PRECISION NOT NULL,
    updated_at TEXT NOT NULL,
    cached_input_per_mtok DOUBLE PRECISION,
    cache_write_per_mtok DOUBLE PRECISION
);

CREATE TABLE ai_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE ai_project_budgets (
    project_id TEXT PRIMARY KEY,
    month_tokens BIGINT,
    job_tokens BIGINT,
    updated_at TEXT NOT NULL
);

CREATE TABLE ai_budget_stops (
    job_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    cap TEXT NOT NULL,
    used BIGINT NOT NULL,
    limit_tokens BIGINT NOT NULL,
    at TEXT NOT NULL
);
CREATE INDEX idx_ai_stops_project ON ai_budget_stops (project_id, at);

CREATE TABLE quarantine_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    by_name TEXT NOT NULL,
    since TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT,
    ended_at TEXT,
    ended_by TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE UNIQUE INDEX idx_quarantine_one_active ON quarantine_entries (test_id) WHERE status = 'active';
CREATE INDEX idx_quarantine_project ON quarantine_entries (project_id, status);

CREATE TABLE quarantine_history (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    test_id TEXT NOT NULL,
    test_key TEXT NOT NULL,
    title TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    by_name TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_quarantine_history ON quarantine_history (project_id, id);
CREATE INDEX idx_quarantine_history_test ON quarantine_history (test_id, id);

CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT,
    token_hash TEXT NOT NULL,
    hint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    last_used_ms BIGINT,
    revoked_at TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY,
    UNIQUE (token_hash)
);
CREATE INDEX idx_agent_tokens_project ON agent_tokens (project_id);

CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token_id TEXT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    os TEXT NOT NULL,
    arch TEXT NOT NULL,
    node TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    concurrency BIGINT NOT NULL,
    first_seen_ms BIGINT NOT NULL,
    last_seen_ms BIGINT NOT NULL,
    UNIQUE (token_id, name)
);
CREATE INDEX idx_agents_project ON agents (project_id, last_seen_ms);

CREATE TABLE runner_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    run_on TEXT NOT NULL,
    agent_id TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE agent_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    status TEXT NOT NULL,
    agent_id TEXT,
    payload_enc TEXT NOT NULL,
    result_enc TEXT,
    error TEXT,
    offers BIGINT NOT NULL DEFAULT 0,
    cancel_requested BIGINT NOT NULL DEFAULT 0,
    lease_until BIGINT,
    last_beat_ms BIGINT,
    progress_done BIGINT,
    progress_total BIGINT,
    log_json TEXT NOT NULL DEFAULT '[]',
    created_ms BIGINT NOT NULL,
    claimed_ms BIGINT,
    finished_ms BIGINT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_agent_tasks_job ON agent_tasks (job_id);
CREATE INDEX idx_agent_tasks_queue ON agent_tasks (project_id, status, created_ms);

CREATE TABLE agent_task_files (
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    ref TEXT NOT NULL,
    path TEXT NOT NULL,
    size BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (task_id, direction, ref)
);

CREATE TABLE locator_elements (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    page TEXT,
    locator_json TEXT NOT NULL,
    notes TEXT,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, name_key)
);
CREATE INDEX idx_locator_elements_name ON locator_elements (project_id, name);

CREATE TABLE locator_usage (
    element_id TEXT NOT NULL REFERENCES locator_elements(id) ON DELETE CASCADE,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    steps BIGINT NOT NULL DEFAULT 1,
    PRIMARY KEY (element_id, test_case_id)
);
CREATE INDEX idx_locator_usage_test ON locator_usage (test_case_id);

CREATE TABLE framework_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE framework_settings_log (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    by TEXT,
    summary TEXT NOT NULL
);
CREATE INDEX idx_framework_log_project ON framework_settings_log (project_id, id);

CREATE TABLE custom_tests (
    test_case_id TEXT PRIMARY KEY REFERENCES test_cases(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin TEXT NOT NULL,
    since TEXT NOT NULL,
    spec_json TEXT,
    git_json TEXT,
    imports_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_custom_tests_project ON custom_tests (project_id);

CREATE TABLE custom_script_versions (
    id TEXT PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    version BIGINT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    note TEXT,
    by_who TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (test_case_id, version)
);

CREATE TABLE custom_helpers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    imports_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, name)
);

CREATE TABLE custom_audit (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_case_id TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL,
    actor TEXT
);
CREATE INDEX idx_custom_audit_project ON custom_audit (project_id, id);

CREATE TABLE git_repos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    path TEXT NOT NULL,
    ref TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    url TEXT,
    subpath TEXT
);
CREATE INDEX idx_git_repos_project ON git_repos (project_id);

CREATE TABLE spec_versions (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    version BIGINT NOT NULL,
    spec_json TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (test_case_id, version)
);

CREATE TABLE live_session_audit (
    recording_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    start_url TEXT NOT NULL,
    runner TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    actions BIGINT NOT NULL DEFAULT 0,
    refused BIGINT NOT NULL DEFAULT 0,
    snapshots BIGINT NOT NULL DEFAULT 0,
    actor TEXT
);
CREATE INDEX idx_live_session_audit_project ON live_session_audit (project_id, opened_at);

CREATE TABLE step_blocks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL,
    params_json TEXT NOT NULL,
    steps_json TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, name_key)
);
CREATE INDEX idx_step_blocks_project ON step_blocks (project_id);

CREATE TABLE user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    via TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    user_agent TEXT
);
CREATE INDEX idx_user_sessions_user ON user_sessions (user_id);

CREATE TABLE user_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    hint TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    UNIQUE (token_hash)
);
CREATE INDEX idx_user_tokens_user ON user_tokens (user_id);

CREATE TABLE user_invites (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at TEXT
);
CREATE INDEX idx_user_invites_user ON user_invites (user_id);

CREATE TABLE activity (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    at TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    path TEXT,
    project_id TEXT,
    status BIGINT,
    detail TEXT
);
CREATE INDEX idx_activity_actor ON activity (actor_id, id);
CREATE INDEX idx_activity_project ON activity (project_id, id);

CREATE TABLE auth_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    secret_enc TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE oidc_pending (
    state TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE device_farms (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    secrets_enc TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_device_farms_project ON device_farms (project_id);

CREATE TABLE device_farm_choice (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    run_on TEXT NOT NULL,
    farm_id TEXT,
    parallel BIGINT NOT NULL DEFAULT 1,
    matrix BIGINT NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE device_farm_sessions (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT,
    test_id TEXT NOT NULL,
    farm_id TEXT,
    provider TEXT NOT NULL,
    device TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    link TEXT,
    at TEXT NOT NULL
);
CREATE INDEX idx_device_farm_sessions_project ON device_farm_sessions (project_id, id);

CREATE TABLE saved_sessions (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    account TEXT NOT NULL,
    state_enc TEXT NOT NULL,
    app_url TEXT NOT NULL,
    check_url TEXT NOT NULL,
    expires_at TEXT,
    saved_at TEXT NOT NULL,
    how TEXT NOT NULL,
    checked_at TEXT,
    check_ok BIGINT,
    check_note TEXT,
    PRIMARY KEY (project_id, account)
);

CREATE TABLE test_mailboxes (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    config_enc TEXT NOT NULL,
    token_hash TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (token_hash)
);

CREATE TABLE inbound_mail (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    to_addrs TEXT NOT NULL,
    received_at BIGINT NOT NULL,
    mail_enc TEXT NOT NULL
);
CREATE INDEX idx_inbound_mail_project ON inbound_mail (project_id, received_at);

CREATE TABLE eval_runs (
    id TEXT PRIMARY KEY,
    corpus TEXT NOT NULL,
    plan_only BIGINT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    overall_json TEXT NOT NULL,
    run_json TEXT NOT NULL
);
CREATE INDEX idx_eval_runs_corpus ON eval_runs (corpus, plan_only, started_at);

CREATE TABLE test_files (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size BIGINT NOT NULL,
    content_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, name)
);

CREATE TABLE test_data_reset (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment TEXT NOT NULL DEFAULT '',
    enabled BIGINT NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    header_names TEXT NOT NULL DEFAULT '[]',
    headers_enc TEXT,
    expected_status BIGINT NOT NULL,
    last_ok BIGINT,
    last_message TEXT,
    last_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, environment)
);

CREATE TABLE security_applications (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_url TEXT NOT NULL,
    environment TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    excluded_paths_json TEXT NOT NULL,
    max_rps BIGINT NOT NULL,
    api_spec_url TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_sec_apps_project ON security_applications (project_id, created_at);

CREATE TABLE security_authorizations (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES security_applications(id) ON DELETE CASCADE,
    basis TEXT NOT NULL,
    approver_name TEXT NOT NULL,
    approver_email TEXT,
    document_reference TEXT,
    restrictions TEXT,
    statement TEXT NOT NULL,
    confirmed_by_user_id TEXT,
    confirmed_by_name TEXT NOT NULL,
    confirmed_at TEXT NOT NULL,
    scope_fingerprint TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT,
    revoked_reason TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_sec_auth_app ON security_authorizations (application_id, confirmed_at);

CREATE TABLE security_assessments (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES security_applications(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    authorization_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'passive',
    state TEXT NOT NULL,
    progress BIGINT NOT NULL DEFAULT 0,
    progress_text TEXT NOT NULL DEFAULT '',
    coverage_json TEXT,
    error TEXT,
    started_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    retest_of TEXT,
    cancel_requested BIGINT NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_until BIGINT,
    heartbeat_at TEXT,
    work_json TEXT,
    approval_json TEXT,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_sec_assess_app ON security_assessments (application_id, created_at);
CREATE INDEX idx_sec_assess_project ON security_assessments (project_id, created_at);
CREATE INDEX idx_sec_assess_state ON security_assessments (state);

CREATE TABLE security_findings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES security_applications(id) ON DELETE CASCADE,
    first_assessment_id TEXT REFERENCES security_assessments(id) ON DELETE SET NULL,
    last_assessment_id TEXT REFERENCES security_assessments(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL,
    check_id TEXT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    impact TEXT NOT NULL,
    remediation TEXT NOT NULL,
    reproduction TEXT,
    evidence_json TEXT NOT NULL,
    source TEXT NOT NULL,
    ai_note TEXT,
    validation TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_by TEXT,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_sec_find_fp ON security_findings (application_id, fingerprint);
CREATE INDEX idx_sec_find_last ON security_findings (last_assessment_id);
CREATE INDEX idx_sec_find_project ON security_findings (project_id, last_seen_at);
CREATE INDEX idx_sec_find_severity ON security_findings (project_id, severity);
CREATE INDEX idx_sec_find_validation ON security_findings (project_id, validation);

CREATE TABLE security_finding_history (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    finding_id TEXT NOT NULL REFERENCES security_findings(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_id TEXT,
    from_validation TEXT,
    to_validation TEXT,
    comment TEXT,
    assessment_id TEXT
);
CREATE INDEX idx_sec_hist_finding ON security_finding_history (finding_id, id);

CREATE TABLE security_finding_sightings (
    finding_id TEXT NOT NULL REFERENCES security_findings(id) ON DELETE CASCADE,
    assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
    seen_at TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    PRIMARY KEY (finding_id, assessment_id)
);
CREATE INDEX idx_sec_sight_assessment ON security_finding_sightings (assessment_id);

CREATE TABLE security_audit (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    at TEXT NOT NULL,
    project_id TEXT NOT NULL,
    application_id TEXT,
    actor_kind TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT,
    summary TEXT NOT NULL
);
CREATE INDEX idx_sec_audit_project ON security_audit (project_id, id);

CREATE TABLE security_project_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    testing_type TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE user_projects (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    project_admin BIGINT NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'added',
    added_by TEXT,
    PRIMARY KEY (user_id, project_id)
);
CREATE INDEX idx_user_projects_project ON user_projects (project_id);

CREATE TABLE security_application_extras (
    application_id TEXT PRIMARY KEY REFERENCES security_applications(id) ON DELETE CASCADE,
    signin_account TEXT,
    sensitive_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);

CREATE TABLE security_api_documents (
    application_id TEXT PRIMARY KEY REFERENCES security_applications(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    format TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    content TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    uploaded_by TEXT NOT NULL
);

CREATE TABLE ops_heartbeats (
    name TEXT PRIMARY KEY,
    at BIGINT NOT NULL,
    pid BIGINT
);

CREATE TABLE runner_update_settings (
    agent_id TEXT PRIMARY KEY,
    auto SMALLINT,
    requested_at BIGINT,
    reported TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE security_scan_runs (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES security_applications(id) ON DELETE CASCADE,
    scanner TEXT NOT NULL,
    profile TEXT NOT NULL,
    state TEXT NOT NULL,
    reference TEXT,
    started_at TEXT,
    finished_at TEXT,
    took_ms BIGINT,
    findings_count BIGINT NOT NULL DEFAULT 0,
    error TEXT,
    coverage_json TEXT NOT NULL DEFAULT '{}',
    approval_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_sec_scanrun_assessment ON security_scan_runs (assessment_id, created_at);
CREATE INDEX idx_sec_scanrun_project ON security_scan_runs (project_id, created_at);
CREATE INDEX idx_sec_scanrun_scanner ON security_scan_runs (scanner, created_at);

CREATE TABLE security_scanner_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    enabled_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);
