/**
 * The runner kit without a browser (fast tier): the prebuilt bundle really is built and checked, the zip a download produces (entries,
 * executable bits, line endings, README, runner.json), the name/system checks, the address decision table, the secrets that must never
 * be inside, the pinned versions, the runner.json handling of the agent itself, and the start scripts' syntax.
 * Builds the bundle with esbuild into a temp folder (a few seconds). No ports.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyKitDefaults, parseKitFile } from "../src/agent/kit.js";
import { parseAgentArgs } from "../src/agent/config.js";
import { CapabilityProbe } from "../src/agent/capabilities.js";
import { filesLine } from "../src/agent/computer-check.js";
import { Capabilities } from "../src/agent-protocol/schema.js";
import { buildKitZip, decideAddress, DownloadRequest, loadBundle, projectSlugOf, type Bundle } from "../src/platform/runner-kit.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner, KIT_DEPENDENCIES, KIT_OPTIONAL } from "../scripts/build-runner.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TOKEN = "aitg_KitUnitTokenSentinel0123456789abcdefgh";
const SENTINELS = { ANTHROPIC_API_KEY: "sk-ant-KITLEAK-9f2c41d7e8a0", API_KEY: "KITLEAK-admin-key-77c3e1", OPENAI_API_KEY: "KITLEAK-openai-5a90bb12", SECRET_BOX_KEY: "KITLEAK-box-key-0d4e6f31" };

let tmp: string;
let bundleDir: string;
let bundle: Extract<Bundle, { ok: true }>;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-kit-unit-"));
    bundleDir = path.join(tmp, "dist-runner");
    // Secrets in the environment while the bundle is built and the zip is made: neither may take them in.
    for (const [k, v] of Object.entries(SENTINELS)) {
        savedEnv[k] = process.env[k];
        process.env[k] = v;
    }
    await buildRunner({ outDir: bundleDir });
    const loaded = loadBundle(bundleDir);
    if (!loaded.ok) throw new Error(loaded.reason);
    bundle = loaded;
}, 120_000);

afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});

const request = (platform: "windows" | "unix", name: string | undefined = "Maya's laptop") => ({ platform, ...(name ? { name } : {}) });
const makeZip = (platform: "windows" | "unix", over: { name?: string; noName?: boolean; projectName?: string; url?: string } = {}) =>
    buildKitZip({ bundle, request: request(platform, over.noName ? undefined : over.name), projectName: over.projectName ?? "Shop Checkout", projectSlug: projectSlugOf(over.projectName ?? "Shop Checkout"), platformUrl: over.url ?? "https://tests.example.com", token: TOKEN });
const entries = (zip: Uint8Array) => unzipSync(zip);
const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

/** Unix permission bits of each entry, read from the zip's central directory (fflate's unzip does not expose them). */
function modes(zip: Uint8Array): Record<string, { mode: number; unix: boolean }> {
    const b = Buffer.from(zip);
    const out: Record<string, { mode: number; unix: boolean }> = {};
    for (let i = 0; i + 46 <= b.length; i++) {
        if (b.readUInt32LE(i) !== 0x02014b50) continue;
        const nameLen = b.readUInt16LE(i + 28);
        const name = b.subarray(i + 46, i + 46 + nameLen).toString("utf8");
        out[name] = { mode: (b.readUInt32LE(i + 38) >>> 16) & 0o7777, unix: (b.readUInt16LE(i + 4) >> 8) === 3 };
        i += 45;
    }
    return out;
}

describe("the prebuilt bundle", () => {
    it("is a manifest plus the files it lists, with checksums that check out", () => {
        // package-lock.json from round 39: the kit installs its test tools with npm ci from it.
        expect(bundle.manifest.files.map((f) => f.name).sort()).toEqual(["LICENSES.txt", "package-lock.json", "package.json", "record-child.mjs", "runner.mjs", "task-child.mjs"]);
        expect(bundle.manifest.kitVersion).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{10}$/);
        expect(bundle.manifest.nodeMin).toBe(24);
    });

    it("is refused when it is missing, edited after the build, or incomplete", () => {
        const none = loadBundle(path.join(tmp, "nothing-here"));
        expect(none).toMatchObject({ ok: false, reason: "The runner kit has not been built on this server. Run `npm run build:runner`." });
        const edited = path.join(tmp, "edited");
        fs.cpSync(bundleDir, edited, { recursive: true });
        fs.appendFileSync(path.join(edited, "runner.mjs"), "\n// tampered\n");
        expect(loadBundle(edited)).toMatchObject({ ok: false, reason: expect.stringContaining("damaged") });
        const partial = path.join(tmp, "partial");
        fs.cpSync(bundleDir, partial, { recursive: true });
        fs.rmSync(path.join(partial, "task-child.mjs"));
        expect(loadBundle(partial)).toMatchObject({ ok: false, reason: expect.stringContaining("damaged") });
        const junk = path.join(tmp, "junk");
        fs.mkdirSync(junk);
        fs.writeFileSync(path.join(junk, "manifest.json"), "{ not json");
        expect(loadBundle(junk)).toMatchObject({ ok: false });
    });

    it("pins the exact versions of the packages this platform has installed", () => {
        const pkg = JSON.parse(text(bundle.files.get("package.json")!)) as { type: string; dependencies: Record<string, string>; optionalDependencies: Record<string, string>; scripts?: unknown; engines: { node: string } };
        expect(pkg.type).toBe("module");
        expect(pkg.engines.node).toBe(">=24");
        expect(pkg.scripts).toBeUndefined(); // nothing that fetches or runs anything except the standard install
        const installed = (n: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", ...n.split("/"), "package.json"), "utf8")).version as string;
        expect(Object.keys(pkg.dependencies).sort()).toEqual([...KIT_DEPENDENCIES].sort());
        for (const [n, v] of Object.entries(pkg.dependencies)) expect([n, v], n).toEqual([n, installed(n)]);
        for (const [n, v] of Object.entries(pkg.optionalDependencies)) expect([n, v], n).toEqual([n, installed(n)]);
        expect(Object.keys(pkg.optionalDependencies)).toEqual(KIT_OPTIONAL);
        for (const v of [...Object.values(pkg.dependencies), ...Object.values(pkg.optionalDependencies)]) expect(v).toMatch(/^\d+\.\d+\.\d+$/); // exact, no ^ or ~
    });

    it("installs playwright-core once, at the version playwright uses (a second, newer copy made the runner report no browsers)", () => {
        const pkg = JSON.parse(text(bundle.files.get("package.json")!)) as { dependencies: Record<string, string>; overrides?: Record<string, string> };
        const installed = (n: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", ...n.split("/"), "package.json"), "utf8")).version as string;
        expect(pkg.dependencies["playwright-core"]).toBe(installed("playwright-core"));
        expect(pkg.overrides?.["playwright-core"]).toBe(installed("playwright-core"));
        // Playwright and its core are released together: the kit must not pin them apart.
        expect(installed("playwright-core")).toBe(installed("playwright"));
        expect(pkg.dependencies["playwright"]).toBe(pkg.dependencies["playwright-core"]);
    });

    it("keeps the packages that ship browsers or are imported by generated tests out of the bundle", () => {
        const main = text(bundle.files.get("runner.mjs")!);
        // They are imported at run time from the kit's node_modules, not copied in.
        expect(main).not.toMatch(/\/\/ node_modules\/playwright-core\//);
        expect(main).not.toMatch(/\/\/ node_modules\/typescript\//);
        expect(main.length).toBeLessThan(4_000_000);
    });
});

describe("the zip a download produces", () => {
    it("holds the program, this download's files and the right start script, in one folder", () => {
        // All three start scripts are in both variants: the chosen system only decides the folder's name and what the README leads with.
        // check-computer.*: "Check this computer" in every download (docs/features/runner-check.md).
        const files = ["LICENSES.txt", "README.txt", "check-computer.cmd", "check-computer.command", "check-computer.sh", "package-lock.json", "package.json", "record-child.mjs", "runner.json", "runner.mjs", "runner.token", "start-runner.cmd", "start-runner.command", "start-runner.sh", "task-child.mjs"];
        const win = entries(makeZip("windows"));
        expect(Object.keys(win).sort()).toEqual(files.map((n) => `runner-shop-checkout-windows/${n}`).sort());
        const unix = entries(makeZip("unix"));
        expect(Object.keys(unix).sort()).toEqual(files.map((n) => `runner-shop-checkout-unix/${n}`).sort());
        // The program is the prebuilt bytes, untouched.
        for (const n of ["runner.mjs", "task-child.mjs", "record-child.mjs"]) expect(Buffer.from(win[`runner-shop-checkout-windows/${n}`]!).equals(Buffer.from(bundle.files.get(n)!)), n).toBe(true);
    });

    it("writes runner.json and the one-line token file", () => {
        const z = entries(makeZip("windows", { url: "https://tests.example.com/app", name: "Maya's laptop" }));
        const dir = "runner-shop-checkout-windows";
        expect(JSON.parse(text(z[`${dir}/runner.json`]!))).toEqual({ url: "https://tests.example.com/app", name: "Maya's laptop", kitVersion: bundle.manifest.kitVersion });
        expect(text(z[`${dir}/runner.token`]!)).toBe(`${TOKEN}\n`);
        // Round 45: a download from Settings names no runner, so the runner takes the computer's own name; its README says no name either.
        const nameless = entries(buildKitZip({ bundle, request: { platform: "unix" }, projectSlug: "my-computer", platformUrl: "https://tests.example.com", enrollCode: "aite_NamelessDownloadCode0123456789abcdefghij" }));
        expect(JSON.parse(text(nameless["runner-my-computer-unix/runner.json"]!))).toEqual({ url: "https://tests.example.com", kitVersion: bundle.manifest.kitVersion });
        const readme = text(nameless["runner-my-computer-unix/README.txt"]!);
        expect(readme.split("\n")[0]).toBe("AI Testing Platform runner");
        expect(readme).not.toContain("Project:");
        expect(readme).toContain("Settings, Your runner");
    });

    it("passes the computer check's file comparison as it comes out of the zip, lock file included (it once said every download was damaged)", () => {
        const z = entries(makeZip("windows"));
        const dir = "runner-shop-checkout-windows";
        expect(z[`${dir}/package-lock.json`], "this build has a lock file").toBeDefined();
        const read = (n: string) => (z[`${dir}/${n}`] ? Buffer.from(z[`${dir}/${n}`]!) : undefined);
        const kitVersion = JSON.parse(text(z[`${dir}/runner.json`]!)).kitVersion as string;
        expect(filesLine(kitVersion, read)).toMatchObject({ status: "ok" });
        // A changed lock file is still found.
        const changed = (n: string) => (n === "package-lock.json" ? Buffer.concat([read(n)!, Buffer.from("\n")]) : read(n));
        expect(filesLine(kitVersion, changed)).toMatchObject({ status: "missing", title: expect.stringContaining("do not match this download") });
        // So is a deleted one: this download's version covers it.
        const deleted = (n: string) => (n === "package-lock.json" ? undefined : read(n));
        expect(filesLine(kitVersion, deleted)).toMatchObject({ status: "missing", title: expect.stringContaining("do not match this download") });
    });

    it("marks the shell scripts executable and the token owner-only, as a Unix zip (Apple's Archive Utility and unzip honour that)", () => {
        // Read from the zip's central directory: "version made by" is 3 (Unix) and the mode is in the high half of the external attributes.
        for (const platform of ["unix", "windows"] as const) {
            const m = modes(makeZip(platform));
            const dir = `runner-shop-checkout-${platform}`;
            expect(m[`${dir}/start-runner.sh`], platform).toEqual({ mode: 0o755, unix: true });
            expect(m[`${dir}/start-runner.command`], platform).toEqual({ mode: 0o755, unix: true });
            expect(m[`${dir}/start-runner.cmd`], platform).toEqual({ mode: 0o755, unix: true });
            expect(m[`${dir}/runner.token`], platform).toEqual({ mode: 0o600, unix: true });
            expect(m[`${dir}/runner.mjs`], platform).toEqual({ mode: 0o644, unix: true });
            expect(m[`${dir}/README.txt`], platform).toEqual({ mode: 0o644, unix: true });
        }
    });

    it("uses CRLF in the Windows script and README, LF in the Unix script and README", () => {
        const win = entries(makeZip("windows"));
        const cmd = text(win["runner-shop-checkout-windows/start-runner.cmd"]!);
        expect(cmd).toContain("\r\n");
        expect(cmd.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/); // every line break is CRLF
        expect(text(win["runner-shop-checkout-windows/README.txt"]!).replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
        // The Unix scripts are LF in either variant (a CR before the shebang makes a Mac say "bad interpreter").
        for (const platform of ["unix", "windows"] as const) {
            const z = entries(makeZip(platform));
            for (const n of ["start-runner.sh", "start-runner.command"]) expect(text(z[`runner-shop-checkout-${platform}/${n}`]!), `${platform} ${n}`).not.toContain("\r");
            expect(text(z[`runner-shop-checkout-${platform}/start-runner.sh`]!).startsWith("#!/bin/sh\n")).toBe(true);
        }
        expect(text(entries(makeZip("unix"))["runner-shop-checkout-unix/README.txt"]!)).not.toContain("\r");
        // ASCII only: cmd.exe reads the file in the computer's code page.
        expect(cmd).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
    });

    it("explains itself in the README without printing the token", () => {
        const readme = text(entries(makeZip("windows", { name: "Maya's laptop", projectName: "Shop Checkout" }))["runner-shop-checkout-windows/README.txt"]!);
        for (const needle of ["Maya's laptop", "Shop Checkout", "https://tests.example.com", "start-runner.cmd", "Connected to the platform", "runner.enroll", "one-time code", "30 minutes", "Node.js 24", "Remove this computer", "--forget-credential", "Ctrl+C", bundle.manifest.kitVersion]) expect(readme, needle).toContain(needle);
        expect(readme).not.toContain(TOKEN);
        // Each README leads with its own system's way and still mentions the other, because both scripts are in the folder.
        const unixReadme = text(entries(makeZip("unix"))["runner-shop-checkout-unix/README.txt"]!);
        expect(unixReadme).not.toContain(TOKEN);
        expect(unixReadme.indexOf("sh start-runner.sh")).toBeGreaterThan(-1);
        expect(unixReadme.indexOf("sh start-runner.sh")).toBeLessThan(unixReadme.indexOf("start-runner.cmd"));
        expect(readme.indexOf("start-runner.cmd")).toBeLessThan(readme.indexOf("start-runner.sh"));
        // The Mac steps in plain words (this avoids the permission and "unidentified developer" prompts), and the right-click route.
        for (const needle of ["Open Terminal", "Type  cd  followed by a space", "drag the unzipped folder", "sh start-runner.sh", "Open Anyway", "node --version", "from that same window"]) expect(unixReadme, needle).toContain(needle);
        expect(readme).toContain("node --version");
    });

    it("never contains the server's secrets, paths or data", () => {
        // What a real server holds: the sentinels set above (in the environment while the bundle was built and the zip made).
        const secrets = Object.values(SENTINELS);
        const forbidden = [...secrets, "platform.db", ROOT, ROOT.replaceAll("\\", "/")];
        for (const platform of ["windows", "unix"] as const) {
            const z = entries(makeZip(platform));
            for (const [name, bytes] of Object.entries(z)) {
                if (name.endsWith("runner.token")) continue; // the one file that is meant to hold a secret, and only the new token
                const body = Buffer.from(bytes).toString("latin1");
                for (const s of forbidden) expect(body.includes(s), `${s.slice(0, 8)}... in ${name}`).toBe(false);
            }
        }
        // The token appears in exactly one place: runner.token.
        const z = entries(makeZip("windows"));
        const holders = Object.entries(z).filter(([, b]) => Buffer.from(b).toString("latin1").includes(TOKEN)).map(([n]) => n);
        expect(holders).toEqual(["runner-shop-checkout-windows/runner.token"]);
    });

    it("keeps hostile names out of the scripts", () => {
        // The name is allowed to hold quotes, percent signs and ampersands; it must only ever appear as text in runner.json and the README.
        const name = `Bob & "Co" %PATH% ^ ! (x)`;
        const z = entries(makeZip("windows", { name }));
        const cmd = text(z["runner-shop-checkout-windows/start-runner.cmd"]!);
        expect(cmd).not.toContain("Bob");
        // %PATH% appears once, in the script's own line that puts the chosen Node.js first on the PATH; the name adds none.
        expect(cmd.split("%PATH%").length - 1).toBe(1);
        expect(cmd).toContain('set "PATH=%NODE_DIR%;%PATH%"');
        expect(JSON.parse(text(z["runner-shop-checkout-windows/runner.json"]!)).name).toBe(name);
        const sh = text(entries(makeZip("unix", { name }))["runner-shop-checkout-unix/start-runner.sh"]!);
        expect(sh).not.toContain("Bob");
    });

    it("names the folder after the project, with a safe fallback", () => {
        expect(projectSlugOf("Shop Checkout")).toBe("shop-checkout");
        expect(projectSlugOf("../../etc/passwd")).toBe("etc-passwd");
        expect(projectSlugOf("   ")).toBe("general");
        expect(projectSlugOf("日本語")).toBe("general");
    });
});

describe("what the person may ask for", () => {
    const ok = (body: unknown) => DownloadRequest.safeParse(body);
    it("accepts each system and processor, nothing else to choose", () => {
        for (const os of ["windows", "mac", "linux"]) for (const arch of ["x64", "arm64"]) expect(ok({ os, arch }).success, `${os} ${arch}`).toBe(true);
    });
    it("refuses an unknown system or processor and every other field (a name, a kind, a token)", () => {
        for (const bad of [{}, { os: "windows" }, { arch: "x64" }, { os: "WINDOWS", arch: "x64" }, { os: "unix", arch: "x64" }, { os: "mac", arch: "ia32" }, { os: "linux", arch: null }]) expect(ok(bad).success, JSON.stringify(bad)).toBe(false);
        for (const extra of [{ name: "x" }, { kind: "installer" }, { complete: true }, { token: "aitg_x" }, { platform: "windows" }]) expect(ok({ os: "windows", arch: "x64", ...extra }).success, JSON.stringify(extra)).toBe(false);
    });
});

describe("the address the runner is told to use", () => {
    const d = (publicUrl: string | undefined, protocol: string, host: string | undefined) => decideAddress({ publicUrl, protocol, host });
    it("PUBLIC_URL wins over the request, with or without a path or trailing slash", () => {
        expect(d("https://tests.example.com", "http", "10.1.2.3:4000")).toEqual({ platformUrl: "https://tests.example.com", urlOk: true });
        expect(d("https://tests.example.com/qa/", "http", "x")).toEqual({ platformUrl: "https://tests.example.com/qa", urlOk: true });
        expect(d("http://192.168.1.20:4000", "http", "x")).toEqual({ platformUrl: "http://192.168.1.20:4000", urlOk: true });
    });
    it("PUBLIC_URL as plain http on a public host is flagged (the runner would refuse it)", () => {
        const r = d("http://tests.example.com", "https", "x");
        expect(r.urlOk).toBe(false);
        expect(r.urlWarning).toBe("Runners need an https address when the platform is not on your own network. Set PUBLIC_URL to the https address people use.");
    });
    it("an unusable PUBLIC_URL is flagged, not guessed around", () => {
        expect(d("not a url", "http", "x")).toMatchObject({ urlOk: false, platformUrl: "" });
        expect(d("ftp://tests.example.com", "http", "x")).toMatchObject({ urlOk: false });
        expect(d("https://user:pw@tests.example.com", "http", "x")).toMatchObject({ urlOk: false });
    });
    it("without PUBLIC_URL the Host header is used and the warning says so", () => {
        const lan = d(undefined, "http", "192.168.1.20:4000");
        expect(lan).toMatchObject({ platformUrl: "http://192.168.1.20:4000", urlOk: true });
        expect(lan.urlWarning).toMatch(/set PUBLIC_URL/);
        const local = d(undefined, "http", "localhost:4000");
        expect(local).toMatchObject({ platformUrl: "http://localhost:4000", urlOk: true });
        expect(local.urlWarning).toMatch(/only a runner on this computer/i);
        const pub = d(undefined, "http", "tests.example.com");
        expect(pub).toMatchObject({ platformUrl: "http://tests.example.com", urlOk: false });
        expect(pub.urlWarning).toMatch(/https address/);
        expect(d(undefined, "https", "tests.example.com")).toMatchObject({ platformUrl: "https://tests.example.com", urlOk: true });
        expect(d(undefined, "http", "[::1]:4000")).toMatchObject({ platformUrl: "http://[::1]:4000", urlOk: true });
    });
    it("a missing or odd Host header yields no address", () => {
        for (const host of [undefined, "", "a b", "evil.com/path", "x@y", "a:99999999"]) expect(d(undefined, "http", host), String(host)).toMatchObject({ urlOk: false, platformUrl: "" });
    });
    it("agrees with the runner's own rule about which http addresses it accepts", () => {
        for (const host of ["localhost:4000", "127.0.0.1:1", "10.0.0.5", "172.16.0.9", "192.168.9.9:81", "tests.example.com", "8.8.8.8", "172.32.0.1"]) {
            const decided = decideAddress({ publicUrl: `http://${host}`, protocol: "http", host: undefined });
            const parsed = parseAgentArgs(["--url", `http://${host}`, "--token", TOKEN], {});
            expect(decided.urlOk, host).toBe(parsed.kind === "run");
        }
    });
});

describe("the runner program reading its kit files", () => {
    const kitDir = () => fs.mkdtempSync(path.join(tmp, "k-"));
    const validJson = { url: "https://tests.example.com", name: "Maya's laptop", kitVersion: "0.1.0+abc123def0" };

    it("does nothing without runner.json (a repository checkout)", () => {
        const dir = kitDir();
        const env = { PATH: "x" };
        expect(applyKitDefaults(env, dir)).toEqual({ kit: false, env });
    });

    it("fills in address, name, token file, work folder and kit version, and the arguments parse", () => {
        const dir = kitDir();
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify(validJson));
        fs.writeFileSync(path.join(dir, "runner.token"), `${TOKEN}\n`);
        const r = applyKitDefaults({}, dir);
        expect(r.kit).toBe(true);
        const parsed = parseAgentArgs([], (r as { env: NodeJS.ProcessEnv }).env);
        expect(parsed.kind).toBe("run");
        if (parsed.kind !== "run") return;
        expect(parsed.config).toMatchObject({ baseUrl: "https://tests.example.com", name: "Maya's laptop", token: TOKEN, tokenSource: "file", workDir: path.join(dir, "work"), kitVersion: validJson.kitVersion });
    });

    it("lets flags and environment variables win", () => {
        const dir = kitDir();
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify(validJson));
        fs.writeFileSync(path.join(dir, "runner.token"), `${TOKEN}\n`);
        const other = "aitg_OtherTokenFromTheEnvironment0123456789ab";
        const r = applyKitDefaults({ AITP_URL: "https://other.example.com", AITP_AGENT_TOKEN: other }, dir) as { env: NodeJS.ProcessEnv };
        const parsed = parseAgentArgs(["--name", "From the flag"], r.env);
        if (parsed.kind !== "run") throw new Error("did not parse");
        expect(parsed.config).toMatchObject({ baseUrl: "https://other.example.com", token: other, tokenSource: "env", name: "From the flag" });
    });

    it("stops with a plain message when runner.json is broken, huge or incomplete", () => {
        for (const body of ["{ nope", "[]", JSON.stringify({ name: "No address" }), JSON.stringify({ ...validJson, name: "bad\u0000name" }), JSON.stringify({ ...validJson, name: "" }), "x".repeat(20_000)]) {
            const dir = kitDir();
            fs.writeFileSync(path.join(dir, "runner.json"), body);
            const r = applyKitDefaults({}, dir);
            expect(r.kit, body.slice(0, 20)).toBe("broken");
            expect((r as { message: string }).message).toMatch(/runner kit|runner\.json/i);
        }
        expect(parseKitFile(`\uFEFF${JSON.stringify(validJson)}`.replace(/^\uFEFF/, "")).ok).toBe(true);
    });

    it("without a name in runner.json (downloads from round 45 on) the runner is named after the computer", () => {
        const dir = kitDir();
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ url: "https://tests.example.com", kitVersion: validJson.kitVersion }));
        fs.writeFileSync(path.join(dir, "runner.token"), `${TOKEN}\n`);
        const r = applyKitDefaults({}, dir) as { kit: boolean; env: NodeJS.ProcessEnv };
        expect(r.kit).toBe(true);
        expect(r.env.AITP_AGENT_NAME).toBeUndefined();
        const parsed = parseAgentArgs([], r.env);
        if (parsed.kind !== "run") throw new Error("did not parse");
        expect(parsed.config.name).toBe(os.hostname().trim().slice(0, 64));
    });

    it("reports the kit version to the platform as an additive capability, and only then", async () => {
        const base = { browsers: () => ["chromium" as const], platform: "linux" as const, exec: async () => undefined, env: {} };
        const withKit = await new CapabilityProbe({ ...base, kitVersion: "0.1.0+abc123def0" }).discover();
        expect(withKit.kitVersion).toBe("0.1.0+abc123def0");
        expect(Capabilities.safeParse(withKit).success).toBe(true);
        const without = await new CapabilityProbe(base).discover();
        expect("kitVersion" in without).toBe(false);
        expect(Capabilities.safeParse({ os: "linux", arch: "x64", node: "v24", browsers: [], kitVersion: "x".repeat(81) }).success).toBe(false);
    });
});

describe("the start scripts", () => {
    function bashPath(): string | undefined {
        for (const candidate of [process.env.KIT_TEST_BASH, "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "/bin/bash", "bash"]) {
            if (!candidate) continue;
            const r = spawnSync(candidate, ["-c", "echo kit-ok"], { encoding: "utf8", timeout: 20_000 });
            if (r.status === 0 && r.stdout.trim() === "kit-ok") return candidate;
        }
        return undefined;
    }
    const bash = bashPath();

    it.skipIf(!bash)("start-runner.sh and start-runner.command pass a syntax check (bash -n)", () => {
        const dir = fs.mkdtempSync(path.join(tmp, "sh-"));
        const z = entries(makeZip("unix"));
        for (const n of ["start-runner.sh", "start-runner.command"]) fs.writeFileSync(path.join(dir, n), z[`runner-shop-checkout-unix/${n}`]!);
        for (const n of ["start-runner.sh", "start-runner.command"]) {
            const r = spawnSync(bash!, ["-n", n], { cwd: dir, encoding: "utf8", timeout: 20_000 });
            expect(r.status, `${n}: ${r.stderr}`).toBe(0);
        }
    });

    it("the Windows script has a label for every goto (no jump into nothing)", () => {
        const cmd = text(entries(makeZip("windows"))["runner-shop-checkout-windows/start-runner.cmd"]!);
        const labels = new Set([...cmd.matchAll(/^:([a-z]+)\s*$/gim)].map((m) => m[1]!.toLowerCase()));
        const targets = [...cmd.matchAll(/goto ([a-z]+)/gi)].map((m) => m[1]!.toLowerCase());
        expect(targets.length).toBeGreaterThan(10);
        for (const t of targets) expect(labels.has(t), `goto ${t}`).toBe(true);
        expect(cmd).toContain("AITP_KIT_SKIP_INSTALL");
        expect(cmd).toContain("winget install OpenJS.NodeJS.LTS");
        // It asks before installing anything.
        expect(cmd.indexOf("set /p")).toBeLessThan(cmd.indexOf("winget install OpenJS.NodeJS.LTS\r\nif errorlevel"));
        expect(cmd).toContain("--no-audit --no-fund");
        // Round 17: the start scripts no longer download a browser; the runner program chooses one itself (installed Chrome or Edge, or a download it makes).
        expect(cmd).not.toContain("playwright install chromium");
    });

    it("both scripts honour AITP_KIT_SKIP_INSTALL, restart after a crash, and stop for good on a revoked token", () => {
        const z = entries(makeZip("unix"));
        const sh = text(z["runner-shop-checkout-unix/start-runner.sh"]!);
        expect(sh).toContain('"$AITP_KIT_SKIP_INSTALL" != "1"');
        expect(sh).toContain("sleep 5");
        expect(sh).toMatch(/3\)[\s\S]*fail 3/);
        expect(sh).toContain("brew install node");
        const cmd = text(entries(makeZip("windows"))["runner-shop-checkout-windows/start-runner.cmd"]!);
        expect(cmd).toContain('if "%CODE%"=="3" goto revoked');
        expect(cmd).toContain("goto loop");
    });
});
