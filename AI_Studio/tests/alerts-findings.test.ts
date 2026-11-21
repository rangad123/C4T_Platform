/**
 * Findings notices on the existing alert channels (Phase 6, X3): a person's confirm sends finding_confirmed and a reopen
 * finding_reopened, only to channels that chose them (a channel made without choosing hears about runs only), with every text masked
 * (canary grep) and each delivery in the alert log. The receiver is a local HTTP server; nothing leaves the machine.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { findingFingerprint, type CandidateFindingInput } from "../src/engine/explore/finding.js";
import { DEFAULT_EVENTS } from "../src/platform/alerts.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "alerts-findings-test-key-93ab";
const CANARY = "FAKECANARY0alerts0findings0123456789";
let dir: string;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let store: CandidateFindingStore;
let receiver: http.Server;
let base = "";
let projectId = "";
const received: Array<{ url: string; body: string }> = [];

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    return { status: r.statusCode, body: r.body && /^[{[]/.test(r.body) ? r.json() : r.body };
};
const finding = (scenario: string): CandidateFindingInput => ({
    objective: null,
    actions: { stepCount: 1 },
    expected: { text: "The total equals the sum of the lines.", source: "R-4" },
    observed: `The page showed password=${CANARY} next to a total of 40.00.`,
    evidence: { screenshots: [], requests: [], console: [] },
    capture: "captured",
    independence: "independent",
    confidence: "high",
    fingerprint: findingFingerprint({ source: "R-4", expected: "The total equals the sum of the lines.", scenario }),
    modelVersion: null,
    replays: [],
});
const messages = (name: string) => received.filter((r) => r.url === `/${name}`).map((r) => JSON.parse(r.body));

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    receiver = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => (received.push({ url: req.url ?? "", body }), res.writeHead(200).end("ok")));
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-alertfind-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "alerts-findings-secret-key-0123456789" }));
    app = await buildServer(platform);
    await app.ready();
    store = new CandidateFindingStore(platform.sql);
    projectId = (await call("POST", "/api/projects", { name: "Shop" })).body.id;
    const ch = (name: string, events?: string[]) => call("POST", `/api/projects/${projectId}/alert-channels`, { kind: "webhook", name, url: `${base}/${name}`, ...(events ? { events } : {}) });
    expect((await ch("confirmed", ["finding_confirmed"])).status).toBe(201);
    expect((await ch("reopened", ["finding_reopened"])).status).toBe(201);
    expect((await ch("default")).status).toBe(201);
});

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise<void>((r) => (receiver ? receiver.close(() => r()) : r()));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("findings notices", () => {
    it("are opt-in: a channel made without choosing hears about runs only", async () => {
        expect(DEFAULT_EVENTS).toEqual(["run_failed", "regression", "recovered", "flaky"]);
        const list = (await call("GET", `/api/projects/${projectId}/alert-channels`)).body;
        const def = (Array.isArray(list) ? list : list.channels).find((c: any) => c.name === "default");
        expect(def.events).toEqual(DEFAULT_EVENTS);
    });

    it("tell the channel that chose finding_confirmed when a person confirms, masked", async () => {
        const id = (await store.upsert({ projectId, finding: finding("a") })).finding.id;
        await store.transition(projectId, id, { to: "verification_pending", by: "engine" });
        await store.transition(projectId, id, { to: "reproduced", by: "engine", set: { severity: "high", confidence: { confidence: "high", factors: [] } as any } });
        expect((await call("POST", `/api/projects/${projectId}/findings/${id}/transition`, { action: "confirm" })).status).toBe(200);
        await vi.waitFor(() => expect(messages("confirmed")).toHaveLength(1), { timeout: 10_000, interval: 50 });
        const m = messages("confirmed")[0];
        expect(m).toMatchObject({ event: "finding_confirmed", events: ["finding_confirmed"], project: { id: projectId } });
        expect(m.summary).toContain("confirmed the finding");
        expect(m.findings[0].reason).toContain("40.00");
        expect(JSON.stringify(received)).not.toContain(CANARY);
        expect(messages("reopened")).toEqual([]);
    });

    it("tell the channel that chose finding_reopened when a person reopens, and say nothing for not a bug", async () => {
        const id = (await store.upsert({ projectId, finding: finding("b") })).finding.id;
        expect((await call("POST", `/api/projects/${projectId}/findings/${id}/transition`, { action: "not_a_bug", reason: "On purpose." })).status).toBe(200);
        expect((await call("POST", `/api/projects/${projectId}/findings/${id}/transition`, { action: "reopen" })).status).toBe(200);
        await vi.waitFor(() => expect(messages("reopened")).toHaveLength(1), { timeout: 10_000, interval: 50 });
        expect(messages("reopened")[0]).toMatchObject({ event: "finding_reopened" });
        expect(messages("reopened")[0].summary).toContain("(it was not a bug)");
        expect(messages("confirmed")).toHaveLength(1);
        expect(messages("default")).toEqual([]);
        expect(JSON.stringify(received)).not.toContain(CANARY);
        const log = platform.db.all<{ event: string; status: string; summary: string }>("SELECT event, status, summary FROM alert_log WHERE project_id = ? ORDER BY id", projectId);
        expect(log.map((l) => [l.event, l.status])).toEqual([
            ["finding_confirmed", "sent"],
            ["finding_reopened", "sent"],
        ]);
        expect(JSON.stringify(log)).not.toContain(CANARY);
    });
});
