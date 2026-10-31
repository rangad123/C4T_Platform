/**
 * Two-factor (TOTP) login, really executed: discovery logs in through a one-time-code step, and a generated script computes
 * the code itself at run time. The fixture verifies codes with an independently written TOTP, not the engine's.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { login } from "../src/engine/discovery/auth.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { totpAccepted } from "./fixtures/independent-totp.js";

const PORT = 5340;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "JBSWY3DPEHPK3PXP"; // a typical authenticator secret
const WRONG_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const codeOk = (code: string) => totpAccepted(SECRET, code);

const sessions = new Set<string>();
const layout = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>2FA shop</title></head><body>${body}</body></html>`;
const loginForm = (error = "") => layout(`<h1>Sign in</h1>${error}<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button type="submit">Log in</button></form>`);
const otpForm = (error = "") => layout(`<h1>Two-step verification</h1>${error}<form method="post" action="/verify"><label>6-digit code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button type="submit">Verify</button></form>`);

function body(req: http.IncomingMessage): Promise<URLSearchParams> {
    return new Promise((resolve) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => resolve(new URLSearchParams(raw)));
    });
}
const sidOf = (req: http.IncomingMessage) => /sid=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
const app = http.createServer(async (req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    const sid = sidOf(req);
    const html = (status: number, content: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "text/html", ...headers });
        res.end(content);
    };
    const redirect = (to: string, headers: Record<string, string> = {}) => {
        res.writeHead(302, { location: to, ...headers });
        res.end();
    };
    if (req.method === "POST" && p === "/login") {
        const f = await body(req);
        if (f.get("email") !== "demo@example.com" || f.get("password") !== "Password123!") return html(401, loginForm('<p role="alert">Invalid email or password</p>'));
        const id = crypto.randomBytes(8).toString("hex");
        sessions.add(`pending:${id}`);
        return redirect("/verify", { "set-cookie": `sid=${id}; Path=/; HttpOnly` });
    }
    if (p === "/verify") {
        if (!sessions.has(`pending:${sid}`)) return redirect("/login");
        if (req.method === "GET") return html(200, otpForm());
        const f = await body(req);
        if (!codeOk((f.get("code") ?? "").trim())) return html(401, otpForm('<p role="alert">That code is not valid</p>'));
        sessions.add(`full:${sid}`);
        return redirect("/account");
    }
    if (p === "/account") return sessions.has(`full:${sid}`) ? html(200, layout("<h1>Welcome back</h1><p>Your account</p>")) : redirect("/login");
    if (p === "/" || p === "/login") return html(200, loginForm());
    html(404, layout("not found"));
});

let browser: Browser;
beforeAll(async () => {
    await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    await new Promise((r) => app.close(r));
});

describe("discovery login with a one-time code", () => {
    const attempt = async (totpSecret?: string) => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        try {
            return await login(session, BASE, { username: "demo@example.com", password: "Password123!", ...(totpSecret ? { totpSecret } : {}) });
        } finally {
            await session.close();
        }
    };
    it("signs in through the code step and lands in the app", async () => {
        const r = await attempt(SECRET);
        expect(r.error).toBeUndefined();
        expect(r.ok).toBe(true);
        expect(new URL(r.landingUrl!).pathname).toBe("/account");
        expect(r.mechanisms).toEqual(["form", "totp", "session-cookie"]);
    }, 60_000);
    it("tells you plainly when a code is needed but no secret was given", async () => {
        const r = await attempt();
        expect(r.ok).toBe(false);
        expect(r.error).toBe("The login asks for a one-time code, but no authenticator secret (TOTP) was provided for this project.");
    }, 60_000);
    it("says when the code was not accepted (wrong secret), instead of reporting a false success", async () => {
        const r = await attempt(WRONG_SECRET);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^The one-time code was not accepted\./);
    }, 60_000);
    it("reports an invalid secret clearly", async () => {
        const r = await attempt("not base32!");
        expect(r.ok).toBe(false);
        expect(r.error).toContain("not valid base32");
    }, 60_000);
});

describe("a generated script", () => {
    const spec = {
        title: "Two-step login reaches the account",
        kind: "web",
        category: "Authentication",
        steps: [
            { action: "navigate", url: "/login" },
            { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
            { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
            { action: "click", locator: { by: "role", role: "button", value: "Log in" } },
            { action: "fill", locator: { by: "label", value: "6-digit code" }, value: "{{credentials.totp}}" },
            { action: "click", locator: { by: "role", role: "button", value: "Verify" } },
            { action: "assert", check: "text", locator: { by: "role", role: "heading", value: "Welcome back" }, expected: "Welcome back" },
        ],
    };

    it("computes the code itself at run time, carries no secret, and renders per-role names", () => {
        const script = renderScript(TestSpecSchema.parse({ ...spec, testId: "WEB-001" }), "playwright", { baseUrl: BASE }).content;
        expect(script).toContain('import { createHmac } from "node:crypto";');
        expect(script).toContain("function totpCode(");
        expect(script).toContain('totpCode(process.env.TEST_TOTP_SECRET ?? "")');
        expect(script).not.toContain(SECRET);

        const roles = renderScript(
            TestSpecSchema.parse({ ...spec, testId: "WEB-002", steps: [{ action: "navigate", url: "/" }, { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.admin.username}}" }, { action: "fill", locator: { by: "label", value: "Code" }, value: "{{credentials.admin.totp}}" }] }),
            "playwright",
            { baseUrl: BASE },
        ).content;
        expect(roles).toContain("process.env.TEST_ADMIN_USERNAME");
        expect(roles).toContain('totpCode(process.env.TEST_ADMIN_TOTP_SECRET ?? "")');
    });

    it("is not given a code helper when it does not use one", () => {
        const plain = renderScript(TestSpecSchema.parse({ ...spec, testId: "WEB-003", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Sign in" } }] }), "playwright", { baseUrl: BASE }).content;
        expect(plain).not.toContain("totpCode");
        expect(plain).not.toContain("createHmac");
    });

    describe("validated by the platform", () => {
        let platform: Platform;
        let worker: Worker;
        let server: Awaited<ReturnType<typeof buildServer>>;
        let dir: string;
        beforeAll(async () => {
            for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-totp-"));
            platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
            server = await buildServer(platform);
            worker = new Worker(platform, 200);
            worker.start();
        }, 30_000);
        afterAll(async () => {
            await worker?.stop();
            await server?.close();
            platform?.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        });
        const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
            const res = await server.inject({ method, url, payload: payload as never });
            return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
        };

        it("passes with the secret, never exposes it, and refuses a malformed one", async () => {
            const project = (await call("POST", "/api/projects", { name: "2FA" })).body.id as string;
            const res = await call("POST", `/api/projects/${project}/specs`, { specs: [spec], baseUrl: BASE, credentials: { username: "demo@example.com", password: "Password123!", totpSecret: SECRET } });
            expect(res.status).toBe(202);
            for (let i = 0; i < 240; i++) {
                const j = (await call("GET", `/api/test-generation/${res.body.jobId}`)).body;
                if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
                await new Promise((r) => setTimeout(r, 500));
            }
            const tests = (await call("GET", `/api/projects/${project}/tests`)).body as Array<{ id: string; validationStatus: string; validationReason: string | null }>;
            expect(tests[0]!.validationStatus, tests[0]!.validationReason ?? "").toBe("VALIDATED");

            const everything = JSON.stringify([(await call("GET", `/api/projects/${project}`)).body, (await call("GET", `/api/tests/${tests[0]!.id}`)).body, (await call("GET", `/api/projects/${project}/specs`)).body]);
            expect(everything).not.toContain(SECRET);

            const bad = await call("POST", `/api/projects/${project}/specs`, { specs: [spec], baseUrl: BASE, credentials: { username: "u", password: "p", totpSecret: "not base32!" } });
            expect(bad.status).toBe(400);
        }, 240_000);
    });
});
