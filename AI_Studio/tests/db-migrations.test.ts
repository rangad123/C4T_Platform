import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Db } from "../src/platform/db.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-db-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const tables = (db: Db) => new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));

describe("database migrations", () => {
    it("creates every table on a new database", () => {
        const db = new Db(path.join(dir, "fresh.db"));
        const t = tables(db);
        for (const n of ["runbooks", "runbook_runs", "custom_tests", "git_repos", "spec_versions", "live_session_audit"]) expect(t.has(n), n).toBe(true);
        db.raw.close();
    });

    it("repairs a database whose reserved slots were recorded before their SQL existed", () => {
        const file = path.join(dir, "old.db");
        const first = new Db(file);
        // Make the file look like one that ran with placeholders in slots 14, 22 and 23: versions recorded, tables absent.
        first.raw.exec(
            "DROP TABLE runbook_run_steps; DROP TABLE runbook_schedule_links; DROP TABLE runbook_token_links; DROP TABLE runbook_runs; DROP TABLE runbooks;" +
                "DROP TABLE custom_audit; DROP TABLE custom_helpers; DROP TABLE custom_script_versions; DROP TABLE custom_tests; DROP TABLE git_repos; DROP TABLE spec_versions;",
        );
        expect(tables(first).has("runbooks")).toBe(false);
        first.raw.close();

        const db = new Db(file);
        const t = tables(db);
        for (const n of ["runbooks", "runbook_runs", "runbook_run_steps", "custom_tests", "custom_helpers", "git_repos", "spec_versions"]) expect(t.has(n), n).toBe(true);
        // The statements the platform runs at start no longer fail.
        expect(db.all("SELECT * FROM runbook_runs WHERE status = 'running'")).toEqual([]);
        db.raw.close();

        // Opening again changes nothing.
        const again = new Db(file);
        expect(tables(again).has("runbooks")).toBe(true);
        again.raw.close();
    });
});
