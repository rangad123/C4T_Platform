/**
 * The races of POSTGRES_S3_MIGRATION.md §2.3, as far as SQLite can show them. SQLite has one writer, so a real interleaving cannot
 * happen here; where a race needs "someone else wrote in between", a trigger or a user function plays the other writer at exactly
 * that moment. The PostgreSQL tier (M4) runs the real concurrent versions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Db } from "../src/platform/db.js";
import { Repo, type JobOptions } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { SpecVersionStore } from "../src/platform/spec-version-store.js";
import { retryOnUniqueViolation, sqliteDialect } from "../src/platform/sql-dialect.js";
import { UserStore } from "../src/platform/user-store.js";
import type { TestSpec } from "../src/engine/spec/schema.js";

const dirs: string[] = [];
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sql-races-"));
    dirs.push(dir);
    const file = path.join(dir, "t.db");
    const db = new Db(file);
    const repo = new Repo(db, new SecretBox(dir));
    const projectId = repo.createProject({ name: "Races" }).id as string;
    const appId = repo.createApplication(projectId, "https://app.example.com/", {});
    const suiteId = repo.getOrCreateSuite(projectId, "Main", "main");
    const testId = "t-1";
    const at = new Date().toISOString();
    db.run(
        "INSERT INTO test_cases (id, project_id, suite_id, test_key, title, kind, type, priority, validation_status, framework, spec_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        testId, projectId, suiteId, "T-001", "A test", "ui", "functional", "P2", "PENDING", "playwright", "{}", at, at,
    );
    return { dir, file, db, repo, projectId, appId, suiteId, testId };
}

const OPTIONS = { maxPages: 1, maxDepth: 1, maxScenarios: 1 } as JobOptions;

describe("claimNextJob", () => {
    it("gives each queued job to one worker only, also across two connections to the same file", async () => {
        const s = setup();
        const other = new Repo(new Db(s.file), new SecretBox(s.dir));
        const a = (await s.repo.createJob(s.projectId, s.appId, OPTIONS)).id;
        const b = (await s.repo.createJob(s.projectId, s.appId, OPTIONS)).id;
        const first = s.repo.claimNextJob(60_000, "w1");
        const second = other.claimNextJob(60_000, "w2");
        const third = s.repo.claimNextJob(60_000, "w1");
        expect([first?.id, second?.id].sort()).toEqual([a, b].sort());
        expect(third).toBeUndefined();
        expect(s.db.get("SELECT lease_owner FROM generation_jobs WHERE id = ?", second!.id)?.lease_owner).toBe("w2");
        other.db.close();
    });
    // The outer `AND status = 'QUEUED'` only matters under READ COMMITTED with a waiting second worker; that is the PostgreSQL tier's test (M4).
});

describe("UserStore.takePending", () => {
    it("hands a sign-in round trip out once, even to a second connection", () => {
        const s = setup();
        const users = new UserStore(s.db);
        const other = new UserStore(new Db(s.file));
        users.addPending({ state: "st-1", nonce: "n", verifier: "v", redirectUri: "https://x/cb" });
        expect(users.takePending("st-1")).toEqual({ nonce: "n", verifier: "v", redirectUri: "https://x/cb" });
        expect(other.takePending("st-1")).toBeUndefined();
        expect(users.takePending("st-1")).toBeUndefined();
        other.db.close();
    });

    it("removes an expired round trip and does not hand it out", () => {
        const s = setup();
        const users = new UserStore(s.db);
        s.db.run("INSERT INTO oidc_pending (state, nonce, verifier, redirect_uri, created_at) VALUES (?,?,?,?,?)", "old", "n", "v", "https://x/cb", Date.now() - 11 * 60_000);
        expect(users.takePending("old")).toBeUndefined();
        expect(s.db.get("SELECT COUNT(*) AS n FROM oidc_pending")?.n).toBe(0);
    });
});

describe("Repo.getOrCreateSuite", () => {
    it("uses the other writer's suite when it was created between the read and the insert", () => {
        const s = setup();
        // Plays a concurrent caller: just before our insert, someone else creates the same (project, slug).
        s.db.raw.exec(`CREATE TEMP TRIGGER suite_race BEFORE INSERT ON test_suites WHEN NEW.slug = 'race' AND NEW.id != 'theirs'
            BEGIN INSERT INTO test_suites (id, project_id, name, slug, created_at) VALUES ('theirs', NEW.project_id, NEW.name, NEW.slug, NEW.created_at); END`);
        expect(s.repo.getOrCreateSuite(s.projectId, "Race", "race")).toBe("theirs");
        expect(s.db.get("SELECT COUNT(*) AS n FROM test_suites WHERE slug = 'race'")?.n).toBe(1);
        expect(s.repo.getOrCreateSuite(s.projectId, "Race", "race")).toBe("theirs");
    });
});

describe("version numbers", () => {
    it("generated_scripts refuses a second row with the same test, framework and version", () => {
        const s = setup();
        const script = { framework: "playwright" as const, filename: "a.spec.ts", content: "x", hash: "h", storagePath: "p", executable: true };
        s.repo.addScript(s.testId, script);
        s.repo.addScript(s.testId, { ...script, framework: "cypress" as never });
        // Per framework, so another framework's version 1 is fine.
        expect(s.db.all("SELECT framework, version FROM generated_scripts ORDER BY framework").map((r) => `${r.framework}:${r.version}`)).toEqual(["cypress:1", "playwright:1"]);
        expect(() =>
            s.db.run("INSERT INTO generated_scripts (id, test_case_id, framework, filename, content, content_hash, version, created_at) VALUES ('dup', ?, 'playwright', 'a', 'x', 'h', 1, 'now')", s.testId),
        ).toThrow(/UNIQUE/);
    });

    it("Repo.addScript tries again when another writer took the same version", () => {
        const s = setup();
        let raced = 0;
        // The other writer commits a row with the version we are about to write; the user function survives the rollback, so it races once.
        s.db.raw.function("race_once", () => (raced++ === 0 ? 1 : 0));
        s.db.raw.exec(`CREATE TEMP TRIGGER script_race BEFORE INSERT ON generated_scripts WHEN NEW.id != 'theirs' AND race_once() = 1
            BEGIN INSERT INTO generated_scripts (id, test_case_id, framework, filename, content, content_hash, version, created_at) VALUES ('theirs', NEW.test_case_id, NEW.framework, 'b', 'y', 'h2', NEW.version, NEW.created_at); END`);
        const id = s.repo.addScript(s.testId, { framework: "playwright", filename: "a.spec.ts", content: "x", hash: "h", storagePath: "p", executable: true });
        expect(raced).toBeGreaterThanOrEqual(2);
        expect(s.db.all("SELECT id, version FROM generated_scripts").map((r) => `${r.id}:${r.version}`)).toEqual([`${id}:1`]);
    });

    it("SpecVersionStore.add takes the next number in the insert and tries again on a clash", () => {
        const s = setup();
        const store = new SpecVersionStore(s.db);
        const spec = { steps: [] } as unknown as TestSpec;
        expect(store.add(s.testId, spec, "one")).toBe(1);
        // Another writer inserts version 2 just before ours: ours fails UNIQUE (test_case_id, version) and is tried again as 3.
        s.db.raw.exec(`CREATE TEMP TRIGGER spec_race BEFORE INSERT ON spec_versions WHEN NEW.note = 'two'
            BEGIN INSERT INTO spec_versions (test_case_id, version, spec_json, note, created_at) VALUES (NEW.test_case_id, NEW.version, NEW.spec_json, 'theirs', NEW.created_at); END`);
        let tries = 0;
        s.db.raw.function("count_try", () => ++tries);
        s.db.raw.exec("CREATE TEMP TRIGGER spec_count BEFORE INSERT ON spec_versions WHEN NEW.note = 'two' BEGIN SELECT count_try(); END");
        // The trigger fires on every try, so each try clashes; after three the error reaches the caller instead of a duplicate.
        expect(() => store.add(s.testId, spec, "two")).toThrow(/UNIQUE/);
        expect(tries).toBe(3);
        s.db.raw.exec("DROP TRIGGER spec_race");
        // A clash that happens once is absorbed.
        let once = 0;
        s.db.raw.function("clash_once", () => (once++ === 0 ? 1 : 0));
        s.db.raw.exec(`CREATE TEMP TRIGGER spec_race_once BEFORE INSERT ON spec_versions WHEN NEW.note = 'three' AND clash_once() = 1
            BEGIN INSERT INTO spec_versions (test_case_id, version, spec_json, note, created_at) VALUES (NEW.test_case_id, NEW.version, NEW.spec_json, 'theirs', NEW.created_at); END`);
        expect(store.add(s.testId, spec, "three")).toBe(2);
        expect(s.db.all("SELECT version, note FROM spec_versions ORDER BY version").map((r) => `${r.version}:${r.note}`)).toEqual(["1:one", "2:three"]);
    });
});

describe("retryOnUniqueViolation", () => {
    it("retries only unique violations, and at most the given number of times", () => {
        const unique = Object.assign(new Error("UNIQUE constraint failed"), { errcode: 2067 });
        let n = 0;
        expect(retryOnUniqueViolation(sqliteDialect, () => (++n < 3 ? (() => { throw unique; })() : "ok"))).toBe("ok");
        n = 0;
        expect(() => retryOnUniqueViolation(sqliteDialect, () => { n++; throw new Error("other"); })).toThrow("other");
        expect(n).toBe(1);
        n = 0;
        expect(() => retryOnUniqueViolation(sqliteDialect, () => { n++; throw unique; }, 2)).toThrow("UNIQUE");
        expect(n).toBe(2);
    });
});
