/**
 * AI keys (an "AI configuration": provider, models, the key, an address for a custom endpoint). Two kinds only (round 57):
 *
 * - **Organisational**: Crowd4Test's. Crowd4Test admins add, change and remove them and assign each to particular admins or sub-admins; only
 *   the people it is assigned to may use it (ai_key_assignees). Crowd4Test pays.
 * - **Personal**: one person's own key (`owner_person_id`). Only that person sees and uses it. That person pays.
 *
 * Every person has at most one chosen key (ai_key_choices); all the AI work they start, in any project, uses it. Projects choose nothing.
 *
 * The key is stored once, encrypted with the platform's SecretBox, and never leaves this file except to the call that uses it (`keyOf`): no
 * row, view or answer carries it. People see its last four characters, kept apart in `key_hint`.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LlmProviderId } from "../engine/llm/provider.js";
import type { Row } from "./db.js";
import type { SecretBox } from "./secrets.js";
import type { Sql } from "./sql.js";

export const AI_CONFIG_MIGRATION = `
CREATE TABLE ai_configurations (
    id TEXT PRIMARY KEY,
    owner_kind TEXT NOT NULL,             -- organisational | personal (before slot 61: platform | organization | project)
    organization_id TEXT,                 -- before slot 61 only
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,   -- before slot 61 only
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

/**
 * Slot 61: the two kinds. `created_by` holds "Name (person id)" for a person (actorLabel), so a person is found by the exact "(id)" at its
 * end (or, for a label cut before it, by `created_by` being exactly the id).
 * - platform keys become organisational, assigned to the person who added them (when that person is still here);
 * - organisation and project keys become personal keys of the person who added them; one whose person cannot be found is removed
 *   (it is never given to someone else). On a server without accounts the open server ("Open access", owner id "open") counts as that person;
 * - usage rows a customer's own key paid for say "personal".
 * Then `backfillChosenKeys` (below, run in the same transaction) gives people the key their projects used, and drops project_ai_settings.
 */
export const AI_KEYS_MIGRATION = `
ALTER TABLE ai_configurations ADD COLUMN owner_person_id TEXT;
CREATE INDEX idx_ai_configurations_person ON ai_configurations(owner_person_id);
CREATE TABLE ai_key_assignees (
    key_id TEXT NOT NULL REFERENCES ai_configurations(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL,
    assigned_by TEXT,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (key_id, person_id)
);
CREATE INDEX idx_ai_key_assignees_person ON ai_key_assignees(person_id);
CREATE TABLE ai_key_choices (
    person_id TEXT PRIMARY KEY,
    key_id TEXT NOT NULL REFERENCES ai_configurations(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_key_choices_key ON ai_key_choices(key_id);
ALTER TABLE ai_usage ADD COLUMN billing_person_id TEXT;
UPDATE ai_configurations SET owner_person_id = (SELECT u.id FROM users u WHERE substr(ai_configurations.created_by, -(length(u.id) + 2)) = '(' || u.id || ')' ORDER BY u.id LIMIT 1);
UPDATE ai_configurations SET owner_person_id = (SELECT u.id FROM users u WHERE u.id = ai_configurations.created_by) WHERE owner_person_id IS NULL;
UPDATE ai_configurations SET owner_person_id = 'open' WHERE owner_person_id IS NULL AND created_by = 'Open access';
INSERT INTO ai_key_assignees (key_id, person_id, assigned_by, assigned_at)
    SELECT id, owner_person_id, created_by, updated_at FROM ai_configurations WHERE owner_kind = 'platform' AND owner_person_id IS NOT NULL;
UPDATE ai_configurations SET owner_person_id = NULL WHERE owner_kind = 'platform';
UPDATE ai_usage SET billing_owner = 'personal' WHERE billing_owner = 'organization';
`;

/**
 * Who may be assigned an organisational key (and keep using one): with Crowd4Test sign-in, Crowd4Test admins and sub-admins only; on a server
 * without it, its owners. Active people only.
 */
export const assignableSql = (alias: string, crowd4test: boolean) =>
    `(${alias}.role IS NOT NULL AND ${alias}.status = 'active' AND ${crowd4test ? `${alias}.c4t_role IN ('ADMIN', 'SUB_ADMIN')` : `${alias}.c4t_role IS NULL AND ${alias}.role = 'owner'`})`;

/**
 * After slot 61's SQL: every person who started AI work in a project whose AI setting pointed at a key they may still use gets it as their chosen
 * key, if they have none. Best effort, from the jobs' recorded starters (a job started by a schedule or a trigger counts for its maker). Then the
 * projects' AI settings are gone. Runs inside slot 61's transaction, so it happens exactly once.
 */
export function backfillChosenKeys(raw: DatabaseSync): void {
    // A key whose maker cannot be found is removed, never given to someone else; only the number is said.
    const orphans = Number((raw.prepare("SELECT COUNT(*) AS n FROM ai_configurations WHERE owner_kind IN ('organization', 'project') AND owner_person_id IS NULL").get() as { n: number }).n);
    if (orphans > 0) console.warn(`[ai-keys] ${orphans} AI ${orphans === 1 ? "key was" : "keys were"} removed: the person who added ${orphans === 1 ? "it" : "them"} is no longer here.`);
    raw.exec(`DELETE FROM ai_configurations WHERE owner_kind IN ('organization', 'project') AND owner_person_id IS NULL;
UPDATE ai_configurations SET owner_kind = 'personal', organization_id = NULL, project_id = NULL WHERE owner_kind IN ('organization', 'project');
UPDATE ai_configurations SET owner_kind = 'organisational' WHERE owner_kind = 'platform';`);
    // The migration has no settings: a server whose people carry a Crowd4Test role signs in with Crowd4Test.
    const crowd4test = Boolean(raw.prepare("SELECT 1 AS x FROM users WHERE c4t_role IS NOT NULL LIMIT 1").get());
    const settings = raw.prepare("SELECT project_id, configuration_id FROM project_ai_settings WHERE configuration_id IS NOT NULL").all() as Array<{ project_id: string; configuration_id: string }>;
    const now = new Date().toISOString();
    const has = raw.prepare("SELECT 1 AS x FROM ai_key_choices WHERE person_id = ?");
    const key = raw.prepare("SELECT owner_kind, owner_person_id FROM ai_configurations WHERE id = ?");
    const assigned = raw.prepare("SELECT 1 AS x FROM ai_key_assignees WHERE key_id = ? AND person_id = ?");
    const staff = raw.prepare(`SELECT 1 AS x FROM users u WHERE u.id = ? AND ${assignableSql("u", crowd4test)}`);
    const usable = (person: string, keyId: string): boolean => {
        const k = key.get(keyId) as { owner_kind: string; owner_person_id: string | null } | undefined;
        if (!k) return false;
        if (k.owner_kind === "personal") return k.owner_person_id === person;
        return k.owner_kind === "organisational" && Boolean(assigned.get(keyId, person)) && (person === "open" || Boolean(staff.get(person)));
    };
    const put = raw.prepare("INSERT INTO ai_key_choices (person_id, key_id, updated_at) VALUES (?, ?, ?)");
    const jobs = raw.prepare("SELECT options_json FROM generation_jobs WHERE project_id = ? ORDER BY created_at DESC");
    for (const s of settings) {
        const people = new Set<string>();
        for (const j of jobs.all(s.project_id) as Array<{ options_json: string | null }>) {
            try {
                const b = (JSON.parse(j.options_json ?? "{}") as { startedBy?: { kind?: string; id?: string | null; ownerId?: string | null } }).startedBy;
                const id = b?.kind === "user" ? b.id : b?.kind === "open" ? "open" : b?.kind === "schedule" || b?.kind === "trigger" ? b.ownerId : null;
                if (typeof id === "string" && id) people.add(id);
            } catch {
                // An unreadable job says nothing about who used the key.
            }
        }
        for (const person of people) if (!has.get(person) && usable(person, s.configuration_id)) put.run(person, s.configuration_id, now);
    }
    // Anyone still without a choice who may use exactly one key gets that one.
    const holders = raw.prepare("SELECT DISTINCT owner_person_id AS p FROM ai_configurations WHERE owner_kind = 'personal' UNION SELECT DISTINCT person_id AS p FROM ai_key_assignees").all() as Array<{ p: string | null }>;
    const keysOf = raw.prepare("SELECT id FROM ai_configurations WHERE (owner_kind = 'personal' AND owner_person_id = ?) OR (owner_kind = 'organisational' AND id IN (SELECT key_id FROM ai_key_assignees WHERE person_id = ?))");
    for (const { p: person } of holders) {
        if (!person || has.get(person)) continue;
        const mine = (keysOf.all(person, person) as Array<{ id: string }>).filter((k) => usable(person, k.id));
        if (mine.length === 1) put.run(person, mine[0]!.id, now);
    }
    raw.exec("DROP TABLE project_ai_settings");
}

export type KeyKind = "organisational" | "personal";
export type ConfigStatus = "untested" | "working" | "failed";

/** A key as the code sees it. The encrypted key is not part of it. */
export interface AiConfiguration {
    id: string;
    kind: KeyKind;
    /** A personal key's person; null for an organisational key. */
    ownerPersonId: string | null;
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

/** Every column but the key. */
const COLUMNS = "id, owner_kind, owner_person_id, label, provider, model, fast_model, base_url, key_hint, status, status_note, last_validated_at, created_at, updated_at";

const configOf = (r: Row): AiConfiguration => ({
    id: r.id,
    kind: r.owner_kind === "personal" ? "personal" : "organisational",
    ownerPersonId: r.owner_person_id ?? null,
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
    kind: KeyKind;
    /** Required for a personal key. */
    ownerPersonId?: string | null;
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
        if (c.kind === "personal" && !c.ownerPersonId) throw new Error("A personal key needs its person");
        const id = randomUUID();
        const now = this.nowIso();
        await this.sql.run(
            `INSERT INTO ai_configurations (id, owner_kind, owner_person_id, label, provider, model, fast_model, base_url, key_enc, key_hint, status, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,'untested',?,?,?)`,
            id,
            c.kind,
            c.kind === "personal" ? (c.ownerPersonId ?? null) : null,
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

    /** Every organisational key (admins' list). */
    async organisational(): Promise<AiConfiguration[]> {
        return (await this.sql.all(`SELECT ${COLUMNS} FROM ai_configurations WHERE owner_kind = 'organisational' ORDER BY label, id`)).map(configOf);
    }

    /** One person's own keys. */
    async personalOf(personId: string): Promise<AiConfiguration[]> {
        return (await this.sql.all(`SELECT ${COLUMNS} FROM ai_configurations WHERE owner_kind = 'personal' AND owner_person_id = ? ORDER BY label, id`, personId)).map(configOf);
    }

    /** The organisational keys assigned to this person (whether they may still hold one is the caller's check). */
    async assignedTo(personId: string): Promise<AiConfiguration[]> {
        const cols = COLUMNS.split(", ").map((c) => `c.${c}`).join(", ");
        return (
            await this.sql.all(`SELECT ${cols} FROM ai_configurations c JOIN ai_key_assignees a ON a.key_id = c.id WHERE c.owner_kind = 'organisational' AND a.person_id = ? ORDER BY c.label, c.id`, personId)
        ).map(configOf);
    }

    async isAssigned(keyId: string, personId: string): Promise<boolean> {
        return Boolean(await this.sql.get("SELECT 1 AS x FROM ai_key_assignees WHERE key_id = ? AND person_id = ?", keyId, personId));
    }

    async assigneesOf(keyId: string): Promise<string[]> {
        return (await this.sql.all<{ person_id: string }>("SELECT person_id FROM ai_key_assignees WHERE key_id = ? ORDER BY assigned_at, person_id", keyId)).map((r) => r.person_id);
    }

    /** Replaces who an organisational key is assigned to. People who lose it and had chosen it lose that choice too. */
    async setAssignees(keyId: string, personIds: readonly string[], by: string | null): Promise<{ added: string[]; removed: string[] }> {
        const before = new Set(await this.assigneesOf(keyId));
        const next = new Set(personIds);
        const added = [...next].filter((x) => !before.has(x));
        const removed = [...before].filter((x) => !next.has(x));
        const now = this.nowIso();
        await this.sql.tx(async (t) => {
            for (const person of removed) {
                await t.run("DELETE FROM ai_key_assignees WHERE key_id = ? AND person_id = ?", keyId, person);
                await t.run("DELETE FROM ai_key_choices WHERE key_id = ? AND person_id = ?", keyId, person);
            }
            for (const person of added) await t.run("INSERT INTO ai_key_assignees (key_id, person_id, assigned_by, assigned_at) VALUES (?,?,?,?)", keyId, person, by, now);
        });
        return { added, removed };
    }

    /** How many people chose each key. */
    async choiceCounts(): Promise<Map<string, number>> {
        const rows = await this.sql.all<{ key_id: string; n: number }>("SELECT key_id, COUNT(*) AS n FROM ai_key_choices GROUP BY key_id");
        return new Map(rows.map((r) => [r.key_id, Number(r.n)]));
    }

    async countPersonal(personId: string): Promise<number> {
        return Number((await this.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_configurations WHERE owner_kind = 'personal' AND owner_person_id = ?", personId))?.n ?? 0);
    }

    async countOrganisational(): Promise<number> {
        return Number((await this.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_configurations WHERE owner_kind = 'organisational'"))?.n ?? 0);
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

    /** The key this person chose (its id), or null. Whether they may still use it is the caller's check. */
    async chosenOf(personId: string): Promise<string | null> {
        return (await this.sql.get<{ key_id: string }>("SELECT key_id FROM ai_key_choices WHERE person_id = ?", personId))?.key_id ?? null;
    }

    async setChosen(personId: string, keyId: string): Promise<void> {
        await this.sql.run(
            "INSERT INTO ai_key_choices (person_id, key_id, updated_at) VALUES (?,?,?) ON CONFLICT(person_id) DO UPDATE SET key_id = excluded.key_id, updated_at = excluded.updated_at",
            personId,
            keyId,
            this.nowIso(),
        );
    }

    async clearChosen(personId: string): Promise<void> {
        await this.sql.run("DELETE FROM ai_key_choices WHERE person_id = ?", personId);
    }
}
