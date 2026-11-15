/**
 * The evidence helper every web script carries (src/engine/evidence/capture.ts), batch E8: secret-named environment settings and a bare
 * auth credential are masked in the script itself, a page error keeps a short masked stack, and each step records where the page was
 * (path and title). The step marker fault injection relies on (`evidenceStep(page, N);`) is unchanged, and older evidence still parses.
 */
import http from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVIDENCE_HELPER_SOURCE, loadEvidenceRuntime } from "../src/engine/evidence/capture.js";
import { sanitizeEvidence, type Evidence } from "../src/engine/evidence/model.js";
import { renderScript } from "../src/engine/generators/index.js";
import { faultScript, faultsFor } from "../src/engine/mutation/faults.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { socketFaultScript } from "../src/engine/web/socket-faults.js";

const rt = loadEvidenceRuntime();
const SECRET_NAME = new RegExp(/const EVIDENCE_SECRET_SETTING_NAME = \/(.+)\/i;/.exec(EVIDENCE_HELPER_SOURCE)![1]!, "i");

/** The names the platform's secret policy and the script agree on (the policy's own test uses the same list). */
const SECRET_NAMES = ["DB_PASSWORD", "db-password", "dbPassword", "PASSPHRASE", "apiKey", "API-KEY", "x_api_key", "clientSecret", "CLIENT_SECRET", "accessToken", "refresh-token", "AUTH_HEADER", "Authorization", "proxy-authorization", "COOKIE", "cookies", "sessionId", "SESSION_KEY", "session", "SID", "app_sid", "privateKey", "secret-key", "jwt", "TOTP", "credentials", "DATABASE_DSN", "connectionString"];
const PLAIN_NAMES = ["BASE_URL", "PUBLIC_KEY", "SORT_KEY", "keyword", "user_id", "tokenizer", "passwordPolicy", "COOKIE_BANNER_TEXT", "outside", "consider", "status_code", "region"];

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
    const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
        return fn();
    } finally {
        for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

describe("secrets the script finds itself", () => {
    it("the setting-name rule matches the platform's secret policy, name for name", async () => {
        for (const n of SECRET_NAMES) expect(SECRET_NAME.test(n), n).toBe(true);
        for (const n of PLAIN_NAMES) expect(SECRET_NAME.test(n), n).toBe(false);
        // Once the shared policy is in this tree, the two patterns must be the very same.
        const policy = await import("../src/engine/evidence/secret-policy.js" as string).catch(() => undefined);
        if (policy?.SECRET_SETTING_NAME) expect(SECRET_NAME.source).toBe((policy.SECRET_SETTING_NAME as RegExp).source);
    });

    it("masks an environment's secret-named settings, never its plain ones nor ordinary words", () => {
        const s = withEnv({ TEST_ENV_clientSecret: "env-client-secret-1", TEST_ENV_DB_PASSWORD: "env-db-pw-22", TEST_ENV_SHOW_COOKIES: "true", TEST_ENV_PUBLIC_KEY: "pub-key-plain", TEST_ENV_BASE_URL: "https://app.example" }, () => rt.evidenceSecrets());
        expect(s).toContain("env-client-secret-1");
        expect(s).toContain("env-db-pw-22");
        for (const v of ["true", "pub-key-plain", "https://app.example"]) expect(s).not.toContain(v);
        const text = rt.evidenceText("client secret env-client-secret-1 and key pub-key-plain", s);
        expect(text).not.toContain("env-client-secret-1");
        expect(text).toContain("pub-key-plain");
    });

    it("an auth header's credential is masked alone, without its scheme word", () => {
        const s = withEnv({ API_AUTH_HEADER: "Authorization: Bearer hdr-cred-4455" }, () => rt.evidenceSecrets());
        expect(s).toContain("hdr-cred-4455");
        expect(rt.evidenceText("token hdr-cred-4455 seen", s)).not.toContain("hdr-cred-4455");
    });
});

describe("in a real browser: stacks and where each step was", () => {
    let server: http.Server;
    let browser: Browser;
    const PORT = 9581;
    const SECRET = "Stack-Secret-9911";
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            res.setHeader("content-type", "text/html");
            if (req.url!.startsWith("/boom")) {
                res.end(`<title>Broken page ${SECRET}</title><script>function explode(){ throw new Error("bad thing ${SECRET}") } setTimeout(explode, 10)</script>`);
                return;
            }
            res.end("<title>Home</title><p>ok</p>");
        });
        await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
        browser = await chromium.launch();
    }, 60_000);
    afterAll(async () => {
        await browser?.close();
        await new Promise<void>((r) => server.close(() => r()));
    });

    it("keeps a masked stack for a page error, and each step's path and title (query values hidden)", async () => {
        const page = await browser.newPage();
        const rec = rt.installEvidence(page, `http://127.0.0.1:${PORT}/`);
        await page.goto(`http://127.0.0.1:${PORT}/`);
        rt.evidenceStep(page, 1);
        // The title is best effort: it comes back with the page's load, after the step marker here.
        await page.waitForTimeout(100);
        await page.goto(`http://127.0.0.1:${PORT}/boom?token=${SECRET}&q=shoes`);
        await page.waitForTimeout(300);
        rt.evidenceStep(page, 2);
        await page.waitForTimeout(200);
        const out = rt.evidenceSerialize(rec, [SECRET]) as Evidence & { console: Array<{ stack?: string; type: string }> };
        await page.close();
        const err = out.console.find((l) => l.type === "pageerror")!;
        expect(err.stack).toMatch(/explode/);
        expect(err.stack!.length).toBeLessThanOrEqual(1500);
        expect(out.steps[0]).toMatchObject({ n: 1, url: "/", title: "Home" });
        expect(out.steps[1]!.url).toBe("/boom?token=[hidden]&q=shoes");
        expect(out.steps[1]!.title).toMatch(/^Broken page/);
        expect(JSON.stringify(out)).not.toContain(SECRET);
        // The platform reads it back unchanged in shape, and masks it again.
        const stored = sanitizeEvidence(out, [SECRET])!;
        expect(stored.steps[1]!.url).toBe("/boom?token=[hidden]&q=shoes");
        expect(stored.console.find((l) => l.type === "pageerror")!.stack).toMatch(/explode/);
        expect(JSON.stringify(stored)).not.toContain(SECRET);
    }, 60_000);
});

describe("compatibility", () => {
    const spec = (steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "A test", kind: "web", category: "Forms", source: { origin: "browser-agent" }, steps });
    const s = spec([{ action: "navigate", url: "/" }, { action: "click", locator: { by: "role", role: "button", value: "Go" } }, { action: "assert", check: "visible", expected: "Done" }]);

    it("the rendered script keeps the exact step markers, so fault injection still finds every step", () => {
        const script = renderScript(s, "playwright", { baseUrl: "http://127.0.0.1:1" });
        for (const n of [1, 2, 3]) expect(script.content).toContain(`\n    evidenceStep(page, ${n});\n`);
        for (const f of faultsFor(s)) expect(faultScript(s, { baseUrl: "http://127.0.0.1:1" }, f), f.kind).toBeDefined();
        expect(socketFaultScript(s, { baseUrl: "http://127.0.0.1:1" }, "socket-drop" as never) ?? socketFaultScript(s, { baseUrl: "http://127.0.0.1:1" }, "offline")).toBeDefined();
    });

    it("evidence written by older scripts (no stack, no step address) still parses unchanged", () => {
        const old: Evidence = { v: 1, durationMs: 5, counts: { requests: 0, requestsKept: 0, console: 1, consoleKept: 1 }, steps: [{ n: 1, t: 1 }], requests: [], console: [{ t: 1, step: 1, type: "pageerror", text: "x" }] };
        expect(sanitizeEvidence(old)).toEqual(old);
        expect(sanitizeEvidence(sanitizeEvidence(old))).toEqual(old);
    });

    it("stays under the size cap with many long stacks", () => {
        const big = { v: 1, durationMs: 5, counts: { requests: 0, requestsKept: 0, console: 200, consoleKept: 200 }, steps: [], requests: [], console: Array.from({ length: 200 }, (_, i) => ({ t: i, step: 1, type: "pageerror", text: "e".repeat(2000), stack: "at f (/a.js:1)\n".repeat(100).slice(0, 1500) })) };
        const out = sanitizeEvidence(big)!;
        expect(out).toBeDefined();
        expect(JSON.stringify(out).length).toBeLessThanOrEqual(600_000);
    });
});
