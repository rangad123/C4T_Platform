/**
 * Round 21 (FX-S), really executed: a signed-in assessment whose session ends on the server half-way (the local fixture app WE own
 * refuses the session after a number of requests and removes its cookie), with a real Chromium, through the platform's routes and the
 * assessment loop.
 *
 * Proves: the saved sign-in is re-checked while the assessment runs (every few pages: the signed-in page again, or without one the
 * browser's cookies) and before the read-only checks (the signed-in page with a plain request); once it has stopped working nothing more
 * is sent signed in (no session cookie on any later request, the read-only checks included), what was seen is kept, and the coverage
 * says from which point signed-in pages were not inspected. It never signs in again: only GET/HEAD/OPTIONS reach the app, never a
 * sign-in or sign-out address.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-signin-expiry.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";
import { SessionStore } from "../src/platform/session-store.js";
import { FINISHED_STATES, type SecurityAssessment } from "../src/security/contract.js";
import { AssessmentLoop, signInEndedSentence, type RunnerDeps } from "../src/security/assessment/runner.js";
import type { DiscoveryResult } from "../src/security/assessment/types.js";
import { loopDeps } from "../src/security/routes/assessments.js";
import { securitySettings } from "../src/security/settings.js";
import { SecurityStore } from "../src/security/store.js";
import { FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE, startSecurityFixture, type SecurityFixture } from "./fixtures/security-fixture-app.js";

type Inject = Awaited<ReturnType<typeof buildServer>>;
const API = "/api/v1/security";
const LABEL = "the project's own account";

let dir: string;
let platform: Platform;
let server: Inject;
let fixture: SecurityFixture;
let store: SecurityStore;
let appId: string;
let projectId: string;
const launched: Browser[] = [];

async function api(method: "GET" | "POST" | "PATCH" | "PUT", url: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await server.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}) });
    let json: any;
    try {
        json = r.json();
    } catch {
        json = undefined;
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

const deps = (signInCheckEvery: number): RunnerDeps => ({
    ...loopDeps({ p: platform, settings: securitySettings(platform.config) }),
    limits: { maxPages: 12, signInCheckEvery },
    launch: async () => {
        const b = await launchChromium(true);
        launched.push(b);
        return b;
    },
});

/** Saves the sign-in (with or without its signed-in page), ends the session after `requests` signed-in requests, runs one assessment. */
async function assess(o: { checkUrl?: string; sessionLasts: number; every: number }) {
    const storageState = {
        cookies: [{ name: FIXTURE_SESSION_COOKIE, value: FIXTURE_SESSION_VALUE, domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax" as const }],
        origins: [],
    };
    if (o.checkUrl) {
        const saved = await api("PUT", `${API}/applications/${appId}/saved-sign-in`, { account: "main", storageState, checkUrl: o.checkUrl });
        expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    } else {
        // A sign-in saved in Settings on a page outside this application's scope: the assessment has no signed-in page to open again.
        new SessionStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).saveSession(projectId, "main", { state: storageState, appUrl: fixture.origin, checkUrl: `${fixture.outsideOrigin}/signed-in`, how: "file" });
    }
    fixture.expireSessionAfter(o.sessionLasts);
    const from = fixture.requests.length;
    const started = await api("POST", `${API}/applications/${appId}/assessments`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(201);
    const aid = started.json.assessment.id as string;
    const loop = new AssessmentLoop(deps(o.every), 100);
    loop.start();
    try {
        const a = await waitFor(() => {
            const x = store.getAssessment(aid)!;
            return FINISHED_STATES.includes(x.state) ? x : undefined;
        }, 170_000, `assessment ${aid}`);
        const requests = fixture.requests.slice(from);
        const ended = store.getWorkData<{ discovery?: DiscoveryResult }>(aid)?.discovery?.signInEnded ?? null;
        return { a, requests, ended };
    } finally {
        await loop.stop();
        fixture.expireSessionAfter(null);
    }
}

const sessionCookie = (r: SecurityFixture["requests"][number]) => String(r.headers.cookie ?? "").includes(`${FIXTURE_SESSION_COOKIE}=`);

/** Nothing but reads, never a sign-in or sign-out address, nothing outside the scope. */
function expectReadOnly(requests: SecurityFixture["requests"]): void {
    expect(requests.every((r) => ["GET", "HEAD", "OPTIONS"].includes(r.method))).toBe(true);
    for (const r of requests) expect(r.path, r.path).not.toMatch(/^\/(login|logout|session\/end|api\/logout)/);
    expect(fixture.outsideRequests).toEqual([]);
}

/** After the last request that carried the session, nothing did again, and the app was still looked at (the read-only checks at least). */
function expectNothingSignedInAfterwards(requests: SecurityFixture["requests"]): void {
    const last = requests.map(sessionCookie).lastIndexOf(true);
    expect(last).toBeGreaterThan(0);
    const later = requests.slice(last + 1);
    expect(later.some(sessionCookie)).toBe(false);
    const env = later.find((r) => r.path === "/.env");
    expect(env, "the read-only checks ran after it, signed out").toBeDefined();
}

beforeAll(async () => {
    fixture = await startSecurityFixture(7210, 7211, { pages: 6 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-secexp-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", WORKER_EMBEDDED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true" }));
    server = await buildServer(platform);
    store = new SecurityStore(platform.db);
    projectId = platform.repo.createProject({ name: "Session client" }).id as string;
    const r = await api("POST", `${API}/projects/${projectId}/applications`, { name: "Fixture shop", targetUrl: `${fixture.origin}/`, environment: "development", excludedPaths: ["/admin"], maxRequestsPerSecond: 10, signInAccount: "main" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    appId = r.json.application.id;
    const auth = await api("POST", `${API}/applications/${appId}/authorizations`, { basis: "owner", approverName: "Test Owner", confirm: true });
    expect(auth.status, JSON.stringify(auth.json)).toBe(201);
}, 60_000);

afterAll(async () => {
    for (const b of launched) await b.close().catch(() => undefined);
    await server?.close();
    platform?.db.close?.();
    await fixture?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a saved sign-in that stops working during the assessment (real browser)", () => {
    it("re-opening the signed-in page finds it: later pages and the checks are signed out, and the coverage says from which point", async () => {
        const { a, requests, ended } = await assess({ checkUrl: "/account", sessionLasts: 5, every: 2 });
        expect(["COMPLETED", "PARTIALLY_COMPLETED"], JSON.stringify(a)).toContain(a.state);
        expect(ended).toMatchObject({ when: "discovery", url: "/account", reason: "answered HTTP 401" });
        expect(ended!.lastOkAfterPages).toBeGreaterThanOrEqual(2);
        expect(ended!.afterPages).toBeGreaterThan(ended!.lastOkAfterPages);
        const coverage = a.coverage!.notInspected;
        expect(coverage).toContain(signInEndedSentence(LABEL, ended!));
        expect(coverage.join("\n")).toMatch(/stopped working after \d+ pages \(the signed-in page \/account answered HTTP 401; it last worked after \d+ pages\); signed-in pages after that were not inspected\. Save the sign-in again in Settings\./);
        expect(coverage.join("\n")).not.toMatch(/^Signed in with the saved sign-in/m);
        // What was seen is kept: the signed-in pages seen before it ended, and pages after it.
        expect(a.coverage!.pagesSeen).toBeGreaterThan(ended!.afterPages);
        expect(requests.some((r) => r.path === "/account" && sessionCookie(r))).toBe(true);
        expectNothingSignedInAfterwards(requests);
        expectReadOnly(requests);
    }, 200_000);

    it("without a signed-in page the browser's cookies tell: the app removed the session cookie", async () => {
        const { a, requests, ended } = await assess({ sessionLasts: 4, every: 2 });
        expect(a.state).not.toBe("FAILED");
        expect(ended).toMatchObject({ when: "discovery", url: null, reason: "its cookies were removed or ran out" });
        expect(a.coverage!.notInspected.join("\n")).toMatch(/The saved sign-in for the project's own account stopped working after \d+ pages \(its cookies were removed or ran out(; it last worked after \d+ pages)?\); signed-in pages after that were not inspected\./);
        expectNothingSignedInAfterwards(requests);
        expectReadOnly(requests);
    }, 200_000);

    it("found only right before the read-only checks: they are made signed out, and the coverage says so", async () => {
        // No re-check while looking at the pages (every 100 pages): only the first look and the check before the read-only checks.
        const { a, requests, ended } = await assess({ checkUrl: "/account", sessionLasts: 5, every: 100 });
        expect(a.state).not.toBe("FAILED");
        expect(ended).toMatchObject({ when: "before-checks", url: "/account", reason: "answered HTTP 401", lastOkAfterPages: 2 });
        const text = a.coverage!.notInspected.join("\n");
        expect(text).toMatch(/The saved sign-in for the project's own account no longer worked when the read-only checks started \(the signed-in page \/account answered HTTP 401; it last worked after 2 pages\); the read-only checks were made signed out\. Pages after the first 2 pages may have been looked at signed out\./);
        expectNothingSignedInAfterwards(requests);
        expectReadOnly(requests);
    }, 200_000);

    it("a sign-in that keeps working is re-checked without changing anything", async () => {
        const { a, requests, ended } = await assess({ checkUrl: "/account", sessionLasts: 10_000, every: 2 });
        expect(a.state).not.toBe("FAILED");
        expect(ended).toBeNull();
        expect(a.coverage!.notInspected.join("\n")).toContain("Signed in with the saved sign-in for the project's own account");
        // The re-checks opened the signed-in page again, signed in; the read-only checks carried the session too.
        expect(requests.filter((r) => r.path === "/account" && sessionCookie(r)).length).toBeGreaterThan(1);
        expect(requests.some((r) => r.path === "/.env" && sessionCookie(r))).toBe(true);
        expectReadOnly(requests);
    }, 200_000);
});
