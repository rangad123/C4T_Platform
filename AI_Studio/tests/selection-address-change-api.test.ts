/**
 * Test-selection preview, after an address change, against a real platform (no browser, no worker, no AI): after the application's address moves to
 * another host, a web test's latest run (made on the old address) no longer vouches for its coverage, so the preview proposes it and requires
 * a full run. Nothing is contacted; automatic selection stays off: nothing here runs or skips a test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const API_KEY = "selection-address-change-key-0123456789";
const APP = "http://127.0.0.1:9657";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let projectId: string;
let testId: string;

const send = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: { "x-api-key": API_KEY } });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body };
};
const preview = async (body: unknown) => {
    const res = await send("POST", `/api/projects/${projectId}/selection-preview`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
};
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-selection-address-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "selection-address-change-secret-key-0123456789", API_KEY }));
    server = await buildServer(platform);
    projectId = (await send("POST", "/api/projects", { name: "Shop" })).body.id;
    const title = "Checkout";
    const res = await send("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: APP,
        validate: false,
        specs: [{ title, kind: "web", category: "Functional", steps: [{ action: "navigate", url: "/checkout" }, { action: "assert", check: "visible", locator: { by: "text", value: "Pay" } }] }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    testId = platform.repo.listTests(projectId).find((t) => t.title === title)!.id;
    // A passing run of the current script with a complete footprint, yesterday.
    const scriptId = (platform.repo.getCurrentScript(testId) as { id: string }).id;
    const execId = platform.repo.addExecution({ testId, scriptId, jobId: null, attempt: 1, status: "passed", durationMs: 500, startedAt: ago(1), steps: [] });
    platform.db.run("UPDATE test_executions SET test_version_id = (SELECT id FROM test_versions WHERE test_case_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1) WHERE id = ?", testId, execId);
    const evidence = { v: 1, durationMs: 500, counts: { requests: 1, requestsKept: 0, console: 0, consoleKept: 0 }, steps: [], requests: [], console: [], footprint: { pages: [{ path: "/checkout", step: 1 }], endpoints: [{ method: "POST", path: "/pay", step: 1, n: 1, statuses: [200] }] } };
    const key = `${projectId}/_artifacts/sel/${execId}/evidence.json`;
    const body = JSON.stringify(evidence);
    await platform.store.put(key, body);
    platform.repo.addArtifact({ projectId, testId, executionId: execId, kind: "evidence", path: key, size: body.length });
}, 60_000);

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("a changed application address makes coverage out of date", () => {
    it("is not matched while the address is the one the run opened, and out of date (full run required) after it moves", async () => {
        const change = { endpoints: ["POST /orders"] };
        let p = await preview(change);
        expect(p.notMatched.map((t: { title: string }) => t.title)).toEqual(["Checkout"]);
        expect(p.fullRunRequired).toBe(false);
        // The same address saved again (same host) changes nothing.
        platform.repo.createApplication(projectId, APP, {});
        p = await preview(change);
        expect(p.notMatched.map((t: { title: string }) => t.title)).toEqual(["Checkout"]);
        // The application moved to another host.
        platform.repo.createApplication(projectId, "https://shop.example.test", {});
        p = await preview(change);
        expect(p.notMatched).toHaveLength(0);
        expect(p.unknown.find((t: { title: string }) => t.title === "Checkout")?.why).toBe(
            `Proposed because its recorded coverage is out of date: the application's address changed after its latest run (${ago(1).slice(0, 10)}), so what it touched was on the old address.`,
        );
        expect(p.fullRunRequired).toBe(true);
    });
});
