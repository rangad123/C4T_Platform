/**
 * Passive security checks: spec generation, the check helper (unit-tested on synthetic responses and
 * executed for real by the Playwright API runner against fixture servers), finding classification and
 * severity.
 *
 * Fixtures (examples/checks-app): a deliberately weak app (5210), a hardened app (5211), a single-page
 * app that answers 200 + HTML for every path (5212), and https variants with self-signed certificates
 * (5213 trusted-name-but-self-signed, 5214 wrong host name, 5215/5216 short-lived / expired certificates
 * when `openssl` is available). Nothing leaves the machine.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { EXPOSED_FILE_GROUPS, evaluateSecurity, loadSecurityRuntime, SECURITY_FAILURE_PREFIX, SECURITY_HELPER_SOURCE, type SecurityCall } from "../src/engine/security/checks.js";
import { generateSecuritySpecs, parseSecurityReason, securityFinding } from "../src/engine/security/specs.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { assessSeverity } from "../src/engine/validation/severity.js";
import { runScripts, type RunEnv, type ScriptRun } from "../src/engine/validation/runner.js";
import { modelFor, startChecksApp } from "./fixtures/checks-app.js";
import { removeMintedTls, selfSignedTls, TLS_SKIP_REASON } from "./fixtures/tls-files.js";

const PORTS = { weak: 5210, hardened: 5211, spa: 5212, tlsSelfSigned: 5213, tlsWrongHost: 5214, tlsExpiring: 5215, tlsExpired: 5216 };
const url = (port: number, scheme = "http") => `${scheme}://127.0.0.1:${port}`;
const children: ChildProcess[] = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-"));

/** openssl is only needed to mint short-lived certificates; without it those two tests are skipped. */
function findOpenssl(): string | undefined {
    for (const bin of ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "/usr/bin/openssl"]) {
        try {
            execFileSync(bin, ["version"], { stdio: "ignore" });
            return bin;
        } catch {
            /* try the next one */
        }
    }
    return undefined;
}
const openssl = findOpenssl();

/** Writes a self-signed localhost certificate into tests/fixtures/tls under `name`, valid for `days`. */
function mintCert(name: string, days: number): void {
    const dir = path.join(REPO_ROOT, "tests/fixtures/tls");
    execFileSync(openssl!, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(scratch, `${name}.key`), "-out", path.join(scratch, `${name}.crt`), "-days", String(days), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    fs.copyFileSync(path.join(scratch, `${name}.key`), path.join(dir, `${name}.key`));
    fs.copyFileSync(path.join(scratch, `${name}.crt`), path.join(dir, `${name}.crt`));
}
const minted: string[] = [];
// The published certificates, or ones made now when their keys are not in the checkout (tests/fixtures/tls-files.ts).
const SELF_SIGNED = selfSignedTls("localhost");
const WRONG_HOST = selfSignedTls("wrong-host");
if (!SELF_SIGNED || !WRONG_HOST) console.warn(TLS_SKIP_REASON);

beforeAll(async () => {
    children.push(
        await startChecksApp(PORTS.weak, "weak"),
        await startChecksApp(PORTS.hardened, "hardened"),
        await startChecksApp(PORTS.spa, "spa"),
        ...(SELF_SIGNED ? [await startChecksApp(PORTS.tlsSelfSigned, "hardened", SELF_SIGNED.name)] : []),
        ...(WRONG_HOST ? [await startChecksApp(PORTS.tlsWrongHost, "hardened", WRONG_HOST.name)] : []),
    );
    if (openssl) {
        // days=5 expires soon; days=0 expires the moment it is created.
        for (const [name, days, port] of [["short-lived", 5, PORTS.tlsExpiring], ["already-expired", 0, PORTS.tlsExpired]] as const) {
            try {
                mintCert(name, days);
                minted.push(name);
                children.push(await startChecksApp(port, "hardened", name));
            } catch {
                /* this openssl cannot mint such a certificate: that test is skipped */
            }
        }
    }
}, 60_000);

afterAll(() => {
    for (const c of children) c.kill();
    removeMintedTls();
    for (const name of minted) for (const ext of ["key", "crt"]) fs.rmSync(path.join(REPO_ROOT, `tests/fixtures/tls/${name}.${ext}`), { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
});

const call = (over: Partial<SecurityCall> = {}): SecurityCall => ({ status: 200, headers: {}, text: "", url: "http://shop.example/", sent: {}, setCookies: [], ...over });
const message = (check: Parameters<typeof evaluateSecurity>[0], calls: SecurityCall[], expected?: string | number) => evaluateSecurity(check, calls, expected);

const ALL_HEADERS = {
    "content-security-policy": "default-src 'self'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000",
};

describe("generateSecuritySpecs", () => {
    const http = modelFor(url(PORTS.weak), [{ path: "/", type: "home" }], [{ method: "GET", path: "/api/items", origin: url(PORTS.weak) } as never, { method: "POST", path: "/api/items", origin: url(PORTS.weak) } as never]);
    const https = modelFor("https://shop.example", [{ path: "/", type: "home" }]);

    it("produces one valid read-only group of API specs per origin", () => {
        const drafts = generateSecuritySpecs(http);
        expect(drafts.map((d) => d.title)).toEqual([
            "Browser security headers are set (/)",
            "Session cookies are protected (/)",
            "Cross-origin access (CORS) is not wide open",
            "Secret and source-control files cannot be downloaded",
            "Backups and server diagnostic pages cannot be downloaded",
            "The server does not reveal software versions or list folders",
        ]);
        drafts.forEach((d, i) => {
            const spec = TestSpecSchema.parse({ ...d, testId: `API-${String(i + 1).padStart(3, "0")}` });
            expect(spec).toMatchObject({ kind: "api", type: "security", category: "Security checks", source: { origin: "security-check" } });
            // GET only, never with credentials, and no request bodies
            for (const s of spec.steps) {
                if (s.action === "request") {
                    expect(s).toMatchObject({ method: "GET", auth: "none" });
                    expect("body" in s).toBe(false);
                }
            }
        });
        // the CORS probe uses the discovered GET endpoint, not the POST one
        const cors = drafts.find((d) => d.title.startsWith("Cross-origin"))!;
        expect(cors.steps.filter((s) => s.action === "request").map((s) => (s as { path: string }).path)).toEqual(["/", "/api/items"]);
    });

    it("never asks plain-http sites for HSTS or a certificate, and says why", () => {
        const drafts = generateSecuritySpecs(http);
        const headers = drafts[0]!;
        expect(headers.steps.find((s) => s.action === "assertResponse")).toMatchObject({ expected: "csp,frame,nosniff,referrer" });
        expect(headers.description).toMatch(/plain http, which cannot have it/);
        expect(drafts.some((d) => /certificate/i.test(d.title))).toBe(false);
    });

    it("adds HSTS and the certificate check on https sites", () => {
        const drafts = generateSecuritySpecs(https);
        expect(drafts[0]!.steps.find((s) => s.action === "assertResponse")).toMatchObject({ expected: "csp,frame,nosniff,referrer,hsts" });
        expect(drafts.at(-1)!.title).toBe("The HTTPS certificate is valid and not about to expire");
    });

    it("judges headers on the first page that loaded, and file probes only ask for the first 4 KB", () => {
        const m = modelFor(url(PORTS.weak), [{ path: "/broken", type: "error", status: 500 }, { path: "/en/", type: "home" }]);
        expect(generateSecuritySpecs(m)[0]!.title).toBe("Browser security headers are set (/en/)");
        const probes = generateSecuritySpecs(http).find((d) => d.title.startsWith("Secret"))!.steps.filter((s) => s.action === "request");
        expect(probes.map((s) => (s as { path: string }).path)).toEqual([...EXPOSED_FILE_GROUPS.secrets]);
        expect(probes.every((s) => (s as { headers: Record<string, string> }).headers.Range === "bytes=0-4095")).toBe(true);
    });
});

describe("check helper on synthetic responses", () => {
    it("securityHeaders: reports each missing header with how to fix it, and accepts a complete set", async () => {
        const bare = await message("securityHeaders", [call({ url: "https://shop.example/" })]);
        expect(bare).toMatch(new RegExp(`^${SECURITY_FAILURE_PREFIX} 5 browser security headers missing or weak\\n`));
        expect(bare).toContain("- [medium] Content-Security-Policy is missing");
        expect(bare!.match(/- \[low\]/g)).toHaveLength(4);
        expect(bare!.length).toBeLessThan(800); // the runner truncates step errors at 800 characters
        expect(await message("securityHeaders", [call({ url: "https://shop.example/", headers: ALL_HEADERS })])).toBeUndefined();
    });

    it("securityHeaders: frame-ancestors satisfies the framing check; weak or missing HSTS is flagged only on https", async () => {
        const csp = { ...ALL_HEADERS, "x-frame-options": "", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" } as Record<string, string>;
        delete csp["x-frame-options"];
        expect(await message("securityHeaders", [call({ url: "https://shop.example/", headers: csp })])).toBeUndefined();
        const weakHsts = await message("securityHeaders", [call({ url: "https://shop.example/", headers: { ...ALL_HEADERS, "strict-transport-security": "max-age=60" } })]);
        expect(weakHsts).toContain("Strict-Transport-Security lasts under 6 months");
        // plain http is never flagged for HSTS, even when the check asks for it
        const { "strict-transport-security": _h, ...noHsts } = ALL_HEADERS;
        expect(await message("securityHeaders", [call({ url: "http://shop.example/", headers: noHsts })])).toBeUndefined();
        const httpBare = await message("securityHeaders", [call({ url: "http://shop.example/" })]);
        expect(httpBare).not.toMatch(/Strict-Transport-Security/);
        expect(httpBare).toContain("4 browser security headers missing or weak");
    });

    it("securityHeaders: only judges what the spec asks for, and ignores an unsafe Referrer-Policy value only when it is set", async () => {
        expect(await message("securityHeaders", [call()], "csp")).toContain("1 browser security header missing or weak");
        expect(await message("securityHeaders", [call({ headers: { ...ALL_HEADERS, "referrer-policy": "unsafe-url" } })], "referrer")).toContain("Referrer-Policy is missing or unsafe");
    });

    it("cookieFlags: flags session cookies only, exempts CSRF cookies, and demands Secure only on https", async () => {
        const cookies = ["sessionid=abc; Path=/", "theme=dark; Path=/", "XSRF-TOKEN=t; Path=/", "auth_token=x; Path=/; HttpOnly; SameSite=Lax"];
        const http = await message("cookieFlags", [call({ setCookies: cookies })]);
        expect(http).toContain("1 session cookie not fully protected");
        expect(http).toContain('- [medium] Cookie "sessionid" is missing HttpOnly (page scripts can read it), SameSite');
        expect(http).not.toContain("Secure (it can");
        expect(http).not.toMatch(/theme|XSRF|auth_token/);
        const https = await message("cookieFlags", [call({ url: "https://shop.example/", setCookies: cookies })]);
        expect(https).toContain("2 session cookies not fully protected");
        expect(https).toContain('Cookie "auth_token" is missing Secure');
        // fully protected / SameSite only missing (low)
        expect(await message("cookieFlags", [call({ url: "https://shop.example/", setCookies: ["sid=1; HttpOnly; Secure; SameSite=Strict"] })])).toBeUndefined();
        expect(await message("cookieFlags", [call({ url: "https://shop.example/", setCookies: ["sid=1; HttpOnly; Secure"] })])).toContain("- [low]");
        expect(await message("cookieFlags", [call({ url: "https://shop.example/", setCookies: ["sid=1; HttpOnly; SameSite=None"] })])).toContain("Secure, which SameSite=None needs");
        expect(await message("cookieFlags", [call({ setCookies: [] })])).toBeUndefined();
    });

    it("corsPolicy: wildcard / echoed origin with credentials is high, an echoed origin alone medium, a plain wildcard is fine", async () => {
        const sent = { origin: "https://untrusted-origin.example" };
        const cors = (headers: Record<string, string>) => message("corsPolicy", [call({ url: "http://shop.example/api/x", sent, headers })]);
        expect(await cors({ "access-control-allow-origin": "*", "access-control-allow-credentials": "true" })).toContain("- [high] /api/x allows any website to send logged-in requests");
        expect(await cors({ "access-control-allow-origin": sent.origin, "access-control-allow-credentials": "true" })).toContain("- [high] /api/x echoes back any Origin and allows credentials");
        expect(await cors({ "access-control-allow-origin": "null", "access-control-allow-credentials": "true" })).toContain("'null' origin");
        expect(await cors({ "access-control-allow-origin": sent.origin })).toContain("- [medium] /api/x echoes back any Origin");
        expect(await cors({ "access-control-allow-origin": "*" })).toBeUndefined();
        expect(await cors({ "access-control-allow-origin": "https://app.shop.example", "access-control-allow-credentials": "true" })).toBeUndefined();
        // a response to a request that carried no probe Origin says nothing about CORS
        expect(await message("corsPolicy", [call({ headers: { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" } })])).toBeUndefined();
    });

    it("noExposedFiles: needs the file's content signature, never just HTTP 200", async () => {
        const html = "<!doctype html><html><head><title>App</title></head><body><div id=app></div></body></html>";
        const everyPath = [...EXPOSED_FILE_GROUPS.secrets, ...EXPOSED_FILE_GROUPS.other].map((p) => call({ url: `http://shop.example${p}`, headers: { "content-type": "text/html" }, text: html }));
        expect(await message("noExposedFiles", everyPath)).toBeUndefined();

        const hit = (p: string, text: string, headers: Record<string, string> = { "content-type": "text/plain" }, status = 200) => call({ url: `http://shop.example${p}`, text, headers, status });
        expect(await message("noExposedFiles", [hit("/.git/HEAD", "ref: refs/heads/main\n")])).toContain("- [critical] /.git/HEAD can be downloaded by anyone");
        expect(await message("noExposedFiles", [hit("/.env", "DB_PASSWORD=hunter2\nAPI_KEY=x\n")])).toContain("- [critical] /.env");
        expect(await message("noExposedFiles", [hit("/.env", "DB_PASSWORD=hunter2", { "content-type": "text/html" })])).toBeUndefined(); // HTML is not a .env
        expect(await message("noExposedFiles", [hit("/.env", "just some words\n")])).toBeUndefined();
        expect(await message("noExposedFiles", [hit("/.git/config", "[core]\n\trepositoryformatversion = 0\n")])).toContain("/.git/config");
        expect(await message("noExposedFiles", [hit("/.svn/entries", "12\n\ndir\n")])).toContain("- [high] /.svn/entries");
        expect(await message("noExposedFiles", [hit("/wp-config.php.bak", "<?php define('DB_PASSWORD', 'x');")])).toContain("/wp-config.php.bak");
        expect(await message("noExposedFiles", [hit("/backup.zip", "PK\u0003\u0004rest")])).toContain("- [high] /backup.zip");
        expect(await message("noExposedFiles", [hit("/.DS_Store", "\u0000\u0000\u0000\u0001Bud1")])).toContain("- [low] /.DS_Store");
        expect(await message("noExposedFiles", [hit("/server-status", "<h1>Apache Server Status for x</h1>", { "content-type": "text/html" })])).toContain("- [medium] /server-status");
        // a real hit answered with an error status is not a hit; 206 (Range) is
        expect(await message("noExposedFiles", [hit("/.env", "A=b", undefined, 403)])).toBeUndefined();
        expect(await message("noExposedFiles", [hit("/.git/HEAD", "ref: refs/heads/main", undefined, 206)])).toContain("/.git/HEAD");
        // worst first, all hits reported
        const many = await message("noExposedFiles", [hit("/.DS_Store", "\u0000\u0000\u0000\u0001Bud1"), hit("/.env", "A=b")]);
        expect(many).toContain("2 sensitive files are publicly readable");
        expect(many!.indexOf("[critical]")).toBeLessThan(many!.indexOf("[low]"));
    });

    it("noInfoDisclosure: version banners and directory listings, not bare product names", async () => {
        const banner = await message("noInfoDisclosure", [call({ headers: { server: "Apache/2.4.41 (Ubuntu)", "x-powered-by": "PHP/7.4.3" } })]);
        expect(banner).toContain("2 details about the server are exposed");
        expect(banner).toContain('Server header reveals the software version ("Apache/2.4.41 (Ubuntu)")');
        expect(banner).toContain('X-Powered-By header reveals the technology ("PHP/7.4.3")');
        expect(await message("noInfoDisclosure", [call({ headers: { server: "nginx" } })])).toBeUndefined();
        const listing = await message("noInfoDisclosure", [call({ url: "http://shop.example/uploads/", text: "<html><head><title>Index of /uploads/</title></head>" })]);
        expect(listing).toContain("- [medium] /uploads/ lists the files in a folder");
        expect(await message("noInfoDisclosure", [call({ text: "<title>Welcome</title>" })])).toBeUndefined();
    });

    it("certificate judgement: expired, expiring soon, wrong host, untrusted, and a healthy one", () => {
        const { secCertLines } = loadSecurityRuntime();
        const now = Date.parse("2026-06-01T00:00:00Z");
        const cert = (validTo: string, altNames = "DNS:shop.example") => ({ valid_to: validTo, subjectaltname: altNames, subject: { CN: "shop.example" } }) as never;
        expect(secCertLines({ cert: cert("Dec 31 23:59:59 2026 GMT") }, "shop.example", now, 14)).toEqual([]);
        expect(secCertLines({ cert: cert("May 20 00:00:00 2026 GMT") }, "shop.example", now, 14)[0]).toMatch(/^- \[high\] The HTTPS certificate expired on 2026-05-20/);
        const soon = secCertLines({ cert: cert("Jun 10 00:00:00 2026 GMT") }, "shop.example", now, 14);
        expect(soon[0]).toMatch(/^- \[medium\] The HTTPS certificate expires on 2026-06-10 \(in 9 days\)/);
        expect(secCertLines({ cert: cert("Jun 10 00:00:00 2026 GMT") }, "shop.example", now, 5)).toEqual([]); // outside the warning window
        const wrong = secCertLines({ cert: cert("Dec 31 23:59:59 2026 GMT", "DNS:other.example") }, "shop.example", now, 14);
        expect(wrong[0]).toMatch(/^- \[high\] The HTTPS certificate is not valid for shop.example \(it is issued for other.example\)/);
        const untrusted = secCertLines({ cert: cert("Dec 31 23:59:59 2026 GMT"), authError: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }, "shop.example", now, 14);
        expect(untrusted[0]).toMatch(/^- \[medium\] The HTTPS certificate is not trusted \(depth zero self signed cert\)/);
        // expiry and host problems are not double-reported as "untrusted"
        expect(secCertLines({ cert: cert("May 20 00:00:00 2026 GMT"), authError: { code: "CERT_HAS_EXPIRED" } }, "shop.example", now, 14)).toHaveLength(1);
    });

    it("does nothing for tlsCertificate on a plain-http response, and rejects an unknown check", async () => {
        expect(await message("tlsCertificate", [call({ url: "http://shop.example/" })], 14)).toBeUndefined();
        await expect(loadSecurityRuntime().secAssert([call()], "nope" as never)).rejects.toThrow(/Unknown security check/);
    });

    it("caps the message so the runner does not truncate it", async () => {
        const lines = Array.from({ length: 12 }, (_, i) => hitEnv(i));
        const msg = (await message("noExposedFiles", lines))!;
        expect(msg.split("\n").length).toBeLessThanOrEqual(7);
        function hitEnv(i: number): SecurityCall {
            return call({ url: `http://shop.example/${i % 2 ? ".env" : ".git/HEAD"}?${i}`, text: i % 2 ? "A=b" : "ref: refs/heads/x", headers: { "content-type": "text/plain" } });
        }
        expect(msg.length).toBeLessThan(800);
    });
});

describe("generated scripts", () => {
    const specs = generateSecuritySpecs(modelFor("https://shop.example", [{ path: "/", type: "home" }])).map((d, i) => TestSpecSchema.parse({ ...d, testId: `API-${String(i + 1).padStart(3, "0")}` }));
    const render = (s: TestSpec, base = "https://shop.example") => renderScript(s, "playwright-api", { baseUrl: base, apiBaseUrl: "https://api.other.example" });

    it("re-render identically from the spec and carry the helper verbatim", () => {
        for (const s of specs) {
            const a = render(s);
            expect(render(s).content).toBe(a.content);
            expect(a.content).toContain(SECURITY_HELPER_SOURCE);
            expect(a.filename).toBe(`${s.testId}.spec.ts`);
        }
        // the helper is plain text that can live in a template literal
        expect(SECURITY_HELPER_SOURCE).not.toMatch(/`|\$\{/);
    });

    it("target the application origin (not the API base), tolerate bad certificates, and hold no secrets", () => {
        const { content } = render(specs[0]!);
        expect(content).toContain('const API_BASE_URL = process.env.BASE_URL ?? "https://shop.example";');
        expect(content).not.toContain("api.other.example");
        expect(content).toContain("const IGNORE_HTTPS_ERRORS = true;");
        expect(content).toContain("auth: false");
        expect(content).not.toContain("auth: true"); // the token / auth-header branch of the helper is never taken
        // other API specs keep their own base URL and strict certificate handling
        const other = TestSpecSchema.parse({ testId: "API-100", title: "Items respond", kind: "api", steps: [{ action: "request", method: "GET", path: "/api/items" }, { action: "assertResponse", check: "status", expected: 200 }] });
        const o = render(other).content;
        expect(o).toContain('process.env.API_BASE_URL ?? "https://api.other.example"');
        expect(o).toContain("const IGNORE_HTTPS_ERRORS = false;");
        expect(o).not.toContain("SEC_PREFIX");
    });
});

/** Render + run specs with the real Playwright runner (no browser is started: these are API tests). */
async function run(specs: TestSpec[], baseUrl: string, env: Partial<RunEnv> = {}): Promise<Map<string, ScriptRun>> {
    const scripts = specs.map((s) => {
        const r = renderScript(s, "playwright-api", { baseUrl });
        return { testId: s.testId, filename: r.filename, content: r.content };
    });
    const runs = await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl, headless: true, ...env }, { workers: 4 });
    return new Map(runs.map((r) => [r.testId, r]));
}

const suiteFor = (origin: string, pages = [{ path: "/", type: "home" as const }]) =>
    generateSecuritySpecs(modelFor(origin, pages)).map((d, i) => TestSpecSchema.parse({ ...d, testId: `API-${String(i + 1).padStart(3, "0")}` }));

const byTitle = (specs: TestSpec[], start: string) => specs.find((s) => s.title.startsWith(start))!;

describe("against a deliberately weak application", () => {
    const specs = suiteFor(url(PORTS.weak));
    let runs: Map<string, ScriptRun>;
    beforeAll(async () => {
        runs = await run(specs, url(PORTS.weak), { apiToken: "super-secret-token-123", apiAuthHeader: "X-Key: super-secret-key" });
    }, 120_000);

    const finding = (start: string) => {
        const s = byTitle(specs, start);
        return { spec: s, run: runs.get(s.testId)!, reason: securityFinding(s, runs.get(s.testId)!) };
    };

    it("finds missing headers (medium: no Content-Security-Policy)", () => {
        const { spec, run, reason } = finding("Browser security headers");
        expect(run.status).toBe("failed");
        expect(reason).toMatch(/^Security check failed: 4 browser security headers missing or weak/);
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason)).toEqual({ severity: "medium", basis: "browser security headers missing" });
    });

    it("finds the unprotected session cookie (medium) and ignores the theme / CSRF cookies", () => {
        const { spec, reason } = finding("Session cookies");
        expect(reason).toContain('Cookie "sessionid" is missing HttpOnly');
        expect(reason).not.toMatch(/theme|XSRF/);
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason)?.severity).toBe("medium");
    });

    it("finds CORS that echoes any origin with credentials (high)", () => {
        const { spec, reason } = finding("Cross-origin");
        expect(reason).toContain("- [high] / echoes back any Origin and allows credentials");
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason)).toEqual({ severity: "high", basis: "permissive cross-origin (CORS) setting" });
    });

    it("finds the readable /.env and /.git/HEAD (critical) and nothing the server does not have", () => {
        const { spec, reason } = finding("Secret and source-control");
        expect(reason).toContain("2 sensitive files are publicly readable");
        expect(reason).toContain("- [critical] /.env can be downloaded by anyone");
        expect(reason).toContain("- [critical] /.git/HEAD");
        expect(reason).not.toMatch(/\/\.git\/config|\.svn|wp-config|htpasswd/);
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason)).toEqual({ severity: "critical", basis: "sensitive file readable by anyone" });
        // the second group has nothing readable on this server
        expect(runs.get(byTitle(specs, "Backups").testId)!.status).toBe("passed");
    });

    it("reports the version banners and the directory listing, worst first", () => {
        const { spec, reason } = finding("The server does not reveal");
        expect(reason).toMatch(/3 details about the server are exposed\n- \[medium\] \/uploads\/ lists the files/);
        expect(reason).toContain('X-Powered-By header reveals the technology ("Express/4.17.1")');
        expect(reason).toContain('Server header reveals the software version ("Apache/2.4.41 (Ubuntu)")');
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason)?.severity).toBe("medium");
    });

    it("sent no credentials, only GET requests, and stayed on its own origin", async () => {
        expect(await (await fetch(`${url(PORTS.weak)}/__auth`)).text()).toBe("0");
        const log = (await (await fetch(`${url(PORTS.weak)}/__log`)).json()) as string[];
        expect(log).toContain("/.env");
        expect(log.every((p) => p.startsWith("/"))).toBe(true);
        // the security specs never executed a request to a path they were not generated with
        const planned = new Set(specs.flatMap((s) => s.steps.filter((x) => x.action === "request").map((x) => (x as { path: string }).path)));
        expect(log.filter((p) => !planned.has(p) && !p.startsWith("/__"))).toEqual([]);
    });

    it("classifies only the check's own message as a finding", () => {
        const s = byTitle(specs, "Browser security headers");
        const r = runs.get(s.testId)!;
        // a request that could not be made is an ordinary failure, not a finding
        const refused: ScriptRun = { ...r, error: "apiRequestContext.fetch: connect ECONNREFUSED 127.0.0.1:1", failedStepIndex: 0, steps: [{ index: 0, title: "1. Request / (read-only)", status: "failed", error: "apiRequestContext.fetch: connect ECONNREFUSED 127.0.0.1:1" }] };
        expect(securityFinding(s, refused)).toBeUndefined();
        // the same message on a step that is not a security assert is not trusted
        expect(securityFinding(s, { ...r, steps: r.steps.map((x) => ({ ...x, index: 0 })) })).toBeUndefined();
        expect(securityFinding(s, { ...r, status: "passed" })).toBeUndefined();
        expect(parseSecurityReason("Something else")).toEqual({});
    });
});

describe("against a hardened application", () => {
    it("finds nothing, and plain http is never flagged for HSTS", async () => {
        const specs = suiteFor(url(PORTS.hardened));
        const runs = await run(specs, url(PORTS.hardened));
        for (const s of specs) expect(runs.get(s.testId)!.status, `${s.title}: ${runs.get(s.testId)!.error}`).toBe("passed");
        // even a spec edited to demand HSTS passes on an http origin
        const demanding = TestSpecSchema.parse({
            testId: "API-050", title: "HSTS demanded", kind: "api", type: "security", source: { origin: "security-check" },
            steps: [{ action: "request", method: "GET", path: "/", auth: "none" }, { action: "assertResponse", check: "securityHeaders", expected: "hsts" }],
        });
        expect((await run([demanding], url(PORTS.hardened))).get("API-050")!.status).toBe("passed");
    }, 120_000);

    it.skipIf(!SELF_SIGNED)("the same hardened app over https passes the header, cookie and exposed-file checks (HSTS present)", async () => {
        const specs = suiteFor(url(PORTS.tlsSelfSigned, "https")).filter((s) => !s.title.startsWith("The HTTPS certificate"));
        const runs = await run(specs, url(PORTS.tlsSelfSigned, "https"));
        for (const s of specs) expect(runs.get(s.testId)!.status, `${s.title}: ${runs.get(s.testId)!.error}`).toBe("passed");
    }, 120_000);
});

describe("against a single-page app that answers 200 + HTML for every path", () => {
    it("produces no exposed-file or directory-listing false positives", async () => {
        const specs = suiteFor(url(PORTS.spa)).filter((s) => /cannot be downloaded|does not reveal/.test(s.title));
        expect(specs).toHaveLength(3);
        const runs = await run(specs, url(PORTS.spa));
        for (const s of specs) expect(runs.get(s.testId)!.status, `${s.title}: ${runs.get(s.testId)!.error}`).toBe("passed");
        // ...even though the server really did answer 200 for every probed path
        for (const p of ["/.env", "/.git/HEAD", "/backup.zip", "/uploads/"]) {
            const res = await fetch(`${url(PORTS.spa)}${p}`);
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toMatch(/html/);
        }
    }, 120_000);
});

describe.skipIf(!SELF_SIGNED || !WRONG_HOST)("HTTPS certificate check against real TLS servers", () => {
    const tlsSpec = (base: string) => suiteFor(base).find((s) => s.title.startsWith("The HTTPS certificate"))!;

    it("reports a self-signed certificate as not trusted (medium) while the other checks still run", async () => {
        const base = url(PORTS.tlsSelfSigned, "https");
        const spec = tlsSpec(base);
        const r = (await run([spec], base)).get(spec.testId)!;
        expect(r.status).toBe("failed");
        const reason = securityFinding(spec, r)!;
        expect(reason).toMatch(/^Security check failed: 1 problem with the HTTPS certificate\n- \[medium\] The HTTPS certificate is not trusted \(depth zero self signed cert\)/);
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason)).toEqual({ severity: "medium", basis: "problem with the HTTPS certificate" });
    }, 120_000);

    it("reports a certificate for another host name (high)", async () => {
        const base = url(PORTS.tlsWrongHost, "https");
        const spec = tlsSpec(base);
        const r = (await run([spec], base)).get(spec.testId)!;
        const reason = securityFinding(spec, r)!;
        expect(reason).toContain("- [high] The HTTPS certificate is not valid for 127.0.0.1 (it is issued for shop.example)");
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason)?.severity).toBe("high");
    }, 120_000);

    it.skipIf(!openssl)("reports a certificate that expires within 14 days (medium) and one that has expired (high)", async () => {
        expect(minted, "openssl exists but minted no certificate").toContain("short-lived");
        if (minted.includes("short-lived")) {
            const base = url(PORTS.tlsExpiring, "https");
            const spec = tlsSpec(base);
            const reason = securityFinding(spec, (await run([spec], base)).get(spec.testId)!)!;
            expect(reason).toMatch(/- \[medium\] The HTTPS certificate expires on \d{4}-\d{2}-\d{2} \(in [45] days\)/);
        }
        if (minted.includes("already-expired")) {
            // a certificate issued for 0 days is already past its end date by the time it is checked
            await new Promise((r) => setTimeout(r, 1500));
            const base = url(PORTS.tlsExpired, "https");
            const spec = tlsSpec(base);
            const reason = securityFinding(spec, (await run([spec], base)).get(spec.testId)!)!;
            expect(reason).toMatch(/- \[high\] The HTTPS certificate expired on \d{4}-\d{2}-\d{2}/);
        }
    }, 120_000);
});

describe("scripts outside the platform", () => {
    it("a downloaded security script is a normal Playwright test: BASE_URL redirects it to another site", async () => {
        const specs = suiteFor(url(PORTS.weak));
        const spec = byTitle(specs, "Secret and source-control");
        const { filename, content } = renderScript(spec, "playwright-api", { baseUrl: url(PORTS.weak) });
        const dir = fs.mkdtempSync(path.join(loadConfig({}).scratchDir, "standalone-"));
        fs.writeFileSync(path.join(dir, filename), content);
        // no platform runner, no platform config: just Playwright and the file
        fs.writeFileSync(path.join(dir, "playwright.config.ts"), 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: ".", reporter: "line" });\n');
        const cli = path.join(REPO_ROOT, "node_modules/@playwright/test/cli.js");
        const exec = (base: string) =>
            new Promise<{ code: number | null; out: string }>((resolve) => {
                const child = spawn(process.execPath, [cli, "test", "--config", "playwright.config.ts"], { cwd: dir, env: { ...process.env, BASE_URL: base, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
                let out = "";
                child.stdout.on("data", (d) => (out += d));
                child.stderr.on("data", (d) => (out += d));
                child.on("close", (code) => resolve({ code, out }));
            });
        try {
            const weak = await exec(url(PORTS.weak));
            expect(weak.code).toBe(1);
            expect(weak.out).toContain("Security check failed: 2 sensitive files are publicly readable");
            const hardened = await exec(url(PORTS.hardened));
            expect(hardened.code, hardened.out).toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});
