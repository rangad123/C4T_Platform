/**
 * Holes reachable on the hosted preview (round 36 review), each against a real platform through inject, a stand-in Crowd4Test sign-in
 * (port 7975) and local stand-in servers (7976-7979). No real provider or external address is ever called.
 *
 *  1. A custom AI endpoint cannot reach the server's own network: no redirect is followed, private addresses are refused when the
 *     connection is made (so DNS rebinding fails too), and "Test this key" shows only a class of failure, never the answer's text.
 *  2. A .docx built to unpack to gigabytes is refused before it is read, and the server keeps answering.
 *  4. A retired runner's open poll receives nothing more.
 *  5. A tester cannot make a runner token (a task offer carries the project's credentials).
 *  6. Staff limited to some projects manage AI configurations of those projects' organisations only, and none of the platform's.
 *  7. Deleting a project needs permission to delete tests; a runner registered from it and serving nothing else is retired with it.
 *  8. Caps (runners, folders, AI configurations, review comments) answer a plain 409, and polling does not sweep on every turn.
 * (3, the review policy, is in reviews-api.test.ts.)
 */
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { aiConfigStore } from "../src/platform/ai-config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { TaskOffer } from "../src/agent-protocol/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { SYSTEM_ACTOR } from "../src/platform/auth/actor.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { guardedFetch } from "../src/platform/guarded-fetch.js";
import { FolderStore } from "../src/platform/project-folders.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { resetKeyTests } from "../src/platform/routes/ai-config.js";
import { buildServer } from "../src/platform/server.js";
import { checkDocxSize, DOCX_LIMITS, RequirementsDocumentError } from "../src/engine/requirements/extract.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";

const C4T_PORT = 7975;
const LLM_PORT = 7976;
const INTERNAL_PORT = 7977;
const PAGE = { "x-requested-with": "ai-studio" };
const INTERNAL_TEXT = "ASIA-INTERNAL-SECRET from a private host";
const ANSWER_TEXT = "PROVIDER-ANSWER-TEXT-7a1c";

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const without = (...codes: string[]) => PERMISSIONS.filter((c) => !codes.includes(c));
const ACCOUNTS: Record<string, unknown> = {
    "t-ann": me("ann", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-dan": me("dan", "CUSTOMER", without("ai_studio.tests.delete"), "org-a"),
    "t-tom": me("tom", "TESTER", PERMISSIONS),
    "t-sue": me("sue", "SUB_ADMIN", ["ai_studio.access", "ai_studio.ai_keys.manage", "ai_studio.platform.settings", "ai_studio.project.create"]),
    "t-zed": me("zed", "CUSTOMER", PERMISSIONS, "org-z"),
};

let c4t: http.Server;
let llm: http.Server;
let internal: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
const seen: string[] = [];
let llmMode: "redirect" | "text" = "redirect";

const as = async (token: string, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, text: r.body, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; text: string; body: any };
};
const personOf = async (t: string) => (await as(t, "GET", "/api/auth/state")).body.me.id as string;
const control = () => accessControlOf(app).projects.store;
const addMember = async (projectId: string, token: string, projectAdmin = false) => control().addMember(projectId, await personOf(token), { role: "owner", projectAdmin, source: "added", addedBy: "test" });
const newProject = async (token: string, name: string) => (await as(token, "POST", "/api/projects", { name })).body.id as string;
const listen = (s: http.Server, port: number) => new Promise<void>((r) => s.listen(port, "127.0.0.1", r));

beforeAll(async () => {
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    llm = http.createServer((req, res) => {
        seen.push(`llm ${req.method} ${req.url}`);
        req.resume();
        if (llmMode === "redirect") {
            res.writeHead(302, { location: `http://127.0.0.1:${INTERNAL_PORT}/latest/meta-data/iam/security-credentials/role` });
            return res.end();
        }
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: ANSWER_TEXT, type: "invalid_request_error" } }));
    });
    internal = http.createServer((req, res) => {
        seen.push(`internal ${req.method} ${req.url}`);
        req.resume();
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(INTERNAL_TEXT);
    });
    await Promise.all([listen(c4t, C4T_PORT), listen(llm, LLM_PORT), listen(internal, INTERNAL_PORT)]);
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-live-hardening-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: "live-hardening-key-0123456789", SECRET_KEY: "live-hardening-secret-0123456789abcdef", C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://www.crowd4test.example" }),
    );
    app = await buildServer(platform);
    await app.ready();
});

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await Promise.all([c4t, llm, internal].map((s) => new Promise((r) => s?.close(r))));
    fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
    delete process.env.BLOCK_PRIVATE_TARGETS;
    vi.restoreAllMocks();
});

describe("1. a custom AI endpoint", () => {
    it("never follows a redirect: the private address is not contacted, and nothing of any answer is shown", async () => {
        resetKeyTests();
        seen.length = 0;
        llmMode = "redirect";
        const pid = await newProject("t-ann", "Shop");
        const c = await as("t-ann", "POST", `/api/projects/${pid}/ai/configurations`, { label: "x", provider: "openai-compatible", model: "m", baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: "sk-customer-secret-key-1234" });
        expect(c.status).toBe(201);
        const t = await as("t-ann", "POST", `/api/ai-configurations/${c.body.id}/test`, {});
        expect(t.status).toBe(200);
        expect(t.body.ok).toBe(false);
        expect(seen.some((s) => s.startsWith("internal"))).toBe(false);
        expect(t.text).not.toContain("ASIA-INTERNAL");
        expect(t.body.configuration.statusNote).toMatch(/^(Key refused|Address not reachable|Provider busy|Unexpected answer)\./);
    });

    it("shows only the class of a failure, never the text the address answered", async () => {
        resetKeyTests();
        llmMode = "text";
        const pid = await newProject("t-ann", "Shop two");
        const c = await as("t-ann", "POST", `/api/projects/${pid}/ai/configurations`, { label: "y", provider: "openai-compatible", model: "m", baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: "sk-customer-secret-key-5678" });
        const t = await as("t-ann", "POST", `/api/ai-configurations/${c.body.id}/test`, {});
        expect(t.body.ok).toBe(false);
        expect(t.text).not.toContain(ANSWER_TEXT);
        expect(t.body.message).toMatch(/^It did not work\. Unexpected answer\./);
        expect(t.body.configuration.statusNote).toMatch(/^Unexpected answer\./);
    });

    it("with BLOCK_PRIVATE_TARGETS, refuses a private address at connection time, whatever the name resolved to before (DNS rebinding)", async () => {
        seen.length = 0;
        // The name resolves to loopback only when the connection is made.
        vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as never);
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        await expect(guardedFetch(`http://rebind.example:${INTERNAL_PORT}/latest/meta-data/`)).rejects.toThrow(/fetch failed/);
        await expect(guardedFetch(`http://127.0.0.1:${INTERNAL_PORT}/`)).rejects.toThrow(/fetch failed/);
        await expect(guardedFetch(`http://169.254.169.254/latest/meta-data/`)).rejects.toThrow(/fetch failed/);
        expect(seen).toEqual([]);
        // The same lookup without the guard reaches the server: what is checked is what the connection uses.
        delete process.env.BLOCK_PRIVATE_TARGETS;
        const r = await guardedFetch(`http://rebind.example:${INTERNAL_PORT}/x`);
        expect(await r.text()).toBe(INTERNAL_TEXT);
        expect(seen).toEqual(["internal GET /x"]);
    });

    it("refuses a redirect even to a public address", async () => {
        llmMode = "redirect";
        await expect(guardedFetch(`http://127.0.0.1:${LLM_PORT}/v1/chat/completions`, { method: "POST", body: "{}" })).rejects.toThrow(/fetch failed/);
    });
});

/** A zip with one stored entry list; `lie` makes the directory claim a small size for every part. */
function zip(entries: Array<{ name: string; data: Buffer }>, lie = false): Buffer {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const packed = zlib.deflateRawSync(e.data, { level: 9 });
        const name = Buffer.from(e.name);
        const size = lie ? 1000 : e.data.length;
        const crc = zlib.crc32(e.data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(8, 8);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(packed.length, 18);
        lh.writeUInt32LE(size, 22);
        lh.writeUInt16LE(name.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(8, 10);
        ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(packed.length, 20);
        ch.writeUInt32LE(size, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(offset, 42);
        locals.push(lh, name, packed);
        central.push(ch, name);
        offset += lh.length + name.length + packed.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}
const WORD_PARTS = (doc: Buffer) => [
    { name: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: "word/document.xml", data: doc },
];

describe("2. a compression bomb in an import", () => {
    // About 30 MB of paragraphs: a few tens of kilobytes packed, made in memory and never written to disk.
    const BIG = Buffer.concat([Buffer.from('<w:document xmlns:w="w"><w:body>'), Buffer.alloc(30 * 1024 * 1024, "<w:p/>"), Buffer.from("</w:body></w:document>")]);

    it("refuses a part that unpacks past the limit, whether or not the zip states its size honestly", () => {
        for (const lie of [false, true]) {
            const bomb = zip(WORD_PARTS(BIG), lie);
            expect(bomb.length).toBeLessThan(200_000);
            expect(() => checkDocxSize(bomb, "r.docx")).toThrow(RequirementsDocumentError);
            expect(() => checkDocxSize(bomb, "r.docx")).toThrow(/unpacks to more than/);
        }
        // Many small parts that add up, and too many parts.
        const many = Array.from({ length: 5 }, (_, i) => ({ name: `word/media/p${i}.xml`, data: Buffer.alloc(15 * 1024 * 1024, "a") }));
        expect(() => checkDocxSize(zip(many), "r.docx")).toThrow(/unpacks to more than/);
        const parts = Array.from({ length: DOCX_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `p${i}`, data: Buffer.from("x") }));
        expect(() => checkDocxSize(zip(parts), "r.docx")).toThrow(/more than 1000 parts/);
        expect(() => checkDocxSize(zip(WORD_PARTS(Buffer.from("<w:document/>"))), "r.docx")).not.toThrow();
    });

    it("answers the upload with a plain 400, and the server keeps answering", async () => {
        const pid = await newProject("t-ann", "Requirements shop");
        const bomb = zip(WORD_PARTS(BIG), true);
        const r = await as("t-ann", "POST", `/api/projects/${pid}/requirements/import/preview`, { file: { filename: "bomb.docx", contentBase64: bomb.toString("base64") } });
        expect(r.status).toBe(400);
        expect(r.body.error ?? r.body.message ?? r.text).toMatch(/unpacks to more than/);
        expect((await as("t-ann", "GET", `/api/projects/${pid}/requirements`)).status).toBe(200);
    });
});

describe("4 and 5. runner tokens", () => {
    it("a removed runner's open poll receives nothing more", async () => {
        const pid = await newProject("t-ann", "Runner shop");
        const svc = getAgentServices(platform);
        const ann = await personOf("t-ann");
        const { record } = svc.store.createPersonalToken({ ownerId: ann, label: "r", createdBy: "test" });
        const caps = { os: "linux", arch: "x64", node: "24", browsers: ["chromium"], record: false } as never;
        const agent = svc.store.upsertAgent(record, { name: "m", version: "1", capabilities: caps, concurrency: 5 });
        const task = (n: number) => {
            const offer = TaskOffer.parse({ taskId: `11111111-1111-4111-8111-11111111111${n}`, jobId: `22222222-2222-4222-8222-22222222222${n}`, adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [], env: { baseUrl: "http://x.example", headless: true, credentials: { username: "u", password: "project-secret" } } });
            svc.store.enqueue({ id: offer.taskId, projectId: pid, jobId: offer.jobId, adapterId: "playwright", payloadEnc: svc.encrypt(offer), files: [], ownerId: ann });
        };
        task(1);
        // Before retiring, the runner is offered work: what follows is the retirement, not something else.
        expect(svc.offerTo(svc.store.getAgent(agent.id)!, 1)?.env.credentials).toBeDefined();
        task(2);
        expect((await as("t-ann", "POST", "/api/me/runner/retire", {})).status).toBe(200);
        // What the open poll's loop asks on its next turn: it does not authenticate again.
        expect(svc.store.getAgent(agent.id)).toBeUndefined();
        expect(svc.offerTo(agent, 1)).toBeUndefined();
        expect(svc.store.claimFor("11111111-1111-4111-8111-111111111112", agent, 60_000)).toBeUndefined();
        expect(svc.store.tokenLive(record.id)).toBe(false);
    });

    it("a project's runner tokens and kits can no longer be made, by anyone (round 45: one runner per person, from Settings)", async () => {
        const pid = await newProject("t-ann", "Tester shop");
        expect((await as("t-ann", "POST", `/api/projects/${pid}/agent-tokens`, { label: "ours" })).status).toBe(404);
        expect((await as("t-ann", "POST", `/api/projects/${pid}/runner-kits`, { name: "ours", platform: "unix" })).status).toBe(404);
    });
});

describe("6. AI configurations across organisations", () => {
    it("staff limited to some projects manage only those projects' organisations, and none of the platform's", async () => {
        const pid = await newProject("t-ann", "Org A shop");
        await as("t-sue", "GET", "/api/auth/state");
        control().set(await personOf("t-sue"), { mode: "only", projects: [{ projectId: pid, role: "owner" }] });
        const body = { label: "k", provider: "openai", model: "gpt-x", apiKey: "sk-staff-key-12345678" };
        expect((await as("t-sue", "POST", "/api/ai-configurations", { ...body, owner: "organization", organizationId: "org-b" })).status).toBe(403);
        expect((await as("t-sue", "POST", "/api/ai-configurations", { ...body, owner: "platform" })).status).toBe(403);
        expect((await as("t-sue", "POST", "/api/ai-configurations", { ...body, owner: "organization", organizationId: "org-a" })).status).toBe(201);
    });
});

describe("7. deleting a project", () => {
    it("needs permission to delete tests", async () => {
        const pid = await newProject("t-dan", "Delete shop");
        expect((await as("t-dan", "POST", `/api/projects/${pid}/archive`, {})).status).toBe(200);
        const refused = await as("t-dan", "DELETE", `/api/projects/${pid}`, { name: "Delete shop" });
        expect(refused.status).toBe(403);
        expect(refused.text).toMatch(/delete tests/);
        await addMember(pid, "t-ann", true);
        expect((await as("t-ann", "DELETE", `/api/projects/${pid}`, { name: "Delete shop" })).status).toBe(200);
    });
});

describe("8. caps", () => {
    it("folders, AI configurations and comments stop at their limit with a plain 409", async () => {
        const pid = await newProject("t-zed", "Capped shop");

        const folders = new FolderStore(platform.db);
        for (let i = 0; i < 200; i++) folders.create({ organizationId: "org-z", name: `f${i}`, createdBy: "test" });
        const f = await as("t-zed", "POST", "/api/folders", { name: "one more" });
        expect(f.status).toBe(409);
        expect(f.text).toMatch(/200 folders/);

        const configs = aiConfigStore({ sql: platform.sql, config: platform.config });
        for (let i = 0; i < 20; i++) await configs.create({ label: `c${i}`, provider: "openai", model: "m", apiKey: "sk-cap-key-12345678", ownerKind: "organization", organizationId: "org-z", baseUrl: null, fastModel: null, createdBy: "test" } as never);
        const c = await as("t-zed", "POST", `/api/projects/${pid}/ai/configurations`, { label: "one more", provider: "openai", model: "m", apiKey: "sk-cap-key-12345678" });
        expect(c.status).toBe(409);
        expect(c.text).toMatch(/20 AI configurations/);

        platform.repo.createApplication(pid, "http://127.0.0.1:9/", {});
        const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Capped test", kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] });
        const tid = platform.repo.insertTest({ projectId: pid, suiteId: platform.repo.getOrCreateSuite(pid, "Smoke", "smoke"), jobId: null, spec, framework: "playwright", validationStatus: "PENDING", versionSource: "ai" });
        expect((await as("t-zed", "GET", `/api/tests/${tid}/review`)).status).toBe(200);
        const reviews = new ReviewStore(platform.db);
        const v = reviews.list(tid)[0]!;
        for (let i = reviews.commentCount(v.id); i < 500; i++) reviews.addComment(v.id, "comment", `c${i}`, SYSTEM_ACTOR);
        const m = await as("t-zed", "POST", `/api/tests/${tid}/review/${v.version}/comments`, { body: "one more" });
        expect(m.status).toBe(409);
        expect(m.text).toMatch(/500 comments/);
    });

    it("polling sweeps expired leases at most every few seconds, not on every turn", async () => {
        const pid = await newProject("t-ann", "Sweep shop");
        const svc = getAgentServices(platform);
        const { record } = svc.store.createPersonalToken({ ownerId: await personOf("t-ann"), label: "sweeper", createdBy: "test" });
        const agent = svc.store.upsertAgent(record, { name: "s", version: "1", capabilities: { os: "linux", arch: "x64", node: "24", browsers: ["chromium"], record: false } as never, concurrency: 1 });
        const sweep = vi.spyOn(svc.store, "sweep");
        for (let i = 0; i < 8; i++) svc.offerTo(svc.store.getAgent(agent.id)!, 1);
        expect(sweep.mock.calls.length).toBeLessThanOrEqual(1);
    });
});
