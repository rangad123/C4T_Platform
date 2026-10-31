/**
 * Visual regression lifecycle through the real API, queue, worker and Playwright:
 * capture baseline (+ stability re-run) → unchanged passes → change is a NEEDS_REVIEW finding with
 * diff images → accept new baseline → passes; a page that differs on every load cannot be baselined.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 5151;
const BASE = `http://127.0.0.1:${PORT}`;
let variant = "a";
const fixture = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url === "/clock") {
        res.end(`<!doctype html><body style="margin:0;font:40px sans-serif"><p>${Date.now()}${Math.random()}</p></body>`);
        return;
    }
    const color = variant === "a" ? "#1f2937" : "#b91c1c";
    const label = variant === "a" ? "Welcome to the shop" : "Welcome to the NEW shop";
    res.end(`<!doctype html><body style="margin:0;font:28px sans-serif"><header style="background:${color};color:#fff;padding:24px">${label}</header><p style="padding:24px">Static content.</p></body>`);
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;

beforeAll(async () => {
    await new Promise<void>((r) => fixture.listen(PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-visual-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
});
afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    fixture.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
async function waitForJob(jobId: string) {
    for (let i = 0; i < 300; i++) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("job did not finish");
}
const visualSpec = (title: string, url: string) => ({
    title,
    kind: "web",
    category: "Visual",
    type: "visual",
    steps: [
        { action: "navigate", url },
        { action: "assert", check: "screenshot", expected: 100 },
    ],
});

describe("visual regression", () => {
    let projectId = "";
    let homeId = "";
    let clockId = "";

    it("captures a baseline on first validation and checks it is stable", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Visual" })).body.id;
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs: [visualSpec("Home looks unchanged", "/"), visualSpec("Clock page", "/clock")], baseUrl: BASE });
        expect(res.status).toBe(202);
        [homeId, clockId] = res.body.tests.map((t: { id: string }) => t.id);
        await waitForJob(res.body.jobId);

        const home = (await call("GET", `/api/tests/${homeId}`)).body;
        expect(home.validationStatus).toBe("VALIDATED");
        expect(home.executions).toHaveLength(2); // capture + stability re-run
        const baselines = platform.repo.listArtifacts({ testId: homeId }).filter((a) => a.kind === "baseline");
        expect(baselines.map((a) => path.posix.basename(a.path))).toEqual(["WEB-001-2.png"]);

        const clock = (await call("GET", `/api/tests/${clockId}`)).body;
        expect(clock.validationStatus).toBe("FAILED_VALIDATION");
        expect(clock.validationReason).toMatch(/not visually stable/);
        expect(clock.severity).toBeNull();
    }, 120_000);

    it("passes again while the page is unchanged", async () => {
        const job = await waitForJob((await call("POST", `/api/tests/${homeId}/validate`)).body.jobId);
        expect(job.status).toBe("COMPLETED");
    }, 60_000);

    it("reports a changed page as a low-severity finding with diff images", async () => {
        variant = "b";
        await waitForJob((await call("POST", `/api/tests/${homeId}/validate`)).body.jobId);
        const home = (await call("GET", `/api/tests/${homeId}`)).body;
        expect(home.validationStatus).toBe("NEEDS_REVIEW");
        expect(home.validationReason).toMatch(/^Visual change: \d+ pixels differ/);
        expect(home.severity.severity).toBe("low");
        const kinds = home.executions[0].artifacts.map((a: { kind: string }) => a.kind);
        expect(kinds).toEqual(expect.arrayContaining(["visual-actual", "visual-diff"]));

        const img = await server.inject({ method: "GET", url: `/api/artifacts/${home.executions[0].artifacts.find((a: { kind: string }) => a.kind === "visual-diff").id}` });
        expect(img.headers["content-type"]).toBe("image/png");
    }, 60_000);

    it("accepts the new screenshot as the baseline and confirms it with a passing run", async () => {
        const res = await call("POST", `/api/tests/${homeId}/baseline`);
        expect(res.status).toBe(202);
        expect(res.body.accepted).toEqual(["WEB-001-2.png"]);
        await waitForJob(res.body.jobId);
        expect((await call("GET", `/api/tests/${homeId}`)).body.validationStatus).toBe("VALIDATED");
        // nothing left to accept now
        expect((await call("POST", `/api/tests/${homeId}/baseline`)).status).toBe(409);
    }, 60_000);
});
