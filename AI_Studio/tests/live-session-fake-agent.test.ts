/**
 * Driving a recording step by step on a runner agent, platform side, against a real platform on real HTTP and a FAKE AGENT written in the test (plain fetch,
 * no browser): the commands that travel in heartbeat replies, the answers that come back as pushes, an agent that is too old, one that never answers,
 * one that sends rubbish, secrets, and the audit row. Browser-free. Ports: platform 6171.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecordCommand, TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { TOO_OLD_TO_DRIVE } from "../src/platform/agent-record.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { recorderOptions } from "../src/platform/routes/recorder.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";

const PORT = 6171;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = "http://localhost:6172";
const API_KEY = "live-agent-admin-key-81c4";
const PASSWORD = "LIVEAGENT-Password-77d1e0";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
const answers: string[] = [];

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    answers.push(text);
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 10_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v as T;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(40);
    }
};

const gotoStep = () => ({ index: 0, kind: "goto", url: `${APP}/login`, describe: "Open the page", at: "2026-10-11T10:00:00.000Z" });
const state = (agent: FakeAgent, taskId: string, over: Record<string, unknown> = {}) => agent.recording(taskId, { status: "recording", currentUrl: `${APP}/login`, steps: [gotoStep()], ...over });
const snap = (over: Record<string, unknown> = {}) => ({ url: `${APP}/login`, title: "Log in", text: "Log in", elements: [{ index: 0, tag: "button", role: "button", name: "Sign in", locator: { strategy: "role", value: "button", name: "Sign in", exact: true }, matches: 1, visible: true, enabled: true }], ...over });

/** The agent waits for its next live command and answers it. */
async function answerNext(agent: FakeAgent, taskId: string, reply: (c: Extract<RecordCommand, { type: "act" | "snapshot" }>) => Record<string, unknown>): Promise<Extract<RecordCommand, { type: "act" | "snapshot" }>> {
    const cmd = await until(async () => {
        const hb = await agent.heartbeat(taskId, {});
        return (hb.json?.commands as RecordCommand[] | undefined)?.find((c): c is Extract<RecordCommand, { type: "act" | "snapshot" }> => c.type === "act" || c.type === "snapshot");
    }, "a live command");
    const r = await state(agent, taskId, { acked: [cmd.id], results: [{ id: cmd.id, ...reply(cmd) }] });
    expect(r.status, r.text).toBe(200);
    return cmd;
}

async function newProject(name: string) {
    const id = (await admin("POST", "/api/projects", { name })).body.id as string;
    platform.repo.createApplication(id, APP, { ...DEFAULT_JOB_OPTIONS }, { username: "tester@example.test", password: PASSWORD });
    return id;
}
async function connect(projectId: string, name: string, caps = defaultCaps({ record: true, recordHeaded: true, liveSession: true })) {
    void projectId;
    const secret = personalRunner(platform, { label: name }).secret;
    const agent = new FakeAgent(viaFetch(BASE), secret, { name, capabilities: caps });
    expect((await agent.hello()).status).toBe(200);
    return agent;
}
async function session(projectId: string, agent: FakeAgent) {
    const r = await admin("POST", `/api/projects/${projectId}/recordings`, { url: `${APP}/login`, on: "agent", agentId: agent.agentId, headed: false });
    expect(r.status, r.text).toBe(201);
    const offer = (await agent.next(10_000)) as TaskOffer;
    expect((await state(agent, offer.taskId)).status).toBe(200);
    await until(async () => (await admin("GET", `/api/recordings/${r.body.id}`)).body.status === "recording", "the recording");
    return { rid: r.body.id as string, taskId: offer.taskId };
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "50" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    Object.assign(recorderOptions, { remote: { lostContactMs: 20_000, claimWaitMs: 5_000, settleMs: 500, liveWaitMs: 1_500 } });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-liveagent-"));
    // No API_KEY: the server is open and acts as one person, whose runners these are (round 45).
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
    delete recorderOptions.remote;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("an agent that does not know how to be driven", () => {
    it("is told nothing, and the person gets the plain sentence", async () => {
        const projectId = await newProject("Old agent");
        const old = await connect(projectId, "Old agent", defaultCaps({ record: true, recordHeaded: true }));
        const { rid, taskId } = await session(projectId, old);
        const act = await admin("POST", `/api/recordings/${rid}/act`, { action: "scroll" });
        expect(act.status).toBe(422);
        expect(act.body.error).toBe(TOO_OLD_TO_DRIVE);
        const snapshot = await admin("GET", `/api/recordings/${rid}/snapshot`);
        expect(snapshot.status).toBe(422);
        expect(snapshot.body.error).toBe(TOO_OLD_TO_DRIVE);
        const hb = await old.heartbeat(taskId, {});
        expect(hb.json.commands ?? []).toEqual([]);
        // the recording itself carries on as before
        expect((await admin("GET", `/api/recordings/${rid}`)).body.status).toBe("recording");
        await admin("DELETE", `/api/recordings/${rid}`);
    });
});

describe("an agent that can be driven", () => {
    let projectId: string;
    let agent: FakeAgent;
    let rid = "";
    let taskId = "";

    it("sends an action as a command and returns the agent's answer: the step, the page, and no stored secret", async () => {
        projectId = await newProject("Driven");
        agent = await connect(projectId, "Maya's laptop");
        ({ rid, taskId } = await session(projectId, agent));
        const pending = admin("POST", `/api/recordings/${rid}/act`, { action: "fill", locator: { strategy: "label", value: "Password", exact: true }, value: "{{credentials.password}}", image: true });
        const cmd = await answerNext(agent, taskId, () => ({
            ok: true,
            recorded: true,
            step: { index: 1, kind: "fill", locator: { strategy: "label", value: "Password" }, value: PASSWORD, secret: true, describe: `Type ${PASSWORD}`, at: "2026-10-11T10:00:01.000Z" },
            snapshot: snap({ text: `Your password ${PASSWORD} is shown` }),
        }));
        // the command carried the stand-in's value to the agent (over its own authenticated link) and asked for a picture
        expect(cmd).toMatchObject({ type: "act", action: { action: "fill", value: "{{credentials.password}}" }, secret: PASSWORD, image: true });
        const r = await pending;
        expect(r.status, r.text).toBe(200);
        expect(r.body).toMatchObject({ recorded: true, step: { kind: "fill", secret: true, value: "{{credentials.password}}" } });
        expect(r.text).not.toContain(PASSWORD);
        expect(r.body.snapshot.text).toBe("Your password [hidden] is shown");
        // the command was confirmed and is not sent again
        expect(((await agent.heartbeat(taskId, {})).json.commands ?? []).filter((c: RecordCommand) => c.type === "act")).toEqual([]);
    });

    it("passes an agent's refusal on with its status and plain words", async () => {
        const pending = admin("POST", `/api/recordings/${rid}/act`, { action: "fill", locator: { strategy: "label", value: "Password", exact: true }, value: "hunter2" });
        const cmd = await answerNext(agent, taskId, () => ({ ok: false, status: 422, error: "This field holds a password, so it can only be filled with {{credentials.password}}." }));
        expect(cmd.type === "act" && cmd.secret).toBeFalsy(); // a real value is not a stand-in: nothing was looked up
        const r = await pending;
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/only be filled with/);
    });

    it("looks at the page: one command, the picture cleaned, and a second look within a second is served from the first", async () => {
        const first = admin("GET", `/api/recordings/${rid}/snapshot?image=1`);
        const png = Buffer.alloc(300, 7).toString("base64");
        const cmd = await answerNext(agent, taskId, () => ({ ok: true, snapshot: snap({ image: png, imageType: "image/png", text: "Log\u0000 in" }) }));
        expect(cmd).toMatchObject({ type: "snapshot", image: true });
        const r = await first;
        expect(r.status, r.text).toBe(200);
        expect(r.body).toMatchObject({ title: "Log in", text: "Log in", image: png, imageType: "image/png" });
        const again = await admin("GET", `/api/recordings/${rid}/snapshot?image=1`);
        expect(again.body.image).toBe(png);
        expect(((await agent.heartbeat(taskId, {})).json.commands ?? []).filter((c: RecordCommand) => c.type === "snapshot")).toEqual([]);
    });

    it("cleans what a careless agent sends: a secret field is hidden, a bad picture is dropped, control characters go", async () => {
        await sleep(1100); // past the cache
        const pending = admin("GET", `/api/recordings/${rid}/snapshot?image=1`);
        await answerNext(agent, taskId, () => ({
            ok: true,
            snapshot: snap({
                title: "T‮itle",
                image: "<img src=x onerror=alert(1)>",
                imageType: "image/png",
                elements: [{ index: 9, tag: "input", name: "Password", locator: { strategy: "label", value: "Password" }, matches: 1, visible: true, enabled: true, secret: true, value: "LEAKED-BY-AGENT" }],
            }),
        }));
        const r = await pending;
        expect(r.body.title).toBe("Title");
        expect(r.body.image).toBeUndefined();
        expect(r.body.elements[0]).toMatchObject({ index: 0, secret: true, value: "[hidden]" });
        expect(r.text).not.toContain("LEAKED-BY-AGENT");
    });

    it("an answer too large for the wire is refused by the push route, and the person is told the agent did not answer", async () => {
        await sleep(1100);
        const pending = admin("GET", `/api/recordings/${rid}/snapshot`);
        const cmd = await until(async () => ((await agent.heartbeat(taskId, {})).json.commands as RecordCommand[] | undefined)?.find((c) => c.type === "snapshot"), "a snapshot command");
        const huge = await state(agent, taskId, { acked: [cmd.id], results: [{ id: cmd.id, ok: true, snapshot: snap({ image: "A".repeat(900_000), imageType: "image/png" }) }] });
        expect(huge.status).toBeGreaterThanOrEqual(400);
        const r = await pending;
        expect(r.status).toBe(504);
        expect(r.body.error).toMatch(/Maya's laptop did not answer in time/);
    }, 20_000);

    it("one action at a time: a second one while the first waits is a 409", async () => {
        const first = admin("POST", `/api/recordings/${rid}/act`, { action: "scroll" });
        await until(async () => ((await agent.heartbeat(taskId, {})).json.commands as RecordCommand[] | undefined)?.some((c) => c.type === "act"), "an act command");
        const second = await admin("POST", `/api/recordings/${rid}/act`, { action: "scroll" });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/Another action is still running/);
        await answerNext(agent, taskId, () => ({ ok: true, recorded: false, snapshot: snap() }));
        expect((await first).status).toBe(200);
    });

    it("an agent that never answers: the wait ends in a plain 504, the command is withdrawn, and the session can be used again", async () => {
        const r = await admin("POST", `/api/recordings/${rid}/act`, { action: "scroll" });
        expect(r.status).toBe(504);
        expect(r.body.error).toMatch(/did not answer in time.*take a snapshot/);
        expect(((await agent.heartbeat(taskId, {})).json.commands ?? []).filter((c: RecordCommand) => c.type === "act")).toEqual([]);
        const again = admin("POST", `/api/recordings/${rid}/act`, { action: "scroll" });
        await answerNext(agent, taskId, () => ({ ok: true, recorded: false, snapshot: snap() }));
        expect((await again).status).toBe(200);
    }, 20_000);

    it("the stored details are never sent for a page on another site", async () => {
        await state(agent, taskId, { currentUrl: "http://elsewhere.example.test/login" });
        const r = await admin("POST", `/api/recordings/${rid}/act`, { action: "fill", locator: { strategy: "label", value: "Password" }, value: "{{credentials.password}}" });
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/only typed on the application's own site \(http:\/\/localhost:6172\)/);
        expect(((await agent.heartbeat(taskId, {})).json.commands ?? []).filter((c: RecordCommand) => c.type === "act")).toEqual([]);
        await state(agent, taskId);
    });

    it("bad actions are refused by the platform before any command is queued", async () => {
        for (const body of [{ action: "teleport" }, { action: "click" }, { action: "navigate", url: "javascript:1" }]) {
            expect((await admin("POST", `/api/recordings/${rid}/act`, body)).status).toBe(400);
        }
        expect(((await agent.heartbeat(taskId, {})).json.commands ?? []).filter((c: RecordCommand) => c.type === "act")).toEqual([]);
    });

    it("keeps one audit row for the session, saying it ran on the agent, and not one secret anywhere the platform answered", async () => {
        const list = (await admin("GET", `/api/projects/${projectId}/live-sessions`)).body.sessions as Array<Record<string, any>>;
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ recordingId: rid, runner: "agent:Maya's laptop", startUrl: `${APP}/login` });
        expect(list[0]!.actions).toBeGreaterThan(1);
        expect(list[0]!.refused).toBeGreaterThan(2);
        expect(answers.join("\n")).not.toContain(PASSWORD);
        for (const f of [platform.config.dbPath, `${platform.config.dbPath}-wal`].filter((f) => fs.existsSync(f))) expect(fs.readFileSync(f).includes(Buffer.from(PASSWORD))).toBe(false);
    });

    it("a recording that ends while an action waits cancels the wait", async () => {
        const waiting = admin("POST", `/api/recordings/${rid}/act`, { action: "scroll" });
        await until(async () => ((await agent.heartbeat(taskId, {})).json.commands as RecordCommand[] | undefined)?.some((c) => c.type === "act"), "an act command");
        await state(agent, taskId, { status: "stopped" });
        const r = await waiting;
        expect(r.status).toBe(409);
        expect((await admin("POST", `/api/recordings/${rid}/act`, { action: "scroll" })).status).toBe(409);
        await admin("DELETE", `/api/recordings/${rid}`);
    });
});
