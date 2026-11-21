import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db, Row } from "../db.js";
import type { SecretBox } from "../secrets.js";
import { sqliteDialect, type Dialect } from "../sql-dialect.js";
import { allowedApiBase, GITHUB_API, GithubCodeHost, type GithubCodeConfig } from "./github.js";

/**
 * Migration slot 72 (Phase 6): the project's code repository, the webhook deliveries it received and the tests chosen per pull request.
 * A connection G1 kept in `integrations` (kind `code`) moves to code_repos with its encrypted token and webhook secret as they were;
 * the earliest one per project when there were several (portable SQL: the dialect gives the JSON read). Its webhook address comes with the next save (none existed before).
 */
export const codeHostMigration = (d: Dialect = sqliteDialect): string => `
CREATE TABLE code_repos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    host TEXT NOT NULL,                   -- github
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    api_url TEXT,                         -- null: https://api.github.com
    secret_enc TEXT NOT NULL,             -- SecretBox: the token and the webhook secret; never returned
    hook_token_hash TEXT UNIQUE,          -- SHA-256 of the token in the webhook address; null until the connection is saved again
    feedback INTEGER NOT NULL DEFAULT 0,  -- the project's switch: post the pull request comment and check
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
INSERT INTO code_repos (id, project_id, host, owner, repo, api_url, secret_enc, created_at, updated_at)
    SELECT id, project_id, 'github', ${d.jsonText("config_json", "owner")}, ${d.jsonText("config_json", "repo")}, ${d.jsonText("config_json", "apiUrl")}, secret_enc, created_at, updated_at
    FROM integrations WHERE kind = 'code' ORDER BY created_at, id
    ON CONFLICT DO NOTHING;
DELETE FROM integrations WHERE kind = 'code';
CREATE TABLE pr_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL,            -- X-GitHub-Delivery: the same delivery twice acts once
    event TEXT NOT NULL,                  -- pull_request deployment_status ...
    action TEXT,
    pr INTEGER,
    head_sha TEXT,
    environment TEXT,                     -- deployment_status: the deployment's environment
    queued TEXT,                          -- impact reverify, or null when the delivery asked for nothing
    ignored TEXT,                         -- why nothing was queued
    received_at TEXT NOT NULL,
    UNIQUE (project_id, delivery_id)
);
CREATE INDEX idx_pr_events_pr ON pr_events (project_id, pr);
CREATE TABLE pr_selections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pr INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    mode TEXT NOT NULL,                   -- focused full
    selected_json TEXT NOT NULL,          -- the chosen test ids
    reasons_json TEXT NOT NULL,           -- per test, the evidence that chose it
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_pr_selections_pr ON pr_selections (project_id, pr, head_sha);
`;

const now = () => new Date().toISOString();
export const HOOK_TOKEN_PREFIX = "aith_";
export const hashHookToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A repository connection as the API shows it: never the token, the webhook secret or the webhook address's token. */
export interface PublicCodeRepo {
    id: string;
    projectId: string;
    host: "github";
    name: string;
    owner: string;
    repo: string;
    apiUrl: string;
    webhookSecretSet: boolean;
    webhookUrlSet: boolean;
    feedback: boolean;
    createdAt: string;
    updatedAt: string;
}

interface StoredSecret {
    token: string;
    webhookSecret?: string;
}

/** One webhook delivery, as kept in pr_events. */
export interface PrEvent {
    deliveryId: string;
    event: string;
    action?: string;
    pr?: number;
    headSha?: string;
    environment?: string;
    queued?: "impact" | "reverify";
    ignored?: string;
}

/** The tests chosen for one pull request head (code-host/pr-impact.ts): the proposed ids, the evidence per test, the run's mode. */
export interface PrSelection {
    id: string;
    pr: number;
    headSha: string;
    /** The run that follows: full unless a person or the API asks for focused. */
    mode: "focused" | "full";
    selected: string[];
    reasons: unknown;
    createdAt: string;
}

/** The project's code repository (one per project; connecting again replaces it), with its token and webhook secret encrypted by the SecretBox. */
export class CodeHostStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
    ) {}

    private row(projectId: string): Row | undefined {
        return this.db.get("SELECT * FROM code_repos WHERE project_id = ?", projectId);
    }

    private secretOf(r: Row): StoredSecret {
        return this.secrets.decrypt<StoredSecret>(r.secret_enc);
    }

    private configOf(r: Row): GithubCodeConfig {
        return { owner: r.owner, repo: r.repo, ...(r.api_url ? { apiUrl: r.api_url } : {}) };
    }

    get(projectId: string): PublicCodeRepo | undefined {
        const r = this.row(projectId);
        if (!r) return undefined;
        return {
            id: r.id,
            projectId: r.project_id,
            host: "github",
            name: `GitHub ${r.owner}/${r.repo}`,
            owner: r.owner,
            repo: r.repo,
            apiUrl: r.api_url ?? GITHUB_API,
            webhookSecretSet: Boolean(this.secretOf(r).webhookSecret),
            webhookUrlSet: Boolean(r.hook_token_hash),
            feedback: r.feedback === 1,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        };
    }

    /**
     * Connect, or replace the connection. A token or webhook secret left out keeps the stored one (only when replacing). `hookToken` is the
     * webhook address's token, returned only by the save that made it (a connection without one gets one); only its hash is kept.
     */
    save(projectId: string, s: { owner: string; repo: string; apiUrl?: string; token?: string; webhookSecret?: string; feedback?: boolean }): { connection: PublicCodeRepo; hookToken?: string } {
        const apiUrl = allowedApiBase(s.apiUrl);
        const existing = this.row(projectId);
        const before = existing ? this.secretOf(existing) : undefined;
        const token = s.token ?? before?.token;
        if (!token) throw new Error("A token is needed to connect a repository");
        const webhookSecret = s.webhookSecret ?? before?.webhookSecret;
        const secret_enc = this.secrets.encrypt({ token, ...(webhookSecret ? { webhookSecret } : {}) });
        const hookToken = existing?.hook_token_hash ? undefined : HOOK_TOKEN_PREFIX + randomBytes(32).toString("base64url");
        const hook = hookToken ? hashHookToken(hookToken) : existing!.hook_token_hash;
        const feedback = (s.feedback ?? existing?.feedback === 1) ? 1 : 0;
        const api = apiUrl !== GITHUB_API ? apiUrl : null;
        const t = now();
        if (existing) this.db.run("UPDATE code_repos SET owner = ?, repo = ?, api_url = ?, secret_enc = ?, hook_token_hash = ?, feedback = ?, updated_at = ? WHERE id = ?", s.owner, s.repo, api, secret_enc, hook, feedback, t, existing.id);
        else this.db.run("INSERT INTO code_repos (id, project_id, host, owner, repo, api_url, secret_enc, hook_token_hash, feedback, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", randomUUID(), projectId, "github", s.owner, s.repo, api, secret_enc, hook, feedback, t, t);
        return { connection: this.get(projectId)!, ...(hookToken ? { hookToken } : {}) };
    }

    remove(projectId: string): boolean {
        return Number(this.db.run("DELETE FROM code_repos WHERE project_id = ?", projectId).changes) > 0;
    }

    /** A client for other repository names that reuses the stored token (left out when changing a connection). */
    clientWith(projectId: string, cfg: GithubCodeConfig): GithubCodeHost | undefined {
        const r = this.row(projectId);
        return r ? new GithubCodeHost(cfg, this.secretOf(r).token) : undefined;
    }

    /** The client for the stored connection (decrypts the token for the duration of the calls). Throws "blocked" if its host is no longer allowed. */
    client(projectId: string): GithubCodeHost | undefined {
        const r = this.row(projectId);
        return r ? new GithubCodeHost(this.configOf(r), this.secretOf(r).token) : undefined;
    }

    /** The connection a webhook address's token belongs to, with what checking its deliveries needs. */
    byHookToken(token: string): { projectId: string; owner: string; repo: string; webhookSecret?: string } | undefined {
        const r = this.db.get("SELECT * FROM code_repos WHERE hook_token_hash = ?", hashHookToken(token));
        return r ? { projectId: r.project_id, owner: r.owner, repo: r.repo, webhookSecret: this.secretOf(r).webhookSecret } : undefined;
    }

    /** Where pull request feedback goes, or undefined when the project has no connection or its switch is off. */
    feedbackTarget(projectId: string): { apiUrl: string; owner: string; repo: string; token: string } | undefined {
        const r = this.row(projectId);
        if (!r || r.feedback !== 1) return undefined;
        return { apiUrl: allowedApiBase(r.api_url ?? undefined), owner: r.owner, repo: r.repo, token: this.secretOf(r).token };
    }

    /** The tests chosen for a pull request's head commit, if they were chosen already. */
    selection(projectId: string, pr: number, headSha: string): PrSelection | undefined {
        const r = this.db.get("SELECT * FROM pr_selections WHERE project_id = ? AND pr = ? AND head_sha = ?", projectId, pr, headSha);
        return r ? { id: r.id, pr: r.pr, headSha: r.head_sha, mode: r.mode, selected: JSON.parse(r.selected_json), reasons: JSON.parse(r.reasons_json), createdAt: r.created_at } : undefined;
    }

    /** Keeps one selection per pull request head: false when that head already has one (nothing is written). */
    saveSelection(projectId: string, s: Omit<PrSelection, "id" | "createdAt">): boolean {
        const changes = this.db.run(
            "INSERT INTO pr_selections (id, project_id, pr, head_sha, mode, selected_json, reasons_json, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (project_id, pr, head_sha) DO NOTHING",
            randomUUID(),
            projectId,
            s.pr,
            s.headSha,
            s.mode,
            JSON.stringify(s.selected),
            JSON.stringify(s.reasons),
            now(),
        ).changes;
        return Number(changes) === 1;
    }

    /** Keeps a delivery once: false when this project already has that delivery id (nothing is written). */
    recordEvent(projectId: string, e: PrEvent): boolean {
        const changes = this.db.run(
            "INSERT INTO pr_events (id, project_id, delivery_id, event, action, pr, head_sha, environment, queued, ignored, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (project_id, delivery_id) DO NOTHING",
            randomUUID(),
            projectId,
            e.deliveryId,
            e.event,
            e.action ?? null,
            e.pr ?? null,
            e.headSha ?? null,
            e.environment ?? null,
            e.queued ?? null,
            e.ignored ?? null,
            now(),
        ).changes;
        return Number(changes) === 1;
    }
}
