/**
 * Migration 61 (two kinds of AI keys, docs/features/ai-keys.md): a database left by the release before it, with Crowd4Test (platform),
 * organisation and project configurations, projects pointing at them and jobs that used them, ends with organisational keys assigned to
 * their maker, personal keys of their maker, a chosen key for the people who used one through a project, no project AI settings, and usage
 * rows a customer's own key paid for saying "personal". A key whose maker cannot be found is removed, never given to someone else. Opening
 * again re-runs nothing; a fresh database and an upgraded one end with the same AI key schema.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDatabaseAtVersion, Db } from "../src/platform/db.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-aikeys-mig-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

class DatabaseAt60 {
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

const t0 = new Date(Date.now() - 3_600_000).toISOString();

function oldDatabase(file: string): void {
    createDatabaseAtVersion(file, 60);
    const db = new DatabaseAt60(file);
    const person = (id: string, c4tRole: string | null, role: string) => db.run("INSERT INTO users (id, email, name, created_at, role, status, c4t_role) VALUES (?,?,?,?,?,?,?)", id, `${id}@people.example`, id, t0, role, "active", c4tRole);
    person("u-ada", "ADMIN", "owner");
    person("u-sam", "SUB_ADMIN", "owner");
    person("u-cora", "CUSTOMER", "editor");
    person("u-tia", "TESTER", "editor");
    // An id with an underscore: a LIKE pattern would take it for any character.
    person("u_x", "CUSTOMER", "editor");
    const project = (id: string) => db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", id, "u-ada", id, t0, t0);
    for (const p of ["p-managed", "p-own", "p-proj", "p-orphan"]) project(p);
    db.run("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES (?,?,?,?,?,?)", "app1", "p-managed", "https://app.example", "https://app.example", "{}", t0);
    const key = (id: string, kind: string, createdBy: string | null, extra: { org?: string; project?: string } = {}) =>
        db.run(
            "INSERT INTO ai_configurations (id, owner_kind, organization_id, project_id, label, provider, model, key_enc, key_hint, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            id, kind, extra.org ?? null, extra.project ?? null, id, "openai-compatible", "m", "enc", "1234", "working", createdBy, t0, t0,
        );
    key("k-platform", "platform", "ada (u-ada)");
    key("k-platform-nobody", "platform", "Gone person (u-gone)");
    key("k-org", "organization", "cora (u-cora)", { org: "org-a" });
    key("k-proj", "project", "tia (u-tia)", { project: "p-proj" });
    key("k-orphan", "project", "Someone (u-gone)", { project: "p-orphan" });
    // Sam's own key, used nowhere: as his only usable key, it becomes his choice.
    key("k-solo", "organization", "sam (u-sam)", { org: "org-a" });
    // A label cut before its "(id)": only an exact id counts.
    key("k-cut", "organization", "u-cora", { org: "org-a" });
    // Its maker "u-x" is gone; "u_x" must not be taken for them.
    key("k-wild", "organization", "Gone (u-x)", { org: "org-a" });
    // The id in the middle, not at the end: not a match.
    key("k-middle", "organization", "cora (u-cora) and more", { org: "org-a" });
    const setting = (projectId: string, mode: string, configurationId: string) => db.run("INSERT INTO project_ai_settings (project_id, mode, configuration_id, updated_at) VALUES (?,?,?,?)", projectId, mode, configurationId, t0);
    setting("p-managed", "managed", "k-platform");
    setting("p-own", "own", "k-org");
    setting("p-proj", "own", "k-proj");
    setting("p-orphan", "own", "k-orphan");
    const job = (id: string, projectId: string, startedBy: object) =>
        db.run("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", id, projectId, "app1", "COMPLETED", JSON.stringify({ mode: "generate", startedBy }), "{}", "{}", t0, t0);
    // Ada ran the managed project (its Crowd4Test key is assigned to her); Sam ran it too (not assigned: no choice for him).
    job("j1", "p-managed", { kind: "user", id: "u-ada" });
    job("j2", "p-managed", { kind: "user", id: "u-sam" });
    // Cora ran her organisation's project (her key); Sam ran it too (not his key: no choice). Tia's schedule ran her project's key.
    job("j3", "p-own", { kind: "user", id: "u-cora" });
    job("j4", "p-own", { kind: "user", id: "u-sam" });
    job("j5", "p-proj", { kind: "schedule", id: "s1", ownerId: "u-tia" });
    db.run("INSERT INTO ai_usage (job_id, project_id, purpose, model, day, calls, billing_owner, billing_organization_id) VALUES (?,?,?,?,?,?,?,?)", "j3", "p-own", "other", "m", "2026-11-01", 1, "organization", "org-a");
    db.run("INSERT INTO ai_usage (job_id, project_id, purpose, model, day, calls, billing_owner) VALUES (?,?,?,?,?,?,?)", "j1", "p-managed", "other", "m", "2026-11-01", 1, "crowd4test");
    db.close();
}

const keySchema = (db: Db) =>
    Object.fromEntries(
        ["ai_configurations", "ai_key_assignees", "ai_key_choices", "ai_usage"].map((t) => [
            t,
            {
                columns: db.all("SELECT name, type, \"notnull\" AS nn, dflt_value AS d, pk FROM pragma_table_info(?) ORDER BY name", t),
                indexes: db.all("SELECT name, \"unique\" AS u FROM pragma_index_list(?) ORDER BY name", t).map((i) => i.name),
                fks: db.all("SELECT \"table\" AS t, \"from\" AS f, on_delete AS d FROM pragma_foreign_key_list(?) ORDER BY \"from\"", t),
            },
        ]),
    );

describe("migration 61: two kinds of AI keys", () => {
    const file = path.join(dir, "old.db");

    it("turns every old key into one of the two kinds, with its maker (the exact id only), and removes a key whose maker is gone, saying how many", () => {
        oldDatabase(file);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const db = new Db(file);
        try {
            expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(["[ai-keys] 3 AI keys were removed: the person who added them is no longer here."]);
            expect(db.all("SELECT id, owner_kind, owner_person_id, organization_id, project_id FROM ai_configurations ORDER BY id")).toEqual([
                { id: "k-cut", owner_kind: "personal", owner_person_id: "u-cora", organization_id: null, project_id: null },
                { id: "k-org", owner_kind: "personal", owner_person_id: "u-cora", organization_id: null, project_id: null },
                { id: "k-platform", owner_kind: "organisational", owner_person_id: null, organization_id: null, project_id: null },
                { id: "k-platform-nobody", owner_kind: "organisational", owner_person_id: null, organization_id: null, project_id: null },
                { id: "k-proj", owner_kind: "personal", owner_person_id: "u-tia", organization_id: null, project_id: null },
                { id: "k-solo", owner_kind: "personal", owner_person_id: "u-sam", organization_id: null, project_id: null },
            ]);
            expect(db.all("SELECT key_id, person_id FROM ai_key_assignees ORDER BY key_id")).toEqual([{ key_id: "k-platform", person_id: "u-ada" }]);
        } finally {
            warn.mockRestore();
            db.close();
        }
    });

    it("gives a chosen key to the people who used one through a project, only where they may still use it; else their only usable key", () => {
        const db = new Db(file);
        try {
            expect(db.all("SELECT person_id, key_id FROM ai_key_choices ORDER BY person_id")).toEqual([
                { person_id: "u-ada", key_id: "k-platform" },
                { person_id: "u-cora", key_id: "k-org" },
                { person_id: "u-sam", key_id: "k-solo" },
                { person_id: "u-tia", key_id: "k-proj" },
            ]);
            expect(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_ai_settings'")).toBeUndefined();
        } finally {
            db.close();
        }
    });

    it("usage a customer's own key paid for now says personal; Crowd4Test's stays", () => {
        const db = new Db(file);
        try {
            expect(db.all("SELECT job_id, billing_owner FROM ai_usage ORDER BY job_id")).toEqual([
                { job_id: "j1", billing_owner: "crowd4test" },
                { job_id: "j3", billing_owner: "personal" },
            ]);
        } finally {
            db.close();
        }
    });

    it("opening again re-runs nothing, and a fresh database has the same AI key schema", () => {
        const again = new Db(file);
        const fresh = new Db(path.join(dir, "fresh.db"));
        try {
            expect(again.all("SELECT person_id FROM ai_key_choices")).toHaveLength(4);
            expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version WHERE version = 61")?.n).toBe(1);
            expect(keySchema(again)).toEqual(keySchema(fresh));
        } finally {
            again.close();
            fresh.close();
        }
    });
});
