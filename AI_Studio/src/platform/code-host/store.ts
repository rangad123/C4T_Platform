import { randomUUID } from "node:crypto";
import type { Db, Row } from "../db.js";
import type { SecretBox } from "../secrets.js";
import { allowedApiBase, GITHUB_API, GithubCodeHost, type GithubCodeConfig } from "./github.js";

const now = () => new Date().toISOString();

/** A repository connection as the API shows it: never the token, never the webhook secret. */
export interface PublicCodeRepo {
    id: string;
    projectId: string;
    host: "github";
    name: string;
    owner: string;
    repo: string;
    apiUrl: string;
    webhookSecretSet: boolean;
    createdAt: string;
    updatedAt: string;
}

interface StoredConfig extends GithubCodeConfig {
    kind: "code";
    host: "github";
}
interface StoredSecret {
    token: string;
    webhookSecret?: string;
}

/**
 * The project's code repository (one per project; connecting again replaces it). It is kept the way the issue trackers keep theirs:
 * a row in the `integrations` table (kind `code`) with the token and webhook secret encrypted by the SecretBox. `IntegrationStore`
 * only sees tracker kinds, so this row is never offered as a place to file issues.
 * shortcut: lives in the integrations table until migration slot 72 adds code_repos (S3), which moves the row there.
 */
export class CodeHostStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
    ) {}

    private row(projectId: string): Row | undefined {
        return this.db.get("SELECT * FROM integrations WHERE project_id = ? AND kind = 'code' ORDER BY created_at LIMIT 1", projectId);
    }

    private secretOf(r: Row): StoredSecret {
        return this.secrets.decrypt<StoredSecret>(r.secret_enc);
    }

    get(projectId: string): PublicCodeRepo | undefined {
        const r = this.row(projectId);
        if (!r) return undefined;
        const c = JSON.parse(r.config_json) as StoredConfig;
        return { id: r.id, projectId: r.project_id, host: "github", name: r.name, owner: c.owner, repo: c.repo, apiUrl: c.apiUrl ?? GITHUB_API, webhookSecretSet: Boolean(this.secretOf(r).webhookSecret), createdAt: r.created_at, updatedAt: r.updated_at };
    }

    /** Connect, or replace the connection. A token or webhook secret left out keeps the stored one (only when replacing). */
    save(projectId: string, s: { owner: string; repo: string; apiUrl?: string; token?: string; webhookSecret?: string }): PublicCodeRepo {
        const apiUrl = allowedApiBase(s.apiUrl);
        const config: StoredConfig = { kind: "code", host: "github", owner: s.owner, repo: s.repo, ...(apiUrl !== GITHUB_API ? { apiUrl } : {}) };
        const name = `GitHub ${s.owner}/${s.repo}`;
        const existing = this.row(projectId);
        const before = existing ? this.secretOf(existing) : undefined;
        const token = s.token ?? before?.token;
        if (!token) throw new Error("A token is needed to connect a repository");
        const webhookSecret = s.webhookSecret ?? before?.webhookSecret;
        const secret_enc = this.secrets.encrypt({ token, ...(webhookSecret ? { webhookSecret } : {}) });
        const t = now();
        if (existing) this.db.run("UPDATE integrations SET name = ?, config_json = ?, secret_enc = ?, updated_at = ? WHERE id = ?", name, JSON.stringify(config), secret_enc, t, existing.id);
        else this.db.run("INSERT INTO integrations (id, project_id, kind, name, config_json, secret_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", randomUUID(), projectId, "code", name, JSON.stringify(config), secret_enc, t, t);
        return this.get(projectId)!;
    }

    remove(projectId: string): boolean {
        return Number(this.db.run("DELETE FROM integrations WHERE project_id = ? AND kind = 'code'", projectId).changes) > 0;
    }

    /** A client for other repository names that reuses the stored token (left out when changing a connection). */
    clientWith(projectId: string, cfg: GithubCodeConfig): GithubCodeHost | undefined {
        const r = this.row(projectId);
        return r ? new GithubCodeHost(cfg, this.secretOf(r).token) : undefined;
    }

    /** The client for the stored connection (decrypts the token for the duration of the calls). Throws "blocked" if its host is no longer allowed. */
    client(projectId: string): GithubCodeHost | undefined {
        const r = this.row(projectId);
        if (!r) return undefined;
        return new GithubCodeHost(JSON.parse(r.config_json) as StoredConfig, this.secretOf(r).token);
    }

    /** The webhook secret, for checking a delivery's signature (G2). */
    webhookSecret(projectId: string): string | undefined {
        const r = this.row(projectId);
        return r ? this.secretOf(r).webhookSecret : undefined;
    }
}
