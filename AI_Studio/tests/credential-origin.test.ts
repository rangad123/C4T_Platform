/**
 * H1 of the AX review, for real: generated scripts run by the real Playwright runner against two local servers, "the application" and
 * "another site". Stored sign-in details must never reach the other one:
 *   - an API script whose request lands on another site than API_BASE_URL does not attach the token (it fails with the rule, sends nothing);
 *   - a web script whose page was sent to another site by a redirect types nothing (the real page address is compared right before the fill).
 * The controls show the same scripts do work, and do use the details, on the application's own site.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/credential-origin.test.ts
 * Ports: 6210 (the application and its API), 6211 (another site, reached as localhost).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";

const APP_PORT = 6210;
const OTHER_PORT = 6211;
const APP = `http://127.0.0.1:${APP_PORT}`;
const OTHER = `http://localhost:${OTHER_PORT}`;
const TOKEN = "AZ1-Token-9d41c0aa";
const PASSWORD = "AZ1-Password-7b3e55f1";

interface Seen {
    where: "app" | "other";
    url: string;
    authorization?: string;
}
const seen: Seen[] = [];
const servers: http.Server[] = [];

const page = (title: string, extra = "") => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${extra}</main></body></html>`;
const field = `<label>Password <input id="pw" type="password" oninput="fetch('/typed?len='+this.value.length)"></label>`;

function serve(port: number, where: Seen["where"]): Promise<void> {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", `http://x`);
            seen.push({ where, url: url.pathname + url.search, ...(req.headers.authorization ? { authorization: String(req.headers.authorization) } : {}) });
            if (url.pathname === "/api/ok" || url.pathname === "/steal") {
                res.writeHead(200, { "content-type": "application/json" });
                return void res.end(JSON.stringify({ ok: true }));
            }
            if (url.pathname === "/typed") {
                res.writeHead(204);
                return void res.end();
            }
            res.writeHead(200, { "content-type": "text/html" });
            if (url.pathname === "/bounce") return void res.end(page("Bouncing", `<script>setTimeout(function(){ location.href = ${JSON.stringify(`${OTHER}/capture`)}; }, 150);</script>`));
            if (url.pathname === "/capture") return void res.end(page("Another site", field));
            if (url.pathname === "/login") return void res.end(page("Sign in", field));
            res.end(page("Home"));
        });
        s.listen(port, "127.0.0.1", () => resolve());
        servers.push(s);
    });
}

let dir: string;
beforeAll(async () => {
    await serve(APP_PORT, "app");
    await serve(OTHER_PORT, "other");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-credorigin-"));
});
afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    fs.rmSync(dir, { recursive: true, force: true });
});

const spec = (kind: "web" | "api", testId: string, steps: unknown[]) => TestSpecSchema.parse({ testId, title: `Credential origin ${testId}`, kind, steps });
const scriptOf = (s: ReturnType<typeof spec>, ctx: { baseUrl: string; apiBaseUrl?: string }) => {
    const r = renderScript(s, s.kind === "api" ? "playwright-api" : "playwright", ctx);
    return { testId: s.testId, filename: r.filename, content: r.content };
};
const config = loadConfig({ DATA_DIR: os.tmpdir() });

describe("the API token goes to the API's own site only", () => {
    it("is attached on the API origin and NOT when the request lands elsewhere (the script refuses before sending)", async () => {
        // The application is on the "other" site and the API on the app site: a request to the application's address is allowed by the generator
        // (either configured address may be meant) but is not the API's own site, so at run time the token must stay home.
        const ctx = { baseUrl: OTHER, apiBaseUrl: APP };
        const control = spec("api", "API-001", [{ action: "request", method: "GET", path: "/api/ok" }, { action: "assertResponse", check: "status", expected: 200 }]);
        const away = spec("api", "API-002", [{ action: "request", method: "GET", path: `${OTHER}/steal` }, { action: "assertResponse", check: "status", expected: 200 }]);
        const scripts = [scriptOf(control, ctx), scriptOf(away, ctx)];
        expect(scripts[1]!.content).toContain("assertOwnOrigin(target, API_BASE_URL);");
        seen.length = 0;
        const runs = await runScripts(config.scratchDir, scripts, { baseUrl: OTHER, apiBaseUrl: APP, apiToken: TOKEN, headless: true }, { workers: 1 });
        const [ok, leak] = runs;
        expect(ok!.status, ok!.error).toBe("passed");
        expect(leak!.status).toBe("failed");
        expect(`${leak!.error} ${JSON.stringify(leak!.steps)}`).toMatch(/Stored sign-in details can only be used on the application's own site/);
        // the control sent the token to the API site; nothing at all reached the other site
        expect(seen.filter((s) => s.where === "app" && s.url === "/api/ok").map((s) => s.authorization)).toEqual([`Bearer ${TOKEN}`]);
        expect(seen.filter((s) => s.where === "other")).toEqual([]);
        expect(JSON.stringify(leak)).not.toContain(TOKEN);
    }, 120_000);
});

describe("the password is typed on the application's own site only", () => {
    it("types it on the application's page, and types nothing when a redirect has moved the page to another site", async () => {
        const ctx = { baseUrl: APP };
        const typePassword = { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" };
        const control = spec("web", "WEB-001", [{ action: "navigate", url: "/login" }, typePassword]);
        // Own address first, so the generator is satisfied; the page then sends the browser to the other site while the script waits.
        const moved = spec("web", "WEB-002", [{ action: "navigate", url: "/bounce" }, { action: "wait", ms: 1200 }, typePassword]);
        const scripts = [scriptOf(control, ctx), scriptOf(moved, ctx)];
        for (const s of scripts) expect(s.content).toContain("assertOwnOrigin(page.url(), BASE_URL);");
        seen.length = 0;
        const runs = await runScripts(config.scratchDir, scripts, { baseUrl: APP, credentials: { username: "demo", password: PASSWORD }, headless: true }, { workers: 1 });
        const [ok, away] = runs;
        expect(ok!.status, ok!.error).toBe("passed");
        // the control really typed on the application's page (the page reported the length)
        expect(seen.filter((s) => s.where === "app" && s.url === `/typed?len=${PASSWORD.length}`).length).toBeGreaterThan(0);
        expect(away!.status).toBe("failed");
        expect(`${away!.error} ${JSON.stringify(away!.steps)}`).toMatch(/Stored sign-in details can only be used on the application's own site/);
        expect(`${away!.error}`).toMatch(/Nothing was typed or sent/);
        // the other site did serve its page, and received no typing at all
        expect(seen.some((s) => s.where === "other" && s.url === "/capture")).toBe(true);
        expect(seen.filter((s) => s.where === "other" && s.url.startsWith("/typed"))).toEqual([]);
        expect(JSON.stringify(away)).not.toContain(PASSWORD);
    }, 180_000);
});
