/**
 * Fixes from the release audit that touch the server as a whole: two PDFs at a time (platform/pdf.ts), the address of a visitor behind the
 * site's own proxy (trustProxy, only with PUBLIC_URL), and no app file path in an imported spec's body (another project's file).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap } from "../src/platform/bootstrap.js";
import { HttpError } from "../src/platform/http-error.js";
import { PDF_BROWSERS_MAX, PDF_BUSY, withPdfSlot } from "../src/platform/pdf.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "fixes-owner-key-0a1b2c3d";
const dirs: string[] = [];
const PUBLIC_URL = process.env.PUBLIC_URL;
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    if (PUBLIC_URL === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = PUBLIC_URL;
});

const server = async (env: Record<string, string> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-fixes-"));
    dirs.push(dir);
    const app = await buildServer(bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "fixes-secret-key-0123456789", ...env })));
    app.get("/probe-ip", async (req) => ({ ip: req.ip }));
    await app.ready();
    return app;
};

describe("PDFs on a shared server", () => {
    it("makes at most two at a time and refuses a third with a plain 429, then takes one again", async () => {
        expect(PDF_BROWSERS_MAX).toBe(2);
        const gates: Array<() => void> = [];
        const slow = () => withPdfSlot(() => new Promise<string>((r) => gates.push(() => r("pdf"))));
        const a = slow();
        const b = slow();
        const third = await withPdfSlot(async () => "pdf").catch((e) => e);
        expect(third).toBeInstanceOf(HttpError);
        expect(third).toMatchObject({ status: 429, message: PDF_BUSY });
        gates.forEach((g) => g());
        expect(await Promise.all([a, b])).toEqual(["pdf", "pdf"]);
        expect(await withPdfSlot(async () => "again")).toBe("again");
        // a failure frees its place too
        await expect(withPdfSlot(async () => Promise.reject(new Error("no browser")))).rejects.toThrow("no browser");
        expect(await Promise.all([withPdfSlot(async () => 1), withPdfSlot(async () => 2)])).toEqual([1, 2]);
    });
});

describe("the visitor's address behind the site's own proxy", () => {
    it("believes x-forwarded-for from 127.0.0.1 only with PUBLIC_URL; without it nothing changes", async () => {
        const plain = await server();
        expect((await plain.inject({ url: "/probe-ip", headers: { "x-forwarded-for": "203.0.113.7" } })).json().ip).toBe("127.0.0.1");
        await plain.close();

        const behind = await server({ PUBLIC_URL: "https://aistudio.example" });
        expect((await behind.inject({ url: "/probe-ip", headers: { "x-forwarded-for": "203.0.113.7" } })).json().ip).toBe("203.0.113.7");
        // a request from anywhere but the proxy on this machine cannot claim an address
        expect((await behind.inject({ url: "/probe-ip", remoteAddress: "198.51.100.4", headers: { "x-forwarded-for": "203.0.113.7" } })).json().ip).toBe("198.51.100.4");
        await behind.close();
    });
});

describe("an imported spec cannot name an app file", () => {
    it("refuses mobile.apkPath in the body of POST /api/projects/:id/specs, and still takes an app package", async () => {
        const app = await server();
        const h = { "x-api-key": KEY };
        const proj = (await app.inject({ method: "POST", url: "/api/projects", headers: h, payload: { name: "p" } })).json();
        const spec = { testId: "MOB-001", title: "open", kind: "mobile", category: "c", steps: [{ action: "press", key: "device:back" }], source: { origin: "manual" } };
        const bad = await app.inject({ method: "POST", url: `/api/projects/${proj.id}/specs`, headers: h, payload: { specs: [spec], validate: false, mobile: { appPackage: "com.example.shop", apkPath: "/data/generated-tests/other-project/_apps/app.apk" } } });
        expect(bad.statusCode).toBe(400);
        const ok = await app.inject({ method: "POST", url: `/api/projects/${proj.id}/specs`, headers: h, payload: { specs: [spec], validate: false, mobile: { appPackage: "com.example.shop" } } });
        expect(ok.statusCode).toBeLessThan(300);
        await app.close();
    });
});

// ── jobs: the disk, the deadline and the lease timer ─────────────────────────
import http from "node:http";
import type { AddressInfo } from "node:net";
import { jobOverTime, leaseTick, runJob } from "../src/platform/job-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { DataSetStore } from "../src/platform/environments-store.js";
import { ResetHookStore } from "../src/platform/test-data-reset-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { diskWait, Worker } from "../src/platform/worker.js";

const platformFor = (env: Record<string, string> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-fixes-"));
    dirs.push(dir);
    return bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "fixes-secret-key-0123456789", ...env }));
};

describe("a job waits while the disk is nearly full", () => {
    it("is not claimed below READY_MIN_FREE_MB, says why once, and starts when space is back", async () => {
        const p = platformFor();
        const projectId = p.repo.createProject({ name: "disk" }).id as string;
        const appId = p.repo.createApplication(projectId, "http://127.0.0.1:7790/", {});
        const job = await p.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        let free = 10 * 1024 * 1024;
        const worker = new Worker({ ...p }, 20, { freeBytes: () => free, minFreeBytes: 500 * 1024 * 1024 });
        worker.start();
        await new Promise((r) => setTimeout(r, 200));
        expect(p.repo.getJob(job.id)!.status).toBe("QUEUED");
        const waits = (p.repo.listEvents(job.id) as Array<{ kind: string; message: string }>).filter((e) => e.kind === "job_waiting_for_disk");
        expect(waits.map((e) => e.message)).toEqual([diskWait(500 * 1024 * 1024)]);
        free = 900 * 1024 * 1024;
        const until = Date.now() + 10_000;
        while (p.repo.getJob(job.id)!.status === "QUEUED" && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
        await worker.stop();
        expect(p.repo.getJob(job.id)!.status).not.toBe("QUEUED");
    });
});

describe("a job has a deadline (JOB_MAX_MINUTES)", () => {
    it("defaults to 120 minutes", () => {
        expect(loadConfig({}).JOB_MAX_MINUTES).toBe(120);
    });

    it("stops a job that runs past it and records why", async () => {
        // The test data reset is the job's first step: an endpoint that never answers keeps the job busy.
        const hang = http.createServer(() => undefined);
        await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
        const p = platformFor({ JOB_MAX_MINUTES: "0.003" });
        const projectId = p.repo.createProject({ name: "slow" }).id as string;
        const appId = p.repo.createApplication(projectId, `http://127.0.0.1:${(hang.address() as AddressInfo).port}/`, {});
        new ResetHookStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY)).save(projectId, "", { enabled: true, method: "POST", url: "/reset", expectedStatus: 200, headers: [] });
        await p.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const claimed = p.repo.claimNextJob(60_000, "w1")!;
        const started = Date.now();
        await runJob({ ...p }, claimed, "w1");
        hang.closeAllConnections();
        hang.close();
        expect(Date.now() - started).toBeLessThan(10_000);
        const done = p.repo.getJob(claimed.id)!;
        expect(done.status).toBe("FAILED");
        expect(done.error).toBe(jobOverTime(0.003));
    });
});

describe("the lease timer", () => {
    it("never throws, and treats six failures in a row as a lost lease", () => {
        let lost = 0;
        let cancelled = 0;
        let fail = true;
        const tick = leaseTick({ beat: () => { if (fail) throw new Error("database is locked"); return true; }, cancelRequested: () => false, lost: () => lost++, cancel: () => cancelled++ });
        for (let i = 0; i < 5; i++) expect(() => tick()).not.toThrow();
        expect(lost).toBe(0);
        tick();
        expect(lost).toBe(1);
        // a good beat starts the count again
        fail = false;
        tick();
        fail = true;
        for (let i = 0; i < 5; i++) tick();
        expect(lost).toBe(1);
        // a beat the database refuses is a lost lease at once; a cancel is passed on
        const tick2 = leaseTick({ beat: () => false, cancelRequested: () => true, lost: () => lost++, cancel: () => cancelled++ });
        tick2();
        expect([lost, cancelled]).toEqual([2, 1]);
    });

    it("releases the job when its setup fails, instead of leaving it claimed", async () => {
        const p = platformFor();
        const projectId = p.repo.createProject({ name: "setup" }).id as string;
        const appId = p.repo.createApplication(projectId, "http://127.0.0.1:7791/", {});
        await p.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const claimed = p.repo.claimNextJob(60_000, "w1")!;
        // Setup reads the project's stores: one that throws stands for any setup failure.
        const spy = vi.spyOn(DataSetStore.prototype, "asMap").mockImplementationOnce(() => {
            throw new Error("setup went wrong");
        });
        await runJob({ ...p }, claimed, "w1");
        spy.mockRestore();
        const done = p.repo.getJob(claimed.id)!;
        expect(done.status).toBe("FAILED");
        expect(done.error).toBe("setup went wrong");
    });
});
