/**
 * Device farms of a project: the provider connections (credentials encrypted with the platform's SecretBox and write-only: no answer ever carries them),
 * where the project's phone tests run (this computer or runner, or a farm; how many at once; every test on every phone or shared out), and the farm
 * sessions of past runs with their links (video and logs on the provider's site).
 *
 * Nothing is stored for a project that never set anything: reading gives "run on this computer's phone, one at a time", which is what the platform
 * always did.
 */
import { randomUUID } from "node:crypto";
import type { Db, Row } from "./db.js";
import type { SecretBox } from "./secrets.js";
import { FARM_LIMITS, type FarmConnection, type FarmDevice, type FarmRunPlan, type FarmSessionRecord, type ProviderId } from "../engine/mobile/cloud/types.js";

/** Migration slot 28. Written with IF NOT EXISTS so it is safe whatever position the lead gives it among this round's slots. */
export const DEVICE_FARM_MIGRATION = `
CREATE TABLE IF NOT EXISTS device_farms (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,                -- browserstack | saucelabs | lambdatest | appium
    label TEXT NOT NULL,
    settings_json TEXT NOT NULL,           -- { region?, hubUrl?, devices: [{ name, osVersion? }] }: no secrets
    secrets_enc TEXT,                      -- SecretBox { username, accessKey }; never returned by the API
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_farms_project ON device_farms(project_id);
CREATE TABLE IF NOT EXISTS device_farm_choice (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    run_on TEXT NOT NULL,                  -- device (this computer or the project's runner) | farm
    farm_id TEXT,
    parallel INTEGER NOT NULL DEFAULT 1,   -- phone tests at once (1-10)
    matrix INTEGER NOT NULL DEFAULT 0,     -- 1: every test on every picked phone
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_farm_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT,
    test_id TEXT NOT NULL,
    farm_id TEXT,
    provider TEXT NOT NULL,
    device TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,                  -- passed | failed | error
    link TEXT,                             -- the provider's page for the session (built from the session id only)
    at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_farm_sessions_project ON device_farm_sessions(project_id, id);
`;

/** Sessions kept per project (older ones are removed as new ones arrive). */
export const SESSIONS_KEPT = 500;

interface Settings {
    region?: string;
    hubUrl?: string;
    devices: FarmDevice[];
}
interface Secrets {
    username?: string;
    accessKey?: string;
}

/** What the API shows about a connection: never the credentials, only whether they are set. */
export interface PublicFarm {
    id: string;
    provider: ProviderId;
    label: string;
    region: string | null;
    hubUrl: string | null;
    devices: FarmDevice[];
    credentialsSet: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface DeviceChoiceSetting {
    runOn: "device" | "farm";
    farmId: string | null;
    parallel: number;
    matrix: boolean;
}

export const DEFAULT_CHOICE: DeviceChoiceSetting = { runOn: "device", farmId: null, parallel: 1, matrix: false };

const now = () => new Date().toISOString();

/** True when the project's phone tests run on a device farm that still exists (no secrets are read). Used by the "can phone tests run?" gates. */
export function farmChosen(db: Db, projectId: string): boolean {
    try {
        return db.get("SELECT 1 AS x FROM device_farm_choice c JOIN device_farms f ON f.id = c.farm_id AND f.project_id = c.project_id WHERE c.project_id = ? AND c.run_on = 'farm'", projectId) !== undefined;
    } catch {
        return false;
    }
}

export class DeviceFarmStore {
    constructor(
        private readonly db: Db,
        private readonly box: SecretBox,
    ) {}

    private settingsOf(r: Row): Settings {
        try {
            const s = JSON.parse(String(r.settings_json)) as Settings;
            return { ...(typeof s.region === "string" ? { region: s.region } : {}), ...(typeof s.hubUrl === "string" ? { hubUrl: s.hubUrl } : {}), devices: Array.isArray(s.devices) ? s.devices.slice(0, FARM_LIMITS.devicesPerConnection) : [] };
        } catch {
            return { devices: [] };
        }
    }

    private secretsOf(r: Row): Secrets {
        if (!r.secrets_enc) return {};
        try {
            return this.box.decrypt<Secrets>(String(r.secrets_enc));
        } catch {
            return {}; // the encryption key changed: as if none were saved
        }
    }

    private toPublic(r: Row): PublicFarm {
        const s = this.settingsOf(r);
        const sec = this.secretsOf(r);
        return { id: r.id, provider: r.provider, label: r.label, region: s.region ?? null, hubUrl: s.hubUrl ?? null, devices: s.devices, credentialsSet: Boolean(sec.username || sec.accessKey), createdAt: r.created_at, updatedAt: r.updated_at };
    }

    list(projectId: string): PublicFarm[] {
        return this.db.all<Row>("SELECT * FROM device_farms WHERE project_id = ? ORDER BY created_at, id", projectId).map((r) => this.toPublic(r));
    }

    get(projectId: string, id: string): PublicFarm | undefined {
        const r = this.db.get<Row>("SELECT * FROM device_farms WHERE project_id = ? AND id = ?", projectId, id);
        return r ? this.toPublic(r) : undefined;
    }

    count(projectId: string): number {
        return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM device_farms WHERE project_id = ?", projectId)?.n ?? 0;
    }

    create(projectId: string, v: { provider: ProviderId; label: string; region?: string; hubUrl?: string; devices: FarmDevice[]; username?: string; accessKey?: string }): PublicFarm {
        const id = randomUUID();
        const t = now();
        const settings: Settings = { ...(v.region ? { region: v.region } : {}), ...(v.hubUrl ? { hubUrl: v.hubUrl } : {}), devices: v.devices };
        const secrets: Secrets = { ...(v.username ? { username: v.username } : {}), ...(v.accessKey ? { accessKey: v.accessKey } : {}) };
        this.db.run(
            "INSERT INTO device_farms (id, project_id, provider, label, settings_json, secrets_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            id, projectId, v.provider, v.label, JSON.stringify(settings), Object.keys(secrets).length ? this.box.encrypt(secrets) : null, t, t,
        );
        return this.get(projectId, id)!;
    }

    /** Changes what is given. Credentials are replaced only when given (an empty string removes one); they are never read back. */
    update(projectId: string, id: string, v: { label?: string; region?: string | null; hubUrl?: string | null; devices?: FarmDevice[]; username?: string; accessKey?: string }): PublicFarm | undefined {
        const r = this.db.get<Row>("SELECT * FROM device_farms WHERE project_id = ? AND id = ?", projectId, id);
        if (!r) return undefined;
        const s = this.settingsOf(r);
        const next: Settings = {
            ...(v.region === undefined ? (s.region ? { region: s.region } : {}) : v.region ? { region: v.region } : {}),
            ...(v.hubUrl === undefined ? (s.hubUrl ? { hubUrl: s.hubUrl } : {}) : v.hubUrl ? { hubUrl: v.hubUrl } : {}),
            devices: v.devices ?? s.devices,
        };
        const sec = this.secretsOf(r);
        if (v.username !== undefined) sec.username = v.username || undefined;
        if (v.accessKey !== undefined) sec.accessKey = v.accessKey || undefined;
        const clean = Object.fromEntries(Object.entries(sec).filter(([, x]) => x));
        this.db.run(
            "UPDATE device_farms SET label = ?, settings_json = ?, secrets_enc = ?, updated_at = ? WHERE id = ?",
            v.label ?? r.label, JSON.stringify(next), Object.keys(clean).length ? this.box.encrypt(clean) : null, now(), id,
        );
        return this.get(projectId, id);
    }

    delete(projectId: string, id: string): boolean {
        const changes = Number(this.db.run("DELETE FROM device_farms WHERE project_id = ? AND id = ?", projectId, id).changes);
        // A project whose farm is gone runs its phone tests where it did before choosing one.
        if (changes) this.db.run("UPDATE device_farm_choice SET run_on = 'device', farm_id = NULL, updated_at = ? WHERE project_id = ? AND farm_id = ?", now(), projectId, id);
        return changes > 0;
    }

    /** The connection with its decrypted credentials: for a run only (never returned, logged or stored in this form). */
    connection(projectId: string, id: string): FarmConnection | undefined {
        const r = this.db.get<Row>("SELECT * FROM device_farms WHERE project_id = ? AND id = ?", projectId, id);
        if (!r) return undefined;
        const s = this.settingsOf(r);
        const sec = this.secretsOf(r);
        return {
            id: r.id,
            provider: r.provider as ProviderId,
            label: r.label,
            ...(s.region ? { region: s.region as FarmConnection["region"] } : {}),
            ...(s.hubUrl ? { hubUrl: s.hubUrl } : {}),
            devices: s.devices,
            ...(sec.username ? { username: sec.username } : {}),
            ...(sec.accessKey ? { accessKey: sec.accessKey } : {}),
        };
    }

    choice(projectId: string): DeviceChoiceSetting {
        const r = this.db.get<Row>("SELECT * FROM device_farm_choice WHERE project_id = ?", projectId);
        if (!r) return { ...DEFAULT_CHOICE };
        return { runOn: r.run_on === "farm" && r.farm_id ? "farm" : "device", farmId: r.farm_id ?? null, parallel: Math.max(1, Math.min(FARM_LIMITS.maxParallel, Number(r.parallel) || 1)), matrix: Number(r.matrix) === 1 };
    }

    setChoice(projectId: string, c: DeviceChoiceSetting): DeviceChoiceSetting {
        this.db.run(
            "INSERT INTO device_farm_choice (project_id, run_on, farm_id, parallel, matrix, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET run_on = excluded.run_on, farm_id = excluded.farm_id, parallel = excluded.parallel, matrix = excluded.matrix, updated_at = excluded.updated_at",
            projectId, c.runOn, c.farmId, c.parallel, c.matrix ? 1 : 0, now(),
        );
        return this.choice(projectId);
    }

    /** The run plan for the project's farm, when its phone tests run on one. */
    plan(projectId: string): FarmRunPlan | undefined {
        const c = this.choice(projectId);
        if (c.runOn !== "farm" || !c.farmId) return undefined;
        const connection = this.connection(projectId, c.farmId);
        return connection ? { connection, parallel: c.parallel, matrix: c.matrix } : undefined;
    }

    addSession(projectId: string, jobId: string | null, farmId: string | null, s: FarmSessionRecord): void {
        this.db.run(
            "INSERT INTO device_farm_sessions (project_id, job_id, test_id, farm_id, provider, device, session_id, status, link, at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            projectId, jobId, s.testId.slice(0, 120), farmId, s.provider, s.device.slice(0, 160), s.sessionId.slice(0, 120), s.status, s.link ?? null, now(),
        );
        this.db.run("DELETE FROM device_farm_sessions WHERE project_id = ? AND id NOT IN (SELECT id FROM device_farm_sessions WHERE project_id = ? ORDER BY id DESC LIMIT ?)", projectId, projectId, SESSIONS_KEPT);
    }

    sessions(projectId: string, o: { testId?: string; jobId?: string; limit?: number } = {}): Array<{ id: number; jobId: string | null; testId: string; provider: string; device: string; sessionId: string; status: string; link: string | null; at: string }> {
        const where = ["project_id = ?"];
        const args: string[] = [projectId];
        if (o.testId) {
            where.push("test_id = ?");
            args.push(o.testId);
        }
        if (o.jobId) {
            where.push("job_id = ?");
            args.push(o.jobId);
        }
        const limit = Math.max(1, Math.min(200, o.limit ?? 50));
        return this.db
            .all<Row>(`SELECT * FROM device_farm_sessions WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`, ...args)
            .map((r) => ({ id: r.id, jobId: r.job_id ?? null, testId: r.test_id, provider: r.provider, device: r.device, sessionId: r.session_id, status: r.status, link: r.link ?? null, at: r.at }));
    }
}
