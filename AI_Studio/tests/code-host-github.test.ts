/**
 * The GitHub code-host connection (Phase 6, G1): connect a repository to a project with a fine-grained token, read a pull request, its
 * files (paginated, capped at GitHub's 3,000) and commits, and a branch. Everything runs against local fake GitHub servers
 * (tests/fixtures/fake-github.ts) over real HTTP; no request goes to github.com, and the tokens here are made up.
 * Covers: the token and webhook secret never appear in an answer, a log line or the database in plain text; a host other than GitHub
 * or the configured GitHub Enterprise API is refused before anything is sent; another project sees nothing; the routes need the
 * connection-managing permission.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { permissionRuleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { allowedApiBases, GITHUB_API, GithubCodeHost, MAX_PR_FILES } from "../src/platform/code-host/github.js";
import { CodeHostStore } from "../src/platform/code-host/store.js";
import { TrackerError } from "../src/platform/issues/http.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";
import { startFakeGithub } from "./fixtures/fake-github.js";

const KEY = "code-host-test-key-5f1c2a";
const TOKEN = "github_pat_11FAKE0TOKEN0FOR0TESTS0ONLY0abcdef0123456789";
const WEBHOOK_SECRET = "whsec-FAKE-code-host-webhook-secret-42";
const OTHER_TOKEN = "github_pat_11OTHER0FAKE0TOKEN0zzzzzzzzzzzzzzzzzz";

type Fake = Awaited<ReturnType<typeof startFakeGithub>>;
let gh: Fake;
let other: Fake;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let A: string;
let B: string;
const logged: string[] = [];
const restore: Array<() => void> = [];
const envBefore = process.env.CODE_HOST_GITHUB_API_URL;

const patch = (i: number) => `@@ -1,2 +1,3 @@ function f${i}() {\n context\n+added ${i}\n context`;
const manyFiles = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `src/f${i}.ts`, patch: patch(i) }));

beforeAll(async () => {
    gh = await startFakeGithub({
        token: TOKEN,
        prs: {
            7: {
                title: "Fix the discount",
                author: "dev1",
                headRef: "fix/discount",
                headSha: "1111111111111111111111111111111111111111",
                files: [
                    { filename: "server.mjs", patch: "@@ -139,1 +139,1 @@ function priced(cart) {\n-old\n+new", additions: 1, deletions: 1 },
                    { filename: "logo.png", status: "added" },
                    { filename: "src/new-name.ts", status: "renamed", previous_filename: "src/old-name.ts", patch: "@@ -1 +1 @@\n-a\n+b" },
                ],
                commits: [{ sha: "a1", message: "Fix the discount base", login: "dev1" }],
            },
            8: { files: manyFiles(230), commits: Array.from({ length: 120 }, (_, i) => ({ sha: `c${i}` })) },
            9: { files: manyFiles(3205), commits: Array.from({ length: 260 }, (_, i) => ({ sha: `d${i}` })) },
            10: { headRepo: "someone/shop-fork" },
        },
        branches: { "release/1.2": { sha: "2222222222222222222222222222222222222222", protected: true } },
    });
    other = await startFakeGithub({ token: TOKEN });
    // The fake stands in for a GitHub Enterprise API this server was set up with; `other` is any other host.
    process.env.CODE_HOST_GITHUB_API_URL = gh.url;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-codehost-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", API_KEY: KEY }));
    app = await buildServer(platform);
    await app.ready();
    // Everything the server writes to stdout/stderr while this file runs, to prove no secret is logged (checked to capture at all, below).
    // The server's logger writes to the file descriptors directly, so the fs calls are wrapped as well as the streams.
    const capture = <T extends object, K extends keyof T>(obj: T, name: K, fdOf: (args: unknown[]) => unknown, chunkOf: (args: unknown[]) => unknown) => {
        const orig = obj[name] as unknown as (...a: unknown[]) => unknown;
        (obj as Record<K, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
            const fd = fdOf(args);
            if (fd === 1 || fd === 2) logged.push(String(chunkOf(args)));
            return orig.apply(this, args);
        };
        restore.push(() => ((obj as Record<K, unknown>)[name] = orig));
    };
    capture(fs, "writeSync", (a) => a[0], (a) => a[1]);
    capture(fs, "write", (a) => a[0], (a) => a[1]);
    capture(process.stdout, "write", () => 1, (a) => a[0]);
    capture(process.stderr, "write", () => 2, (a) => a[0]);
    A = platform.repo.createProject({ name: "Shop" }).id as string;
    B = platform.repo.createProject({ name: "Other" }).id as string;
}, 60_000);

afterAll(async () => {
    for (const r of restore) r();
    if (envBefore === undefined) delete process.env.CODE_HOST_GITHUB_API_URL;
    else process.env.CODE_HOST_GITHUB_API_URL = envBefore;
    await app?.close();
    platform?.db.close();
    await gh?.close();
    await other?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const answers: string[] = [];
async function call(method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown, auth: Record<string, string> = { "x-api-key": KEY }) {
    const res = await app.inject({ method, url, payload: payload as never, headers: auth });
    answers.push(res.body);
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
}

describe("connecting a repository", () => {
    it("checks the token against the repository, then stores it encrypted and never shows it", async () => {
        const before = gh.requests.length;
        const r = await call("PUT", `/api/projects/${A}/code-host`, { owner: "acme", repo: "shop", token: TOKEN, webhookSecret: WEBHOOK_SECRET, apiUrl: gh.url });
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ connected: true, connection: { host: "github", owner: "acme", repo: "shop", apiUrl: gh.url, webhookSecretSet: true } });
        // the check was one real call to the repository, with the token, and to this host only
        expect(gh.requests.slice(before)).toEqual([{ method: "GET", url: "/repos/acme/shop", authorization: `Bearer ${TOKEN}` }]);
        expect(other.requests).toEqual([]);
        const row = platform.db.get<{ secret_enc: string }>("SELECT * FROM code_repos WHERE project_id = ?", A)!;
        expect(JSON.stringify(row)).not.toContain(TOKEN);
        expect(JSON.stringify(row)).not.toContain(WEBHOOK_SECRET);
        expect(new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY).decrypt(row.secret_enc)).toEqual({ token: TOKEN, webhookSecret: WEBHOOK_SECRET });
    });

    it("shows the connection, and tests it with a real call", async () => {
        expect((await call("GET", `/api/projects/${A}/code-host`)).body).toMatchObject({ connected: true, connection: { owner: "acme", repo: "shop", webhookSecretSet: true } });
        expect((await call("POST", `/api/projects/${A}/code-host/test`)).body).toEqual({ ok: true, message: "Connected to acme/shop." });
    });

    it("is not an issue tracker: the issue integrations list does not show it", async () => {
        const list = (await call("GET", `/api/projects/${A}/integrations`)).body as Array<{ kind: string }>;
        expect(list.map((i) => i.kind)).not.toContain("code");
    });

    it("keeps the stored token when only the repository changes on the same host, and asks for it again for a new host", async () => {
        expect((await call("PUT", `/api/projects/${A}/code-host`, { owner: "acme", repo: "shop", apiUrl: gh.url })).status).toBe(200);
        const r = await call("PUT", `/api/projects/${A}/code-host`, { owner: "acme", repo: "shop", verify: false });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/Enter the token/);
    });

    it("refuses a token GitHub does not accept, with GitHub's reason in our words", async () => {
        const r = await call("PUT", `/api/projects/${B}/code-host`, { owner: "acme", repo: "shop", token: OTHER_TOKEN, apiUrl: gh.url });
        expect(r.status).toBe(502);
        expect(r.body).toMatchObject({ error: "GitHub did not accept the token. Check that it is correct and has not expired.", details: { code: "unauthorized", upstreamStatus: 401 } });
        expect((await call("GET", `/api/projects/${B}/code-host`)).body).toEqual({ connected: false });
    });

    it("refuses any host other than GitHub or the configured GitHub Enterprise API, before sending anything", async () => {
        for (const apiUrl of [other.url, `${gh.url}/elsewhere`, "https://api.github.com.evil.example", "https://evil.example/api/v3", "ftp://api.github.com"]) {
            const r = await call("PUT", `/api/projects/${B}/code-host`, { owner: "acme", repo: "shop", token: TOKEN, apiUrl });
            expect(r.status, apiUrl).toBe(400);
            expect(r.body.error, apiUrl).toMatch(/only GitHub|api\.github\.com/i);
        }
        expect(other.requests).toEqual([]);
        expect(() => new GithubCodeHost({ owner: "acme", repo: "shop", apiUrl: other.url }, TOKEN)).toThrow(TrackerError);
        // GitHub itself is always allowed; nothing is sent to it here (verify off)
        expect(allowedApiBases()).toEqual([GITHUB_API, gh.url]);
        const r = await call("PUT", `/api/projects/${B}/code-host`, { owner: "acme", repo: "shop", token: TOKEN, verify: false });
        expect(r.body.connection.apiUrl).toBe(GITHUB_API);
        expect((await call("DELETE", `/api/projects/${B}/code-host`)).status).toBe(204);
    });

    it("refuses a stored connection whose host is no longer allowed, without sending its token", async () => {
        process.env.CODE_HOST_GITHUB_API_URL = other.url;
        try {
            const before = gh.requests.length;
            const r = await call("POST", `/api/projects/${A}/code-host/test`);
            expect(r.body).toMatchObject({ ok: false, code: "blocked" });
            expect(gh.requests.length).toBe(before);
            expect(other.requests).toEqual([]);
        } finally {
            process.env.CODE_HOST_GITHUB_API_URL = gh.url;
        }
    });
});

describe("another project, and who may change it", () => {
    it("another project sees no connection and cannot use it", async () => {
        expect((await call("GET", `/api/projects/${B}/code-host`)).body).toEqual({ connected: false });
        expect((await call("POST", `/api/projects/${B}/code-host/test`)).status).toBe(404);
        expect((await call("DELETE", `/api/projects/${B}/code-host`)).status).toBe(404);
        expect((await call("GET", "/api/projects/no-such-project/code-host")).status).toBe(404);
        // still there for its own project
        expect((await call("GET", `/api/projects/${A}/code-host`)).body.connected).toBe(true);
    });

    it("needs the permission that manages connections to other systems; a viewer may only look", async () => {
        for (const [m, u] of [["PUT", "/api/projects/:id/code-host"], ["DELETE", "/api/projects/:id/code-host"], ["POST", "/api/projects/:id/code-host/test"]] as const) expect(permissionRuleFor(m, u)).toBe("ai_studio.ai_keys.manage");
        expect(permissionRuleFor("GET", "/api/projects/:id/code-host")).toBe("read");
        const users = accessControlOf(app).users;
        const viewer = users.create({ email: "viewer@people.example", name: "Viewer", role: "viewer" });
        const auth = { authorization: `Bearer ${users.createToken(viewer.id, { name: "t", role: "viewer" }).token}` };
        expect((await call("GET", `/api/projects/${A}/code-host`, undefined, auth)).status).toBe(200);
        expect((await call("PUT", `/api/projects/${A}/code-host`, { owner: "acme", repo: "x", token: TOKEN }, auth)).status).toBe(403);
        expect((await call("POST", `/api/projects/${A}/code-host/test`, undefined, auth)).status).toBe(403);
        expect((await call("DELETE", `/api/projects/${A}/code-host`, undefined, auth)).status).toBe(403);
    });
});

describe("reading a pull request", () => {
    const client = () => new CodeHostStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).client(A)!;

    it("reads the pull request, without the parts nothing here needs", async () => {
        const pr = await client().pr(7);
        expect(pr).toEqual({
            number: 7,
            title: "Fix the discount",
            state: "open",
            draft: false,
            merged: false,
            author: "dev1",
            url: "https://github.example/acme/shop/pull/7",
            head: { ref: "fix/discount", sha: "1111111111111111111111111111111111111111", repo: "acme/shop" },
            base: { ref: "main", sha: "e5bd3914e2e596debea16f433f57875b5b90bcd6", repo: "acme/shop" },
            fromFork: false,
            changedFiles: 3,
            commits: 1,
        });
        expect((await client().pr(10)).fromFork).toBe(true);
        expect(JSON.stringify(pr)).not.toContain("PR-BODY-SENTINEL");
    });

    it("reads the changed files with their patches; a file without a patch (binary) has none", async () => {
        const { files, limit } = await client().files(7);
        expect(limit).toBeUndefined();
        expect(files).toEqual([
            { path: "server.mjs", status: "modified", additions: 1, deletions: 1, patch: "@@ -139,1 +139,1 @@ function priced(cart) {\n-old\n+new" },
            { path: "logo.png", status: "added", additions: 1, deletions: 0 },
            { path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" },
        ]);
    });

    it("follows the pages of a long list", async () => {
        const before = gh.requests.length;
        const { files } = await client().files(8);
        expect(files).toHaveLength(230);
        expect(files.at(-1)!.path).toBe("src/f229.ts");
        expect(gh.requests.slice(before).map((r) => r.url)).toEqual([1, 2, 3].map((p) => `/repos/acme/shop/pulls/8/files?per_page=100&page=${p}`));
        expect(await client().commits(8)).toHaveLength(120);
    });

    it("stops at GitHub's 3,000 files and says so in a sentence", async () => {
        const before = gh.requests.length;
        const { files, limit } = await client().files(9);
        expect(files).toHaveLength(MAX_PR_FILES);
        expect(limit).toBe("This pull request changes 3,205 files; GitHub lists only the first 3,000, so the other 205 are not part of this analysis.");
        // 30 full pages, then the pull request itself for the count; never a 31st page
        expect(gh.requests.slice(before).map((r) => r.url).filter((u) => u.includes("/files"))).toHaveLength(30);
    });

    it("reads the commits (GitHub lists at most 250) and a branch, whose name is sent encoded", async () => {
        const commits = await client().commits(7);
        expect(commits).toEqual([{ sha: "a1", message: "Fix the discount base", author: "dev1", date: "2026-11-01T10:00:00Z" }]);
        expect(JSON.stringify(commits)).not.toContain("AUTHOR-EMAIL-SENTINEL");
        expect(await client().commits(9)).toHaveLength(250);
        const before = gh.requests.length;
        expect(await client().branch("release/1.2")).toEqual({ name: "release/1.2", sha: "2222222222222222222222222222222222222222", protected: true });
        expect(gh.requests.slice(before)[0]!.url).toBe("/repos/acme/shop/branches/release%2F1.2");
    });

    it("refuses a malformed pull request number or branch name before calling GitHub", async () => {
        const before = gh.requests.length;
        for (const n of [0, -1, 1.5, Number.NaN]) await expect(client().pr(n)).rejects.toThrow(TrackerError);
        for (const b of ["", "../../etc", "a\nb"]) await expect(client().branch(b)).rejects.toThrow(TrackerError);
        expect(gh.requests.length).toBe(before);
    });

    it("says plainly when a pull request does not exist", async () => {
        await expect(client().pr(404)).rejects.toMatchObject({ code: "not_found" });
    });
});

describe("secrets", () => {
    it("removing the connection deletes the stored token", async () => {
        expect((await call("DELETE", `/api/projects/${A}/code-host`)).status).toBe(204);
        expect(platform.db.get("SELECT id FROM code_repos WHERE project_id = ?", A)).toBeUndefined();
        expect((await call("GET", `/api/projects/${A}/code-host`)).body).toEqual({ connected: false });
    });

    it("no answer and no log line held the token or the webhook secret", () => {
        app.log.warn("code-host-log-capture-check");
        expect(logged.join("")).toContain("code-host-log-capture-check");
        expect(answers.length).toBeGreaterThan(20);
        for (const s of [TOKEN, OTHER_TOKEN, WEBHOOK_SECRET]) {
            expect(answers.filter((a) => a.includes(s))).toEqual([]);
            expect(logged.filter((l) => l.includes(s))).toEqual([]);
        }
    });
});
