/**
 * The passive assessment, really executed (round 18, RUN): a real Chromium and real HTTP against a local fixture app WE own
 * (tests/fixtures/security-fixture-app.ts) with deliberate misconfigurations, through the platform's routes and the assessment loop.
 *
 * Proves: the deliberate problems are found (through FIND's ingest); nothing outside the scope is ever contacted (the redirect to another
 * host, the private-address link); excluded paths are never requested; nothing but GET/HEAD/OPTIONS reaches the app (the sign-in form is
 * not submitted, the page script's POST is blocked); no secret from the app is stored; progress and coverage; no authorization → 409;
 * one running per application; cancel; emergency stop; time limit; partial completion; restart safety; retest marking fixed.
 *
 * Run under the browser lock: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-assessment-run.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { FINISHED_STATES, type SecurityAssessment } from "../src/security/contract.js";
import { AssessmentLoop, LEASE_MS, type RunnerDeps } from "../src/security/assessment/runner.js";
import { loopDeps } from "../src/security/routes/assessments.js";
import { securitySettings } from "../src/security/settings.js";
import { SecurityStore } from "../src/security/store.js";
import { startSecurityFixture, type SecurityFixture } from "./fixtures/security-fixture-app.js";

type Inject = Awaited<ReturnType<typeof buildServer>>;

let dir: string;
let platform: Platform;
let server: Inject;
let fixture: SecurityFixture;
let store: SecurityStore;
let projectId: string;
let otherProjectId: string;
let appId: string;
let deps: RunnerDeps;
const launched: Browser[] = [];
const SECRETS = ["fake-db-password-123", "fake-session-value-123", "fake0token0abcdef0123456789"];

async function api(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await server.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}) });
    let json: any;
    try {
        json = r.json();
    } catch {
        json = r.body;
    }
    return { status: r.statusCode, json };
}

async function waitFor<T>(fn: () => T | undefined | false, ms: number, what: string): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 150));
    }
}

const finished = (id: string) => {
    const a = store.getAssessment(id)!;
    return FINISHED_STATES.includes(a.state) ? a : undefined;
};

/** Runs the loop until the assessment has finished (or `until` says stop waiting), then stops the loop. */
async function runToEnd(id: string, limits: Partial<NonNullable<RunnerDeps["limits"]>> = {}, during?: (loop: AssessmentLoop) => Promise<void>): Promise<SecurityAssessment> {
    const loop = new AssessmentLoop({ ...deps, limits: { ...deps.limits, ...limits } }, 100);
    loop.start();
    try {
        await during?.(loop);
        return await waitFor(() => finished(id), 150_000, `assessment ${id} to finish`);
    } finally {
        await loop.stop();
    }
}

async function newApp(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await api("POST", `/api/v1/security/projects/${projectId}/applications`, {
        name,
        targetUrl: `${fixture.origin}/`,
        environment: "development",
        excludedPaths: ["/admin"],
        maxRequestsPerSecond: 10,
        ...extra,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.application.id as string;
    const auth = await api("POST", `/api/v1/security/applications/${id}/authorizations`, { basis: "owner", approverName: "Test Owner", confirm: true });
    expect(auth.status, JSON.stringify(auth.json)).toBe(201);
    return id;
}

beforeAll(async () => {
    fixture = await startSecurityFixture(7031, 7032);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-secrun-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", WORKER_EMBEDDED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true" }));
    server = await buildServer(platform);
    store = new SecurityStore(platform.db);
    projectId = platform.repo.createProject({ name: "Fixture client" }).id as string;
    otherProjectId = platform.repo.createProject({ name: "Other client" }).id as string;
    deps = {
        ...loopDeps({ p: platform, settings: securitySettings(platform.config) }),
        limits: { maxPages: 12 },
        launch: async () => {
            const b = await launchChromium(true);
            launched.push(b);
            return b;
        },
    };
}, 60_000);

afterAll(async () => {
    for (const b of launched) await b.close().catch(() => undefined);
    await server?.close();
    platform?.db.close?.();
    await fixture?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("starting", () => {
    it("refuses without a current authorization (409, plain reason), and one running per application", async () => {
        const r = await api("POST", `/api/v1/security/projects/${projectId}/applications`, { name: "No permission yet", targetUrl: `${fixture.origin}/`, environment: "development" });
        const noAuth = await api("POST", `/api/v1/security/applications/${r.json.application.id}/assessments`, {});
        expect(noAuth.status).toBe(409);
        expect(noAuth.json.message ?? noAuth.json.error).toMatch(/No authorization is recorded yet/);

        appId = await newApp("Fixture shop", { apiSpecUrl: `${fixture.origin}/openapi.json` });
        const first = await api("POST", `/api/v1/security/applications/${appId}/assessments`, {});
        expect(first.status).toBe(201);
        expect(first.json.assessment).toMatchObject({ state: "QUEUED", kind: "passive", applicationName: "Fixture shop", retestOf: null });
        const second = await api("POST", `/api/v1/security/applications/${appId}/assessments`, {});
        expect(second.status).toBe(409);
        expect(second.json.message ?? second.json.error).toMatch(/already under way/);
        // Another project cannot see it.
        expect((await api("GET", `/api/v1/security/assessments/${first.json.assessment.id}?projectId=${otherProjectId}`)).status).toBe(404);
        expect((await api("GET", `/api/v1/security/projects/${otherProjectId}/assessments`)).json.assessments).toEqual([]);
    });
});

describe("a real passive assessment of the fixture app", () => {
    let assessment: SecurityAssessment;
    const progressSeen = new Set<string>();

    it("runs through its states and finishes, with progress words", async () => {
        const id = store.listAssessments({ applicationId: appId })[0]!.id;
        assessment = await runToEnd(id, {}, async () => {
            await waitFor(
                () => {
                    const a = store.getAssessment(id)!;
                    progressSeen.add(a.state);
                    return FINISHED_STATES.includes(a.state);
                },
                150_000,
                "the end",
            );
        });
        expect(assessment.error, JSON.stringify(assessment.coverage)).toBeNull();
        expect(assessment.state).toBe("COMPLETED");
        expect(progressSeen.has("DISCOVERING") || progressSeen.has("SCANNING")).toBe(true);
        expect(assessment.progress).toBe(100);
        expect(assessment.progressText).toMatch(/^Finished: \d+ new findings?/);
        expect(assessment.startedAt).toBeTruthy();
        expect(assessment.finishedAt).toBeTruthy();
    }, 180_000);

    it("finds the deliberate misconfigurations", async () => {
        const { json } = await api("GET", `/api/v1/security/projects/${projectId}/findings?limit=200`);
        const findings = json.findings as Array<{ title: string; category: string; severity: string; location: string; validation: string; source: string }>;
        const has = (category: string, re: RegExp) => findings.some((f) => f.category === category && re.test(`${f.title} ${f.location}`));
        expect(has("headers", /Content-Security-Policy/i), JSON.stringify(findings.map((f) => f.title))).toBe(true);
        expect(has("cookies", /sessionid/)).toBe(true);
        expect(has("exposed-files", /\.env/)).toBe(true);
        expect(has("information-disclosure", /Server|Apache/i)).toBe(true);
        expect(has("information-disclosure", /X-Powered-By|Express/i)).toBe(true);
        expect(has("information-disclosure", /uploads/)).toBe(true);
        expect(has("cors", /api\/items/)).toBe(true);
        expect(findings.every((f) => f.source === "built-in" && f.validation !== "confirmed")).toBe(true);
        expect(findings.find((f) => f.category === "exposed-files")!.severity).toBe("critical");
    });

    it("never contacted anything outside the scope, never requested excluded paths, only read", () => {
        expect(fixture.outsideRequests).toEqual([]);
        const paths = fixture.requests.map((r) => r.path);
        expect(paths.some((p) => p.startsWith("/admin"))).toBe(false);
        expect(fixture.requests.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method))).toEqual([]);
        expect(paths).toContain("/go-away");
        expect(paths).toContain("/.env");
        expect(paths).toContain("/openapi.json");
        // The sign-in form was seen and not submitted (no /login request at all).
        expect(paths.some((p) => p.startsWith("/login"))).toBe(false);
        // The made-up origin was sent to the API, as a header only.
        expect(fixture.requests.some((r) => r.path === "/api/items" && r.headers.origin === "https://untrusted-origin.example")).toBe(true);
    });

    it("says what it looked at and what it did not", () => {
        const c = assessment.coverage!;
        expect(c.pagesSeen).toBeGreaterThanOrEqual(5);
        expect(c.formsSeen).toBeGreaterThanOrEqual(1);
        expect(c.apiCallsSeen).toBeGreaterThanOrEqual(1);
        const text = c.notInspected.join("\n");
        expect(text).toMatch(/sign-in form was seen/);
        expect(text).toMatch(/Excluded paths were not requested: .*\/admin\/billing/);
        expect(text).toMatch(/outside the authorized scope/);
        expect(text).toMatch(/localhost:7032|10\.0\.0\.5/);
        expect(text).toMatch(/POST .*\/api\/track/);
        expect(text).toMatch(/never submitted/);
        expect(text).toMatch(/API document lists 1 operation/);
        expect(text).toMatch(/Only passive checks were made/);
    });

    it("stores no secret of the app (findings, assessment, work data, audit)", async () => {
        const all = JSON.stringify([
            (await api("GET", `/api/v1/security/projects/${projectId}/findings?limit=200`)).json,
            (await api("GET", `/api/v1/security/assessments/${assessment.id}`)).json,
            (await api("GET", `/api/v1/security/projects/${projectId}/activity`)).json,
        ]);
        for (const s of SECRETS) expect(all).not.toContain(s);
        // The assessment's own scratch data keeps cookies as received (never shown), but no API answer carries it.
        expect(JSON.stringify((await api("GET", `/api/v1/security/projects/${projectId}/assessments`)).json)).not.toContain("work");
    });

    it("records start and end in the security trail and Activity", async () => {
        const events = (await api("GET", `/api/v1/security/projects/${projectId}/activity`)).json.events as Array<{ action: string; summary: string }>;
        expect(events.some((e) => e.action === "assessment.started")).toBe(true);
        expect(events.some((e) => e.action === "assessment.finished" && /finished/.test(e.summary))).toBe(true);
    });

    it("a retest re-checks only the open findings' addresses and marks the fixed ones", async () => {
        fixture.fixEnv();
        const before = fixture.requests.length;
        const r = await api("POST", `/api/v1/security/applications/${appId}/assessments`, { retestOf: assessment.id });
        expect(r.status, JSON.stringify(r.json)).toBe(201);
        const done = await runToEnd(r.json.assessment.id);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(done.state);
        const asked = fixture.requests.slice(before).map((x) => x.path);
        expect(asked).toContain("/.env");
        // Only the findings' addresses: none of the other probe paths.
        expect(asked.some((p) => p === "/.git/HEAD" || p === "/phpinfo.php")).toBe(false);
        const findings = (await api("GET", `/api/v1/security/projects/${projectId}/findings?limit=200`)).json.findings as Array<{ category: string; validation: string; title: string }>;
        expect(findings.find((f) => f.category === "exposed-files")!.validation).toBe("fixed");
        expect(findings.find((f) => f.category === "cookies")!.validation).not.toBe("fixed");
        expect(fixture.outsideRequests).toEqual([]);
    }, 180_000);
});

describe("stopping", () => {
    it("cancel stops within seconds, closes the browser it opened, keeps what was found", async () => {
        fixture.setDelay(1_500);
        const id2 = await newApp("Slow shop (cancel)");
        const r = await api("POST", `/api/v1/security/applications/${id2}/assessments`, {});
        const id = r.json.assessment.id as string;
        const browsersBefore = launched.length;
        const done = await runToEnd(id, {}, async () => {
            await waitFor(() => store.getAssessment(id)!.state === "DISCOVERING" && launched.length > browsersBefore, 60_000, "discovery to start");
            await new Promise((res) => setTimeout(res, 2_000));
            const c = await api("POST", `/api/v1/security/assessments/${id}/cancel`, {});
            expect(c.status).toBe(202);
            const t0 = Date.now();
            await waitFor(() => finished(id), 15_000, "the cancel");
            expect(Date.now() - t0).toBeLessThan(15_000);
        });
        fixture.setDelay(0);
        expect(done.state).toBe("CANCELLED");
        expect(done.progressText).toMatch(/Cancelled while looking at the pages/);
        expect(done.coverage?.notInspected.join(" ")).toMatch(/Cancelled/);
        expect(launched[launched.length - 1]!.isConnected()).toBe(false);
        expect((await api("POST", `/api/v1/security/assessments/${id}/cancel`, {})).status).toBe(409);
    }, 120_000);

    it("the emergency stop stops every unfinished assessment of the project (running and queued)", async () => {
        fixture.setDelay(1_500);
        const a1 = await newApp("Stop one");
        const a2 = await newApp("Stop two");
        const s1 = (await api("POST", `/api/v1/security/applications/${a1}/assessments`, {})).json.assessment.id as string;
        const s2 = (await api("POST", `/api/v1/security/applications/${a2}/assessments`, {})).json.assessment.id as string;
        const loop = new AssessmentLoop(deps, 100);
        loop.start();
        try {
            await waitFor(() => store.getAssessment(s1)!.state === "DISCOVERING", 60_000, "the first to start");
            const other = await api("POST", `/api/v1/security/projects/${otherProjectId}/stop-all`, {});
            expect(other.json.stopped).toBe(0);
            const r = await api("POST", `/api/v1/security/projects/${projectId}/stop-all`, {});
            expect(r.status).toBe(202);
            expect(r.json.stopped).toBe(2);
            await waitFor(() => finished(s1) && finished(s2), 20_000, "both to stop");
        } finally {
            await loop.stop();
            fixture.setDelay(0);
        }
        expect(store.getAssessment(s1)!.state).toBe("CANCELLED");
        expect(store.getAssessment(s2)!.state).toBe("CANCELLED");
        expect(store.getAssessment(s2)!.progressText).toMatch(/Nothing was requested/);
        const events = (await api("GET", `/api/v1/security/projects/${projectId}/activity`)).json.events as Array<{ action: string }>;
        expect(events.some((e) => e.action === "assessment.stopped")).toBe(true);
    }, 120_000);

    it("the time limit ends it as partially completed, with the reason", async () => {
        fixture.setDelay(1_500);
        const id3 = await newApp("Slow shop (time limit)");
        const id = (await api("POST", `/api/v1/security/applications/${id3}/assessments`, {})).json.assessment.id as string;
        const done = await runToEnd(id, { timeoutMs: 5_000 });
        fixture.setDelay(0);
        expect(done.state).toBe("PARTIALLY_COMPLETED");
        expect(done.error).toMatch(/time limit/);
    }, 120_000);
});

describe("partial completion and restarts", () => {
    it("a check that keeps failing (connection dropped, retried) ends PARTIALLY_COMPLETED with the reason", async () => {
        fixture.setBroken("/backup.zip");
        const id4 = await newApp("Flaky shop");
        const id = (await api("POST", `/api/v1/security/applications/${id4}/assessments`, {})).json.assessment.id as string;
        const before = fixture.requests.length;
        const done = await runToEnd(id, { maxPages: 3 });
        fixture.setBroken(null);
        expect(done.state).toBe("PARTIALLY_COMPLETED");
        expect(done.error).toMatch(/backup\.zip/);
        // Retried a bounded number of times (1 + 2 retries).
        expect(fixture.requests.slice(before).filter((r) => r.path === "/backup.zip")).toHaveLength(3);
    }, 120_000);

    it("an assessment whose loop died is picked up by the next loop; three interruptions fail it", async () => {
        const id5 = await newApp("Restarted shop");
        const id = (await api("POST", `/api/v1/security/applications/${id5}/assessments`, {})).json.assessment.id as string;
        // A loop that claimed it and died at once: its lease runs out.
        expect(store.claimAssessment("dead-loop", 1)?.id).toBe(id);
        store.updateAssessment(id, { state: "SCANNING", startedAt: new Date().toISOString() });
        await new Promise((r) => setTimeout(r, 20));
        const done = await runToEnd(id, { maxPages: 3 });
        expect(done.state).toBe("COMPLETED");

        const id6 = await newApp("Often restarted shop");
        const again = (await api("POST", `/api/v1/security/applications/${id6}/assessments`, {})).json.assessment.id as string;
        store.setWorkData(again, { attempts: 3 });
        const failed = await runToEnd(again);
        expect(failed.state).toBe("FAILED");
        expect(failed.error).toMatch(/interrupted three times/);
        expect(LEASE_MS).toBeGreaterThan(5_000);
    }, 120_000);

    it("a revoked authorization stops the assessment", async () => {
        fixture.setDelay(1_500);
        const id7 = await newApp("Revoked shop");
        const id = (await api("POST", `/api/v1/security/applications/${id7}/assessments`, {})).json.assessment.id as string;
        const done = await runToEnd(id, {}, async () => {
            await waitFor(() => store.getAssessment(id)!.state === "DISCOVERING", 60_000, "discovery");
            const auths = (await api("GET", `/api/v1/security/applications/${id7}/authorizations`)).json.authorizations as Array<{ id: string }>;
            expect((await api("DELETE", `/api/v1/security/authorizations/${auths[0]!.id}`)).status).toBe(200);
        });
        fixture.setDelay(0);
        expect(done.state).toBe("CANCELLED");
        expect((await api("POST", `/api/v1/security/applications/${id7}/assessments`, {})).status).toBe(409);
    }, 120_000);
});
