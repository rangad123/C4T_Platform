/**
 * Live event streaming against a REAL platform on real HTTP: stream tickets, resume with Last-Event-ID, caps, slow clients, nothing
 * left running after a stream closes, a real validation job streamed from start to end, a worker in a SEPARATE PROCESS
 * (the API in another process too, so its request log can be inspected), a runner agent's heartbeat lines, and secrets.
 *
 * Browser-free: the validation jobs run API tests (Playwright without a browser) against a small local fixture.
 * Ports: platform 5970, fixture application 5971, API child process 5972.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { eventBus } from "../src/platform/event-bus.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getStreamHub } from "../src/platform/routes/stream.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { defaultCaps, FakeAgent, passedRun, viaFetch } from "./fixtures/fake-agent.js";
import { requestedUrls, SseClient } from "./fixtures/sse-client.js";

const PORT = 5970;
const APP_PORT = 5971;
const CHILD_PORT = 5972;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "al-admin-key-7e3d91c4";
const PASSWORD = "ALLEAK-Password-4d8b13";
const API_TOKEN = "ALLEAK-ApiToken-92c7e5";
const STREAM_ENV: Record<string, string> = {
    // Rounds are slow on purpose (2 s): anything faster than that is the in-process bell, not polling.
    STREAM_POLL_MS: "2000",
    STREAM_MAX_POLL_MS: "2000",
    STREAM_HEARTBEAT_MS: "1500",
    STREAM_MAX_STREAMS: "6",
    STREAM_MAX_PER_JOB: "3",
    STREAM_MAX_BUFFER_BYTES: "65536",
    STREAM_DRAIN_TIMEOUT_MS: "1000",
    STREAM_TICKET_TTL_MS: "1500",
};
const ENV_KEYS = [...Object.keys(STREAM_ENV), "AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let appServer: http.Server;
const clients: SseClient[] = [];
let busBaseline = 0;

const hub = () => getStreamHub(platform)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const call = async (port: number, method: string, url: string, body?: unknown, headers: Record<string, string> = { "x-api-key": API_KEY }) => {
    requestedUrls.push(url);
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const admin = (method: string, url: string, body?: unknown) => call(PORT, method, url, body);

const ticketFor = async (path: string, port = PORT): Promise<string> => {
    const r = await call(port, "POST", "/api/stream-tickets", { path });
    expect(r.status, r.text).toBe(201);
    return r.body.ticket;
};
const openWithTicket = async (path: string, headers: Record<string, string> = {}, port = PORT): Promise<SseClient> => {
    const ticket = await ticketFor(path, port);
    const c = await SseClient.open(port, `${path}?ticket=${ticket}`, headers);
    clients.push(c);
    return c;
};
const jobStream = (jobId: string) => `/api/test-generation/${jobId}/stream`;

const newProject = async (name: string) => (await admin("POST", "/api/projects", { name })).body.id as string;
const newJob = async (projectId: string, status?: "FAILED") => {
    const appId = platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, undefined);
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
    if (status) platform.repo.setJobStatus(job.id, status, "done");
    return job.id;
};
const ev = (jobId: string, message: string, level: "info" | "warn" | "error" = "info") => platform.repo.addEvent(jobId, { stage: "validation", kind: "note", level, message });
const dbEvents = (jobId: string) => platform.repo.listEvents(jobId, 0, 100_000) as Array<{ id: number; message: string; level: string }>;
const finishJob = (jobId: string) => platform.repo.setJobStatus(jobId, "COMPLETED");

/** Streams are closed by the server shortly after the client goes; wait for the hub to say so. */
async function settled(): Promise<void> {
    for (let i = 0; i < 80; i++) {
        const s = hub().stats();
        if (s.open === 0 && s.timers === 0 && s.busListeners === busBaseline) return;
        await sleep(50);
    }
    throw new Error(`streams were not released: ${JSON.stringify(hub().stats())}`);
}

beforeAll(async () => {
    Object.assign(process.env, STREAM_ENV, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = http.createServer((req, res) => {
        res.writeHead(req.url === "/broken" ? 500 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-stream-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    busBaseline = eventBus.listenerCount();
}, 60_000);

afterEach(async () => {
    for (const c of clients.splice(0)) c.abort();
    await settled();
});

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    for (const p of children) killTree(p);
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const d of extraDirs) fs.rmSync(d, { recursive: true, force: true });
});

const children: ChildProcess[] = [];
const extraDirs: string[] = [];
/** Stops exactly the processes this file started (and what they started), by process id. */
function killTree(p: ChildProcess): void {
    if (!p.pid || p.exitCode !== null) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else p.kill("SIGKILL");
}

describe("stream tickets: the API key never travels in an address", () => {
    let jobId: string;
    beforeAll(async () => {
        jobId = await newJob(await newProject("Tickets"));
    });

    it("a stream needs the key or a ticket, and a ticket is only made with the key", async () => {
        const none = await SseClient.open(PORT, jobStream(jobId));
        expect(none.status).toBe(401);
        const wrong = await SseClient.open(PORT, `${jobStream(jobId)}?ticket=st_madeup`);
        expect(wrong.status).toBe(401);
        const noKey = await call(PORT, "POST", "/api/stream-tickets", { path: jobStream(jobId) }, {});
        expect(noKey.status).toBe(401);
        // the key as a query parameter is not accepted on a stream (only artifact links have that precedent)
        const asQuery = await SseClient.open(PORT, `${jobStream(jobId)}?key=${API_KEY}`);
        expect(asQuery.status).toBe(401);
        requestedUrls.pop(); // the one deliberate bad address of this file; the check at the end is about addresses the page would use
    });

    it("asks for a path that is really a stream of something that exists", async () => {
        expect((await admin("POST", "/api/stream-tickets", { path: "/api/projects" })).status).toBe(400);
        expect((await admin("POST", "/api/stream-tickets", { path: "/api/test-generation/../x/stream" })).status).toBe(400);
        expect((await admin("POST", "/api/stream-tickets", { path: `${jobStream(jobId)}?x=1` })).status).toBe(400);
        expect((await admin("POST", "/api/stream-tickets", {})).status).toBe(400);
        const missing = await admin("POST", "/api/stream-tickets", { path: "/api/test-generation/nope/stream" });
        expect(missing.status).toBe(404);
        const ok = await admin("POST", "/api/stream-tickets", { path: jobStream(jobId) });
        expect(ok.status).toBe(201);
        expect(ok.body.ticket).toMatch(/^st_[A-Za-z0-9_-]{32}$/);
        expect(ok.body.expiresInSeconds).toBe(2);
        expect(ok.text).not.toContain(API_KEY);
    });

    it("opens one stream, once", async () => {
        const ticket = await ticketFor(jobStream(jobId));
        const first = await SseClient.open(PORT, `${jobStream(jobId)}?ticket=${ticket}`);
        clients.push(first);
        expect(first.status).toBe(200);
        expect(first.headers["content-type"]).toMatch(/^text\/event-stream/);
        expect(first.headers["cache-control"]).toMatch(/no-cache/);
        await first.waitFor((c) => c.frames.some((f) => f.event === "job"));
        const again = await SseClient.open(PORT, `${jobStream(jobId)}?ticket=${ticket}`);
        expect(again.status).toBe(401);
        expect(JSON.parse(again.body).error).toMatch(/already used or has expired/);
    });

    it("is refused for another stream, and is then spent", async () => {
        const other = await newJob(await newProject("Other"));
        const ticket = await ticketFor(jobStream(jobId));
        expect((await SseClient.open(PORT, `${jobStream(other)}?ticket=${ticket}`)).status).toBe(401);
        expect((await SseClient.open(PORT, `${jobStream(jobId)}?ticket=${ticket}`)).status).toBe(401);
        // a project ticket does not open a job stream either
        const projectTicket = await ticketFor(`/api/projects/${platform.repo.getJob(jobId)!.projectId}/stream`);
        expect((await SseClient.open(PORT, `${jobStream(jobId)}?ticket=${projectTicket}`)).status).toBe(401);
    });

    it("expires", async () => {
        const ticket = await ticketFor(jobStream(jobId));
        await sleep(1700);
        expect((await SseClient.open(PORT, `${jobStream(jobId)}?ticket=${ticket}`)).status).toBe(401);
        expect(hub().stats().tickets).toBe(0);
    });

    it("scripts can still use the key in the header", async () => {
        const c = await SseClient.open(PORT, jobStream(jobId), { "x-api-key": API_KEY });
        clients.push(c);
        expect(c.status).toBe(200);
        await c.waitFor((x) => x.frames.length > 0);
    });
});

describe("what a stream carries", () => {
    it("sends the job, then each event as it is written (at once, not at the next poll), then the end, then closes", async () => {
        const jobId = await newJob(await newProject("Basic"));
        ev(jobId, "first");
        const c = await openWithTicket(jobStream(jobId));
        await c.waitFor((x) => x.logs().length === 1);
        expect(c.frames.map((f) => f.event)).toEqual(["job", "log"]);
        expect(c.frames[0]!.id).toBeUndefined(); // a snapshot must not move the resume position
        expect(c.frames[0]!.data).toMatchObject({ jobId, status: "QUEUED" });
        // rounds are 2 s apart in this file: arriving sooner proves the in-process bell woke the stream
        const t0 = Date.now();
        ev(jobId, "second");
        await c.waitFor((x) => x.logs().length === 2);
        expect(Date.now() - t0).toBeLessThan(1200);
        ev(jobId, "third", "warn");
        finishJob(jobId);
        await c.untilClosed();
        const rows = dbEvents(jobId);
        expect(c.logIds()).toEqual(rows.map((r) => r.id));
        expect(c.logs().map((l) => l.message)).toEqual(["first", "second", "third"]);
        expect(c.logs()[2]!.level).toBe("warn");
        expect(c.frames.at(-1)!.event).toBe("end");
        expect(c.frames.at(-1)!.data).toEqual({ status: "COMPLETED" });
        expect(c.frames.at(-2)!.event).toBe("job");
        expect(c.frames.at(-2)!.data.status).toBe("COMPLETED");
        // a log frame says only what the page needs
        expect(Object.keys(c.logs()[0]!).sort()).toEqual(["at", "id", "jobId", "kind", "level", "message", "stage"]);
        // each log frame's id is the event's id
        for (const f of c.frames.filter((x) => x.event === "log")) expect(f.id).toBe(String(f.data.id));
    });

    it("a finished job replays its events and ends at once", async () => {
        const jobId = await newJob(await newProject("Done"));
        for (let i = 1; i <= 4; i++) ev(jobId, `m${i}`);
        finishJob(jobId);
        const c = await openWithTicket(jobStream(jobId));
        await c.untilClosed();
        expect(c.frames.map((f) => f.event)).toEqual(["job", "log", "log", "log", "log", "end"]);
        expect(c.logIds()).toEqual(dbEvents(jobId).map((r) => r.id));
    });

    it("an unknown run or project is a plain 404", async () => {
        const gone = await call(PORT, "GET", "/api/test-generation/nope/stream");
        expect(gone.status).toBe(404);
        expect(gone.body.error).toBe("Job not found");
        expect((await call(PORT, "GET", "/api/projects/nope/stream")).status).toBe(404);
    });

    it("masks the API key if one ever reached an event, and keeps the text of other events as they are", async () => {
        const jobId = await newJob(await newProject("Mask"));
        ev(jobId, `oops ${API_KEY} leaked`);
        ev(jobId, "fine <b>text</b> & more");
        finishJob(jobId);
        const c = await openWithTicket(jobStream(jobId));
        await c.untilClosed();
        expect(c.text).not.toContain(API_KEY);
        expect(c.logs().map((l) => l.message)).toEqual(["oops [hidden] leaked", "fine <b>text</b> & more"]);
    });

    it("sends a keep-alive comment when nothing happens", async () => {
        const jobId = await newJob(await newProject("Quiet"));
        const c = await openWithTicket(jobStream(jobId));
        await c.waitFor((x) => x.comments.filter((t) => t === "keep-alive").length >= 1, 8_000, "a keep-alive comment");
        expect(c.comments[0]).toBe("live");
    });

    it("a new viewer sees the 500 most recent events and is told how many older ones there are", async () => {
        const jobId = await newJob(await newProject("Many"));
        for (let i = 1; i <= 520; i++) ev(jobId, `event ${i}`);
        finishJob(jobId);
        const rows = dbEvents(jobId);
        const c = await openWithTicket(jobStream(jobId));
        await c.untilClosed();
        expect(c.logIds()).toEqual(rows.slice(20).map((r) => r.id));
        expect(c.frames[0]!.data.earlierEvents).toBe(20);
        // a reconnect with a position gets every missed event, however many
        const all = await openWithTicket(jobStream(jobId), { "last-event-id": "0" });
        await all.untilClosed();
        expect(all.logIds()).toEqual(rows.map((r) => r.id));
        expect(all.frames[0]!.data.earlierEvents).toBeUndefined();
    });
});

describe("reconnecting without gaps or repeats", () => {
    it("resumes exactly after Last-Event-ID, header or query, while the job keeps writing", async () => {
        const jobId = await newJob(await newProject("Resume"));
        for (let i = 1; i <= 10; i++) ev(jobId, `before ${i}`);
        const a = await openWithTicket(jobStream(jobId));
        await a.waitFor((c) => c.logs().length === 10);
        const seen = a.logIds().slice(0, 4);
        const lastSeen = seen.at(-1)!;
        a.abort(); // the tab was closed after the fourth event
        for (let i = 11; i <= 15; i++) ev(jobId, `while away ${i}`);
        const b = await openWithTicket(jobStream(jobId), { "last-event-id": String(lastSeen) });
        await b.waitFor((c) => c.logs().length === 11);
        ev(jobId, "live after resume");
        finishJob(jobId);
        await b.untilClosed();
        const all = dbEvents(jobId).map((r) => r.id);
        expect([...seen, ...b.logIds()]).toEqual(all);
        expect(new Set([...seen, ...b.logIds()]).size).toBe(all.length);
        // the same through the query string (a hand-made reconnect)
        const ticket = await ticketFor(jobStream(jobId));
        const d = await SseClient.open(PORT, `${jobStream(jobId)}?ticket=${ticket}&lastEventId=${all[all.length - 3]}`);
        clients.push(d);
        await d.untilClosed();
        expect(d.logIds()).toEqual(all.slice(-2));
    });

    it("a position past the newest event replays nothing; junk is ignored", async () => {
        const jobId = await newJob(await newProject("Past"), "FAILED");
        ev(jobId, "only");
        const rows = dbEvents(jobId);
        const past = await openWithTicket(jobStream(jobId), { "last-event-id": String(rows[0]!.id + 1000) });
        await past.untilClosed();
        expect(past.logs()).toEqual([]);
        expect(past.frames.map((f) => f.event)).toEqual(["job", "end"]);
        const junk = await openWithTicket(jobStream(jobId), { "last-event-id": "abc" });
        await junk.untilClosed();
        expect(junk.logIds()).toEqual(rows.map((r) => r.id));
    });

    it("many reconnects in a row still deliver every event exactly once", async () => {
        const jobId = await newJob(await newProject("Churn"));
        const got: number[] = [];
        let last = 0;
        for (let round = 0; round < 6; round++) {
            for (let i = 0; i < 5; i++) ev(jobId, `r${round} e${i}`);
            const c = await openWithTicket(jobStream(jobId), last ? { "last-event-id": String(last) } : {});
            await c.waitFor((x) => x.logs().length >= 5, 10_000);
            // take a random-ish prefix, as a tab closed in the middle would
            const take = c.logIds().slice(0, 3 + (round % 3));
            got.push(...take);
            last = take.at(-1)!;
            c.abort();
        }
        finishJob(jobId);
        const tail = await openWithTicket(jobStream(jobId), { "last-event-id": String(last) });
        await tail.untilClosed();
        got.push(...tail.logIds());
        expect(got).toEqual(dbEvents(jobId).map((r) => r.id));
    });
});

describe("a project's stream", () => {
    it("shows what happens from now on in any of its runs, not another project's, and ends when none is active", async () => {
        const projectId = await newProject("Project stream");
        const other = await newProject("Not this one");
        const old = await newJob(projectId, "FAILED");
        ev(old, "history that is not replayed");
        const jobA = await newJob(projectId);
        const jobOther = await newJob(other);
        const c = await openWithTicket(`/api/projects/${projectId}/stream`);
        await c.waitFor((x) => x.frames.some((f) => f.event === "job" && f.data.jobId === jobA));
        ev(jobA, "from the project's run");
        ev(jobOther, "from somebody else's run");
        await c.waitFor((x) => x.logs().length >= 1);
        await sleep(300);
        expect(c.logs().map((l) => [l.jobId, l.message])).toEqual([[jobA, "from the project's run"]]);
        platform.repo.setJobStatus(jobA, "VALIDATING");
        await c.waitFor((x) => x.frames.some((f) => f.event === "job" && f.data.status === "VALIDATING"));
        finishJob(jobA);
        await c.untilClosed();
        expect(c.frames.at(-1)!.event).toBe("end");
        expect(c.frames.at(-1)!.data.status).toBe("idle");
        // resuming a project stream replays what was missed
        const missed = await openWithTicket(`/api/projects/${projectId}/stream`, { "last-event-id": "0" });
        await missed.untilClosed();
        expect(new Set(missed.logs().map((l) => l.jobId))).toEqual(new Set([old, jobA]));
    });
});

describe("limits", () => {
    it("refuses a fourth viewer of one run, and a seventh in the process, with a plain 429; room comes back when one closes", async () => {
        const projectId = await newProject("Caps");
        const a = await newJob(projectId);
        const b = await newJob(projectId);
        const c = await newJob(projectId);
        const mine: SseClient[] = [];
        for (let i = 0; i < 3; i++) mine.push(await openWithTicket(jobStream(a)));
        for (let i = 0; i < 3; i++) mine.push(await openWithTicket(jobStream(b)));
        for (const m of mine) expect(m.status).toBe(200);
        expect(hub().stats().open).toBe(6);
        // the per-run cap and the whole-process cap both answer in plain words
        const fourth = await SseClient.open(PORT, `${jobStream(a)}?ticket=${await ticketFor(jobStream(a))}`);
        expect(fourth.status).toBe(429);
        expect(JSON.parse(fourth.body).error).toMatch(/Too many live views are open/);
        const seventh = await SseClient.open(PORT, `${jobStream(c)}?ticket=${await ticketFor(jobStream(c))}`);
        expect(seventh.status).toBe(429);
        // a refused request holds nothing
        expect(hub().stats().open).toBe(6);
        mine[0]!.abort();
        for (let i = 0; i < 40 && hub().stats().open === 6; i++) await sleep(50);
        const again = await openWithTicket(jobStream(c));
        expect(again.status).toBe(200);
        for (const m of mine) m.abort();
        again.abort();
    });
});

describe("nothing is left running after a stream closes", () => {
    it("releases the stream, its timer and its listener however it ends: the end, the browser, the server stopping", async () => {
        const projectId = await newProject("Leaks");
        const ended = await newJob(projectId);
        const abandoned = await newJob(projectId);
        const stopped = await newJob(projectId);
        const before = hub().stats();
        expect(before).toMatchObject({ open: 0, timers: 0, busListeners: busBaseline });

        const e = await openWithTicket(jobStream(ended));
        const a1 = await openWithTicket(jobStream(abandoned));
        const a2 = await openWithTicket(jobStream(abandoned));
        const s = await openWithTicket(jobStream(stopped));
        await Promise.all([e, a1, a2, s].map((c) => c.waitFor((x) => x.frames.length > 0)));
        const during = hub().stats();
        expect(during.open).toBe(4);
        expect(during.busListeners).toBe(busBaseline + 4);
        expect(during.timers).toBe(4); // one pending timer per stream, no more

        finishJob(ended); // ends by itself
        a1.abort(); // a closed tab
        a2.abort();
        await e.untilClosed();
        await settled().catch(() => undefined);
        expect(hub().stats().open).toBe(1);
        hub().closeAll(); // the server stopping
        await s.untilClosed();
        await settled();
        expect(hub().stats()).toMatchObject({ open: 0, timers: 0, busListeners: busBaseline });
        expect(e.last("end")).toBeTruthy();
        expect(s.last("end")).toBeUndefined(); // a stopped server is a disconnect: the browser reconnects and resumes
    });

    it("drops a client that cannot keep up, frees everything, and the same client resumes with nothing lost", async () => {
        const jobId = await newJob(await newProject("Slow"));
        const chunk = "x".repeat(950);
        for (let i = 0; i < 9000; i++) ev(jobId, `${i} ${chunk}`);
        const total = dbEvents(jobId).length;
        const other = await newJob(await newProject("Healthy"));
        const healthy = await openWithTicket(jobStream(other));

        const slow = await openWithTicket(jobStream(jobId), { "last-event-id": "0" });
        slow.pause(); // it connects and then reads nothing
        await slow.waitFor((c) => c.status === 200);
        for (let i = 0; i < 160 && hub().stats().open > 1; i++) await sleep(100);
        expect(hub().stats().open).toBe(1); // the slow one was dropped, the healthy one is still there
        ev(other, "healthy viewers are not affected");
        await healthy.waitFor((c) => c.logs().length === 1);
        slow.resume();
        await slow.untilClosed();
        const got = slow.logIds();
        expect(got.length).toBeLessThan(total);
        // resume from the last event it did receive
        const rest = await openWithTicket(jobStream(jobId), { "last-event-id": String(got.at(-1) ?? 0) });
        finishJob(jobId);
        await rest.untilClosed(60_000);
        const merged = [...got, ...rest.logIds()];
        expect(merged).toEqual(dbEvents(jobId).map((r) => r.id));
        expect(merged).toHaveLength(total);
    }, 120_000);
});

/** Imports API tests against the fixture and returns their ids. */
async function importTests(call_: typeof admin, projectId: string, titles: Array<[string, string, number]>): Promise<string[]> {
    const imp = await call_("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: APP,
        validate: false,
        credentials: { username: "demo@example.com", password: PASSWORD, apiToken: API_TOKEN },
        specs: titles.map(([title, p, status]) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: status }] })),
    });
    expect(imp.status, imp.text).toBe(202);
    return (imp.body.tests as Array<{ id: string }>).map((t) => t.id);
}

describe("a real validation job, from start to end", () => {
    it("streams the job, its events in order with no gap or repeat, and the end, with no secret in any of it", async () => {
        const projectId = await newProject("Real run");
        const [t1] = await importTests(admin, projectId, [["Health answers", "/health", 200]]);
        const started = await admin("POST", `/api/tests/${t1}/validate`);
        expect(started.status, started.text).toBe(202);
        const jobId = started.body.jobId as string;
        // the job exists and has not been picked up yet: the viewer is already watching when the work starts
        const c = await openWithTicket(jobStream(jobId));
        await c.waitFor((x) => x.frames.some((f) => f.event === "job"));
        const worker = new Worker(platform, 100);
        worker.start();
        try {
            await c.untilClosed(120_000);
        } finally {
            await worker.stop();
        }
        const rows = dbEvents(jobId);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(c.logIds()).toEqual(rows.map((r) => r.id));
        expect(c.frames.at(-1)!.event).toBe("end");
        const finalJob = c.frames.filter((f) => f.event === "job").at(-1)!.data;
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(finalJob.status);
        expect(finalJob.status).toBe(c.frames.at(-1)!.data.status);
        // the phases moved while we watched (more than one snapshot), and ids only ever go up
        expect(c.frames.filter((f) => f.event === "job").length).toBeGreaterThanOrEqual(2);
        const ids = c.logIds();
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        // the polling fallback reads the same events
        const polled = (await admin("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ id: number }>;
        expect(polled.map((p) => p.id)).toEqual(c.logIds());
        // no secret in anything the stream wrote
        for (const secret of [PASSWORD, API_TOKEN, API_KEY]) expect(c.text).not.toContain(secret);
        expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    }, 150_000);
});

describe("a runner agent's progress", () => {
    it("appears as events as the heartbeat arrives, named after the agent, with credentials scrubbed", async () => {
        const projectId = await newProject("Agent progress");
        const made = await admin("POST", `/api/projects/${projectId}/agent-tokens`, { label: "maya" });
        const agent = new FakeAgent(viaFetch(`http://127.0.0.1:${PORT}`), made.body.secret, { name: "Maya’s laptop", capabilities: defaultCaps(), concurrency: 1 });
        expect((await agent.hello()).status).toBe(200);
        const [t1] = await importTests(admin, projectId, [["Health answers", "/health", 200]]);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        const started = await admin("POST", `/api/tests/${t1}/validate`);
        expect(started.status, started.text).toBe(202);
        const jobId = started.body.jobId as string;
        const c = await openWithTicket(jobStream(jobId));
        const worker = new Worker(platform, 100);
        worker.start();
        let beatAt = 0;
        let arrivedAt = 0;
        try {
            const offer = await agent.next(20_000);
            expect(offer).toBeTruthy();
            await c.waitFor((x) => x.logs().some((l) => l.kind === "agent_task_started"));
            beatAt = Date.now();
            const r = await agent.heartbeat(offer!.taskId, { done: 0, total: 1, log: ["Downloading 2 baseline images", `Signed in as demo with ${PASSWORD}`, `Finished 1 of 3 tests: login works (passed)`] });
            expect(r.status).toBe(200);
            await c.waitFor((x) => x.logs().some((l) => l.message.includes("Finished 1 of 3 tests")));
            arrivedAt = Date.now();
            await agent.answer(offer!, { runs: [passedRun(offer!.scripts[0]!.testId)] });
            await c.untilClosed(60_000);
        } finally {
            await worker.stop();
        }
        // rounds are 2 s apart here, so arriving this fast means the heartbeat woke the stream
        expect(arrivedAt - beatAt).toBeLessThan(1200);
        const lines = c.logs().filter((l) => l.kind === "agent_progress").map((l) => l.message);
        expect(lines).toEqual(["Maya’s laptop: Downloading 2 baseline images", "Maya’s laptop: Signed in as demo with [hidden]", "Maya’s laptop: Finished 1 of 3 tests: login works (passed)"]);
        expect(c.logIds()).toEqual(dbEvents(jobId).map((r) => r.id));
        expect(c.text).not.toContain(PASSWORD);
        expect(JSON.stringify(dbEvents(jobId))).not.toContain(PASSWORD);
    }, 120_000);
});

describe("a worker in a separate process, and the API's request log", () => {
    let apiLog = "";
    const spawnTs = (script: string, env: Record<string, string>): ChildProcess => {
        const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("STREAM_") && !k.startsWith("VITEST")));
        const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: REPO_ROOT, env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        children.push(child);
        return child;
    };

    it("streams events written by another process, to the end", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-stream-sep-"));
        extraDirs.push(dir);
        const shared = { DATA_DIR: dir, API_KEY, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "", LLM_API_KEY: "", SCHEDULER_ENABLED: "false", MAX_REPAIR_ATTEMPTS: "0" };
        // the API process, without a worker of its own; debug level so every request is written to its log
        const api = spawnTs("src/main.ts", { ...shared, PORT: String(CHILD_PORT), HOST: "127.0.0.1", WORKER_EMBEDDED: "false", LOG_LEVEL: "debug" });
        api.stdout!.on("data", (d) => (apiLog += d));
        api.stderr!.on("data", (d) => (apiLog += d));
        // Up to 90 s: a cold tsx start of the whole platform on a busy machine (the release run) has taken more than 30 s.
        for (let i = 0; i < 900 && !apiLog.includes("listening on"); i++) {
            if (api.exitCode !== null) throw new Error(`the API process exited early: ${apiLog.slice(-800)}`);
            await sleep(100);
        }
        expect(apiLog).toContain("listening on");

        const child = (method: string, url: string, body?: unknown) => call(CHILD_PORT, method, url, body);
        const projectId = (await child("POST", "/api/projects", { name: "Separate worker" })).body.id as string;
        const [t1] = await importTests(child, projectId, [["Health answers", "/health", 200]]);
        const started = await child("POST", `/api/tests/${t1}/validate`);
        expect(started.status, started.text).toBe(202);
        const jobId = started.body.jobId as string;
        const c = await openWithTicket(jobStream(jobId), {}, CHILD_PORT);
        await c.waitFor((x) => x.frames.some((f) => f.event === "job" && f.data.status === "QUEUED"));

        // the worker is another process: its writes reach this one only through the database file
        const worker = spawnTs("src/worker-main.ts", { ...shared, WORKER_POLL_MS: "100" });
        let workerLog = "";
        worker.stdout!.on("data", (d) => (workerLog += d));
        worker.stderr!.on("data", (d) => (workerLog += d));
        await c.untilClosed(150_000);
        expect(workerLog).toContain("standalone worker started");

        expect(c.frames.at(-1)!.event).toBe("end");
        const polled = (await child("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ id: number; message: string }>;
        expect(polled.length).toBeGreaterThanOrEqual(1);
        expect(c.logIds()).toEqual(polled.map((p) => p.id));
        expect(c.logs().map((l) => l.message)).toEqual(polled.map((p) => p.message));
        const states = c.frames.filter((f) => f.event === "job").map((f) => f.data.status);
        expect(states[0]).toBe("QUEUED");
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(states.at(-1));
        expect(c.text).not.toContain(PASSWORD);
        expect(c.text).not.toContain(API_TOKEN);

        // the API's own log: it recorded the stream requests, and neither the key nor a ticket is in it
        expect(apiLog).toContain("/stream?ticket=[hidden]");
        expect(apiLog).not.toContain(API_KEY);
        const tickets = requestedUrls.filter((u) => u.includes("ticket=")).map((u) => /ticket=(st_[\w-]+)/.exec(u)?.[1]).filter(Boolean) as string[];
        expect(tickets.length).toBeGreaterThan(0);
        for (const t of tickets) expect(apiLog).not.toContain(t);
        expect(apiLog).not.toContain(PASSWORD);
        killTree(worker);
        killTree(api);
    }, 240_000);
});

describe("secrets and addresses", () => {
    it("the API key is in no address any client asked for", () => {
        expect(requestedUrls.length).toBeGreaterThan(20);
        for (const u of requestedUrls) expect(u).not.toContain(API_KEY);
        expect(requestedUrls.some((u) => u.includes("ticket=st_"))).toBe(true);
    });
});
