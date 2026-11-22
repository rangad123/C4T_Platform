/**
 * Migration 72 (Phase 6 code host): a slot-71 database's repository connection (G1 kept it in integrations as kind `code`) moves to
 * code_repos with its encrypted token and webhook secret still readable, and leaves the issue trackers where they were; the earliest of
 * two connections of one project is kept; pr_events and pr_selections start empty and go with their project; a delivery id is kept once
 * per project; a fresh database and an upgraded one end with the same schema; a database already at 72 opens again without re-running.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodeHostStore } from "../src/platform/code-host/store.js";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";
import { SecretBox } from "../src/platform/secrets.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-code72-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const box = new SecretBox(dir, "code-host-migration-72-key");
const at = "2026-11-21T10:00:00.000Z";
const later = "2026-11-21T11:00:00.000Z";
const TABLES = ["code_repos", "pr_events", "pr_selections", "integrations"];
const schemaOf = (db: Db) =>
    TABLES.map((t) => ({
        t,
        columns: db.all(`SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info('${t}') ORDER BY name`),
        indexes: db.all(`SELECT name, "unique" AS u FROM pragma_index_list('${t}') ORDER BY name`),
        fks: db.all(`SELECT "table" AS t, "from" AS f, on_delete AS d FROM pragma_foreign_key_list('${t}') ORDER BY "from"`),
    }));

function databaseAt71(file: string): void {
    createDatabaseAtVersion(file, 71);
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
    for (const p of ["p1", "p2", "p3"]) raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run(p, "u-1", p, at, at);
    const ins = raw.prepare("INSERT INTO integrations (id, project_id, kind, name, config_json, secret_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
    ins.run("i-code-1", "p1", "code", "GitHub acme/shop", JSON.stringify({ kind: "code", host: "github", owner: "acme", repo: "shop", apiUrl: "https://ghe.example/api/v3" }), box.encrypt({ token: "tok-1", webhookSecret: "secret-one-0123456789" }), at, at);
    ins.run("i-gh-1", "p1", "github", "Issues", JSON.stringify({ kind: "github", owner: "acme", repo: "shop" }), box.encrypt({ token: "issues" }), at, at);
    ins.run("i-code-2b", "p2", "code", "GitHub acme/new", JSON.stringify({ kind: "code", host: "github", owner: "acme", repo: "new" }), box.encrypt({ token: "tok-2b" }), later, later);
    ins.run("i-code-2a", "p2", "code", "GitHub acme/old", JSON.stringify({ kind: "code", host: "github", owner: "acme", repo: "old" }), box.encrypt({ token: "tok-2a" }), at, at);
    raw.close();
}

describe("migration 72", () => {
    it("is known to this code", () => {
        expect(knownSchemaVersion()).toBeGreaterThanOrEqual(72);
    });

    it("moves each project's code connection to code_repos with readable secrets and keeps the issue trackers", () => {
        const file = path.join(dir, "at71.db");
        databaseAt71(file);
        const db = new Db(file);
        expect(db.all("SELECT version FROM schema_version WHERE version IN (71, 72) ORDER BY version")).toEqual([{ version: 71 }, { version: 72 }]);
        expect(db.all("SELECT id, project_id, host, owner, repo, api_url, hook_token_hash, feedback, created_at FROM code_repos ORDER BY project_id")).toEqual([
            { id: "i-code-1", project_id: "p1", host: "github", owner: "acme", repo: "shop", api_url: "https://ghe.example/api/v3", hook_token_hash: null, feedback: 0, created_at: at },
            { id: "i-code-2a", project_id: "p2", host: "github", owner: "acme", repo: "old", api_url: null, hook_token_hash: null, feedback: 0, created_at: at },
        ]);
        expect(db.all("SELECT id, kind FROM integrations ORDER BY id")).toEqual([{ id: "i-gh-1", kind: "github" }]);
        const store = new CodeHostStore(db, box);
        process.env.CODE_HOST_GITHUB_API_URL = "https://ghe.example/api/v3";
        try {
            expect(store.get("p1")).toMatchObject({ owner: "acme", repo: "shop", apiUrl: "https://ghe.example/api/v3", webhookSecretSet: true, webhookUrlSet: false, feedback: false });
        } finally {
            delete process.env.CODE_HOST_GITHUB_API_URL;
        }
        expect(store.get("p2")).toMatchObject({ repo: "old", webhookSecretSet: false });
        expect(store.get("p3")).toBeUndefined();
        expect(db.all("SELECT * FROM pr_events")).toEqual([]);
        expect(db.all("SELECT * FROM pr_selections")).toEqual([]);
        db.close();
    });

    it("keeps a delivery once per project, and removes a project's repository, events and selections with it", () => {
        const db = new Db(":memory:");
        db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
        for (const p of ["p1", "p2"]) db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", p, "u-1", p, at, at);
        const store = new CodeHostStore(db, box);
        store.save("p1", { owner: "acme", repo: "shop", token: "tok" });
        expect(store.recordEvent("p1", { deliveryId: "d-1", event: "ping" })).toBe(true);
        expect(store.recordEvent("p1", { deliveryId: "d-1", event: "pull_request", queued: "impact" })).toBe(false);
        expect(store.recordEvent("p2", { deliveryId: "d-1", event: "ping" })).toBe(true);
        db.run("INSERT INTO pr_selections (id, project_id, pr, head_sha, mode, selected_json, reasons_json, created_at) VALUES (?,?,?,?,?,?,?,?)", "s1", "p1", 7, "a".repeat(40), "focused", "[]", "{}", at);
        expect(db.all("SELECT project_id, event, queued FROM pr_events ORDER BY project_id")).toEqual([
            { project_id: "p1", event: "ping", queued: null },
            { project_id: "p2", event: "ping", queued: null },
        ]);
        db.run("DELETE FROM projects WHERE id = ?", "p1");
        expect(db.all("SELECT project_id FROM code_repos")).toEqual([]);
        expect(db.all("SELECT project_id FROM pr_events")).toEqual([{ project_id: "p2" }]);
        expect(db.all("SELECT id FROM pr_selections")).toEqual([]);
        db.close();
    });

    it("leaves an upgraded database with the same schema as a fresh one", () => {
        const file = path.join(dir, "at71b.db");
        databaseAt71(file);
        const upgraded = new Db(file);
        const fresh = new Db(":memory:");
        expect(schemaOf(upgraded)).toEqual(schemaOf(fresh));
        upgraded.close();
        fresh.close();
    });

    it("opens a database already at 72 without re-running a slot, keeping its rows", () => {
        const file = path.join(dir, "at72.db");
        createDatabaseAtVersion(file, 72);
        const raw = new DatabaseSync(file);
        raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
        raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("p1", "u-1", "p1", at, at);
        raw.prepare("INSERT INTO code_repos (id, project_id, host, owner, repo, secret_enc, hook_token_hash, feedback, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("r1", "p1", "github", "acme", "shop", "x", "h".repeat(64), 1, at, at);
        raw.close();
        const db = new Db(file);
        expect(db.all("SELECT version FROM schema_version WHERE version IN (71, 72) ORDER BY version")).toEqual([{ version: 71 }, { version: 72 }]);
        expect(db.all("SELECT id, feedback FROM code_repos")).toEqual([{ id: "r1", feedback: 1 }]);
        db.close();
    });
});
