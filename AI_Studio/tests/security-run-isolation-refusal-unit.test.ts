/**
 * Above passive a scanner runs inside the isolated network or not at all: even when the isolation proof
 * reports success while the machine's isolation support does not, the orchestration refuses the tool in plain words instead of running
 * it on the plain request guard. The proof is replaced here so that otherwise unreachable branch can be reached; no tool, no request.
 *   npx vitest run tests/security-run-isolation-refusal-unit.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/security/egress/isolation.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/security/egress/isolation.js")>()),
    // A proof that (wrongly) says yes on a machine that cannot isolate.
    proveIsolation: async () => ({ ok: true, line: "proved" }),
}));

const { runScanners } = await import("../src/security/scanners/orchestration/run.js");
const { setProjectScanners } = await import("../src/security/scanners/store.js");
const { scannerSettings } = await import("../src/security/scanners/settings.js");
const { SecurityStore } = await import("../src/security/store.js");
const { Db } = await import("../src/platform/db.js");
const { Repo } = await import("../src/platform/repo.js");
const { SecretBox } = await import("../src/platform/secrets.js");
import type { ScannerAdapter } from "../src/security/scanners/contract.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-run-iso-refusal-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("no scanner above passive without isolation", () => {
    it("refuses the tool, without starting it or a plain guard, when the isolation support is missing", async () => {
        const db = new Db(path.join(dir, "t.db"));
        try {
            const repo = new Repo(db, new SecretBox(dir));
            const projectId = repo.createProject({ name: "Client" }).id as string;
            const store = new SecurityStore(db);
            const app = store.createApplication(projectId, { name: "Shop", targetUrl: "http://127.0.0.1:9599/", environment: "staging", scope: [], excludedPaths: [], maxRequestsPerSecond: 2 });
            const authorization = store.addAuthorization(app.id, { basis: "owner", approverName: "Client", documentReference: null, restrictions: null, statement: "I confirm.", confirmedByName: "Owner" });
            const assessment = store.createAssessment({ applicationId: app.id, authorizationId: authorization.id, startedBy: "Owner" });
            setProjectScanners(db, projectId, ["nuclei"]);
            let started = 0;
            const tool = {
                id: "nuclei",
                name: "NUCLEI",
                documentationUrl: "https://example.com",
                description: "fake",
                capabilities: { progress: false, cancel: false, sharedDaemon: false, specDriven: false, aiDriven: false, egressProxy: true, egressIsolation: true },
                available: async () => ({ scanner: "nuclei", state: "available", checkedAt: new Date().toISOString() }),
                validateConfig: async () => ({ ok: true, problems: [], checked: [] }),
                supports: () => true,
                validateScope: async (t: { urls: string[] }) => ({ ok: true, allowed: t.urls, refused: [] }),
                start: async () => {
                    started++;
                    throw new Error("must not start");
                },
            } as unknown as ScannerAdapter;
            const out = await runScanners({
                db,
                application: app,
                assessmentId: assessment.id,
                profile: "conservative-active",
                approval: { profile: "conservative-active", approvedBy: "Admin", approvedAt: new Date().toISOString(), environment: "staging" } as never,
                signal: new AbortController().signal,
                target: { urls: ["http://127.0.0.1:9599/"], origin: "http://127.0.0.1:9599" },
                settings: scannerSettings({ SECURITY_SCANNERS: "nuclei" }),
                adapters: [tool],
                egress: { allowPrivate: true, isolation: { ok: false, missing: "unshare" } },
            });
            expect(started).toBe(0);
            expect(out.outcomes).toMatchObject([{ scanner: "nuclei", state: "FAILED" }]);
            expect(out.outcomes[0]!.reason).toMatch(/NUCLEI was not run: above passive a scanner runs only where it can reach nothing but the request guard/);
        } finally {
            db.close();
        }
    });
});
