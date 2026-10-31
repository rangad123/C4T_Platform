/**
 * Migration slot 31: a project's test files (small files that upload steps put into file fields) and its test data reset hooks (one HTTP
 * request the platform sends before a run so the application starts from known data). See docs/features/frames-uploads-popups.md.
 *
 * Test files live in the artifact store under <projectId>/_test_files/<name>; only their names, sizes and hashes are in the database.
 * A reset hook's header values are secrets: stored encrypted (SecretBox), never returned, logged or put in an event; the API shows their names only.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { isTestFileName, testFileNameFrom, testFileSlot, uploadFilesOf } from "../engine/web/pages.js";

export { testFileNameFrom };
import { blockView } from "./block-store.js";
import type { Db } from "./db.js";
import type { Repo } from "./repo.js";
import { HttpError } from "./http-error.js";
import { assertAllowedTarget } from "./net-guard.js";
import type { SecretBox } from "./secrets.js";
import type { ArtifactStore } from "./storage.js";
import { localPathOf } from "./object-store.js";

/** Migration slot 31. `IF NOT EXISTS` on purpose: ten builders added slots 26-31 at the same time, so the order of the lines may still change. */
export const WEB_PAGES_MIGRATION = `
CREATE TABLE IF NOT EXISTS test_files (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,              -- the name steps use: letters, numbers, dots, dashes, underscores
    path TEXT NOT NULL,              -- relative to the artifact store
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS test_data_reset (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment TEXT NOT NULL DEFAULT '',   -- '' = runs against the project's own address; else a named environment
    enabled INTEGER NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,                      -- a path of the application, or a full address (own origin or an allowed one)
    header_names TEXT NOT NULL DEFAULT '[]',
    headers_enc TEXT,                       -- SecretBox: { name: value }
    expected_status INTEGER NOT NULL,
    last_ok INTEGER,
    last_message TEXT,
    last_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, environment)
);
`;

// ── test files ──────────────────────────────────────────────────────────

export const TEST_FILE_LIMITS = { fileBytes: 5 * 1024 * 1024, files: 50, totalBytes: 50 * 1024 * 1024 } as const;

/** The kinds of file a test may upload, by extension (anything else is refused: the library is for test inputs, not for storing programs). */
export const TEST_FILE_TYPES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
};

export const extensionOf = (name: string): string => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? "").toLowerCase();

export interface TestFile {
    name: string;
    size: number;
    contentType: string;
    sha256: string;
    createdAt: string;
}

export class TestFileStore {
    constructor(
        private readonly db: Db,
        private readonly store: ArtifactStore,
    ) {}

    list(projectId: string): TestFile[] {
        return this.db.all("SELECT name, size, content_type, sha256, created_at FROM test_files WHERE project_id = ? ORDER BY name", projectId).map((r) => ({ name: r.name, size: Number(r.size), contentType: r.content_type, sha256: r.sha256, createdAt: r.created_at }));
    }

    /** The file on this machine, or undefined when the project has no file of that name. */
    pathOf(projectId: string, name: string): string | undefined {
        if (!isTestFileName(name)) return undefined;
        const r = this.db.get<{ path: string }>("SELECT path FROM test_files WHERE project_id = ? AND name = ?", projectId, name);
        // A path on this machine for the run folder: the stored file on local disk (object-store.ts, localPathOf; async with M1).
        return r ? localPathOf(this.store, r.path) : undefined;
    }

    /** Stores a file (replacing one of the same name). Refuses a name, type, size or count over the caps with a plain message. */
    async put(projectId: string, rawName: string, data: Buffer): Promise<TestFile> {
        const name = testFileNameFrom(rawName);
        if (!name) throw new HttpError(400, "Give the file a name with letters or numbers, such as photo.png.");
        const contentType = TEST_FILE_TYPES[extensionOf(name)];
        if (!contentType) throw new HttpError(400, `Files of this kind cannot be test files. Use one of: ${Object.keys(TEST_FILE_TYPES).join(", ")}.`);
        if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, "The file is empty.");
        if (data.length > TEST_FILE_LIMITS.fileBytes) throw new HttpError(413, `A test file can be at most ${TEST_FILE_LIMITS.fileBytes / 1024 / 1024} MB.`);
        const existing = this.list(projectId);
        const others = existing.filter((f) => f.name !== name);
        if (others.length >= TEST_FILE_LIMITS.files) throw new HttpError(409, `A project can have at most ${TEST_FILE_LIMITS.files} test files. Delete one first.`);
        if (others.reduce((n, f) => n + f.size, 0) + data.length > TEST_FILE_LIMITS.totalBytes) throw new HttpError(409, `A project's test files can take at most ${TEST_FILE_LIMITS.totalBytes / 1024 / 1024} MB together. Delete one first.`);
        const rel = path.posix.join(projectId, "_test_files", name);
        await this.store.put(rel, data, { contentType });
        const file: TestFile = { name, size: data.length, contentType, sha256: createHash("sha256").update(data).digest("hex"), createdAt: new Date().toISOString() };
        this.db.run(
            "INSERT INTO test_files (project_id, name, path, size, content_type, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET path = excluded.path, size = excluded.size, content_type = excluded.content_type, sha256 = excluded.sha256, created_at = excluded.created_at",
            projectId,
            name,
            rel,
            file.size,
            contentType,
            file.sha256,
            file.createdAt,
        );
        return file;
    }

    async remove(projectId: string, name: string): Promise<boolean> {
        const r = this.db.get<{ path: string }>("SELECT path FROM test_files WHERE project_id = ? AND name = ?", projectId, name);
        if (!r) return false;
        this.db.run("DELETE FROM test_files WHERE project_id = ? AND name = ?", projectId, name);
        await this.store.delete(r.path);
        return true;
    }
}

/**
 * The files a test's upload steps need, as "baselines" named upload--<name> (how they reach the run folder, here or on a runner). A name
 * the library does not have is left out: the script then fails on that step with a plain "not available" message instead of a guess.
 */
export function testFilesFor(repo: Pick<Repo, "getTest" | "db">, store: ArtifactStore, projectId: string, testDbId: string): Array<{ name: string; path: string }> {
    const t = repo.getTest(testDbId);
    if (!t || !JSON.stringify(t.spec).includes('"upload"')) return [];
    let names: string[];
    try {
        names = uploadFilesOf(blockView(repo.db, projectId)(t.spec));
    } catch {
        names = uploadFilesOf(t.spec);
    }
    const files = new TestFileStore(repo.db, store);
    return names.flatMap((n) => {
        const p = files.pathOf(projectId, n);
        return p ? [{ name: testFileSlot(n), path: p }] : [];
    });
}

// ── reset hooks ─────────────────────────────────────────────────────────

export const RESET_METHODS = ["POST", "PUT", "DELETE", "PATCH", "GET"] as const;
export type ResetMethod = (typeof RESET_METHODS)[number];
export const RESET_LIMITS = { headers: 10, headerValue: 2000, url: 2000, timeoutMs: 30_000 } as const;

export interface ResetHook {
    environment: string;
    enabled: boolean;
    method: ResetMethod;
    url: string;
    headerNames: string[];
    expectedStatus: number;
    last: { ok: boolean; message: string; at: string } | null;
    updatedAt: string;
}

/** What the platform needs to send it (never leaves the platform). */
export interface ResetHookSecret extends ResetHook {
    headers: Record<string, string>;
}

export class ResetHookStore {
    constructor(
        private readonly db: Db,
        private readonly box: SecretBox,
    ) {}

    private row(r: Record<string, any>): ResetHook {
        return {
            environment: r.environment,
            enabled: Boolean(r.enabled),
            method: r.method,
            url: r.url,
            headerNames: JSON.parse(r.header_names) as string[],
            expectedStatus: Number(r.expected_status),
            last: r.last_at ? { ok: Boolean(r.last_ok), message: r.last_message ?? "", at: r.last_at } : null,
            updatedAt: r.updated_at,
        };
    }

    list(projectId: string): ResetHook[] {
        return this.db.all("SELECT * FROM test_data_reset WHERE project_id = ? ORDER BY environment", projectId).map((r) => this.row(r));
    }

    get(projectId: string, environment = ""): ResetHook | undefined {
        const r = this.db.get("SELECT * FROM test_data_reset WHERE project_id = ? AND environment = ?", projectId, environment);
        return r ? this.row(r) : undefined;
    }

    /** With the decrypted header values: only for sending the request. */
    secret(projectId: string, environment = ""): ResetHookSecret | undefined {
        const r = this.db.get("SELECT * FROM test_data_reset WHERE project_id = ? AND environment = ?", projectId, environment);
        if (!r) return undefined;
        let headers: Record<string, string> = {};
        if (r.headers_enc) {
            try {
                headers = this.box.decrypt<Record<string, string>>(r.headers_enc);
            } catch {
                throw new Error("The reset request's saved headers cannot be read (the encryption key may have changed). Enter them again in Settings.");
            }
        }
        return { ...this.row(r), headers };
    }

    /**
     * Saves a hook. `headers` lists every header the hook keeps: a value given replaces the saved one, a missing value keeps it (write-only
     * values, so the page never needs them back). A header left out of the list is removed.
     */
    save(projectId: string, environment: string, v: { enabled: boolean; method: ResetMethod; url: string; expectedStatus: number; headers: Array<{ name: string; value?: string }> }): ResetHook {
        const before = this.secret(projectId, environment)?.headers ?? {};
        const headers: Record<string, string> = {};
        for (const h of v.headers) {
            const value = h.value ?? before[h.name];
            if (value === undefined) throw new HttpError(400, `Enter a value for the header ${h.name}.`);
            headers[h.name] = value;
        }
        const names = Object.keys(headers);
        this.db.run(
            `INSERT INTO test_data_reset (project_id, environment, enabled, method, url, header_names, headers_enc, expected_status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, environment) DO UPDATE SET enabled = excluded.enabled, method = excluded.method, url = excluded.url, header_names = excluded.header_names,
             headers_enc = excluded.headers_enc, expected_status = excluded.expected_status, updated_at = excluded.updated_at`,
            projectId,
            environment,
            v.enabled ? 1 : 0,
            v.method,
            v.url,
            JSON.stringify(names),
            names.length ? this.box.encrypt(headers) : null,
            v.expectedStatus,
            new Date().toISOString(),
        );
        return this.get(projectId, environment)!;
    }

    remove(projectId: string, environment: string): boolean {
        return Number(this.db.run("DELETE FROM test_data_reset WHERE project_id = ? AND environment = ?", projectId, environment).changes) > 0;
    }

    recordOutcome(projectId: string, environment: string, ok: boolean, message: string): void {
        this.db.run("UPDATE test_data_reset SET last_ok = ?, last_message = ?, last_at = ? WHERE project_id = ? AND environment = ?", ok ? 1 : 0, message.slice(0, 300), new Date().toISOString(), projectId, environment);
    }
}

/** Origins besides the application's own that a reset request may go to (an admin setting: RESET_ALLOWED_ORIGINS, a comma list). */
export function allowedResetOrigins(): string[] {
    return (process.env.RESET_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .flatMap((s) => {
            try {
                return [new URL(s).origin];
            } catch {
                return [];
            }
        });
}

/**
 * Where a hook's request goes, from its address and the address the run tests. Refused with a plain message when it leaves the application's
 * own site for a place nobody allowed: the request carries saved header values, which (like sign-in details) only go to the application.
 */
export function resetTarget(url: string, appBase: string): URL {
    let target: URL;
    try {
        target = new URL(url, appBase);
    } catch {
        throw new HttpError(400, "The reset address is not a valid address or path.");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new HttpError(400, "The reset address must start with http:// or https://, or be a path such as /test/reset.");
    if (target.username || target.password) throw new HttpError(400, "Put sign-in details for the reset request in a header, not in the address.");
    const own = new URL(appBase).origin;
    if (target.origin !== own && !allowedResetOrigins().includes(target.origin)) {
        throw new HttpError(400, `The reset request may only go to the application's own site (${own}). An administrator can allow another address with RESET_ALLOWED_ORIGINS.`);
    }
    return target;
}

/** A plain description of the request, for the run sentence and events ("POST /test/reset"). Never includes header values. */
export function resetSummary(h: Pick<ResetHook, "method" | "url">): string {
    return `${h.method} ${h.url}`;
}

export interface ResetOutcome {
    ok: boolean;
    status?: number;
    ms: number;
    message: string;
}

/** Sends a hook's request once: no redirects followed (they could carry the headers elsewhere), 30 s at most, only the status is read. */
export async function sendResetRequest(hook: ResetHookSecret, appBase: string, signal?: AbortSignal): Promise<ResetOutcome> {
    const started = Date.now();
    const target = resetTarget(hook.url, appBase);
    await assertAllowedTarget(target.toString());
    const timeout = AbortSignal.timeout(RESET_LIMITS.timeoutMs);
    try {
        const res = await fetch(target, { method: hook.method, headers: hook.headers, redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        // The body is not read into any message: a test endpoint may echo what it was sent.
        await res.body?.cancel().catch(() => undefined);
        const ms = Date.now() - started;
        if (res.status === hook.expectedStatus) return { ok: true, status: res.status, ms, message: `${resetSummary(hook)} answered ${res.status} in ${ms} ms.` };
        const redirect = res.status >= 300 && res.status < 400 ? " (a redirect is not followed)" : "";
        return { ok: false, status: res.status, ms, message: `${resetSummary(hook)} answered ${res.status}${redirect}; ${hook.expectedStatus} was expected.` };
    } catch (e) {
        const ms = Date.now() - started;
        if (signal?.aborted) throw e;
        const why = timeout.aborted ? `no answer within ${RESET_LIMITS.timeoutMs / 1000} seconds` : `it could not be sent (${e instanceof Error ? e.message.slice(0, 120) : "network error"})`;
        return { ok: false, ms, message: `${resetSummary(hook)} failed: ${why}.` };
    }
}
