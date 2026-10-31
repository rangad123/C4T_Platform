/**
 * Runner updates without a server: the platform's side (which runner is offered what, the files, the setting, Activity) and the runner's
 * updater (download and check, staging, the self-test, the switch, rollback, an interrupted switch, back-off, the hourly cap, new test tools
 * from a complete download's pack or from npm). The two halves are joined in-process: the runner's "client" fetches its files from the
 * platform's RunnerUpdates object, so the checksums the runner checks are the ones the platform announces.
 *
 * Fast tier (no browser, no server). Real files in temp folders, real child processes for the self-test and the stand-in npm.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Capabilities, RunnerUpdateOffer } from "../src/agent-protocol/schema.js";
import { RunnerUpdateOffer as OfferSchema } from "../src/agent-protocol/schema.js";
import { memoryLogger } from "../src/agent/log.js";
import { MAX_UNCONFIRMED_STARTS, RUNNER_UPDATE_EXIT, rollbackByHand, RunnerUpdater } from "../src/agent/updater.js";
import type { PlatformClient } from "../src/agent/client.js";
import { RunnerUpdates, targetOfAgent, type ActivityRow } from "../src/platform/runner-update.js";
import { Db } from "../src/platform/db.js";
import { agentRouteOf, isAgentRoute } from "../src/platform/agent-routing.js";
import { ROUTE_ROLES } from "../src/platform/auth/roles.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-upd-unit-"));
const savedEnv = { RUNNER_KIT_DIR: process.env.RUNNER_KIT_DIR, RUNNER_COMPLETE_DIR: process.env.RUNNER_COMPLETE_DIR };
afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let n = 0;
const fresh = (label: string) => fs.mkdtempSync(path.join(tmpRoot, `${label}-${n++}-`));

/** A runner program that only answers --version (the self-test), stamped with its version so the files differ between versions. */
const program = (v: string) => `// ${v}\nif (process.argv.includes("--version")) { console.log("ai-test-agent 1.0.0"); process.exit(0); }\nprocess.exit(9);\n`;
const pkgJson = (pw: string) => `${JSON.stringify({ name: "ai-test-runner-kit", private: true, type: "module", dependencies: { "@playwright/test": pw } }, null, 2)}\n`;

/** A prebuilt bundle as build:runner writes it (the five files and a manifest with checksums). */
function writeBundle(dir: string, version: string, opts: { pw?: string; brokenRunner?: boolean } = {}): string {
    fs.mkdirSync(dir, { recursive: true });
    const files: Record<string, string> = {
        "runner.mjs": opts.brokenRunner ? `// ${version}\nprocess.exit(3);\n` : program(version),
        "task-child.mjs": `// task child ${version}\n`,
        "record-child.mjs": `// record child ${version}\n`,
        "package.json": pkgJson(opts.pw ?? "1.63.0"),
        "LICENSES.txt": "licences\n",
    };
    const list = Object.entries(files).map(([name, text]) => {
        fs.writeFileSync(path.join(dir, name), text);
        return { name, bytes: Buffer.byteLength(text), sha256: sha(text) };
    });
    const hash = sha(list.map((f) => `${f.name}\0${f.sha256}\n`).join(""));
    const kitVersion = `${version}+${hash.slice(0, 10)}`;
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: 1, platformVersion: version, hash, kitVersion, nodeMin: 24, files: list }));
    return kitVersion;
}

/** A complete build for one target, in the layout loadComplete checks (pack.bin of deflated files, manifest with offsets and checksums). */
function writeComplete(root: string, target: string, bundleDir: string, nodeModules: Record<string, string>, opts: { damage?: string } = {}): void {
    const dir = path.join(root, target);
    fs.mkdirSync(dir, { recursive: true });
    const entries: Record<string, string> = { "complete-kit.json": "{}\n", [target.startsWith("win") ? "node/node.exe" : "node/bin/node"]: "not really node\n", "node_modules/.aitp-complete": "complete\n" };
    for (const [p, t] of Object.entries(nodeModules)) entries[`node_modules/${p}`] = t;
    const chunks: Buffer[] = [];
    let offset = 0;
    const files = Object.entries(entries).map(([p, text]) => {
        const data = Buffer.from(text);
        let packed = zlib.deflateRawSync(data);
        if (opts.damage === p) packed = zlib.deflateRawSync(Buffer.from(text.replace(/./, "X")));
        const f = { path: p, mode: 0o644, size: data.length, csize: packed.length, crc: zlib.crc32(data) >>> 0, sha256: sha(data), offset };
        offset += packed.length;
        chunks.push(packed);
        return f;
    });
    const pack = Buffer.concat(chunks);
    fs.writeFileSync(path.join(dir, "pack.bin"), pack);
    const packageJsonSha256 = sha(fs.readFileSync(path.join(bundleDir, "package.json")));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: 1, target, nodeVersion: "v24.99.0", packageJsonSha256, dosTime: 0, dosDate: 33, packBytes: pack.length, packSha256: sha(pack), unpackedBytes: 1, files }));
}

/** A runner's folder as a download leaves it, on version `from`, with a stand-in @playwright/test so the new program's packages resolve. */
function writeKit(bundleDir: string, kitVersion: string, opts: { complete?: boolean; extra?: Record<string, unknown> } = {}): string {
    const kit = fresh("kit");
    for (const f of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"]) fs.copyFileSync(path.join(bundleDir, f), path.join(kit, f));
    fs.writeFileSync(path.join(kit, "runner.json"), JSON.stringify({ url: "https://platform.example", name: "Maya", kitVersion, ...(opts.extra ?? {}) }, null, 2));
    fs.writeFileSync(path.join(kit, "runner.token"), "aitg_SECRET-token-value-0123456789\n");
    const pw = path.join(kit, "node_modules", "@playwright", "test");
    fs.mkdirSync(pw, { recursive: true });
    fs.writeFileSync(path.join(pw, "package.json"), JSON.stringify({ name: "@playwright/test", version: "old", main: "index.js" }));
    fs.writeFileSync(path.join(pw, "index.js"), "module.exports = 'old';\n");
    if (opts.complete) fs.writeFileSync(path.join(kit, "node_modules", ".aitp-complete"), "complete\n");
    return kit;
}

async function bytesOf(body: Buffer | Readable): Promise<Buffer> {
    if (Buffer.isBuffer(body)) return body;
    const parts: Buffer[] = [];
    for await (const c of body) parts.push(c as Buffer);
    return Buffer.concat(parts);
}

/** The runner's connection, answered by the platform object in-process. `tamper` changes a file on the way. */
function bridge(updates: RunnerUpdates, agent: () => { id: string; capabilities: Capabilities; node: string }, tamper?: (name: string, b: Buffer) => Buffer) {
    const asked: string[] = [];
    const client = {
        updateHint: undefined as string | undefined,
        updateState: undefined as unknown,
        async updateOffer() {
            return updates.offer(agent());
        },
        async updateFile(name: string, size: number, dest: string) {
            asked.push(name);
            const f = updates.file(name);
            if (!f) throw new Error(`404 ${name}`);
            let b = await bytesOf(f.body);
            if (tamper) b = tamper(name, b);
            if (b.length > size) throw new Error(`more bytes than ${name} should have`);
            fs.writeFileSync(dest, b);
            return { size: b.length, sha256: sha(b) };
        },
    };
    return { client: client as unknown as PlatformClient, asked };
}

const caps = (u: RunnerUpdater, kitVersion: string): Capabilities => ({ os: process.platform as Capabilities["os"], arch: process.arch, node: process.version, browsers: ["chromium"], kitVersion, update: u.status() });

async function until<T>(what: string, probe: () => T | undefined | false, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = probe();
        if (v) return v;
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}
const idle = { active: () => 0, keepAlive: async () => undefined, wait: async () => undefined };

let platformDir: string;
let bundleA: string;
let bundleB: string;
let versionA: string;
let versionB: string;
let rows: ActivityRow[];
let updates: RunnerUpdates;
let db: Db;

beforeEach(() => {
    platformDir = fresh("platform");
    bundleA = path.join(fresh("bundles"), "a");
    bundleB = path.join(path.dirname(bundleA), "b");
    versionA = writeBundle(bundleA, "1.0.0");
    versionB = writeBundle(bundleB, "1.1.0");
    process.env.RUNNER_KIT_DIR = bundleB;
    process.env.RUNNER_COMPLETE_DIR = path.join(platformDir, "no-complete");
    rows = [];
    db = new Db(path.join(platformDir, "platform.db"));
    updates = new RunnerUpdates({ db, dataDir: platformDir, activity: (r) => rows.push(r) });
});
afterEach(() => {
    db.close();
    delete process.env.AITP_UPDATE_NPM_CLI;
});

function runnerOn(kit: string, version = versionA, extra: Partial<ConstructorParameters<typeof RunnerUpdater>[0]> = {}) {
    const u = new RunnerUpdater({ kitDir: kit, version, ...extra });
    const { log, lines } = memoryLogger();
    const agent = () => ({ id: "agent-1", capabilities: caps(u, u.version), node: process.version });
    return { u, log, lines, agent };
}

describe("the protocol additions", () => {
    it("adds exactly the two update routes to the runner's routes, token-checked, and the admin routes for owners", () => {
        expect(agentRouteOf("POST", "/api/agent/update")).toEqual({ kind: "update" });
        expect(agentRouteOf("GET", "/api/agent/update/files/runner.mjs")).toEqual({ kind: "update-file", name: "runner.mjs" });
        for (const [m, p] of [["GET", "/api/agent/update"], ["POST", "/api/agent/update/"], ["GET", "/api/agent/update/files/../x"], ["GET", "/api/agent/update/files/a/b"], ["GET", "/api/agent/update/files/.hidden"], ["PUT", "/api/agent/update/files/x"]] as const) expect(isAgentRoute(m, p), p).toBe(false);
        expect(ROUTE_ROLES["POST /api/agent/update"]).toBe("own");
        expect(ROUTE_ROLES["GET /api/agent/update/files/:name"]).toBe("own");
        expect(ROUTE_ROLES["PUT /api/projects/:id/agents/:agentId/updates"]).toBe("owner");
        expect(ROUTE_ROLES["POST /api/projects/:id/agents/:agentId/update"]).toBe("owner");
    });
});

describe("the platform's side", () => {
    it("reads the settings file of an earlier release once into an empty table, and never writes a file", () => {
        const dir = fresh("upgrade");
        fs.writeFileSync(path.join(dir, "runner-updates.json"), JSON.stringify({ format: 1, agents: { old1: { auto: false, requestedAt: 1234, reported: "updated|x" }, old2: {} } }));
        const upgraded = new Db(path.join(dir, "platform.db"));
        try {
            const first = new RunnerUpdates({ db: upgraded, dataDir: dir });
            first.setAuto("old2", false);
            const rows = upgraded.all<{ agent_id: string; auto: number | null; requested_at: number | null; reported: string | null }>("SELECT agent_id, auto, requested_at, reported FROM runner_update_settings ORDER BY agent_id");
            expect(rows).toEqual([
                { agent_id: "old1", auto: 0, requested_at: 1234, reported: "updated|x" },
                { agent_id: "old2", auto: 0, requested_at: null, reported: null },
            ]);
            // A restart does not import again over what changed since; the file is left for a rollback and not rewritten.
            first.setAuto("old1", true);
            new RunnerUpdates({ db: upgraded, dataDir: dir });
            expect(upgraded.get<{ auto: number | null }>("SELECT auto FROM runner_update_settings WHERE agent_id = 'old1'")!.auto).toBeNull(); // back on: absent, as in the file
            expect(JSON.parse(fs.readFileSync(path.join(dir, "runner-updates.json"), "utf8")).agents.old1.auto).toBe(false);
        } finally {
            upgraded.close();
        }
    });

    it("offers its own bundle to a runner that can update and is on another version; never to one that cannot, or is current", () => {
        const kit = writeKit(bundleA, versionA);
        const { u } = runnerOn(kit);
        const agent = { id: "a1", node: process.version, capabilities: caps(u, versionA) };
        expect(updates.latest()).toBe(versionB);
        expect(updates.wanted(agent)).toBe("auto");
        expect(updates.hint(agent)).toBe(`auto ${versionB}`);
        const offer = updates.offer(agent)!;
        expect(OfferSchema.parse(offer)).toEqual(offer);
        expect(offer.version).toBe(versionB);
        expect(offer.files.map((f) => f.name).sort()).toEqual(["LICENSES.txt", "package.json", "record-child.mjs", "runner.mjs", "task-child.mjs"]);
        for (const f of offer.files) expect(f.sha256).toBe(sha(fs.readFileSync(path.join(bundleB, f.name))));
        expect(offer.complete).toBeUndefined();
        // A runner from a checkout or an older download (no update.can), or one already current, is offered nothing.
        expect(updates.offer({ ...agent, capabilities: { ...agent.capabilities, update: undefined } })).toBeUndefined();
        expect(updates.offer({ ...agent, capabilities: { ...agent.capabilities, kitVersion: versionB } })).toBeUndefined();
        // Only files an offer can name are served.
        expect(updates.file("runner.mjs")!.sha256).toBe(offer.files.find((f) => f.name === "runner.mjs")!.sha256);
        for (const name of ["runner.json", "runner.token", "manifest.json", "complete-win-x64-node_modules.json", "../x"]) expect(updates.file(name), name).toBeUndefined();
    });

    it("keeps the setting per runner: off means only on request; a request is settled by the runner's report; Activity once per report", () => {
        const kit = writeKit(bundleA, versionA);
        const { u } = runnerOn(kit);
        const agent = { id: "a2", name: "Maya", projectId: "p1", node: process.version, capabilities: caps(u, versionA) };
        updates.setAuto("a2", false);
        expect(updates.wanted(agent)).toBeUndefined();
        expect(updates.publicView(agent)).toMatchObject({ can: true, auto: false, outOfDate: true, latest: versionB, requested: false });
        updates.request("a2");
        expect(updates.wanted(agent)).toBe("requested");
        // The setting survives a restart of the platform (a row in the database every process sees).
        const again = new RunnerUpdates({ db, dataDir: platformDir });
        expect(again.publicView(agent)).toMatchObject({ auto: false, requested: true });
        // The runner reports a failure: one Activity row, the request is settled, the row says why.
        const at = new Date().toISOString();
        const failed = { ...agent.capabilities, update: { can: true, state: "failed" as const, to: versionB, error: "The file runner.mjs arrived damaged.", at } };
        updates.observe(agent, failed);
        updates.observe(agent, failed);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: "runner-update-failed", projectId: "p1", agentName: "Maya" });
        expect(rows[0]!.detail).toContain(`Still on version ${versionA}`);
        expect(updates.wanted({ ...agent, capabilities: failed })).toBeUndefined();
        expect(updates.publicView({ ...agent, capabilities: failed })).toMatchObject({ state: "failed", error: "The file runner.mjs arrived damaged." });
        // Back on: automatic again. An "updated" report is one more row.
        updates.setAuto("a2", true);
        updates.observe(agent, { ...agent.capabilities, kitVersion: versionB, update: { can: true, state: "updated", from: versionA, to: versionB, at: new Date(Date.now() + 1000).toISOString() } });
        expect(rows.map((r) => r.action)).toEqual(["runner-update-failed", "runner-updated"]);
        expect(rows[1]!.detail).toBe(`Runner “Maya” updated itself from ${versionA} to ${versionB}.`);
    });

    it("masks a proxy sign-in that slipped into a runner's error text", () => {
        const agent = { id: "a3", name: "M", projectId: "p", capabilities: { os: "win32", arch: "x64", node: "v24", browsers: [], kitVersion: versionA, update: { can: true, state: "failed", error: "via http://bob:Secr3t@proxy:8080 failed", at: new Date().toISOString() } } as Capabilities };
        expect(JSON.stringify(updates.publicView(agent))).not.toContain("Secr3t");
        updates.observe(agent, agent.capabilities);
        expect(rows[0]!.detail).not.toContain("Secr3t");
    });
});

describe("the runner's updater", () => {
    it("downloads, checks, tests and switches the files; keeps runner.json's own lines, the token and one previous version", async () => {
        const kit = writeKit(bundleA, versionA, { extra: { proxy: "http://proxy.example:8080", browser: "chrome" } });
        const { u, log, lines, agent } = runnerOn(kit);
        const { client } = bridge(updates, agent);
        u.attach(client, log);
        expect(u.status()).toMatchObject({ can: true, state: "idle", packageSha256: sha(fs.readFileSync(path.join(kit, "package.json"))) });
        u.connected("agent-1", updates.offer(agent()));
        expect(u.holding()).toBe(true);
        await until("ready", () => u.status().state === "ready" || u.status().state === "failed");
        expect(u.status(), lines.join("\n")).toMatchObject({ state: "ready", from: versionA, to: versionB });
        // Tasks still running: it waits.
        expect(await u.hold({ ...idle, active: () => 1 })).toBeUndefined();
        expect(fs.readFileSync(path.join(kit, "runner.mjs"), "utf8")).toContain("1.0.0");
        // Idle: switch, and ask to be started again.
        expect(await u.hold(idle)).toBe(RUNNER_UPDATE_EXIT);
        for (const f of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"]) expect(fs.readFileSync(path.join(kit, f), "utf8"), f).toBe(fs.readFileSync(path.join(bundleB, f), "utf8"));
        expect(JSON.parse(fs.readFileSync(path.join(kit, "runner.json"), "utf8"))).toEqual({ url: "https://platform.example", name: "Maya", kitVersion: versionB, proxy: "http://proxy.example:8080", browser: "chrome" });
        expect(fs.readFileSync(path.join(kit, "runner.token"), "utf8")).toBe("aitg_SECRET-token-value-0123456789\n");
        expect(fs.readFileSync(path.join(kit, ".update", "previous", "runner.mjs"), "utf8")).toContain("1.0.0");
        expect(fs.existsSync(path.join(kit, ".update", "next"))).toBe(false);
        // The token is in no file of the update folder and in no line.
        const all = fs.readdirSync(path.join(kit, ".update"), { recursive: true }).map(String).filter((f) => fs.statSync(path.join(kit, ".update", f)).isFile());
        for (const f of all) expect(fs.readFileSync(path.join(kit, ".update", f), "utf8"), f).not.toContain("SECRET-token");
        expect(lines.join("\n")).not.toContain("SECRET-token");

        // The new version starts (index.ts) and connects: confirmed, reported as updated, no offer any more.
        const next = new RunnerUpdater({ kitDir: kit, version: versionB });
        expect(next.startup(() => undefined)).toBeUndefined();
        const after = memoryLogger();
        next.attach(bridge(updates, () => ({ id: "agent-1", capabilities: caps(next, versionB), node: process.version })).client, after.log);
        next.connected("agent-1", undefined);
        expect(next.status()).toMatchObject({ state: "updated", from: versionA, to: versionB });
        expect(after.lines.join("\n")).toContain(`updated itself from version ${versionA} to ${versionB}`);
        expect(updates.offer({ id: "agent-1", node: process.version, capabilities: caps(next, versionB) })).toBeUndefined();
    });

    it("refuses a file that arrives damaged: nothing changes, it says why, backs off and caps attempts per hour", async () => {
        const kit = writeKit(bundleA, versionA);
        let now = Date.parse("2026-10-18T10:00:00Z");
        const { u, log, lines, agent } = runnerOn(kit, versionA, { now: () => now });
        const before = fs.readFileSync(path.join(kit, "runner.mjs"), "utf8");
        u.attach(bridge(updates, agent, (name, b) => (name === "task-child.mjs" ? Buffer.concat([b.subarray(0, b.length - 1), Buffer.from("!")]) : b)).client, log);
        u.connected("agent-1", updates.offer(agent()));
        await until("failed", () => u.status().state === "failed");
        const s = u.status();
        expect(s.error).toBe("The file task-child.mjs of the update arrived damaged (its size or checksum does not match what the platform announced). Nothing was changed.");
        expect(s.retryAt).toBe(new Date(now + 5 * 60_000).toISOString());
        expect(fs.readFileSync(path.join(kit, "runner.mjs"), "utf8")).toBe(before);
        expect(fs.existsSync(path.join(kit, ".update", "next"))).toBe(false);
        expect(fs.existsSync(path.join(kit, ".update", "previous"))).toBe(false);
        expect(u.holding()).toBe(false);
        expect(lines.join("\n")).toContain(`Still on version ${versionA}`);
        // Backing off: an automatic hint is ignored, a person's request is not.
        u.consider({ ...updates.offer(agent())!, reason: "auto" });
        expect(u.holding()).toBe(false);
        now += 6 * 60_000;
        u.consider(updates.offer(agent())!);
        expect(u.holding()).toBe(true);
        await until("failed again", () => !u.holding());
        expect(u.status().retryAt).toBe(new Date(now + 15 * 60_000).toISOString());
        u.consider({ ...updates.offer(agent())!, reason: "requested" });
        await until("third failure", () => !u.holding());
        // Three attempts this hour: even a request waits for the hour to pass.
        u.consider({ ...updates.offer(agent())!, reason: "requested" });
        expect(u.holding()).toBe(false);
        expect(u.status().state).toBe("failed");
    });

    it("refuses a new version that does not start on this computer (the self-test), before switching anything", async () => {
        writeBundle(bundleB, "1.1.0", { brokenRunner: true });
        const kit = writeKit(bundleA, versionA);
        const { u, log, agent } = runnerOn(kit);
        u.attach(bridge(updates, agent).client, log);
        u.connected("agent-1", updates.offer(agent()));
        await until("failed", () => u.status().state === "failed");
        expect(u.status().error).toMatch(/The new version did not start on this computer \(exit code 3\)\. Nothing was changed\./);
        expect(fs.readFileSync(path.join(kit, "runner.mjs"), "utf8")).toContain("1.0.0");
    });

    it("rolls back by hand and after a new version keeps starting without connecting; does not take the same version again by itself", async () => {
        const kit = writeKit(bundleA, versionA);
        const { u, log, agent } = runnerOn(kit);
        u.attach(bridge(updates, agent).client, log);
        u.connected("agent-1", updates.offer(agent()));
        await until("ready", () => u.status().state === "ready");
        expect(await u.hold(idle)).toBe(RUNNER_UPDATE_EXIT);

        // Three starts are allowed to connect; the fourth puts the old files back and restarts.
        for (let i = 0; i < MAX_UNCONFIRMED_STARTS; i++) expect(new RunnerUpdater({ kitDir: kit, version: versionB }).startup(() => undefined)).toBeUndefined();
        const said: string[] = [];
        expect(new RunnerUpdater({ kitDir: kit, version: versionB }).startup((l) => said.push(l))).toBe(RUNNER_UPDATE_EXIT);
        expect(said.join("\n")).toContain(`went back to version ${versionA}`);
        expect(fs.readFileSync(path.join(kit, "runner.mjs"), "utf8")).toContain("1.0.0");
        expect(JSON.parse(fs.readFileSync(path.join(kit, "runner.json"), "utf8")).kitVersion).toBe(versionA);
        const back = new RunnerUpdater({ kitDir: kit, version: versionA });
        expect(back.status()).toMatchObject({ state: "rolled-back", to: versionB });
        // The automatic offer of that version is ignored; a request is taken.
        back.attach(bridge(updates, () => ({ id: "agent-1", capabilities: caps(back, versionA), node: process.version })).client, memoryLogger().log);
        back.consider({ ...updates.offer({ id: "agent-1", node: process.version, capabilities: caps(back, versionA) })!, reason: "auto" });
        expect(back.holding()).toBe(false);
        back.consider({ ...updates.offer({ id: "agent-1", node: process.version, capabilities: caps(back, versionA) })!, reason: "requested" });
        expect(back.holding()).toBe(true);
        await until("ready", () => back.status().state === "ready");
        expect(await back.hold(idle)).toBe(RUNNER_UPDATE_EXIT);

        // --rollback by hand.
        const byHand = new RunnerUpdater({ kitDir: kit, version: versionB });
        const out: string[] = [];
        expect(rollbackByHand(byHand, (l) => out.push(l))).toBe(0);
        expect(out[0]).toContain(`Went back from version ${versionB} to version ${versionA}`);
        expect(fs.readFileSync(path.join(kit, "runner.mjs"), "utf8")).toContain("1.0.0");
        // Only one rollback is kept.
        expect(rollbackByHand(new RunnerUpdater({ kitDir: kit, version: versionA }), (l) => out.push(l))).toBe(1);
        expect(out[1]).toContain("There is no earlier version");
    });

    it("undoes a switch that was interrupted (the journal) at the next start", async () => {
        const kit = writeKit(bundleA, versionA);
        const { u, log, agent } = runnerOn(kit);
        u.attach(bridge(updates, agent).client, log);
        u.connected("agent-1", updates.offer(agent()));
        await until("ready", () => u.status().state === "ready");
        expect(await u.hold(idle)).toBe(RUNNER_UPDATE_EXIT);
        // As if the power went off half way: the journal is there and runner.mjs is already the new one.
        const stateFile = path.join(kit, ".update", "state.json");
        const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        st.switching = { from: versionA, to: versionB, at: new Date().toISOString() };
        delete st.switched;
        fs.writeFileSync(stateFile, JSON.stringify(st));
        const said: string[] = [];
        expect(new RunnerUpdater({ kitDir: kit, version: versionB }).startup((l) => said.push(l))).toBe(RUNNER_UPDATE_EXIT);
        expect(said[0]).toContain("was interrupted");
        expect(fs.readFileSync(path.join(kit, "runner.mjs"), "utf8")).toContain("1.0.0");
        expect(JSON.parse(fs.readFileSync(path.join(kit, "runner.json"), "utf8")).kitVersion).toBe(versionA);
    });

    it("a complete download gets its new test tools from the platform's pack, every file checked; a damaged one is refused", async () => {
        const target = targetOfAgent({ os: process.platform as Capabilities["os"], arch: process.arch })!;
        expect(target).toBeTruthy();
        const completeRoot = path.join(platformDir, "complete");
        process.env.RUNNER_COMPLETE_DIR = completeRoot;
        // Version B pins other test tool versions.
        versionB = writeBundle(bundleB, "1.1.0", { pw: "1.64.0" });
        const newTools = { "@playwright/test/package.json": JSON.stringify({ name: "@playwright/test", version: "1.64.0", main: "index.js" }), "@playwright/test/index.js": "module.exports = 'new';\n", "left/lib/a.js": "a\n" };
        writeComplete(completeRoot, target, bundleB, newTools, { damage: "node_modules/left/lib/a.js" });
        const kit = writeKit(bundleA, versionA, { complete: true });
        const r1 = runnerOn(kit);
        const offer1 = updates.offer(r1.agent())!;
        expect(offer1.complete?.parts.map((p) => p.folder)).toEqual(["node_modules"]);
        r1.u.attach(bridge(updates, r1.agent).client, r1.log);
        r1.u.connected("agent-1", offer1);
        await until("failed", () => r1.u.status().state === "failed");
        expect(r1.u.status().error).toBe("The file node_modules/left/lib/a.js of the update is damaged (its checksum does not match). Nothing was changed.");
        expect(fs.readFileSync(path.join(kit, "node_modules", "@playwright", "test", "index.js"), "utf8")).toBe("module.exports = 'old';\n");

        // A good build: the new node_modules is switched in, the old one kept for a rollback.
        writeComplete(completeRoot, target, bundleB, newTools);
        const kit2 = writeKit(bundleA, versionA, { complete: true });
        const r2 = runnerOn(kit2);
        r2.u.attach(bridge(updates, r2.agent).client, r2.log);
        r2.u.connected("agent-1", updates.offer(r2.agent()));
        await until("ready", () => r2.u.status().state === "ready" || r2.u.status().state === "failed");
        expect(r2.u.status().state, r2.lines.join("\n")).toBe("ready");
        expect(await r2.u.hold(idle)).toBe(RUNNER_UPDATE_EXIT);
        expect(fs.readFileSync(path.join(kit2, "node_modules", "@playwright", "test", "index.js"), "utf8")).toBe("module.exports = 'new';\n");
        expect(fs.readFileSync(path.join(kit2, "node_modules", "left", "lib", "a.js"), "utf8")).toBe("a\n");
        expect(fs.existsSync(path.join(kit2, "node_modules", ".aitp-complete"))).toBe(true);
        expect(fs.readFileSync(path.join(kit2, ".update", "previous", "node_modules", "@playwright", "test", "index.js"), "utf8")).toBe("module.exports = 'old';\n");
        // A rollback puts the old test tools back too.
        expect(new RunnerUpdater({ kitDir: kit2, version: versionB }).rollback("test")).toBe(true);
        expect(fs.readFileSync(path.join(kit2, "node_modules", "@playwright", "test", "index.js"), "utf8")).toBe("module.exports = 'old';\n");
        expect(fs.existsSync(path.join(kit2, "node_modules", "left"))).toBe(false);
    });

    it("a complete download whose server has no complete build for it says so instead of guessing", async () => {
        versionB = writeBundle(bundleB, "1.1.0", { pw: "1.64.0" });
        const kit = writeKit(bundleA, versionA, { complete: true });
        const r = runnerOn(kit);
        r.u.attach(bridge(updates, r.agent).client, r.log);
        r.u.connected("agent-1", updates.offer(r.agent()));
        await until("failed", () => r.u.status().state === "failed");
        expect(r.u.status().error).toMatch(/^This update needs new test tools, and the platform has no complete download for this computer/);
    });

    it("the plain files kit installs new test tools with npm into the staging folder (a stand-in npm here), and says when npm is missing", async () => {
        versionB = writeBundle(bundleB, "1.1.0", { pw: "1.64.0" });
        const fakeNpm = path.join(fresh("npm"), "npm-cli.js");
        fs.writeFileSync(
            fakeNpm,
            `const fs=require("fs"),p=require("path");if(process.argv[2]!=="install")process.exit(5);if(process.env.NODE_USE_SYSTEM_CA!=="1")process.exit(6);const d=p.join(process.cwd(),"node_modules","@playwright","test");fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"package.json"),JSON.stringify({name:"@playwright/test",version:"1.64.0",main:"index.js"}));fs.writeFileSync(p.join(d,"index.js"),"module.exports='npm';");`,
        );
        fs.renameSync(fakeNpm, fakeNpm.replace(/\.js$/, ".cjs"));
        const kit = writeKit(bundleA, versionA);
        const r = runnerOn(kit, versionA, { env: { ...process.env, AITP_UPDATE_NPM_CLI: fakeNpm.replace(/\.js$/, ".cjs") } });
        r.u.attach(bridge(updates, r.agent).client, r.log);
        r.u.connected("agent-1", updates.offer(r.agent()));
        await until("ready", () => r.u.status().state === "ready" || r.u.status().state === "failed");
        expect(r.u.status().state, JSON.stringify(r.u.status())).toBe("ready");
        expect(await r.u.hold(idle)).toBe(RUNNER_UPDATE_EXIT);
        expect(fs.readFileSync(path.join(kit, "node_modules", "@playwright", "test", "index.js"), "utf8")).toBe("module.exports='npm';");

        const kit2 = writeKit(bundleA, versionA);
        const r2 = runnerOn(kit2, versionA, { execPath: path.join(fresh("nonode"), "node.exe"), env: { ...process.env, AITP_UPDATE_NPM_CLI: "" } });
        r2.u.attach(bridge(updates, r2.agent).client, r2.log);
        r2.u.connected("agent-1", updates.offer(r2.agent()));
        await until("failed", () => r2.u.status().state === "failed");
        expect(r2.u.status().error).toMatch(/npm was not found/);
    });

    it("a runner without runner.mjs in a writable folder cannot update and reports so; a hint is ignored while it cannot", () => {
        const dir = fresh("checkout");
        const u = new RunnerUpdater({ kitDir: dir, version: "x" });
        expect(u.status().can).toBe(false);
        u.consider({ version: versionB, reason: "requested", files: [] } as unknown as RunnerUpdateOffer);
        expect(u.holding()).toBe(false);
    });
});
