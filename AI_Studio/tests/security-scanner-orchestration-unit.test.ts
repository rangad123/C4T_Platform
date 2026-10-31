/**
 * The orchestration between an assessment and the scanners it may run: which tools are allowed, what happens when one of them fails,
 * what one project's allow-list means for another project, and that a scanner is never handed an address outside the scope.
 *
 * Everything here uses a fake adapter, so the point is the platform's own behaviour rather than a tool's. No tool is started, and the
 * database is real, so tenant isolation is a property of the schema and not of a mock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScannerError } from "../src/security/scanners/contract.js";
import type { ScanIntensity, ScannerAdapter, ScannerAvailability, ScannerFinding, ScanResultSet, ScannerScopeCheck, ScanTarget } from "../src/security/scanners/contract.js";
import { buildTarget, profileStatementFor, runScanners, scannerCoverageLines, scannerErrorMessage } from "../src/security/scanners/orchestration/run.js";
import { adaptersForProject, allAdapters, profileProblem, scannerHealth, usableAdapters } from "../src/security/scanners/registry.js";
import { scannerSettings } from "../src/security/scanners/settings.js";
import { projectScanners, setProjectScanners } from "../src/security/scanners/store.js";
import type { SecurityApplication } from "../src/security/contract.js";
import { SecurityStore } from "../src/security/store.js";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";

const setting = (...ids: string[]) => scannerSettings({ SECURITY_SCANNERS: ids.join(","), SECURITY_SCANNER_MAX_RPS: "50", SECURITY_SCANNER_REQUEST_BUDGET: "500" });

const dirs: string[] = [];
/**
 * A real database with two projects, and a real application, authorization and assessment in the first one, so tenant isolation and the
 * scanner run table's foreign keys are properties of the schema rather than of a mock.
 */
function withDb(): { db: Db; store: SecurityStore; pA: string; pB: string; app: SecurityApplication; assessmentId: string; close(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-scan-orch-"));
    dirs.push(dir);
    const db = new Db(path.join(dir, "t.db"));
    const repo = new Repo(db, new SecretBox(dir));
    const pA = repo.createProject({ name: "Client A" }).id;
    const pB = repo.createProject({ name: "Client B" }).id;
    const store = new SecurityStore(db);
    const app = store.createApplication(pA, { name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging", scope: [], excludedPaths: ["/admin"], maxRequestsPerSecond: 3 });
    const authorization = store.addAuthorization(app.id, { basis: "owner", approverName: "Dana", documentReference: null, restrictions: null, statement: "I confirm I am authorized to test this application.", confirmedByName: "Olga" });
    const assessment = store.createAssessment({ applicationId: app.id, authorizationId: authorization.id, startedBy: "Olga" });
    return { db, store, pA, pB, app, assessmentId: assessment.id, close: () => db.close() };
}
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** One fake tool, so the orchestration's own behaviour can be tested with nothing installed. */
function fake(id: "zap" | "nuclei" | "schemathesis" | "promptfoo", opts: { state?: ScannerAvailability["state"]; findings?: ScannerFinding[]; fail?: string } = {}): ScannerAdapter {
    const finding = (rule: string): ScannerFinding => ({ scannerRuleId: rule, title: `${id} says ${rule}`, severity: "medium", category: "configuration", url: "https://shop.example.com/x", description: "d", evidence: [{ kind: "note", label: "l", value: "v" }] });
    return {
        id,
        name: id.toUpperCase(),
        documentationUrl: "https://example.com",
        description: "fake",
        capabilities: { progress: false, cancel: false, sharedDaemon: false, specDriven: id === "schemathesis", aiDriven: id === "promptfoo" },
        async available(): Promise<ScannerAvailability> {
            return { scanner: id, state: opts.state ?? "available", checkedAt: "2026-01-01T00:00:00.000Z", ...(opts.state && opts.state !== "available" ? { reason: `${id} is not available here.`, remedy: "install it" } : {}) };
        },
        async validateConfig() {
            return { ok: true, problems: [], checked: [] };
        },
        supports: (_profile: ScanIntensity) => true,
        async validateScope(target: ScanTarget): Promise<ScannerScopeCheck> {
            const allowed = target.urls.filter((u) => !u.includes("/admin"));
            return { ok: allowed.length > 0, allowed, refused: target.urls.filter((u) => u.includes("/admin")).map((u) => ({ url: u, code: "excluded-path" as const, reason: "excluded" })) };
        },
        async start() {
            if (opts.fail) throw new ScannerError("tool_failed", id, opts.fail, "detail");
            return {
                scanner: id,
                reference: `${id}-run-1`,
                progress: async () => ({ percent: 100, message: "done", done: true }),
                cancel: async () => undefined,
                results: async (): Promise<ScanResultSet> => ({
                    findings: opts.findings ?? [finding("rule-a"), finding("rule-b")],
                    coverage: { inspected: [`${id} looked at 3 addresses.`], notInspected: [`${id} did not check authorization between users.`] },
                    reference: `${id}-run-1`,
                }),
                cleanup: async () => undefined,
            };
        },
    };
}

const application = (projectId: string) => ({ id: "app1", projectId, name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging" as const, scope: [], excludedPaths: ["/admin"], maxRequestsPerSecond: 3, apiSpecUrl: null, notes: null, createdAt: "", updatedAt: "" });
const target = { urls: ["https://shop.example.com/"], origin: "https://shop.example.com" };
const signal = () => new AbortController().signal;

describe("which scanners a project may run", () => {
    it("runs none for a project that allows none, whatever is installed", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        const out = await runScanners({ db, application: app, assessmentId, profile: "passive", signal: signal(), target, settings: setting("zap", "nuclei"), adapters: [fake("zap"), fake("nuclei")] });
        expect(out.results).toEqual([]);
        expect(out.outcomes).toEqual([]);
        expect(out.health.find((h) => h.id === "zap")?.status).toBe("not-allowed");
        close();
    });

    it("runs only the tools the project allows, never one that is merely installed", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        setProjectScanners(db, pA, ["nuclei"]);
        const out = await runScanners({ db, application: app, assessmentId, profile: "passive", signal: signal(), target, settings: setting("zap", "nuclei"), adapters: [fake("zap"), fake("nuclei")] });
        expect(out.outcomes.filter((o) => o.state === "COMPLETED").map((o) => o.scanner)).toEqual(["nuclei"]);
        close();
    });

    it("gives one project's allow-list no authority over another project's targets", async () => {
        const { db, store, pA, pB, close } = withDb();
        setProjectScanners(db, pA, ["zap"]);
        expect(projectScanners(db, pB)).toEqual([]);
        // The application under test belongs to B, and only A ever allowed ZAP.
        const appB = store.createApplication(pB, { name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging", scope: [], excludedPaths: ["/admin"], maxRequestsPerSecond: 3 });
        const authorizationB = store.addAuthorization(appB.id, { basis: "owner", approverName: "Dana", statement: "I confirm I am authorized to test this application.", confirmedByName: "Olga" });
        const assessmentB = store.createAssessment({ applicationId: appB.id, authorizationId: authorizationB.id, startedBy: "Olga" });
        const out = await runScanners({ db, application: appB, assessmentId: assessmentB.id, profile: "passive", signal: signal(), target, settings: setting("zap"), adapters: [fake("zap")] });
        expect(out.outcomes).toEqual([]);
        expect(out.health.find((h) => h.id === "zap")?.status).toBe("not-allowed");
        close();
    });

    it("never runs a tool the platform did not switch on, even when the project asks for it", () => {
        expect(adaptersForProject(setting("zap"), ["zap", "nuclei"]).map((a) => a.id)).toEqual(["zap"]);
    });
});

describe("when a tool is missing, the assessment says so instead of looking clean", () => {
    it("records why it did not run and produces no findings for it", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        setProjectScanners(db, pA, ["zap", "nuclei"]);
        const out = await runScanners({ db, application: app, assessmentId, profile: "passive", signal: signal(), target, settings: setting("zap", "nuclei"), adapters: [fake("zap", { state: "unavailable" }), fake("nuclei")] });
        expect(out.results).toHaveLength(2);
        expect(out.outcomes.filter((o) => o.scanner === "zap")[0]).toMatchObject({ state: "SKIPPED", findings: 0 });
        const text = scannerCoverageLines(out.outcomes).join(" ");
        expect(text).toMatch(/did not run/);
        close();
    });

    it("names the tool's own state rather than hiding it", async () => {
        const { pA, close } = withDb();
        const health = await scannerHealth(setting("nuclei"), ["nuclei"], "passive", undefined, { resolve: () => [fake("nuclei", { state: "unavailable" })] });
        expect(health.find((h) => h.id === "nuclei")).toMatchObject({ status: "unavailable", reason: expect.stringContaining("not available") });
        expect(health.find((h) => h.id === "nuclei")?.remedy).toBe("install it");
        void pA;
        close();
    });

    it("reports a tool switched off for the platform separately from one not allowed for the project", async () => {
        const health = await scannerHealth(setting(), ["zap"], "passive", undefined, { resolve: () => [fake("zap")] });
        expect(health.find((h) => h.id === "zap")?.status).toBe("off");
        expect(health.find((h) => h.id === "zap")?.remedy).toContain("SECURITY_SCANNERS");
    });
});

describe("one tool failing never fails the assessment", () => {
    it("keeps the other tools' findings and records the failure in plain words", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        setProjectScanners(db, pA, ["zap", "nuclei"]);
        const out = await runScanners({ db, application: app, assessmentId, profile: "passive", signal: signal(), target, settings: setting("zap", "nuclei"), adapters: [fake("zap", { fail: "ZAP did not answer." }), fake("nuclei")] });
        expect(out.outcomes.map((o) => [o.scanner, o.state])).toEqual([["zap", "FAILED"], ["nuclei", "COMPLETED"]]);
        expect(out.results).toHaveLength(2);
        expect(scannerCoverageLines(out.outcomes).join(" ")).toContain("ZAP did not answer.");
        close();
    });

    it("keeps a scanner's own limitations in the coverage list, so a report cannot imply full coverage", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        setProjectScanners(db, pA, ["zap"]);
        const out = await runScanners({ db, application: app, assessmentId, profile: "passive", signal: signal(), target, settings: setting("zap"), adapters: [fake("zap")] });
        const text = scannerCoverageLines(out.outcomes).join(" ");
        expect(text).toContain("authorization between users");
        expect(text).toContain("2 findings");
        close();
    });

    it("folds one tool's repeated report of the same problem into one finding", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        setProjectScanners(db, pA, ["nuclei"]);
        const twice = [
            { scannerRuleId: "r", title: "t", severity: "low" as const, category: "configuration" as const, url: "https://shop.example.com/x", description: "d", evidence: [{ kind: "note" as const, label: "a", value: "1" }] },
            { scannerRuleId: "r", title: "t", severity: "high" as const, category: "configuration" as const, url: "https://shop.example.com/x", description: "d", evidence: [{ kind: "note" as const, label: "b", value: "2" }] },
        ];
        const out = await runScanners({ db, application: app, assessmentId, profile: "passive", signal: signal(), target, settings: setting("nuclei"), adapters: [fake("nuclei", { findings: twice })] });
        expect(out.results).toHaveLength(1);
        expect(scannerCoverageLines(out.outcomes).join(" ")).toMatch(/repeated the same rule/);
        close();
    });
});

describe("an intrusive profile needs its recorded approval", () => {
    it("runs nothing at an advanced profile without one, and says why", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        setProjectScanners(db, pA, ["zap"]);
        const out = await runScanners({ db, application: app, assessmentId, profile: "advanced", signal: signal(), target, settings: setting("zap"), adapters: [fake("zap")] });
        expect(out.results).toEqual([]);
        expect(out.health.find((h) => h.id === "zap")?.reason).toMatch(/approval/);
        close();
    });

    it("runs with one", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        setProjectScanners(db, pA, ["zap"]);
        const approval = { profile: "advanced" as const, approvedByUserId: "u1", approvedByName: "Ana", approvedAt: "2026-01-01T00:00:00.000Z", environment: "staging", statement: "approved" };
        const out = await runScanners({ db, application: app, assessmentId, profile: "advanced", approval, signal: signal(), target, settings: setting("zap"), adapters: [fake("zap")] });
        expect(out.outcomes.map((o) => o.state)).toEqual(["COMPLETED"]);
        close();
    });

    it("refuses an advanced profile for production, before anything starts", () => {
        expect(profileProblem("advanced", "production", true)).toMatch(/production/i);
        expect(profileProblem("advanced", "staging", false)).toMatch(/approval/i);
        expect(profileProblem("conservative-active", "production", false)).toBe("");
        expect(profileProblem("passive", "production", false)).toBe("");
    });
});

describe("the target a scanner is given", () => {
    const base = () => {
        const { db, pA, app, assessmentId, close } = withDb();
        return { db, application: app, assessmentId, close };
    };

    it("clamps the rate to the application's own", () => {
        const { db, application: app, assessmentId, close } = base();
        expect(buildTarget({ db, application: app, assessmentId, profile: "passive", signal: signal(), target, settings: setting("zap") }, fake("zap"), null).maxRequestsPerSecond).toBe(3);
        expect(buildTarget({ db, application: { ...app, maxRequestsPerSecond: 10 }, assessmentId, profile: "passive", signal: signal(), target, settings: setting("zap") }, fake("zap"), null).maxRequestsPerSecond).toBe(10);
        close();
    });

    it("gives the API document only to a spec-driven tool, and the AI interface only to an AI tool", () => {
        const { db, application: app, assessmentId, close } = base();
        const spec = { fileName: "openapi.json", text: "{}" };
        const ai = { kind: "http-chat" as const, url: "https://shop.example.com/ai" };
        const mk = (application2: unknown, id: "zap" | "schemathesis" | "promptfoo") => buildTarget({ db, application: application2 as never, assessmentId, profile: "passive", signal: signal(), target, settings: setting(), aiInterface: ai }, fake(id), spec);
        expect(mk(app, "schemathesis").spec).toEqual(spec);
        expect(mk(app, "zap").spec).toBeNull();
        expect(mk(app, "promptfoo").aiInterface).toEqual(ai);
        expect(mk(app, "zap").aiInterface).toBeNull();
        close();
    });

    it("carries the exclusions the client set, so a tool cannot reach them", () => {
        const { db, application: app, assessmentId, close } = base();
        expect(buildTarget({ db, application: app, assessmentId, profile: "passive", signal: signal(), target, settings: setting("zap") }, fake("zap"), null).excludedPaths).toEqual(["/admin"]);
        close();
    });

    it("never hands out an address under an excluded path", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        setProjectScanners(db, pA, ["zap"]);
        const out = await runScanners({ db, application: app, assessmentId, profile: "passive", signal: signal(), target: { urls: ["https://shop.example.com/", "https://shop.example.com/admin/secret"], origin: "https://shop.example.com" }, settings: setting("zap"), adapters: [fake("zap")] });
        expect(out.results.every((r) => !String(r.url).includes("/admin"))).toBe(true);
        close();
    });
});

describe("a stopped assessment", () => {
    it("runs no scanner at all once it has been cancelled", async () => {
        const { db, pA, app, assessmentId, close } = withDb();
        setProjectScanners(db, pA, ["zap", "nuclei"]);
        const controller = new AbortController();
        controller.abort();
        const out = await runScanners({ db, application: app, assessmentId, profile: "passive", signal: controller.signal, target, settings: setting("zap", "nuclei"), adapters: [fake("zap"), fake("nuclei")] });
        expect(out.results).toEqual([]);
        close();
    });

    it("words a timeout as a timeout and a stop as a stop", () => {
        expect(scannerErrorMessage(new ScannerError("timeout", "zap", "ZAP did not finish."))).toMatch(/time limit/);
        expect(scannerErrorMessage(new ScannerError("cancelled", "zap", "ZAP did not finish."))).toMatch(/stopped/);
        expect(scannerErrorMessage(new Error("ECONNREFUSED"))).toContain("ECONNREFUSED");
    });
});

describe("what the report is told about the run", () => {
    it("names the profile and the tools that actually ran", () => {
        const line = profileStatementFor("conservative-active", [{ scanner: "zap", state: "COMPLETED", reason: "", findings: 1, coverage: { inspected: [], notInspected: [] }, reference: null, tookMs: 10 }]);
        expect(line).toContain("conservative-active");
        expect(line).toContain("zap");
    });

    it("says 'none' rather than implying coverage when nothing ran", () => {
        expect(profileStatementFor("passive", [])).toContain("none");
    });

    it("never reports a tool as available that is not", async () => {
        const { adapters } = await usableAdapters(setting("zap"), ["zap"], "passive", undefined, { resolve: () => [fake("zap", { state: "misconfigured" })] });
        expect(adapters).toEqual([]);
        expect(allAdapters(setting("zap")).map((a) => a.id)).toEqual(["zap", "nuclei", "schemathesis", "promptfoo"]);
    });

    it("says what each tool covers, in words a client can read", async () => {
        const health = await scannerHealth(setting("zap"), ["zap"], "passive", undefined, { resolve: () => [fake("zap")] });
        const zap = health.find((h) => h.id === "zap")!;
        expect(zap.covers).toMatch(/Not covered/);
        expect(zap.purpose.length).toBeGreaterThan(20);
        expect(zap.documentationUrl).toBe("https://example.com");
    });
});
