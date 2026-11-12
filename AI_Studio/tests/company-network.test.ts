/**
 * Company networks for real, on local sockets only (no internet):
 *  - a CONNECT proxy (tests/fixtures/connect-proxy.ts) with and without basic sign-in, mapping every name to 127.0.0.1, and an https
 *    front with the TEST-ONLY company certificate (tests/fixtures/tls/company) in front of the fake platform, like a security tool
 *    that re-signs https traffic;
 *  - the REAL runner program (bin/ai-test-agent.mjs) through the proxy: connects with --ca-file, runs a task whose script prints the
 *    proxy variables (the result, the heartbeats and the window never show the password; the child got the certificate trust), and
 *    the plain sentences for a proxy that wants a password, an untrusted company certificate, an unreachable proxy, an address the
 *    proxy blocks, NO_PROXY, and the Windows proxy setting (through a FAKE reg, never the real registry);
 *  - the platform: the runner's network on its row (host:port only, problem masked), a hello with a sign-in in the proxy refused, the
 *    server's own outbound calls (an AI model provider) through the proxy and the company certificate, and a kit download built with
 *    a proxy password in the server's environment holds none of it.
 *
 * Starts the runner, a platform server and (for one task) Playwright's test runner without a browser: run under the lock,
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/company-network.test.ts
 * Ports 6970-6979 (6979 is left closed on purpose).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { buildKitZip, loadBundle } from "../src/platform/runner-kit.js";
import { buildServer } from "../src/platform/server.js";
import { ConnectProxy, tlsFront } from "./fixtures/connect-proxy.js";
import { FakePlatform } from "./fixtures/fake-platform.js";
import { companyTls, removeMintedTls, TLS_SKIP_REASON } from "./fixtures/tls-files.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "bin/ai-test-agent.mjs");
const COMPANY = companyTls();
if (!COMPANY) console.warn(TLS_SKIP_REASON);
const CA = COMPANY?.ca ?? "";
const FAKE_REG = path.join(ROOT, "tests/fixtures/fake-reg.mjs");
const TOKEN = "aitg_NetE2eTokenSentinel0123456789abcdefgh";
const USER = "maya";
const PASSWORD = "Pr0xy-S3cret-NETe2e";
const AUTH_PORT = 6970;
const FRONT_PORT = 6971;
const FAKE_PORT = 6972;
const OPEN_PORT = 6973;
const BLOCKING_PORT = 6974;
const CLOSED_PORT = 6979;
const PLATFORM_URL = `https://platform.test:${FRONT_PORT}`;
const AUTH_PROXY = `http://${USER}:${PASSWORD}@127.0.0.1:${AUTH_PORT}`;
const API_KEY = "net-admin-key-6a1f0c";

let tmp: string;
let fake: FakePlatform;
let authProxy: ConnectProxy;
let openProxy: ConnectProxy;
let blockingProxy: ConnectProxy;
let front: { stop(): Promise<void> };
const started: ChildProcess[] = [];

/** The runner's environment: this machine's, minus anything that would point it at a real proxy or another setting. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(https?_proxy|no_proxy|all_proxy|node_extra_ca_certs|node_use_system_ca|node_use_env_proxy)$/i.test(k) || /^AITP_/i.test(k)) continue;
        env[k] = v;
    }
    // On Windows the runner would otherwise read this computer's own proxy setting; every test that wants one uses the fake reg.
    return { ...env, AITP_REG_PATH: FAKE_REG, FAKE_REG_OUTPUT: "", AITP_AGENT_TOKEN: TOKEN, ...extra };
}

interface Cli {
    child: ChildProcess;
    output(): string;
    waitFor(re: RegExp, what: string, ms?: number): Promise<void>;
    stop(): Promise<void>;
}

function runner(args: string[], extraEnv: Record<string, string> = {}, workName = `w-${started.length}`): Cli {
    const child = spawn(process.execPath, [LAUNCHER, "--url", PLATFORM_URL, "--work-dir", path.join(tmp, workName), "--name", "Net runner", ...args], { cwd: ROOT, env: cleanEnv(extraEnv), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    started.push(child);
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    const exited = new Promise<void>((r) => child.on("exit", () => r()));
    return {
        child,
        output: () => out,
        async waitFor(re, what, ms = 60_000) {
            const until = Date.now() + ms;
            while (!re.test(out)) {
                if (Date.now() > until) throw new Error(`timed out waiting for ${what}. Output so far:\n${out}`);
                if (child.exitCode !== null) throw new Error(`the runner ended before ${what}. Output:\n${out}`);
                await new Promise((r) => setTimeout(r, 150));
            }
        },
        // Only the process this test started, by its own handle.
        async stop() {
            if (child.exitCode === null) child.kill();
            await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
        },
    };
}

const waitUntil = async (what: string, ok: () => boolean, ms = 60_000) => {
    const until = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 150));
    }
};

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-net-"));
    fake = new FakePlatform(FAKE_PORT, { token: TOKEN });
    await fake.start();
    if (COMPANY) front = await tlsFront(FRONT_PORT, FAKE_PORT, { cert: fs.readFileSync(COMPANY.cert, "utf8") + fs.readFileSync(CA, "utf8"), key: fs.readFileSync(COMPANY.key, "utf8") });
    authProxy = new ConnectProxy(AUTH_PORT, { user: USER, password: PASSWORD });
    openProxy = new ConnectProxy(OPEN_PORT);
    blockingProxy = new ConnectProxy(BLOCKING_PORT, { refuse: ["blocked.test"] });
    await Promise.all([authProxy.start(), openProxy.start(), blockingProxy.start()]);
}, 60_000);

afterAll(async () => {
    for (const c of started) if (c.exitCode === null) c.kill();
    await Promise.all([fake?.stop(), authProxy?.stop(), openProxy?.stop(), blockingProxy?.stop(), front?.stop()]);
    removeMintedTls();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

describe.skipIf(!COMPANY)("the runner through a company proxy", () => {
    it("connects through a proxy with a password to a platform behind the company certificate, and the password shows up nowhere", async () => {
        const cli = runner(["--proxy", AUTH_PROXY, "--ca-file", CA], {}, "through");
        try {
            await cli.waitFor(/Connected to the platform/, "the connection");
            // The name platform.test exists only behind the proxy: the runner reached the platform through it, signed in.
            const tunnel = authProxy.hits.find((h) => h.method === "CONNECT" && h.target === `platform.test:${FRONT_PORT}` && h.auth === `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`);
            expect(tunnel).toBeDefined();
            expect(cli.output()).toContain(`Network: connecting through the proxy http://${USER}:***@127.0.0.1:${AUTH_PORT}, from --proxy.`);
            expect(cli.output()).toContain("Tests reach the application directly.");
            expect(cli.output()).toMatch(/Certificates trusted: Node\.js's own, this computer's certificate store \(\d+ more\), test-company-root\.crt \(1 certificate\)\./);
            // What the platform learns: host:port, where it came from, what is trusted. Never the sign-in.
            const hello = fake.hellos.at(-1)!;
            expect(hello.capabilities.network).toEqual({ proxy: `127.0.0.1:${AUTH_PORT}`, proxySource: "flag", certificates: ["system", "file"] });

            // A task whose script reads the proxy and certificate variables it inherited and puts them into its error text.
            const script = [
                'import { test } from "@playwright/test";',
                'test("reads the network settings", async () => {',
                '    throw new Error(`proxy=${process.env.HTTPS_PROXY} sys=${process.env.NODE_USE_SYSTEM_CA} ca=${process.env.NODE_EXTRA_CA_CERTS ? "set" : "unset"} pw=${new URL(process.env.HTTPS_PROXY).password}`);',
                "});",
                "",
            ].join("\n");
            const offer: TaskOffer = { taskId: "task-net-1", jobId: "job-net", adapterId: "playwright", leaseSeconds: 60, workers: 1, timeoutMs: 120_000, scripts: [{ testId: "NET-1", filename: "net-1.spec.ts", content: script }], env: { baseUrl: "http://127.0.0.1:9", apiBaseUrl: "http://127.0.0.1:9", headless: true } } as TaskOffer;
            fake.enqueue({ offer });
            const result = await fake.result(offer.taskId, 120_000);
            const text = JSON.stringify(result);
            expect(text).not.toContain(PASSWORD);
            const err = result.runs[0]?.error ?? result.error ?? "";
            // The child process got the trust (system store switch and the company file) and a proxy variable, whose secret parts are masked.
            expect(err).toMatch(/sys=1 ca=set pw=\*\*\*/);
            expect(err).toMatch(/proxy=\*\*\*/);
            for (const beats of fake.heartbeats.values()) expect(JSON.stringify(beats)).not.toContain(PASSWORD);
            expect(JSON.stringify(fake.polls)).not.toContain(PASSWORD);
            expect(JSON.stringify(fake.hellos)).not.toContain(PASSWORD);
            expect(JSON.stringify(fake.hellos)).not.toContain(USER);
            expect(cli.output()).not.toContain(PASSWORD);
        } finally {
            await cli.stop();
        }
        expect(cli.output()).not.toContain(PASSWORD);
    }, 180_000);

    it("plain sentences: the proxy wants a password, the company certificate is not trusted, the proxy is down, the proxy blocks the address", async () => {
        const cases: Array<{ args: string[]; url?: string; expect: RegExp; also?: RegExp }> = [
            { args: ["--proxy", `http://127.0.0.1:${AUTH_PORT}`, "--ca-file", CA], expect: new RegExp(`Could not reach platform\\.test:${FRONT_PORT}: the proxy http://127\\.0\\.0\\.1:${AUTH_PORT} asks for a user name and password \\(HTTP 407\\)\\. Add them to the proxy address`) },
            { args: ["--proxy", `http://${USER}:wrong-password-1@127.0.0.1:${AUTH_PORT}`, "--ca-file", CA], expect: /did not accept the user name and password \(HTTP 407\)/, also: /maya:\*\*\*@/ },
            { args: ["--proxy", AUTH_PROXY], expect: /the platform's certificate was not accepted \(SELF_SIGNED_CERT_IN_CHAIN\): .*A company security tool .* --ca-file <file>/ },
            { args: ["--proxy", `http://127.0.0.1:${CLOSED_PORT}`], expect: new RegExp(`the proxy http://127\\.0\\.0\\.1:${CLOSED_PORT} could not be reached \\(the connection was refused\\)\\. Check the proxy address \\(set by --proxy\\)`) },
            { args: ["--proxy", `http://127.0.0.1:${BLOCKING_PORT}`, "--url", `https://blocked.test:${FRONT_PORT}`], expect: new RegExp(`refused the connection to blocked\\.test:${FRONT_PORT} \\(HTTP 403\\)\\. The company network may block this address`) },
        ];
        // At most two runners at a time (memory).
        for (let i = 0; i < cases.length; i += 2) {
            const batch = cases.slice(i, i + 2).map((c, k) => ({ c, cli: runner(c.args, {}, `err-${i + k}`) }));
            try {
                await Promise.all(batch.map(({ c, cli }) => cli.waitFor(c.expect, String(c.expect))));
                for (const { c, cli } of batch) {
                    if (c.also) expect(cli.output()).toMatch(c.also);
                    expect(cli.output()).toMatch(/Trying again in \d+ s/);
                    expect(cli.output()).not.toContain(PASSWORD);
                    expect(cli.output()).not.toContain("wrong-password-1");
                }
            } finally {
                await Promise.all(batch.map(({ cli }) => cli.stop()));
            }
        }
    }, 240_000);

    it("NO_PROXY: an address in the exceptions is reached directly, never through the proxy", async () => {
        const before = openProxy.hits.length;
        const cli = runner([], { HTTPS_PROXY: `http://127.0.0.1:${OPEN_PORT}`, NO_PROXY: "intranet.test,platform.test" }, "noproxy");
        try {
            await cli.waitFor(/address could not be found/, "the direct attempt");
            expect(cli.output()).toContain("from HTTPS_PROXY / HTTP_PROXY. Reached directly: intranet.test, platform.test, localhost, 127.0.0.1, ::1, [::1].");
            expect(cli.output()).toContain("The platform's address is in the exceptions, so the runner reaches it directly.");
            expect(openProxy.hits.slice(before)).toEqual([]);
        } finally {
            await cli.stop();
        }
    }, 120_000);

    it.skipIf(process.platform !== "win32")("on Windows, uses the person's proxy setting when nothing else names one (fake reg)", async () => {
        const reg = ["", "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "    ProxyEnable    REG_DWORD    0x1", `    ProxyServer    REG_SZ    127.0.0.1:${OPEN_PORT}`, "    ProxyOverride    REG_SZ    <local>;*.corp.test", ""].join("\n");
        const before = openProxy.hits.length;
        const cli = runner(["--ca-file", CA], { FAKE_REG_OUTPUT: reg }, "windows");
        try {
            await cli.waitFor(/Connected to the platform/, "the connection");
            expect(cli.output()).toContain(`Network: connecting through the proxy http://127.0.0.1:${OPEN_PORT}, from the Windows proxy setting. Reached directly: *.corp.test, localhost`);
            expect(cli.output()).toMatch(/Don't use the proxy server for local addresses/);
            expect(openProxy.hits.slice(before).some((h) => h.method === "CONNECT" && h.target === `platform.test:${FRONT_PORT}`)).toBe(true);
            expect(fake.hellos.at(-1)!.capabilities.network).toMatchObject({ proxy: `127.0.0.1:${OPEN_PORT}`, proxySource: "windows" });
        } finally {
            await cli.stop();
        }
    }, 120_000);
});

describe.skipIf(!COMPANY)("the platform", () => {
    let platform: Platform;
    let dataDir: string;

    beforeAll(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-net-platform-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: "6975", SECRET_KEY: "net-secret-key-0123456789abcdef" }));
    });
    afterAll(() => {
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    });

    it("shows the runner's proxy (host:port) and its last problem masked; a proxy with a sign-in is refused", async () => {
        const app = await buildServer(platform);
        try {
            const admin = async (method: "GET" | "POST", url: string, body?: unknown) => {
                const r = await app.inject({ method, url, headers: { "x-api-key": API_KEY }, ...(body !== undefined ? { payload: body as object } : {}) });
                return { status: r.statusCode, body: r.json() as any };
            };
            const projectId = (await admin("POST", "/api/projects", { name: "Net project" })).body.id as string;
            const secret = personalRunner(platform, { label: "Net runner", replace: true }).secret;
            const caps = { os: "win32", arch: "x64", node: "v24.19.0", browsers: [] };
            const hello = (network: unknown) => app.inject({ method: "POST", url: "/api/agent/hello", headers: { authorization: `Bearer ${secret}` }, payload: { protocol: 1, name: "Net runner", version: "1.0.0", concurrency: 1, capabilities: { ...caps, network } } });
            const ok = await hello({ proxy: "proxy.corp.test:8080", proxySource: "windows", certificates: ["system"], problem: `Could not reach x: via http://maya:${PASSWORD}@proxy.corp.test:8080 failed.`, problemAt: "2026-10-18T10:00:00.000Z" });
            expect(ok.statusCode).toBe(200);
            const agents = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ capabilities: { network?: Record<string, unknown> } }>;
            expect(agents[0]!.capabilities.network).toEqual({ proxy: "proxy.corp.test:8080", proxySource: "windows", certificates: ["system"], problem: "Could not reach x: via http://maya:***@proxy.corp.test:8080 failed.", problemAt: "2026-10-18T10:00:00.000Z" });
            expect(JSON.stringify(agents)).not.toContain(PASSWORD);
            const refused = await hello({ proxy: `maya:${PASSWORD}@proxy.corp.test:8080` });
            expect(refused.statusCode).toBe(400);
            expect(refused.body).not.toContain(PASSWORD);
            // An older runner reports no network: the answer has none.
            await app.inject({ method: "POST", url: "/api/agent/hello", headers: { authorization: `Bearer ${secret}` }, payload: { protocol: 1, name: "Net runner", version: "1.0.0", concurrency: 1, capabilities: caps } });
            const again = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ capabilities: Record<string, unknown> }>;
            expect(again[0]!.capabilities).not.toHaveProperty("network");
        } finally {
            await app.close();
        }
    }, 60_000);

    it("the server's own outbound calls (an AI model provider) go through the proxy and trust the company certificate", async () => {
        // .mts: an ES module wherever the temp folder is (it uses top-level await).
        const script = path.join(tmp, "server-outbound.mts");
        const url = (p: string) => JSON.stringify(pathToFileURL(path.join(ROOT, p)).href);
        fs.writeFileSync(
            script,
            [
                `import { applyServerNetwork } from ${url("src/platform/outbound-network.ts")};`,
                `import { buildProviderModel } from ${url("src/engine/llm/provider.ts")};`,
                "for (const l of applyServerNetwork()) console.log(l);",
                `const model = buildProviderModel("openai-compatible", "net-model", { apiKey: "net-key", baseURL: "https://platform.test:${FRONT_PORT}/v1" }) as any;`,
                'try { await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }); console.log("ANSWERED"); }',
                'catch (e: any) { const codes: string[] = []; let c = e; for (let i = 0; c && i < 6; i++, c = c.cause) if (c.code) codes.push(c.code); console.log(`STATUS=${e?.statusCode ?? ""} CODES=${codes.join(",")}`); }',
                "",
            ].join("\n"),
        );
        // Not spawnSync: the proxy and the https front run in this process and must keep answering while the child waits.
        const run = (env: Record<string, string>) =>
            new Promise<{ stdout: string; stderr: string }>((resolve) => {
                const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: ROOT, env: cleanEnv(env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
                started.push(child);
                let stdout = "";
                let stderr = "";
                child.stdout!.on("data", (d) => (stdout += d));
                child.stderr!.on("data", (d) => (stderr += d));
                const timer = setTimeout(() => child.kill(), 90_000);
                child.on("exit", () => {
                    clearTimeout(timer);
                    resolve({ stdout, stderr });
                });
            });
        const before = authProxy.hits.length;
        const trusted = await run({ HTTPS_PROXY: AUTH_PROXY, NODE_EXTRA_CA_CERTS: CA });
        const out = `${trusted.stdout}${trusted.stderr}`;
        expect(out).toContain(`[network] Outbound calls (AI models, webhooks, notifications, issue trackers) go through the proxy http://${USER}:***@127.0.0.1:${AUTH_PORT}. Reached directly: localhost, 127.0.0.1, ::1, [::1].`);
        expect(out).toContain("[network] Trusting this computer's certificate store as well as Node.js's own certificates and NODE_EXTRA_CA_CERTS.");
        // The fake platform behind the company certificate answered (401: it is not a model provider), through the proxy.
        expect(out).toMatch(/STATUS=401/);
        expect(authProxy.hits.slice(before).some((h) => h.method === "CONNECT" && h.target === `platform.test:${FRONT_PORT}`)).toBe(true);
        expect(out).not.toContain(PASSWORD);
        // Without the company certificate the same call is refused for the certificate, not answered.
        const untrusted = await run({ HTTPS_PROXY: AUTH_PROXY });
        expect(`${untrusted.stdout}${untrusted.stderr}`).toMatch(/SELF_SIGNED_CERT_IN_CHAIN/);
        // No proxy variables: nothing about a proxy is printed and nothing goes through one.
        const plain = await run({});
        expect(`${plain.stdout}${plain.stderr}`).not.toMatch(/go through the proxy/);
    }, 200_000);

    it("a runner download built while the server has a proxy password in its environment holds none of it", async () => {
        const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
        process.env.HTTPS_PROXY = AUTH_PROXY;
        process.env.NO_PROXY = "intranet-sentinel.test";
        try {
            const outDir = path.join(tmp, "dist-runner");
            await buildRunner({ outDir });
            const bundle = loadBundle(outDir);
            if (!bundle.ok) throw new Error(bundle.reason);
            // The runner program carries the company-network code (it is bundled from src/agent and src/engine).
            expect(Buffer.from(bundle.files.get("runner.mjs")!).toString("utf8")).toContain("setGlobalProxyFromEnv");
            for (const platformKind of ["windows", "unix"] as const) {
                const zip = buildKitZip({ bundle, request: { name: "Net runner", platform: platformKind }, platformUrl: "https://tests.example.com", token: TOKEN });
                for (const [name, bytes] of Object.entries(unzipSync(zip))) {
                    const text = Buffer.from(bytes).toString("latin1");
                    expect(text, name).not.toContain(PASSWORD);
                    expect(text, name).not.toContain("intranet-sentinel.test");
                    expect(text, name).not.toContain(`127.0.0.1:${AUTH_PORT}`);
                }
            }
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    }, 180_000);
});
