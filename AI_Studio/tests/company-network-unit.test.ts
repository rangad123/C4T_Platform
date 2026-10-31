/**
 * Company networks without a network (fast tier): reading proxy addresses and certificate files, which setting wins (flag, environment,
 * runner.json, the Windows proxy setting), the Windows setting read through a FAKE reg (tests/fixtures/fake-reg.mjs via AITP_REG_PATH,
 * never the real registry), NO_PROXY matching, what is written into the environment for child processes, the --proxy-tests config,
 * the plain error sentences, and that a proxy password appears in no message, no log line and nothing sent to the platform.
 * No ports, no browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Capabilities } from "../src/agent-protocol/schema.js";
import { parseAgentArgs } from "../src/agent/config.js";
import { memoryLogger } from "../src/agent/log.js";
import {
    addWindowsProxy,
    applyRunnerNetwork,
    kitNetworkDefaults,
    networkCapabilities,
    noteNetworkProblem,
    parseRegQuery,
    readWindowsProxy,
    regProgram,
    resetNetworkState,
    resolveNetwork,
    windowsProxyFrom,
    type NetworkSettings,
} from "../src/agent/net.js";
import {
    bypassMatches,
    describeNetworkError,
    exportProxyEnv,
    parseProxyAddress,
    proxyEnvOf,
    proxyForTarget,
    readCertificateFile,
    redactCredentials,
    redactProxyUrl,
    withLoopbackBypass,
} from "../src/engine/net/company-network.js";
import { withTestProxy } from "../src/engine/net/test-proxy.js";
import { configFor } from "../src/engine/validation/runner.js";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const FAKE_REG = path.join(ROOT, "tests/fixtures/fake-reg.mjs");
const CA = path.join(ROOT, "tests/fixtures/tls/company/test-company-root.crt");
const TOKEN = "aitg_NetUnitTokenSentinel0123456789abcdef";
const URL_OK = "https://tests.example.com";
const PASSWORD = "Pr0xy-S3cret-NETunit";
const WITH_PASSWORD = `http://maya:${PASSWORD}@proxy.corp.test:8080`;

let tmp: string;
beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-net-unit-"));
});
afterEach(() => resetNetworkState());

const regOutput = (values: Record<string, string>) =>
    [
        "",
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        "    User Agent    REG_SZ    Mozilla/4.0 (compatible; MSIE 8.0; Win32)",
        ...Object.entries(values).map(([k, v]) => `    ${k}    ${k === "ProxyEnable" ? "REG_DWORD" : "REG_SZ"}    ${v}`),
        "",
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections",
        "    ProxyServer    REG_SZ    sub-key-value-must-be-ignored:1",
        "",
    ].join("\n");

describe("proxy addresses", () => {
    it("reads the usual forms and keeps the password out of every message", () => {
        const p = parseProxyAddress(WITH_PASSWORD);
        expect(p.ok && p.proxy).toMatchObject({ protocol: "http:", hostname: "proxy.corp.test", port: 8080, host: "proxy.corp.test:8080", username: "maya", password: PASSWORD, display: "http://maya:***@proxy.corp.test:8080" });
        expect(parseProxyAddress("proxy.corp.test:3128").ok && (parseProxyAddress("proxy.corp.test:3128") as { proxy: { url: string } }).proxy.url).toBe("http://proxy.corp.test:3128");
        expect((parseProxyAddress("https://secure-proxy.test") as { proxy: { port: number } }).proxy.port).toBe(443);
        expect((parseProxyAddress("http://maya:p%40ss@proxy.test:8080") as { proxy: { password: string } }).proxy.password).toBe("p@ss");
        for (const [raw, why] of [
            [`socks5://maya:${PASSWORD}@proxy.test:1080`, /SOCKS proxies are not supported/],
            [`http://maya:${PASSWORD}@proxy.test:8080/proxy.pac`, /without a path.*PAC/],
            [`ftp://maya:${PASSWORD}@proxy.test`, /must start with http/],
            [`http://maya:${PASSWORD}@ proxy.test`, /spaces/],
            ["", /empty/],
        ] as const) {
            const r = parseProxyAddress(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.message).toMatch(why);
                expect(r.message).not.toContain(PASSWORD);
            }
        }
        expect(redactProxyUrl(WITH_PASSWORD)).toBe("http://maya:***@proxy.corp.test:8080");
        expect(redactProxyUrl(`socks5://maya:${PASSWORD}@x:1`)).not.toContain(PASSWORD);
        expect(redactCredentials(`tunnel to x via ${WITH_PASSWORD}/ failed; also https://a:b-${PASSWORD}@y`)).toBe("tunnel to x via http://maya:***@proxy.corp.test:8080/ failed; also https://a:***@y");
    });

    it("matches NO_PROXY the way Node's fetch and http.request both do", () => {
        const list = "intranet.test, .corp.test,*.lab.test,app.test:8443,[::1],10.1.2.3";
        expect(bypassMatches("intranet.test", 443, list)).toBe(true);
        expect(bypassMatches("INTRANET.test", 443, list)).toBe(true);
        expect(bypassMatches("www.intranet.test", 443, list)).toBe(false);
        expect(bypassMatches("corp.test", 443, list)).toBe(true);
        expect(bypassMatches("a.b.corp.test", 80, list)).toBe(true);
        expect(bypassMatches("lab.test", 443, list)).toBe(false);
        expect(bypassMatches("x.lab.test", 443, list)).toBe(true);
        expect(bypassMatches("app.test", 8443, list)).toBe(true);
        expect(bypassMatches("app.test", 443, list)).toBe(false);
        expect(bypassMatches("::1", 80, list)).toBe(true);
        expect(bypassMatches("10.1.2.3", 80, list)).toBe(true);
        expect(bypassMatches("anything", 1, "*")).toBe(true);
        expect(bypassMatches("anything", 1, undefined)).toBe(false);
        // This computer's own addresses are always added.
        expect(withLoopbackBypass("a.test")).toBe("a.test,localhost,127.0.0.1,::1,[::1]");
        const pe = { https: "http://p:1", http: "http://q:2", noProxy: withLoopbackBypass(".corp.test") };
        expect(proxyForTarget(new URL("https://platform.example.com"), pe)).toBe("http://p:1");
        expect(proxyForTarget(new URL("http://platform.example.com"), pe)).toBe("http://q:2");
        expect(proxyForTarget(new URL("https://x.corp.test"), pe)).toBeUndefined();
        expect(proxyForTarget(new URL("https://127.0.0.1:4100"), pe)).toBeUndefined();
        // https falls back to the http proxy, as Node's fetch does
        expect(proxyForTarget(new URL("https://x.example.com"), { http: "http://q:2" })).toBe("http://q:2");
    });

    it("reads the variables in either case (lower case wins) and writes them for child processes", () => {
        expect(proxyEnvOf({ HTTPS_PROXY: "http://upper:1", https_proxy: "http://lower:1", NO_PROXY: "a" })).toEqual({ https: "http://lower:1", noProxy: "a" });
        const win: NodeJS.ProcessEnv = { https_proxy: "http://old:1" };
        exportProxyEnv(win, { https: "http://new:1", noProxy: "x" }, "win32");
        expect(win).toEqual({ HTTPS_PROXY: "http://new:1", NO_PROXY: "x" });
        const unix: NodeJS.ProcessEnv = {};
        exportProxyEnv(unix, { https: "http://new:1", http: "http://new:2" }, "linux");
        expect(unix).toEqual({ HTTPS_PROXY: "http://new:1", https_proxy: "http://new:1", HTTP_PROXY: "http://new:2", http_proxy: "http://new:2" });
    });
});

describe("which setting wins", () => {
    it("flag beats the environment, which beats runner.json; --proxy none turns everything off", () => {
        const env = { HTTPS_PROXY: "http://env-proxy.test:1", AITP_KIT_PROXY: "http://file-proxy.test:2" };
        const flag = resolveNetwork({ proxy: "http://flag-proxy.test:3" }, env);
        expect(flag.ok && flag.settings.proxy).toMatchObject({ source: "flag", https: { host: "flag-proxy.test:3" } });
        const fromEnv = resolveNetwork({}, env);
        expect(fromEnv.ok && fromEnv.settings.proxy).toMatchObject({ source: "env", https: { host: "env-proxy.test:1" } });
        expect(fromEnv.ok && fromEnv.settings.proxy?.http).toBeUndefined();
        const fromFile = resolveNetwork({}, { AITP_KIT_PROXY: "file-proxy.test:2" });
        expect(fromFile.ok && fromFile.settings.proxy).toMatchObject({ source: "file", https: { url: "http://file-proxy.test:2" }, http: { url: "http://file-proxy.test:2" } });
        const none = resolveNetwork({ proxy: "none" }, env);
        expect(none.ok && none.settings.proxy).toBeUndefined();
        expect(none.ok && none.settings.proxyNone).toBe(true);
        // exceptions: the flag, then NO_PROXY, then runner.json
        expect((resolveNetwork({ "proxy-bypass": "a.test, b.test" }, { NO_PROXY: "c.test", AITP_KIT_NO_PROXY: "d.test" }) as { settings: NetworkSettings }).settings.bypass).toBe("a.test,b.test");
        expect((resolveNetwork({}, { no_proxy: "c.test", AITP_KIT_NO_PROXY: "d.test" }) as { settings: NetworkSettings }).settings.bypass).toBe("c.test");
        expect((resolveNetwork({}, { AITP_KIT_NO_PROXY: "d.test" }) as { settings: NetworkSettings }).settings.bypass).toBe("d.test");
        // certificates: the computer's store unless AITP_SYSTEM_CA=0; --proxy-tests by flag or variable
        expect((resolveNetwork({}, {}) as { settings: NetworkSettings }).settings).toMatchObject({ systemCa: true, proxyTests: false });
        expect((resolveNetwork({ "proxy-tests": true }, { AITP_SYSTEM_CA: "0" }) as { settings: NetworkSettings }).settings).toMatchObject({ systemCa: false, proxyTests: true });
        expect((resolveNetwork({}, { AITP_PROXY_TESTS: "1" }) as { settings: NetworkSettings }).settings.proxyTests).toBe(true);
    });

    it("the command line: a bad proxy or certificate file is a usage error that never repeats the password", () => {
        const base = ["--url", URL_OK, "--token", TOKEN];
        const run = parseAgentArgs([...base, "--proxy", WITH_PASSWORD, "--proxy-bypass", ".corp.test", "--proxy-tests", "--ca-file", CA], {});
        expect(run.kind).toBe("run");
        if (run.kind === "run") {
            expect(run.config.network).toMatchObject({ proxy: { source: "flag", https: { display: "http://maya:***@proxy.corp.test:8080" } }, bypass: ".corp.test", proxyTests: true, caFile: { path: CA } });
            expect(run.config.network?.caFile?.pems).toHaveLength(1);
        }
        for (const [argv, env, why] of [
            [["--proxy", `socks5://maya:${PASSWORD}@x:1`], {}, /--proxy: SOCKS proxies are not supported/],
            [[], { HTTPS_PROXY: `http://maya:${PASSWORD}@x:1/path` }, /HTTPS_PROXY: .*without a path/],
            [[], { AITP_KIT_PROXY: `ftp://maya:${PASSWORD}@x` }, /"proxy" in runner.json: /],
            [["--ca-file", path.join(tmp, "missing.pem")], {}, /--ca-file: The certificate file could not be read/],
        ] as const) {
            const r = parseAgentArgs([...base, ...argv], env as NodeJS.ProcessEnv);
            expect(r.kind).toBe("error");
            if (r.kind === "error") {
                expect(r.message).toMatch(why);
                expect(r.message).not.toContain(PASSWORD);
            }
        }
    });

    it("runner.json may name proxy, noProxy, caFile and proxyTests; the environment still wins", () => {
        const dir = path.join(tmp, "kit");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ url: URL_OK, name: "Maya", proxy: WITH_PASSWORD, noProxy: ".corp.test", caFile: "company.pem", proxyTests: true }));
        const r = kitNetworkDefaults({ AITP_CA_FILE: "/already/set.pem" }, dir);
        expect(r.ok && r.env).toMatchObject({ AITP_KIT_PROXY: WITH_PASSWORD, AITP_KIT_NO_PROXY: ".corp.test", AITP_CA_FILE: "/already/set.pem", AITP_PROXY_TESTS: "1" });
        const r2 = kitNetworkDefaults({}, dir);
        expect(r2.ok && r2.env.AITP_CA_FILE).toBe(path.join(dir, "company.pem"));
        // The file comes after the variables: HTTPS_PROXY wins over runner.json.
        expect((resolveNetwork({}, { ...(r2.ok ? r2.env : {}), HTTPS_PROXY: "http://env.test:1", AITP_CA_FILE: "" }) as { settings: NetworkSettings }).settings.proxy?.source).toBe("env");
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ url: URL_OK, name: "Maya", proxyTests: "yes" }));
        const bad = kitNetworkDefaults({}, dir);
        expect(bad.ok).toBe(false);
        // No runner.json: nothing changes (a checkout).
        const env = { A: "1" };
        expect(kitNetworkDefaults(env, path.join(tmp, "no-kit-here"))).toEqual({ ok: true, env });
    });
});

describe("the Windows proxy setting", () => {
    it("reads reg query output: the key's own values only, names with spaces, per-protocol servers, exceptions", () => {
        const v = parseRegQuery(regOutput({ ProxyEnable: "0x1", ProxyServer: "proxy.corp.test:8080", ProxyOverride: "<local>;*.corp.test;intranet.test;10.*;192.168.1.*" }).replace(/\n/g, "\r\n"));
        expect(v.get("user agent")).toMatch(/Mozilla/);
        expect(v.get("proxyserver")).toBe("proxy.corp.test:8080");
        const w = windowsProxyFrom(v);
        expect(w).toMatchObject({ https: "proxy.corp.test:8080", http: "proxy.corp.test:8080", bypass: "*.corp.test,intranet.test" });
        expect(w.notes.join(" ")).toMatch(/local addresses/);
        expect(w.notes.join(" ")).toMatch(/2 Windows proxy exceptions with a \* in the middle or at the end/);
        expect(windowsProxyFrom(parseRegQuery(regOutput({ ProxyEnable: "0x1", ProxyServer: "http=web.test:80;https=secure.test:8443;socks=s.test:1080" })))).toMatchObject({ http: "web.test:80", https: "secure.test:8443" });
        expect(windowsProxyFrom(parseRegQuery(regOutput({ ProxyEnable: "0x1", ProxyServer: "socks=s.test:1080" }))).notes[0]).toMatch(/only a SOCKS proxy/);
        // Off: nothing, but a PAC script is mentioned in words.
        expect(windowsProxyFrom(parseRegQuery(regOutput({ ProxyEnable: "0x0", ProxyServer: "proxy.corp.test:8080" })))).toEqual({ notes: [] });
        const pac = windowsProxyFrom(parseRegQuery(regOutput({ ProxyEnable: "0x0", AutoConfigURL: "http://wpad.corp.test/proxy.pac" })));
        expect(pac.https).toBeUndefined();
        expect(pac.notes[0]).toMatch(/automatic setup script \(PAC\)\. The runner cannot read those scripts/);
    });

    it("runs Windows' own reg.exe by its full path (never a PATH lookup), or the test stand-in", () => {
        expect(regProgram({ SystemRoot: "C:\\Windows" })).toEqual({ file: path.join("C:\\Windows", "System32", "reg.exe"), args: ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"] });
        expect(regProgram({ AITP_REG_PATH: FAKE_REG }).file).toBe(process.execPath);
    });

    it("is used only on Windows and only when nothing else names a proxy (fake reg)", async () => {
        const env = { ...process.env, AITP_REG_PATH: FAKE_REG, FAKE_REG_OUTPUT: regOutput({ ProxyEnable: "0x1", ProxyServer: "proxy.corp.test:8080", ProxyOverride: "*.corp.test" }) };
        const read = await readWindowsProxy(env);
        expect(read).toMatchObject({ https: "proxy.corp.test:8080", bypass: "*.corp.test" });
        const base = (resolveNetwork({}, {}) as { settings: NetworkSettings }).settings;
        const win = await addWindowsProxy(base, env, "win32");
        expect(win.proxy).toMatchObject({ source: "windows", https: { url: "http://proxy.corp.test:8080" } });
        expect(win.bypass).toBe("*.corp.test");
        // a NO_PROXY of the person's own beats the Windows exceptions
        const own = await addWindowsProxy((resolveNetwork({}, { NO_PROXY: "mine.test" }) as { settings: NetworkSettings }).settings, env, "win32");
        expect(own.bypass).toBe("mine.test");
        expect(await addWindowsProxy(base, env, "linux")).toBe(base);
        const flagged = (resolveNetwork({ proxy: "http://flag.test:1" }, {}) as { settings: NetworkSettings }).settings;
        expect((await addWindowsProxy(flagged, env, "win32")).proxy?.source).toBe("flag");
        const none = (resolveNetwork({ proxy: "none" }, {}) as { settings: NetworkSettings }).settings;
        expect((await addWindowsProxy(none, env, "win32")).proxy).toBeUndefined();
        const broken = await addWindowsProxy(base, { ...env, FAKE_REG_EXIT: "1" }, "win32");
        expect(broken.proxy).toBeUndefined();
        expect(broken.notes.join(" ")).toMatch(/Windows proxy setting could not be read/);
    });
});

describe("applying it", () => {
    it("writes the proxy, the exceptions and the certificate trust into the environments, and reports only host:port", () => {
        const settings = (resolveNetwork({ proxy: WITH_PASSWORD, "proxy-bypass": ".corp.test", "proxy-tests": true, "ca-file": CA }, {}) as { settings: NetworkSettings }).settings;
        const agentEnv: NodeJS.ProcessEnv = { NODE_EXTRA_CA_CERTS: CA };
        const done = applyRunnerNetwork(settings, { envs: [agentEnv], global: false, workDir: path.join(tmp, "work"), platform: "linux" });
        expect(agentEnv).toMatchObject({ HTTPS_PROXY: settings.proxy!.https!.url, http_proxy: settings.proxy!.http!.url, NO_PROXY: ".corp.test,localhost,127.0.0.1,::1,[::1]", AITP_PROXY_TESTS: "1", NODE_USE_SYSTEM_CA: "1", NODE_EXTRA_CA_CERTS: CA });
        const all = [...done.info, ...done.warn].join("\n");
        expect(all).toContain("Network: connecting through the proxy http://maya:***@proxy.corp.test:8080, from --proxy. Reached directly: .corp.test, localhost, 127.0.0.1, ::1, [::1].");
        expect(all).toMatch(/Tests go through the proxy too/);
        expect(all).not.toContain(PASSWORD);
        expect(done.secrets).toContain(PASSWORD);
        expect(done.secrets).toContain(settings.proxy!.https!.url);
        const caps = networkCapabilities();
        expect(caps).toEqual({ proxy: "proxy.corp.test:8080", proxySource: "flag", proxyTests: true, certificates: ["system", "file", "extra"] });
        expect(JSON.stringify(caps)).not.toContain("maya");
        expect(Capabilities.shape.network.safeParse(caps).success).toBe(true);
        // The protocol refuses a proxy with a sign-in in it, whoever sends it.
        expect(Capabilities.shape.network.safeParse({ proxy: `maya:${PASSWORD}@proxy.corp.test:8080` }).success).toBe(false);
    });

    it("a second certificate file joins NODE_EXTRA_CA_CERTS in one file for child processes", () => {
        const other = path.join(tmp, "other.pem");
        fs.writeFileSync(other, fs.readFileSync(path.join(ROOT, "tests/fixtures/tls/localhost.crt")));
        const settings = (resolveNetwork({ "ca-file": CA }, {}) as { settings: NetworkSettings }).settings;
        const env: NodeJS.ProcessEnv = { NODE_EXTRA_CA_CERTS: other };
        applyRunnerNetwork(settings, { envs: [env], global: false, workDir: path.join(tmp, "work2") });
        expect(env.NODE_EXTRA_CA_CERTS).toBe(path.join(tmp, "work2", "network", "trusted-certificates.pem"));
        const joined = readCertificateFile(env.NODE_EXTRA_CA_CERTS!);
        expect(joined.ok && joined.pems).toHaveLength(2);
    });

    it("no proxy: says so; --proxy none also keeps a proxy of the environment from the programs it starts", () => {
        const none = (resolveNetwork({ proxy: "none", "proxy-tests": true }, { HTTPS_PROXY: "http://env.test:1" }) as { settings: NetworkSettings }).settings;
        const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://env.test:1", http_proxy: "http://env.test:1" };
        const done = applyRunnerNetwork(none, { envs: [env], global: false, workDir: tmp });
        expect(done.info[0]).toBe("Network: no proxy (--proxy none), connecting directly.");
        expect(done.warn).toContain("--proxy-tests has no effect: no proxy is set.");
        expect(env.HTTPS_PROXY).toBeUndefined();
        expect(env.http_proxy).toBeUndefined();
        expect(networkCapabilities()).toEqual({ certificates: ["system"] });
    });

    it("the last network problem goes to the platform masked, and only for an hour", () => {
        applyRunnerNetwork((resolveNetwork({}, {}) as { settings: NetworkSettings }).settings, { envs: [{}], global: false, workDir: tmp });
        const t0 = Date.parse("2026-10-18T10:00:00Z");
        noteNetworkProblem(`Could not reach x: tunnel via ${WITH_PASSWORD} failed.\nnext line`, t0);
        const caps = networkCapabilities(t0 + 60_000)!;
        expect(caps.problem).toBe("Could not reach x: tunnel via http://maya:***@proxy.corp.test:8080 failed. next line");
        expect(caps.problemAt).toBe("2026-10-18T10:00:00.000Z");
        expect(networkCapabilities(t0 + 61 * 60_000)!.problem).toBeUndefined();
    });

    it("the log masks a registered proxy password wherever it shows up", () => {
        const { log, lines } = memoryLogger();
        const p = parseProxyAddress(WITH_PASSWORD);
        if (!p.ok) throw new Error("parse");
        log.addSecrets([...new Set([p.proxy.password, p.proxy.url])]);
        log.warn(`child said: HTTPS_PROXY=${WITH_PASSWORD} and the password ${PASSWORD}`);
        expect(lines.join("\n")).not.toContain(PASSWORD);
    });
});

describe("--proxy-tests: the run's Playwright config", () => {
    it("is byte-identical when off; when on, the proxy is read from the environment and never written into the file", () => {
        for (const config of [configFor([]), configFor([{ name: "firefox", device: "Desktop Firefox" }], 90_000)]) {
            expect(withTestProxy(config, {})).toBe(config);
            expect(withTestProxy(config, { HTTPS_PROXY: WITH_PASSWORD })).toBe(config);
            expect(withTestProxy(config, { AITP_PROXY_TESTS: "1" })).toBe(config);
            const on = withTestProxy(config, { AITP_PROXY_TESTS: "1", HTTPS_PROXY: WITH_PASSWORD });
            expect(on).not.toBe(config);
            expect(on).not.toContain(PASSWORD);
            expect(on).not.toContain("proxy.corp.test");
            expect(on).toContain("    use: {\n        ...(testProxy ? { proxy: testProxy } : {}),");
            expect(on.split("\n")[0]).toBe(config.split("\n")[0]);
        }
        // The helper itself, evaluated the way Playwright will: Playwright's proxy shape, sign-in decoded, exceptions passed on.
        const on = withTestProxy(configFor([]), { AITP_PROXY_TESTS: "1", HTTPS_PROXY: "x" });
        const helper = on.slice(on.indexOf("const testProxy"), on.indexOf("})();") + 5);
        const evaluate = (env: Record<string, string>) => new Function("process", `${helper}\nreturn testProxy;`)({ env }) as unknown;
        expect(evaluate({ HTTPS_PROXY: "http://maya:p%40ss@proxy.corp.test:8080", NO_PROXY: ".corp.test" })).toEqual({ server: "http://proxy.corp.test:8080", bypass: ".corp.test", username: "maya", password: "p@ss" });
        expect(evaluate({ http_proxy: "proxy.corp.test:3128" })).toEqual({ server: "http://proxy.corp.test:3128" });
    });
});

describe("plain error sentences", () => {
    const proxy = (() => {
        const p = parseProxyAddress(WITH_PASSWORD);
        if (!p.ok) throw new Error(p.message);
        return p.proxy;
    })();
    const fetchFailed = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });

    it("names the proxy (redacted) and says what to do", () => {
        const auth = describeNetworkError(fetchFailed(Object.assign(new Error("Request was cancelled."), { cause: Object.assign(new Error("Proxy response (407) !== 200 when HTTP Tunneling"), { code: "UND_ERR_ABORTED" }) })), { target: "platform.test", proxy });
        expect(auth).toMatchObject({ kind: "proxy-auth" });
        expect(auth.reason).toBe("the proxy http://maya:***@proxy.corp.test:8080 did not accept the user name and password (HTTP 407)");
        const noUser = parseProxyAddress("http://proxy.corp.test:8080") as { ok: true; proxy: typeof proxy };
        const ask = describeNetworkError(fetchFailed({ message: "Proxy response (407) !== 200 when HTTP Tunneling" }), { target: "platform.test", proxy: noUser.proxy, proxySource: "windows" });
        expect(ask.reason).toMatch(/asks for a user name and password \(HTTP 407\)/);
        expect(ask.advice).toMatch(/--proxy http:\/\/user:password@proxy\.corp\.test:8080.*NTLM or Kerberos/);
        expect(describeNetworkError(fetchFailed({ message: "Proxy response (403) !== 200 when HTTP Tunneling" }), { target: "platform.test", proxy }).advice).toMatch(/ask IT to allow platform\.test/i);
        const tunnel = describeNetworkError(Object.assign(new Error("Failed to establish tunnel to platform.test:443 via http://127.0.0.1:1/: HTTP/1.1 502 Bad Gateway"), { code: "ERR_PROXY_TUNNEL" }), { target: "platform.test", proxy });
        expect(tunnel).toMatchObject({ kind: "proxy-refused" });
        const down = describeNetworkError(fetchFailed({ code: "ECONNREFUSED", address: "10.0.0.5", port: 8080, message: "connect ECONNREFUSED 10.0.0.5:8080" }), { target: "platform.test", proxy, proxySource: "env" });
        expect(down.reason).toBe("the proxy http://maya:***@proxy.corp.test:8080 could not be reached (the connection was refused)");
        expect(down.advice).toMatch(/HTTPS_PROXY.*--proxy none/);
        const name = describeNetworkError(fetchFailed({ code: "ENOTFOUND", hostname: "proxy.corp.test", message: "getaddrinfo ENOTFOUND proxy.corp.test" }), { target: "platform.test", proxy });
        expect(name.kind).toBe("proxy-unreachable");
        for (const pr of [auth, ask, down, name, tunnel]) expect(`${pr.reason} ${pr.advice}`).not.toContain(PASSWORD);
    });

    it("company certificates, DNS, a blocked address, a refused connection", () => {
        for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
            const c = describeNetworkError(fetchFailed({ code, message: "x" }), { target: "platform.test" });
            expect(c.kind).toBe("certificate");
            expect(c.reason).toContain(`certificate was not accepted (${code})`);
            expect(c.advice).toMatch(/security tool.*--ca-file/);
        }
        expect(describeNetworkError(fetchFailed({ code: "CERT_HAS_EXPIRED" }), { target: "x" }).advice).toMatch(/date and time/);
        expect(describeNetworkError(fetchFailed({ code: "ENOTFOUND", hostname: "platform.test" }), { target: "platform.test" })).toMatchObject({ kind: "dns", advice: expect.stringMatching(/--proxy http:\/\/host:port/) });
        expect(describeNetworkError(fetchFailed({ code: "ECONNREFUSED", address: "127.0.0.1", port: 1 }), { target: "x" }).reason).toMatch(/connection was refused/);
        expect(describeNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" }), { target: "x" }).kind).toBe("timeout");
    });
});
