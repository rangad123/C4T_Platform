/**
 * Google's Android phone tools (platform-tools) fetched by the runner itself (src/engine/mobile/platform-tools.ts, src/agent/phone-tools.ts):
 * Google's repository list read and checked, the archive's size and SHA-1, what is unpacked and where, the runner's setting, its report and its
 * retry limit, the phone-session rule, runner.json. Against a LOCAL stand-in for dl.google.com (plain http on 127.0.0.1); the real address is
 * only checked as a string, never fetched. Port 6990.
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/phone-tools-unit.test.ts
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CapabilityProbe, describeCapabilities } from "../src/agent/capabilities.js";
import { applyKitDefaults, parseKitFile } from "../src/agent/kit.js";
import { memoryLogger } from "../src/agent/log.js";
import { PhoneToolsSetup, phoneToolsPolicy, PHONE_TOOLS_RETRY } from "../src/agent/phone-tools.js";
import { Capabilities } from "../src/agent-protocol/schema.js";
import { deviceSessionProblem } from "../src/engine/mobile/device/capability.js";
import { chooseArchive, fetchPlatformTools, GOOGLE_REPOSITORY, installedPhoneTools, parseRepositoryManifest, PHONE_TOOLS_MARKER, phoneToolsHost, PhoneToolsError, repositoryBase, REPOSITORY_MANIFEST, USB_DEBUGGING_STEPS } from "../src/engine/mobile/platform-tools.js";
import { adbPath } from "../src/engine/mobile/toolchain.js";

const PORT = 6990; // not 6910: runner-complete-kit-unit uses that one, and the fast tier runs both at once
const REPO = `http://127.0.0.1:${PORT}/android/repository/`;
/** The runner setting tests fetch for this computer itself: adbPath looks for adb.exe only on Windows, so a pretend "win32" fetch elsewhere
 * unpacks an adb.exe that is never found. */
const HOST = process.platform;
const HOST_ADB = HOST === "win32" ? "adb.exe" : "adb";

/** A small stand-in for Google's platform-tools archive for one system. */
function archive(hostOs: "windows" | "macosx" | "linux", extra: Record<string, Uint8Array> = {}, drop: string[] = []): Buffer {
    const adb = hostOs === "windows" ? "adb.exe" : "adb";
    const files: Record<string, Uint8Array> = {
        [`platform-tools/${adb}`]: Buffer.from(`fake adb for ${hostOs}`),
        [`platform-tools/${hostOs === "windows" ? "fastboot.exe" : "fastboot"}`]: Buffer.from("fake fastboot"),
        "platform-tools/NOTICE.txt": Buffer.from("Android SDK license terms (stand-in)"),
        "platform-tools/source.properties": Buffer.from("Pkg.Revision=35.0.2\n"),
        "platform-tools/lib64/libc++.so": Buffer.from("not a real library"),
        ...extra,
    };
    for (const d of drop) delete files[d];
    return Buffer.from(zipSync(files));
}
const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");

interface Served {
    list: string;
    files: Map<string, Buffer>;
    status?: number;
}
let served: Served = { list: "", files: new Map() };
let requests: string[] = [];
let server: http.Server;
let tmp: string;
let n = 0;

/** Google's list (repository2-3 layout) offering `entries`; `size`/`sum` override what the list says about an archive. */
function manifest(entries: Array<{ version: [number, number, number]; channel?: string; obsolete?: boolean; archives: Array<{ hostOs: string; file: string; size: number; sha1: string; type?: string }> }>): string {
    const pkgs = entries
        .map(
            (e) => `<remotePackage path="platform-tools"${e.obsolete ? ' obsolete="true"' : ""}>
    <type-details xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="generic:genericDetailsType"/>
    <revision><major>${e.version[0]}</major><minor>${e.version[1]}</minor><micro>${e.version[2]}</micro></revision>
    <display-name>Android SDK Platform-Tools</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="${e.channel ?? "channel-0"}"/>
    <archives>${e.archives
        .map((a) => `<archive><complete><size>${a.size}</size><checksum${a.type === undefined ? ' type="sha1"' : a.type ? ` type="${a.type}"` : ""}>${a.sha1}</checksum><url>${a.file}</url></complete><host-os>${a.hostOs}</host-os></archive>`)
        .join("")}</archives>
</remotePackage>`,
        )
        .join("\n");
    return `<?xml version="1.0" ?><sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
<license id="android-sdk-license" type="text">Terms and Conditions (stand-in)</license>
<channel id="channel-0">stable</channel><channel id="channel-1">beta</channel><channel id="channel-2">dev</channel>
<remotePackage path="build-tools;35.0.0"><revision><major>35</major></revision><channelRef ref="channel-0"/><archives><archive><complete><size>10</size><checksum type="sha1">${"a".repeat(40)}</checksum><url>build-tools.zip</url></complete><host-os>windows</host-os></archive></archives></remotePackage>
${pkgs}
</sdk:sdk-repository>`;
}

/** Serve platform-tools 35.0.2 for all three systems (plus an older 34 and a newer beta that must not be chosen). */
function serveStandard(over: { windows?: Buffer; listSize?: number; listSha1?: string } = {}): { win: Buffer; mac: Buffer; linux: Buffer } {
    const win = over.windows ?? archive("windows");
    const mac = archive("macosx");
    const linux = archive("linux");
    served = {
        list: manifest([
            { version: [34, 0, 5], archives: [{ hostOs: "windows", file: "platform-tools_r34.0.5-windows.zip", size: 1, sha1: "b".repeat(40) }] },
            { version: [36, 0, 0], channel: "channel-1", archives: [{ hostOs: "windows", file: "platform-tools_r36.0.0-windows.zip", size: 1, sha1: "c".repeat(40) }] },
            {
                version: [35, 0, 2],
                archives: [
                    { hostOs: "windows", file: "platform-tools_r35.0.2-win.zip", size: over.listSize ?? win.length, sha1: over.listSha1 ?? sha1(win) },
                    { hostOs: "macosx", file: "platform-tools_r35.0.2-darwin.zip", size: mac.length, sha1: sha1(mac) },
                    { hostOs: "linux", file: "platform-tools_r35.0.2-linux.zip", size: linux.length, sha1: sha1(linux) },
                ],
            },
        ]),
        files: new Map([
            ["platform-tools_r35.0.2-win.zip", win],
            ["platform-tools_r35.0.2-darwin.zip", mac],
            ["platform-tools_r35.0.2-linux.zip", linux],
        ]),
    };
    return { win, mac, linux };
}

const fresh = () => fs.mkdtempSync(path.join(tmp, `case-${++n}-`));
const env = (o: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ AITP_PHONE_TOOLS_REPO: REPO, ANDROID_HOME: "", TAQWRIGHT_HOME: path.join(tmp, "no-taqwright"), ANDROID_AVD_HOME: path.join(tmp, "no-avds"), ...o });

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phone-tools-"));
    server = http.createServer((req, res) => {
        requests.push(req.url ?? "");
        const name = (req.url ?? "").replace(/^\/android\/repository\//, "");
        if (served.status) return void res.writeHead(served.status).end("no");
        if (name === REPOSITORY_MANIFEST) return void res.writeHead(200, { "content-type": "application/xml" }).end(served.list);
        const f = served.files.get(name);
        if (!f) return void res.writeHead(404).end("not found");
        res.writeHead(200, { "content-type": "application/zip", "content-length": String(f.length) }).end(f);
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
});
beforeEach(() => {
    requests = [];
    served = { list: "", files: new Map() };
});
afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Google's list", () => {
    it("takes the newest stable platform-tools for each system, with its size and SHA-1, and nothing else", () => {
        serveStandard();
        const list = parseRepositoryManifest(served.list, `${REPO}${REPOSITORY_MANIFEST}`);
        expect(list.map((a) => `${a.version} ${a.hostOs}`).sort()).toEqual(["34.0.5 windows", "35.0.2 linux", "35.0.2 macosx", "35.0.2 windows"]);
        const win = chooseArchive(list, "windows")!;
        expect(win).toMatchObject({ version: "35.0.2", url: `${REPO}platform-tools_r35.0.2-win.zip`, size: served.files.get("platform-tools_r35.0.2-win.zip")!.length });
        expect(win.sha1).toMatch(/^[0-9a-f]{40}$/);
        expect(chooseArchive(list, "macosx")!.url).toContain("darwin");
    });

    it("skips obsolete, preview, odd checksums, archives elsewhere and broken entries", () => {
        const list = parseRepositoryManifest(
            manifest([
                { version: [40, 0, 0], obsolete: true, archives: [{ hostOs: "windows", file: "a.zip", size: 5, sha1: "a".repeat(40) }] },
                {
                    version: [35, 0, 2],
                    archives: [
                        { hostOs: "windows", file: "https://evil.example.test/platform-tools.zip", size: 5, sha1: "a".repeat(40) },
                        { hostOs: "windows", file: "sha256.zip", size: 5, sha1: "a".repeat(64), type: "sha-256" },
                        { hostOs: "windows", file: "short.zip", size: 5, sha1: "abc" },
                        { hostOs: "windows", file: "notzip.exe", size: 5, sha1: "a".repeat(40) },
                        { hostOs: "windows", file: "huge.zip", size: 500 * 1024 * 1024, sha1: "a".repeat(40) },
                        { hostOs: "solaris", file: "sol.zip", size: 5, sha1: "a".repeat(40) },
                        { hostOs: "linux", file: "old-style.zip", size: 5, sha1: "D".repeat(40), type: "" },
                    ],
                },
            ]).replace('type=""', ""),
            `${REPO}${REPOSITORY_MANIFEST}`,
        );
        expect(list).toEqual([{ version: "35.0.2", hostOs: "linux", url: `${REPO}old-style.zip`, size: 5, sha1: "d".repeat(40) }]);
        expect(parseRepositoryManifest("<not xml", REPO)).toEqual([]);
        expect(parseRepositoryManifest(manifest([{ version: [35, 0, 2], channel: "channel-2", archives: [{ hostOs: "linux", file: "x.zip", size: 5, sha1: "a".repeat(40) }] }]), REPO)).toEqual([]);
    });

    it("knows which download fits which computer, and says plainly when Google has none", () => {
        expect(phoneToolsHost("win32", "x64")).toEqual({ ok: true, hostOs: "windows" });
        expect(phoneToolsHost("win32", "arm64")).toMatchObject({ ok: true, hostOs: "windows", note: expect.stringContaining("emulation") });
        expect(phoneToolsHost("darwin", "arm64")).toEqual({ ok: true, hostOs: "macosx" });
        expect(phoneToolsHost("linux", "x64")).toEqual({ ok: true, hostOs: "linux" });
        expect(phoneToolsHost("linux", "arm64")).toMatchObject({ ok: false, reason: expect.stringContaining("sudo apt install adb") });
    });

    it("reads from Google over https unless told otherwise; plain http only on this computer, never with a password", () => {
        expect(GOOGLE_REPOSITORY).toBe("https://dl.google.com/android/repository/");
        expect(repositoryBase({})).toEqual({ ok: true, url: GOOGLE_REPOSITORY });
        expect(repositoryBase({ AITP_PHONE_TOOLS_REPO: "https://mirror.example.test/android" })).toEqual({ ok: true, url: "https://mirror.example.test/android/" });
        expect(repositoryBase({ AITP_PHONE_TOOLS_REPO: REPO })).toEqual({ ok: true, url: REPO });
        expect(repositoryBase({ AITP_PHONE_TOOLS_REPO: "http://mirror.example.test/" })).toMatchObject({ ok: false, reason: expect.stringContaining("https only") });
        expect(repositoryBase({ AITP_PHONE_TOOLS_REPO: "https://u:p@mirror.example.test/" })).toMatchObject({ ok: false });
        expect(repositoryBase({ AITP_PHONE_TOOLS_REPO: "not a url" })).toMatchObject({ ok: false });
    });
});

describe("fetching, checking and unpacking", { timeout: 60_000 }, () => {
    it("downloads the archive for this system, checks size and SHA-1, unpacks only platform-tools into the given folder and records the version", async () => {
        serveStandard();
        const dir = fresh();
        const lines: string[] = [];
        const got = await fetchPlatformTools({ dir, platform: "win32", arch: "x64", env: env(), onLine: (l) => lines.push(l) });
        expect(got).toEqual({ home: dir, adb: path.join(dir, "platform-tools", "adb.exe"), version: "35.0.2" });
        expect(fs.readFileSync(got.adb, "utf8")).toBe("fake adb for windows");
        expect(fs.existsSync(path.join(dir, "platform-tools", "lib64", "libc++.so"))).toBe(true);
        expect(fs.readdirSync(dir)).toEqual(["platform-tools"]);
        const marker = JSON.parse(fs.readFileSync(path.join(dir, "platform-tools", PHONE_TOOLS_MARKER), "utf8"));
        expect(marker).toMatchObject({ version: "35.0.2", hostOs: "windows", url: `${REPO}platform-tools_r35.0.2-win.zip`, sha1: sha1(served.files.get("platform-tools_r35.0.2-win.zip")!) });
        expect(requests).toEqual([`/android/repository/${REPOSITORY_MANIFEST}`, "/android/repository/platform-tools_r35.0.2-win.zip"]);
        expect(lines.join("\n")).toMatch(/Downloading the Android phone tools 35\.0\.2[\s\S]*Checked the download against Google's size and checksum[\s\S]*are ready/);
        expect(installedPhoneTools(dir, "win32")).toEqual(got);
        // a Mac gets the Mac archive, and its programs are made runnable
        const mac = fresh();
        const m = await fetchPlatformTools({ dir: mac, platform: "darwin", arch: "arm64", env: env() });
        expect(path.basename(m.adb)).toBe("adb");
        if (process.platform !== "win32") expect(fs.statSync(m.adb).mode & 0o111).not.toBe(0);
        expect(requests.at(-1)).toBe("/android/repository/platform-tools_r35.0.2-darwin.zip");
    });

    it("refuses a download whose size or checksum differs from Google's list, and keeps the tools that were there", async () => {
        serveStandard();
        const dir = fresh();
        await fetchPlatformTools({ dir, platform: "win32", env: env() });
        const before = fs.readFileSync(path.join(dir, "platform-tools", PHONE_TOOLS_MARKER), "utf8");

        const other = archive("windows", { "platform-tools/adb.exe": Buffer.from("tampered") });
        serveStandard({ windows: other, listSha1: sha1(archive("windows", { "platform-tools/extra.txt": Buffer.from("x") })) });
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env() })).rejects.toThrow(/do not match Google's checksum \(SHA-1\)\. Nothing was kept/);

        serveStandard({ listSize: archive("windows").length + 100 });
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env() })).rejects.toThrow(/bytes, but Google lists/);

        // a server that sends more than the list says is cut off
        serveStandard({ listSize: 50 });
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env() })).rejects.toThrow(/larger than expected/);

        expect(fs.readFileSync(path.join(dir, "platform-tools", PHONE_TOOLS_MARKER), "utf8")).toBe(before);
        expect(fs.readFileSync(path.join(dir, "platform-tools", "adb.exe"), "utf8")).toBe("fake adb for windows");
        expect(fs.readdirSync(dir)).toEqual(["platform-tools"]);
    });

    it("refuses an archive with files outside its folder or without adb", async () => {
        const evil = archive("windows", { "platform-tools/../escaped.txt": Buffer.from("x") });
        serveStandard({ windows: evil });
        const dir = fresh();
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env() })).rejects.toThrow(/outside its own folder/);
        expect(fs.existsSync(path.join(dir, "escaped.txt"))).toBe(false);
        expect(fs.existsSync(path.join(path.dirname(dir), "escaped.txt"))).toBe(false);

        serveStandard({ windows: archive("windows", {}, ["platform-tools/adb.exe"]) });
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env() })).rejects.toThrow(/no adb for this system/);
        expect(installedPhoneTools(dir, "win32")).toBeUndefined();
    });

    it("says in words when Google cannot be reached, answers with an error, has nothing for the system, or the address is not allowed", async () => {
        const dir = fresh();
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env({ AITP_PHONE_TOOLS_REPO: "http://127.0.0.1:6999/" }) })).rejects.toThrow(/could not be reached \(127\.0\.0\.1:6999\)\. Check this computer's internet connection or proxy/);
        served = { list: "", files: new Map(), status: 503 };
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env() })).rejects.toThrow(/answered with an error \(503\)/);
        served = { list: manifest([]), files: new Map() };
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env() })).rejects.toThrow(/no phone tools for this system/);
        requests = [];
        await expect(fetchPlatformTools({ dir, platform: "linux", arch: "arm64", env: env() })).rejects.toBeInstanceOf(PhoneToolsError);
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env({ AITP_PHONE_TOOLS_REPO: "http://mirror.example.test/" }) })).rejects.toThrow(/https only/);
        expect(requests).toEqual([]);
        const stop = new AbortController();
        stop.abort();
        serveStandard();
        await expect(fetchPlatformTools({ dir, platform: "win32", env: env(), signal: stop.signal })).rejects.toThrow(/was stopped/);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});

describe("the runner's setting, report and retries", { timeout: 60_000 }, () => {
    it("a downloaded runner fetches when a phone session needs it; a checkout does not unless asked", () => {
        expect(phoneToolsPolicy({}, true)).toBe("auto");
        expect(phoneToolsPolicy({}, false)).toBe("off");
        expect(phoneToolsPolicy({ AITP_PHONE_TOOLS: "NOW" }, false)).toBe("now");
        expect(phoneToolsPolicy({ AITP_PHONE_TOOLS: "off" }, true)).toBe("off");
        expect(phoneToolsPolicy({ AITP_PHONE_TOOLS: "sometimes" }, true)).toBe("auto");
    });

    it("off: says nothing and fetches nothing", async () => {
        const { log } = memoryLogger();
        const e = env();
        const s = new PhoneToolsSetup({ policy: "off", env: e, log, workDir: fresh(), platform: "win32" });
        s.prepare();
        expect(s.report()).toBeUndefined();
        expect(await s.ensure(() => undefined)).toMatchObject({ ok: false, reason: expect.stringContaining("AITP_PHONE_TOOLS=off") });
        expect(requests).toEqual([]);
    });

    it("auto: offers, fetches once for callers at the same time, then uses its own adb through ANDROID_HOME, also after a restart", async () => {
        serveStandard();
        const { log } = memoryLogger();
        const workDir = fresh();
        const e = env();
        let changes = 0;
        const s = new PhoneToolsSetup({ policy: "auto", env: e, log, workDir, platform: HOST, arch: "x64", onChange: () => changes++ });
        s.prepare();
        expect(requests).toEqual([]);
        expect(s.report()).toEqual({ state: "can-fetch", note: "The runner gets the Android phone tools from Google when a phone session arrives." });
        const notes: string[] = [];
        const [a, b] = await Promise.all([s.ensure((l) => notes.push(l)), s.ensure(() => undefined)]);
        expect(a).toEqual({ ok: true });
        expect(b).toEqual({ ok: true });
        expect(requests.filter((r) => r.endsWith(".zip"))).toHaveLength(1);
        expect(changes).toBeGreaterThanOrEqual(2);
        expect(e.ANDROID_HOME).toBe(path.join(workDir, "phone-tools"));
        expect(adbPath(e)).toBe(path.join(workDir, "phone-tools", "platform-tools", HOST_ADB));
        expect(s.report()).toEqual({ state: "ready", version: "35.0.2" });
        expect(notes[0]).toMatch(/This computer has no Android phone tools \(adb\)\. The runner gets them from Google .*license/);
        expect(notes.filter((l) => l.startsWith("To use a phone on USB"))).toHaveLength(USB_DEBUGGING_STEPS.length);
        expect(notes.join("\n")).toContain("USB debugging");
        // already there: nothing more
        expect(await s.ensure(() => undefined)).toEqual({ ok: true });

        // a restart of the runner uses the tools from its folder at once
        requests = [];
        const e2 = env();
        const s2 = new PhoneToolsSetup({ policy: "auto", env: e2, log, workDir, platform: HOST, arch: "x64" });
        s2.prepare();
        expect(e2.ANDROID_HOME).toBe(path.join(workDir, "phone-tools"));
        expect(s2.report()).toEqual({ state: "ready", version: "35.0.2" });
        expect(requests).toEqual([]);
    });

    it("another adb on the computer wins: the runner's own tools are not fetched or reported", async () => {
        serveStandard();
        const { log } = memoryLogger();
        const e = env({ AITP_ADB_PATH: path.resolve("tests/fixtures/fake-adb.mjs") });
        const s = new PhoneToolsSetup({ policy: "now", env: e, log, workDir: fresh(), platform: "win32" });
        s.prepare();
        expect(s.report()).toBeUndefined();
        expect(await s.ensure(() => undefined)).toEqual({ ok: true });
        expect(requests).toEqual([]);
        expect(e.ANDROID_HOME).toBe("");
    });

    it("now: fetches at start in the background", async () => {
        serveStandard();
        const { log, lines } = memoryLogger();
        const e = env();
        const s = new PhoneToolsSetup({ policy: "now", env: e, log, workDir: fresh(), platform: HOST, arch: "x64" });
        s.prepare();
        expect(s.report()?.state).toBe("fetching");
        for (let i = 0; i < 100 && s.report()?.state !== "ready"; i++) await new Promise((r) => setTimeout(r, 50));
        expect(s.report()).toEqual({ state: "ready", version: "35.0.2" });
        expect(lines.join("\n")).toContain("Downloading the Android phone tools 35.0.2");
    });

    it("a failing download is tried again only after a pause and at most 3 times an hour, and the report says why", async () => {
        served = { list: "", files: new Map(), status: 500 };
        const { log } = memoryLogger();
        let now = 1_000_000;
        const s = new PhoneToolsSetup({ policy: "auto", env: env(), log, workDir: fresh(), platform: HOST, arch: "x64", now: () => now });
        expect(await s.ensure(() => undefined)).toMatchObject({ ok: false, reason: expect.stringContaining("answered with an error (500)") });
        expect(s.report()).toMatchObject({ state: "failed", note: expect.stringContaining("(500)") });
        expect(await s.ensure(() => undefined)).toMatchObject({ ok: false, reason: expect.stringContaining("tries again in a few minutes") });
        expect(requests).toHaveLength(1);
        now += PHONE_TOOLS_RETRY.afterFailureMs;
        expect(s.report()?.state).toBe("can-fetch");
        await s.ensure(() => undefined);
        now += PHONE_TOOLS_RETRY.afterFailureMs;
        await s.ensure(() => undefined);
        now += PHONE_TOOLS_RETRY.afterFailureMs;
        expect(requests).toHaveLength(3);
        expect(await s.ensure(() => undefined)).toMatchObject({ ok: false });
        expect(requests).toHaveLength(3);
        now += 60 * 60_000;
        serveStandard();
        expect(await s.ensure(() => undefined)).toEqual({ ok: true });
    });

    it("Linux on ARM is told plainly what to install instead", () => {
        const { log } = memoryLogger();
        const s = new PhoneToolsSetup({ policy: "auto", env: env(), log, workDir: fresh(), platform: "linux", arch: "arm64" });
        expect(s.report()).toMatchObject({ state: "unsupported", note: expect.stringContaining("sudo apt install adb") });
    });
});

describe("what the runner reports, and the phone-session rule", () => {
    it("a runner that can fetch the tools may host a phone session; a failed or unsupported one says why", () => {
        expect(deviceSessionProblem({ phoneTools: { state: "can-fetch" } })).toBeUndefined();
        expect(deviceSessionProblem({ android: { adb: false, devices: [], avds: [] }, phoneTools: { state: "fetching" } })).toBeUndefined();
        expect(deviceSessionProblem({ phoneTools: { state: "failed", note: "The Android phone tools could not be fetched: no network." } })).toBe("The Android phone tools could not be fetched: no network.");
        // without the field nothing changes
        expect(deviceSessionProblem({})).toMatch(/adb \(the Android debug tool\) was not found/);
        // once the tools are there, the usual rule: a phone must be ready
        expect(deviceSessionProblem({ android: { adb: true, devices: [], avds: [] }, phoneTools: { state: "ready", version: "35.0.2" } })).toMatch(/No phone is connected/);
        expect(Capabilities.parse({ os: "win32", arch: "x64", node: "v24", browsers: [], phoneTools: { state: "can-fetch", note: "x" } }).phoneTools).toEqual({ state: "can-fetch", note: "x" });
        expect(Capabilities.safeParse({ os: "win32", arch: "x64", node: "v24", browsers: [], phoneTools: { state: "maybe" } }).success).toBe(false);
    });

    it("the probe reports it, claims the phone session, and says it in the runner's log line", async () => {
        const probe = new CapabilityProbe({ env: env(), platform: "linux", browsers: () => [], exec: async () => undefined, phoneTools: { report: () => ({ state: "can-fetch", note: "The runner gets the Android phone tools from Google when a phone session arrives." }) } });
        const c = await probe.discover();
        expect(c.phoneTools?.state).toBe("can-fetch");
        expect(c.deviceSession).toBe(true);
        expect(c.android).toBeUndefined();
        expect(describeCapabilities(c)).toContain("Android phone tools: The runner gets the Android phone tools from Google when a phone session arrives");
        const none = await new CapabilityProbe({ env: env(), platform: "linux", browsers: () => [], exec: async () => undefined }).discover();
        expect(none.phoneTools).toBeUndefined();
        expect(none.deviceSession).toBeUndefined();
    });

    it("runner.json may set it; the environment wins; an unknown value is refused in words", () => {
        const base = { url: "https://tests.example.test", name: "Maya's laptop", kitVersion: "1.0.0+abc" };
        expect(parseKitFile(JSON.stringify({ ...base, phoneTools: "Now" }))).toMatchObject({ ok: true, file: { phoneTools: "now" } });
        expect(parseKitFile(JSON.stringify({ ...base, phoneTools: "always" }))).toMatchObject({ ok: false, message: expect.stringContaining('"phoneTools"') });
        expect(parseKitFile(JSON.stringify(base))).toEqual({ ok: true, file: base });
        const dir = fresh();
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ ...base, phoneTools: "now" }));
        expect(applyKitDefaults({}, dir)).toMatchObject({ kit: true, env: { AITP_PHONE_TOOLS: "now" } });
        expect(applyKitDefaults({ AITP_PHONE_TOOLS: "off" }, dir)).toMatchObject({ kit: true, env: { AITP_PHONE_TOOLS: "off" } });
    });
});
