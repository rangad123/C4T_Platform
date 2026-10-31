/**
 * MCP server (Builder U), really executed: a real platform (HTTP on a local port, real worker, API-only jobs against the
 * sample app, no model) and the SDK's own MCP client talking to the real server process over stdio.
 * Ports 5630-5649: 5630 sample app, 5631 platform, 5632 platform with an API key, 5633 nothing listens,
 * 5634 a stand-in for an older platform version that lacks the newer routes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { PlatformClient, PlatformError } from "../src/mcp/client.js";
import { ConfigError, readConfig } from "../src/mcp/config.js";
import { cap, listLines, scrub } from "../src/mcp/format.js";
import { MAX_POLLS, MAX_WAITS_PER_JOB, TOOLS, type ToolContext } from "../src/mcp/tools.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const APP_PORT = 5630;
const PLATFORM_PORT = 5631;
const KEYED_PORT = 5632;
const NOBODY_PORT = 5633;
const OLD_PORT = 5634;
const APP = `http://127.0.0.1:${APP_PORT}`;
const PLATFORM = `http://127.0.0.1:${PLATFORM_PORT}`;
const API_KEY = "mcp-test-key-7f3a9c1d5b2e";
const WRONG_KEY = "mcp-wrong-key-0b8d4e6a9c13";

let app: ChildProcess;
let platform: Platform;
let keyed: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let keyedServer: Awaited<ReturnType<typeof buildServer>>;
let oldPlatform: http.Server;
const dirs: string[] = [];
const opened: Client[] = [];
/** Every piece of text the MCP server produced (tool answers and its stderr), to prove the key never shows up. */
const everything: string[] = [];

type Result = { text: string; isError: boolean };

async function connect(url: string, key?: string): Promise<Client> {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(REPO_ROOT, "bin", "ai-test-mcp.mjs")],
        cwd: REPO_ROOT,
        env: { ...getDefaultEnvironment(), AITP_URL: url, AITP_POLL_MS: "300", ...(key ? { AITP_API_KEY: key } : {}) },
        stderr: "pipe",
    });
    transport.stderr?.on("data", (d) => everything.push(String(d)));
    const client = new Client({ name: "mcp-test", version: "1.0.0" });
    await client.connect(transport);
    opened.push(client);
    return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
    const res: any = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
    everything.push(text);
    return { text, isError: Boolean(res.isError) };
}

async function until(client: Client, jobId: string): Promise<string> {
    for (let i = 0; i < 4; i++) {
        const r = await call(client, "wait_for_job", { jobId, timeoutSeconds: 100 });
        expect(r.isError, r.text).toBe(false);
        if (FINISHED.test(r.text)) return r.text;
    }
    throw new Error(`job ${jobId} did not finish`);
}

/** A finished job: all good, or finished with findings (never FAILED in these tests). */
const FINISHED = /^Job \S+\s+(COMPLETED|PARTIALLY_COMPLETED)/;
const jobIdOf =(text: string): string => /Job id: (\S+)/.exec(text)![1]!;

const platformJson = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${PLATFORM}/api${p}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(APP_PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(APP + "/")).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const mk = () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mcp-"));
        dirs.push(d);
        return d;
    };
    platform = bootstrap(loadConfig({ DATA_DIR: mk(), CONCURRENCY: "2" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();

    keyed = bootstrap(loadConfig({ DATA_DIR: mk(), API_KEY }));
    keyedServer = await buildServer(keyed);
    await keyedServer.listen({ port: KEYED_PORT, host: "127.0.0.1" });

    // An older platform: knows a project, has no dashboard and no plain-English route; every other path is a 404 like Fastify's.
    oldPlatform = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && req.url === "/api/projects/old1") return void res.end(JSON.stringify({ id: "old1", name: "Old", application: null, latestJob: null, suites: [] }));
        if (req.method === "GET" && req.url === "/api/projects/old1/tests") return void res.end("[]");
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
    });
    await new Promise<void>((r) => oldPlatform.listen(OLD_PORT, "127.0.0.1", r));
}, 60_000);

afterAll(async () => {
    for (const c of opened) await c.close().catch(() => undefined);
    await worker?.stop();
    await server?.close();
    await keyedServer?.close();
    await new Promise((r) => oldPlatform?.close(r));
    platform?.db.close();
    keyed?.db.close();
    app?.kill();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("pieces that need no platform", () => {
    it("reads its settings from the environment and rejects bad ones plainly", () => {
        expect(readConfig({}).baseUrl).toBe("http://127.0.0.1:4000");
        const c = readConfig({ AITP_URL: "https://ci.example.test:8443/", AITP_API_KEY: " k1 " });
        expect(c).toMatchObject({ baseUrl: "https://ci.example.test:8443", host: "ci.example.test:8443", apiKey: "k1" });
        expect(() => readConfig({ AITP_URL: "not a url" })).toThrow(ConfigError);
        expect(() => readConfig({ AITP_URL: "ftp://x.test" })).toThrow(/http/);
    });

    it("cuts long answers and says how much is missing", () => {
        const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
        const out = cap(text, 1000);
        expect(out.length).toBeLessThan(1200);
        expect(out).toMatch(/…\d+ more characters not shown/);
        expect(cap("short", 1000)).toBe("short");
        expect(listLines([1, 2, 3, 4, 5], 2, String)).toEqual(["1", "2", "…3 more"]);
        expect(scrub("a secret-key-1 b", "secret-key-1")).toBe("a [hidden] b");
    });

    it("builds requests that keep risky switches off unless asked, and passes the production confirmation through only when true", async () => {
        const sent: Array<{ method: string; path: string; body: any }> = [];
        const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        const fakeFetch = (async (url: string, init: RequestInit) => {
            const p = new URL(url).pathname.replace(/^\/api/, "");
            const body = init.body ? JSON.parse(String(init.body)) : undefined;
            sent.push({ method: init.method ?? "GET", path: p, body });
            if (p === "/projects" && init.method === "GET") return reply(200, []);
            if (p === "/projects" && init.method === "POST") return reply(201, { id: "p9", name: body.name });
            if (p === "/projects/p9") return reply(200, { id: "p9", name: "x", latestJob: null, suites: [] });
            if (p === "/projects/p9/tests") return reply(200, []);
            if (p === "/config") return reply(200, { llm: { configured: false } });
            if (p === "/projects/p9/test-generation") return reply(202, { jobId: "j1", status: "QUEUED" });
            if (p === "/projects/p9/validation") return body.confirmProduction ? reply(202, { jobId: "j2", testCount: 3, production: true, environment: "prod" }) : reply(409, { error: "“prod” is a production environment. Running there needs your explicit confirmation (confirmProduction: true).", details: { requiresConfirmation: true } });
            return reply(404, { error: "Not found" });
        }) as unknown as typeof fetch;
        const config = readConfig({ AITP_URL: "http://127.0.0.1:1" });
        const ctx: ToolContext = { client: new PlatformClient(config, fakeFetch), config, waits: new Map() };
        const tool = (n: string) => TOOLS.find((t) => t.name === n)!;

        const safe = await tool("analyze_application").run({ url: "http://127.0.0.1:1/" }, ctx);
        const gen = sent.find((s) => s.path === "/projects/p9/test-generation")!;
        expect(gen.body).toMatchObject({ allowMutatingApiTests: false, loadChecks: false, targets: ["web", "api"] });
        expect(safe).toContain("data-changing API tests: no");
        expect(safe).toContain("load checks: no");
        expect(safe).toContain("no AI model configured");

        sent.length = 0;
        const risky = await tool("analyze_application").run({ url: "http://127.0.0.1:1/", projectId: "p9", includeWebTests: false, allowMutatingApiTests: true, loadChecks: true }, ctx);
        expect(sent.find((s) => s.path === "/projects/p9/test-generation")!.body).toMatchObject({ allowMutatingApiTests: true, loadChecks: true, targets: ["api"] });
        expect(risky).toContain("data-changing API tests: YES");
        expect(risky).toContain("load checks: YES");
        await expect(tool("analyze_application").run({ url: "http://127.0.0.1:1/", includeWebTests: false, includeApiTests: false }, ctx)).rejects.toThrow(/at least one kind/);

        await expect(tool("run_tests").run({ projectId: "p9", environment: "prod" }, ctx)).rejects.toThrow(/confirmProduction/);
        expect(sent.filter((s) => s.path === "/projects/p9/validation").at(-1)!.body).toEqual({ environment: "prod" });
        const ok = await tool("run_tests").run({ projectId: "p9", environment: "prod", confirmProduction: true }, ctx);
        expect(sent.filter((s) => s.path === "/projects/p9/validation").at(-1)!.body).toEqual({ environment: "prod", confirmProduction: true });
        expect(ok).toContain("PRODUCTION");
    });

    it("says plainly when the platform cannot be reached or does not answer in JSON", async () => {
        const config = readConfig({ AITP_URL: `http://127.0.0.1:${NOBODY_PORT}` });
        await expect(new PlatformClient(config).json("GET", "/projects")).rejects.toThrow(`Could not reach the platform at 127.0.0.1:${NOBODY_PORT}. Is it running?`);
        const html = (async () => new Response("<html>hi</html>", { status: 200 })) as unknown as typeof fetch;
        await expect(new PlatformClient(config, html).json("GET", "/projects")).rejects.toThrow(/not JSON/);
        const boom = (async () => new Response("stack trace here at /srv/app.js:10", { status: 500 })) as unknown as typeof fetch;
        const err = await new PlatformClient(config, boom).json("GET", "/projects").catch((e) => e as PlatformError);
        expect(err.message).toMatch(/internal error/);
        expect(err.message).not.toContain("/srv/app.js");
    });
});

describe("MCP server over stdio against a real platform", () => {
    let client: Client;
    let projectId = "";
    let tests: Array<{ id: string; key: string; status: string }> = [];
    /** Tests that passed validation (the sample API needs a token for some endpoints, so a few findings are expected). */
    let baseline = { all: 0, findings: 0, couldNot: 0 };
    const good = () => tests.filter((t) => t.status === "validated");

    beforeAll(async () => {
        client = await connect(PLATFORM);
    }, 60_000);

    it("lists the tools with precise schemas and the report resource", async () => {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(
            ["analyze_application", "download_script", "get_dashboard", "get_failures", "get_job", "get_project", "get_test", "list_projects", "list_tests", "run_tests", "wait_for_job", "write_test", "open_live_session", "live_snapshot", "live_act", "live_save_as_test", "close_live_session"].sort(),
        );
        for (const t of tools) {
            expect(t.description!.length, t.name).toBeGreaterThan(40);
            expect(t.inputSchema.type).toBe("object");
            expect((t.inputSchema as any).additionalProperties, t.name).toBe(false);
        }
        const by = Object.fromEntries(tools.map((t) => [t.name, t]));
        const analyze: any = by.analyze_application!.inputSchema;
        expect(analyze.required).toEqual(["url"]);
        expect(Object.keys(analyze.properties)).toEqual(expect.arrayContaining(["url", "name", "includeApiTests", "allowMutatingApiTests", "loadChecks"]));
        expect((by.wait_for_job!.inputSchema as any).properties.timeoutSeconds.maximum).toBe(120);
        expect((by.get_project!.inputSchema as any).required).toEqual(["projectId"]);
        // read-only tools say so; the three that start work do not
        for (const n of ["analyze_application", "run_tests", "write_test"]) expect(by[n]!.annotations?.readOnlyHint, n).toBe(false);
        for (const n of ["list_projects", "get_failures", "get_dashboard"]) expect(by[n]!.annotations?.readOnlyHint, n).toBe(true);
        const templates = await client.listResourceTemplates();
        expect(templates.resourceTemplates.map((r) => r.uriTemplate)).toContain("aitp://projects/{projectId}/report");
    });

    it("starts empty, then analyzes an API-only project, waits, and lists its tests", async () => {
        const empty = await call(client, "list_projects");
        expect(empty).toMatchObject({ isError: false });
        expect(empty.text).toMatch(/no projects yet/i);

        const started = await call(client, "analyze_application", { url: APP, name: "DemoShop", includeWebTests: false, securityChecks: false });
        expect(started.isError, started.text).toBe(false);
        expect(started.text).toContain("created now");
        expect(started.text).toContain("data-changing API tests: no");
        expect(started.text).toContain("load checks: no");
        expect(started.text).toContain("browser tests: no");
        const jobId = jobIdOf(started.text);
        projectId = /Project: DemoShop {2}\(id (\S+),/.exec(started.text)![1]!;

        // a second job for the same project is refused with the platform's own message
        const dup = await call(client, "analyze_application", { url: APP, projectId, includeWebTests: false });
        expect(dup.isError).toBe(true);
        expect(dup.text).toMatch(/still/);
        expect(dup.text).toContain(jobId);

        // a short wait returns the state and how to continue, or the finished summary; never hangs
        const short = await call(client, "wait_for_job", { jobId, timeoutSeconds: 1 });
        expect(short.text).toMatch(/COMPLETED|Still/);
        const done = await until(client, jobId);
        expect(done).toMatch(FINISHED);
        expect(done).toContain("tests generated");
        expect(done).toContain(`get_failures with projectId ${projectId}`);

        const job = await call(client, "get_job", { jobId });
        expect(job.text).toContain("validation done");

        const again = await call(client, "list_projects");
        expect(again.text).toContain("1 project");
        expect(again.text).toContain(`id ${projectId}`);

        const listed = await call(client, "list_tests", { projectId, limit: 100 });
        expect(listed.text).toMatch(/\d+ tests/);
        tests = [...listed.text.matchAll(/^- id (\S+) {2}(\S+) {2}\[([^\],]+)/gm)].map((m) => ({ id: m[1]!, key: m[2]!, status: m[3]! }));
        expect(tests.length).toBeGreaterThan(5);
        expect(good().length).toBeGreaterThan(5);
        expect(good()[0]!.key).toMatch(/^API-/);

        // without a token the sample's secured endpoint (/api/me) cannot be validated: the status filter finds it
        const filtered = await call(client, "list_tests", { projectId, status: "FAILED_VALIDATION" });
        expect(filtered.text).toMatch(/\[could not be validated\]/);
        expect(filtered.text.split("\n").every((l) => !l.startsWith("- id ") || l.includes("[could not be validated"))).toBe(true);
        expect((await call(client, "list_tests", { projectId, status: "NEEDS_REVIEW" })).text).toMatch(/No tests match/);
        const search = await call(client, "list_tests", { projectId, q: "products" });
        expect(search.text).toMatch(/products/i);
        const few = await call(client, "list_tests", { projectId, limit: 3 });
        expect(few.text).toMatch(/…\d+ more/);
        expect(few.text.split("\n").filter((l) => l.startsWith("- id ")).length).toBe(3);
    }, 240_000);

    it("describes a project, a test, a script and the fleet", async () => {
        const proj = await call(client, "get_project", { projectId });
        expect(proj.text).toContain("DemoShop");
        expect(proj.text).toMatch(/Tests: \d+ tests: \d+ validated, \d+ need review/);
        expect(proj.text).toMatch(/Ready to release: (Ready|Needs attention|Unknown|Blocked)/);
        expect(proj.text).toMatch(/Latest job: \S+ {2}(COMPLETED|PARTIALLY_COMPLETED)/);

        const t = await call(client, "get_test", { testId: good()[0]!.id });
        expect(t.text).toContain(good()[0]!.key);
        expect(t.text).toMatch(/Steps \(\d+\):\n1\. /);
        expect(t.text).toMatch(/Last run: passed/);

        const script = await call(client, "download_script", { testId: good()[0]!.id });
        expect(script.isError).toBe(false);
        expect(script.text).toContain("API_BASE_URL");

        const dash = await call(client, "get_dashboard");
        expect(dash.text).toContain("DemoShop");
        expect(dash.text).toMatch(/\[(Ready|Needs attention|Unknown|Blocked)\]/);
        const none = await call(client, "get_dashboard", { q: "no-such-project" });
        expect(none.text).toMatch(/No project matches/);

        // the findings the platform already holds (secured endpoints without a token), most serious first, each with its reason
        const before = await call(client, "get_failures", { projectId });
        const m = /(\d+) tests? need attention \((\d+) findings?, (\d+) could not be validated\)/.exec(before.text);
        expect(m, before.text).not.toBeNull();
        baseline = { all: Number(m![1]), findings: Number(m![2]), couldNot: Number(m![3]) };
        expect(before.text).toContain("why:");

        const res = await client.readResource({ uri: `aitp://projects/${projectId}/report` });
        const report = JSON.parse((res.contents[0] as any).text);
        expect(report.project).toMatchObject({ id: projectId, name: "DemoShop" });
        expect(report.tests.total).toBe(tests.length);
        const listedRes = await client.listResources();
        expect(listedRes.resources.map((r) => r.uri)).toContain(`aitp://projects/${projectId}/report`);
    });

    it("re-runs tests, and refuses production without confirmation", async () => {
        // environments are created through the platform's own API
        const staging = await platformJson("POST", `/projects/${projectId}/environments`, { name: "staging", baseUrl: APP });
        expect(staging.status, JSON.stringify(staging.body)).toBe(201);
        const prod = await platformJson("POST", `/projects/${projectId}/environments`, { name: "prod", baseUrl: APP, production: true });
        expect(prod.status, JSON.stringify(prod.body)).toBe(201);
        const jobsBefore = (await platformJson("GET", `/projects/${projectId}/jobs`)).body.length;

        // production without the confirmation: refused in plain words, no job created
        const refused = await call(client, "run_tests", { projectId, environment: "prod" });
        expect(refused.isError).toBe(true);
        expect(refused.text).toMatch(/production/);
        expect(refused.text).toContain("confirmProduction");
        expect((await platformJson("GET", `/projects/${projectId}/jobs`)).body.length).toBe(jobsBefore);

        // several chosen tests without an environment cannot be done by the platform: said plainly
        const several = await call(client, "run_tests", { projectId, testIds: [good()[0]!.key, good()[1]!.key] });
        expect(several.isError).toBe(true);
        expect(several.text).toMatch(/single test|one chosen test/);
        const unknown = await call(client, "run_tests", { projectId, testIds: ["API-9999"] });
        expect(unknown).toMatchObject({ isError: true });
        expect(unknown.text).toContain("API-9999");

        // a chosen set against staging (by key and by id)
        const stg = await call(client, "run_tests", { projectId, environment: "staging", testIds: [good()[0]!.key, good()[1]!.id] });
        expect(stg.isError, stg.text).toBe(false);
        expect(stg.text).toContain("Started a run of 2 tests");
        expect(stg.text).toContain("against staging");
        expect(await until(client, jobIdOf(stg.text))).toMatch(FINISHED);

        // production with the confirmation goes through (read-only checks against the local fixture)
        const confirmed = await call(client, "run_tests", { projectId, environment: "prod", testIds: [good()[0]!.id], confirmProduction: true });
        expect(confirmed.isError, confirmed.text).toBe(false);
        expect(confirmed.text).toContain("PRODUCTION, confirmed");
        await until(client, jobIdOf(confirmed.text));

        // one test, then the whole project, against the project's own address
        const one = await call(client, "run_tests", { projectId, testIds: [good()[2]!.key] });
        expect(one.isError, one.text).toBe(false);
        await until(client, jobIdOf(one.text));
        const all = await call(client, "run_tests", { projectId });
        expect(all.isError, all.text).toBe(false);
        expect(all.text).toMatch(/Started a run of \d+ tests/);
        expect(await until(client, jobIdOf(all.text))).toMatch(FINISHED);
    }, 360_000);

    it("lists what needs attention, most serious first", async () => {
        const [a, b, c] = good();
        // findings and unusable tests are rows the platform stores; set a few the way a failed run would
        platform.db.run("UPDATE test_cases SET validation_status = 'FAILED_VALIDATION', validation_reason = ? WHERE id = ?", "Locator did not match any element", c!.id);
        platform.db.run("UPDATE test_cases SET validation_status = 'NEEDS_REVIEW', validation_reason = ? WHERE id = ?", "Expected status 200 but the API answered 500", b!.id);
        platform.db.run("UPDATE test_cases SET validation_status = 'NEEDS_REVIEW', validation_reason = ? WHERE id = ?", "Response was slower than expected", a!.id);
        const r = await call(client, "get_failures", { projectId });
        expect(r.isError).toBe(false);
        expect(r.text).toMatch(new RegExp(`${baseline.all + 3} tests need attention \\(${baseline.findings + 2} findings, ${baseline.couldNot + 1} could not be validated\\)`));
        const kinds = [...r.text.matchAll(/^- id \S+ {2}\S+ {2}\[(needs review|could not be validated)/gm)].map((m) => m[1]);
        expect(kinds.indexOf("could not be validated")).toBe(kinds.lastIndexOf("needs review") + 1); // findings first, then tests that could not be validated
        expect(r.text).toContain(c!.id);
        expect(r.text).toContain("why: Expected status 200 but the API answered 500");
        const limited = await call(client, "get_failures", { projectId, limit: 1 });
        expect(limited.text).toMatch(new RegExp(`…${baseline.all + 2} more`));
        const proj = await call(client, "get_project", { projectId });
        expect(proj.text).toMatch(new RegExp(`Needs attention: ${baseline.all + 3} \\(use get_failures\\)`));
        const t = await call(client, "get_test", { testId: b!.id });
        expect(t.text).toContain("Reason: Expected status 200 but the API answered 500");
    });

    it("stops waiting on one job after a fixed number of waits", async () => {
        const finished = (await platformJson("GET", `/projects/${projectId}/jobs`)).body[0].jobId as string;
        let last = { text: "", isError: false } as Result;
        for (let i = 0; i < MAX_WAITS_PER_JOB + 1; i++) last = await call(client, "wait_for_job", { jobId: finished, timeoutSeconds: 1 });
        expect(last.text).toContain("Not waiting any more");
        expect(MAX_POLLS).toBeLessThanOrEqual(60);
    }, 120_000);

    it("reports errors as plain tool errors, not stack traces", async () => {
        const missing = await call(client, "get_project", { projectId: "does-not-exist" });
        expect(missing).toMatchObject({ isError: true, text: "Project not found" });
        expect((await call(client, "get_job", { jobId: "nope" })).text).toBe("Job not found");
        expect((await call(client, "get_test", { testId: "nope" })).text).toBe("Test not found");
        expect((await call(client, "download_script", { testId: "nope" })).text).toBe("No script for this test");

        const noArgs = await call(client, "get_job", {});
        expect(noArgs.isError).toBe(true);
        expect(noArgs.text).toMatch(/Invalid arguments/);
        const tooLong = await call(client, "wait_for_job", { jobId: "x", timeoutSeconds: 500 });
        expect(tooLong.isError).toBe(true);
        expect(tooLong.text).toMatch(/Invalid arguments/);
        const extra = await call(client, "list_tests", { projectId, surprise: true });
        expect(extra.isError).toBe(true);
        const badEnum = await call(client, "list_tests", { projectId, status: "BROKEN" });
        expect(badEnum.isError).toBe(true);

        // an unknown tool is an error too (the SDK answers either with a tool error or a protocol error)
        const unknown = await call(client, "no_such_tool", {}).catch((e) => ({ isError: true, text: String(e.message) }));
        expect(unknown.isError).toBe(true);
        expect(unknown.text).toMatch(/not found/i);

        // the platform's own address guard is relayed, not bypassed
        const guarded = await call(client, "analyze_application", { url: "ftp://files.example.test/", projectId });
        expect(guarded.isError).toBe(true);
        expect(guarded.text).toMatch(/Only http/);
        for (const r of [missing, noArgs, tooLong, guarded]) expect(r.text).not.toMatch(/\bat .*\.(ts|js):\d+/);
    });

    it("write_test relays the platform's answer for a project that exists", async () => {
        const tooShort = await call(client, "write_test", { projectId, description: "x" });
        expect(tooShort.isError).toBe(true);
        const missing = await call(client, "write_test", { projectId: "does-not-exist", description: "Open the home page and check the title" });
        expect(missing.text).toBe("Project not found");
        // depending on whether this platform version has the plain-English route: a plain "not available" or a plain "no AI model" refusal; never a started job without a model
        const r = await call(client, "write_test", { projectId, description: "Open the home page and check the title", kind: "web" });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/not available in this platform version|AI model|model/i);
    });
});

describe("MCP server against other platforms", () => {
    it("write_test, get_dashboard and get_project degrade cleanly on a platform without the newer routes", async () => {
        const client = await connect(`http://127.0.0.1:${OLD_PORT}`);
        const w = await call(client, "write_test", { projectId: "old1", description: "Open the home page and check the title" });
        expect(w).toMatchObject({ isError: true, text: "Writing tests from a description is not available in this platform version." });
        const d = await call(client, "get_dashboard");
        expect(d.isError).toBe(true);
        expect(d.text).toMatch(/not available in this platform version/);
        const p = await call(client, "get_project", { projectId: "old1" });
        expect(p.isError).toBe(false);
        expect(p.text).toContain("Ready to release: not available from this platform");
        const missing = await call(client, "write_test", { projectId: "other", description: "Open the home page and check the title" });
        expect(missing.text).toBe("Not found");
        await client.close();
    }, 60_000);

    it("says the platform cannot be reached when nothing listens", async () => {
        const client = await connect(`http://127.0.0.1:${NOBODY_PORT}`);
        const r = await call(client, "list_projects");
        expect(r).toMatchObject({ isError: true, text: `Could not reach the platform at 127.0.0.1:${NOBODY_PORT}. Is it running?` });
        const w = await call(client, "wait_for_job", { jobId: "x", timeoutSeconds: 1 });
        expect(w.text).toMatch(/Could not reach the platform/);
        await client.close();
    }, 60_000);

    it("protects with the API key exactly like the platform: missing and wrong keys get a plain error, the right key works, the key is never printed", async () => {
        const none = await connect(`http://127.0.0.1:${KEYED_PORT}`);
        const noKey = await call(none, "list_projects");
        expect(noKey.isError).toBe(true);
        expect(noKey.text).toMatch(/needs an API key/);
        await none.close();

        const wrong = await connect(`http://127.0.0.1:${KEYED_PORT}`, WRONG_KEY);
        const bad = await call(wrong, "list_projects");
        expect(bad.isError).toBe(true);
        expect(bad.text).toMatch(/refused the API key/);
        for (const name of ["get_project", "get_dashboard", "run_tests"]) {
            const r = await call(wrong, name, name === "get_dashboard" ? {} : { projectId: "p" });
            expect(r.isError, name).toBe(true);
            expect(r.text, name).toMatch(/refused the API key/);
        }
        await wrong.close();

        const right = await connect(`http://127.0.0.1:${KEYED_PORT}`, API_KEY);
        const ok = await call(right, "list_projects");
        expect(ok.isError, ok.text).toBe(false);
        expect(ok.text).toMatch(/no projects yet/i);
        const created = await call(right, "analyze_application", { url: "ftp://files.example.test/", name: "KeyCheck" }); // refused by the platform's address guard, after the key was accepted
        expect(created.isError).toBe(true);
        expect(created.text).toMatch(/Only http/);
        await right.close();

        // nothing the server said, on its tool answers or on stderr, contains either key
        const all = everything.join("\n");
        expect(all).not.toContain(API_KEY);
        expect(all).not.toContain(WRONG_KEY);
        expect(all).toContain("API key set"); // the start-up line says a key is set, not what it is
    }, 90_000);

    it("keeps stdout free for the protocol (no console.log in the server)", () => {
        for (const f of fs.readdirSync(path.join(REPO_ROOT, "src", "mcp"))) {
            const src = fs.readFileSync(path.join(REPO_ROOT, "src", "mcp", f), "utf8");
            expect(src, f).not.toMatch(/console\.log/); // stdout is the protocol channel
        }
    });
});
