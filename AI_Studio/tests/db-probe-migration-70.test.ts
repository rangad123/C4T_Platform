/**
 * Migration 70 (a project's database checks, db-probe-store.ts): a database at 68 opens to 70, keeping its projects, with no probe set up
 * (off). A database that recorded 70 as `-- reserved` (Phase 5 branches) gets the table when it opens (LATE_FILLED_SLOTS). A probe
 * setting goes with its project. Opening again re-runs nothing.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-probe70-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const at = "2026-11-22T10:00:00.000Z";
const columns = (db: Db) => db.all("SELECT name, type, \"notnull\" AS nn, pk FROM pragma_table_info('project_db_probes') ORDER BY name");

function withProject(file: string, version: number, reserved70 = false): void {
    createDatabaseAtVersion(file, version);
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
    raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("p1", "u-1", "Shop", at, at);
    if (reserved70) raw.prepare("INSERT INTO schema_version (version) VALUES (?), (?)").run(69, 70);
    raw.close();
}

describe("migration 70", () => {
    it("takes a database at 68 to 70 with no probe set up, and a probe goes with its project", () => {
        expect(knownSchemaVersion()).toBeGreaterThanOrEqual(70);
        const file = path.join(dir, "at68.db");
        withProject(file, 68);
        const db = new Db(file);
        expect(db.all("SELECT version FROM schema_version WHERE version BETWEEN 68 AND 70 ORDER BY version")).toEqual([{ version: 68 }, { version: 69 }, { version: 70 }]);
        expect(db.all("SELECT id FROM projects")).toEqual([{ id: "p1" }]);
        expect(db.all("SELECT * FROM project_db_probes")).toEqual([]);
        expect(columns(db)).toEqual(columns(new Db(":memory:")));
        db.run("INSERT INTO project_db_probes (project_id, enabled, url, token_enc, updated_at) VALUES (?,?,?,?,?)", "p1", 1, "https://probe.example.com", "enc", at);
        db.run("DELETE FROM projects WHERE id = ?", "p1");
        expect(db.all("SELECT * FROM project_db_probes")).toEqual([]);
        db.close();
        const again = new Db(file);
        expect(again.all("SELECT version FROM schema_version WHERE version BETWEEN 69 AND 70")).toHaveLength(2);
        again.close();
    });

    it("gives a database that recorded 70 as reserved the table", () => {
        const file = path.join(dir, "reserved70.db");
        withProject(file, 68, true);
        const db = new Db(file);
        expect(columns(db)).toEqual(columns(new Db(":memory:")));
        expect(db.all("SELECT id FROM projects")).toEqual([{ id: "p1" }]);
        db.close();
    });
});
