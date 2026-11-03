/**
 * Integrations set up once for an organisation and used by the projects that choose them (the Integrations place).
 *
 * A shared connection holds the settings and the secret (a tracker or Sentry token, or an alert channel's webhook address), encrypted with
 * the platform's SecretBox like every other stored credential. When a project starts using it, the project gets its own row in the table
 * that feature already reads (`integrations` for issue trackers and Sentry, `alert_channels` for Slack, Teams and webhooks), carrying the
 * same encrypted secret; the link remembers which row that is. So everything that files issues, reads Sentry or sends alerts works exactly
 * as before, and per-project connections made in a project's settings stay what they were.
 *
 * Changing the shared connection changes every project's row; stopping using it removes only that project's row; a project's own settings
 * cannot change or remove a row that came from here (the project routes refuse, see `sharedOrigin`). What each project chose for its
 * alerts (which events, which severity, on or off) stays the project's.
 */
import { randomUUID } from "node:crypto";
import type { Db, Row } from "./db.js";
import type { SecretBox } from "./secrets.js";

/** Migration slot 48: the shared connections and which projects use them. */
export const SHARED_INTEGRATIONS_MIGRATION = `
CREATE TABLE shared_integrations (
    id TEXT PRIMARY KEY,
    organization_id TEXT,                 -- the organisation that owns it; NULL: the whole platform (Crowd4Test's own, or a local install)
    kind TEXT NOT NULL,                   -- github | jira | notion | sentry | slack | teams | webhook
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,            -- non-secret settings (for an alert channel only its host)
    secret_enc TEXT NOT NULL,             -- SecretBox JSON: {token} for trackers and Sentry, {url} for alert channels; never returned
    status TEXT NOT NULL DEFAULT 'unchecked',   -- unchecked | working | failed: the last "Test the connection"
    status_note TEXT,
    checked_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_shared_integrations_org ON shared_integrations(organization_id);
CREATE TABLE shared_integration_links (
    integration_id TEXT NOT NULL REFERENCES shared_integrations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL,              -- the project's row this put in place: integrations.id or alert_channels.id
    linked_by TEXT,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (integration_id, project_id)
);
CREATE INDEX idx_shared_integration_links_target ON shared_integration_links(target_id);
CREATE INDEX idx_shared_integration_links_project ON shared_integration_links(project_id);
`;

export const SHARED_KINDS = ["jira", "github", "notion", "sentry", "slack", "teams", "webhook"] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];
export const TRACKER_SHARED: readonly SharedKind[] = ["jira", "github", "notion"];
export const ALERT_SHARED: readonly SharedKind[] = ["slack", "teams", "webhook"];
export const isAlertKind = (k: string): boolean => (ALERT_SHARED as readonly string[]).includes(k);
/** Alert channels a project may have (routes/schedules.ts keeps the same number). */
export const MAX_PROJECT_CHANNELS = 10;
/** Shared connections per organisation (and for the platform). */
export const MAX_SHARED_PER_OWNER = 30;

export interface SharedIntegration {
    id: string;
    organizationId: string | null;
    kind: SharedKind;
    name: string;
    config: Record<string, unknown>;
    status: "unchecked" | "working" | "failed";
    statusNote: string | null;
    checkedAt: string | null;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SharedLink {
    integrationId: string;
    projectId: string;
    targetId: string;
    linkedBy: string | null;
    linkedAt: string;
    /** False when the project's row is gone (a restore, or removed before this existed): using it again puts it back. */
    present: boolean;
}

/** Why linking was refused, in words a person can act on. The route turns it into a 409. */
export class LinkRefused extends Error {}

const now = () => new Date().toISOString();
const toShared = (r: Row): SharedIntegration => ({
    id: r.id,
    organizationId: r.organization_id ?? null,
    kind: r.kind,
    name: r.name,
    config: JSON.parse(r.config_json),
    status: r.status,
    statusNote: r.status_note ?? null,
    checkedAt: r.checked_at ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

/** The shared connection a project's row came from, or undefined for a row the project set up itself. */
export function sharedOrigin(db: Db, targetId: string): { integrationId: string; name: string } | undefined {
    return db.get<{ integrationId: string; name: string }>("SELECT l.integration_id AS integrationId, s.name AS name FROM shared_integration_links l JOIN shared_integrations s ON s.id = l.integration_id WHERE l.target_id = ?", targetId);
}

/** The refusal a project route gives for a row that came from a shared connection. */
export const sharedRowMessage = (name: string) => `“${name}” is shared from Integrations. Change it there, or stop using it in this project there.`;

export class SharedIntegrationStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
    ) {}

    list(): SharedIntegration[] {
        return this.db.all("SELECT * FROM shared_integrations ORDER BY created_at").map(toShared);
    }

    get(id: string): SharedIntegration | undefined {
        const r = this.db.get("SELECT * FROM shared_integrations WHERE id = ?", id);
        return r ? toShared(r) : undefined;
    }

    countOf(organizationId: string | null): number {
        const r = organizationId ? this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM shared_integrations WHERE organization_id = ?", organizationId) : this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM shared_integrations WHERE organization_id IS NULL");
        return Number(r?.n ?? 0);
    }

    /** The secret, decrypted: only a connection check or a new link uses it, never an answer. */
    secretOf<T>(id: string): T {
        const r = this.db.get<{ secret_enc: string }>("SELECT secret_enc FROM shared_integrations WHERE id = ?", id);
        if (!r) throw new Error("Shared integration not found");
        return this.secrets.decrypt<T>(r.secret_enc);
    }

    create(input: { organizationId: string | null; kind: SharedKind; name: string; config: Record<string, unknown>; secret: Record<string, unknown>; createdBy: string | null }): SharedIntegration {
        const id = randomUUID();
        const t = now();
        this.db.run(
            "INSERT INTO shared_integrations (id, organization_id, kind, name, config_json, secret_enc, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            id,
            input.organizationId,
            input.kind,
            input.name,
            JSON.stringify(input.config),
            this.secrets.encrypt(input.secret),
            "unchecked",
            input.createdBy,
            t,
            t,
        );
        return this.get(id)!;
    }

    /** A new name, settings or secret; every project using it gets the change. A changed setting or secret needs a new check. */
    update(id: string, patch: { name?: string; config?: Record<string, unknown>; secret?: Record<string, unknown> }): SharedIntegration | undefined {
        const cur = this.db.get("SELECT * FROM shared_integrations WHERE id = ?", id);
        if (!cur) return undefined;
        const name = patch.name?.trim() || cur.name;
        const config = patch.config ? JSON.stringify(patch.config) : cur.config_json;
        const secret = patch.secret ? this.secrets.encrypt(patch.secret) : cur.secret_enc;
        const changed = config !== cur.config_json || Boolean(patch.secret);
        this.db.tx(() => {
            this.db.run(
                `UPDATE shared_integrations SET name = ?, config_json = ?, secret_enc = ?, updated_at = ?${changed ? ", status = 'unchecked', status_note = NULL" : ""} WHERE id = ?`,
                name,
                config,
                secret,
                now(),
                id,
            );
            for (const l of this.linksOf(id)) this.writeTarget(toShared({ ...cur, name, config_json: config }), secret, l.targetId);
        });
        return this.get(id);
    }

    /** Removes it; the projects' rows go with it (issues already filed keep their links: `issue_links.integration_id` is set to NULL). */
    remove(id: string): boolean {
        return this.db.tx(() => {
            for (const l of this.linksOf(id)) this.deleteTarget(id, l.targetId);
            return Number(this.db.run("DELETE FROM shared_integrations WHERE id = ?", id).changes) > 0;
        });
    }

    setStatus(id: string, ok: boolean, note: string | null): void {
        this.db.run("UPDATE shared_integrations SET status = ?, status_note = ?, checked_at = ? WHERE id = ?", ok ? "working" : "failed", ok ? null : note, now(), id);
    }

    links(): SharedLink[] {
        return this.db.all("SELECT * FROM shared_integration_links ORDER BY linked_at").map((r) => this.toLink(r));
    }

    linksOf(id: string): SharedLink[] {
        return this.db.all("SELECT * FROM shared_integration_links WHERE integration_id = ? ORDER BY linked_at", id).map((r) => this.toLink(r));
    }

    linksOfProject(projectId: string): SharedLink[] {
        return this.db.all("SELECT * FROM shared_integration_links WHERE project_id = ? ORDER BY linked_at", projectId).map((r) => this.toLink(r));
    }

    private toLink(r: Row): SharedLink {
        const kind = this.db.get<{ kind: string }>("SELECT kind FROM shared_integrations WHERE id = ?", r.integration_id)?.kind ?? "";
        const table = isAlertKind(kind) ? "alert_channels" : "integrations";
        const present = Boolean(this.db.get(`SELECT id FROM ${table} WHERE id = ?`, r.target_id));
        return { integrationId: r.integration_id, projectId: r.project_id, targetId: r.target_id, linkedBy: r.linked_by ?? null, linkedAt: r.linked_at, present };
    }

    /**
     * The project starts using the connection: its own row is made from the shared one. Using it again is harmless (and puts back a row that
     * went missing). Refused, with the reason, when the project already has its own Sentry or as many alert channels as it may have.
     */
    link(id: string, projectId: string, by: string | null): SharedLink {
        return this.db.tx(() => {
            const row = this.db.get("SELECT * FROM shared_integrations WHERE id = ?", id);
            if (!row) throw new Error("Shared integration not found");
            const s = toShared(row);
            const existing = this.db.get("SELECT * FROM shared_integration_links WHERE integration_id = ? AND project_id = ?", id, projectId);
            if (existing && this.toLink(existing).present) return this.toLink(existing);
            if (s.kind === "sentry" && this.db.get("SELECT id FROM integrations WHERE project_id = ? AND kind = 'sentry'", projectId)) {
                throw new LinkRefused("This project already has a Sentry connection of its own. Remove it in the project's settings (Issues), then use this one.");
            }
            if (isAlertKind(s.kind) && Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alert_channels WHERE project_id = ?", projectId)?.n ?? 0) >= MAX_PROJECT_CHANNELS) {
                throw new LinkRefused(`This project already has ${MAX_PROJECT_CHANNELS} alert channels, the most it can have. Remove one in the project's settings first.`);
            }
            const targetId = randomUUID();
            this.insertTarget(s, row.secret_enc, projectId, targetId);
            if (existing) this.db.run("UPDATE shared_integration_links SET target_id = ?, linked_by = ?, linked_at = ? WHERE integration_id = ? AND project_id = ?", targetId, by, now(), id, projectId);
            else this.db.run("INSERT INTO shared_integration_links (integration_id, project_id, target_id, linked_by, linked_at) VALUES (?,?,?,?,?)", id, projectId, targetId, by, now());
            return this.toLink(this.db.get("SELECT * FROM shared_integration_links WHERE integration_id = ? AND project_id = ?", id, projectId)!);
        });
    }

    /** The project stops using it: its row goes, the shared connection and the other projects stay. */
    unlink(id: string, projectId: string): boolean {
        return this.db.tx(() => {
            const l = this.db.get<{ target_id: string }>("SELECT target_id FROM shared_integration_links WHERE integration_id = ? AND project_id = ?", id, projectId);
            if (!l) return false;
            this.deleteTarget(id, l.target_id);
            this.db.run("DELETE FROM shared_integration_links WHERE integration_id = ? AND project_id = ?", id, projectId);
            return true;
        });
    }

    private insertTarget(s: SharedIntegration, secretEnc: string, projectId: string, targetId: string): void {
        const t = now();
        if (isAlertKind(s.kind)) {
            // A new channel hears about runs (not API changes), like one made in a project's settings without choosing.
            this.db.run(
                "INSERT INTO alert_channels (id, project_id, kind, name, url_enc, url_host, events_json, min_severity, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                targetId,
                projectId,
                s.kind,
                s.name,
                secretEnc,
                String(s.config.host ?? ""),
                JSON.stringify(["run_failed", "regression", "recovered", "flaky"]),
                null,
                1,
                t,
                t,
            );
            return;
        }
        this.db.run("INSERT INTO integrations (id, project_id, kind, name, config_json, secret_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", targetId, projectId, s.kind, s.name, JSON.stringify({ kind: s.kind, ...s.config }), secretEnc, t, t);
    }

    private writeTarget(s: SharedIntegration, secretEnc: string, targetId: string): void {
        if (isAlertKind(s.kind)) {
            this.db.run("UPDATE alert_channels SET name = ?, url_enc = ?, url_host = ?, updated_at = ? WHERE id = ?", s.name, secretEnc, String(s.config.host ?? ""), now(), targetId);
            return;
        }
        this.db.run("UPDATE integrations SET name = ?, config_json = ?, secret_enc = ?, updated_at = ? WHERE id = ?", s.name, JSON.stringify({ kind: s.kind, ...s.config }), secretEnc, now(), targetId);
    }

    private deleteTarget(id: string, targetId: string): void {
        const kind = this.db.get<{ kind: string }>("SELECT kind FROM shared_integrations WHERE id = ?", id)?.kind ?? "";
        if (isAlertKind(kind)) this.db.run("DELETE FROM alert_channels WHERE id = ?", targetId);
        else this.db.run("DELETE FROM integrations WHERE id = ?", targetId);
    }

    /** Projects that set up this kind of connection themselves (not from a shared one), for the Integrations page. */
    ownUses(): Array<{ kind: string; projectId: string }> {
        const q = (sql: string) => this.db.all<{ kind: string; projectId: string }>(sql);
        return [
            ...q("SELECT DISTINCT i.kind AS kind, i.project_id AS projectId FROM integrations i WHERE NOT EXISTS (SELECT 1 FROM shared_integration_links l WHERE l.target_id = i.id)"),
            ...q("SELECT DISTINCT c.kind AS kind, c.project_id AS projectId FROM alert_channels c WHERE NOT EXISTS (SELECT 1 FROM shared_integration_links l WHERE l.target_id = c.id)"),
            ...q("SELECT DISTINCT 'git' AS kind, project_id AS projectId FROM git_repos"),
            ...q("SELECT DISTINCT 'device_farm' AS kind, project_id AS projectId FROM device_farms"),
            ...q("SELECT DISTINCT 'mailbox' AS kind, project_id AS projectId FROM test_mailboxes"),
        ];
    }
}
