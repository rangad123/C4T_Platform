/**
 * A project's database checks (Phase 4 D-c, docs/features/database-checks.md): the address of the customer's database probe
 * (examples/db-probe) and its token, and whether runs use it. Off by default: a project without a row, or with the switch off, has no
 * database layer. The token is encrypted with the platform's SecretBox and never leaves this file except into the engine's probe
 * (engine/database/remote.ts) for a run; the API says only whether one is saved.
 */
import type { DatabaseProbe } from "../engine/database/probe.js";
import { remoteDbProbe } from "../engine/database/remote.js";
import { guardedFetch } from "./guarded-fetch.js";
import type { SecretBox } from "./secrets.js";
import type { Sql } from "./sql.js";

/** Migration slot 70. */
export const DB_PROBE_MIGRATION = `
CREATE TABLE project_db_probes (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    url TEXT NOT NULL,
    token_enc TEXT NOT NULL,                  -- SecretBox-encrypted probe token; never returned by the API
    updated_at TEXT NOT NULL
);
`;

export interface DbProbeSetting {
    enabled: boolean;
    url: string;
    /** Whether a token is saved (the token itself is never returned). */
    tokenSaved: boolean;
}

export const DB_PROBE_OFF: DbProbeSetting = { enabled: false, url: "", tokenSaved: false };

export class DbProbeStore {
    constructor(
        private readonly sql: Sql,
        private readonly secrets: SecretBox,
    ) {}

    async get(projectId: string): Promise<DbProbeSetting> {
        const r = await this.sql.get<{ enabled: number; url: string }>("SELECT enabled, url FROM project_db_probes WHERE project_id = ?", projectId);
        return r ? { enabled: r.enabled === 1, url: r.url, tokenSaved: true } : DB_PROBE_OFF;
    }

    /** Saves the setting; no `token` keeps the saved one. With no address the setting is removed (off). */
    async set(projectId: string, v: { enabled: boolean; url: string; token?: string }): Promise<void> {
        if (!v.url) {
            await this.sql.run("DELETE FROM project_db_probes WHERE project_id = ?", projectId);
            return;
        }
        const at = new Date().toISOString();
        if (v.token) {
            await this.sql.run(
                "INSERT INTO project_db_probes (project_id, enabled, url, token_enc, updated_at) VALUES (?,?,?,?,?) ON CONFLICT (project_id) DO UPDATE SET enabled = excluded.enabled, url = excluded.url, token_enc = excluded.token_enc, updated_at = excluded.updated_at",
                projectId,
                v.enabled ? 1 : 0,
                v.url,
                this.secrets.encrypt(v.token),
                at,
            );
        } else await this.sql.run("UPDATE project_db_probes SET enabled = ?, url = ?, updated_at = ? WHERE project_id = ?", v.enabled ? 1 : 0, v.url, at, projectId);
    }

    /** The probe a run of this project uses, or undefined (off, none, or a token the current key cannot read). */
    async probeFor(projectId: string): Promise<DatabaseProbe | undefined> {
        const r = await this.sql.get<{ enabled: number; url: string; token_enc: string }>("SELECT enabled, url, token_enc FROM project_db_probes WHERE project_id = ?", projectId);
        if (!r || r.enabled !== 1) return undefined;
        let token: string;
        try {
            token = this.secrets.decrypt<string>(r.token_enc);
        } catch {
            return undefined;
        }
        return remoteDbProbe({ url: r.url, token, fetch: guardedFetch });
    }
}
