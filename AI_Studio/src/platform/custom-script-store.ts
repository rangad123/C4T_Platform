/**
 * Hand-written (custom) tests: which tests are custom, their script versions, the project's shared helper modules, a small audit
 * trail, and the Git repositories tests were imported from (migration slot 22).
 *
 * A test stays one row in `test_cases`; being custom is a flag-row here. The spec of a taken-over test is archived in `custom_tests`
 * (and still sits in `test_cases.spec_json`, which `Repo.updateTest` no longer rewrites for a custom test), so restoring the generated
 * version can render it again. The CURRENT script keeps living in `generated_scripts` like any other, so downloads, backups and runs
 * find it where they always did; `custom_script_versions` is the history people see.
 */
import { createHash, randomUUID } from "node:crypto";
import { helperClosure, MAX_HELPERS, MAX_HELPER_DEPTH } from "../engine/custom/helpers.js";
import type { Db, Row } from "./db.js";
import { actorLabel } from "./auth/actor.js";

export const CUSTOM_MIGRATION = `
CREATE TABLE custom_tests (
    test_case_id TEXT PRIMARY KEY REFERENCES test_cases(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin TEXT NOT NULL,                 -- taken-over | git | written
    since TEXT NOT NULL,
    spec_json TEXT,                       -- the archived spec of a taken-over test (null = nothing to restore)
    git_json TEXT,                        -- provenance of a Git import: {host,path,ref,commit,importedAt,repoId,file}
    imports_json TEXT NOT NULL DEFAULT '[]'   -- helper names the script imports (read from its syntax tree on every save)
);
CREATE INDEX idx_custom_tests_project ON custom_tests(project_id);
CREATE TABLE custom_script_versions (
    id TEXT PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    kind TEXT NOT NULL,                   -- generated | taken-over | edited | git | restored
    note TEXT,
    by_who TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (test_case_id, version)
);
CREATE TABLE custom_helpers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    imports_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (project_id, name)
);
CREATE TABLE custom_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_case_id TEXT,                    -- no foreign key: the trail outlives a deleted test
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_custom_audit_project ON custom_audit(project_id, id);
-- Repositories tests were imported from (Builder AR's Git import uses GitRepoStore). Nothing secret is ever stored here.
CREATE TABLE git_repos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    path TEXT NOT NULL,                   -- owner/repo on that host
    ref TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    url TEXT,                             -- the address the repository was cloned from (no credentials)
    subpath TEXT                          -- the folder inside the repository that was imported
);
CREATE INDEX idx_git_repos_project ON git_repos(project_id);
`;

export type CustomOrigin = "taken-over" | "git" | "written";
export type VersionKind = "generated" | "taken-over" | "edited" | "git" | "restored";

export interface GitProvenance {
    host: string;
    path: string;
    ref: string;
    commit: string;
    importedAt: string;
    /** The git_repos row this test belongs to, and the file inside the repository. */
    repoId?: string;
    file?: string;
}

export interface CustomState {
    testId: string;
    projectId: string;
    origin: CustomOrigin;
    since: string;
    /** The archived spec (a taken-over test); undefined = the generated version cannot be restored. */
    specArchive?: unknown;
    git?: GitProvenance;
    imports: string[];
}

/** The `custom` block of a test in the API (see .scratch/briefs/CODE-API-SHAPES.md). */
export interface CustomInfo {
    since: string;
    origin: CustomOrigin;
    canRestoreGenerated: boolean;
    git?: { host: string; path: string; ref: string; commit: string; importedAt: string };
}

export const customInfo = (c: CustomState): CustomInfo => ({
    since: c.since,
    origin: c.origin,
    canRestoreGenerated: c.specArchive !== undefined,
    ...(c.git ? { git: { host: c.git.host, path: c.git.path, ref: c.git.ref, commit: c.git.commit, importedAt: c.git.importedAt } } : {}),
});

export interface VersionRow {
    version: number;
    createdAt: string;
    note: string | null;
    bytes: number;
    kind: VersionKind;
    by: string | null;
}

export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");
const now = () => new Date().toISOString();

/** The newest versions kept per test (the generated version 0 is never pruned). */
export const KEEP_VERSIONS = 100;
/** Script history of a whole project, in bytes: beyond it the oldest versions go first (never version 0, never a test's newest version). */
export const MAX_PROJECT_VERSION_BYTES = 50 * 1024 * 1024;
/** Audit rows kept per project (the newest). */
export const KEEP_AUDIT_ROWS = 1000;

export class HelperLimitError extends Error {
    constructor() {
        super(`A project can have at most ${MAX_HELPERS} helpers. Delete one you no longer use first.`);
    }
}

const toState = (r: Row): CustomState => ({
    testId: r.test_case_id,
    projectId: r.project_id,
    origin: r.origin,
    since: r.since,
    ...(r.spec_json ? { specArchive: JSON.parse(r.spec_json) } : {}),
    ...(r.git_json ? { git: JSON.parse(r.git_json) as GitProvenance } : {}),
    imports: JSON.parse(r.imports_json ?? "[]"),
});

export class CustomScriptStore {
    constructor(
        private readonly db: Db,
        /** Overridable so a test does not have to write 50 MB. */
        private readonly limits: { projectVersionBytes?: number; auditRows?: number } = {},
    ) {}

    // ── which tests are custom ──────────────────────────────────────────────
    isCustom(testId: string): boolean {
        return Boolean(this.db.get("SELECT 1 AS x FROM custom_tests WHERE test_case_id = ?", testId));
    }

    get(testId: string): CustomState | undefined {
        const r = this.db.get("SELECT * FROM custom_tests WHERE test_case_id = ?", testId);
        return r ? toState(r) : undefined;
    }

    /** Every custom test of a project, keyed by test id (one query, for lists). */
    forProject(projectId: string): Map<string, CustomState> {
        return new Map(this.db.all("SELECT * FROM custom_tests WHERE project_id = ?", projectId).map((r) => [r.test_case_id as string, toState(r)]));
    }

    /** The ones among `testIds` that are custom. */
    customAmong(testIds: readonly string[]): string[] {
        if (testIds.length === 0) return [];
        const out: string[] = [];
        for (let i = 0; i < testIds.length; i += 400) {
            const part = testIds.slice(i, i + 400);
            out.push(...this.db.all(`SELECT test_case_id FROM custom_tests WHERE test_case_id IN (${part.map(() => "?").join(",")})`, ...part).map((r) => r.test_case_id as string));
        }
        return out;
    }

    countInProject(projectId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM custom_tests WHERE project_id = ?", projectId)?.n ?? 0);
    }

    mark(testId: string, projectId: string, o: { origin: CustomOrigin; specArchive?: unknown; git?: GitProvenance; imports?: string[] }): void {
        this.db.run(
            "INSERT INTO custom_tests (test_case_id, project_id, origin, since, spec_json, git_json, imports_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT (test_case_id) DO UPDATE SET project_id = excluded.project_id, origin = excluded.origin, since = excluded.since, spec_json = excluded.spec_json, git_json = excluded.git_json, imports_json = excluded.imports_json",
            testId,
            projectId,
            o.origin,
            now(),
            o.specArchive !== undefined ? JSON.stringify(o.specArchive) : null,
            o.git ? JSON.stringify(o.git) : null,
            JSON.stringify(o.imports ?? []),
        );
    }

    unmark(testId: string): void {
        this.db.run("DELETE FROM custom_tests WHERE test_case_id = ?", testId);
    }

    setImports(testId: string, imports: readonly string[]): void {
        this.db.run("UPDATE custom_tests SET imports_json = ? WHERE test_case_id = ?", JSON.stringify([...imports]), testId);
    }

    setGit(testId: string, git: GitProvenance | null): void {
        this.db.run("UPDATE custom_tests SET git_json = ? WHERE test_case_id = ?", git ? JSON.stringify(git) : null, testId);
    }

    /** Runs `fn` in one transaction, or inside the caller's when one is already open (SQLite has no nested transactions). */
    private atomic<T>(fn: () => T): T {
        return this.db.raw.isTransaction ? fn() : this.db.tx(fn);
    }

    // ── versions ────────────────────────────────────────────────────────────
    latestVersion(testId: string): { version: number; hash: string } | undefined {
        const r = this.db.get("SELECT version, content_hash FROM custom_script_versions WHERE test_case_id = ? ORDER BY version DESC LIMIT 1", testId);
        return r ? { version: r.version as number, hash: r.content_hash as string } : undefined;
    }

    /**
     * Stores a version. Identical content to the newest version does not make a new row (unless `force`): the answer then names the
     * existing version and `created` is false. The oldest versions beyond KEEP_VERSIONS are removed; version 0 (the generated one) never is.
     */
    addVersion(testId: string, v: { content: string; kind: VersionKind; note?: string | null; by?: string | null; force?: boolean; version?: number }): { version: number; created: boolean } {
        const hash = hashOf(v.content);
        return this.atomic(() => {
            const latest = this.latestVersion(testId);
            if (!v.force && latest && latest.hash === hash) return { version: latest.version, created: false };
            const version = v.version ?? (latest ? latest.version + 1 : 1);
            this.db.run(
                "INSERT INTO custom_script_versions (id, test_case_id, version, content, content_hash, kind, note, by_who, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                randomUUID(), testId, version, v.content, hash, v.kind, v.note ?? null, v.by ?? null, now(),
            );
            const extra = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM custom_script_versions WHERE test_case_id = ? AND version > 0", testId)?.n ?? 0) - KEEP_VERSIONS;
            if (extra > 0) this.db.run("DELETE FROM custom_script_versions WHERE id IN (SELECT id FROM custom_script_versions WHERE test_case_id = ? AND version > 0 ORDER BY version ASC LIMIT ?)", testId, extra);
            this.trimProject(testId);
            return { version, created: true };
        });
    }

    /** Keeps a project's whole script history under MAX_PROJECT_VERSION_BYTES: the oldest versions go first, never version 0 and never the newest of a test. */
    private trimProject(testId: string): void {
        const cap = this.limits.projectVersionBytes ?? MAX_PROJECT_VERSION_BYTES;
        const project = this.db.get<{ project_id: string }>("SELECT project_id FROM test_cases WHERE id = ?", testId)?.project_id;
        if (!project) return;
        const total = () => Number(this.db.get<{ n: number | null }>(`SELECT SUM(${this.db.dialect.byteLength("v.content")}) AS n FROM custom_script_versions v JOIN test_cases t ON t.id = v.test_case_id WHERE t.project_id = ?`, project)?.n ?? 0);
        let size = total();
        if (size <= cap) return;
        const old = this.db.all<{ id: string; n: number }>(
            `SELECT v.id AS id, ${this.db.dialect.byteLength("v.content")} AS n FROM custom_script_versions v JOIN test_cases t ON t.id = v.test_case_id
             WHERE t.project_id = ? AND v.version > 0 AND v.version < (SELECT MAX(m.version) FROM custom_script_versions m WHERE m.test_case_id = v.test_case_id)
             ORDER BY v.created_at ASC, v.version ASC`,
            project,
        );
        for (const v of old) {
            if (size <= cap) break;
            this.db.run("DELETE FROM custom_script_versions WHERE id = ?", v.id);
            size -= Number(v.n);
        }
    }

    listVersions(testId: string): VersionRow[] {
        return this.db
            .all(`SELECT version, created_at, note, ${this.db.dialect.byteLength("content")} AS bytes, kind, by_who FROM custom_script_versions WHERE test_case_id = ? ORDER BY version DESC`, testId)
            .map((r) => ({ version: r.version, createdAt: r.created_at, note: r.note ?? null, bytes: Number(r.bytes), kind: r.kind, by: r.by_who ?? null }));
    }

    getVersion(testId: string, version: number): { version: number; content: string; kind: VersionKind } | undefined {
        const r = this.db.get("SELECT version, content, kind FROM custom_script_versions WHERE test_case_id = ? AND version = ?", testId, version);
        return r ? { version: r.version, content: r.content, kind: r.kind } : undefined;
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    private helperCode(projectId: string): Map<string, string> {
        return new Map(this.db.all("SELECT name, content FROM custom_helpers WHERE project_id = ?", projectId).map((r) => [r.name as string, r.content as string]));
    }

    getHelper(projectId: string, name: string): { name: string; content: string; updatedAt: string } | undefined {
        const r = this.db.get("SELECT name, content, updated_at FROM custom_helpers WHERE project_id = ? AND name = ?", projectId, name);
        return r ? { name: r.name, content: r.content, updatedAt: r.updated_at } : undefined;
    }

    countHelpers(projectId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM custom_helpers WHERE project_id = ?", projectId)?.n ?? 0);
    }

    /** Creates or replaces a helper. Returns whether the content actually changed. */
    putHelper(projectId: string, name: string, content: string, imports: readonly string[]): { created: boolean; changed: boolean } {
        const cur = this.getHelper(projectId, name);
        if (!cur && this.countHelpers(projectId) >= MAX_HELPERS) throw new HelperLimitError();
        const t = now();
        if (!cur) {
            this.db.run("INSERT INTO custom_helpers (id, project_id, name, content, imports_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", randomUUID(), projectId, name, content, JSON.stringify([...imports]), t, t);
            return { created: true, changed: true };
        }
        if (cur.content === content) return { created: false, changed: false };
        this.db.run("UPDATE custom_helpers SET content = ?, imports_json = ?, updated_at = ? WHERE project_id = ? AND name = ?", content, JSON.stringify([...imports]), t, projectId, name);
        return { created: false, changed: true };
    }

    deleteHelper(projectId: string, name: string): boolean {
        return Number(this.db.run("DELETE FROM custom_helpers WHERE project_id = ? AND name = ?", projectId, name).changes) > 0;
    }

    /** Custom test ids whose scripts import `name`, directly or through other helpers (up to MAX_HELPER_DEPTH levels). */
    usersOfHelper(projectId: string, name: string): string[] {
        const code = this.helperCode(projectId);
        const imports = new Map(this.db.all("SELECT name, imports_json FROM custom_helpers WHERE project_id = ?", projectId).map((r) => [r.name as string, JSON.parse(r.imports_json) as string[]]));
        const users: string[] = [];
        for (const t of this.db.all("SELECT test_case_id, imports_json FROM custom_tests WHERE project_id = ?", projectId)) {
            const seen = new Set<string>();
            const walk = (names: readonly string[], depth: number): boolean => {
                for (const n of names) {
                    if (n === name) return true;
                    if (depth >= MAX_HELPER_DEPTH || seen.has(n) || !code.has(n)) continue;
                    seen.add(n);
                    if (walk(imports.get(n) ?? [], depth + 1)) return true;
                }
                return false;
            };
            if (walk(JSON.parse(t.imports_json) as string[], 1)) users.push(t.test_case_id as string);
        }
        return users;
    }

    /** Helpers of a project with how many tests use each. */
    listHelpers(projectId: string): Array<{ name: string; bytes: number; updatedAt: string; usedBy: number }> {
        return this.db
            .all(`SELECT name, ${this.db.dialect.byteLength("content")} AS bytes, updated_at FROM custom_helpers WHERE project_id = ? ORDER BY name`, projectId)
            .map((r) => ({ name: r.name, bytes: Number(r.bytes), updatedAt: r.updated_at, usedBy: this.usersOfHelper(projectId, r.name).length }));
    }

    /** The helpers (with the helpers they use) that the given scripts need, for a run. */
    helpersFor(projectId: string, scripts: readonly string[]): ReturnType<typeof helperClosure> {
        const code = this.helperCode(projectId);
        return helperClosure(scripts, (n) => code.get(n));
    }

    allHelpers(projectId: string): Array<{ name: string; content: string }> {
        return this.db.all("SELECT name, content FROM custom_helpers WHERE project_id = ? ORDER BY name", projectId).map((r) => ({ name: r.name, content: r.content }));
    }

    // ── audit ───────────────────────────────────────────────────────────────
    audit(projectId: string, testId: string | null, action: string, detail?: string): void {
        // `actor`: who did it (a person, the access key, a runner...), from the request (auth/actor.ts).
        this.db.run("INSERT INTO custom_audit (project_id, test_case_id, action, detail, created_at, actor) VALUES (?,?,?,?,?,?)", projectId, testId, action, detail?.slice(0, 500) ?? null, now(), actorLabel());
        // Only the newest rows of a project are kept (the trail is for recent questions, and an unbounded table is a way to fill the disk).
        const keep = this.limits.auditRows ?? KEEP_AUDIT_ROWS;
        this.db.run("DELETE FROM custom_audit WHERE project_id = ? AND id <= COALESCE((SELECT id FROM custom_audit WHERE project_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?), 0)", projectId, projectId, keep);
    }

    auditTrail(projectId: string, limit = 100): Array<{ testId: string | null; action: string; detail: string | null; at: string }> {
        return this.db.all("SELECT test_case_id, action, detail, created_at FROM custom_audit WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, limit).map((r) => ({ testId: r.test_case_id ?? null, action: r.action, detail: r.detail ?? null, at: r.created_at }));
    }
}

// ── Git repositories (used by Builder AR's Git import) ─────────────────────────

export interface GitRepo {
    id: string;
    projectId: string;
    host: string;
    /** owner/repo on that host. */
    path: string;
    ref: string;
    commit: string;
    importedAt: string;
    /** The address it was cloned from, without credentials. */
    url?: string;
    /** The folder inside the repository that was imported ("" = the root). */
    subpath?: string;
}

const toRepo = (r: Row): GitRepo => ({
    id: r.id,
    projectId: r.project_id,
    host: r.host,
    path: r.path,
    ref: r.ref,
    commit: r.commit_sha,
    importedAt: r.imported_at,
    ...(r.url ? { url: r.url } : {}),
    ...(r.subpath ? { subpath: r.subpath } : {}),
});

/** The repositories a project's tests were imported from. Never holds a token. */
export class GitRepoStore {
    constructor(private readonly db: Db) {}

    create(projectId: string, r: { host: string; path: string; ref: string; commit: string; url?: string; subpath?: string; importedAt?: string }): GitRepo {
        const id = randomUUID();
        this.db.run(
            "INSERT INTO git_repos (id, project_id, host, path, ref, commit_sha, imported_at, url, subpath) VALUES (?,?,?,?,?,?,?,?,?)",
            id, projectId, r.host, r.path, r.ref, r.commit, r.importedAt ?? now(), r.url ?? null, r.subpath ?? null,
        );
        return this.get(projectId, id)!;
    }

    list(projectId: string): GitRepo[] {
        return this.db.all("SELECT * FROM git_repos WHERE project_id = ? ORDER BY imported_at DESC, id", projectId).map(toRepo);
    }

    /** A repository of this project, or undefined (another project's id is never found). */
    get(projectId: string, id: string): GitRepo | undefined {
        const r = this.db.get("SELECT * FROM git_repos WHERE project_id = ? AND id = ?", projectId, id);
        return r ? toRepo(r) : undefined;
    }

    update(projectId: string, id: string, patch: Partial<Pick<GitRepo, "ref" | "commit" | "url" | "subpath">> & { importedAt?: string }): GitRepo | undefined {
        const cur = this.get(projectId, id);
        if (!cur) return undefined;
        this.db.run(
            "UPDATE git_repos SET ref = ?, commit_sha = ?, imported_at = ?, url = ?, subpath = ? WHERE project_id = ? AND id = ?",
            patch.ref ?? cur.ref, patch.commit ?? cur.commit, patch.importedAt ?? now(), patch.url ?? cur.url ?? null, patch.subpath ?? cur.subpath ?? null, projectId, id,
        );
        return this.get(projectId, id);
    }

    /** Drops the link only: the tests stay (as custom tests), their provenance keeps the text of where they came from. */
    delete(projectId: string, id: string): boolean {
        const gone = Number(this.db.run("DELETE FROM git_repos WHERE project_id = ? AND id = ?", projectId, id).changes) > 0;
        if (gone) {
            for (const r of this.db.all("SELECT test_case_id, git_json FROM custom_tests WHERE project_id = ? AND git_json IS NOT NULL", projectId)) {
                const g = JSON.parse(r.git_json) as GitProvenance;
                if (g.repoId === id) {
                    delete g.repoId;
                    this.db.run("UPDATE custom_tests SET git_json = ? WHERE test_case_id = ?", JSON.stringify(g), r.test_case_id);
                }
            }
        }
        return gone;
    }

    /** How many tests came from this repository. */
    testCount(projectId: string, id: string): number {
        return this.db.all("SELECT git_json FROM custom_tests WHERE project_id = ? AND git_json IS NOT NULL", projectId).filter((r) => (JSON.parse(r.git_json) as GitProvenance).repoId === id).length;
    }

    /** The custom tests that came from this repository, with the file each one is. */
    testsOf(projectId: string, id: string): Array<{ testId: string; file: string | undefined }> {
        return this.db
            .all("SELECT test_case_id, git_json FROM custom_tests WHERE project_id = ? AND git_json IS NOT NULL", projectId)
            .map((r) => ({ testId: r.test_case_id as string, git: JSON.parse(r.git_json) as GitProvenance }))
            .filter((x) => x.git.repoId === id)
            .map((x) => ({ testId: x.testId, file: x.git.file }));
    }
}
