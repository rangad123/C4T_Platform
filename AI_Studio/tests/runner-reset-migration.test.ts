/**
 * Migration 57 (the runner reset, docs/runner-implementation/RUNNER_ARCHITECTURE.md): a database left by the release before it, with team and personal runners,
 * credentials, codes, reservations, and running and queued tasks, ends with no runner at all; a running task and a queued recording end
 * failed with the sentence; a queued run stays queued; the run history still names where it ran. A fresh database and an upgraded one end
 * with the same runner schema, opening again re-runs nothing, and schedules and trigger tokens get their owner from Activity once.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentStore, RUNNER_REMOVED_IN_UPDATE } from "../src/platform/agent-store.js";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-reset-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const RUNNER_TABLES = ["agent_tokens", "agents", "runner_enrollments", "device_reservations", "runner_settings", "runner_update_settings"];
/** Every column, its type, not-null and default, and every index of the runner tables. */
function runnerSchema(db: Db) {
    const out: Record<string, unknown> = {};
    for (const t of RUNNER_TABLES) {
        out[t] = {
            columns: db.all("SELECT name, type, \"notnull\" AS nn, dflt_value AS d, pk FROM pragma_table_info(?) ORDER BY name", t),
            indexes: db.all("SELECT name, \"unique\" AS u FROM pragma_index_list(?) ORDER BY name", t).map((i) => ({ ...i, cols: db.all("SELECT name FROM pragma_index_info(?)", String(i.name)).map((c) => c.name) })),
            fks: db.all("SELECT \"table\" AS t, \"from\" AS f, \"to\" AS o, on_delete AS d FROM pragma_foreign_key_list(?) ORDER BY \"from\"", t),
        };
    }
    out.runner_access = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runner_access'") ?? null;
    return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A database as the release before migration 57 left it, with runners and their work in it. */
function oldDatabase(file: string): void {
    createDatabaseAtVersion(file, 56);
    const db = new DatabaseAt56(file);
    const now = Date.now();
    const t0 = iso(now - 3_600_000);
    db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-ann", "ann@people.example", "Ann", t0, "owner", "active");
    db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-bob", "bob@people.example", "Bob", t0, "editor", "active");
    db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "p1", "u-ann", "Shop", t0, t0);
    db.run("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES (?,?,?,?,?,?)", "app1", "p1", "https://app.example", "https://app.example", "{}", t0);
    // A team runner and Ann's own runner (two credentials of hers: from before one runner per person).
    db.run("INSERT INTO agent_tokens (id, project_id, label, token_hash, hint, created_at, kind) VALUES (?,?,?,?,?,?,?)", "k-team", "p1", "Lab PC", "h-team", "team", t0, "team");
    db.run("INSERT INTO agent_tokens (id, label, token_hash, hint, created_at, kind, owner_id) VALUES (?,?,?,?,?,?,?)", "k-ann", "Ann's laptop", "h-ann", "anna", t0, "personal", "u-ann");
    db.run("INSERT INTO agent_tokens (id, label, token_hash, hint, created_at, kind, owner_id) VALUES (?,?,?,?,?,?,?)", "k-ann2", null, "h-ann2", "ann2", t0, "personal", "u-ann");
    db.run("INSERT INTO runner_access (token_id, project_id, granted_at) VALUES (?,?,?)", "k-team", "p1", t0);
    const agent = (id: string, token: string, name: string) =>
        db.run("INSERT INTO agents (id, project_id, token_id, name, version, os, arch, node, capabilities_json, concurrency, first_seen_ms, last_seen_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", id, null, token, name, "1", "linux", "x64", "v24", "{}", 1, now, now);
    agent("a-team", "k-team", "lab-pc");
    agent("a-ann", "k-ann", "ann-pc");
    db.run("INSERT INTO runner_enrollments (id, code_hash, hint, kind, owner_id, created_at, expires_ms) VALUES (?,?,?,?,?,?,?)", "e1", "c-hash", "code", "personal", "u-ann", t0, now + 60_000);
    db.run("INSERT INTO runner_settings (project_id, run_on, agent_id, updated_at, allow_personal) VALUES (?,?,?,?,?)", "p1", "agent", "a-team", t0, 0);
    db.run("INSERT INTO runner_update_settings (agent_id, auto, requested_at, updated_at) VALUES (?,?,?,?)", "a-ann", 1, now, t0);
    const job = (id: string) =>
        db.run("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", id, "p1", "app1", "VALIDATING", JSON.stringify({ mode: "validate", startedBy: { kind: "user", id: "u-ann" } }), "{}", "{}", t0, t0);
    const task = (id: string, jobId: string, status: string, agentId: string | null, adapter = "playwright") =>
        db.run("INSERT INTO agent_tasks (id, project_id, job_id, adapter_id, status, agent_id, payload_enc, created_ms, owner_id, phase) VALUES (?,?,?,?,?,?,?,?,?,?)", id, "p1", jobId, adapter, status, agentId, "x", now - 1000, "u-ann", status);
    job("j-running");
    job("j-queued");
    task("t-running", "j-running", "running", "a-ann");
    task("t-queued", "j-queued", "queued", null);
    task("t-record", "record:r1", "queued", null, "record:a-ann");
    db.run("INSERT INTO device_reservations (agent_id, family, device, task_id, project_id, reserved_ms) VALUES (?,?,?,?,?,?)", "a-ann", "android", "*", "t-running", "p1", now);
    // Owner attribution: a schedule edited by Ann, one made by Bob alone in its window, one whose latest change was by the shared key,
    // a trigger token Bob made, and two tokens made together (not certain).
    const schedule = (id: string, at: string) =>
        db.run("INSERT INTO schedules (id, project_id, name, kind, cadence_json, enabled, retry_failures, next_run_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, "p1", id, "validate", "{}", 0, 1, null, null, at, at);
    const activity = (kind: string, actor: string | null, action: string, p: string | null, at: string) =>
        db.run("INSERT INTO activity (at, actor_kind, actor_id, actor_name, action, path, project_id, status) VALUES (?,?,?,?,?,?,?,?)", at, kind, actor, "x", action, p, "p1", 200);
    const sEdited = iso(now - 900_000);
    const sMade = iso(now - 600_000);
    const sKey = iso(now - 300_000);
    schedule("s-edited", sEdited);
    schedule("s-made", sMade);
    schedule("s-key", sKey);
    activity("user", "u-ann", "PATCH /api/projects/:id/schedules/:sid", "/api/projects/p1/schedules/s-edited", iso(now - 100_000));
    activity("user", "u-bob", "POST /api/projects/:id/schedules", "/api/projects/p1/schedules", iso(Date.parse(sMade) + 2_000));
    activity("user", "u-ann", "PATCH /api/projects/:id/schedules/:sid", "/api/projects/p1/schedules/s-key", iso(now - 90_000));
    activity("key", null, "PATCH /api/projects/:id/schedules/:sid", "/api/projects/p1/schedules/s-key", iso(now - 80_000));
    const token = (id: string, at: string) => db.run("INSERT INTO trigger_tokens (id, project_id, token_hash, hint, created_at) VALUES (?,?,?,?,?)", id, "p1", `th-${id}`, "hint", at);
    const tBob = iso(now - 2_000_000);
    const tPair = iso(now - 1_500_000);
    token("tt-bob", tBob);
    token("tt-a", tPair);
    token("tt-b", iso(Date.parse(tPair) + 1_000));
    activity("user", "u-bob", "POST /api/projects/:id/triggers", "/api/projects/p1/triggers", iso(Date.parse(tBob) + 500));
    activity("user", "u-ann", "POST /api/projects/:id/triggers", "/api/projects/p1/triggers", iso(Date.parse(tPair) + 500));
    db.close();
}

/** A connection that runs no migration: the file stays at the version createDatabaseAtVersion left it at. */
class DatabaseAt56 {
    private readonly raw: import("node:sqlite").DatabaseSync;
    constructor(file: string) {
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
        this.raw = new DatabaseSync(file);
        this.raw.exec("PRAGMA foreign_keys = ON");
    }
    run(sql: string, ...params: Array<string | number | null>): void {
        this.raw.prepare(sql).run(...params);
    }
    close(): void {
        this.raw.close();
    }
}

describe("migration 57: the runner reset", () => {
    const file = path.join(dir, "old.db");

    it("removes every runner, fails the work that was on one with the sentence, keeps the queued run and the history", () => {
        oldDatabase(file);
        const db = new Db(file);
        try {
            expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(knownSchemaVersion());
            for (const t of ["agent_tokens", "agents", "runner_enrollments", "device_reservations", "runner_update_settings"]) expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n, t).toBe(0);
            expect(db.get("SELECT name FROM sqlite_master WHERE name = 'runner_access'")).toBeUndefined();
            // The project keeps where its tests run; the pin and the project switch are gone.
            expect(db.all("SELECT * FROM runner_settings")).toEqual([{ project_id: "p1", run_on: "agent", updated_at: expect.any(String) }]);
            const task = (id: string) => db.get<{ status: string; error: string | null; phase: string; finished_ms: number | null }>("SELECT status, error, phase, finished_ms FROM agent_tasks WHERE id = ?", id)!;
            expect(task("t-running")).toMatchObject({ status: "failed", error: RUNNER_REMOVED_IN_UPDATE, phase: "failed" });
            expect(task("t-running").finished_ms).toBeGreaterThan(Date.now() - 60_000);
            expect(task("t-record")).toMatchObject({ status: "failed", error: RUNNER_REMOVED_IN_UPDATE });
            expect(task("t-queued")).toMatchObject({ status: "queued", error: null });
            // The run says so, and still names the runner it ran on.
            expect(db.all("SELECT job_id, level, message FROM agent_events WHERE kind = 'runner_removed'")).toEqual([{ job_id: "j-running", level: "warn", message: RUNNER_REMOVED_IN_UPDATE }]);
            const ranOn = JSON.parse(db.get<{ r: string }>("SELECT ran_on_json AS r FROM generation_jobs WHERE id = 'j-running'")!.r);
            expect(ranOn).toMatchObject({ agentId: "a-ann", tokenId: "k-ann", name: "Ann's laptop", taskId: "t-running", phase: "failed" });
            expect(db.get<{ r: string | null }>("SELECT ran_on_json AS r FROM generation_jobs WHERE id = 'j-queued'")!.r).toBeNull();
            // The text is plain and says what to do.
            expect(RUNNER_REMOVED_IN_UPDATE).toBe("The runner this run was on was removed in an update. Download the new runner in Settings, Your runner, then start the run again.");
        } finally {
            db.close();
        }
    });

    it("gives schedules and trigger tokens their owner from Activity once, only where certain", () => {
        const db = new Db(file);
        try {
            const owner = (table: string, id: string) => db.get<{ o: string | null }>(`SELECT created_by AS o FROM ${table} WHERE id = ?`, id)!.o;
            expect(owner("schedules", "s-edited")).toBe("u-ann");
            expect(owner("schedules", "s-made")).toBe("u-bob");
            // Its latest change was by the shared key: not certain.
            expect(owner("schedules", "s-key")).toBeNull();
            expect(owner("trigger_tokens", "tt-bob")).toBe("u-bob");
            // Two tokens made in the same 10 seconds: not certain which one the create was.
            expect(owner("trigger_tokens", "tt-a")).toBeNull();
            expect(owner("trigger_tokens", "tt-b")).toBeNull();
            // Start-up no longer attributes anything: a schedule left without an owner stays so when the database is opened again.
            db.run("INSERT INTO activity (at, actor_kind, actor_id, actor_name, action, path, project_id, status) VALUES (?,?,?,?,?,?,?,?)", new Date().toISOString(), "user", "u-ann", "x", "PATCH /api/projects/:id/schedules/:sid", "/api/projects/p1/schedules/s-key", "p1", 200);
        } finally {
            db.close();
        }
        const again = new Db(file);
        try {
            expect(again.get<{ o: string | null }>("SELECT created_by AS o FROM schedules WHERE id = 's-key'")!.o).toBeNull();
        } finally {
            again.close();
        }
    });

    it("opening the database again re-runs nothing: no slot, no repair", () => {
        const db = new Db(file);
        try {
            // A runner made after the upgrade survives a restart.
            const store = new AgentStore(db);
            store.createPersonalToken({ ownerId: "u-ann", label: "New laptop", createdBy: "test" });
            db.run("UPDATE agent_tasks SET status = 'queued', error = NULL WHERE id = 't-running'");
        } finally {
            db.close();
        }
        const again = new Db(file);
        try {
            expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version WHERE version = 57")!.n).toBe(1);
            expect(again.all<{ label: string }>("SELECT label FROM agent_tokens")).toEqual([{ label: "New laptop" }]);
            expect(again.get<{ status: string }>("SELECT status FROM agent_tasks WHERE id = 't-running'")!.status).toBe("queued");
            expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_events WHERE kind = 'runner_removed'")!.n).toBe(1);
        } finally {
            again.close();
        }
    });

    it("a fresh database and an upgraded one end with the same runner schema", () => {
        const fresh = new Db(path.join(dir, "fresh.db"));
        const upgraded = new Db(file);
        try {
            expect(runnerSchema(upgraded)).toEqual(runnerSchema(fresh));
            expect(runnerSchema(fresh).runner_access).toBeNull();
            const cols = (runnerSchema(fresh).agent_tokens as { columns: Array<{ name: string }> }).columns.map((c) => c.name);
            for (const gone of ["kind", "project_id", "organization_id", "revoked_at"]) expect(cols).not.toContain(gone);
            for (const kept of ["token_hash", "owner_id", "machine_id", "previous_hash", "previous_until_ms", "rotated_at", "allow_code_scripts", "allow_private_targets", "allow_real_phone"]) expect(cols).toContain(kept);
        } finally {
            fresh.close();
            upgraded.close();
        }
    });

    it("one credential per person: a second enrolment replaces the first, by construction", () => {
        const db = new Db(path.join(dir, "enrol.db"));
        try {
            db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-cy", "cy@people.example", "Cy", new Date().toISOString(), "owner", "active");
            const store = new AgentStore(db);
            const first = store.redeemEnrollment(store.createPersonalEnrollment({ ownerId: "u-cy", createdBy: "Cy" }).code, { name: "laptop", machineId: "m-1" });
            const second = store.redeemEnrollment(store.createPersonalEnrollment({ ownerId: "u-cy", createdBy: "Cy" }).code, { name: "desktop", machineId: "m-2" });
            expect(first.ok && second.ok).toBe(true);
            if (!first.ok || !second.ok) return;
            expect(first.replaced).toBe(false);
            expect(second.replaced).toBe(true);
            expect(db.all("SELECT id FROM agent_tokens WHERE owner_id = 'u-cy'")).toEqual([{ id: second.token.id }]);
            expect(store.findToken(first.secret)).toBeUndefined();
            expect(store.runnerOf("u-cy")?.token.id).toBe(second.token.id);
            // The database itself refuses a second row for the same person.
            expect(() => db.run("INSERT INTO agent_tokens (id, owner_id, token_hash, hint, created_at) VALUES ('x', 'u-cy', 'h-x', 'x', 'now')")).toThrow(/UNIQUE/);
        } finally {
            db.close();
        }
    });
});
