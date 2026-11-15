/**
 * Scheduled passive assessments (src/security/schedules.ts, routes/schedule.ts) through the real platform server (Fastify inject, no network,
 * no browser): setting one needs security.use and a current authorization; a due schedule starts a passive assessment in its maker's name
 * on time; nothing is started before its time, while another assessment runs, without a current authorization (the schedule then switches
 * itself off), or when its maker lost access; off means off; the shared access key cannot be a maker.
 *
 * No ports. Run: node scripts/with-lock.mjs browser -- npx vitest run tests/security-schedules.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { fireDueSecuritySchedules, KEY_CANNOT_SCHEDULE, MAKER_LOST_ACCESS, nextSecurityRun, SecurityScheduleStore } from "../src/security/schedules.js";
import { securityStoreFor } from "../src/security/store.js";

const KEY = "sec-schedule-key-0123456789";
const API = "/api/v1/security";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-sched-"));

type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
const caller =
    (app: FastifyInstance, key: string): Call =>
    async (method, url, body) => {
        const r = await app.inject({ method: method as never, url, headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
        let parsed: unknown = r.body;
        try {
            parsed = JSON.parse(r.body);
        } catch {
            /* not JSON */
        }
        return { status: r.statusCode, body: parsed };
    };

const H = 3_600_000;
const authBody = { basis: "client-permission", approverName: "Dana Client", approverRole: "Head of Engineering", approverEmail: "dana@client.example", documentReference: "SOW-12", authority: "Signed SOW-12 for the application's owner.", restrictions: "", confirm: true };
const shop = (name: string) => ({ name, targetUrl: `https://${name.toLowerCase()}.example.com/`, environment: "staging", scope: [], excludedPaths: [], maxRequestsPerSecond: 2, notes: "" });

describe("scheduled passive assessments", () => {
    let platform: Platform;
    let app: FastifyInstance;
    let key: Call;
    let owner: Call;
    let editor: Call;
    let viewer: Call;
    let editorId: string;
    let project: string;

    beforeAll(async () => {
        platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY }));
        app = await buildServer(platform);
        await app.ready();
        const users = accessControlOf(app).users;
        const person = (name: string, role: "owner" | "editor" | "viewer") => {
            const u = users.create({ email: `${name.toLowerCase()}@example.com`, name, role });
            if (role === "editor") editorId = u.id;
            return caller(app, users.createToken(u.id, { name: "t", role }).token);
        };
        key = caller(app, KEY);
        owner = person("Olga", "owner");
        editor = person("Eve", "editor");
        viewer = person("Vic", "viewer");
        project = (await key("POST", "/api/projects", { name: "Client" })).body.id;
    }, 60_000);
    afterAll(async () => {
        await app?.close();
        platform?.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const newApp = async (name: string, authorized = true) => {
        const id = (await editor("POST", `${API}/projects/${project}/applications`, shop(name))).body.application.id as string;
        if (authorized) expect((await owner("POST", `${API}/applications/${id}/authorizations`, authBody)).status).toBe(201);
        return id;
    };
    const assessmentsOf = (appId: string) => securityStoreFor(platform.db).listAssessments({ projectId: project, applicationId: appId, limit: 50 });
    const due = (appId: string) => Date.parse(new SecurityScheduleStore(platform.db).get(appId)!.nextRunAt!);

    it("needs security.use and a current authorization to set, never the access key, and anyone on the project may read it", async () => {
        const id = await newApp("Gate", false);
        expect((await viewer("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "02:00" } })).status).toBe(403);
        expect((await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "02:00" } })).status).toBe(409);
        expect((await owner("POST", `${API}/applications/${id}/authorizations`, authBody)).status).toBe(201);
        const k = await key("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "02:00" } });
        expect(k.status).toBe(403);
        expect(k.body.error).toBe(KEY_CANNOT_SCHEDULE);
        expect((await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "25:00" } })).status).toBe(400);
        // Only daily or weekly: there is no other kind of schedule, and no other kind of assessment to choose.
        expect((await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "interval", every: 5, unit: "minutes" } })).status).toBe(400);
        expect((await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "02:00" }, kind: "active" })).status).toBe(400);
        const set = await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "weekly", weekday: 1, time: "03:30" } });
        expect(set.status).toBe(200);
        expect(set.body.schedule).toMatchObject({ enabled: true, words: "Every Monday at 03:30 UTC", maker: "Eve", lastOutcome: null });
        expect((await viewer("GET", `${API}/applications/${id}/schedule`)).body.schedule.words).toBe("Every Monday at 03:30 UTC");
        const audit = platform.db.all<{ action: string; summary: string }>("SELECT action, summary FROM security_audit WHERE application_id = ? AND action = 'schedule.changed'", id);
        expect(audit.map((a) => a.summary)).toEqual(["Scheduled a passive assessment of “Gate”: Every Monday at 03:30 UTC."]);
    });

    it("works out the next time in UTC", () => {
        const from = Date.UTC(2026, 10, 14, 1, 0); // Saturday 01:00 UTC
        expect(new Date(nextSecurityRun({ type: "daily", time: "02:00" }, from)).toISOString()).toBe("2026-11-14T02:00:00.000Z");
        expect(new Date(nextSecurityRun({ type: "daily", time: "00:30" }, from)).toISOString()).toBe("2026-11-15T00:30:00.000Z");
        expect(new Date(nextSecurityRun({ type: "weekly", weekday: 1, time: "03:30" }, from)).toISOString()).toBe("2026-11-16T03:30:00.000Z");
    });

    it("fires on time, passive, in its maker's name, once per slot", async () => {
        const id = await newApp("OnTime");
        expect((await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "02:00" } })).status).toBe(200);
        const at = due(id);
        expect((await fireDueSecuritySchedules(platform, at - 60_000)).filter((r) => r.applicationId === id)).toEqual([]);
        expect(assessmentsOf(id)).toHaveLength(0);
        let poked = 0;
        const fired = (await fireDueSecuritySchedules(platform, at + 1000, () => poked++)).find((r) => r.applicationId === id)!;
        expect(fired.outcome).toBe("started");
        expect(poked).toBe(1);
        const list = assessmentsOf(id);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: fired.assessmentId, kind: "passive", state: "QUEUED", startedBy: "Eve", retestOf: null });
        // The same slot never starts twice (another tick, another process).
        expect((await fireDueSecuritySchedules(platform, at + 2000)).filter((r) => r.applicationId === id)).toEqual([]);
        expect(assessmentsOf(id)).toHaveLength(1);
        const s = new SecurityScheduleStore(platform.db).get(id)!;
        expect(s).toMatchObject({ lastOutcome: "started", lastAssessmentId: fired.assessmentId });
        expect(Date.parse(s.nextRunAt!)).toBe(at + 24 * H);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_audit WHERE object_id = ? AND action = 'assessment.started'", fired.assessmentId!)!.n).toBe(1);
    });

    it("skips a slot while another assessment of the application runs, and tries the next one", async () => {
        const id = await newApp("Busy");
        expect((await editor("POST", `${API}/applications/${id}/assessments`, {})).status).toBe(201);
        expect((await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "04:00" } })).status).toBe(200);
        const at = due(id);
        const r = (await fireDueSecuritySchedules(platform, at + 1000)).find((x) => x.applicationId === id)!;
        expect(r.outcome).toBe("skipped");
        expect(r.note).toMatch(/already under way/);
        expect(assessmentsOf(id)).toHaveLength(1);
        const s = new SecurityScheduleStore(platform.db).get(id)!;
        expect(s.enabled).toBe(true);
        expect(Date.parse(s.nextRunAt!)).toBe(at + 24 * H);
    });

    it("switches itself off without a current authorization, with a sentence and an audit line", async () => {
        const id = await newApp("Revoked");
        expect((await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "05:00" } })).status).toBe(200);
        const authId = (await viewer("GET", `${API}/applications/${id}/authorizations`)).body.authorizations[0].id as string;
        expect((await owner("DELETE", `${API}/authorizations/${authId}`, { reason: "Contract ended" })).status).toBeLessThan(300);
        const r = (await fireDueSecuritySchedules(platform, due(id) + 1000)).find((x) => x.applicationId === id)!;
        expect(r.outcome).toBe("stopped");
        expect(r.note).toMatch(/switched off/);
        expect(assessmentsOf(id)).toHaveLength(0);
        const s = (await viewer("GET", `${API}/applications/${id}/schedule`)).body.schedule;
        expect(s).toMatchObject({ enabled: false, words: "Off", lastOutcome: "stopped" });
        expect(platform.db.all("SELECT 1 FROM security_audit WHERE application_id = ? AND action = 'schedule.stopped'", id)).toHaveLength(1);
        // Off means off: nothing more is tried, whatever time it is.
        expect((await fireDueSecuritySchedules(platform, Date.now() + 30 * 24 * H)).filter((x) => x.applicationId === id)).toEqual([]);
    });

    it("off means off when a person switches it off", async () => {
        const id = await newApp("Paused");
        expect((await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "06:00" } })).status).toBe(200);
        const at = due(id);
        const off = await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: null });
        expect(off.body.schedule).toMatchObject({ enabled: false, nextRunAt: null, words: "Off" });
        expect((await fireDueSecuritySchedules(platform, at + 10 * 24 * H)).filter((x) => x.applicationId === id)).toEqual([]);
        expect(assessmentsOf(id)).toHaveLength(0);
    });

    it("stops when its maker can no longer use the project", async () => {
        const id = await newApp("Maker");
        expect((await editor("PUT", `${API}/applications/${id}/schedule`, { cadence: { type: "daily", time: "07:00" } })).status).toBe(200);
        platform.db.run("UPDATE users SET status = 'disabled' WHERE id = ?", editorId);
        try {
            const r = (await fireDueSecuritySchedules(platform, due(id) + 1000)).find((x) => x.applicationId === id)!;
            expect(r).toMatchObject({ outcome: "stopped", note: MAKER_LOST_ACCESS });
            expect(assessmentsOf(id)).toHaveLength(0);
            expect(new SecurityScheduleStore(platform.db).get(id)!.enabled).toBe(false);
        } finally {
            platform.db.run("UPDATE users SET status = 'active' WHERE id = ?", editorId);
        }
    });

    it("is reached through the platform scheduler's tick", async () => {
        const src = fs.readFileSync(path.join(__dirname, "../src/platform/schedule-services.ts"), "utf8");
        expect(src).toMatch(/fireDueSecuritySchedules\(p, now/);
    });
});
