/**
 * Resuming a stopped benchmark app (src/eval/bench/controller.ts continueApp, cli.ts state file), against a scripted platform client:
 *   - any failure while an app is continued keeps its project and jobs (status stays "stopped"), the creations it started included;
 *   - the validation run of a continued app gets its own (2 hour) wait, not the 10-minute wind-down wait of a stopped job;
 *   - the saved state keeps the earlier attempt's apps not reached yet, and is written whole (temporary file, then renamed).
 * The stand-in app (tests/fixtures/bench-standin.mjs) runs on port 9472; no browser, no AI.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Answer, PlatformClient } from "../src/eval/client.js";
import type { BenchApp } from "../src/eval/bench/apps.js";
import type { Catalogue } from "../src/eval/bench/catalogue.js";
import { withAppsNotReached, writeState } from "../src/eval/bench/cli.js";
import { runBenchmark, type BenchOptions } from "../src/eval/bench/controller.js";
import type { BenchAppResult, BenchConfig } from "../src/eval/bench/schema.js";

const PORT = 9472;
const APP: BenchApp = { id: "bench-standin", script: "tests/fixtures/bench-standin.mjs", workflows: [{ name: "Home", paths: ["/"] }] };
const CATALOGUE: Catalogue = {
    version: "test-1",
    sha256: "0".repeat(64),
    defects: [{ id: "SI-1", app: "bench-standin", workflow: "Home", category: "api-contract", severity: "high", expected: "a", actual: "b" }],
};
const CONFIG = { apps: [{ id: "bench-standin", version: "v1" }] } as unknown as BenchConfig;
let tmp: string;
beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-resume-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** An app an earlier attempt stopped, with its project and jobs. */
const stoppedApp = (): BenchAppResult =>
    ({
        id: "bench-standin",
        entryId: "bench-standin",
        projectId: "p1",
        status: "stopped",
        reason: "stopped: provider rate limit",
        appVersion: "v1",
        seededDefects: ["SI-1"],
        defects: [],
        findings: [],
        metrics: { testsGenerated: 2 },
        jobs: { planJobId: "plan1", createJobIds: ["c1"] },
    }) as unknown as BenchAppResult;

type Handler = (method: string, url: string, body?: unknown) => Answer | undefined;
/** A platform that answers what `handle` answers, and otherwise: every job finished, no tests, no events, no usage. */
function fakeClient(handle: Handler, seen: string[] = []): PlatformClient {
    return {
        mode: "in-process",
        upload: async () => ({ status: 404, body: {} }),
        call: async (method, url, body) => {
            seen.push(`${method} ${url}`);
            const a = handle(method, url, body);
            if (a) return a;
            if (method === "GET" && /^\/api\/test-generation\/[^/]+$/.test(url)) return { status: 200, body: { status: "COMPLETED" } };
            if (method === "GET" && /\/tests$/.test(url)) return { status: 200, body: [] };
            if (method === "GET" && /\/events$/.test(url)) return { status: 200, body: [] };
            return { status: 404, body: { error: "not here" } };
        },
    };
}

const options = (extra: Partial<BenchOptions>): BenchOptions => ({
    apps: [{ app: APP, port: PORT }],
    catalogue: CATALOGUE,
    mode: "discovery",
    exploration: {},
    repeat: 1,
    model: "scripted",
    config: CONFIG,
    baseline: false,
    pollMs: 20,
    previous: { startedAt: new Date().toISOString(), apps: [stoppedApp()], entries: [], notes: [] },
    ...extra,
});

describe("an app that fails while it is continued", () => {
    it("keeps its project and jobs when the continuation is refused (stays stopped, so the next --resume continues it)", async () => {
        const client = fakeClient((m, url) => (m === "POST" && url.endsWith("/create") ? { status: 409, body: { error: "Only a creation that was stopped can be continued." } } : undefined));
        const { benchmark, complete } = await runBenchmark(client, options({}));
        const app = benchmark.apps[0]!;
        expect(complete).toBe(false);
        expect(app.status).toBe("stopped");
        expect(app.projectId).toBe("p1");
        expect(app.jobs).toMatchObject({ planJobId: "plan1", createJobIds: ["c1"] });
        expect(app.reason).toMatch(/could not be continued.*Only a creation that was stopped/);
    }, 60_000);

    it("keeps the creation it started too, when reading the tests fails after it", async () => {
        let created = false;
        const client = fakeClient((m, url) => {
            if (m === "POST" && url.endsWith("/create")) {
                created = true;
                return { status: 202, body: { jobId: "c2", status: "QUEUED" } };
            }
            if (created && m === "GET" && url === "/api/projects/p1/tests") return { status: 503, body: { error: "a network blip" } };
            return undefined;
        });
        const { benchmark } = await runBenchmark(client, options({}));
        const app = benchmark.apps[0]!;
        expect(app.status).toBe("stopped");
        expect(app.projectId).toBe("p1");
        expect(app.jobs?.createJobIds).toEqual(["c1", "c2"]);
        expect(app.reason).toMatch(/a network blip/);
    }, 60_000);
});

describe("the validation run of a continued app", () => {
    it("is waited for with its own limit, not the wind-down limit of a stopped job, before anything is judged", async () => {
        const seen: string[] = [];
        let validationEnds = Infinity;
        let early: string | undefined;
        const client = fakeClient((m, url) => {
            if (m === "POST" && url.endsWith("/create")) return { status: 400, body: { error: "Nothing is left to create." } };
            if (m === "GET" && url === "/api/projects/p1/tests") return { status: 200, body: [{ id: "t1", testId: "WEB-001", title: "A test", type: "functional", validationStatus: "PENDING" }] };
            if (m === "GET" && url === "/api/tests/t1") return { status: 200, body: { spec: {} } };
            if (m === "POST" && url === "/api/projects/p1/runs") {
                if (validationEnds === Infinity) {
                    validationEnds = Date.now() + 1500;
                    return { status: 202, body: { jobId: "v1" } };
                }
                early ??= Date.now() < validationEnds ? "a replay started while the validation was still running" : undefined;
                return { status: 422, body: { error: "nothing to run" } };
            }
            if (m === "GET" && url === "/api/test-generation/v1") return { status: 200, body: { status: Date.now() < validationEnds ? "RUNNING" : "COMPLETED" } };
            return undefined;
        }, seen);
        const t0 = Date.now();
        const { benchmark } = await runBenchmark(client, options({ windDownMs: 200, continuedValidationMs: 10_000 }));
        const app = benchmark.apps[0]!;
        expect(app.status, app.reason).toBe("done");
        expect(app.jobs?.validationJobIds).toEqual(["v1"]);
        // The judging read of the tests after the validation came only once it had finished.
        expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
        expect(early).toBeUndefined();
        const afterValidation = seen.slice(seen.indexOf("POST /api/projects/p1/runs") + 1);
        const firstOther = afterValidation.find((s) => s !== "GET /api/test-generation/v1");
        expect(firstOther).toBeDefined();
        const polls = afterValidation.slice(0, afterValidation.indexOf(firstOther!)).length;
        expect(polls).toBeGreaterThan(200 / 20); // more polls than the 200 ms wind-down limit allows
    }, 60_000);
});

describe("the saved resume state", () => {
    it("keeps the earlier attempt's apps not reached yet (a stopped one with its project), and their entries", () => {
        const a = { id: "a", status: "done" };
        const bNow = { id: "b", status: "done" };
        const bBefore = { id: "b", status: "stopped", projectId: "p-b" };
        const c = { id: "c", status: "stopped", projectId: "p-c" };
        const saved = withAppsNotReached({ apps: [a, bNow], entries: [{ id: "a" }] }, { apps: [a, bBefore, c], entries: [{ id: "a" }, { id: "c" }] });
        expect(saved.apps).toEqual([a, bNow, c]);
        expect(saved.entries).toEqual([{ id: "a" }, { id: "c" }]);
        expect(withAppsNotReached({ apps: [a], entries: [] })).toEqual({ apps: [a], entries: [] });
    });

    it("is written whole: a temporary file renamed over the old one, nothing else left in the folder", () => {
        const out = path.join(tmp, "state");
        writeState(out, { apps: [1] });
        const renames: string[] = [];
        const real = fs.renameSync;
        fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
            renames.push(`${path.basename(String(from))} -> ${path.basename(String(to))}`);
            return real(from, to);
        }) as typeof fs.renameSync;
        try {
            writeState(out, { apps: [1, 2] });
        } finally {
            fs.renameSync = real;
        }
        expect(renames).toEqual([`bench-state.json.${process.pid}.tmp -> bench-state.json`]);
        expect(JSON.parse(fs.readFileSync(path.join(out, "bench-state.json"), "utf8"))).toEqual({ apps: [1, 2] });
        expect(fs.readdirSync(out)).toEqual(["bench-state.json"]);
    });
});
