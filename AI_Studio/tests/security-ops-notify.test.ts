/**
 * Security Assessment messages when an assessment ends (src/security/notify.ts, routes/notifications.ts), through the real platform
 * server (Fastify inject) and the project's real alert channels, delivered to a local fake webhook receiver and a local fake mail server.
 *
 * Proves: the defaults (new critical/high on, failures on, every finish off); one message per assessment with the reasons combined; what a
 * message carries (application, state, counts by severity, link to the assessment) and what it never carries (evidence, locations, the
 * target address, an error text); webhook, Slack, Teams and email shapes; chosen channels and disabled channels; the alert log and the
 * "recent" list; the RUN loop's end hook sends it; the settings API (roles, validation, tenant check, audit trail, the switch off); round 21:
 * a critical or high finding marked fixed and seen again counts as "came back" (reopened-critical-high).
 *
 * Ports 7177-7178 (OPS range). Run under the lock (it starts servers):
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-ops-notify.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import type { SecurityApplication, SecurityAssessment, Severity } from "../src/security/contract.js";
import { ingest, type RawResult } from "../src/security/findings/ingest.js";
import { notifyAssessmentFinished } from "../src/security/notify.js";
import { loopDeps } from "../src/security/routes/assessments.js";
import { securitySettings } from "../src/security/settings.js";
import { securityStoreFor, type SecurityStore } from "../src/security/store.js";
import { startFakeSmtp, type FakeSmtp } from "./fixtures/fake-smtp.js";

const HOOK_PORT = 7177;
const SMTP_PORT = 7178;
const KEY = "sec-ops-notify-key-0123456789";
const API = "/api/v1/security";
const PUBLIC = "https://platform.example";
const EVIDENCE = "EVIDENCE-SENTINEL-7177";
const LOCATION = "where-SENTINEL-7177";
const TARGET_HOST = "shop.client-sentinel.example";
const ERROR_TEXT = "error-text-SENTINEL-7177";

const received: Array<{ path: string; body: any; raw: string }> = [];
let hook: http.Server;
let smtp: FakeSmtp;
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-notify-"));
    dirs.push(d);
    return d;
};

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

beforeAll(async () => {
    hook = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            received.push({ path: req.url ?? "", body: JSON.parse(raw || "null"), raw });
            res.writeHead(200).end("ok");
        });
    });
    await new Promise<void>((r) => hook.listen(HOOK_PORT, "127.0.0.1", r));
    smtp = await startFakeSmtp(SMTP_PORT);
});
afterAll(async () => {
    await new Promise((r) => hook?.close(r));
    await smtp?.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const waitFor = async (cond: () => boolean, ms = 8_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 50));
    }
};

describe("messages when a security assessment ends", () => {
    let platform: Platform;
    let app: FastifyInstance;
    let key: Call;
    let editor: Call;
    let viewer: Call;
    let store: SecurityStore;
    let pid: string;
    let otherPid: string;
    let shop: SecurityApplication;
    let authId: string;
    const ch: Record<string, string> = {};

    beforeAll(async () => {
        platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, PUBLIC_URL: PUBLIC }));
        app = await buildServer(platform);
        await app.ready();
        const users = accessControlOf(app).users;
        const person = (name: string, role: "owner" | "editor" | "viewer") => {
            const u = users.create({ email: `${name.toLowerCase()}@example.com`, name, role });
            return caller(app, users.createToken(u.id, { name: "t", role }).token);
        };
        key = caller(app, KEY);
        editor = person("Eve", "editor");
        viewer = person("Vic", "viewer");
        pid = (await key("POST", "/api/projects", { name: "Client A" })).body.id;
        otherPid = (await key("POST", "/api/projects", { name: "Client B" })).body.id;
        const hookUrl = (p: string) => `http://127.0.0.1:${HOOK_PORT}/${p}`;
        for (const [name, kind] of [["webhook", "webhook"], ["slack", "slack"], ["teams", "teams"]] as const) {
            const r = await key("POST", `/api/projects/${pid}/alert-channels`, { kind, name, url: hookUrl(name) });
            expect(r.status).toBe(201);
            ch[name] = r.body.id;
        }
        const off = await key("POST", `/api/projects/${pid}/alert-channels`, { kind: "webhook", name: "off", url: hookUrl("off"), enabled: false });
        ch.off = off.body.id;
        const mail = await key("POST", `/api/projects/${pid}/alert-channels`, { kind: "email", name: "mail", recipients: ["sec@example.com"], smtp: { host: "127.0.0.1", port: SMTP_PORT, from: "alerts@example.com" } });
        expect(mail.status).toBe(201);
        ch.mail = mail.body.id;
        ch.otherProject = (await key("POST", `/api/projects/${otherPid}/alert-channels`, { kind: "webhook", name: "b", url: hookUrl("b") })).body.id;

        store = securityStoreFor(platform.db);
        shop = store.createApplication(pid, { name: "Shop", targetUrl: `https://${TARGET_HOST}/`, environment: "staging" });
        authId = store.addAuthorization(shop.id, { basis: "owner", approverName: "Olga", statement: "I confirm.", confirmedByName: "Olga" }).id;
    }, 60_000);
    afterAll(async () => {
        await app?.close();
        platform?.db.close();
    });

    /** An assessment that ended in `state`, which saw these findings (by fingerprint). */
    const ended = (state: SecurityAssessment["state"], seen: Array<{ fp: string; severity: Severity }>, error: string | null = null) => {
        const a = store.createAssessment({ applicationId: shop.id, authorizationId: authId, startedBy: "Eve" });
        for (const f of seen) {
            store.upsertFinding({
                projectId: pid,
                applicationId: shop.id,
                assessmentId: a.id,
                fingerprint: f.fp,
                title: `Finding ${f.fp}`,
                category: "headers",
                severity: f.severity,
                confidence: "high",
                location: `https://${TARGET_HOST}/${LOCATION}/${f.fp}`,
                description: "d",
                impact: "i",
                remediation: "r",
                evidence: [{ kind: "response-header", label: "set-cookie", value: `sid=${EVIDENCE}`, observedAt: new Date().toISOString() }],
                source: "built-in",
            });
        }
        return store.updateAssessment(a.id, { state, finishedAt: new Date().toISOString(), error })!;
    };
    const fresh = () => received.splice(0, received.length);
    const send = (a: SecurityAssessment) => notifyAssessmentFinished(platform, a, shop, { delivery: { backoffMs: [] } });

    it("the settings answer: defaults, the project's channels (no address), nothing sent yet", async () => {
        const r = await viewer("GET", `${API}/projects/${pid}/notifications`);
        expect(r.status).toBe(200);
        expect(r.body.settings).toEqual({ newCriticalHigh: true, failed: true, everyFinish: false, channelIds: null });
        expect(r.body.saved).toBe(false);
        expect(r.body.defaults).toEqual(r.body.settings);
        expect(r.body.channels.map((c: any) => [c.name, c.kind, c.enabled, c.selected])).toEqual([
            ["webhook", "webhook", true, true],
            ["slack", "slack", true, true],
            ["teams", "teams", true, true],
            ["off", "webhook", false, false],
            ["mail", "email", true, true],
        ]);
        expect(JSON.stringify(r.body)).not.toContain(`127.0.0.1:${HOOK_PORT}`);
        expect(r.body.recent).toEqual([]);
    });

    it("by default: new critical or high findings send one message to every enabled channel, with counts and the link, never evidence", async () => {
        fresh();
        smtp.mails.length = 0;
        const a = ended("PARTIALLY_COMPLETED", [
            { fp: "h1", severity: "high" },
            { fp: "m1", severity: "medium" },
            { fp: "m2", severity: "medium" },
        ], `Scan failed for https://${TARGET_HOST}/${ERROR_TEXT}`);
        const sent = await send(a);
        expect(sent.map((s) => [s.channelId, s.reasons, s.ok])).toEqual([
            [ch.webhook, ["new-critical-high"], true],
            [ch.slack, ["new-critical-high"], true],
            [ch.teams, ["new-critical-high"], true],
            [ch.mail, ["new-critical-high"], true],
        ]);
        const got = fresh();
        expect(got.map((g) => g.path).sort()).toEqual(["/slack", "/teams", "/webhook"]);
        const link = `${PUBLIC}/#/projects/${pid}/security/assessments/${a.id}`;
        const webhook = got.find((g) => g.path === "/webhook")!.body;
        expect(webhook).toMatchObject({
            event: "security_assessment",
            events: ["new-critical-high"],
            test: false,
            project: { id: pid, name: "Client A" },
            link,
            assessment: { id: a.id, applicationId: shop.id, applicationName: "Shop", state: "PARTIALLY_COMPLETED", retest: false, findingsSeen: { critical: 0, high: 1, medium: 2, low: 0, info: 0 }, newFindings: { critical: 0, high: 1 } },
        });
        expect(webhook.summary).toBe("The passive assessment of “Shop” in Client A finished with gaps. 1 new critical or high finding (0 critical, 1 high). Findings seen: 1 high, 2 medium.");
        const slack = got.find((g) => g.path === "/slack")!.body;
        expect(slack.text).toBe(webhook.summary);
        expect(JSON.stringify(slack.blocks)).toContain(link);
        const teams = got.find((g) => g.path === "/teams")!.body;
        expect(teams.attachments[0].content.body[0].text).toContain("New critical or high findings: Shop");
        expect(teams.attachments[0].content.actions[0].url).toBe(link);
        await waitFor(() => smtp.mails.length === 1);
        const mail = smtp.mails[0]!.data;
        expect(mail).toMatch(/Subject: New critical or high findings: Shop \(finished with gaps\)/);
        expect(mail).toContain("security assessment, under Notifications");
        for (const text of [...got.map((g) => g.raw), mail]) {
            for (const secret of [EVIDENCE, LOCATION, TARGET_HOST, ERROR_TEXT, "Finding h1"]) expect(text).not.toContain(secret);
        }
    });

    it("by default nothing is sent for an ordinary finish (no new critical or high finding)", async () => {
        fresh();
        // h1 is seen again (not new), plus a new low one.
        const a = ended("COMPLETED", [
            { fp: "h1", severity: "high" },
            { fp: "l1", severity: "low" },
        ]);
        expect(await send(a)).toEqual([]);
        expect(fresh()).toEqual([]);
    });

    it("a failure is sent by default; every finish when it is switched on; reasons are combined", async () => {
        fresh();
        const failed = ended("FAILED", [], `Could not reach https://${TARGET_HOST}/${ERROR_TEXT}`);
        expect((await send(failed)).map((s) => s.reasons)).toEqual([["failed"], ["failed"], ["failed"], ["failed"]]);
        const w = fresh().find((g) => g.path === "/webhook")!;
        expect(w.body.summary).toBe("The passive assessment of “Shop” in Client A failed. No findings were seen.");
        expect(w.raw).not.toContain(ERROR_TEXT);

        expect((await editor("PUT", `${API}/projects/${pid}/notifications`, { failed: false })).status).toBe(200);
        expect(await send(ended("FAILED", []))).toEqual([]);

        expect((await editor("PUT", `${API}/projects/${pid}/notifications`, { everyFinish: true, failed: true })).status).toBe(200);
        const cancelled = ended("CANCELLED", [{ fp: "c1", severity: "critical" }]);
        expect((await send(cancelled))[0]!.reasons).toEqual(["new-critical-high", "finished"]);
        const body = fresh().find((g) => g.path === "/webhook")!.body;
        expect(body.summary).toBe("The passive assessment of “Shop” in Client A was cancelled. 1 new critical or high finding (1 critical, 0 high). Findings seen: 1 critical.");
        expect((await send(ended("COMPLETED", [])))[0]!.reasons).toEqual(["finished"]);
        fresh();
    });

    it("only the chosen channels hear it; a channel of another project cannot be chosen", async () => {
        const bad = await editor("PUT", `${API}/projects/${pid}/notifications`, { channelIds: [ch.webhook, ch.otherProject] });
        expect(bad.status).toBe(400);
        expect(bad.body.message ?? bad.body.error).toMatch(/does not belong to this project/);
        const r = await editor("PUT", `${API}/projects/${pid}/notifications`, { channelIds: [ch.webhook, ch.off] });
        expect(r.status).toBe(200);
        expect(r.body.settings.channelIds).toEqual([ch.webhook, ch.off]);
        expect(r.body.channels.filter((c: any) => c.selected).map((c: any) => c.name)).toEqual(["webhook"]);
        fresh();
        const sent = await send(ended("COMPLETED", []));
        expect(sent.map((s) => s.channelId)).toEqual([ch.webhook]);
        expect(fresh().map((g) => g.path)).toEqual(["/webhook"]);
        // Back to every channel.
        expect((await editor("PUT", `${API}/projects/${pid}/notifications`, { channelIds: null })).body.settings.channelIds).toBeNull();
    });

    it("the RUN loop's end hook sends it (without waiting), and every delivery is in the alert log and the recent list", async () => {
        fresh();
        const logged = () => platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alert_log WHERE project_id = ? AND event LIKE 'security:%'", pid)?.n ?? 0;
        const before = logged();
        const a = ended("COMPLETED", [{ fp: "h9", severity: "high" }]);
        loopDeps({ p: platform, settings: securitySettings(platform.config) }).onFinished!(a, shop);
        await waitFor(() => received.some((g) => g.path === "/webhook" && g.body.assessment?.id === a.id));
        // Webhook, Slack, Teams and email: four deliveries logged.
        await waitFor(() => logged() === before + 4);
        const r = await viewer("GET", `${API}/projects/${pid}/notifications`);
        expect(r.body.recent.length).toBeGreaterThan(5);
        expect(r.body.recent[0]).toMatchObject({ status: "sent", reasons: expect.arrayContaining(["new-critical-high"]), error: null });
        expect(JSON.stringify(r.body.recent)).not.toContain(EVIDENCE);
        // The assessment's own audit line is still written (RUN), as the platform.
        const activity = await viewer("GET", `${API}/projects/${pid}/activity`);
        expect(activity.body.events.some((e: any) => e.action === "assessment.finished" && e.objectId === a.id)).toBe(true);
    });

    it("roles, plain validation, tenant check and the audit trail of the settings", async () => {
        expect((await viewer("PUT", `${API}/projects/${pid}/notifications`, { everyFinish: false })).status).toBe(403);
        const unknown = await editor("PUT", `${API}/projects/${pid}/notifications`, { everyFinish: false, sendTo: "everyone" });
        expect(unknown.status).toBe(400);
        expect((await editor("PUT", `${API}/projects/${pid}/notifications`, { everyFinish: "yes" })).status).toBe(400);
        expect((await editor("PUT", `${API}/projects/no-such-project/notifications`, { everyFinish: false })).status).toBe(404);
        expect((await viewer("GET", `${API}/projects/no-such-project/notifications`)).status).toBe(404);
        const r = await editor("PUT", `${API}/projects/${pid}/notifications`, { everyFinish: false });
        expect(r.body).toMatchObject({ settings: { newCriticalHigh: true, failed: true, everyFinish: false, channelIds: null }, saved: true });
        const trail = (await viewer("GET", `${API}/projects/${pid}/activity`)).body.events.filter((e: any) => e.action === "notifications.changed");
        expect(trail[0].summary).toBe("Changed the assessment messages of “Client A”: new critical or high findings on, failures on, every finish off; sent to every alert channel of the project.");
        expect(trail[0].actor.name).toBe("Eve");
        // The same values again record nothing new.
        const n = trail.length;
        await editor("PUT", `${API}/projects/${pid}/notifications`, { everyFinish: false });
        expect((await viewer("GET", `${API}/projects/${pid}/activity`)).body.events.filter((e: any) => e.action === "notifications.changed").length).toBe(n);
        // Another project's setting is its own.
        expect((await viewer("GET", `${API}/projects/${otherPid}/notifications`)).body.saved).toBe(false);
    });

    // Round 21 (FX-S): a critical or high finding marked fixed that an assessment sees again "came back" and counts like a new one.
    it("a critical or high finding that was marked fixed and is seen again is sent as came back (reopened-critical-high)", async () => {
        const raw: RawResult = { check: "other", url: `https://${TARGET_HOST}/${LOCATION}/back`, custom: { key: "came-back", title: "Finding came back", category: "configuration", severity: "high", description: "d", impact: "i", remediation: "r" } };
        const first = store.createAssessment({ applicationId: shop.id, authorizationId: authId, startedBy: "Eve" });
        expect((await ingest(platform.db, first, [raw])).created).toBe(1);
        const id = platform.db.get<{ id: string }>("SELECT id FROM security_findings WHERE first_assessment_id = ?", first.id)!.id;
        store.setValidation(id, "fixed", { comment: "Fixed in release 12." });
        store.updateAssessment(first.id, { state: "COMPLETED", finishedAt: new Date().toISOString() });
        // FIND's own ingest reopens it (fixed, seen again: needs review).
        const again = store.createAssessment({ applicationId: shop.id, authorizationId: authId, startedBy: "Eve" });
        expect((await ingest(platform.db, again, [raw])).reopened).toBe(1);
        const done = store.updateAssessment(again.id, { state: "COMPLETED", finishedAt: new Date().toISOString() })!;
        fresh();
        smtp.mails.length = 0;
        const sent = await send(done);
        expect(sent.map((s) => s.reasons)).toEqual([["reopened-critical-high"], ["reopened-critical-high"], ["reopened-critical-high"], ["reopened-critical-high"]]);
        const got = fresh();
        const webhook = got.find((g) => g.path === "/webhook")!.body;
        expect(webhook).toMatchObject({ events: ["reopened-critical-high"], assessment: { id: again.id, newFindings: { critical: 0, high: 0 }, reopenedFindings: { critical: 0, high: 1 }, findingsSeen: { high: 1 } } });
        expect(webhook.summary).toBe("The passive assessment of “Shop” in Client A finished. 1 critical or high finding came back: marked fixed, then seen again (0 critical, 1 high). Findings seen: 1 high.");
        const teams = got.find((g) => g.path === "/teams")!.body;
        expect(teams.attachments[0].content.body[0].text).toContain("Critical or high findings came back: Shop");
        expect(JSON.stringify(got.find((g) => g.path === "/slack")!.body.blocks)).toContain("Came back (critical or high)");
        await waitFor(() => smtp.mails.length === 1);
        expect(smtp.mails[0]!.data).toMatch(/Subject: Critical or high findings came back: Shop \(finished\)/);
        for (const text of [...got.map((g) => g.raw), smtp.mails[0]!.data]) for (const secret of [LOCATION, TARGET_HOST, "Finding came back"]) expect(text).not.toContain(secret);
        // The recent list names the reason (the page words it "critical or high findings came back").
        const recent = (await viewer("GET", `${API}/projects/${pid}/notifications`)).body.recent;
        expect(recent[0]).toMatchObject({ status: "sent", reasons: ["reopened-critical-high"] });
        // Seen again while still open is not "came back"; nothing is sent for it by default.
        const third = store.createAssessment({ applicationId: shop.id, authorizationId: authId, startedBy: "Eve" });
        expect((await ingest(platform.db, third, [raw])).reopened).toBe(0);
        expect(await send(store.updateAssessment(third.id, { state: "COMPLETED", finishedAt: new Date().toISOString() })!)).toEqual([]);
        // The same switch turns it off.
        store.setValidation(id, "fixed", { comment: "Fixed again." });
        expect((await editor("PUT", `${API}/projects/${pid}/notifications`, { newCriticalHigh: false })).status).toBe(200);
        const fourth = store.createAssessment({ applicationId: shop.id, authorizationId: authId, startedBy: "Eve" });
        expect((await ingest(platform.db, fourth, [raw])).reopened).toBe(1);
        expect(await send(store.updateAssessment(fourth.id, { state: "COMPLETED", finishedAt: new Date().toISOString() })!)).toEqual([]);
        expect((await editor("PUT", `${API}/projects/${pid}/notifications`, { newCriticalHigh: true })).status).toBe(200);
        fresh();
    });

    it("with the module switched off the routes answer 404", async () => {
        const p2 = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECURITY_ASSESSMENT: "off" }));
        const a2 = await buildServer(p2);
        await a2.ready();
        try {
            const k = caller(a2, KEY);
            const id = (await k("POST", "/api/projects", { name: "X" })).body.id;
            expect((await k("GET", `${API}/projects/${id}/notifications`)).status).toBe(404);
            expect((await k("PUT", `${API}/projects/${id}/notifications`, { everyFinish: true })).status).toBe(404);
        } finally {
            await a2.close();
            p2.db.close();
        }
    });
});
