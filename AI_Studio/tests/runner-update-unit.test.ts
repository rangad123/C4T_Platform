/**
 * Runner updates without a server: the platform's side (which runner is offered what, the files, the setting, Activity) and the runner's
 * updater (download and check, staging, the self-test, the switch, rollback, an interrupted switch, back-off, the hourly cap, new test tools
 * from a complete download's pack or from npm). The two halves are joined in-process: the runner's "client" fetches its files from the
 * platform's RunnerUpdates object, so the checksums the runner checks are the ones the platform announces.
 *
 * Signed updates (round 39): every bundle here is signed with a TEST key pair made in this file (scripts/sign-runner-update.mjs), and
 * both halves trust only that key. The signature checks: a good signature is installed; a missing or bad one, a key the runner does not
 * trust, an offer that names files other than the signed ones, and a bundle changed after signing are refused before anything is
 * downloaded ("needs-manual" on the runner, no offer at all on the platform).
 *
 * Fast tier (no browser, no server). Real files in temp folders, real child processes for the self-test and the stand-in npm.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
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
import { keyIdOf, partListBytes as partListBytesTs, verifySignedManifest } from "../src/agent-protocol/update-manifest.js";
import { PINNED_UPDATE_KEYS, UPDATE_KEYS } from "../src/agent/update-keys.js";
// @ts-expect-error plain JavaScript script (no type declarations)
import { buildUpdateManifest, newKeyPair, partListBytes as partListBytesMjs, publicKeyOf, signUpdate } from "../scripts/sign-runner-update.mjs";

/** A test key pair, made here and never written anywhere but memory. */
const testKey = generateKeyPairSync("ed25519");
const TEST_PEM = testKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const TEST_PUB: string = publicKeyOf(testKey.privateKey).raw;
const otherKey = generateKeyPairSync("ed25519");
const OTHER_PEM = otherKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const OTHER_PUB: string = publicKeyOf(otherKey.privateKey).raw;
/** Sign the bundle in `dir` (and the complete builds RUNNER_COMPLETE_DIR points at) as the deploy does; each signature a larger sequence. */
let sequence = 1_000_000;
const signBundle = (dir: string, pem = TEST_PEM) => signUpdate({ kitDir: dir, completeDir: process.env.RUNNER_COMPLETE_DIR, privateKeyPem: pem, sequence: ++sequence });

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
function writeBundle(dir: string, version: string, opts: { pw?: string; brokenRunner?: boolean; lock?: boolean; unsigned?: boolean } = {}): string {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ["update-manifest.json", "update-manifest.sig", "package-lock.json"]) fs.rmSync(path.join(dir, f), { force: true });
    const files: Record<string, string> = {
        "runner.mjs": opts.brokenRunner ? `// ${version}\nprocess.exit(3);\n` : program(version),
        "task-child.mjs": `// task child ${version}\n`,
        "record-child.mjs": `// record child ${version}\n`,
        "package.json": pkgJson(opts.pw ?? "1.63.0"),
        "LICENSES.txt": "licences\n",
        ...(opts.lock ? { "package-lock.json": `${JSON.stringify({ name: "ai-test-runner-kit", lockfileVersion: 3, requires: true, packages: {} })}\n` } : {}),
    };
    const list = Object.entries(files).map(([name, text]) => {
        fs.writeFileSync(path.join(dir, name), text);
        return { name, bytes: Buffer.byteLength(text), sha256: sha(text) };
    });
    const hash = sha(list.map((f) => `${f.name}\0${f.sha256}\n`).join(""));
    const kitVersion = `${version}+${hash.slice(0, 10)}`;
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: 1, platformVersion: version, hash, kitVersion, nodeMin: 24, files: list }));
    if (!opts.unsigned) signBundle(dir);
    return kitVersion;
}

/** A complete build for one target, in the layout loadComplete checks (pack.bin of deflated files, manifest with offsets and checksums). */
function writeComplete(root: string, target: string, bundleDir: string, nodeModules: Record<string, string>, opts: { damage?: string; unsigned?: boolean } = {}): void {
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
    // The deploy signs after the complete downloads are built, so their parts are in the signed manifest.
    if (!opts.unsigned) signBundle(bundleDir);
}

/** A runner's folder as a download leaves it, on version `from`, with a stand-in @playwright/test so the new program's packages resolve. */
function writeKit(bundleDir: string, kitVersion: string, opts: { complete?: boolean; extra?: Record<string, unknown> } = {}): string {
    // (runner.json "updateSequence" is left out unless a test sets it in `extra`: a download made before signed updates.)
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
/** An "update automatically" off (0) left by an earlier release: no longer read. */
const setAuto = (on: Db, agentId: string, auto: boolean) =>
    on.run("INSERT INTO runner_update_settings (agent_id, auto, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET auto = excluded.auto", agentId, auto ? null : 0, new Date().toISOString());

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
    updates = new RunnerUpdates({ db, activity: (r) => rows.push(r), publicKeys: [TEST_PUB] });
});
afterEach(() => {
    db.close();
    delete process.env.AITP_UPDATE_NPM_CLI;
});

/** A runner's updater that trusts the test key (as a runner built with that key would). */
const updater = (o: ConstructorParameters<typeof RunnerUpdater>[0]) => new RunnerUpdater({ publicKeys: [TEST_PUB], ...o });

function runnerOn(kit: string, version = versionA, extra: Partial<ConstructorParameters<typeof RunnerUpdater>[0]> = {}) {
    const u = updater({ kitDir: kit, version, ...extra });
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
    });
});

describe("the platform's side", () => {
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
        // The deploy's signed manifest goes with it, unchanged, and it covers exactly the offered files.
        expect(offer.signed!.manifest).toBe(fs.readFileSync(path.join(bundleB, "update-manifest.json"), "utf8"));
        expect(offer.signed!.signature).toBe(fs.readFileSync(path.join(bundleB, "update-manifest.sig"), "utf8"));
        const v = verifySignedManifest(offer.signed!.manifest, offer.signed!.signature, [TEST_PUB]);
        expect(v.ok && v.manifest.files.map((f) => f.name).sort()).toEqual(offer.files.map((f) => f.name).sort());
        expect(updates.publicView(agent)).toMatchObject({ published: true });
        expect(offer.files.map((f) => f.name).sort()).toEqual(["LICENSES.txt", "package.json", "record-child.mjs", "runner.mjs", "task-child.mjs"]);
        for (const f of offer.files) expect(f.sha256).toBe(sha(fs.readFileSync(path.join(bundleB, f.name))));
        expect(offer.complete).toBeUndefined();
        // A runner from a checkout or an older download (no update.can), or one already current, is offered nothing.
        expect(updates.offer({ ...agent, capabilities: { ...agent.capabilities, update: undefined } })).toBeUndefined();
        expect(updates.offer({ ...agent, capabilities: { ...agent.capabilities, kitVersion: versionB } })).toBeUndefined();
        // Only files an offer can name are served.
        expect(updates.file("runner.mjs")!.sha256).toBe(offer.files.find((f) => f.name === "runner.mjs")!.sha256);
        for (const name of ["runner.json", "runner.token", "manifest.json", "update-manifest.json", "update-manifest.sig", "complete-win-x64-node_modules.json", "../x"]) expect(updates.file(name), name).toBeUndefined();
    });

    it("updates are always on here: an old \"update automatically\" off is not read; a request is settled by the runner's report; Activity once per report", () => {
        const kit = writeKit(bundleA, versionA);
        const { u } = runnerOn(kit);
        const agent = { id: "a2", name: "Maya", projectId: "p1", node: process.version, capabilities: caps(u, versionA) };
        setAuto(db, "a2", false);
        expect(updates.wanted(agent)).toBe("auto");
        expect(updates.publicView(agent)).toMatchObject({ can: true, auto: true, outOfDate: true, latest: versionB, requested: false });
        updates.request("a2");
        expect(updates.wanted(agent)).toBe("requested");
        // The request survives a restart of the platform (a row in the database every process sees).
        const again = new RunnerUpdates({ db, publicKeys: [TEST_PUB] });
        expect(again.publicView(agent)).toMatchObject({ auto: true, requested: true });
        // The runner reports a failure: one Activity row, the request is settled, the row says why.
        const at = new Date().toISOString();
        const failed = { ...agent.capabilities, update: { can: true, state: "failed" as const, to: versionB, error: "The file runner.mjs arrived damaged.", at } };
        updates.observe(agent, failed);
        updates.observe(agent, failed);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: "runner-update-failed", projectId: "p1", agentName: "Maya" });
        expect(rows[0]!.detail).toContain(`Still on version ${versionA}`);
        // Settled: back to the automatic offer (the runner's own backoff paces the retry).
        expect(updates.wanted({ ...agent, capabilities: failed })).toBe("auto");
        expect(updates.publicView({ ...agent, capabilities: failed })).toMatchObject({ state: "failed", error: "The file runner.mjs arrived damaged.", requested: false });
        // An "updated" report is one more row.
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
        expect(JSON.parse(fs.readFileSync(path.join(kit, "runner.json"), "utf8"))).toEqual({ url: "https://platform.example", name: "Maya", kitVersion: versionB, proxy: "http://proxy.example:8080", browser: "chrome", updateSequence: expect.any(Number) });
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
        const back = updater({ kitDir: kit, version: versionA });
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

    it("the plain files kit never runs npm install for an update: without the lock file it refuses; with it, it says when npm is missing", async () => {
        versionB = writeBundle(bundleB, "1.1.0", { pw: "1.64.0" });
        const fakeNpm = path.join(fresh("npm"), "npm-cli.cjs");
        fs.writeFileSync(fakeNpm, `require("fs").writeFileSync(require("path").join(process.cwd(), "..", "npm-ran"), "yes"); process.exit(0);`);
        const kit = writeKit(bundleA, versionA);
        const r = runnerOn(kit, versionA, { env: { ...process.env, AITP_UPDATE_NPM_CLI: fakeNpm } });
        r.u.attach(bridge(updates, r.agent).client, r.log);
        r.u.connected("agent-1", updates.offer(r.agent()));
        await until("failed", () => r.u.status().state === "failed");
        expect(r.u.status().error).toMatch(/came without their lock file, so they were not installed \(an update never runs npm install without one\)/);
        expect(fs.existsSync(path.join(kit, ".update", "npm-ran"))).toBe(false);
        expect(fs.readFileSync(path.join(kit, "runner.mjs"), "utf8")).toContain("1.0.0");

        versionB = writeBundle(bundleB, "1.1.0", { pw: "1.64.0", lock: true });
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

describe("signed updates (round 39)", () => {
    const agentOf = (u: RunnerUpdater) => ({ id: "agent-s", name: "Signed", projectId: "p1", node: process.version, capabilities: caps(u, u.version) });

    it("the platform offers nothing without a signature, with a key the runners do not trust, or when a file changed after signing, and says why", () => {
        const kit = writeKit(bundleA, versionA);
        const { u } = runnerOn(kit);
        const agent = agentOf(u);
        expect(updates.offer(agent)).toBeDefined();
        // No signature (the deploy had no RUNNER_UPDATE_SIGNING_KEY).
        versionB = writeBundle(bundleB, "1.1.0", { unsigned: true });
        expect(updates.wanted(agent)).toBeUndefined();
        expect(updates.hint(agent)).toBeUndefined();
        expect(updates.offer(agent)).toBeUndefined();
        expect(updates.publicView(agent)).toMatchObject({ outOfDate: true, published: false, unpublished: expect.stringMatching(/not signed .*RUNNER_UPDATE_SIGNING_KEY/) });
        // Signed with another key.
        signBundle(bundleB, OTHER_PEM);
        expect(updates.offer(agent)).toBeUndefined();
        expect(updates.publicView(agent).unpublished).toMatch(/signed with a key this runner does not trust/);
        // Signed, then a file changed (and the bundle's own manifest with it): the signature no longer covers what would be served.
        signBundle(bundleB);
        expect(updates.offer(agent)).toBeDefined();
        fs.writeFileSync(path.join(bundleB, "task-child.mjs"), "// changed after signing\n");
        const m = JSON.parse(fs.readFileSync(path.join(bundleB, "manifest.json"), "utf8"));
        const f = m.files.find((x: { name: string }) => x.name === "task-child.mjs");
        f.bytes = Buffer.byteLength("// changed after signing\n");
        f.sha256 = sha("// changed after signing\n");
        fs.writeFileSync(path.join(bundleB, "manifest.json"), JSON.stringify(m));
        expect(updates.offer(agent)).toBeUndefined();
        expect(updates.publicView(agent).unpublished).toMatch(/task-child\.mjs of the update is not the one that was signed/);
        // "Update this runner" has nothing to send either.
        updates.request(agent.id);
        expect(updates.wanted(agent)).toBeUndefined();
    });

    it("a runner installs a well-signed update; a bad, missing or foreign signature, or an offer that names other files, is refused before any download", async () => {
        const cases: Array<[string, (o: RunnerUpdateOffer) => RunnerUpdateOffer, RegExp, readonly string[]]> = [
            ["no signature", (o) => ({ ...o, signed: undefined }), /without a signature/, [TEST_PUB]],
            ["a changed manifest", (o) => ({ ...o, signed: { ...o.signed!, manifest: o.signed!.manifest.replace(versionB, `${versionB}x`) } }), /signature does not match its manifest/, [TEST_PUB]],
            ["a foreign key", (o) => o, /signed with a key this runner does not trust/, [OTHER_PUB]],
            ["no key built in", (o) => o, /no update key built in/, []],
            ["another file in the offer", (o) => ({ ...o, files: o.files.map((f) => (f.name === "runner.mjs" ? { ...f, sha256: sha("evil") } : f)) }), /runner\.mjs of the update is not the one that was signed/, [TEST_PUB]],
            ["another version in the offer", (o) => ({ ...o, version: "9.9.9+evil" }), /offers version 9\.9\.9\+evil, but version .* was signed/, [TEST_PUB]],
        ];
        for (const [label, change, why, keys] of cases) {
            const kit = writeKit(bundleA, versionA);
            const { u, log, lines, agent } = runnerOn(kit, versionA, { publicKeys: keys });
            const { client, asked } = bridge(updates, agent);
            u.attach(client, log);
            const before = fs.readFileSync(path.join(kit, "runner.mjs"), "utf8");
            u.connected("agent-1", change(updates.offer(agent())!));
            // Refused at once: nothing downloaded, nothing held back, the runner keeps taking tasks.
            expect(u.holding(), label).toBe(false);
            expect(asked, label).toEqual([]);
            const st = u.status();
            expect(st.state, label).toBe("needs-manual");
            expect(st.error, label).toMatch(why);
            expect(st.retryAt, label).toBeDefined();
            expect(fs.readFileSync(path.join(kit, "runner.mjs"), "utf8"), label).toBe(before);
            expect(fs.existsSync(path.join(kit, ".update", "next")), label).toBe(false);
            expect(lines.join("\n"), label).toMatch(/was not installed: .* Choose Update now in Settings, Your runner, or download the runner again there\./);
            // The platform writes it to Activity once and Settings can say "download the new version".
            rows.length = 0;
            updates.observe({ id: "agent-1", name: "Maya", projectId: "p1" }, caps(u, versionA));
            updates.observe({ id: "agent-1", name: "Maya", projectId: "p1" }, caps(u, versionA));
            expect(rows, label).toHaveLength(1);
            expect(rows[0]!.detail, label).toMatch(/did not install version .* by itself: .*\./);
            expect(updates.publicView({ id: "agent-1", capabilities: caps(u, versionA) }).state, label).toBe("needs-manual");
            db.run("DELETE FROM runner_update_settings");
        }
        // The same offer, unchanged, with the right key: installed.
        const kit = writeKit(bundleA, versionA);
        const { u, log, lines, agent } = runnerOn(kit);
        u.attach(bridge(updates, agent).client, log);
        u.connected("agent-1", updates.offer(agent()));
        await until("ready", () => u.status().state === "ready" || u.status().state === "failed" || u.status().state === "needs-manual");
        expect(u.status().state, lines.join("\n")).toBe("ready");
        expect(await u.hold(idle)).toBe(RUNNER_UPDATE_EXIT);
        expect(fs.readFileSync(path.join(kit, "runner.mjs"), "utf8")).toBe(fs.readFileSync(path.join(bundleB, "runner.mjs"), "utf8"));
    });

    it("prepare() checks the signature too, so no caller can skip it", async () => {
        const kit = writeKit(bundleA, versionA);
        const { u, log, agent } = runnerOn(kit);
        u.attach(bridge(updates, agent).client, log);
        const offer = updates.offer(agent())!;
        await expect(u.prepare({ ...offer, signed: undefined }, new AbortController().signal)).rejects.toThrow(/without a signature\. Nothing was changed\./);
    });

    it("the lock file travels in the signed update and the plain files kit installs from it with npm ci --ignore-scripts", async () => {
        versionB = writeBundle(bundleB, "1.1.0", { pw: "1.64.0", lock: true });
        const offer = updates.offer({ id: "a-lock", node: process.version, capabilities: caps(updater({ kitDir: writeKit(bundleA, versionA), version: versionA }), versionA) })!;
        expect(offer.files.map((f) => f.name)).toContain("package-lock.json");
        const fakeNpm = path.join(fresh("npm"), "npm-cli.cjs");
        fs.writeFileSync(
            fakeNpm,
            `const fs=require("fs"),p=require("path");fs.writeFileSync(p.join(process.cwd(),"..","npm-args.json"),JSON.stringify(process.argv.slice(2)));if(!fs.existsSync("package-lock.json"))process.exit(7);const d=p.join(process.cwd(),"node_modules","@playwright","test");fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"package.json"),JSON.stringify({name:"@playwright/test",version:"1.64.0",main:"index.js"}));fs.writeFileSync(p.join(d,"index.js"),"module.exports='ci';");`,
        );
        const kit = writeKit(bundleA, versionA);
        const r = runnerOn(kit, versionA, { env: { ...process.env, AITP_UPDATE_NPM_CLI: fakeNpm } });
        r.u.attach(bridge(updates, r.agent).client, r.log);
        r.u.connected("agent-1", updates.offer(r.agent()));
        await until("ready", () => r.u.status().state === "ready" || r.u.status().state === "failed");
        expect(r.u.status().state, JSON.stringify(r.u.status())).toBe("ready");
        expect(JSON.parse(fs.readFileSync(path.join(kit, ".update", "npm-args.json"), "utf8"))).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
        expect(await r.u.hold(idle)).toBe(RUNNER_UPDATE_EXIT);
        expect(fs.readFileSync(path.join(kit, "package-lock.json"), "utf8")).toBe(fs.readFileSync(path.join(bundleB, "package-lock.json"), "utf8"));
        // Going back to the version without a lock file takes the lock file away too.
        expect(updater({ kitDir: kit, version: versionB }).rollback("test")).toBe(true);
        expect(fs.existsSync(path.join(kit, "package-lock.json"))).toBe(false);
    });

    it("the sign script hashes every file again, signs a manifest the runner reads, and makes the same part lists the platform serves", () => {
        const target = targetOfAgent({ os: process.platform as Capabilities["os"], arch: process.arch })!;
        const completeRoot = path.join(platformDir, "complete-sign");
        process.env.RUNNER_COMPLETE_DIR = completeRoot;
        writeComplete(completeRoot, target, bundleB, { "@playwright/test/package.json": "{}", "x/y.js": "y\n" });
        const { manifest } = buildUpdateManifest({ kitDir: bundleB, completeDir: completeRoot, signedAt: "2026-11-07T00:00:00.000Z" });
        expect(manifest.version).toBe(versionB);
        const cm = JSON.parse(fs.readFileSync(path.join(completeRoot, target, "manifest.json"), "utf8"));
        for (const folder of ["node_modules", "node"] as const) {
            const mjs: Buffer = partListBytesMjs(cm.files, folder);
            expect(mjs.equals(partListBytesTs(cm.files, folder)), folder).toBe(true);
            expect(manifest.complete[target].parts[folder].list.sha256).toBe(sha(mjs));
            // What the platform serves under that name is exactly the signed list.
            expect(sha(updates.file(`complete-${target}-${folder}.json`)!.body as Buffer)).toBe(sha(mjs));
        }
        // A bundle whose files do not match its manifest is refused, not signed.
        fs.appendFileSync(path.join(bundleB, "LICENSES.txt"), "x");
        expect(() => signBundle(bundleB)).toThrow(/is damaged \(LICENSES\.txt does not match its manifest\)/);
        // The key id is the same on both sides; a non-Ed25519 or broken key is refused with a sentence.
        expect(publicKeyOf(testKey.privateKey).keyId).toBe(keyIdOf(TEST_PUB));
        const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
        writeBundle(bundleB, "1.1.0", { unsigned: true });
        expect(() => signBundle(bundleB, rsa)).toThrow(/not an Ed25519 key/);
        expect(() => signBundle(bundleB, "nonsense")).toThrow(/not a private key in PEM form/);
        expect(fs.existsSync(path.join(bundleB, "update-manifest.sig"))).toBe(false);
    });

    it("refuses an update not newer than the installed one (an old signed update sent again), and records the new sequence after a switch", async () => {
        const offer = () => updates.offer({ id: "a-seq", node: process.version, capabilities: caps(updater({ kitDir: writeKit(bundleA, versionA), version: versionA }), versionA) })!;
        const signedSeq = (JSON.parse(offer().signed!.manifest) as { sequence: number }).sequence;
        for (const installed of [signedSeq, signedSeq + 5]) {
            const kit = writeKit(bundleA, versionA, { extra: { updateSequence: installed } });
            const { u, log, agent } = runnerOn(kit);
            const { client, asked } = bridge(updates, agent);
            u.attach(client, log);
            u.connected("agent-1", updates.offer(agent()));
            expect(u.status(), String(installed)).toMatchObject({ state: "needs-manual", error: expect.stringMatching(/not newer than the version this runner runs/) });
            expect(asked).toEqual([]);
        }
        // An older installed sequence: taken, and runner.json then says the new one, so the old manifest can never come back.
        const kit = writeKit(bundleA, versionA, { extra: { updateSequence: signedSeq - 1 } });
        const { u, log, agent } = runnerOn(kit);
        u.attach(bridge(updates, agent).client, log);
        u.connected("agent-1", updates.offer(agent()));
        await until("ready", () => u.status().state === "ready" || u.status().state === "failed");
        expect(await u.hold(idle)).toBe(RUNNER_UPDATE_EXIT);
        expect(JSON.parse(fs.readFileSync(path.join(kit, "runner.json"), "utf8")).updateSequence).toBe(signedSeq);
        const after = updater({ kitDir: kit, version: versionB });
        expect(after.signatureProblem(offer())).toMatch(/not newer/);
    });

    it("the complete download's part lists are signed: a list or pack size the server changed is refused before anything is downloaded", () => {
        const target = targetOfAgent({ os: process.platform as Capabilities["os"], arch: process.arch })!;
        const completeRoot = path.join(platformDir, "complete-parts");
        process.env.RUNNER_COMPLETE_DIR = completeRoot;
        versionB = writeBundle(bundleB, "1.1.0", { pw: "1.64.0" });
        writeComplete(completeRoot, target, bundleB, { "@playwright/test/package.json": "{}" });
        const kit = writeKit(bundleA, versionA, { complete: true });
        const { u, log, agent } = runnerOn(kit);
        const good = updates.offer(agent())!;
        expect(good.complete?.parts.map((p) => p.folder)).toEqual(["node_modules"]);
        expect(u.signatureProblem(good)).toBeUndefined();
        const part = good.complete!.parts[0]!;
        const changed: Array<[string, RunnerUpdateOffer]> = [
            ["list checksum", { ...good, complete: { ...good.complete!, parts: [{ ...part, list: { ...part.list, sha256: sha("other list") } }] } }],
            ["pack size", { ...good, complete: { ...good.complete!, parts: [{ ...part, pack: { ...part.pack, size: part.pack.size + 1 } }] } }],
            ["another target", { ...good, complete: { ...good.complete!, target: "linux-arm64" } }],
            ["a node part nobody signed", { ...good, complete: { ...good.complete!, nodeVersion: "v99.0.0" } }],
        ];
        for (const [label, offer] of changed) {
            const { client, asked } = bridge(updates, agent);
            const fresh2 = runnerOn(writeKit(bundleA, versionA, { complete: true }));
            fresh2.u.attach(client, log);
            fresh2.u.connected("agent-1", offer);
            expect(fresh2.u.status().state, label).toBe("needs-manual");
            expect(fresh2.u.status().error, label).toMatch(/was not signed|is not the one that was signed/);
            expect(asked, label).toEqual([]);
        }
        void u;
    });

    it("runs nothing it downloaded before the signature checks: a runner.mjs whose --version self-test leaves a mark is never started", async () => {
        // Version B's program writes a file when it is started for the self-test.
        const markDir = fresh("mark");
        const mark = path.join(markDir, "self-test-ran");
        versionB = writeBundle(bundleB, "1.1.0");
        const evil = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(mark)}, "ran");\nconsole.log("ai-test-agent 1.0.0");\n`;
        fs.writeFileSync(path.join(bundleB, "runner.mjs"), evil);
        const m = JSON.parse(fs.readFileSync(path.join(bundleB, "manifest.json"), "utf8"));
        Object.assign(m.files.find((x: { name: string }) => x.name === "runner.mjs"), { bytes: Buffer.byteLength(evil), sha256: sha(evil) });
        fs.writeFileSync(path.join(bundleB, "manifest.json"), JSON.stringify(m));
        // Signed by a key the runner does not trust: refused, the program never ran.
        signBundle(bundleB, OTHER_PEM);
        const lenient = new RunnerUpdates({ db, publicKeys: [OTHER_PUB] });
        const kit = writeKit(bundleA, versionA);
        const { u, log, agent } = runnerOn(kit);
        u.attach({ ...bridge(lenient, agent).client, updateOffer: async () => lenient.offer(agent()) } as unknown as PlatformClient, log);
        u.connected("agent-1", lenient.offer(agent()));
        await new Promise((r) => setTimeout(r, 300));
        expect(u.status().state).toBe("needs-manual");
        expect(fs.existsSync(mark)).toBe(false);
        // The same files signed with the trusted key: now (and only now) the self-test starts it.
        signBundle(bundleB);
        const r2 = runnerOn(writeKit(bundleA, versionA));
        r2.u.attach(bridge(updates, r2.agent).client, r2.log);
        r2.u.connected("agent-1", updates.offer(r2.agent()));
        await until("self-test", () => fs.existsSync(mark) || r2.u.status().state === "failed");
        expect(fs.existsSync(mark)).toBe(true);
    });

    it("--new-key writes the private key readable only by its owner, never over a file, and prints only the public key; the source pins no test key", () => {
        const dir = fresh("keys");
        const file = path.join(dir, "k.pem");
        const pub = newKeyPair(file);
        expect(fs.readFileSync(file, "utf8")).toMatch(/^-----BEGIN PRIVATE KEY-----/);
        if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(() => newKeyPair(file)).toThrow();
        expect(Buffer.from(pub.raw, "base64")).toHaveLength(32);
        // The real key is the user's to make: nothing in the source is a key made by a test, and the default list is what the source says.
        expect(UPDATE_KEYS).toEqual(PINNED_UPDATE_KEYS);
        for (const k of PINNED_UPDATE_KEYS) expect([TEST_PUB, OTHER_PUB, pub.raw]).not.toContain(k);
        const script = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts", "sign-runner-update.mjs"), "utf8");
        expect(script).not.toMatch(/console\.log\([^)]*(pem|privateKey)/i);
    });
});
