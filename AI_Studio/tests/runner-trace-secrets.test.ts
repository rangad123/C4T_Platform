/**
 * Round 40: failure traces from a runner hold no password or token.
 *
 * 1. The real agent program against the real platform: a failing web test signs in with the project's password (typed into a password
 *    field, sent in a form body) and an API token (sent in a header, echoed back by the page). The trace the platform stores is unpacked
 *    and searched in every form a trace carries a secret in; the fill is still there, with its value hidden.
 * 2. An older runner that does not clean its traces (protocol 1, a stand-in agent): the platform cleans the trace it uploads, and keeps no
 *    trace it cannot clean (the run's events say so).
 * 3. Pixels cannot be cleaned: a password field is drawn as dots, so two different passwords of the same length give the same picture.
 * 4. A real Chromium form sign-in with a password holding ! ' ( ) ~ and a space, which a browser form-encodes differently from
 *    encodeURIComponent: the cleaned trace is searched by a check that decodes the trace instead of reusing the cleaner's list of forms
 *    (fixtures/secret-oracle.ts). The first test's password has those characters too. A masked part no longer carries the sha1 of its
 *    original anywhere (name or reference), and Playwright's own trace loader still reads the trace with every resource it points at.
 * 5. On a store that is not this disk, an upload whose cleaned copy cannot be stored is removed rather than kept as it came.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/runner-trace-secrets.test.ts
 * Ports: platform 8401, fixture application 8402.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { scrubTraceFile, traceSecretForms, traceSecretsOfRun } from "../src/engine/evidence/trace-scrub.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner } from "./helpers/personal-runner.js";
import type { ObjectStore } from "../src/platform/object-store.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { FakeAgent, failedRun, viaFetch } from "./fixtures/fake-agent.js";
import { readableSecrets } from "./fixtures/secret-oracle.js";

const PLATFORM_PORT = 8401;
const APP_PORT = 8402;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "trace-secrets-admin-key-7c19";
const USER = "trace@example.com";
// ! ' ( ) ~ and a space: a browser's form body escapes them differently from encodeURIComponent.
const PASSWORD = "TRACE-Pa!ss~(w0rd)'4e81 b2";
const TOKEN = "TRACE-ApiToken-93d0aa";
const OLD_PASSWORD = "TRACE-OldRunnerPw-1f6c";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let agentWork: string;
let appServer: http.Server;
let agent: Agent | undefined;
let agentDone: Promise<number> | undefined;

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
async function jobDone(jobId: string): Promise<any> {
    for (let i = 0; i < 400; i++) {
        const j = (await admin("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("job did not finish");
}
/** Every part of a stored trace, unpacked. */
async function storedTrace(artifactId: string): Promise<Record<string, Uint8Array>> {
    const res = await fetch(`${BASE}/api/artifacts/${artifactId}?key=${API_KEY}`);
    expect(res.status).toBe(200);
    return unzipSync(new Uint8Array(await res.arrayBuffer()));
}
/** Which forms of these secrets are in which part. */
const leaksIn = (parts: Record<string, Uint8Array>, secrets: string[]): string[] => {
    const forms = traceSecretForms(secrets);
    return Object.entries(parts).flatMap(([name, b]) => {
        const s = Buffer.from(b).toString("latin1");
        const u16 = Buffer.from(b).toString("utf16le");
        return forms.filter((f) => s.includes(Buffer.from(f).toString("latin1")) || u16.includes(f)).map((f) => `${f.slice(0, 12)}… in ${name}`);
    });
};

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = http.createServer((req, res) => {
        const p = (req.url ?? "/").split("?")[0];
        const page = (body: string, h: Record<string, string> = {}) => (res.writeHead(200, { "content-type": "text/html", ...h }), res.end(`<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main>${body}</main></body></html>`));
        if (p === "/login" && req.method === "POST") {
            req.resume();
            return req.on("end", () => page(`<h1>Welcome back</h1><p>Your key ${TOKEN}</p><script>fetch("/api/me", { headers: { authorization: "Bearer ${TOKEN}" } }).then((r) => r.text()).then((t) => console.log("me " + t));</script>`, { "x-echo": TOKEN }));
        }
        if (p === "/api/me") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ seen: req.headers.authorization ?? "" }));
        page('<h1>Sign in</h1><form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>');
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-trace-secrets-"));
    agentWork = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-trace-secrets-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
}, 60_000);

afterAll(async () => {
    agent?.stop();
    await agentDone;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await worker?.stop();
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentWork, { recursive: true, force: true });
});

describe("a failure trace from a runner", () => {
    it("from the real agent program: the stored trace holds the fill and the sign-in, with the password and token hidden in every part", async () => {
        const projectId = (await admin("POST", "/api/projects", { name: "Trace secrets" })).body.id as string;
        const made = { status: 201, body: { secret: personalRunner(platform, { label: "trace agent", replace: true }).secret } };
        expect(made.status).toBe(201);
        const { log, lines } = memoryLogger();
        agent = new Agent({ config: { baseUrl: BASE, token: made.body.secret, name: "trace agent", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 } });
        agentDone = agent.run();
        for (let i = 0; i < 100 && !(await admin("GET", `/api/projects/${projectId}/agents`)).body.some((a: { online: boolean }) => a.online); i++) await new Promise((r) => setTimeout(r, 200));
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
            baseUrl: APP,
            validate: false,
            credentials: { username: USER, password: PASSWORD, apiToken: TOKEN },
            specs: [
                {
                    title: "Signing in shows the dashboard",
                    kind: "web",
                    category: "Web",
                    steps: [
                        { action: "navigate", url: `${APP}/` },
                        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
                        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
                        { action: "click", locator: { by: "role", role: "button", value: "Log in", exact: true } },
                        { action: "assert", check: "visible", locator: { by: "text", value: "Your dashboard" } },
                    ],
                },
            ],
        });
        expect(imp.status, imp.text).toBe(202);
        const testId = imp.body.tests[0].id as string;
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        const started = await admin("POST", `/api/tests/${testId}/validate`);
        expect(started.status, started.text).toBe(202);
        const job = await jobDone(started.body.jobId);
        expect(job.ranOn).toMatchObject({ kind: "agent", name: "trace agent" });
        expect((await admin("GET", `/api/tests/${testId}/executions`)).body[0].status).toBe("failed");

        const trace = platform.db.get<{ id: string }>("SELECT id FROM artifacts WHERE project_id = ? AND test_case_id = ? AND kind = 'trace'", projectId, testId);
        expect(trace, "the failing run stored a trace").toBeTruthy();
        const parts = await storedTrace(trace!.id);
        // A real trace: the action log, the network log and the form body are there, and the fill of the password is recorded with its value hidden.
        const names = Object.keys(parts);
        expect(names.some((n) => /\d-trace\.trace$/.test(n))).toBe(true);
        expect(names.some((n) => /\d-trace\.network$/.test(n))).toBe(true);
        const actions = names.filter((n) => n.endsWith(".trace")).map((n) => Buffer.from(parts[n]!).toString("utf8")).join("\n");
        expect(actions).toMatch(/"method":"fill","params":\{[^}]*"value":"\[hidden\]"/);
        expect(actions).toContain(USER); // a user name is not a secret: the evidence stays useful
        expect(leaksIn(parts, [PASSWORD, TOKEN])).toEqual([]);
        expect(readableSecrets(parts, [PASSWORD, TOKEN])).toEqual([]);
        // The agent's own output never had them either.
        expect(lines.join("\n")).not.toContain(PASSWORD);
    }, 240_000);

    it("from an older runner that does not clean traces: the platform cleans what it uploads, and keeps none it cannot clean", async () => {
        agent?.stop();
        await agentDone;
        agent = undefined;
        const projectId = (await admin("POST", "/api/projects", { name: "Older runner" })).body.id as string;
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, credentials: { username: USER, password: OLD_PASSWORD }, specs: [{ title: "Home", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Nothing" } }] }] });
        expect(imp.status).toBe(202);
        const testId = imp.body.tests[0].id as string;
        const secret = personalRunner(platform, { label: "old", replace: true }).secret;
        const old = new FakeAgent(viaFetch(BASE), secret, { name: "older runner" });
        expect((await old.hello()).status).toBe(200);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        const raw = zipSync({ "test.trace": strToU8(`{"type":"before","method":"fill","params":{"value":"${OLD_PASSWORD}"}}`), "resources/a.dat": strToU8(`password=${encodeURIComponent(OLD_PASSWORD)}`), "page.jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]) });
        const unsafe = zipSync({ "page.jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(OLD_PASSWORD), 0xff, 0xd9]) });
        const runWith = async (bytes: Uint8Array) => {
            const started = await admin("POST", `/api/tests/${testId}/validate`);
            expect(started.status, started.text).toBe(202);
            const offer = (await old.next(30_000))!;
            expect((await old.upload(offer.taskId, "t.zip", Buffer.from(bytes))).status).toBe(200);
            expect((await old.result(offer.taskId, { ok: true, runs: [failedRun(offer.scripts[0]!.testId, "Not visible", { artifacts: [{ kind: "trace", ref: "t.zip" }] })] })).status).toBe(200);
            await jobDone(started.body.jobId);
            return started.body.jobId as string;
        };
        await runWith(raw);
        const kept = platform.db.all<{ id: string }>("SELECT id FROM artifacts WHERE project_id = ? AND kind = 'trace'", projectId);
        expect(kept).toHaveLength(1);
        const parts = await storedTrace(kept[0]!.id);
        expect(Object.keys(parts)).toEqual(["test.trace", "resources/a.dat", "page.jpeg"]);
        expect(leaksIn(parts, [OLD_PASSWORD])).toEqual([]);
        expect(Buffer.from(parts["resources/a.dat"]!).toString()).toBe("password=[hidden]");

        const second = await runWith(unsafe);
        expect(platform.db.all("SELECT id FROM artifacts WHERE project_id = ? AND kind = 'trace' AND job_id = ?", projectId, second)).toEqual([]);
        const events = (await admin("GET", `/api/test-generation/${second}/events`)).body as Array<{ kind: string; message: string }>;
        expect(events.find((e) => e.kind === "runner_trace_withheld")?.message).toMatch(/could not be cleaned of the run's passwords and tokens/);
        // Nothing the platform keeps holds the password in plain text: not the database, not a stored file (unpacked when it is a zip).
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const found: string[] = [];
        const scan = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) scan(full);
                else {
                    const bytes = fs.readFileSync(full);
                    const parts = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ? unzipSync(new Uint8Array(bytes)) : { [e.name]: new Uint8Array(bytes) };
                    found.push(...leaksIn(parts, [OLD_PASSWORD, PASSWORD, TOKEN]).map((l) => `${l} (${path.relative(dataDir, full)})`));
                }
            }
        };
        scan(dataDir);
        expect(found).toEqual([]);
    }, 120_000);
});

describe("an upload on a store that is not this disk", () => {
    it("is removed when its cleaned copy cannot be stored, rather than kept for a day as it came", async () => {
        agent?.stop();
        await agentDone;
        agent = undefined;
        const pw = "TRACE-StorePw-8c2e17";
        const projectId = (await admin("POST", "/api/projects", { name: "Remote store" })).body.id as string;
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, credentials: { username: USER, password: pw }, specs: [{ title: "Home", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Nothing" } }] }] });
        expect(imp.status).toBe(202);
        const testId = imp.body.tests[0].id as string;
        const secret = personalRunner(platform, { label: "remote", replace: true }).secret;
        const old = new FakeAgent(viaFetch(BASE), secret, { name: "older runner, remote store" });
        expect((await old.hello()).status).toBe(200);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        // The disk store, seen as a remote one whose writes of a runner's task files fail.
        const backing = platform.store;
        const methods = ["put", "putFile", "copy", "get", "getBytes", "head", "exists", "delete", "deletePrefix", "list", "signedUrl"] as const;
        const remote = { ...Object.fromEntries(methods.map((m) => [m, (backing[m] as (...a: unknown[]) => unknown).bind(backing)])), kind: "s3" } as unknown as ObjectStore;
        const failed: string[] = [];
        remote.putFile = async (key, file, o) => {
            if (key.includes("/_agent/")) {
                failed.push(key);
                throw new Error("the store is not answering");
            }
            return backing.putFile(key, file, o);
        };
        platform.store = remote;
        try {
            const started = await admin("POST", `/api/tests/${testId}/validate`);
            expect(started.status, started.text).toBe(202);
            const offer = (await old.next(30_000))!;
            const raw = zipSync({ "test.trace": strToU8(`{"type":"before","method":"fill","params":{"value":"${pw}"}}`) });
            expect((await old.upload(offer.taskId, "t.zip", Buffer.from(raw))).status).toBe(200);
            expect((await old.result(offer.taskId, { ok: true, runs: [failedRun(offer.scripts[0]!.testId, "Not visible", { artifacts: [{ kind: "trace", ref: "t.zip" }] })] })).status).toBe(200);
            await jobDone(started.body.jobId);
            expect(failed).toHaveLength(1);
            // the run keeps the cleaned trace; the upload as it came is gone from the store
            const kept = platform.db.all<{ id: string }>("SELECT id FROM artifacts WHERE project_id = ? AND kind = 'trace'", projectId);
            expect(kept).toHaveLength(1);
            expect(readableSecrets(await storedTrace(kept[0]!.id), [pw])).toEqual([]);
            expect(await backing.exists(failed[0]!)).toBe(false);
        } finally {
            platform.store = backing;
        }
        // Nothing on this disk holds the password.
        const found: string[] = [];
        const scan = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) scan(full);
                else {
                    const bytes = fs.readFileSync(full);
                    const parts = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ? unzipSync(new Uint8Array(bytes)) : { [e.name]: new Uint8Array(bytes) };
                    found.push(...readableSecrets(parts, [pw]).map((l) => `${l} (${path.relative(dataDir, full)})`));
                }
            }
        };
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        scan(dataDir);
        expect(found).toEqual([]);
    }, 120_000);
});

describe("a real Chromium form sign-in", () => {
    it("the trace holds the form-encoded password (! ' ( ) ~ escaped, + for a space); after cleaning, no decoding of any part gives it back, no name or text keeps a masked part's original sha1, and Playwright's loader reads it", async () => {
        const pw = "Pa!ss~(x)'9 zq";
        const browser = await chromium.launch();
        const file = path.join(agentWork, "form-login-trace.zip");
        try {
            const context = await browser.newContext();
            await context.tracing.start({ screenshots: true, snapshots: true });
            const page = await context.newPage();
            await page.goto(`${APP}/`);
            await page.getByLabel("Email").fill(USER);
            await page.getByLabel("Password").fill(pw);
            await page.getByRole("button", { name: "Log in" }).click();
            await page.getByText("Welcome back").waitFor();
            await context.tracing.stop({ path: file });
        } finally {
            await browser.close();
        }
        const before = unzipSync(new Uint8Array(fs.readFileSync(file)));
        const formBody = new URLSearchParams({ email: USER, password: pw }).toString();
        // The browser sent the form-encoded body, and the trace kept it (so the check below proves something).
        expect(Object.values(before).some((b) => Buffer.from(b).toString("latin1").includes(formBody))).toBe(true);
        expect(readableSecrets(before, [pw]).length).toBeGreaterThan(0);
        const r = await scrubTraceFile(file, traceSecretsOfRun({ credentials: { username: USER, password: pw } }));
        expect(r).toMatchObject({ ok: true });
        const after = unzipSync(new Uint8Array(fs.readFileSync(file)));
        expect(readableSecrets(after, [pw])).toEqual([]);
        expect(Object.values(after).some((b) => Buffer.from(b).toString().includes(`email=${encodeURIComponent(USER)}&password=[hidden]`))).toBe(true);
        // Playwright names a resource after the sha1 of its content. A masked part gets the sha1 of its cleaned content; the sha1 of the
        // original (enough to test a guessed password offline) is in no name and no text.
        const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
        const changed = Object.entries(before).filter(([name, b]) => !after[name] || Buffer.compare(Buffer.from(after[name]!), Buffer.from(b)) !== 0);
        const formPart = changed.find(([, b]) => Buffer.from(b).toString("latin1").includes(formBody));
        expect(formPart?.[0]).toBe(`resources/${sha1(formPart![1])}.dat`);
        const gone = changed.filter(([name]) => name.startsWith("resources/")).map(([, b]) => sha1(b));
        expect(gone.length).toBeGreaterThan(0);
        const everything = Object.entries(after).map(([name, b]) => `${name}\n${Buffer.from(b).toString("latin1")}`).join("\n");
        expect(gone.filter((h) => everything.includes(h))).toEqual([]);
        for (const [name, b] of Object.entries(after)) if (/^resources\/[0-9a-f]{40}/.test(name)) expect(name.slice(10, 50)).toBe(sha1(b));
        expect(Object.keys(after).length).toBe(Object.keys(before).length);
        // Playwright's own loader reads it: the actions are there, and every resource the network log names is in the archive.
        const core = createRequire(import.meta.url)("playwright-core/lib/coreBundle");
        const dir = fs.mkdtempSync(path.join(agentWork, "trace-model-"));
        for (const [name, b] of Object.entries(after)) {
            fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
            fs.writeFileSync(path.join(dir, name), b);
        }
        const loader = new core.iso.TraceLoader();
        await loader.load(new core.tools.DirTraceLoaderBackend(dir), undefined);
        const model = new core.iso.TraceModel(dir, loader.contextEntries);
        expect(model.actions.some((a: { method?: string; params?: { value?: string } }) => a.method === "fill" && a.params?.value === "[hidden]")).toBe(true);
        expect(model.resources.length).toBeGreaterThan(0);
        const refs = model.resources.flatMap((res: { request?: { postData?: { _sha1?: string; _file?: string } }; response?: { content?: { _sha1?: string; _file?: string } } }) => [res.request?.postData, res.response?.content].flatMap((c) => [c?._sha1 && `resources/${c._sha1}`, c?._file].filter((x): x is string => Boolean(x))));
        expect(refs.length).toBeGreaterThan(0);
        expect(refs.filter((ref: string) => !fs.existsSync(path.join(dir, ref)))).toEqual([]);
    }, 60_000);
});

describe("pixels cannot be cleaned", () => {
    it("a password field is drawn as dots: two different passwords of the same length make the same picture (a text field does not)", async () => {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage();
            await page.setContent('<label>Secret <input id="f" type="password"></label>');
            // The same field, in the same place, with two different values of the same length; then the same value as plain text.
            const shot = async (value: string, type = "password") => {
                await page.locator("#f").evaluate((el, t) => ((el as HTMLInputElement).type = t), type);
                await page.fill("#f", value);
                await page.locator("#f").evaluate((el) => (el as HTMLInputElement).blur());
                return page.locator("#f").screenshot();
            };
            const a = await shot("AAAAAAAAAAAAAA");
            const b = await shot("zq9#Lm2!Xw0pQe");
            const c = await shot("zq9#Lm2!Xw0pQe", "text");
            expect(Buffer.compare(a, b)).toBe(0);
            expect(Buffer.compare(b, c)).not.toBe(0);
        } finally {
            await browser.close();
        }
    }, 60_000);
});
