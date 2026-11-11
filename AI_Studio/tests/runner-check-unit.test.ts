/**
 * "Check this computer" for the runner (src/agent/computer-check.ts, docs/features/runner-check.md), without a browser, a server or the
 * internet: every line on fake computers, the whole check on a fake download folder with a stand-in platform (fetch), the token and a proxy
 * password never in the output, the report a running runner sends with its hello, the check-computer files in every kind of download, and
 * the start scripts' check mode. Fast tier.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RunnerCheck, type Capabilities } from "../src/agent-protocol/schema.js";
import { execText } from "../src/agent/capabilities.js";
import { toolCwd } from "../src/engine/mobile/toolchain.js";
import {
    BUNDLE_FILES,
    browserLine,
    checkComputer,
    checkSummary,
    clockLine,
    diskLine,
    enginesLine,
    filesLine,
    formatCheck,
    isBundledNode,
    macChipLine,
    maskSecrets,
    networkLine,
    nodeLine,
    noteServerTime,
    phoneLine,
    platformLine,
    quarantineLine,
    resetRunnerCheck,
    runCheckProgram,
    runnerCheckReport,
    startRunnerCheck,
    tokenLine,
    toolsLine,
    type CheckDeps,
} from "../src/agent/computer-check.js";
import { resolveNetwork } from "../src/agent/net.js";
import { describeNetworkError, problemSentence } from "../src/engine/net/company-network.js";
import { CHECK_CMD, CHECK_COMMAND, CHECK_FILES, CHECK_SH } from "../src/platform/runner-check-scripts.js";
import { buildInstallerZip } from "../src/platform/runner-installer.js";
import { buildKitZip, type Bundle } from "../src/platform/runner-kit.js";
import { START_CMD, START_SH } from "../src/platform/runner-kit-scripts.js";

const TOKEN = "aitg_CheckUnitTokenSentinel0123456789abcd";
const PASSWORD = "Chk-Pr0xy-P4ss-sentinel";
const GB = 1024 ** 3;
let tmp: string;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-check-unit-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/** A download folder as the platform makes it: the five bundle files, runner.json with the version hash of exactly those bytes, the token. */
function fakeKit(name: string, o: { damage?: boolean; tools?: boolean; complete?: boolean; json?: Record<string, unknown> } = {}): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (const f of BUNDLE_FILES) {
        const bytes = Buffer.from(f === "package.json" ? JSON.stringify({ dependencies: { "@playwright/test": "1.63.0", playwright: "1.63.0" }, optionalDependencies: { "@taqwright/taqwright": "1.1.0" } }) : `// ${f}\n`);
        fs.writeFileSync(path.join(dir, f), bytes);
        lines.push(`${f}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
    }
    const kitVersion = `0.1.0+${createHash("sha256").update(lines.join("")).digest("hex").slice(0, 10)}`;
    if (o.damage) fs.appendFileSync(path.join(dir, "task-child.mjs"), "// changed\n");
    fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ url: "https://tests.example.com", name: "Office PC", kitVersion, ...o.json }));
    fs.writeFileSync(path.join(dir, "runner.token"), `${TOKEN}\n`);
    if (o.tools) {
        for (const n of ["@playwright/test", "playwright"]) {
            fs.mkdirSync(path.join(dir, "node_modules", ...n.split("/")), { recursive: true });
            fs.writeFileSync(path.join(dir, "node_modules", ...n.split("/"), "package.json"), JSON.stringify({ name: n, version: "1.63.0" }));
        }
    }
    if (o.complete) fs.writeFileSync(path.join(dir, "complete-kit.json"), "{}");
    return dir;
}

interface Call {
    url: string;
    method: string;
    auth?: string;
}

/** A stand-in platform behind `fetch`: answers the health route and the token check, records every request. */
function fakeFetch(o: { tokenOk?: boolean; down?: unknown; date?: string; healthStatus?: number } = {}): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, method: init?.method ?? "GET", ...(headers.get("authorization") ? { auth: headers.get("authorization")! } : {}) });
        if (o.down) throw o.down;
        const date = o.date ?? "Mon, 19 Oct 2026 10:00:00 GMT";
        if (url.endsWith("/api/health")) return new Response(JSON.stringify({ status: "ok" }), { status: o.healthStatus ?? 200, headers: { "content-type": "application/json", date } });
        if (url.endsWith("/api/agent/check")) {
            return o.tokenOk === false
                ? new Response(JSON.stringify({ error: "This runner agent token is not valid or was revoked." }), { status: 404, headers: { "content-type": "application/json" } })
                : new Response(JSON.stringify({ ok: true, project: "Shop" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, calls };
}

/** A fake computer: no browsers found (a folder with nothing in it), plenty of disk, a fixed clock. */
function deps(extra: Partial<CheckDeps> = {}): Partial<CheckDeps> {
    return {
        platform: "linux",
        arch: "x64",
        nodeVersion: "v24.19.0",
        execPath: "/usr/bin/node",
        now: () => Date.parse("2026-10-19T10:00:00Z"),
        exec: async () => undefined,
        freeBytes: () => 50 * GB,
        systemCertificates: () => 140,
        browserRoot: path.join(tmp, "no-browsers"),
        applyNetwork: false,
        ...extra,
    };
}

/** The environment of a fake computer: nothing from this machine's proxy, Android or Playwright settings. */
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: "", PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, "no-browsers"), HOME: tmp, AITP_ADB_PATH: path.join(tmp, "no-adb"), ...extra });

describe("each line on a fake computer", () => {
    it("Node.js: version, came with the download or not, too old", () => {
        expect(nodeLine("v24.19.0", true)).toEqual({ id: "node", status: "ok", title: "Node.js v24.19.0, came with this download" });
        expect(nodeLine("v26.1.0", false).title).toBe("Node.js v26.1.0, installed on this computer");
        const old = nodeLine("v20.11.0", false);
        expect(old.status).toBe("missing");
        expect(old.fix).toMatch(/nodejs\.org.*complete runner/);
        expect(isBundledNode(path.join("/k", "node", "bin", "node"), "/k")).toBe(true);
        expect(isBundledNode("/usr/bin/node", "/k")).toBe(false);
    });

    it("the runner files are compared with the checksum in their version, so a changed file is found", () => {
        const ok = fakeKit("files-ok");
        const v = JSON.parse(fs.readFileSync(path.join(ok, "runner.json"), "utf8")).kitVersion as string;
        const read = (dir: string) => (n: string) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n)) : undefined);
        expect(filesLine(v, read(ok))).toMatchObject({ status: "ok", title: `Runner files match this download (version ${v})` });
        // A download built without a lock file, which npm install then wrote one into: still the same download.
        fs.writeFileSync(path.join(ok, "package-lock.json"), '{"lockfileVersion":3}\n');
        expect(filesLine(v, read(ok))).toMatchObject({ status: "ok" });
        fs.rmSync(path.join(ok, "package-lock.json"));
        const bad = fakeKit("files-bad", { damage: true });
        expect(filesLine(v, read(bad))).toMatchObject({ status: "missing", title: expect.stringContaining("do not match this download") });
        fs.rmSync(path.join(bad, "record-child.mjs"));
        expect(filesLine(v, read(bad))).toMatchObject({ status: "missing", title: "Runner files: record-child.mjs is missing" });
        expect(filesLine("0.1.0", read(ok)).status).toBe("optional");
    });

    it("the test tools: installed, missing (plain files or complete download), wrong version, phone tools optional", () => {
        const pkg = { dependencies: { "@playwright/test": "1.63.0", typescript: "5.9.3" }, optionalDependencies: { "@taqwright/taqwright": "1.1.0" } };
        const have = (m: Record<string, string>) => (n: string) => m[n];
        expect(toolsLine(pkg, have({ "@playwright/test": "1.63.0", typescript: "5.9.3", "@taqwright/taqwright": "1.1.0" }), true)).toMatchObject({ status: "ok", title: "Test tools are installed (Playwright 1.63.0), came with this download" });
        expect(toolsLine(pkg, have({ "@playwright/test": "1.63.0", typescript: "5.9.3" }), false).title).toBe("Test tools are installed (Playwright 1.63.0); the phone test tools are not (only phone tests need them)");
        const none = toolsLine(pkg, have({}), false);
        expect(none).toMatchObject({ status: "missing", title: "The test tools are not installed (@playwright/test and 1 more)" });
        expect(none.fix).toMatch(/start-runner/);
        expect(toolsLine(pkg, have({}), true).fix).toMatch(/incomplete/);
        expect(toolsLine(pkg, have({ "@playwright/test": "1.62.0", typescript: "5.9.3" }), false)).toMatchObject({ status: "missing", title: "The test tools are not the versions this runner needs (@playwright/test 1.62.0, needs 1.63.0)" });
        expect(toolsLine(undefined, have({}), false).status).toBe("missing");
    });

    it("the browser: which one web tests will use and why, the download, and a choice the computer cannot meet", () => {
        const edge = { name: "msedge" as const, path: "C:\\Edge\\msedge.exe", version: "155.0.1.2", usable: true };
        const oldChrome = { name: "chrome" as const, path: "C:\\Chrome\\chrome.exe", version: "120.0.0.0", usable: false, reason: "Google Chrome 120 is too old: the test tools need version 150 or newer" };
        const used = browserLine({ policy: "auto", decision: { use: "installed", browser: edge }, installed: [oldChrome, edge] });
        expect(used).toMatchObject({ status: "ok", title: "Web tests will use Microsoft Edge 155, installed on this computer (browser setting: auto, the default)" });
        expect(used.notes).toEqual(["Google Chrome 120 is too old: the test tools need version 150 or newer."]);
        expect(browserLine({ policy: "auto", decision: { use: "bundled" }, installed: [], bundled: { version: "153.0.1", major: 153 }, downloadedBefore: true }).title).toBe("Web tests will use Chromium 153, downloaded by the runner (browser setting: auto, the default)");
        const dl = browserLine({ policy: "auto", decision: { use: "download" }, installed: [], bundled: { version: "153.0.1", major: 153 } });
        expect(dl).toMatchObject({ status: "ok", title: expect.stringContaining("the runner downloads Chromium 153 once when it starts") });
        const none = browserLine({ policy: "msedge", decision: { use: "none", reason: "Microsoft Edge is not installed on this computer (looked in the usual install folders)." }, installed: [] });
        expect(none.status).toBe("missing");
        expect(none.fix).toMatch(/Install Microsoft Edge.*--browser auto/);
    });

    it("Firefox and WebKit are optional", () => {
        expect(enginesLine(["chromium", "firefox", "webkit"]).status).toBe("ok");
        expect(enginesLine(["chromium"])).toMatchObject({ status: "optional", title: "Firefox and WebKit are not here yet (only runs on other browsers need them)" });
        expect(enginesLine(["firefox"]).title).toBe("WebKit is not here yet (only runs on other browsers need it)");
    });

    it("the network: the proxy with its password as ***, the certificates, and a Node.js too old for a proxy", () => {
        const r = resolveNetwork({ proxy: `http://maya:${PASSWORD}@proxy.corp.test:8080` }, {});
        if (!r.ok) throw new Error(r.message);
        const l = networkLine(r.settings, { nodeVersion: "v24.19.0", systemCertificates: 140 });
        expect(l).toMatchObject({ status: "ok", title: "Network: connects through the proxy http://maya:***@proxy.corp.test:8080, from --proxy; trusts Node.js's own certificates, this computer's certificate store (140)" });
        expect(JSON.stringify(l)).not.toContain(PASSWORD);
        expect(networkLine(r.settings, { nodeVersion: "v24.11.0" }).status).toBe("missing");
        const direct = resolveNetwork({}, { AITP_SYSTEM_CA: "0" });
        if (!direct.ok) throw new Error(direct.message);
        expect(networkLine(direct.settings, { nodeVersion: "v24.19.0" }).title).toBe("Network: connects directly, no proxy set; trusts Node.js's own certificates");
    });

    it("the platform: reached, unreachable, an untrusted company certificate, a proxy that wants a password, a filter, a redirect, a server error", () => {
        expect(platformLine("tests.example.com", { reached: true, status: 200, https: true })).toMatchObject({ status: "ok", title: "The platform at tests.example.com answers, and its certificate is trusted" });
        const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6939"), { code: "ECONNREFUSED", address: "127.0.0.1", port: 6939 }) });
        const down = platformLine("127.0.0.1:6939", { reached: false, sentence: problemSentence("Could not reach 127.0.0.1:6939", describeNetworkError(refused, { target: "127.0.0.1:6939" })) });
        expect(down).toMatchObject({ status: "missing", title: "Could not reach 127.0.0.1:6939: the connection was refused (is the platform running, and is the address right?)" });
        const cert = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }) });
        const untrusted = platformLine("platform.test", { reached: false, sentence: problemSentence("Could not reach platform.test", describeNetworkError(cert, { target: "platform.test" })) });
        expect(untrusted.title).toBe("Could not reach platform.test: the platform's certificate was not accepted (SELF_SIGNED_CERT_IN_CHAIN): the connection is signed by a certificate this computer does not trust");
        expect(untrusted.fix).toMatch(/--ca-file/);
        expect(platformLine("h", { reached: true, status: 407, https: true }).title).toMatch(/proxy asks for a user name and password/);
        expect(platformLine("h", { reached: true, status: 403, https: true, html: true }).fix).toMatch(/web filter/);
        expect(platformLine("h", { reached: true, status: 301, https: true, location: "other.example.com" }).title).toBe("h answers with a redirect (HTTP 301 to other.example.com), which the runner does not follow");
        expect(platformLine("h", { reached: true, status: 502, https: true }).status).toBe("missing");
        expect(platformLine("192.168.1.5", { reached: true, status: 200, https: false }).title).toMatch(/plain http/);
    });

    it("the token: accepted, revoked, not checked, an older platform", () => {
        expect(tokenLine({ status: 200, project: "Shop" })).toMatchObject({ status: "ok", title: `The platform accepts this runner's token (project "Shop"); the token is not shown` });
        expect(tokenLine({ status: 404, sentence: "This runner agent token is not valid or was revoked." })).toMatchObject({ status: "missing", title: "The platform does not accept this runner's credential: it was removed, or another computer was set up in its place" });
        // Round 45: a team or project credential is refused with the platform's own sentence, which the line shows.
        expect(tokenLine({ status: 401, sentence: "This runner was set up for a team or a project, and those runners are no longer used. Set up your own runner from Settings in AI Studio." })).toMatchObject({
            status: "missing",
            title: "The platform does not accept this runner: This runner was set up for a team or a project, and those runners are no longer used. Set up your own runner from Settings in AI Studio",
        });
        expect(tokenLine({ skipped: true }).status).toBe("optional");
        expect(tokenLine({ status: 404, sentence: "Route POST:/api/agent/check not found" }).status).toBe("optional");
        expect(tokenLine({ status: 429 }).status).toBe("optional");
    });

    it("disk, clock, phone tools and the Mac lines", () => {
        expect(diskLine(40.25 * GB)).toMatchObject({ status: "ok", title: "40.3 GB free on the disk that holds the runner's folder" });
        expect(diskLine(0.4 * GB)).toMatchObject({ status: "missing", title: "Only 0.4 GB free on the disk that holds the runner's folder: it needs at least 1 GB" });
        expect(diskLine(undefined).status).toBe("optional");
        const now = Date.parse("2026-10-19T10:00:00Z");
        expect(clockLine("Mon, 19 Oct 2026 10:02:00 GMT", now).status).toBe("ok");
        expect(clockLine("Mon, 19 Oct 2026 08:00:00 GMT", now)).toMatchObject({ status: "missing", title: expect.stringContaining("clock is 2 hours ahead of the platform's") });
        expect(clockLine("2026-10-22T10:00:00.000Z", now).title).toContain("3 days behind");
        expect(clockLine(undefined, now).status).toBe("optional");
        expect(phoneLine({ adb: true, policy: "off" }).status).toBe("ok");
        expect(phoneLine({ adb: false, own: "36.0.0", policy: "auto" }).title).toBe("Android phone tools: the runner's own, version 36.0.0");
        expect(phoneLine({ adb: false, policy: "auto" })).toMatchObject({ status: "optional", fix: expect.stringContaining("gets them from Google") });
        expect(phoneLine({ adb: false, policy: "off" }).fix).toMatch(/AITP_PHONE_TOOLS=auto/);
        expect(macChipLine({ arch: "arm64", translated: false, appleChip: true }).status).toBe("ok");
        expect(macChipLine({ arch: "x64", translated: true, appleChip: true })).toMatchObject({ status: "optional", title: "This Node.js is the Intel version, running through Rosetta on an Apple chip" });
        expect(macChipLine({ arch: "x64", translated: false, appleChip: false }).title).toMatch(/^Intel processor/);
        const q = quarantineLine(true, "/Users/maya/Downloads/runner (1)");
        expect(q.status).toBe("optional");
        expect(q.fix).not.toContain("/Users/maya");
        expect(q.notes).toEqual(['In Terminal: xattr -dr com.apple.quarantine "/Users/maya/Downloads/runner (1)"']);
    });

    it("prints like the doctor: status, title, To fix, and a summary", () => {
        const text = formatCheck({ header: "Check this computer.", lines: [nodeLine("v24.19.0", true), diskLine(0.2 * GB), enginesLine([])] });
        expect(text).toContain("ok        Node.js v24.19.0, came with this download\n");
        expect(text).toContain("missing   Only 0.2 GB free");
        expect(text).toContain("          To fix: Free some space");
        expect(text.trimEnd().endsWith("1 thing needs a look. Fix it, then run this check again.")).toBe(true);
        expect(checkSummary([{ status: "ok" }, { status: "optional" }])).toBe("Everything the runner needs is here. 1 optional thing is not set up; it only matters for those kinds of tests.");
        expect(maskSecrets(`a ${TOKEN} b http://u:${PASSWORD}@h:1`, [TOKEN])).toBe("a *** b http://u:***@h:1");
    });
});

describe("the whole check on a fake download folder", () => {
    it("everything there: ok lines, the token checked only at the platform the download names, never printed, exit 0", async () => {
        const kit = fakeKit("all-ok", { tools: true });
        const f = fakeFetch();
        let out = "";
        const code = await runCheckProgram({ argv: ["--check"], env: env(), kitDir: kit, out: (t) => (out += t), deps: deps({ fetchImpl: f.fetchImpl }) });
        expect(out).toContain('Check this computer for the AI Testing Platform runner "Office PC" (platform tests.example.com).');
        for (const l of ["ok        Settings: platform tests.example.com, runner name \"Office PC\", token read from runner.token (not shown)", "ok        Runner files match this download", "ok        Test tools are installed (Playwright 1.63.0)", "ok        The platform at tests.example.com answers, and its certificate is trusted", 'ok        The platform accepts this runner\'s token (project "Shop")', "ok        The clock agrees", "optional  Android phone tools are not on this computer yet"]) expect(out).toContain(l);
        expect(out).not.toContain(TOKEN);
        expect(code).toBe(0);
        // Only the platform named in runner.json was asked, and the token went only to the token check.
        expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://tests.example.com/api/health", "POST https://tests.example.com/api/agent/check"]);
        expect(f.calls[0]!.auth).toBeUndefined();
        expect(f.calls[1]!.auth).toBe(`Bearer ${TOKEN}`);
    });

    it("a revoked token, a damaged file and the test tools missing: each says what to do, exit 1", async () => {
        const kit = fakeKit("revoked", { damage: true });
        let out = "";
        const code = await runCheckProgram({ argv: [], env: env(), kitDir: kit, out: (t) => (out += t), deps: deps({ fetchImpl: fakeFetch({ tokenOk: false }).fetchImpl }) });
        expect(code).toBe(1);
        expect(out).toContain("missing   The platform does not accept this runner's credential");
        expect(out).toContain("missing   Runner files do not match this download");
        expect(out).toContain("missing   The test tools are not installed");
        expect(out).toMatch(/3 things need a look\. Fix them, then run this check again\.\n$/);
        expect(out).not.toContain(TOKEN);
    });

    it("the platform unreachable through a proxy with a password: the proxy is named with ***, the password and token are nowhere, the token is not checked", async () => {
        const kit = fakeKit("proxy");
        const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:6949`), { code: "ECONNREFUSED", address: "127.0.0.1", port: 6949 }) });
        const f = fakeFetch({ down: refused });
        let out = "";
        const code = await runCheckProgram({ argv: [], env: env({ HTTPS_PROXY: `http://maya:${PASSWORD}@127.0.0.1:6949` }), kitDir: kit, out: (t) => (out += t), deps: deps({ fetchImpl: f.fetchImpl }) });
        expect(code).toBe(1);
        expect(out).toContain("ok        Network: connects through the proxy http://maya:***@127.0.0.1:6949, from HTTPS_PROXY / HTTP_PROXY;");
        expect(out).toContain("missing   Could not reach tests.example.com: the proxy http://maya:***@127.0.0.1:6949 could not be reached (the connection was refused)");
        expect(out).toContain("optional  The token was not checked, because the platform could not be reached");
        expect(out).not.toContain(PASSWORD);
        expect(out).not.toContain(TOKEN);
        expect(f.calls).toHaveLength(1);
    });

    it("a clock 3 hours off and a full disk are required fixes; a broken runner.json is a line, not a crash", async () => {
        const kit = fakeKit("clock", { tools: true });
        let out = "";
        const code = await runCheckProgram({ argv: [], env: env(), kitDir: kit, out: (t) => (out += t), deps: deps({ fetchImpl: fakeFetch({ date: "Mon, 19 Oct 2026 07:00:00 GMT" }).fetchImpl, freeBytes: () => 0.3 * GB }) });
        expect(code).toBe(1);
        expect(out).toContain("missing   This computer's clock is 3 hours ahead of the platform's");
        expect(out).toContain("missing   Only 0.3 GB free");
        const broken = fakeKit("broken");
        fs.writeFileSync(path.join(broken, "runner.json"), "{ not json");
        out = "";
        expect(await runCheckProgram({ argv: [], env: env(), kitDir: broken, out: (t) => (out += t), deps: deps({ fetchImpl: fakeFetch().fetchImpl }) })).toBe(1);
        expect(out).toContain("missing   The runner's settings (runner.json) cannot be used");
        expect(out).toContain("To fix: runner.json is not valid. Download the runner kit again from the platform.");
    });

    it("a fake Mac on Rosetta with the quarantine flag on its folder, using the Node.js that came with the download", async () => {
        const kit = fakeKit("mac", { tools: true, complete: true });
        const asked: string[] = [];
        const exec = async (file: string, args: string[]) => {
            asked.push([file, ...args].join(" "));
            if (args.includes("sysctl.proc_translated")) return "1\n";
            if (args.includes("hw.optional.arm64")) return "1\n";
            if (file === "/usr/bin/xattr" && args[2] === kit) return "0083;6512a1b2;Safari;\n";
            return undefined;
        };
        const r = await checkComputer({ argv: [], env: env(), kitDir: kit, deps: deps({ platform: "darwin", execPath: path.join(kit, "node", "bin", "node"), exec, fetchImpl: fakeFetch().fetchImpl }) });
        const by = (id: string) => r.lines.find((l) => l.id === id)!;
        expect(by("node").title).toBe("Node.js v24.19.0, came with this download");
        expect(by("tools").title).toContain("came with this download");
        expect(by("mac-chip")).toMatchObject({ status: "optional", title: "This Node.js is the Intel version, running through Rosetta on an Apple chip" });
        expect(by("mac-quarantine").status).toBe("optional");
        expect(by("mac-quarantine").notes![0]).toContain(kit);
        // It only reads: sysctl and xattr -p, by their full paths.
        expect(asked.every((a) => /^\/usr\/sbin\/sysctl -n |^\/usr\/bin\/xattr -p com\.apple\.quarantine /.test(a))).toBe(true);
    });

    it("an explicit browser the computer does not have is missing; no runner.json means the settings come from the command line", async () => {
        let out = "";
        const code = await runCheckProgram({ argv: ["--url", "https://tests.example.com", "--browser", "msedge"], env: env({ AITP_AGENT_TOKEN: TOKEN }), kitDir: path.join(tmp, "no-kit-here"), out: (t) => (out += t), deps: deps({ fetchImpl: fakeFetch().fetchImpl }) });
        expect(code).toBe(1);
        expect(out).toContain("missing   Microsoft Edge is not installed on this computer");
        expect(out).toContain("Note: Not started from a download");
        expect(out).toContain("token from AITP_AGENT_TOKEN (not shown)");
        expect(out).not.toMatch(/Runner files|Test tools/);
        out = "";
        expect(await runCheckProgram({ argv: [], env: env(), kitDir: path.join(tmp, "no-kit-here"), out: (t) => (out += t), deps: deps() })).toBe(1);
        expect(out).toContain("missing   The runner's settings are not complete");
    });
});

describe("the report a running runner sends with its hello", () => {
    beforeEach(() => resetRunnerCheck());
    const caps = (extra: Partial<Capabilities> = {}): Capabilities => ({ os: "win32", arch: "x64", node: "v24.19.0", browsers: ["chromium"], ...extra });

    it("is absent until the runner made its start-up check", () => {
        expect(runnerCheckReport(caps())).toBeUndefined();
    });

    it("holds the start-up lines, the browser, network and phone lines from the capabilities and the clock from the hello, fits the protocol and names no path", async () => {
        const kit = fakeKit("report", { tools: true });
        const kitVersion = JSON.parse(fs.readFileSync(path.join(kit, "runner.json"), "utf8")).kitVersion as string;
        await startRunnerCheck({ workDir: path.join(kit, "work"), kitVersion }, deps({ freeBytes: () => 0.5 * GB }), kit);
        noteServerTime(new Date(Date.now() - 4 * 3_600_000).toISOString());
        const r = runnerCheckReport(caps({ browser: { name: "msedge", version: "155.0.1", source: "installed" }, network: { proxy: "proxy.corp.test:8080", proxySource: "windows", certificates: ["system"] }, phoneTools: { state: "can-fetch" } }))!;
        expect(RunnerCheck.safeParse(r).success).toBe(true);
        expect(r.items.map((i) => i.id)).toEqual(["node", "files", "tools", "browser", "engines", "network", "disk", "clock", "phone"]);
        const by = (id: string) => r.items.find((i) => i.id === id)!;
        expect(by("browser").title).toBe("Web tests use Microsoft Edge 155, installed on this computer");
        expect(by("network").title).toBe("Network: connects through the proxy proxy.corp.test:8080, from the Windows proxy setting; trusts Node.js's own certificates, this computer's certificate store");
        expect(by("disk").status).toBe("missing");
        expect(by("clock")).toMatchObject({ status: "missing", title: expect.stringContaining("4 hours ahead") });
        expect(by("phone").status).toBe("optional");
        expect(JSON.stringify(r)).not.toContain(tmp);
        expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it("a runner with no browser ready says so; one downloading it is fine", async () => {
        await startRunnerCheck({ workDir: tmp }, deps(), path.join(tmp, "not-a-kit"));
        const none = runnerCheckReport(caps({ browsers: [], browserNote: "Chromium could not be downloaded (server returned code 407)." }))!;
        expect(none.items.find((i) => i.id === "browser")).toMatchObject({ status: "missing", title: "Chromium could not be downloaded (server returned code 407)" });
        const busy = runnerCheckReport(caps({ browsers: [], browserNote: "The runner is downloading Chromium for web tests." }))!;
        expect(busy.items.find((i) => i.id === "browser")!.status).toBe("ok");
        expect(none.items.map((i) => i.id)).not.toContain("files");
    });
});

describe("check-computer in every download", () => {
    const bundle: Extract<Bundle, { ok: true }> = {
        ok: true,
        manifest: { format: 1, platformVersion: "0.1.0", hash: "0".repeat(64), kitVersion: "0.1.0+0000000000", nodeMin: 24, files: [] },
        files: new Map(["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"].map((n) => [n, Buffer.from(`// ${n}\n`)])),
    };
    /** Unix modes from the zip's central directory. */
    function modes(zip: Uint8Array): Record<string, number> {
        const b = Buffer.from(zip);
        const out: Record<string, number> = {};
        // The central directory starts where the end record says (offset at byte 16 of the last 22 bytes; no zip comment here).
        let p = b.readUInt32LE(b.length - 22 + 16);
        while (p >= 0 && b.readUInt32LE(p) === 0x02014b50) {
            const nameLen = b.readUInt16LE(p + 28);
            const extra = b.readUInt16LE(p + 30);
            const comment = b.readUInt16LE(p + 32);
            out[b.subarray(p + 46, p + 46 + nameLen).toString("utf8")] = (b.readUInt32LE(p + 38) >>> 16) & 0o777;
            p += 46 + nameLen + extra + comment;
        }
        return out;
    }

    it("the plain files and the installer zips hold check-computer.cmd (CRLF), .sh and .command (LF), all executable, and the READMEs say when to use them", () => {
        const kit = buildKitZip({ bundle, request: { name: "Office PC", platform: "windows" }, projectName: "Shop", projectSlug: "shop", platformUrl: "https://tests.example.com", token: TOKEN });
        const inst = buildInstallerZip({ bundle, part: { ok: true, files: [{ name: "AITestingRunnerSetup.exe", mode: 0o755, data: Buffer.from("MZ") }] }, platform: "windows", runnerName: "Office PC", projectName: "Shop", projectSlug: "shop", platformUrl: "https://tests.example.com", token: TOKEN });
        for (const [zip, dir] of [[kit, "runner-shop-windows"], [inst, "runner-shop-windows-setup"]] as const) {
            const z = unzipSync(zip);
            const m = modes(zip);
            const text = (n: string) => Buffer.from(z[`${dir}/${n}`]!).toString("utf8");
            expect(text("check-computer.cmd")).toContain("\r\n");
            expect(text("check-computer.cmd").replace(/\r\n/g, "")).not.toContain("\n");
            expect(text("check-computer.sh")).not.toContain("\r");
            expect(text("check-computer.command")).not.toContain("\r");
            for (const n of ["check-computer.cmd", "check-computer.sh", "check-computer.command"]) expect(m[`${dir}/${n}`], n).toBe(0o755);
            expect(text("README.txt")).toContain("check-computer.cmd");
            // No name, address or token in the scripts: the runner reads them from its own files.
            for (const n of ["check-computer.cmd", "check-computer.sh", "check-computer.command"]) for (const s of [TOKEN, "Office PC", "tests.example.com"]) expect(text(n), n).not.toContain(s);
        }
    });

    it("the scripts hand over to the start script in check mode, which runs runner.mjs --check and offers no installation", () => {
        expect(CHECK_FILES.map((f) => f.name)).toEqual(["check-computer.cmd", "check-computer.sh", "check-computer.command"]);
        expect(/^[\x00-\x7f]*$/.test(CHECK_CMD)).toBe(true);
        expect(CHECK_CMD).toContain('set "AITP_KIT_CHECK=1"');
        expect(CHECK_CMD).toContain("call .\\start-runner.cmd");
        expect(CHECK_SH).toContain("exec sh ./start-runner.sh");
        expect(CHECK_COMMAND).toContain("check-computer.sh");
        expect(START_CMD).toContain('if "%AITP_KIT_CHECK%"=="1" goto check\n');
        expect(START_CMD).toContain('if "%AITP_KIT_CHECK%"=="1" goto checknonode');
        expect(START_CMD).toContain("call node runner.mjs --check");
        expect(START_SH).toContain("node runner.mjs --check");
        // In check mode the check reports the quarantine flag instead of clearing it.
        expect(START_SH).toContain('if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && [ "$AITP_KIT_CHECK" != "1" ]; then');
    });

    const BASH = ["C:\\Program Files\\Git\\usr\\bin\\bash.exe", "/bin/bash", "/usr/bin/bash"].find((p) => fs.existsSync(p));
    it.skipIf(!BASH)("check-computer.sh is valid POSIX sh, and in an installer download without a set-up runner it says to run the installer first", () => {
        const dir = path.join(tmp, "sh");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "check-computer.sh"), CHECK_SH);
        for (const args of [["-n"], ["--posix", "-n"]]) expect(spawnSync(BASH!, [...args, "check-computer.sh"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
        const r = spawnSync(BASH!, ["check-computer.sh"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: path.join(tmp, "empty-home"), AITP_KIT_NO_PAUSE: "1" } });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("missing   The runner is not set up on this computer yet.");
    });
});

describe("the phone tools start outside the runner's folder", () => {
    // adb leaves its server running in the folder it was started from; on Windows that folder then cannot be deleted, which kept the
    // uninstall from removing the runner's folder (GitHub's Windows machines have adb, so their uninstall check found it).
    it("probe commands run in the temp folder, whatever folder the runner itself is in", async () => {
        const tool = path.join(tmp, "print-cwd.mjs");
        fs.writeFileSync(tool, "process.stdout.write(process.cwd());\n");
        const out = await execText(process.execPath, [tool], 10_000);
        expect(out && fs.realpathSync(out)).toBe(fs.realpathSync(os.tmpdir()));
        expect(toolCwd()).toBe(os.tmpdir());
    });

    it("every place that starts adb or the emulator passes that folder", () => {
        const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "..", f), "utf8");
        expect(src("src/engine/mobile/device/adb.ts").match(/\.\.\.\(cwd \? \{ cwd \} : \{\}\)/g)?.length).toBe(2);
        expect(src("src/engine/mobile/emulator.ts").match(/\.\.\.\(cwd \? \{ cwd \} : \{\}\)/g)?.length).toBe(2);
        expect(src("src/agent/computer-check.ts")).toMatch(/const cwd = toolCwd\(\);\s+execFile\(/);
    });
});
