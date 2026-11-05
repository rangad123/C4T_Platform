/**
 * What a project's testing agents need, as saved on its Requirements tab (routes/agent-inputs.ts): the sign-in, the API access, the
 * OpenAPI document address and whether API tests may change data. One row per project, written ONLY by PUT /agent-inputs; an
 * exploration reads it and never writes it, so a person who may explore but may not change settings cannot replace what is saved.
 *
 * The row names the site it was saved for (`site`): its secrets are only ever used for that site (and the addresses saved with them).
 * Secrets are encrypted with the platform's SecretBox, like the application rows' credentials, and are write-only: the API only says
 * whether one is saved. An unreadable blob (the encryption key changed) counts as nothing saved.
 */
import type { Db } from "./db.js";
import type { Credentials } from "./repo.js";
import type { SecretBox } from "./secrets.js";
import { sqliteDialect, type Dialect } from "./sql-dialect.js";

/**
 * Migration slot 50. Until it, the saved inputs were the project's latest application row (every exploration wrote a new one), so each
 * existing project starts with exactly what its latest application holds: the address as the site, the encrypted credentials copied as
 * they are (the same key encrypts both), and that row's settings, of which only `openApiUrl` and `allowMutatingApiTests` are read.
 */
export const agentInputsMigration = (d: Dialect = sqliteDialect): string => `
CREATE TABLE project_agent_inputs (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    site TEXT NOT NULL,                   -- the application address they were saved for: used on that site only
    credentials_enc TEXT,                 -- SecretBox-encrypted {username,password,totpSecret,apiToken,apiAuthHeader,oauth2}; never returned by the API
    settings_json TEXT NOT NULL,          -- {openApiUrl, allowMutatingApiTests}
    updated_at TEXT NOT NULL
);
INSERT INTO project_agent_inputs (project_id, site, credentials_enc, settings_json, updated_at)
SELECT a.project_id, a.url, a.credentials_enc, a.config_json, a.created_at FROM applications a
WHERE a.id = (SELECT b.id FROM applications b WHERE b.project_id = a.project_id ORDER BY b.created_at DESC, ${d.insertionOrder("b")} DESC LIMIT 1);
`;

export interface SavedAgentInputs {
    /** The application address they were saved for. */
    site: string;
    credentials?: Credentials;
    openApiUrl?: string;
    allowMutatingApiTests?: boolean;
    updatedAt: string;
}

export class AgentInputsStore {
    constructor(
        private readonly db: Db,
        private readonly box: SecretBox,
    ) {}

    get(projectId: string): SavedAgentInputs | undefined {
        const r = this.db.get<{ site: string; credentials_enc: string | null; settings_json: string; updated_at: string }>("SELECT site, credentials_enc, settings_json, updated_at FROM project_agent_inputs WHERE project_id = ?", projectId);
        if (!r) return undefined;
        let credentials: Credentials | undefined;
        try {
            credentials = r.credentials_enc ? this.box.decrypt<Credentials>(r.credentials_enc) : undefined;
        } catch {
            credentials = undefined; // the encryption key changed: as if none were saved
        }
        let settings: { openApiUrl?: unknown; allowMutatingApiTests?: unknown } = {};
        try {
            settings = JSON.parse(r.settings_json) ?? {};
        } catch {
            settings = {};
        }
        return {
            site: r.site,
            ...(credentials && Object.values(credentials).some(Boolean) ? { credentials } : {}),
            ...(typeof settings.openApiUrl === "string" && settings.openApiUrl ? { openApiUrl: settings.openApiUrl } : {}),
            ...(typeof settings.allowMutatingApiTests === "boolean" ? { allowMutatingApiTests: settings.allowMutatingApiTests } : {}),
            updatedAt: r.updated_at,
        };
    }

    /** Replaces what the project has saved (only PUT /agent-inputs calls this). */
    save(projectId: string, v: { site: string; credentials?: Credentials; openApiUrl?: string; allowMutatingApiTests?: boolean }): void {
        const has = v.credentials && Object.values(v.credentials).some(Boolean);
        const settings = JSON.stringify({ ...(v.openApiUrl ? { openApiUrl: v.openApiUrl } : {}), ...(v.allowMutatingApiTests !== undefined ? { allowMutatingApiTests: v.allowMutatingApiTests } : {}) });
        this.db.run(
            `INSERT INTO project_agent_inputs (project_id, site, credentials_enc, settings_json, updated_at) VALUES (?,?,?,?,?)
             ON CONFLICT (project_id) DO UPDATE SET site = excluded.site, credentials_enc = excluded.credentials_enc, settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
            projectId,
            v.site,
            has ? this.box.encrypt(v.credentials) : null,
            settings,
            new Date().toISOString(),
        );
    }
}
