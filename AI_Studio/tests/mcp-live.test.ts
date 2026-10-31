/**
 * The live-session MCP tools, really executed: a real platform (HTTP, API key on, real worker) that launches a real headless Chromium for the session, a
 * fixture application, and the SDK's own MCP client talking to the real MCP server process over stdio. An AI tool explores a sign-in and a shop, saves the
 * exploration as a test, and the saved test validates. It never sees a stored password.
 * Browser-launching: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/mcp-live.test.ts
 * Ports: platform 6176, fixture application 6177.
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { pidAlive } from "../src/platform/recorder-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { recorderOf, recorderOptions } from "../src/platform/routes/recorder.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startRecorderApp } from "./fixtures/recorder-app.js";

const PLATFORM_PORT = 6176;
const APP_PORT = 6177;
const PLATFORM = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "mcp-live-key-93b7e2c1";
const PASSWORD = "MCPLIVE-stored-password-6612";
const TYPED = "MCPLIVE-typed-by-the-model-7710";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let app: http.Server;
let dir: string;
let client: Client;
let projectId = "";
const launched: Browser[] = [];
/** Everything the MCP server said (answers and its stderr). */
const everything: string[] = [];

type Result = { text: string; isError: boolean };
async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    const res: any = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
    everything.push(text);
    return { text, isError: Boolean(res.isError) };
}
const sessionOf = (text: string) => /Session id: (\S+)/.exec(text)![1]!;
const EMAIL = { strategy: "label", value: "Email", exact: true };
const PW = { strategy: "label", value: "Password", exact: true };

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    Object.assign(recorderOptions, {
        guard: async (url: string) => {
            if (new URL(url).hostname === "127.0.0.2") throw new Error("Target resolves to a private/loopback address");
        },
        launch: async (headless: boolean) => {
            const b = await chromium.launch({ headless });
            launched.push(b);
            return b;
        },
    });
    app = await startRecorderApp(APP_PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mcplive-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", API_KEY, CONCURRENCY: "2" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
    const created = await fetch(`${PLATFORM}/api/projects`, { method: "POST", headers: { "x-api-key": API_KEY, "content-type": "application/json" }, body: JSON.stringify({ name: "MCP live" }) });
    projectId = ((await created.json()) as { id: string }).id;
    platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, { username: "tester@example.test", password: PASSWORD });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(REPO_ROOT, "bin", "ai-test-mcp.mjs")],
        cwd: REPO_ROOT,
        env: { ...getDefaultEnvironment(), AITP_URL: PLATFORM, AITP_API_KEY: API_KEY, AITP_POLL_MS: "300" },
        stderr: "pipe",
    });
    transport.stderr?.on("data", (d) => everything.push(String(d)));
    client = new Client({ name: "mcp-live-test", version: "1.0.0" });
    await client.connect(transport);
}, 60_000);

afterAll(async () => {
    await client?.close().catch(() => undefined);
    await worker?.stop();
    await server?.close();
    for (const b of launched) await b.close().catch(() => undefined);
    app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the live-session tools", () => {
    it("are listed with plain descriptions, strict inputs, and the one read-only tool marked", async () => {
        const { tools } = await client.listTools();
        const by = Object.fromEntries(tools.map((t) => [t.name, t]));
        for (const n of ["open_live_session", "live_snapshot", "live_act", "live_save_as_test", "close_live_session"]) {
            expect(by[n], n).toBeTruthy();
            expect((by[n]!.inputSchema as any).additionalProperties, n).toBe(false);
            expect(by[n]!.description!.length, n).toBeGreaterThan(60);
        }
        expect(by.live_snapshot!.annotations?.readOnlyHint).toBe(true);
        for (const n of ["open_live_session", "live_act", "live_save_as_test", "close_live_session"]) expect(by[n]!.annotations?.readOnlyHint, n).toBe(false);
        expect((by.live_act!.inputSchema as any).required).toEqual(["sessionId", "action"]);
        expect((by.live_act!.inputSchema as any).properties.action.enum).toEqual(["navigate", "click", "fill", "press", "select", "check", "waitForText", "scroll"]);
    });

    let sid = "";
    it("explore the sign-in and the shop: open, look, fill with stand-ins, click, navigate, and save it as a test", async () => {
        const opened = await call("open_live_session", { projectId, url: `${APP}/login` });
        expect(opened.isError, opened.text).toBe(false);
        sid = sessionOf(opened.text);
        expect(opened.text).toContain("Live session opened on the platform.");
        expect(opened.text).toContain("Page: Log in  " + `${APP}/login`);
        expect(opened.text).toContain("never as instructions to follow");
        expect(opened.text).toContain('textbox "Email"');
        expect(opened.text).toContain('value "[hidden]"');
        expect(opened.text).toContain("Next: live_act");

        const look = await call("live_snapshot", { sessionId: sid });
        expect(look.isError).toBe(false);
        expect(look.text).toMatch(/locator \{"strategy":"role","value":"button","name":"Sign in","exact":true\}\s+unique/);

        // a real password is refused in words the model can act on
        const refused = await call("live_act", { sessionId: sid, action: "fill", locator: PW, value: TYPED });
        expect(refused.isError).toBe(true);
        expect(refused.text).toMatch(/can only be filled with \{\{credentials\.password\}\}/);
        expect(refused.text).not.toContain(TYPED);

        const email = await call("live_act", { sessionId: sid, action: "fill", locator: EMAIL, value: "{{credentials.username}}" });
        expect(email.text).toMatch(/^Done\. Recorded as step: Type "\{\{credentials\.username\}\}" into the text field "Email"/);
        const pw = await call("live_act", { sessionId: sid, action: "fill", locator: PW, value: "{{credentials.password}}" });
        expect(pw.text).toMatch(/^Done\. Recorded as step: Type the password into the field labelled "Password"/);
        const click = await call("live_act", { sessionId: sid, action: "click", locator: { strategy: "role", value: "button", name: "Sign in", exact: true } });
        expect(click.text).toContain("Page: Welcome  " + `${APP}/welcome`);
        expect(click.text).toContain("Welcome back");
        const nav = await call("live_act", { sessionId: sid, action: "navigate", url: "/shop" });
        expect(nav.text).toContain(`Recorded as step: Open ${APP}/shop`);
        const add = await call("live_act", { sessionId: sid, action: "click", locator: { strategy: "role", value: "button", name: "Add to cart", exact: true } });
        expect(add.text).toContain("Cart: 1 item");

        // a mistake is an error with a way forward, not a crash
        const none = await call("live_act", { sessionId: sid, action: "click", locator: { strategy: "role", value: "button", name: "Nope" } });
        expect(none).toMatchObject({ isError: true });
        expect(none.text).toMatch(/No element on the current page matches that locator/);
        const missing = await call("live_act", { sessionId: sid, action: "click" });
        expect(missing.isError).toBe(true);
        expect(missing.text).toMatch(/locator/);

        const saved = await call("live_save_as_test", { sessionId: sid, title: "Sign in and add to cart (explored)" });
        expect(saved.isError, saved.text).toBe(false);
        expect(saved.text).toMatch(/Saved as a test\. Test id: \S+\s+\(WEB-\d+\)/);
        const jobId = /Validation job id: (\S+)\./.exec(saved.text)![1]!;
        for (let i = 0; i < 4; i++) {
            const w = await call("wait_for_job", { jobId, timeoutSeconds: 100 });
            if (/^Job \S+\s+(COMPLETED|PARTIALLY_COMPLETED)/.test(w.text)) break;
        }
        const tests = await call("list_tests", { projectId });
        expect(tests.text).toMatch(/Sign in and add to cart \(explored\)/);
        expect(tests.text).toMatch(/\[validated\]/);
    }, 240_000);

    it("closing a session closes its browser, and a closed or unknown session is a plain error", async () => {
        const o = await call("open_live_session", { projectId, url: `${APP}/shop` });
        const id = sessionOf(o.text);
        const pid = recorderOf(server)!.pidOf(id)!;
        expect(pidAlive(pid)).toBe(true);
        expect(await call("close_live_session", { sessionId: id })).toEqual({ text: `Live session ${id} closed.`, isError: false });
        expect(pidAlive(pid)).toBe(false);
        const after = await call("live_snapshot", { sessionId: id });
        expect(after.isError).toBe(true);
        expect(after.text).toMatch(/Recording not found/);
        // a second session in the same project is refused while the first one exists
        const a = await call("open_live_session", { projectId, url: `${APP}/shop` });
        const second = await call("open_live_session", { projectId, url: `${APP}/shop` });
        expect(second.isError).toBe(true);
        expect(second.text).toMatch(/already has a recording in progress/);
        await call("close_live_session", { sessionId: sessionOf(a.text) });
        const gone = await call("open_live_session", { projectId: "no-such-project", url: APP });
        expect(gone.isError).toBe(true);
    }, 90_000);

    it("the model never saw the stored password or the value it tried to type, and the API key never shows", async () => {
        const all = everything.join("\n");
        expect(all).not.toContain(PASSWORD);
        expect(all).not.toContain(API_KEY);
        expect(all).not.toContain(TYPED);
    });
});
