/**
 * Migration 64 (application intelligence, second shape): a database left by the release before it, with model versions and rules,
 * keeps every row; it gains the sources table, the application version and source fingerprints on model versions and the fingerprint
 * on rules; a fresh database and an upgraded one end with the same schema; opening again re-runs nothing. Additive only.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-intel64-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const TABLES = ["app_model_versions", "app_rules", "app_sources"];
function schemaOf(db: Db) {
    const out: Record<string, unknown> = {};
    for (const t of TABLES) {
        out[t] = {
            columns: db.all("SELECT name, type, \"notnull\" AS nn, dflt_value AS d, pk FROM pragma_table_info(?) ORDER BY name", t),
            indexes: db.all("SELECT name, \"unique\" AS u FROM pragma_index_list(?) ORDER BY name", t).map((i) => ({ ...i, cols: db.all("SELECT name FROM pragma_index_info(?)", String(i.name)).map((c) => c.name) })),
            fks: db.all("SELECT \"table\" AS t, \"from\" AS f, \"to\" AS o, on_delete AS d FROM pragma_foreign_key_list(?) ORDER BY \"from\"", t),
        };
    }
    return out;
}

const at = "2026-11-01T10:00:00.000Z";
/** A database as the release before migration 64 left it, with an analysis and two rules (one confirmed by a person). */
function oldDatabase(file: string): void {
    createDatabaseAtVersion(file, 63);
    // node:sqlite directly, so opening does not migrate before the rows exist.
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
    raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("p1", "u-1", "Shop", at, at);
    raw.prepare("INSERT INTO app_model_versions (id, project_id, version, app_type, context_sources_json, model_json, note, created_at) VALUES (?,?,?,?,?,?,?,?)").run("v1", "p1", 1, "shop", "[\"url\"]", "{\"pages\":[{\"id\":\"cart\",\"path\":\"/cart\"}]}", "first", at);
    const rule = raw.prepare(
        "INSERT INTO app_rules (id, project_id, model_version_id, ref, kind, description, expected, source_type, source_ref, explicitness, confidence, status, decided_by, decided_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    rule.run("r1", "p1", "v1", "R-1", "constraint", "Quantity", "Between 1 and 10", "requirement", "req.md:3", "explicit", 0.9, "confirmed", "u-1", at, at, at);
    rule.run("r2", "p1", "v1", "R-2", "invariant", "Total", "Total is the sum", "inferred", "", "inferred", 0.4, "unverified", null, null, at, at);
    raw.close();
}

describe("migration 64", () => {
    it("is known to this code", () => {
        expect(knownSchemaVersion()).toBeGreaterThanOrEqual(64);
    });

    it("keeps every model version and rule, with its decision, and adds the new columns empty", () => {
        const file = path.join(dir, "old.db");
        oldDatabase(file);
        const db = new Db(file);
        expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(knownSchemaVersion());
        expect(db.all("SELECT id, version, model_json, note, app_version_json, source_fingerprints_json FROM app_model_versions")).toEqual([
            { id: "v1", version: 1, model_json: "{\"pages\":[{\"id\":\"cart\",\"path\":\"/cart\"}]}", note: "first", app_version_json: null, source_fingerprints_json: "{}" },
        ]);
        expect(db.all("SELECT id, ref, status, decided_by, expected, fingerprint FROM app_rules ORDER BY ref")).toEqual([
            { id: "r1", ref: "R-1", status: "confirmed", decided_by: "u-1", expected: "Between 1 and 10", fingerprint: null },
            { id: "r2", ref: "R-2", status: "unverified", decided_by: null, expected: "Total is the sum", fingerprint: null },
        ]);
        expect(db.all("SELECT * FROM app_sources")).toEqual([]);
        db.close();
    });

    it("leaves an upgraded database with the same schema as a fresh one, and re-runs nothing when opened again", () => {
        const file = path.join(dir, "old2.db");
        oldDatabase(file);
        const upgraded = new Db(file);
        const fresh = new Db(":memory:");
        expect(schemaOf(upgraded)).toEqual(schemaOf(fresh));
        upgraded.close();
        fresh.close();
        const again = new Db(file);
        expect(again.all("SELECT version FROM schema_version WHERE version = 64")).toHaveLength(1);
        again.close();
    });

    it("keeps one source row per project, kind and reference, and removes them with the project", () => {
        const db = new Db(":memory:");
        db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
        db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "p1", "u-1", "Shop", at, at);
        const add = (id: string) => db.run("INSERT INTO app_sources (id, project_id, kind, ref, status) VALUES (?,?,?,?,?)", id, "p1", "openapi", "https://shop.test/openapi.json", "connected");
        add("s1");
        expect(() => add("s2")).toThrow(/UNIQUE/);
        db.run("DELETE FROM projects WHERE id = ?", "p1");
        expect(db.all("SELECT * FROM app_sources")).toEqual([]);
        db.close();
    });

    it("only adds: it drops and renames nothing", () => {
        const fresh = new Db(":memory:");
        const at63 = path.join(dir, "at63.db");
        createDatabaseAtVersion(at63, 63);
        // Every table and column at 63 is still there at 64.
        const raw = new DatabaseSync(at63);
        const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
        for (const t of tables) {
            const before = (raw.prepare("SELECT name FROM pragma_table_info(?)").all(t) as Array<{ name: string }>).map((c) => c.name);
            const after = fresh.all<{ name: string }>("SELECT name FROM pragma_table_info(?)", t).map((c) => c.name);
            expect(after.length, t).toBeGreaterThan(0);
            expect(after, t).toEqual(expect.arrayContaining(before));
        }
        raw.close();
        fresh.close();
    });
});
