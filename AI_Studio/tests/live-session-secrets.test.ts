/**
 * Fixes AZ2 (review AX, H2 / M4 / M7) in a real Chromium: a stand-in is typed only into the field meant for it, an echo of what was typed (URL-encoded, a live
 * one-time code, a field cut short by maxlength) never comes back through a snapshot, the page's address is checked right before the characters are typed, and
 * a step the page reports late is still stored as its stand-in.
 * Runs browsers: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/live-session-secrets.test.ts
 * Ports: fixture application 6230.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { LIVE_LIMITS } from "../src/engine/recorder/act.js";
import { RecorderError, RecorderSession } from "../src/engine/recorder/session.js";
import { totp } from "../src/engine/identity/totp.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import type { Recording } from "../src/platform/recorder-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { recorderOptions } from "../src/platform/routes/recorder.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 6230;
const APP = `http://127.0.0.1:${PORT}`;
const OTHER = `http://localhost:${PORT}`;
const USERNAME = "az2.tester@example.test";
const PASSWORD = "Pw 9x&z!Q7-az2";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AZ2 login</title></head><body><main><h1>Sign in</h1>
<p><label for="email">Email</label> <input id="email" type="text"></p>
<p><label for="short">Short name</label> <input id="short" type="text" maxlength="5"></p>
<p><label for="notes">Notes</label> <input id="notes" type="text"></p>
<p><label for="pw">Password</label> <input id="pw" type="password"></p>
<p><label for="code">Code</label> <input id="code" type="text" autocomplete="one-time-code"></p>
<p id="echo"></p><p id="echo2"></p>
</main><script>
document.getElementById("pw").addEventListener("input", function () { document.getElementById("echo").textContent = "q=" + encodeURIComponent(this.value); });
document.getElementById("code").addEventListener("input", function () { document.getElementById("echo2").textContent = "seen " + this.value; });
</script></body></html>`;

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let app: http.Server;
let pid: string;
const launched: Browser[] = [];
const answers: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}
const launch = async (headless: boolean) => {
    const b = await chromium.launch({ headless });
    launched.push(b);
    return b;
};
const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    answers.push(res.body);
    return { status: res.statusCode, body: res.body && (res.body.startsWith("{") || res.body.startsWith("[")) ? JSON.parse(res.body) : null, text: res.body };
};
const act = (rid: string, body: Record<string, unknown>) => call("POST", `/api/recordings/${rid}/act`, body);
const snapshot = (rid: string) => call("GET", `/api/recordings/${rid}/snapshot`);
const field = (label: string) => ({ strategy: "label", value: label, exact: true }) as const;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-az2-"));
    Object.assign(recorderOptions, { launch });
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "1" }));
    server = await buildServer(platform);
    app = http.createServer((req, res) => {
        const p = (req.url ?? "/").split("?")[0];
        if (p === "/login" || p === "/other") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return void res.end(PAGE);
        }
        if (p === "/refresh") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return void res.end(PAGE.replace("<title>", `<meta http-equiv="refresh" content="0.6;url=${OTHER}/other"><title>`));
        }
        res.writeHead(404);
        res.end("no");
    });
    await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
    pid = (await call("POST", "/api/projects", { name: "AZ2 secrets" })).body.id;
    platform.repo.createApplication(pid, APP, { ...DEFAULT_JOB_OPTIONS }, { username: USERNAME, password: PASSWORD, totpSecret: TOTP_SECRET });
}, 60_000);

afterAll(async () => {
    await server?.close();
    for (const b of launched) await b.close().catch(() => undefined);
    app?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("live session: stand-ins and read-back (H2, M7)", () => {
    let rid: string;
    let page: Page;

    it("opens a session on the sample page", async () => {
        const before = launched.length;
        const res = await call("POST", `/api/projects/${pid}/recordings`, { url: `${APP}/login`, headed: false });
        expect(res.status, res.text).toBe(201);
        // loopback is allowed while the guard is off, and the answer says so once
        expect(res.body.warnings).toHaveLength(1);
        expect(res.body.warnings[0]).toMatch(/BLOCK_PRIVATE_TARGETS/);
        rid = res.body.id;
        page = await until<Page>(() => (launched.length > before ? launched[before]!.contexts()[0]?.pages()[0] : undefined), "the browser");
        await until(async () => ((await call("GET", `/api/recordings/${rid}`)).body as Recording).status === "recording" && page.url().startsWith("http"), "recording");
        await page.waitForLoadState("domcontentloaded");
        await sleep(300);
    }, 60_000);

    it("H2: the password and the code stand-ins are refused in an ordinary field, and nothing is typed", async () => {
        for (const v of ["{{credentials.password}}", "{{credentials.totp}}"]) {
            const r = await act(rid, { action: "fill", locator: field("Notes"), value: v });
            expect(r.status, v).toBe(422);
            expect(r.body.error).toMatch(/Only \{\{credentials\.username\}\} can be typed into an ordinary field/);
        }
        expect(await page.inputValue("#notes")).toBe("");
        expect(answers.join("\n")).not.toContain(PASSWORD);
    });

    it("M7: a step the page reports late is still stored as the stand-in, never as the typed user name", async () => {
        const limits = LIVE_LIMITS as unknown as { stepWaitMs: number };
        const keep = limits.stepWaitMs;
        limits.stepWaitMs = 1; // the action answers before the page has reported the field
        let r;
        try {
            r = await act(rid, { action: "fill", locator: field("Email"), value: "{{credentials.username}}" });
        } finally {
            limits.stepWaitMs = keep;
        }
        expect(r.status, r.text).toBe(200);
        expect(await page.inputValue("#email")).toBe(USERNAME);
        const rec = await until(async () => {
            const x = (await call("GET", `/api/recordings/${rid}`)).body as Recording;
            return x.steps.some((s) => s.kind === "fill" && /email/i.test(s.describe)) ? x : undefined;
        }, "the late step");
        const fill = rec.steps.find((s) => s.kind === "fill" && /email/i.test(s.describe))!;
        expect(fill.value).toBe("{{credentials.username}}");
        expect(JSON.stringify(rec.steps)).not.toContain(USERNAME);
    }, 30_000);

    it("H2: a field cut short by maxlength shows [hidden], also in a snapshot taken later", async () => {
        const r = await act(rid, { action: "fill", locator: field("Short name"), value: "{{credentials.username}}" });
        expect(r.status, r.text).toBe(200);
        expect(await page.inputValue("#short")).toBe(USERNAME.slice(0, 5));
        const el = (s: any) => (s.elements as Array<Record<string, any>>).find((e) => e.name === "Short name")!;
        expect(el(r.body.snapshot)).toMatchObject({ value: "[hidden]", secret: true });
        const later = await snapshot(rid);
        expect(el(later.body)).toMatchObject({ value: "[hidden]", secret: true });
        expect(later.text).not.toContain(USERNAME.slice(0, 5));
        expect(await page.locator("[data-aitp-secret]").count()).toBe(0);
    });

    it("H2: an echo of the password, URL-encoded by the page, does not come back", async () => {
        const r = await act(rid, { action: "fill", locator: field("Password"), value: "{{credentials.password}}" });
        expect(r.status, r.text).toBe(200);
        expect(await page.textContent("#echo")).toContain(encodeURIComponent(PASSWORD)); // the page really shows it
        for (const text of [r.text, (await snapshot(rid)).text]) {
            expect(text).not.toContain(encodeURIComponent(PASSWORD));
            expect(text).not.toContain(PASSWORD);
        }
        expect(r.body.snapshot.text).toContain("[hidden]");
    });

    it("H2: the live one-time code is scrubbed from a snapshot taken after the action", async () => {
        const r = await act(rid, { action: "fill", locator: field("Code"), value: "{{credentials.totp}}" });
        expect(r.status, r.text).toBe(200);
        const shown = (await page.textContent("#echo2"))!.replace("seen ", "");
        expect(shown).toMatch(/^\d{6}$/);
        const codes = [-1, 0, 1].map((w) => totp(TOTP_SECRET, { now: Date.now() + w * 30_000 }));
        expect(codes).toContain(shown);
        await sleep(300);
        const later = await snapshot(rid);
        expect(later.text).not.toContain(shown);
        expect(r.text).not.toContain(shown);
        for (const c of codes) expect(later.text).not.toContain(c);
        expect(later.body.text).toContain("seen [hidden]");
    });

    it("the recorded steps carry stand-ins only", async () => {
        const rec = (await call("GET", `/api/recordings/${rid}`)).body as Recording;
        const text = JSON.stringify(rec.steps);
        for (const secret of [USERNAME, PASSWORD]) expect(text, secret).not.toContain(secret);
        expect(text).toContain("{{credentials.password}}");
        expect(answers.join("\n")).not.toContain(PASSWORD);
        expect((await call("DELETE", `/api/recordings/${rid}`)).status).toBe(200);
    });
});

describe("recorder core: the page's address is checked right before a stand-in is typed (M4)", () => {
    let browser: Browser | undefined;
    const open = async (url: string) => {
        const s = new RecorderSession({
            startUrl: url,
            headed: false,
            launch: async (headless) => {
                browser = await chromium.launch({ headless });
                return browser;
            },
        });
        s.start();
        await until(() => s.status === "recording", "recording");
        const page = browser!.contexts()[0]!.pages()[0]!;
        await page.waitForLoadState("domcontentloaded");
        await sleep(300);
        return { s, page };
    };
    afterAll(async () => {
        await browser?.close().catch(() => undefined);
    });

    it("types on the application's own origin, and refuses (typing nothing) once the page is on another origin", async () => {
        const { s, page } = await open(`${APP}/login`);
        await s.act({ action: "fill", locator: field("Email"), value: "{{credentials.username}}" }, { secret: USERNAME, origins: [APP] });
        expect(await page.inputValue("#email")).toBe(USERNAME);

        // The page moves to the second origin (127.0.0.1 and localhost are different origins) before the next stand-in is typed.
        await page.goto(`${OTHER}/other`);
        await expect(s.act({ action: "fill", locator: field("Email"), value: "{{credentials.username}}" }, { secret: "Another-secret-77", origins: [APP] })).rejects.toMatchObject({
            status: 422,
            message: expect.stringMatching(/only typed on the application's own site \(http:\/\/127\.0\.0\.1:6230\).*localhost:6230.*nothing was typed/),
        });
        expect(await page.inputValue("#email")).toBe("");
        // an ordinary value is not a stand-in: it is typed there as before
        await s.act({ action: "fill", locator: field("Email"), value: "plain text" }, { origins: [APP] });
        expect(await page.inputValue("#email")).toBe("plain text");
        await s.discard();
    }, 60_000);

    it("a page that redirects to the second origin by itself never receives the secret", async () => {
        const { s, page } = await open(`${APP}/refresh`);
        let outcome: "typed-before-move" | "refused" | "no-element" = "refused";
        try {
            await s.act({ action: "fill", locator: field("Email"), value: "{{credentials.username}}" }, { secret: "Redirect-secret-4471", origins: [APP] });
            outcome = "typed-before-move";
        } catch (e) {
            outcome = e instanceof RecorderError && /nothing was typed/.test(e.message) ? "refused" : "no-element";
        }
        // Wherever the race ended, the second origin's page never holds the secret.
        await page.waitForURL(`${OTHER}/other`, { timeout: 10_000 });
        expect(await page.inputValue("#email")).toBe("");
        expect(["typed-before-move", "refused", "no-element"]).toContain(outcome);
        await s.discard();
    }, 60_000);
});
