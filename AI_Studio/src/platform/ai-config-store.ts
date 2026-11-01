/**
 * AI configurations: which provider, models and key a project's AI work uses, and who pays for it (migration slot 43).
 *
 * A configuration belongs to the platform (Crowd4Test's own), an organisation, or one project. A project is on managed AI (Crowd4Test pays:
 * the server's key, or one of the platform's configurations) or on its own key (the organisation pays). Nothing is charged here: usage rows
 * say who pays, and that is all.
 *
 * The key is stored once, encrypted with the platform's SecretBox, and never leaves this file except to the call that uses it (`keyOf`): no
 * row, view or answer carries it. People see its last four characters, kept apart in `key_hint`.
 */
import { randomUUID } from "node:crypto";
import type { LlmProviderId } from "../engine/llm/provider.js";
import type { Row } from "./db.js";
import type { SecretBox } from "./secrets.js";
import type { Sql } from "./sql.js";

export const AI_CONFIG_MIGRATION = `
CREATE TABLE ai_configurations (
    id TEXT PRIMARY KEY,
    owner_kind TEXT NOT NULL,             -- platform | organization | project
    organization_id TEXT,                 -- owner_kind organization: the organisation that owns it
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,   -- owner_kind project: the project that owns it
    label TEXT NOT NULL,
    provider TEXT NOT NULL,               -- anthropic | openai | google | openai-compatible
    model TEXT NOT NULL,
    fast_model TEXT,
    base_url TEXT,                        -- openai-compatible only
    key_enc TEXT NOT NULL,                -- AES-256-GCM (SecretBox); never returned
    key_hint TEXT NOT NULL,               -- the key's last four characters
    status TEXT NOT NULL,                 -- untested | working | failed
    status_note TEXT,
    last_validated_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_configurations_owner ON ai_configurations(owner_kind, organization_id);
CREATE INDEX idx_ai_configurations_project ON ai_configurations(project_id);
CREATE TABLE project_ai_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,                   -- managed | own
    configuration_id TEXT REFERENCES ai_configurations(id) ON DELETE SET NULL,
    updated_by TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_ai_configuration ON project_ai_settings(configuration_id);
ALTER TABLE ai_usage ADD COLUMN billing_owner TEXT NOT NULL DEFAULT 'crowd4test';
ALTER TABLE ai_usage ADD COLUMN billing_organization_id TEXT;
CREATE INDEX idx_ai_usage_billing ON ai_usage(billing_owner, day);
`;

export type ConfigOwnerKind = "platform" | "organization" | "project";
export type ConfigStatus = "untested" | "working" | "failed";
export type AiMode = "managed" | "own";

/** A configuration as the code sees it. The encrypted key is not part of it. */
export interface AiConfiguration {
    id: string;
    ownerKind: ConfigOwnerKind;
    organizationId: string | null;
    projectId: string | null;
    label: string;
    provider: LlmProviderId;
    model: string;
    fastModel: string | null;
    baseUrl: string | null;
    keyHint: string;
    status: ConfigStatus;
    statusNote: string | null;
    lastValidatedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ProjectAiChoice {
    mode: AiMode;
    configurationId: string | null;
}

/** Every column but the key. */
const COLUMNS = "id, owner_kind, organization_id, project_id, label, provider, model, fast_model, base_url, key_hint, status, status_note, last_validated_at, created_at, updated_at";

const configOf = (r: Row): AiConfiguration => ({
    id: r.id,
    ownerKind: r.owner_kind,
    organizationId: r.organization_id ?? null,
    projectId: r.project_id ?? null,
    label: r.label,
    provider: r.provider,
    model: r.model,
    fastModel: r.fast_model ?? null,
    baseUrl: r.base_url ?? null,
    keyHint: r.key_hint,
    status: r.status,
    statusNote: r.status_note ?? null,
    lastValidatedAt: r.last_validated_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

export interface NewConfiguration {
    ownerKind: ConfigOwnerKind;
    organizationId?: string | null;
    projectId?: string | null;
    label: string;
    provider: LlmProviderId;
    model: string;
    fastModel?: string | null;
    baseUrl?: string | null;
    apiKey: string;
    createdBy?: string | null;
}

export type ConfigurationChange = Partial<Pick<AiConfiguration, "label" | "provider" | "model" | "fastModel" | "baseUrl">> & { apiKey?: string };

export class AiConfigStore {
    constructor(
        private readonly sql: Sql,
        private readonly box: SecretBox,
        private readonly clock: () => number = Date.now,
    ) {}

    private nowIso(): string {
        return new Date(this.clock()).toISOString();
    }

    async create(c: NewConfiguration): Promise<AiConfiguration> {
        const id = randomUUID();
        const now = this.nowIso();
        await this.sql.run(
            `INSERT INTO ai_configurations (id, owner_kind, organization_id, project_id, label, provider, model, fast_model, base_url, key_enc, key_hint, status, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,'untested',?,?,?)`,
            id,
            c.ownerKind,
            c.organizationId ?? null,
            c.projectId ?? null,
            c.label,
            c.provider,
            c.model,
            c.fastModel ?? null,
            c.baseUrl ?? null,
            this.box.encrypt(c.apiKey),
            c.apiKey.slice(-4),
            c.createdBy ?? null,
            now,
            now,
        );
        return (await this.get(id))!;
    }

    async get(id: string): Promise<AiConfiguration | undefined> {
        const r = await this.sql.get(`SELECT ${COLUMNS} FROM ai_configurations WHERE id = ?`, id);
        return r ? configOf(r) : undefined;
    }

    /** Configurations an organisation owns: its own and its projects' (NULL: the platform's, and those of projects without one). */
    async countOf(organizationId: string | null): Promise<number> {
        const r = organizationId
            ? await this.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_configurations c LEFT JOIN projects p ON p.id = c.project_id WHERE (c.owner_kind = 'organization' AND c.organization_id = ?) OR (c.owner_kind = 'project' AND p.organization_id = ?)", organizationId, organizationId)
            : await this.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_configurations c LEFT JOIN projects p ON p.id = c.project_id WHERE c.owner_kind = 'platform' OR (c.owner_kind = 'project' AND p.organization_id IS NULL)");
        return Number(r?.n ?? 0);
    }

    async list(): Promise<AiConfiguration[]> {
        return (await this.sql.all(`SELECT ${COLUMNS} FROM ai_configurations ORDER BY label, id`)).map(configOf);
    }

    /** A change of key, provider, model or address means the last test no longer says anything: the status starts again. */
    async update(id: string, c: ConfigurationChange): Promise<AiConfiguration | undefined> {
        const cur = await this.get(id);
        if (!cur) return undefined;
        const next = { ...cur, ...c };
        const retest = c.apiKey !== undefined || next.provider !== cur.provider || next.model !== cur.model || next.baseUrl !== cur.baseUrl || next.fastModel !== cur.fastModel;
        await this.sql.run(
            `UPDATE ai_configurations SET label = ?, provider = ?, model = ?, fast_model = ?, base_url = ?, updated_at = ?,
                status = CASE WHEN ? = 1 THEN 'untested' ELSE status END,
                status_note = CASE WHEN ? = 1 THEN NULL ELSE status_note END,
                last_validated_at = CASE WHEN ? = 1 THEN NULL ELSE last_validated_at END
             WHERE id = ?`,
            next.label,
            next.provider,
            next.model,
            next.fastModel ?? null,
            next.baseUrl ?? null,
            this.nowIso(),
            retest ? 1 : 0,
            retest ? 1 : 0,
            retest ? 1 : 0,
            id,
        );
        if (c.apiKey !== undefined) await this.sql.run("UPDATE ai_configurations SET key_enc = ?, key_hint = ? WHERE id = ?", this.box.encrypt(c.apiKey), c.apiKey.slice(-4), id);
        return this.get(id);
    }

    async remove(id: string): Promise<boolean> {
        return (await this.sql.run("DELETE FROM ai_configurations WHERE id = ?", id)).changes > 0;
    }

    async setStatus(id: string, status: ConfigStatus, note: string | null, validated: boolean): Promise<void> {
        const now = this.nowIso();
        if (validated) await this.sql.run("UPDATE ai_configurations SET status = ?, status_note = ?, last_validated_at = ? WHERE id = ?", status, note, now, id);
        else await this.sql.run("UPDATE ai_configurations SET status = ?, status_note = ? WHERE id = ?", status, note, id);
    }

    /** The key itself, for the one call or job that uses it. Throws when it cannot be read (SECRET_KEY changed). */
    async keyOf(id: string): Promise<string> {
        const r = await this.sql.get<{ key_enc: string }>("SELECT key_enc FROM ai_configurations WHERE id = ?", id);
        if (!r) throw new Error("No such AI configuration");
        return this.box.decrypt<string>(r.key_enc);
    }

    /** A project with no row is on managed AI with the server's key: every project was, before configurations existed. */
    async choice(projectId: string): Promise<ProjectAiChoice> {
        const r = await this.sql.get<{ mode: AiMode; configuration_id: string | null }>("SELECT mode, configuration_id FROM project_ai_settings WHERE project_id = ?", projectId);
        return r ? { mode: r.mode, configurationId: r.configuration_id ?? null } : { mode: "managed", configurationId: null };
    }

    async setChoice(projectId: string, choice: ProjectAiChoice, updatedBy?: string | null): Promise<void> {
        await this.sql.run(
            `INSERT INTO project_ai_settings (project_id, mode, configuration_id, updated_by, updated_at) VALUES (?,?,?,?,?)
             ON CONFLICT(project_id) DO UPDATE SET mode = excluded.mode, configuration_id = excluded.configuration_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
            projectId,
            choice.mode,
            choice.configurationId,
            updatedBy ?? null,
            this.nowIso(),
        );
    }

    /** How many projects use each configuration. */
    async useCounts(): Promise<Map<string, number>> {
        const rows = await this.sql.all<{ configuration_id: string; n: number }>("SELECT configuration_id, COUNT(*) AS n FROM project_ai_settings WHERE configuration_id IS NOT NULL GROUP BY configuration_id");
        return new Map(rows.map((r) => [r.configuration_id, Number(r.n)]));
    }
}
