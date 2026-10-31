/**
 * "Save" and "Save and run" are separate in the workbench: saving the steps or the text with `run: false` stores the change as a new
 * version and starts no run (the test says it has not been run since), while the default still saves and queues a run.
 * Real platform, real routes, no browser, no worker (a queued run stays queued: that is what is checked). Port: 6471 is only the address
 * the tests are imported against.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId = "";
let apiId = "";

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: payload !== undefined ? { "content-type": "application/json" } : {} });
    return { status: res.statusCode, body: res.body && (res.body.startsWith("{") || res.body.startsWith("[")) ? JSON.parse(res.body) : res.body };
};
const specSteps = (path: string) => [{ action: "request", method: "GET", path }, { action: "assertResponse", check: "status", expected: 200 }];
const jobsFor = () => platform.db.all("SELECT id FROM generation_jobs WHERE project_id = ?", projectId).length;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-wb-api-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    projectId = (await call("POST", "/api/projects", { name: "Save without running" })).body.id;
    const imp = await call("POST", `/api/projects/${projectId}/specs`, { specs: [{ title: "List products answers", kind: "api", category: "API", steps: specSteps("/api/products") }], baseUrl: "http://127.0.0.1:6471", validate: false });
    expect(imp.status).toBe(202);
    apiId = imp.body.tests[0].id;
}, 60_000);

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("saving the steps without running", () => {
    it("with run: false stores a new version and starts no run", async () => {
        const before = jobsFor();
        const cur = (await call("GET", `/api/tests/${apiId}/spec`)).body;
        const spec = { ...cur.spec, steps: specSteps("/api/products/1") };
        const r = await call("PUT", `/api/tests/${apiId}/spec`, { spec, note: "Look at one product", run: false });
        expect(r.status).toBe(200);
        expect(r.body.changed).toBe(true);
        expect(r.body.jobId).toBeNull();
        expect(r.body.note).toContain("has not been run");
        expect(jobsFor()).toBe(before);
        const t = (await call("GET", `/api/tests/${apiId}`)).body;
        expect(t.validationStatus).toBe("PENDING");
        expect(t.spec.steps[0].path).toBe("/api/products/1");
        // the change is a version like any other (version 1 is the test before the first edit)
        const versions = (await call("GET", `/api/tests/${apiId}/spec-versions`)).body as Array<{ version: number; note: string | null }>;
        expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
        expect(versions.find((v) => v.version === 2)?.note).toBe("Look at one product");
    });

    it("without run: false still saves and queues a run, as before", async () => {
        const before = jobsFor();
        const cur = (await call("GET", `/api/tests/${apiId}/spec`)).body;
        const r = await call("PUT", `/api/tests/${apiId}/spec`, { spec: { ...cur.spec, steps: specSteps("/api/products/2") } });
        expect(r.status).toBe(200);
        expect(r.body.changed).toBe(true);
        expect(typeof r.body.jobId).toBe("string");
        expect(jobsFor()).toBe(before + 1);
        // no worker here: the queued run is ended by hand so the project is free to edit again
        platform.repo.setJobStatus(r.body.jobId, "COMPLETED");
    });

    it("saving nothing changes nothing whichever button was used", async () => {
        const cur = (await call("GET", `/api/tests/${apiId}/spec`)).body;
        const before = jobsFor();
        const r = await call("PUT", `/api/tests/${apiId}/spec`, { spec: cur.spec, run: false });
        expect(r.status).toBe(200);
        expect(r.body.changed).toBe(false);
        expect(jobsFor()).toBe(before);
    });

    it("refuses a run flag that is not a boolean", async () => {
        const cur = (await call("GET", `/api/tests/${apiId}/spec`)).body;
        const r = await call("PUT", `/api/tests/${apiId}/spec`, { spec: cur.spec, run: "no" });
        expect(r.status).toBe(400);
    });
});

describe("saving the text without running", () => {
    let textId = "";
    it("with run: false stores the text as a new version and starts no run", async () => {
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { specs: [{ title: "Orders answer", kind: "api", category: "API", steps: specSteps("/api/orders") }], baseUrl: "http://127.0.0.1:6471", validate: false });
        textId = imp.body.tests[0].id;
        const printed = (await call("GET", `/api/tests/${textId}/dsl`)).body;
        expect(printed.expressible).toBe(true);
        const before = jobsFor();
        const r = await call("PUT", `/api/tests/${textId}/dsl`, { text: String(printed.text).replace("/api/orders", "/api/orders/7"), run: false });
        expect(r.status).toBe(200);
        expect(r.body.changed).toBe(true);
        expect(r.body.jobId).toBeNull();
        expect(jobsFor()).toBe(before);
        const t = (await call("GET", `/api/tests/${textId}`)).body;
        expect(t.spec.steps[0].path).toBe("/api/orders/7");
        expect(t.validationStatus).toBe("PENDING");
        const versions = (await call("GET", `/api/tests/${textId}/spec-versions`)).body as Array<{ version: number; note: string | null }>;
        expect(versions.some((v) => v.note === "Edited as text")).toBe(true);
    });

    it("the default save of the text still queues a run", async () => {
        const printed = (await call("GET", `/api/tests/${textId}/dsl`)).body;
        const before = jobsFor();
        const r = await call("PUT", `/api/tests/${textId}/dsl`, { text: String(printed.text).replace("/api/orders/7", "/api/orders/8") });
        expect(r.status).toBe(200);
        expect(typeof r.body.jobId).toBe("string");
        expect(jobsFor()).toBe(before + 1);
        platform.repo.setJobStatus(r.body.jobId, "COMPLETED");
    });
});
