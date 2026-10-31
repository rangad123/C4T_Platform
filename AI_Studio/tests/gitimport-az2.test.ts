/**
 * Fixes AZ2 for the Git import (review AX: M6, L1, L2), with real git and local servers only:
 *  - M6: with an access token git does not follow a redirect, and the token never reaches the redirect target (two local HTTP servers on different ports);
 *  - L1: a refresh does not overwrite a script that was edited here since the last import (check marks it, refresh skips it and says so);
 *  - L2: at most two imports run at the same time on the whole platform, and a hung git ends with a plain message and frees its slot.
 * No browser. Ports: 6231 (the repository host that redirects), 6232 (the redirect target).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CustomScriptStore } from "../src/platform/custom-script-store.js";
import { GitImportService, type GitImportPorts } from "../src/platform/git-import-service.js";
import { setGitImportSeam } from "../src/platform/routes/git-import.js";
import { buildServer } from "../src/platform/server.js";
import { TestRepo, makeTempRoot, specFile, writeFakeGit } from "./fixtures/git-fixture.js";

const API_KEY = "test-api-key-gitimport-az2";
const REDIRECTOR = 6231;
const TARGET = 6232;
const TOKEN = "AZ2-redirect-Sentinel-Tok3n-51c0";

const stubPorts = (): GitImportPorts => ({
    checkScript: () => [],
    helperNames: () => [],
    repos: { create: () => { throw new Error("not used"); }, list: () => [], get: () => undefined, update: () => undefined, delete: () => undefined },
    tests: { upsert: async () => { throw new Error("not used"); }, forRepo: () => [], queueValidation: async () => ({ jobId: null }) },
});

let tmp: string;
beforeAll(() => {
    tmp = makeTempRoot("gitimport-az2-");
});
afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("M6: a redirect while an access token is in use", () => {
    const seenTarget: Array<{ url: string | undefined; auth: string | undefined }> = [];
    const seenRedirector: Array<{ url: string | undefined; auth: string | undefined }> = [];
    let redirector: http.Server;
    let target: http.Server;

    beforeAll(async () => {
        target = http.createServer((req, res) => {
            seenTarget.push({ url: req.url, auth: req.headers.authorization });
            res.writeHead(404);
            res.end("not a repository");
        });
        redirector = http.createServer((req, res) => {
            seenRedirector.push({ url: req.url, auth: req.headers.authorization });
            res.writeHead(302, { location: `http://127.0.0.1:${TARGET}/elsewhere.git${(req.url ?? "").replace(/^\/acme\/tests\.git/, "")}` });
            res.end();
        });
        await Promise.all([new Promise<void>((r) => target.listen(TARGET, "127.0.0.1", r)), new Promise<void>((r) => redirector.listen(REDIRECTOR, "127.0.0.1", r))]);
    });
    afterAll(() => {
        target?.close();
        redirector?.close();
    });

    const service = () => new GitImportService({ scratchRoot: path.join(tmp, "scratch-m6"), allowLocal: true }, stubPorts());
    const url = `http://127.0.0.1:${REDIRECTOR}/acme/tests.git`;

    it("with a token the redirect is refused with a plain message, and the target is never contacted", async () => {
        seenTarget.length = 0;
        seenRedirector.length = 0;
        const e = (await service().dryRun("p1", { url, token: TOKEN }).catch((x: Error) => x)) as Error;
        expect(e.message).toMatch(/redirects somewhere else/);
        expect(e.message).not.toContain(TOKEN);
        expect(e.message).not.toContain(String(TARGET));
        expect(seenRedirector.length).toBeGreaterThan(0);
        expect(seenRedirector[0]!.auth).toBe(`Bearer ${TOKEN}`); // the repository's own host is the one that gets it
        expect(seenTarget).toEqual([]); // nothing was sent to the redirect target
    }, 60_000);

    it("without a token the first redirect is still followed (the documented gap), and no credential travels", async () => {
        seenTarget.length = 0;
        const e = (await service().dryRun("p1", { url }).catch((x: Error) => x)) as Error;
        expect(e).toBeInstanceOf(Error);
        expect(seenTarget.length).toBeGreaterThan(0);
        expect(seenTarget.every((s) => s.auth === undefined)).toBe(true);
    }, 60_000);
});

describe("L1: a refresh does not overwrite a hand edit", () => {
    let dataDir: string;
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let repo: TestRepo;
    let custom: CustomScriptStore;
    let projectId: string;
    let linkId: string;
    let xId: string;
    let yId: string;
    let c1: string;
    let c2: string;
    let c3: string;

    const call = async (method: "GET" | "POST" | "PUT", u: string, payload?: unknown) => {
        const res = await server.inject({ method, url: u, payload: payload as never, headers: { "x-api-key": API_KEY } });
        return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
    };
    const script = (title: string, n: number) => specFile(title, `await page.goto('/page-${n}');`);
    const currentScript = async (testId: string): Promise<string> => (await call("GET", `/api/tests/${testId}/script`)).body.content ?? (await call("GET", `/api/tests/${testId}/script`)).body;

    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-gitimp-az2-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY }));
        server = await buildServer(platform);
        setGitImportSeam(platform, { allowLocal: true, scratchRoot: path.join(tmp, "scratch-l1") });
        custom = new CustomScriptStore(platform.db);
        projectId = (await call("POST", "/api/projects", { name: "AZ2 git" })).body.id;
        repo = new TestRepo(path.join(tmp, "repo-l1"));
        repo.write("e2e/x.spec.ts", script("X page", 1));
        repo.write("e2e/y.spec.ts", script("Y page", 1));
        c1 = repo.commit("first");
        repo.git("branch", "-f", "follow", c1);
    }, 60_000);
    afterAll(async () => {
        await server?.close();
        platform?.db.close();
        repo?.destroy();
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it("imports two files; one is then edited here", async () => {
        const r = await call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, ref: "follow", path: "e2e" });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        xId = r.body.imported.find((i: any) => i.path === "e2e/x.spec.ts").testId;
        yId = r.body.imported.find((i: any) => i.path === "e2e/y.spec.ts").testId;
        linkId = (await call("GET", `/api/projects/${projectId}/git-imports`)).body[0].id;
        const edited = script("X page", 1).replace("/page-1", "/my-own-page");
        const put = await call("PUT", `/api/tests/${xId}/script`, { content: edited, note: "hand edit" });
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        expect(custom.listVersions(xId).map((v) => v.kind)).toEqual(["edited", "git"]);
    });

    it("when only the unedited file changed upstream, the edited one is not listed as changed", async () => {
        repo.write("e2e/y.spec.ts", script("Y page", 2));
        c2 = repo.commit("change y");
        repo.git("branch", "-f", "follow", c2);
        const chk = await call("POST", `/api/projects/${projectId}/git-imports/${linkId}/check`);
        expect(chk.status, JSON.stringify(chk.body)).toBe(200);
        expect(chk.body.changed.map((c: any) => c.path)).toEqual(["e2e/y.spec.ts"]);
        expect(chk.body.changed[0].editedHere).toBeUndefined();
    }, 60_000);

    it("check marks the edited file editedHere when the repository changed it too, and refresh skips it and says why", async () => {
        repo.write("e2e/x.spec.ts", script("X page", 3));
        c3 = repo.commit("change x");
        repo.git("branch", "-f", "follow", c3);
        const chk = await call("POST", `/api/projects/${projectId}/git-imports/${linkId}/check`);
        const by = Object.fromEntries(chk.body.changed.map((c: any) => [c.path, c]));
        expect(by["e2e/x.spec.ts"]).toMatchObject({ editedHere: true });
        expect(by["e2e/y.spec.ts"].editedHere).toBeUndefined();

        const handEdit = await currentScript(xId);
        expect(handEdit).toContain("/my-own-page");
        const versionsX = custom.listVersions(xId).length;
        const ref = await call("POST", `/api/projects/${projectId}/git-imports/${linkId}/refresh`, {});
        expect(ref.status, JSON.stringify(ref.body)).toBe(201);
        const skipped = ref.body.skipped.find((s: any) => s.path === "e2e/x.spec.ts");
        expect(skipped).toMatchObject({ editedHere: true, reason: expect.stringMatching(/Edited here since the last import/) });
        expect(ref.body.imported.map((i: any) => i.path)).toEqual(["e2e/y.spec.ts"]);
        // the hand edit is intact, with no new version; the other file moved on
        expect(await currentScript(xId)).toBe(handEdit);
        expect(custom.listVersions(xId)).toHaveLength(versionsX);
        expect(await currentScript(yId)).toContain("/page-2");
    }, 120_000);

    it("a file that was not edited is still updated by a refresh", async () => {
        repo.write("e2e/y.spec.ts", script("Y page", 4));
        const c4 = repo.commit("change y again");
        repo.git("branch", "-f", "follow", c4);
        const ref = await call("POST", `/api/projects/${projectId}/git-imports/${linkId}/refresh`, {});
        expect(ref.body.imported.find((i: any) => i.path === "e2e/y.spec.ts")).toMatchObject({ created: false, changed: true });
        expect(await currentScript(yId)).toContain("/page-4");
    }, 120_000);
});

describe("L2: imports are limited, and a hung git frees its slot", () => {
    it("starts at most two at a time (a third is a plain 429), and the slots are free again afterwards", async () => {
        const fake = writeFakeGit(tmp, "hang");
        const svc = new GitImportService({ scratchRoot: path.join(tmp, "scratch-l2"), allowLocal: true, git: { file: fake.file, prefixArgs: fake.prefixArgs }, timeoutMs: 1_500 }, stubPorts());
        const url = "file:///nowhere/never.git";
        const first = svc.dryRun("p1", { url }).catch((e: Error) => e);
        const second = svc.dryRun("p2", { url }).catch((e: Error) => e);
        await new Promise((r) => setTimeout(r, 400));
        const third = (await svc.dryRun("p3", { url }).catch((e: Error & { status?: number }) => e)) as Error & { status?: number };
        expect(third.status).toBe(429);
        expect(third.message).toMatch(/Other Git imports are running/);
        const done = (await Promise.all([first, second])) as Array<Error>;
        for (const e of done) expect(e.message).toMatch(/took too long/);
        // both slots are free: a new import is accepted (and ends the same way)
        const again = (await svc.dryRun("p3", { url }).catch((e: Error) => e)) as Error;
        expect(again.message).toMatch(/took too long/);
        // the stand-in git was ended each time
        const rec = JSON.parse(fs.readFileSync(fake.record, "utf8")) as Array<{ pid: number }>;
        for (const r of rec) expect(() => process.kill(r.pid, 0), `pid ${r.pid} should be gone`).toThrow();
    }, 90_000);
});
