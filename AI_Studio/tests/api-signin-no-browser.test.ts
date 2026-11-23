/**
 * An API test that signs in for its calls (C1) on a computer with no browser to sign in with (a runner that has not fetched Chromium):
 * the calls go unsigned, as before C1, and the test runs and passes; it is not an infrastructure error.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";

const PORT = 9671;
const base = `http://127.0.0.1:${PORT}`;
let server: http.Server;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-nobrowser-"));

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Sign in</title><form><label>Email <input name=email></label></form>");
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

it("runs unsigned and passes when no browser can be started for its sign-in", async () => {
    const spec = TestSpecSchema.parse({ testId: "API-001", title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/health", auth: "default" }, { action: "assertResponse", check: "status", expected: 200 }] });
    const script = renderScript(spec, "playwright-api", { baseUrl: base });
    expect(script.content).toContain("apiSignedIn");
    const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(dir, "no-browsers"); // nothing installed there
    try {
        const [run] = await runScripts(loadConfig({}).scratchDir, [{ testId: spec.testId, ...script }], { baseUrl: base, credentials: { username: "demo@example.com", password: "Pw-0123456789" }, headless: true }, { workers: 1 });
        expect(run, JSON.stringify(run?.error)).toMatchObject({ status: "passed" });
    } finally {
        if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
        else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
    }
}, 120_000);
