/**
 * The external scanner stage and the request guard (src/security/scanners/orchestration/run.ts):
 *   - a scanner run in which the guard allowed no request (everything refused) ends FAILED and none of its findings are used;
 *   - whether private targets are allowed comes from the platform's loaded setting (`allowPrivateTargets`), never from the process
 *     environment, so the scanners and the platform's own checks cannot disagree.
 *
 * A local target on loopback port 9527 and a fake scanner that sends its requests through the guard's proxy. No real tool, no browser.
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-assessment-run-scanner-guard.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import type { ScannerAdapter, ScanResultSet, ScanTarget } from "../src/security/scanners/contract.js";
import { runScanners } from "../src/security/scanners/orchestration/run.js";
import { scannerSettings } from "../src/security/scanners/settings.js";
import { setProjectScanners } from "../src/security/scanners/store.js";
import { SecurityStore } from "../src/security/store.js";

const PORT = 9527;
const T = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-scan-guard-"));
const received: string[] = [];
let target: http.Server;

beforeAll(async () => {
    target = http.createServer((req, res) => {
        received.push(`${req.method} ${req.url}`);
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
    });
    await new Promise<void>((r) => target.listen(PORT, "127.0.0.1", r));
});
afterAll(async () => {
    await new Promise((r) => target.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
});

/** One request through the guard's HTTP proxy (absolute-form), answered with its status. */
function viaProxy(proxyUrl: string, method: string, url: string): Promise<number> {
    const p = new URL(proxyUrl);
    return new Promise((resolve) => {
        const req = http.request({ host: p.hostname, port: Number(p.port), method, path: url, headers: { host: new URL(url).host } }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", () => resolve(0));
        req.end();
    });
}

/** A fake scanner: sends `requests` through the guard, then reports one finding. */
function fake(requests: Array<[string, string]>): ScannerAdapter {
    return {
        id: "nuclei",
        name: "Fake scanner",
        documentationUrl: "https://example.com",
        description: "fake",
        capabilities: { progress: false, cancel: false, sharedDaemon: false, specDriven: false, aiDriven: false, egressProxy: true },
        available: async () => ({ scanner: "nuclei", state: "available", checkedAt: new Date().toISOString() }),
        validateConfig: async () => ({ ok: true, problems: [], checked: [] }),
        supports: () => true,
        validateScope: async (t: ScanTarget) => ({ ok: true, allowed: t.urls, refused: [] }),
        async start(t: ScanTarget) {
            for (const [method, url] of requests) await viaProxy(t.egress!.proxyUrl, method, url);
            const results: ScanResultSet = { findings: [{ scannerRuleId: "r1", title: "A finding", severity: "low", category: "configuration", url: `${T}/`, description: "d", evidence: [{ kind: "note", label: "l", value: "v" }] }], coverage: { inspected: ["looked"], notInspected: [] }, reference: "fake-1" };
            return { scanner: "nuclei", reference: "fake-1", progress: async () => ({ percent: 100, message: "", done: true }), cancel: async () => undefined, results: async () => results, cleanup: async () => undefined };
        },
    } as unknown as ScannerAdapter;
}

function withDb() {
    const dir = fs.mkdtempSync(path.join(tmp, "db-"));
    const db = new Db(path.join(dir, "t.db"));
    const repo = new Repo(db, new SecretBox(dir));
    const projectId = repo.createProject({ name: "Client" }).id;
    const store = new SecurityStore(db);
    const application = store.createApplication(projectId, { name: "Shop", targetUrl: `${T}/`, environment: "staging", scope: [], excludedPaths: ["/admin"], maxRequestsPerSecond: 10 });
    const authorization = store.addAuthorization(application.id, { basis: "owner", approverName: "Owner", documentReference: null, restrictions: null, statement: "I confirm.", confirmedByName: "Tester" });
    const assessment = store.createAssessment({ applicationId: application.id, authorizationId: authorization.id, startedBy: "Tester" });
    setProjectScanners(db, projectId, ["nuclei"]);
    return { db, application, assessmentId: assessment.id };
}
const settings = scannerSettings({ SECURITY_SCANNERS: "nuclei", SECURITY_SCANNER_MAX_RPS: "50", SECURITY_SCANNER_REQUEST_BUDGET: "500" });
const base = (d: ReturnType<typeof withDb>) => ({ db: d.db, application: d.application, assessmentId: d.assessmentId, profile: "passive" as const, signal: new AbortController().signal, target: { urls: [`${T}/`], origin: T }, settings });

describe("the scanner stage and the request guard", () => {
    it("a run whose every request the guard refused ends FAILED, and its findings are not used", async () => {
        const d = withDb();
        received.length = 0;
        const out = await runScanners({ ...base(d), adapters: [fake([["POST", `${T}/`], ["GET", `${T}/admin`]])], egress: { allowPrivate: true } });
        expect(received).toEqual([]);
        expect(out.outcomes[0]).toMatchObject({ state: "FAILED", findings: 0 });
        expect(out.outcomes[0]!.reason).toMatch(/had none of its 2 requests allowed by the platform's request guard.*not used/);
        expect(out.results).toEqual([]);
        d.db.close();
    });

    it("one allowed request is enough: the run completes and its findings are used", async () => {
        const d = withDb();
        received.length = 0;
        const out = await runScanners({ ...base(d), adapters: [fake([["POST", `${T}/`], ["GET", `${T}/`]])], egress: { allowPrivate: true } });
        expect(received).toEqual(["GET /"]);
        expect(out.outcomes[0]!.state).toBe("COMPLETED");
        expect(out.results).toHaveLength(1);
        d.db.close();
    });

    it("private targets follow the platform's loaded setting, not the process environment", async () => {
        const before = process.env.SECURITY_ALLOW_PRIVATE_TARGETS;
        process.env.SECURITY_ALLOW_PRIVATE_TARGETS = "true";
        try {
            // The environment says yes, the platform's setting was not given (off): the loopback target is refused.
            const off = withDb();
            received.length = 0;
            const refused = await runScanners({ ...base(off), adapters: [fake([["GET", `${T}/`]])], egress: {} });
            expect(received).toEqual([]);
            expect(refused.outcomes[0]!.state).toBe("FAILED");
            off.db.close();
            // The platform's setting allows it: the same request goes through.
            const on = withDb();
            const allowed = await runScanners({ ...base(on), adapters: [fake([["GET", `${T}/`]])], egress: {}, allowPrivateTargets: true });
            expect(received).toEqual(["GET /"]);
            expect(allowed.outcomes[0]!.state).toBe("COMPLETED");
            on.db.close();
        } finally {
            if (before === undefined) delete process.env.SECURITY_ALLOW_PRIVATE_TARGETS;
            else process.env.SECURITY_ALLOW_PRIVATE_TARGETS = before;
        }
    });
});
