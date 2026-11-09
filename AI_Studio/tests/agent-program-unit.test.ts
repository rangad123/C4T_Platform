/**
 * The runner agent program, without a browser (fast tier): command line, HTTPS rule, the token never printed, capability
 * parsing, reconnect backoff, protocol validation of malformed answers, file-name safety, the mapping from engine results to
 * wire results, the file cache (checksum, LRU), log redaction and agent-side cleanup against a stub application.
 * Ports: 5872 (stub application for the cleanup rules).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WireRun } from "../src/agent-protocol/schema.js";
import { backoffDelay } from "../src/agent/backoff.js";
import { CapabilityProbe, describeCapabilities, detectBrowsers, parseAdbDevices, parseSimctl } from "../src/agent/capabilities.js";
import { PlatformClient, PlatformError } from "../src/agent/client.js";
import { agentGuard, opsOfScript, runAgentCleanup } from "../src/agent/cleanup.js";
import { checkPlatformAddress, isPrivateHost, parseAgentArgs } from "../src/agent/config.js";
import { CacheIntegrityError, FileCache, sha256OfFile } from "../src/agent/file-cache.js";
import { memoryLogger } from "../src/agent/log.js";
import { main } from "../src/agent/main.js";
import { planUploads, secretsOfEnv, toRunEnv, toWireRun } from "../src/agent/mapping.js";
import { NameAllocator, resolveInside, sanitizeName } from "../src/agent/names.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";

const TOKEN = "aitg_UnitTestToken0123456789abcdefghijk";
const URL_OK = "https://tests.example.com";
let tmp: string;
beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-unit-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("command line", () => {
    it("--help and --version need nothing else", () => {
        expect(parseAgentArgs(["--help"], {}).kind).toBe("help");
        expect(parseAgentArgs(["-h"], {}).kind).toBe("help");
        expect(parseAgentArgs(["--version"], {}).kind).toBe("version");
    });

    it("explains in plain words what is missing or wrong", () => {
        const msg = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
            const r = parseAgentArgs(argv, env);
            if (r.kind !== "error") throw new Error(`expected an error, got ${r.kind}`);
            return r.message;
        };
        expect(msg([])).toMatch(/--url/);
        // Round 39: no token given means the credential this runner keeps (or an enrollment code); main() says so when there is none.
        expect(parseAgentArgs(["--url", URL_OK], {})).toMatchObject({ kind: "run", config: { token: "", tokenSource: "store" } });
        expect(msg(["--url", URL_OK, "--token", "not-a-token"])).toMatch(/not an agent token/);
        expect(msg(["--url", URL_OK, "--token", TOKEN, "--concurrency", "0"])).toMatch(/--concurrency must be between 1 and 8/);
        expect(msg(["--url", URL_OK, "--token", TOKEN, "--concurrency", "9"])).toMatch(/between 1 and 8/);
        expect(msg(["--url", URL_OK, "--token", TOKEN, "--concurrency", "two"])).toMatch(/whole number/);
        expect(msg(["--url", URL_OK, "--token", TOKEN, "--bogus"])).toMatch(/Unknown option --bogus/);
        expect(msg(["--url", URL_OK, "--token", TOKEN, "stray"])).toMatch(/Unexpected argument/);
        expect(msg(["--url"])).toMatch(/needs a value/);
        expect(msg(["--url", "not a url", "--token", TOKEN])).toMatch(/full address/);
        expect(msg(["--url", URL_OK, "--token-file", path.join(tmp, "missing.txt")])).toMatch(/token file could not be read/);
        expect(msg(["--url", "https://user:pw@tests.example.com", "--token", TOKEN])).toMatch(/must not contain a user name/);
    });

    it("reads every option from the environment too, and the flags win", () => {
        const env = { AITP_URL: URL_OK, AITP_AGENT_TOKEN: TOKEN, AITP_AGENT_NAME: "Lab PC", AITP_AGENT_CONCURRENCY: "3", AITP_AGENT_WORK_DIR: path.join(tmp, "work"), AITP_AGENT_CACHE_MB: "64" };
        const r = parseAgentArgs([], env);
        expect(r.kind).toBe("run");
        if (r.kind !== "run") return;
        expect(r.config).toMatchObject({ baseUrl: URL_OK, token: TOKEN, name: "Lab PC", concurrency: 3, workDir: path.join(tmp, "work"), cacheBytes: 64 * 1024 * 1024, tokenSource: "env" });
        const over = parseAgentArgs(["--name", "Other", "--concurrency", "2"], env);
        expect(over.kind === "run" && over.config.name === "Other" && over.config.concurrency === 2).toBe(true);
        // defaults: one slot, a name from the host, a work folder inside the checkout
        const d = parseAgentArgs(["--url", URL_OK, "--token", TOKEN], {});
        expect(d.kind === "run" && d.config.concurrency === 1 && d.config.name.length > 0 && d.config.workDir.endsWith(".agent-work")).toBe(true);
    });

    it("reads the token from a file (first line) and says where it came from", () => {
        const file = path.join(tmp, "token.txt");
        fs.writeFileSync(file, `${TOKEN}\nsecond line ignored\n`);
        const r = parseAgentArgs(["--url", URL_OK, "--token-file", file], {});
        expect(r.kind === "run" && r.config.token === TOKEN && r.config.tokenSource === "file").toBe(true);
        const viaEnv = parseAgentArgs(["--url", URL_OK], { AITP_AGENT_TOKEN_FILE: file });
        expect(viaEnv.kind === "run" && viaEnv.config.token === TOKEN).toBe(true);
    });

    it("never prints the token, in any output", async () => {
        const out: string[] = [];
        const io = { env: {} as NodeJS.ProcessEnv, out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
        for (const argv of [
            ["--help"],
            ["--version"],
            ["--url", "http://example.com", "--token", TOKEN], // refused: public http
            ["--url", URL_OK, "--token", TOKEN, "--concurrency", "99"],
            ["--url", URL_OK, "--token", TOKEN, "--nope"],
            ["--url", "ftp://x", "--token", TOKEN],
        ]) {
            const code = await main(argv, io);
            expect([0, 2]).toContain(code);
        }
        // a badly shaped token is not echoed either
        await main(["--url", URL_OK, "--token", "aitg_short"], io);
        expect(out.join("\n")).not.toContain(TOKEN);
        expect(out.join("\n")).not.toContain("aitg_short");
        expect(out.length).toBeGreaterThan(5);
    });

    it("usage errors exit with code 2", async () => {
        const io = { env: {} as NodeJS.ProcessEnv, out: () => undefined, err: () => undefined };
        expect(await main([], io)).toBe(2);
        expect(await main(["--wat"], io)).toBe(2);
        expect(await main(["--help"], io)).toBe(0);
    });
});

describe("HTTPS rule", () => {
    it("requires https except on this computer or a private network", () => {
        expect(checkPlatformAddress("https://tests.example.com/", false)).toEqual({ ok: true, baseUrl: "https://tests.example.com" });
        expect(checkPlatformAddress("https://tests.example.com/ai/", false)).toMatchObject({ ok: true, baseUrl: "https://tests.example.com/ai" });
        for (const ok of ["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:3000", "http://10.1.2.3", "http://172.16.0.9", "http://172.31.255.1", "http://192.168.1.50:8080", "http://169.254.1.1", "http://[fd00::5]:80"]) {
            const r = checkPlatformAddress(ok, false);
            expect(r.ok, ok).toBe(true);
            expect(r.ok && r.warning).toMatch(/plain http/);
        }
        for (const bad of ["http://tests.example.com", "http://8.8.8.8", "http://172.32.0.1", "http://172.15.0.1", "http://192.169.0.1", "http://myserver"]) {
            const r = checkPlatformAddress(bad, false);
            expect(r.ok, bad).toBe(false);
            expect(!r.ok && r.message).toMatch(/https/);
        }
        const forced = checkPlatformAddress("http://tests.example.com", true);
        expect(forced.ok && forced.warning).toMatch(/--allow-insecure/);
        expect(checkPlatformAddress("ftp://tests.example.com", false).ok).toBe(false);
    });

    it("recognises private hosts", () => {
        expect(isPrivateHost("localhost")).toBe(true);
        expect(isPrivateHost("app.localhost")).toBe(true);
        expect(isPrivateHost("::ffff:10.0.0.1")).toBe(true);
        expect(isPrivateHost("example.com")).toBe(false);
        expect(isPrivateHost("1.2.3.4")).toBe(false);
    });

    it("--allow-insecure (flag or environment) accepts a public http address with a warning", () => {
        const a = parseAgentArgs(["--url", "http://tests.example.com", "--token", TOKEN, "--allow-insecure"], {});
        expect(a.kind === "run" && a.config.insecureWarning).toMatch(/unencrypted/);
        const b = parseAgentArgs(["--url", "http://tests.example.com", "--token", TOKEN], { AITP_AGENT_ALLOW_INSECURE: "1" });
        expect(b.kind).toBe("run");
    });
});

describe("capabilities", () => {
    it("parses `adb devices -l` (emulator, phone, offline, unauthorized, daemon noise)", () => {
        const text = [
            "* daemon not running; starting now at tcp:5037",
            "* daemon started successfully",
            "List of devices attached",
            "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1",
            "R58M12ABCDE            device usb:1-1 product:o1sxxx model:SM_G991B device:o1s transport_id:2",
            "0123456789ABCDEF       unauthorized usb:1-2 transport_id:3",
            "192.168.1.9:5555       offline transport_id:4",
            "ZY22XXXX               no permissions (user in plugdev group; are you sure udev rules are installed?) usb:1-3",
            "",
        ].join("\n");
        expect(parseAdbDevices(text)).toEqual([
            { serial: "emulator-5554", model: "sdk gphone64 x86 64", state: "device", emulator: true },
            { serial: "R58M12ABCDE", model: "SM G991B", state: "device", emulator: false },
            { serial: "0123456789ABCDEF", state: "unauthorized", emulator: false },
            { serial: "192.168.1.9:5555", state: "offline", emulator: false },
            { serial: "ZY22XXXX", state: "no permissions", emulator: false },
        ]);
        expect(parseAdbDevices("")).toEqual([]);
        expect(parseAdbDevices("List of devices attached\n")).toEqual([]);
    });

    it("parses `xcrun simctl list devices -j` (booted first, unavailable skipped)", () => {
        const json = {
            devices: {
                "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
                    { name: "iPhone 15", state: "Shutdown", isAvailable: true, udid: "A" },
                    { name: "iPhone 15 Pro", state: "Booted", isAvailable: true, udid: "B" },
                    { name: "iPad old", state: "Shutdown", isAvailable: false, udid: "C" },
                ],
                "com.apple.CoreSimulator.SimRuntime.watchOS-10-0": [{ name: "Apple Watch", state: "Shutdown", isAvailable: true, udid: "D" }],
            },
        };
        expect(parseSimctl(json)).toEqual(["iPhone 15 Pro (Booted)", "iPhone 15 (Shutdown)", "Apple Watch (Shutdown)"]);
        expect(parseSimctl(null)).toEqual([]);
        expect(parseSimctl({ devices: "nope" })).toEqual([]);
    });

    it("finds installed Playwright browsers by their folders, ignoring half installs and old revisions", () => {
        const dir = path.join(tmp, "ms-playwright");
        const mk = (name: string, complete: boolean) => {
            fs.mkdirSync(path.join(dir, name), { recursive: true });
            if (complete) fs.writeFileSync(path.join(dir, name, "INSTALLATION_COMPLETE"), "");
        };
        mk("chromium-1243", true);
        mk("chromium_headless_shell-1243", true);
        mk("firefox-1543", false); // download interrupted
        mk("webkit-2248", true); // an older revision than this Playwright expects
        mk("ffmpeg-1011", true);
        const expected = { chromium: ["1243"], firefox: ["1543"], webkit: ["2359"] };
        expect(detectBrowsers(dir, expected)).toEqual(["chromium"]);
        mk("firefox-1543", true);
        mk("webkit-2359", true);
        expect(detectBrowsers(dir, expected)).toEqual(["chromium", "firefox", "webkit"]);
        expect(detectBrowsers(path.join(tmp, "nowhere"), expected)).toEqual([]);
        // the installed Playwright's own list is used by default
        expect(Array.isArray(detectBrowsers(dir))).toBe(true);
    });

    it("builds the report, caches it for 30 seconds and notices a phone plugged in later", async () => {
        let adbOutput = "List of devices attached\n";
        let calls = 0;
        let clock = 1_000_000;
        const probe = new CapabilityProbe({
            env: { ANDROID_AVD_HOME: path.join(tmp, "avd-none"), TAQWRIGHT_HOME: path.join(tmp, "no-taqwright") },
            platform: "linux",
            now: () => clock,
            browsers: () => ["chromium"],
            exec: async (file, args) => {
                calls++;
                if (file === "adb" && args[0] === "version") return "Android Debug Bridge";
                if (args[0] === "devices") return adbOutput;
                return undefined;
            },
        });
        const first = await probe.get();
        expect(first).toMatchObject({ os: "linux", browsers: ["chromium"], android: { adb: true, devices: [], avds: [] } });
        const after = calls;
        clock += 10_000;
        adbOutput += "R58M12ABCDE device model:Pixel_7\n";
        expect((await probe.get()).android?.devices).toEqual([]); // still cached
        expect(calls).toBe(after);
        clock += 25_000; // 35 s since the first look
        expect((await probe.get()).android?.devices).toEqual([{ serial: "R58M12ABCDE", model: "Pixel 7", state: "device", emulator: false }]);
        expect(describeCapabilities(await probe.get())).toMatch(/1 device ready/);
    });

    it("reports a machine without Android or browsers plainly", async () => {
        const probe = new CapabilityProbe({ env: { ANDROID_AVD_HOME: path.join(tmp, "avd-none"), TAQWRIGHT_HOME: path.join(tmp, "no-taqwright") }, platform: "linux", browsers: () => [], exec: async () => undefined });
        const c = await probe.get();
        expect(c.android).toBeUndefined();
        expect(describeCapabilities(c)).toMatch(/no Playwright browsers installed/);
    });
});

describe("reconnect backoff", () => {
    it("grows from about a second to at most 30 seconds, with jitter", () => {
        const at = (n: number, r: number) => backoffDelay(n, {}, () => r);
        expect(at(0, 0)).toBe(750);
        expect(at(0, 1)).toBe(1250);
        expect(at(1, 0.5)).toBe(2000);
        expect(at(3, 0.5)).toBe(8000);
        for (const n of [5, 6, 10, 40, 1000]) expect(at(n, 1)).toBeLessThanOrEqual(30_000);
        expect(at(10, 0)).toBeGreaterThanOrEqual(22_500);
        expect(backoffDelay(2, {})).toBeGreaterThanOrEqual(3000);
        // small settings for tests
        expect(backoffDelay(0, { baseMs: 10, maxMs: 40 }, () => 0.5)).toBe(10);
        expect(backoffDelay(9, { baseMs: 10, maxMs: 40 }, () => 1)).toBe(40);
    });
});

describe("protocol client: every answer is validated", () => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
        (async () => new Response(status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
    const client = (f: typeof fetch) => new PlatformClient({ baseUrl: "https://tests.example.com", token: TOKEN, fetchImpl: f });
    const hello = { protocol: 1, name: "x", version: "1", concurrency: 1, capabilities: { os: "linux" as const, arch: "x64", node: "v24", browsers: [] } };
    const helloOk = { agentId: "a", projectId: "p", protocol: 1, pollSeconds: 5, heartbeatSeconds: 5, maxFileBytes: 1000, serverTime: "now" };
    const err = async (p: Promise<unknown>) => {
        try {
            await p;
        } catch (e) {
            return e as PlatformError;
        }
        throw new Error("expected an error");
    };

    it("accepts good answers and sends the token only in the Authorization header", async () => {
        let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
        const f = (async (url: string, init: RequestInit) => {
            seen = { url, headers: init.headers as Record<string, string>, body: String(init.body) };
            return new Response(JSON.stringify(helloOk), { status: 200 });
        }) as unknown as typeof fetch;
        expect(await client(f).hello(hello)).toMatchObject({ agentId: "a" });
        expect(seen!.url).toBe("https://tests.example.com/api/agent/hello");
        expect(seen!.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(seen!.body).not.toContain(TOKEN);
    });

    it("turns malformed answers into plain errors instead of trusting them", async () => {
        expect((await err(client(reply(200, "{ not json")).hello(hello))).kind).toBe("invalid");
        const missing = await err(client(reply(200, { agentId: "a" })).hello(hello));
        expect(missing.kind).toBe("invalid");
        expect(missing.message).toMatch(/does not match the protocol/);
        expect((await err(client(reply(200, { cancel: "yes" })).heartbeat("t1", {}))).kind).toBe("invalid");
        expect((await err(client(reply(200, { ref: "x" })).upload("t1", "x.png", path.join(tmp, "token.txt"), 1))).kind).toBe("invalid");
    });

    it("a task that does not fit the protocol is reported with its id, not crashed on", async () => {
        const r = await client(reply(200, { taskId: "task-9", adapterId: "playwright" })).poll({ agentId: "a", freeSlots: 1 });
        expect(r).toMatchObject({ taskId: "task-9" });
        expect(r && "unreadable" in r && r.unreadable).toMatch(/does not match the protocol/);
        expect(await client(reply(204, "")).poll({ agentId: "a", freeSlots: 1 })).toBeNull();
        const garbage = await err(client(reply(200, "<html>proxy error</html>")).poll({ agentId: "a", freeSlots: 1 }));
        expect(garbage.kind).toBe("invalid");
    });

    it("maps statuses: bad token, revoked token, refusal, protocol, server trouble", async () => {
        const a = await err(client(reply(401, { error: "bad" })).hello(hello));
        expect(a.kind).toBe("auth");
        expect(a.message).toMatch(/not valid or was revoked/);
        expect((await err(client(reply(404, { error: "no such token" })).hello(hello))).kind).toBe("auth"); // revoked = 404
        expect((await err(client(reply(404, "")).poll({ agentId: "a", freeSlots: 1 }))).kind).toBe("auth");
        const c = await err(client(reply(409, { message: "Another agent is called that." })).hello(hello));
        expect(c.kind).toBe("conflict");
        expect(c.message).toMatch(/Another agent is called that/);
        expect((await err(client(reply(426, { error: "upgrade" })).hello(hello))).kind).toBe("protocol");
        expect((await err(client(reply(503, "")).hello(hello))).kind).toBe("network");
        const slow = await err(client(reply(429, "", { "retry-after": "7" })).poll({ agentId: "a", freeSlots: 1 }));
        expect(slow).toMatchObject({ kind: "network", retryAfter: 7 });
        // a task route that says 404 is "that task is gone", not "your token is bad"
        expect((await err(client(reply(404, { error: "No such task." })).heartbeat("t1", {}))).kind).toBe("rejected");
    });

    it("describes network failures without the request, the address path or the token", async () => {
        const refused = (async () => {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        }) as unknown as typeof fetch;
        const e = await err(client(refused).hello(hello));
        expect(e.kind).toBe("network");
        expect(e.message).toMatch(/connection was refused/);
        expect(e.message).toContain("tests.example.com");
        expect(e.message).not.toContain(TOKEN);
        const cert = (async () => {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } });
        }) as unknown as typeof fetch;
        expect((await err(client(cert).hello(hello))).message).toMatch(/certificate was not accepted/);
        for (const kind of [e, await err(client(reply(500, "boom")).hello(hello))]) expect(kind.message).not.toContain(TOKEN);
    });
});

describe("names and paths", () => {
    it("makes safe names from anything", () => {
        expect(sanitizeName("../../etc/passwd")).toBe("etc_passwd");
        expect(sanitizeName("C:\\Windows\\System32")).toBe("C_Windows_System32");
        expect(sanitizeName("..")).toBe("file");
        expect(sanitizeName("")).toBe("file");
        expect(sanitizeName("tâche é.png")).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(sanitizeName("a".repeat(500), 50)).toHaveLength(50);
        expect(sanitizeName(".hidden")).toBe("hidden");
    });

    it("keeps paths inside their folder", () => {
        const base = path.join(tmp, "tasks");
        expect(resolveInside(base, "task-1")).toBe(path.join(base, "task-1"));
        for (const bad of ["..", "../x", "a/../../x", "..\\..\\x", path.resolve("/etc"), ""]) expect(resolveInside(base, bad), bad).toBeUndefined();
    });

    it("hands out unique upload names, valid for the protocol", () => {
        const names = new NameAllocator();
        const got = [names.allocate("trace", ".zip"), names.allocate("trace", ".zip"), names.allocate("TRACE", ".zip"), names.allocate("a b/c", ".weird-ext-too-long")];
        expect(new Set(got.map((g) => g.toLowerCase())).size).toBe(4);
        expect(got[0]).toBe("trace.zip");
        expect(got[1]).toBe("trace-2.zip");
        for (const n of got) expect(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(n), n).toBe(true);
    });
});

describe("mapping engine results to wire results", () => {
    const run = (over: Partial<ScriptRun> = {}): ScriptRun => ({ testId: "WEB-001", status: "failed", durationMs: 1200, error: "boom", failedStepIndex: 1, steps: [{ index: 0, title: "1. Open", status: "passed" }, { index: 1, title: "2. Click", status: "failed", error: "nope" }], artifacts: [], responses: [], ...over });

    it("gives artifacts with the same file name in different folders different upload names", () => {
        const runs = [
            run({ artifacts: [{ kind: "trace", path: "/w/artifacts/a-chromium/trace.zip" }, { kind: "screenshot", path: "/w/artifacts/a-chromium/test-failed-1.png" }, { kind: "video", path: "/w/artifacts/a-chromium/video.webm" }] }),
            run({ testId: "WEB-002", artifacts: [{ kind: "trace", path: "/w/artifacts/b-chromium/trace.zip" }, { kind: "screenshot", path: "/w/artifacts/b-chromium/test-failed-1.png" }], variant: "Mobile Safari" }),
        ];
        const items = planUploads(runs);
        expect(items.map((i) => i.name)).toEqual(["WEB-001-trace.zip", "WEB-001-screenshot.png", "WEB-001-video.webm", "WEB-002-Mobile_Safari-trace.zip", "WEB-002-Mobile_Safari-screenshot.png"]);
        expect(new Set(items.map((i) => i.name)).size).toBe(items.length);
    });

    it("turns paths into the uploaded names, for every artifact kind, vision shots and new baselines", () => {
        const r = run({
            artifacts: [
                { kind: "screenshot", path: "/w/a/s.png" },
                { kind: "trace", path: "/w/a/t.zip" },
                { kind: "video", path: "/w/a/v.webm" },
                { kind: "visual-actual", path: "/w/a/actual.png" },
                { kind: "visual-diff", path: "/w/a/diff.png" },
                { kind: "vision-shot", path: "/w/a/vs.jpg" },
                { kind: "evidence", path: "/w/a/WEB-001-evidence.json" },
            ],
            vision: [{ step: 2, path: "/w/a/vs.jpg", expected: "looks fine" }],
            newBaselines: [{ name: "WEB-001-1.png", path: "/w/__baselines__/WEB-001-1.png" }],
            responses: [{ method: "GET", path: "/x", status: 200, obs: { a: "string" } }],
            metrics: [{ metric: "lcp", value: 1.5, unit: "s", budget: 2 }],
            notes: ["a note"],
        });
        const items = planUploads([r]);
        const uploaded = new Map(items.map((i) => [i.path, i.name]));
        const wire = toWireRun(r, { uploaded, skipped: new Map() });
        expect(WireRun.safeParse(wire).success).toBe(true);
        expect(wire.artifacts.map((a) => a.kind)).toEqual(["screenshot", "trace", "video", "visual-actual", "visual-diff", "vision-shot", "evidence"]);
        expect(wire.artifacts.every((a) => !a.ref.includes("/") && !a.ref.includes("\\"))).toBe(true);
        expect(wire.vision).toEqual([{ step: 2, ref: uploaded.get("/w/a/vs.jpg"), expected: "looks fine" }]);
        expect(wire.artifacts.find((a) => a.kind === "vision-shot")!.ref).toBe(wire.vision![0]!.ref); // one file, one upload
        expect(wire.newBaselines).toEqual([{ name: "WEB-001-1.png", ref: "WEB-001-1.png" }]);
        expect(JSON.stringify(wire)).not.toContain("/w/");
        expect(wire).toMatchObject({ testId: "WEB-001", status: "failed", failedStepIndex: 1, metrics: [{ metric: "lcp", value: 1.5, unit: "s", budget: 2 }], notes: ["a note"] });
    });

    it("leaves out a file that was not uploaded and says so in a note", () => {
        const r = run({ artifacts: [{ kind: "trace", path: "/w/t.zip" }, { kind: "screenshot", path: "/w/s.png" }] });
        const wire = toWireRun(r, { uploaded: new Map([["/w/s.png", "WEB-001-screenshot.png"]]), skipped: new Map([["/w/t.zip", "WEB-001-trace.zip (80 MB) is larger than the 64 MB limit"]]) });
        expect(wire.artifacts).toEqual([{ kind: "screenshot", ref: "WEB-001-screenshot.png" }]);
        expect(wire.notes?.[0]).toMatch(/not attached: WEB-001-trace.zip \(80 MB\) is larger/);
        expect(WireRun.safeParse(wire).success).toBe(true);
    });

    it("cuts everything to the sizes the protocol allows", () => {
        const long = "x".repeat(5000);
        const r = run({
            error: long,
            steps: Array.from({ length: 700 }, (_, i) => ({ index: i, title: `${i}. step`, status: "passed" as const, error: long })),
            notes: Array.from({ length: 80 }, () => long),
            responses: Array.from({ length: 900 }, (_, i) => ({ method: "GET", path: `/p${i}`, status: 200 })),
            durationMs: Number.NaN,
        });
        const wire = toWireRun(r, { uploaded: new Map(), skipped: new Map() });
        expect(WireRun.safeParse(wire).success).toBe(true);
        expect(wire.error).toHaveLength(2000);
        expect(wire.steps).toHaveLength(500);
        expect(wire.steps[0]!.error).toHaveLength(800);
        expect(wire.notes).toHaveLength(50);
        expect(wire.responses).toHaveLength(500);
        expect(wire.durationMs).toBe(0);
    });

    it("hands the cleanup request to the script as the platform's ledger mode, and lists every secret to mask", () => {
        expect(toRunEnv({ baseUrl: "http://x", headless: true, cleanup: "agent" }).cleanup).toBe("platform");
        expect(toRunEnv({ baseUrl: "http://x", headless: true, cleanup: "off" }).cleanup).toBe("off");
        expect(toRunEnv({ baseUrl: "http://x", headless: true }).cleanup).toBeUndefined();
        const secrets = secretsOfEnv({
            baseUrl: "http://x",
            headless: true,
            credentials: { username: "user1", password: "pw-one", totpSecret: "totp-one" },
            roles: [{ name: "admin", username: "adm", password: "pw-two", apiToken: "tok-two" }],
            apiToken: "api-one",
            apiAuthHeader: "X-Key: hdr-secret",
            vars: { REGION: "eu-west" },
        });
        expect(secrets).toEqual(expect.arrayContaining(["pw-one", "totp-one", "pw-two", "tok-two", "api-one", "X-Key: hdr-secret", "hdr-secret", "eu-west"]));
        expect(secrets).not.toContain("user1");
    });
});

describe("file cache", () => {
    const content = (s: string) => Buffer.from(s.repeat(100));
    const ref = async (buf: Buffer) => {
        const f = path.join(tmp, `ref-${Math.random().toString(16).slice(2)}`);
        fs.writeFileSync(f, buf);
        return { size: buf.length, sha256: (await sha256OfFile(f)).sha256 };
    };
    const writer = (buf: Buffer, counter?: { n: number }) => async (dest: string) => {
        if (counter) counter.n++;
        fs.writeFileSync(dest, buf);
        return sha256OfFile(dest);
    };

    it("downloads once, verifies the checksum and serves the second request from disk", async () => {
        const cache = new FileCache(path.join(tmp, "cache1"), 10_000_000);
        await cache.init();
        const buf = content("baseline");
        const r = await ref(buf);
        const counter = { n: 0 };
        const p1 = await cache.get(r, writer(buf, counter), ".png");
        const p2 = await cache.get(r, writer(buf, counter), ".png");
        expect(p1).toBe(p2);
        expect(counter.n).toBe(1);
        expect(fs.readFileSync(p1).equals(buf)).toBe(true);
        expect(path.basename(p1)).toBe(`${r.sha256}.png`);
        // two tasks asking at the same moment share one download
        const buf2 = content("other");
        const r2 = await ref(buf2);
        const c2 = { n: 0 };
        await Promise.all([cache.get(r2, writer(buf2, c2)), cache.get(r2, writer(buf2, c2))]);
        expect(c2.n).toBe(1);
    });

    it("refuses a download whose content is not what the platform announced, and keeps nothing of it", async () => {
        const cache = new FileCache(path.join(tmp, "cache2"), 10_000_000);
        await cache.init();
        const good = content("good");
        const r = await ref(good);
        await expect(cache.get(r, writer(content("tampered")))).rejects.toBeInstanceOf(CacheIntegrityError);
        await expect(cache.get({ ...r, size: r.size + 1 }, writer(good))).rejects.toThrow(/did not match its checksum/);
        expect(fs.readdirSync(cache.dir)).toEqual([]);
        // and a good download afterwards works
        expect(fs.existsSync(await cache.get(r, writer(good)))).toBe(true);
    });

    it("prunes least recently used files over the cap, never a file in use", async () => {
        const cache = new FileCache(path.join(tmp, "cache3"), 2500);
        await cache.init();
        const bufs = ["a", "b", "c", "d"].map((c) => Buffer.from(c.repeat(1000)));
        const refs = await Promise.all(bufs.map(ref));
        const paths: string[] = [];
        for (let i = 0; i < 3; i++) {
            paths.push(await cache.get(refs[i]!, writer(bufs[i]!)));
            fs.utimesSync(paths[i]!, new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000)); // a, b, c in age order
        }
        cache.release(paths); // nothing in use
        // using "a" again makes it the most recent; the oldest is now "b"
        paths[0] = await cache.get(refs[0]!, writer(bufs[0]!));
        cache.release([paths[0]!]);
        const d = await cache.get(refs[3]!, writer(bufs[3]!)); // 4000 bytes in a 2500 byte cache
        const left = fs.readdirSync(cache.dir).sort();
        expect(left.length).toBeLessThanOrEqual(2);
        expect(left).toContain(path.basename(d)); // the newest is kept
        expect(fs.existsSync(paths[1]!)).toBe(false); // least recently used went first
        // a pinned file survives pruning
        const pinned = await cache.get(refs[1]!, writer(bufs[1]!));
        fs.utimesSync(pinned, new Date(1), new Date(1)); // the oldest of all
        await cache.get(refs[2]!, writer(bufs[2]!));
        await cache.prune();
        expect(fs.existsSync(pinned)).toBe(true);
        cache.release([pinned]);
        await cache.prune();
        expect(fs.existsSync(pinned)).toBe(false);
    });

    it("removes half-finished downloads when it starts", async () => {
        const dir = path.join(tmp, "cache4");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, ".tmp-abc"), "partial");
        await new FileCache(dir, 1000).init();
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});

describe("log redaction", () => {
    it("masks registered secrets wherever they appear, longest first, and forgets them when asked", () => {
        const { log, lines } = memoryLogger();
        const forget = log.addSecrets(["hunter2-password", "hunter2", "ab"]);
        log.info("login with hunter2-password failed, then hunter2 again; ab is too short to mask");
        log.warn("multi\nline hunter2");
        expect(lines[0]).toContain("login with *** failed, then *** again; ab is too short");
        expect(lines[0]).not.toContain("hunter2");
        expect(lines[1]).not.toContain("hunter2");
        expect(lines[1]).not.toContain("\n");
        expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO  /);
        forget();
        log.info("hunter2");
        expect(lines[2]).toContain("hunter2");
    });
});

describe("agent-side cleanup", () => {
    const PORT = 5872;
    let server: http.Server;
    const seen: Array<{ method: string; path: string; auth: string }> = [];
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            seen.push({ method: req.method ?? "", path: req.url ?? "", auth: String(req.headers.authorization ?? "") });
            const id = (req.url ?? "").split("/").pop();
            if (id === "gone") return void res.writeHead(404).end();
            if (id === "broken") return void res.writeHead(500).end("body that must not be read");
            if (id === "redirect") return void res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end();
            res.writeHead(204).end();
        });
        await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
    });

    const created = (id: string, at: string) => ({ k: "created" as const, path: "/api/items", id, at });
    const script = (ops: string[]) => `import { test } from "@playwright/test";\nconst CLEANUP_OPS: string[] = ${JSON.stringify(ops)};\n`;
    const baseRun = (over: Partial<ScriptRun>): ScriptRun => ({ testId: "API-001", status: "passed", durationMs: 5, failedStepIndex: -1, steps: [], artifacts: [], responses: [], ...over });

    it("reads the DELETE operations a generated script carries", () => {
        const spec = TestSpecSchema.parse({ testId: "API-009", title: "Create an item", kind: "api", steps: [{ action: "request", method: "POST", path: "/api/items", auth: "default", description: "", body: { name: "x" } }, { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" }] });
        const rendered = renderScript(spec, "playwright-api", { baseUrl: "http://x", deleteOps: ["/api/items/{id}"] }).content;
        expect(opsOfScript(rendered)).toEqual(["/api/items/{id}"]);
        expect(opsOfScript("no ops here")).toEqual([]);
        expect(opsOfScript('const CLEANUP_OPS: string[] = ["/ok/{id}", 3, "nope", {}];')).toEqual(["/ok/{id}"]);
        expect(opsOfScript("const CLEANUP_OPS: string[] = [broken];")).toEqual([]);
    });

    it("deletes only what the scripts recorded, newest first, with the run's credentials, and reports the outcomes", async () => {
        seen.length = 0;
        const runs = [
            baseRun({ created: [created("1", "2026-01-01T00:00:01Z"), created("2", "2026-01-01T00:00:02Z"), created("gone", "2026-01-01T00:00:03Z")] }),
            baseRun({ testId: "API-002", created: [created("broken", "2026-01-01T00:00:04Z"), created("redirect", "2026-01-01T00:00:05Z"), { k: "created", path: "/api/notes", id: "n1", at: "2026-01-01T00:00:06Z" }] }),
            baseRun({ testId: "API-003", created: [created("5", "2026-01-01T00:00:07Z"), { k: "deleted", path: "/api/items/5", status: 204 }] }), // the test removed it itself
        ];
        const scripts = [
            { testId: "API-001", filename: "API-001.spec.ts", content: script(["/api/items/{id}"]) },
            { testId: "API-002", filename: "API-002.spec.ts", content: script(["/api/items/{id}"]) },
            { testId: "API-003", filename: "API-003.spec.ts", content: script(["/api/items/{id}"]) },
        ];
        const result = await runAgentCleanup(runs, scripts, { baseUrl: `http://127.0.0.1:${PORT}`, apiToken: "tok-cleanup-1", headless: true });

        // newest first, one at a time, the token on every DELETE, nothing but DELETE, nothing the scripts did not record
        expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["DELETE /api/items/redirect", "DELETE /api/items/broken", "DELETE /api/items/gone", "DELETE /api/items/2", "DELETE /api/items/1"]);
        expect(seen.every((s) => s.auth === "Bearer tok-cleanup-1")).toBe(true);

        const lines = runs.flatMap((r) => (r.created ?? []) as unknown as Array<Record<string, unknown>>);
        const byId = Object.fromEntries(lines.map((l) => [l.id as string, l]));
        expect(byId["1"]).toMatchObject({ status: "removed", deletePath: "/api/items/1", testId: "API-001" });
        expect(byId["gone"]).toMatchObject({ status: "already-gone" });
        expect(byId["broken"]).toMatchObject({ status: "failed", reason: "The application answered HTTP 500." });
        expect(byId["redirect"]!.reason).toMatch(/redirect/);
        expect(byId["n1"]).toMatchObject({ status: "no-delete-operation" });
        expect(byId["5"]).toMatchObject({ status: "removed", reason: "The test deleted it itself." });
        expect(JSON.stringify(lines)).not.toContain("body that must not be read");
        expect(result).toMatchObject({ created: 7, removed: 4, leftBehind: 3 });
        expect(result.summary).toBe("Removed 4 of 7 records the tests created; 3 left behind.");
        // what goes to the platform fits the protocol
        for (const r of runs) expect(WireRun.safeParse(toWireRun(r, { uploaded: new Map(), skipped: new Map() })).success).toBe(true);
    });

    it("never touches another address, even if a record points there", async () => {
        seen.length = 0;
        const run = baseRun({ created: [{ k: "created", path: "/api/items", id: "7", at: "2026-01-01T00:00:01Z", location: "//evil.example/api/items/7" }] });
        await runAgentCleanup([run], [{ testId: "API-001", filename: "x.spec.ts", content: script(["/api/items/{id}"]) }], { baseUrl: `http://127.0.0.1:${PORT}`, headless: true });
        expect(seen.map((s) => s.path)).toEqual(["/api/items/7"]); // the id, on the application's own address
        await expect(agentGuard("file:///etc/passwd")).rejects.toMatchObject({ status: 422 });
        await expect(agentGuard("http://user:pw@127.0.0.1/x")).rejects.toMatchObject({ status: 422 });
        await agentGuard("http://127.0.0.1:5872/x"); // private addresses are the point of running on the agent
    });

    it("on a runner that refuses private addresses, a delete whose name now leads to a private address is not sent", async () => {
        seen.length = 0;
        const run = baseRun({ created: [created("1", "2026-01-01T00:00:01Z")] });
        // The name was public when the run was checked; by the time of the cleanup it leads to this computer (DNS rebinding).
        const lookup = async () => [{ address: "127.0.0.1" }];
        const r = await runAgentCleanup([run], [{ testId: "API-001", filename: "x.spec.ts", content: script(["/api/items/{id}"]) }], { baseUrl: `http://rebind.example:${PORT}`, apiToken: "tok-cleanup-2", headless: true }, { refusePrivate: true, lookup });
        expect(seen).toEqual([]);
        expect(r).toMatchObject({ created: 1, removed: 0, leftBehind: 1 });
        expect((run.created![0] as unknown as { reason: string }).reason).toMatch(/private or local address/);
    });

    it("reports what it could not do instead of throwing", async () => {
        const run = baseRun({ created: [created("1", "2026-01-01T00:00:01Z")] });
        const r = await runAgentCleanup([run], [{ testId: "API-001", filename: "x.spec.ts", content: script(["/api/items/{id}"]) }], { baseUrl: "http://127.0.0.1:1", headless: true });
        expect(r).toMatchObject({ created: 1, removed: 0, leftBehind: 1 });
        expect((run.created![0] as unknown as { reason: string }).reason).toMatch(/Could not reach the application/);
        const none = await runAgentCleanup([baseRun({})], [], { baseUrl: "http://127.0.0.1:1", headless: true });
        expect(none).toMatchObject({ created: 0, summary: "The tests created no records." });
    });
});
