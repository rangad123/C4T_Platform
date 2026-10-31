import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { SecretBox } from "../secrets.js";
import { SentryClient, type SentryConfig, type SentrySettings } from "./client.js";

const now = () => new Date().toISOString();

/** A Sentry connection as the API shows it: never the token. */
export interface PublicSentry {
    id: string;
    projectId: string;
    name: string;
    baseUrl: string;
    organization: string;
    project: string;
    createdAt: string;
}

/**
 * The project's Sentry connection. It lives in the `integrations` table next to the issue trackers (kind `sentry`), but
 * `IntegrationStore` only ever sees the tracker kinds, so Sentry is never offered as a place to create issues.
 * One connection per project; connecting again replaces it.
 */
export class SentryStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
    ) {}

    private row(projectId: string) {
        return this.db.get("SELECT * FROM integrations WHERE project_id = ? AND kind = 'sentry' ORDER BY created_at LIMIT 1", projectId);
    }

    get(projectId: string): PublicSentry | undefined {
        const r = this.row(projectId);
        if (!r) return undefined;
        const c = JSON.parse(r.config_json) as SentryConfig;
        return { id: r.id, projectId: r.project_id, name: r.name, baseUrl: c.baseUrl, organization: c.organization, project: c.project, createdAt: r.created_at };
    }

    /** Connect, or replace the connection. A token left out keeps the stored one (only when replacing). */
    save(projectId: string, s: Omit<SentrySettings, "token"> & { token?: string }): PublicSentry {
        const config: SentryConfig = { kind: "sentry", baseUrl: s.baseUrl, organization: s.organization, project: s.project };
        const name = `Sentry ${s.organization}/${s.project}`;
        const t = now();
        const existing = this.row(projectId);
        if (existing) {
            this.db.run("UPDATE integrations SET name = ?, config_json = ?, secret_enc = ?, updated_at = ? WHERE id = ?", name, JSON.stringify(config), s.token ? this.secrets.encrypt({ token: s.token }) : existing.secret_enc, t, existing.id);
        } else {
            if (!s.token) throw new Error("A token is needed to connect Sentry");
            this.db.run("INSERT INTO integrations (id, project_id, kind, name, config_json, secret_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", randomUUID(), projectId, "sentry", name, JSON.stringify(config), this.secrets.encrypt({ token: s.token }), t, t);
        }
        return this.get(projectId)!;
    }

    remove(projectId: string): boolean {
        return Number(this.db.run("DELETE FROM integrations WHERE project_id = ? AND kind = 'sentry'", projectId).changes) > 0;
    }

    /** A client for new names or address that reuses the stored token (the token was left out when changing a connection). */
    clientWith(projectId: string, cfg: SentryConfig, opts?: { timeoutMs?: number }): SentryClient | undefined {
        const r = this.row(projectId);
        return r ? new SentryClient(cfg, this.secrets.decrypt<{ token: string }>(r.secret_enc).token, opts) : undefined;
    }

    /** The client for the stored connection (decrypts the token for the duration of the call). */
    client(projectId: string, opts?: { timeoutMs?: number }): SentryClient | undefined {
        const r = this.row(projectId);
        if (!r) return undefined;
        return new SentryClient(JSON.parse(r.config_json), this.secrets.decrypt<{ token: string }>(r.secret_enc).token, opts);
    }
}
