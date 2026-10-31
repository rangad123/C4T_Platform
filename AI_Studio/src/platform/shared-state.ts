/**
 * Small pieces of state every platform process must see, kept in the database instead of files in DATA_DIR: the API and the worker will not
 * share a disk once they run as separate containers (docs/product-restructure/POSTGRES_S3_MIGRATION.md §4.1).
 *
 * - `ops_heartbeats`: the worker's "I am alive" note for GET /readyz (ops/heartbeat.ts).
 * - `runner_update_settings`: per runner, "update automatically" and a pending "Update this runner" request (runner-update.ts). The file the
 *   earlier release kept, `<DATA_DIR>/runner-updates.json`, is read once into the table when the table is empty and left in place, so a
 *   rollback to that release still finds it.
 *
 * Written in the portable subset (TEXT, BIGINT, SMALLINT; upserts with ON CONFLICT), so the same SQL runs on PostgreSQL.
 */
export const SHARED_STATE_MIGRATION = `
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
`;
