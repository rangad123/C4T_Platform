/**
 * The start gate is judged again while an assessment above passive is queued or running (a security review finding), not only at start:
 * when the loop claims or picks it up, before the external scanners (and before each one), and every few seconds while it runs.
 * A withdrawn approval, an approver who was disabled, a newer (narrower) client authorization, or the server switch turned off stops it
 * with a plain sentence; withdrawing an approval stops the assessment at that profile; the cross-account step uses the accounts the
 * CURRENT authorization names.
 *
 * Nothing is requested from any application: the steps that would touch it are a stand-in "runner" (onRunner) that only waits, or work
 * data that says they were already done. The Crowd4Test sign-in is a stand-in on loopback (port 9526). No browser.
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-profile-gate-running.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { emptyDiscovery } from "../src/security/assessment/discover.js";
import { AssessmentLoop, GATE_UNCHECKED_WORDS, type RunnerDeps } from "../src/security/assessment/runner.js";
import { FINISHED_STATES, type SecurityApplication, type SecurityAssessment } from "../src/security/contract.js";
import { writeDesignation } from "../src/security/cross-account-store.js";
import { addApproval, GATE_WORDS, scanApprovalOf, withdrawApproval } from "../src/security/profile-gate.js";
import type { ScannerAdapter } from "../src/security/scanners/contract.js";
import { runScanners } from "../src/security/scanners/orchestration/run.js";
import { scannerSettings } from "../src/security/scanners/settings.js";
import { listRuns, runsOfAssessment, setProjectScanners } from "../src/security/scanners/store.js";
import { securitySettings } from "../src/security/settings.js";
import { securityStoreFor, type AuthorizationInput, type SecurityStore } from "../src/security/store.js";

const API = "/api/v1/security";
const TITLE = "Conservative active checks";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-gate-run-"));
let c4t: http.Server;
let platform: Platform;
let server: FastifyInstance;
let store: SecurityStore;
let projectId: string;
let adminId: string;

const me = { data: { user: { id: "ada", email: "ada@people.example", role: "ADMIN", status: "ACTIVE", firstName: "Ada", lastName: "Person", emailVerified: true, permissions: PERMISSIONS, organisationId: null } } };
const admin = async (method: string, url: string) => {
    const r = await server.inject({ method: method as never, url, headers: { cookie: "c4t_access=t-admin", ...(method === "GET" ? {} : { "x-requested-with": "ai-studio" }) } });
    return { status: r.statusCode, body: JSON.parse(r.body) };
};

const auth = (extra: Partial<AuthorizationInput> = {}): AuthorizationInput => ({
    basis: "owner",
    approverName: "Client Person",
    approverRole: "Head of Engineering",
    approverEmail: "person@client.example",
    documentReference: "SOW-1",
    authority: "Signed SOW-1.",
    statement: "I confirm.",
    confirmedByName: "Owner",
    maxProfile: "advanced",
    ...extra,
});

beforeAll(async () => {
    c4t = http.createServer((req, res) => {
        const ok = String(req.headers.authorization ?? "") === "Bearer t-admin";
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? me : { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(9526, "127.0.0.1", r));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECURITY_ACTIVE_PROFILES: "on", C4T_API_ORIGIN: "http://127.0.0.1:9526", C4T_SITE_URL: "https://crowd4test.example" } as never));
    server = await buildServer(platform);
    await server.ready();
    store = securityStoreFor(platform.db);
    projectId = platform.repo.createProject({ name: "Client" }).id as string;
    adminId = (await admin("GET", "/api/auth/state")).body.me.id;
    expect(platform.db.get<{ c4t_role: string }>("SELECT c4t_role FROM users WHERE id = ?", adminId)?.c4t_role).toBe("ADMIN");
}, 60_000);

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

/** An application authorized up to advanced and approved by the Crowd4Test admin at conservative-active, with a queued assessment at it. */
function queued(name: string): { app: SecurityApplication; id: string; approvalId: string } {
    const app = store.createApplication(projectId, { name, targetUrl: `https://${name.toLowerCase().replace(/\W+/g, "-")}.example.com/`, environment: "staging" });
    const a = store.addAuthorization(app.id, auth());
    const approval = addApproval(platform.db, app.id, { profile: "conservative-active", environment: "staging", statement: "s", byUserId: adminId, byName: "Ada Person" });
    const created = store.createAssessment({ applicationId: app.id, authorizationId: a.id, startedBy: "Eve", kind: "conservative-active", approval: scanApprovalOf(approval) });
    return { app, id: created.id, approvalId: approval.id };
}

const finished = (id: string) => {
    const a = store.getAssessment(id)!;
    return FINISHED_STATES.includes(a.state) ? a : undefined;
};
async function waitFor<T>(fn: () => T | undefined | false, ms: number, what: string): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

/** Loop dependencies: the steps that touch the application run on a stand-in runner that sends nothing (by default it only waits). */
function deps(over: Partial<RunnerDeps> = {}, gate: Partial<NonNullable<RunnerDeps["gate"]>> = {}): RunnerDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        db: platform.db,
        settings: { ...securitySettings(platform.config), activeProfiles: true },
        headless: true,
        guardFor: () => {
            throw new Error("nothing is requested in this test");
        },
        gate: { activeProfilesOn: true, crowd4testOn: true, isolationProblem: () => undefined, ...gate },
        onRunner: async (o) => {
            calls.push(o.assessment.id);
            await new Promise((r) => o.signal.addEventListener("abort", r, { once: true }));
            throw new Error("stopped");
        },
        ...over,
    };
}

async function run(d: RunnerDeps, id: string, during?: () => Promise<void> | void): Promise<SecurityAssessment> {
    const loop = new AssessmentLoop(d, 50);
    loop.start();
    try {
        await during?.();
        return await waitFor(() => finished(id), 30_000, `assessment ${id} to finish`);
    } finally {
        await loop.stop();
    }
}

/** A stand-in scanner that records being started (and then fails): nothing is installed or sent. */
function fakeNuclei(onStart: () => void): ScannerAdapter {
    return {
        id: "nuclei",
        name: "NUCLEI",
        documentationUrl: "https://example.com",
        description: "fake",
        capabilities: { progress: false, cancel: false, sharedDaemon: false, specDriven: false, aiDriven: false },
        available: async () => ({ scanner: "nuclei", state: "available", checkedAt: new Date().toISOString() }),
        validateConfig: async () => ({ ok: true, problems: [], checked: [] }),
        supports: () => true,
        validateScope: async (t: { urls: string[] }) => ({ ok: true, allowed: t.urls, refused: [] }),
        start: async () => {
            onStart();
            throw new Error("must not start");
        },
    } as unknown as ScannerAdapter;
}

describe("the gate while an assessment above passive is queued or running", () => {
    it("claim: an approval withdrawn while it was queued stops it before anything is requested", async () => {
        const q = queued("Claim withdrawn");
        withdrawApproval(platform.db, q.approvalId, "Ada Person");
        const d = deps();
        const end = await run(d, q.id);
        expect(d.calls).toEqual([]);
        expect(end.state).toBe("CANCELLED");
        expect(end.progressText).toBe(`${GATE_WORDS.stopped(GATE_WORDS.notApproved(TITLE, "staging"))} Nothing was requested.`);
    });

    it("reclaim: SECURITY_ACTIVE_PROFILES turned off before an interrupted assessment is picked up again stops it, keeping what was seen", async () => {
        const q = queued("Reclaim switched off");
        store.setWorkData(q.id, { attempts: 1, discovery: emptyDiscovery(q.app.targetUrl), discoveryDone: true });
        const d = deps({ settings: { ...securitySettings(platform.config), activeProfiles: false } }, { activeProfilesOn: false });
        const end = await run(d, q.id);
        expect(d.calls).toEqual([]);
        expect(end.state).toBe("CANCELLED");
        expect(end.progressText).toContain(GATE_WORDS.stopped(GATE_WORDS.switchedOff));
        expect(end.progressText).toMatch(/What was seen until then is kept/);
    });

    it("running: the approver's account is disabled, so the approval stops counting and the assessment stops", async () => {
        const q = queued("Running disabled admin");
        const d = deps();
        try {
            const end = await run(d, q.id, async () => {
                await waitFor(() => d.calls.length > 0, 10_000, "the runner to take it");
                platform.db.run("UPDATE users SET status = 'disabled' WHERE id = ?", adminId);
            });
            expect(end.state).toBe("CANCELLED");
            expect(end.progressText).toContain(GATE_WORDS.stopped(GATE_WORDS.notApproved(TITLE, "staging")));
        } finally {
            platform.db.run("UPDATE users SET status = 'active' WHERE id = ?", adminId);
        }
    }, 40_000);

    it("running: the client narrows consent (a newer passive authorization), so it stops instead of going on at the old profile", async () => {
        const q = queued("Running narrowed");
        const d = deps();
        const end = await run(d, q.id, async () => {
            await waitFor(() => d.calls.length > 0, 10_000, "the runner to take it");
            store.addAuthorization(q.app.id, auth({ maxProfile: "passive" }));
        });
        expect(end.state).toBe("CANCELLED");
        expect(end.progressText).toContain(GATE_WORDS.stopped(GATE_WORDS.authorizationReplaced(TITLE)));
    }, 40_000);

    it("withdrawing the approval stops the assessment at that profile (as revoking an authorization does)", async () => {
        const q = queued("Withdraw route");
        const r = await admin("DELETE", `${API}/applications/${q.app.id}/approvals/${q.approvalId}`);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.stoppedAssessmentId).toBe(q.id);
        const a = store.getAssessment(q.id)!;
        expect(a.state).toBe("CANCELLED");
        expect(a.progressText).toBe(`${GATE_WORDS.stopped(GATE_WORDS.approvalWithdrawn(TITLE))} Nothing was requested.`);
    });

    it("before the scanners: an approval withdrawn after the read-only steps means no scanner runs and it stops", async () => {
        const q = queued("Before scanners");
        setProjectScanners(platform.db, projectId, ["nuclei"]);
        const started: string[] = [];
        const fake = fakeNuclei(() => started.push("nuclei"));
        const d = deps({
            scanners: { adapters: [fake], settings: scannerSettings({ SECURITY_SCANNERS: "nuclei" }) },
            onRunner: async () => {
                withdrawApproval(platform.db, q.approvalId, "Ada Person");
                return { work: { discovery: { ...emptyDiscovery(q.app.targetUrl), pages: [{ url: q.app.targetUrl }] } as never, discoveryDone: true, scan: { results: [], outcomes: [], capReached: false, requested: 0 } }, extra: [] };
            },
        });
        const end = await run(d, q.id);
        expect(started).toEqual([]);
        expect(end.state).toBe("CANCELLED");
        expect(end.progressText).toContain(GATE_WORDS.stopped(GATE_WORDS.notApproved(TITLE, "staging")));
        // Nothing of the scanner stage is left behind: no scanner run row and no "was not run" line. The runner's own check before the
        // stage is a backstop here — the orchestration refuses before writing anything too (a mutation check showed both paths agree).
        expect(platform.db.all("SELECT id FROM security_scan_runs WHERE assessment_id = ?", q.id)).toEqual([]);
        expect((end.coverage?.notInspected ?? []).some((l: string) => /was not run:/.test(l))).toBe(false);
    });

    it("the cross-account step uses the accounts the CURRENT authorization names, not the replaced one's", async () => {
        const app = store.createApplication(projectId, { name: "Cross account", targetUrl: "https://cross.example.com/", environment: "staging" });
        writeDesignation(platform.db, app.id, { accountA: "alice", accountB: "bob", resources: [{ path: "/api/notes/1", kind: "item", owner: "B" }] }, null);
        const a1 = store.addAuthorization(app.id, auth({ maxProfile: "passive", crossAccounts: ["alice", "bob"] }));
        const created = store.createAssessment({ applicationId: app.id, authorizationId: a1.id, startedBy: "Eve" });
        store.addAuthorization(app.id, auth({ maxProfile: "passive" }));
        // The read-only steps were already done (nothing is requested); no saved sign-ins can be read here.
        store.setWorkData(created.id, { attempts: 0, discovery: emptyDiscovery(app.targetUrl), discoveryDone: true, scan: { results: [], outcomes: [], capReached: false, requested: 0 } });
        const guard = { ready: async () => undefined, fetch: async () => Promise.reject(new Error("nothing is requested")) };
        const end = await run(deps({ onRunner: undefined, guardFor: () => guard as never }), created.id);
        expect(end.coverage?.notInspected.join("\n")).toContain("Cross-account checks were not made: the current authorization does not name the test account “alice” and the test account “bob”.");
    });
});

describe("a gate that cannot be checked, and a restart during the scanners", () => {
    it("running: a gate check that keeps failing stops the assessment after a few tries, in plain words", async () => {
        const q = queued("Gate unreadable");
        let broken = false;
        const d = deps({}, {
            isolationProblem: () => {
                if (broken) throw new Error("ENOSPC: no space left on device");
                return undefined;
            },
        });
        const end = await run(d, q.id, async () => {
            await waitFor(() => d.calls.length > 0, 10_000, "the runner to take it");
            broken = true;
        });
        expect(end.state).toBe("CANCELLED");
        expect(end.progressText).toContain(GATE_UNCHECKED_WORDS);
    }, 60_000);

    it("running: a cancel is honoured even while the gate check keeps failing", async () => {
        const q = queued("Gate unreadable cancel");
        let broken = false;
        const d = deps({}, {
            isolationProblem: () => {
                if (broken) throw new Error("ENOSPC: no space left on device");
                return undefined;
            },
        });
        const end = await run(d, q.id, async () => {
            await waitFor(() => d.calls.length > 0, 10_000, "the runner to take it");
            broken = true;
            store.requestCancel(q.id);
        });
        expect(end.state).toBe("CANCELLED");
        expect(end.progressText).toMatch(/^Cancelled/);
    }, 60_000);

    it("a restart during the scanner stage runs the stage again after pickup instead of skipping the scanners that had not run", async () => {
        const app = store.createApplication(projectId, { name: "Restart scanners", targetUrl: "https://restart.example.com/", environment: "staging" });
        const authz = store.addAuthorization(app.id, auth({ maxProfile: "passive" }));
        const created = store.createAssessment({ applicationId: app.id, authorizationId: authz.id, startedBy: "Eve" });
        setProjectScanners(platform.db, projectId, ["nuclei"]);
        let starts = 0;
        let first: AssessmentLoop | undefined;
        const tool = {
            ...fakeNuclei(() => undefined),
            start: async (_t: unknown, _p: unknown, o: { signal: AbortSignal }) => {
                if (++starts === 1) {
                    // The platform restarts while the first scanner runs: this loop loses the assessment.
                    void first!.stop();
                    await new Promise((r) => (o.signal.aborted ? r(undefined) : o.signal.addEventListener("abort", r, { once: true })));
                    throw new Error("stopped");
                }
                const finding = { scannerRuleId: "fake:1", title: "Seen after pickup", severity: "low", category: "configuration", url: app.targetUrl, description: "d", evidence: [{ kind: "note", label: "l", value: "v" }] };
                return { scanner: "nuclei", reference: null, progress: async () => ({ percent: 100, message: "", done: true }), cancel: async () => undefined, results: async () => ({ findings: [finding], coverage: { inspected: ["The fake tool looked."], notInspected: ["The fake tool skipped nothing."] }, reference: null }), cleanup: async () => undefined };
            },
        } as unknown as ScannerAdapter;
        const d = deps({
            scanners: { adapters: [tool], settings: scannerSettings({ SECURITY_SCANNERS: "nuclei" }) },
            onRunner: async () => ({ work: { discovery: { ...emptyDiscovery(app.targetUrl), pages: [{ url: app.targetUrl }] } as never, discoveryDone: true, scan: { results: [], outcomes: [], capReached: false, requested: 0 } }, extra: [] }),
        });
        first = new AssessmentLoop(d, 50);
        first.start();
        await waitFor(() => starts >= 1, 20_000, "the first scanner to start");
        await first.stop();
        // The interrupted stage left nothing saying it was done.
        expect((store.getWorkData<{ scanners?: unknown }>(created.id) ?? {}).scanners).toBeUndefined();
        expect(finished(created.id)).toBeUndefined();
        // The next loop picks it up once the lease has run out, and runs the scanner again.
        platform.db.run("UPDATE security_assessments SET lease_until = 0 WHERE id = ?", created.id);
        const end = await run(d, created.id);
        expect(starts).toBe(2);
        expect(end.state).toBe("COMPLETED");
        expect(end.coverage?.notInspected.join("\n")).toContain("The fake tool skipped nothing.");
        // The interrupted attempt's run is superseded, so the run lists show the scanner once; its row stays.
        expect(platform.db.all("SELECT id FROM security_scan_runs WHERE assessment_id = ? AND scanner = 'nuclei'", created.id)).toHaveLength(2);
        expect(runsOfAssessment(platform.db, created.id).map((r) => `${r.scanner} ${r.state}`)).toEqual(["nuclei COMPLETED"]);
        expect(listRuns(platform.db, projectId).filter((r) => r.assessmentId === created.id)).toHaveLength(1);
        const scans = await admin("GET", `/api/v1/security/assessments/${created.id}/scans`);
        expect(scans.status).toBe(200);
        expect((scans.body.runs as Array<{ scanner: string }>).map((r) => r.scanner)).toEqual(["nuclei"]);
    }, 60_000);
});

describe("the scanner orchestration asks the gate before each tool", () => {
    it("a refusal means the tool is never started, with the plain reason", async () => {
        const app = store.createApplication(projectId, { name: "Orchestration", targetUrl: "https://orch.example.com/", environment: "staging" });
        const a = store.addAuthorization(app.id, auth({ maxProfile: "passive" }));
        const created = store.createAssessment({ applicationId: app.id, authorizationId: a.id, startedBy: "Eve" });
        setProjectScanners(platform.db, projectId, ["nuclei"]);
        let starts = 0;
        const fake = fakeNuclei(() => starts++);
        let refuse: string | undefined;
        const input = { db: platform.db, application: app, assessmentId: created.id, profile: "passive" as const, signal: new AbortController().signal, target: { urls: [app.targetUrl], origin: "https://orch.example.com" }, settings: scannerSettings({ SECURITY_SCANNERS: "nuclei" }), adapters: [fake], gateRefusal: () => refuse };
        // Refused before any tool: nothing starts.
        refuse = "The authorization was revoked.";
        const out = await runScanners(input);
        expect(starts).toBe(0);
        expect(out.health.find((h) => h.id === "nuclei")?.reason).toBe("NUCLEI was not run: The authorization was revoked.");
        // Refused only once the loop reaches the tool: still never started, recorded as not run with the reason.
        let asked = 0;
        const later = await runScanners({ ...input, gateRefusal: () => (asked++ === 0 ? undefined : "The approval was withdrawn.") });
        expect(starts).toBe(0);
        expect(later.outcomes).toMatchObject([{ scanner: "nuclei", state: "FAILED", reason: "NUCLEI was not run: The approval was withdrawn." }]);
    });
});
