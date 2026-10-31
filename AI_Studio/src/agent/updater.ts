/**
 * The runner keeps itself up to date (docs/features/runner-updates.md).
 *
 * Only a runner started from a download (a runner.json next to runner.mjs, with a kit version) can update itself; a checkout-based runner
 * never does. When the platform runs a newer runner version it says so (the hello answer, or the x-runner-update header of a poll answer).
 * The runner then:
 *   1. stops claiming new tasks (it keeps polling with no free slot, so it stays online) and lets the running ones finish;
 *   2. downloads the update over its own authenticated connection into .update/next and checks every file against the sha256 in the
 *      offer (a file that does not match is refused and nothing changes); new test tools come from the complete download's pack (checked
 *      file by file) or, for the plain files kit, from `npm install` into the staging folder; a new pinned Node.js is staged in .update/node-next;
 *   3. starts the new runner.mjs once with --version (it must load with this computer's Node.js and packages) before anything is switched;
 *   4. switches: the current files are copied to .update/previous (one rollback), the new ones are renamed into place one by one, runner.mjs
 *      last, under a journal in .update/state.json so an interrupted switch is undone at the next start;
 *   5. exits with RUNNER_UPDATE_EXIT (75): the start script or the installer's launcher starts it again at once (and swaps in a staged
 *      Node.js). Older start scripts restart it after 5 seconds, as after any unexpected stop.
 * The new version confirms itself with its first successful hello. If it starts three times without connecting it puts the previous files
 * back by itself and exits 75 again; `node runner.mjs --rollback` does the same by hand. A version rolled back from is not tried again
 * automatically. Failures back off (5, 15, 45 minutes, at most an hour) and there are at most 3 attempts an hour.
 *
 * The token is never part of an update: it stays in runner.token, which is never touched, and the requests carry it only in their header.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";
import { RUNNER_UPDATE_EXIT, UpdatePartList, type RunnerUpdateOffer, type RunnerUpdateState, type UpdatePart } from "../agent-protocol/schema.js";
import type { PlatformClient } from "./client.js";
import type { Logger } from "./log.js";

export { RUNNER_UPDATE_EXIT };
export const UPDATE_DIR = ".update";
/** The bundle files an update replaces; runner.mjs goes last, so a half-done switch still starts the old program. */
export const UPDATE_FILES = ["LICENSES.txt", "package.json", "record-child.mjs", "task-child.mjs", "runner.mjs"] as const;
/** Starts of a new version without one successful connection before it is rolled back. */
export const MAX_UNCONFIRMED_STARTS = 3;
const HOUR = 3_600_000;
const MAX_LIST_BYTES = 32 * 1024 * 1024;

interface Persisted {
    format: 1;
    attempts: number[];
    failures: number;
    backoffUntil?: number;
    /** A version this runner went back from: not tried again automatically. */
    skip?: string;
    last?: { state: "updated" | "failed" | "rolled-back"; from?: string; to?: string; error?: string; at: string };
    /** The journal of a switch in progress (files are being renamed). */
    switching?: { from: string; to: string; at: string };
    /** A switch that happened and is waiting for the new version's first connection. */
    switched?: { from: string; to: string; at: string; starts: number; confirmed?: boolean };
}

/** A plain reason why an update did not happen. */
export class UpdateError extends Error {}

const sha256File = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const exists = (p: string): boolean => {
    try {
        fs.lstatSync(p);
        return true;
    } catch {
        return false;
    }
};

/** Rename, retrying briefly: on Windows a virus scanner can hold a just-written file for a moment. */
function renameRetry(from: string, to: string): void {
    for (let i = 0; ; i++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (i >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
    }
}

/** Remove a folder we made; a link (junction) inside is unlinked, never followed. */
const removeDir = (p: string): void => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        const keep = (d: Buffer) => {
            out = (out + d.toString("utf8")).slice(-8000);
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        const kill = () => child.kill();
        const timer = setTimeout(kill, opts.timeoutMs);
        opts.signal?.addEventListener("abort", kill, { once: true });
        child.on("error", () => undefined);
        child.on("close", (code) => {
            clearTimeout(timer);
            opts.signal?.removeEventListener("abort", kill);
            resolve({ code, out });
        });
    });
}

export interface UpdaterOptions {
    /** The folder of runner.mjs (the download's folder). */
    kitDir: string;
    /** The version in runner.json. */
    version: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    /** The Node.js running this runner (process.execPath) and its version. */
    execPath?: string;
    nodeVersion?: string;
    /** First back-off after a failure (default 5 minutes; AITP_UPDATE_RETRY_SECONDS changes it, for tests). */
    retryBaseMs?: number;
    maxPerHour?: number;
}

export interface HoldContext {
    /** Tasks running right now. */
    active(): number;
    /** A poll that cannot be given a task, so the runner stays online while it waits. */
    keepAlive(): Promise<unknown>;
    wait(ms: number): Promise<void>;
}

export class RunnerUpdater {
    readonly kitDir: string;
    readonly dir: string;
    version: string;
    private readonly env: NodeJS.ProcessEnv;
    private readonly now: () => number;
    private readonly execPath: string;
    private readonly nodeVersion: string;
    private readonly retryBaseMs: number;
    private readonly maxPerHour: number;
    private state: Persisted;
    private phase: "idle" | "preparing" | "ready" = "idle";
    private target?: RunnerUpdateOffer;
    private abort?: AbortController;
    private client?: PlatformClient;
    private log?: Logger;
    private agentId?: string;
    private lastAsked = 0;
    private lastKeepAlive = 0;
    private stopped = false;
    /** Set when the new Node.js is staged for the start script to swap in. */
    private nodeStaged = false;
    readonly writable: boolean;

    constructor(o: UpdaterOptions) {
        this.kitDir = o.kitDir;
        this.dir = path.join(o.kitDir, UPDATE_DIR);
        this.version = o.version;
        this.env = o.env ?? process.env;
        this.now = o.now ?? Date.now;
        this.execPath = o.execPath ?? process.execPath;
        this.nodeVersion = o.nodeVersion ?? process.version;
        const envBase = Number(this.env.AITP_UPDATE_RETRY_SECONDS);
        this.retryBaseMs = o.retryBaseMs ?? (Number.isFinite(envBase) && envBase > 0 ? envBase * 1000 : 5 * 60_000);
        this.maxPerHour = o.maxPerHour ?? 3;
        this.state = this.load();
        let writable = false;
        try {
            fs.accessSync(this.kitDir, fs.constants.W_OK);
            writable = fs.existsSync(path.join(this.kitDir, "runner.mjs"));
        } catch {
            writable = false;
        }
        this.writable = writable;
    }

    // ── what is kept on disk ────────────────────────────────────────────────

    private load(): Persisted {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(this.dir, "state.json"), "utf8")) as Partial<Persisted>;
            if (raw && raw.format === 1) return { format: 1, attempts: Array.isArray(raw.attempts) ? raw.attempts.filter((n) => typeof n === "number") : [], failures: Number(raw.failures) || 0, ...raw } as Persisted;
        } catch {
            /* nothing yet */
        }
        return { format: 1, attempts: [], failures: 0 };
    }

    private save(): void {
        fs.mkdirSync(this.dir, { recursive: true });
        const file = path.join(this.dir, "state.json");
        fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(this.state, null, 2)}\n`);
        renameRetry(`${file}.tmp`, file);
    }

    /** What the runner reports (Capabilities.update). */
    status(): RunnerUpdateState {
        const base: RunnerUpdateState = { can: this.writable, state: "idle" };
        const pkg = path.join(this.kitDir, "package.json");
        if (fs.existsSync(pkg)) base.packageSha256 = sha256File(pkg);
        if (this.isComplete()) base.complete = true;
        if (this.runsBundledNode()) base.bundledNode = true;
        if (this.phase !== "idle") return { ...base, state: this.phase, from: this.version, ...(this.target ? { to: this.target.version } : {}) };
        const l = this.state.last;
        const retry = this.retryAt();
        return { ...base, ...(l ? { state: l.state, ...(l.from ? { from: l.from } : {}), ...(l.to ? { to: l.to } : {}), ...(l.error ? { error: l.error.slice(0, 400) } : {}), at: l.at } : {}), ...(retry ? { retryAt: new Date(retry).toISOString() } : {}) };
    }

    private isComplete(): boolean {
        return fs.existsSync(path.join(this.kitDir, "node_modules", ".aitp-complete"));
    }

    private bundledNodePath(): string {
        return path.join(this.kitDir, "node", process.platform === "win32" ? "node.exe" : path.join("bin", "node"));
    }

    private runsBundledNode(): boolean {
        return path.resolve(this.execPath).toLowerCase() === path.resolve(this.bundledNodePath()).toLowerCase();
    }

    private retryAt(): number | undefined {
        const t = this.now();
        const recent = this.state.attempts.filter((a) => a > t - HOUR);
        const capped = recent.length >= this.maxPerHour ? Math.min(...recent) + HOUR : 0;
        const r = Math.max(capped, this.state.backoffUntil ?? 0);
        return r > t ? r : undefined;
    }

    // ── at program start ────────────────────────────────────────────────────

    /**
     * Called by index.ts before anything else. Finishes what an earlier run left: an interrupted switch is undone; a new version that keeps
     * starting without connecting is rolled back. Returns an exit code when the runner must restart at once (into the restored files).
     */
    startup(say: (line: string) => void): number | undefined {
        if (!this.writable) return undefined;
        if (this.state.switching) {
            const s = this.state.switching;
            this.restorePrevious();
            this.state.switching = undefined;
            this.state.skip = s.to;
            this.state.last = { state: "rolled-back", from: s.from, to: s.to, error: "The switch to the new version was interrupted, so the runner went back to the files it had.", at: new Date(this.now()).toISOString() };
            this.version = s.from;
            this.save();
            say(`The update to version ${s.to} was interrupted. The runner went back to version ${s.from} and starts again.`);
            return RUNNER_UPDATE_EXIT;
        }
        const sw = this.state.switched;
        if (sw && !sw.confirmed) {
            sw.starts += 1;
            if (sw.starts > MAX_UNCONFIRMED_STARTS) {
                const ok = this.rollback(`The new version started ${MAX_UNCONFIRMED_STARTS} times without connecting to the platform.`);
                say(ok ? `Version ${sw.to} did not connect after ${MAX_UNCONFIRMED_STARTS} starts. The runner went back to version ${sw.from} and starts again.` : `Version ${sw.to} did not connect after ${MAX_UNCONFIRMED_STARTS} starts, and no earlier version is kept to go back to.`);
                if (ok) return RUNNER_UPDATE_EXIT;
            } else this.save();
        }
        // Leftovers of an update that never finished (the program stopped while preparing), and a new Node.js the start script did not swap in.
        removeDir(path.join(this.dir, "next"));
        removeDir(path.join(this.dir, "discard"));
        if (exists(path.join(this.dir, "node-next"))) {
            removeDir(path.join(this.dir, "node-next"));
            say("A newer Node.js came with the last update, but this download's start script does not switch it in. The runner keeps its Node.js.");
        }
        return undefined;
    }

    // ── connected to the agent ──────────────────────────────────────────────

    attach(client: PlatformClient, log: Logger): void {
        this.client = client;
        this.log = log;
        client.updateState = () => this.status();
    }

    /** After every successful hello: the hello's offer, and the first connection of a freshly switched version confirms it. */
    connected(agentId: string, offer: RunnerUpdateOffer | undefined): void {
        this.agentId = agentId;
        const sw = this.state.switched;
        if (sw && !sw.confirmed) {
            sw.confirmed = true;
            this.state.failures = 0;
            this.state.backoffUntil = undefined;
            this.state.last = { state: "updated", from: sw.from, to: sw.to, at: new Date(this.now()).toISOString() };
            this.save();
            this.log?.info(`This runner updated itself from version ${sw.from} to ${sw.to}.`);
        }
        if (offer) this.consider(offer);
    }

    /** The header of a poll answer ("auto 1.2.0+abc"): ask the platform for the offer when it is worth it. */
    noteHint(hint: string | undefined): void {
        const m = /^(auto|requested) (\S{1,80})$/.exec(hint ?? "");
        if (!m || !this.client || !this.agentId) return;
        if (!this.wants(m[1] as "auto" | "requested", m[2]!)) return;
        if (this.now() - this.lastAsked < 60_000) return;
        this.lastAsked = this.now();
        this.client.updateOffer(this.agentId).then(
            (offer) => offer && this.consider(offer),
            (e) => this.log?.warn(`The runner could not ask the platform about its update: ${e instanceof Error ? e.message : "unknown problem"}`),
        );
    }

    private wants(reason: "auto" | "requested", version: string): boolean {
        if (!this.writable || this.stopped || this.phase !== "idle" || version === this.version) return false;
        if (reason === "auto" && this.state.skip === version) return false;
        const t = this.now();
        if (this.state.attempts.filter((a) => a > t - HOUR).length >= this.maxPerHour) return false;
        if (reason === "auto" && (this.state.backoffUntil ?? 0) > t) return false;
        return true;
    }

    /** Start preparing an offered update (in the background); no new tasks are claimed from now on. */
    consider(offer: RunnerUpdateOffer): void {
        if (!this.wants(offer.reason, offer.version)) return;
        this.phase = "preparing";
        this.target = offer;
        this.state.attempts = [...this.state.attempts.filter((a) => a > this.now() - HOUR), this.now()];
        this.save();
        this.log?.info(`The platform runs runner version ${offer.version} (this runner: ${this.version}). Updating: no new tasks are taken, running ones finish first.`);
        this.abort = new AbortController();
        this.prepare(offer, this.abort.signal).then(
            () => {
                if (this.phase !== "preparing") return;
                this.phase = "ready";
                this.log?.info(`The update to version ${offer.version} is downloaded and checked. It is switched in as soon as no task is running.`);
            },
            (e) => this.fail(offer.version, e),
        );
    }

    private fail(to: string, e: unknown): void {
        this.cleanStaging();
        this.phase = "idle";
        this.target = undefined;
        if (this.stopped) return;
        const reason = e instanceof UpdateError ? e.message : `${e instanceof Error ? e.message : "an unknown problem"}`;
        this.state.failures += 1;
        this.state.backoffUntil = this.now() + Math.min(HOUR, this.retryBaseMs * 3 ** (this.state.failures - 1));
        this.state.last = { state: "failed", from: this.version, to, error: reason.slice(0, 380), at: new Date(this.now()).toISOString() };
        this.save();
        this.log?.warn(`Could not update to version ${to}: ${reason} Still on version ${this.version}. The runner tries again later.`);
    }

    private cleanStaging(): void {
        for (const d of ["next", "parts", "node-next"]) removeDir(path.join(this.dir, d));
        this.nodeStaged = false;
    }

    /** True while an update is being prepared or waits for the running tasks: the agent claims no new task. */
    holding(): boolean {
        return this.phase !== "idle";
    }

    /** One turn of the agent's loop while holding. Returns RUNNER_UPDATE_EXIT once the new version is in place. */
    async hold(ctx: HoldContext): Promise<number | undefined> {
        if (this.phase === "ready" && ctx.active() === 0 && !this.stopped) return this.switchNow();
        if (this.now() - this.lastKeepAlive > 15_000) {
            this.lastKeepAlive = this.now();
            await ctx.keepAlive().catch(() => undefined);
        }
        await ctx.wait(1000);
        return undefined;
    }

    stop(): void {
        this.stopped = true;
        this.abort?.abort();
    }

    // ── preparing ───────────────────────────────────────────────────────────

    private async fetchChecked(name: string, size: number, sha256: string | undefined, dest: string, signal: AbortSignal): Promise<void> {
        const got = await this.client!.updateFile(name, size, dest, signal);
        if (got.size !== size || (sha256 && got.sha256 !== sha256)) throw new UpdateError(`The file ${name} of the update arrived damaged (its size or checksum does not match what the platform announced). Nothing was changed.`);
    }

    async prepare(offer: RunnerUpdateOffer, signal: AbortSignal): Promise<void> {
        if (!this.client) throw new UpdateError("The runner is not connected.");
        const next = path.join(this.dir, "next");
        this.cleanStaging();
        fs.mkdirSync(next, { recursive: true });
        const names = new Set<string>(UPDATE_FILES);
        for (const n of UPDATE_FILES) if (!offer.files.some((f) => f.name === n)) throw new UpdateError(`The update does not contain ${n}. Nothing was changed.`);
        for (const f of offer.files) {
            if (!names.has(f.name)) continue;
            await this.fetchChecked(f.name, f.size, f.sha256, path.join(next, f.name), signal);
        }
        // New test tools when package.json changed: from the complete download's pack, or npm for the plain files kit.
        const pkgChanged = !fs.existsSync(path.join(this.kitDir, "package.json")) || sha256File(path.join(this.kitDir, "package.json")) !== sha256File(path.join(next, "package.json"));
        if (pkgChanged) {
            const part = offer.complete?.parts.find((p) => p.folder === "node_modules");
            if (this.isComplete()) {
                if (!part) throw new UpdateError("This update needs new test tools, and the platform has no complete download for this computer to take them from. Ask the platform's owner to run npm run build:runner -- --complete, or download a new runner.");
                await this.unpackPart(part, path.join(next, "node_modules"), signal);
            } else await this.npmInstall(next, signal);
        }
        const nodePart = offer.complete?.parts.find((p) => p.folder === "node");
        let newNode: string | undefined;
        if (nodePart && this.runsBundledNode()) {
            const dest = path.join(this.dir, "node-next");
            await this.unpackPart(nodePart, dest, signal);
            newNode = path.join(dest, process.platform === "win32" ? "node.exe" : path.join("bin", "node"));
            const v = await run(newNode, ["--version"], { cwd: this.kitDir, env: this.env, timeoutMs: 30_000, signal });
            if (v.code !== 0 || v.out.trim() !== offer.complete!.nodeVersion) throw new UpdateError(`The Node.js ${offer.complete!.nodeVersion} that came with the update does not start on this computer. Nothing was changed.`);
        }
        // The new program must load with this computer's Node.js and packages before anything is switched.
        try {
            createRequire(path.join(next, "check.js")).resolve("@playwright/test");
        } catch {
            throw new UpdateError("The new version cannot find its test tools (@playwright/test). Nothing was changed.");
        }
        const self = await run(newNode ?? this.execPath, [path.join(next, "runner.mjs"), "--version"], { cwd: next, env: { ...this.env, AITP_URL: "", AITP_AGENT_TOKEN: "", AITP_AGENT_TOKEN_FILE: "" }, timeoutMs: 60_000, signal });
        if (signal.aborted) throw new UpdateError("The update was stopped.");
        if (self.code !== 0 || !/ai-test-agent /.test(self.out)) throw new UpdateError(`The new version did not start on this computer (exit code ${self.code ?? "none"}). Nothing was changed.`);
        this.nodeStaged = Boolean(newNode);
    }

    /** A complete-download part: its list (checked against the offer), then every file of its pack inflated and checked against the list. */
    private async unpackPart(part: UpdatePart, destDir: string, signal: AbortSignal): Promise<void> {
        const parts = path.join(this.dir, "parts");
        fs.mkdirSync(parts, { recursive: true });
        if (part.list.size > MAX_LIST_BYTES) throw new UpdateError("The update's file list is too large. Nothing was changed.");
        const listFile = path.join(parts, `${part.folder}.json`);
        await this.fetchChecked(part.list.name, part.list.size, part.list.sha256, listFile, signal);
        let list: ReturnType<typeof UpdatePartList.parse>;
        try {
            list = UpdatePartList.parse(JSON.parse(fs.readFileSync(listFile, "utf8")));
        } catch {
            throw new UpdateError("The update's file list could not be read. Nothing was changed.");
        }
        if (list.folder !== part.folder || list.files.reduce((n, f) => n + f.csize, 0) !== part.pack.size) throw new UpdateError("The update's file list does not match its pack. Nothing was changed.");
        const packFile = path.join(parts, `${part.folder}.pack`);
        await this.fetchChecked(part.pack.name, part.pack.size, undefined, packFile, signal);
        const fd = fs.openSync(packFile, "r");
        try {
            let pos = 0;
            for (const f of list.files) {
                if (signal.aborted) throw new UpdateError("The update was stopped.");
                const packed = Buffer.alloc(f.csize);
                if (f.csize > 0 && fs.readSync(fd, packed, 0, f.csize, pos) !== f.csize) throw new UpdateError("The update's pack ended early. Nothing was changed.");
                pos += f.csize;
                let data: Buffer;
                try {
                    data = f.size === 0 ? Buffer.alloc(0) : zlib.inflateRawSync(packed, { maxOutputLength: f.size });
                } catch {
                    throw new UpdateError(`The file ${part.folder}/${f.path} of the update is damaged. Nothing was changed.`);
                }
                if (data.length !== f.size || createHash("sha256").update(data).digest("hex") !== f.sha256) throw new UpdateError(`The file ${part.folder}/${f.path} of the update is damaged (its checksum does not match). Nothing was changed.`);
                const target = path.join(destDir, ...f.path.split("/"));
                if (!target.startsWith(destDir + path.sep)) throw new UpdateError("The update names a file outside its folder. Nothing was changed.");
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, data, { mode: f.mode || 0o644 });
                if (process.platform !== "win32") fs.chmodSync(target, f.mode || 0o644);
            }
        } finally {
            fs.closeSync(fd);
            removeDir(parts);
        }
    }

    /** The plain files kit: install the new test tools into the staging folder with the npm that came with this Node.js. */
    private async npmInstall(dir: string, signal: AbortSignal): Promise<void> {
        const nodeDir = path.dirname(this.execPath);
        const candidates = [this.env.AITP_UPDATE_NPM_CLI, path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].filter((c): c is string => Boolean(c));
        const cli = candidates.find((c) => fs.existsSync(c));
        if (!cli) throw new UpdateError("This update needs new test tools, and npm was not found next to this computer's Node.js. Download a new runner from the platform.");
        this.log?.info("The update needs new test tools: installing them with npm (this needs the internet and can take a few minutes).");
        const r = await run(this.execPath, [cli, "install", "--no-audit", "--no-fund"], { cwd: dir, env: { ...this.env, NODE_USE_SYSTEM_CA: "1" }, timeoutMs: 15 * 60_000, signal });
        if (signal.aborted) throw new UpdateError("The update was stopped.");
        if (r.code !== 0 || !fs.existsSync(path.join(dir, "node_modules", "@playwright", "test", "package.json"))) throw new UpdateError(`The new test tools could not be installed (npm exit code ${r.code ?? "none"}). Check that this computer can reach the npm registry. Nothing was changed.`);
    }

    // ── switching ───────────────────────────────────────────────────────────

    /** Put the checked files in place (keeping the current ones for one rollback). Returns RUNNER_UPDATE_EXIT, or undefined when it could not. */
    switchNow(): number | undefined {
        const offer = this.target;
        if (!offer || this.phase !== "ready") return undefined;
        const next = path.join(this.dir, "next");
        const previous = path.join(this.dir, "previous");
        const kitJson = path.join(this.kitDir, "runner.json");
        try {
            // runner.json keeps everything the person added (proxy, browser, ...); only the version changes.
            const conf = JSON.parse(fs.readFileSync(kitJson, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
            fs.writeFileSync(path.join(next, "runner.json"), `${JSON.stringify({ ...conf, kitVersion: offer.version }, null, 2)}\n`);
            removeDir(previous);
            removeDir(path.join(this.dir, "node-previous"));
            fs.mkdirSync(previous, { recursive: true });
            const files = ["runner.json", ...UPDATE_FILES];
            for (const f of files) if (fs.existsSync(path.join(this.kitDir, f))) fs.copyFileSync(path.join(this.kitDir, f), path.join(previous, f));
            this.state.switching = { from: this.version, to: offer.version, at: new Date(this.now()).toISOString() };
            this.save();
            if (exists(path.join(next, "node_modules"))) {
                if (exists(path.join(this.kitDir, "node_modules"))) renameRetry(path.join(this.kitDir, "node_modules"), path.join(previous, "node_modules"));
                renameRetry(path.join(next, "node_modules"), path.join(this.kitDir, "node_modules"));
            }
            // runner.json before runner.mjs: whichever program starts next reads a version that matches its files or recovers from the journal.
            for (const f of ["LICENSES.txt", "package.json", "record-child.mjs", "task-child.mjs", "runner.json", "runner.mjs"]) renameRetry(path.join(next, f), path.join(this.kitDir, f));
        } catch (e) {
            // Put back what was moved; the journal makes the next start do the same if this process dies here.
            try {
                if (this.state.switching) this.restorePrevious();
            } catch {
                /* the journal stays; the next start tries again */
            }
            this.state.switching = undefined;
            this.save();
            this.fail(offer.version, new UpdateError(`The new files could not be put in place (${(e as NodeJS.ErrnoException).code ?? "unknown problem"}). The runner kept its files.`));
            return undefined;
        }
        const from = this.version;
        this.state.switching = undefined;
        this.state.switched = { from, to: offer.version, at: new Date(this.now()).toISOString(), starts: 0 };
        this.save();
        removeDir(next);
        this.log?.info(`Switched to version ${offer.version}${this.nodeStaged ? " (with a new Node.js, which the start script switches in)" : ""}. Restarting.`);
        this.phase = "idle";
        this.version = offer.version;
        return RUNNER_UPDATE_EXIT;
    }

    /** Copy the kept files back over the current ones (runner.json included) and put the kept node_modules back. */
    private restorePrevious(): void {
        const previous = path.join(this.dir, "previous");
        if (exists(path.join(previous, "node_modules"))) {
            const discard = path.join(this.dir, "discard");
            removeDir(discard);
            fs.mkdirSync(discard, { recursive: true });
            if (exists(path.join(this.kitDir, "node_modules"))) renameRetry(path.join(this.kitDir, "node_modules"), path.join(discard, "node_modules"));
            renameRetry(path.join(previous, "node_modules"), path.join(this.kitDir, "node_modules"));
            removeDir(discard);
        }
        for (const f of ["LICENSES.txt", "package.json", "record-child.mjs", "task-child.mjs", "runner.json", "runner.mjs"]) {
            const from = path.join(previous, f);
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(this.kitDir, f));
        }
    }

    /**
     * Go back to the version kept in .update/previous (once: the kept files are used up). Returns false when there is none. The version
     * gone back from is not tried again automatically.
     */
    rollback(reason: string): boolean {
        const previous = path.join(this.dir, "previous");
        if (!fs.existsSync(path.join(previous, "runner.mjs")) || !fs.existsSync(path.join(previous, "runner.json"))) return false;
        let back = "an earlier version";
        try {
            back = String((JSON.parse(fs.readFileSync(path.join(previous, "runner.json"), "utf8")) as { kitVersion?: string }).kitVersion ?? back);
        } catch {
            /* the words stay general */
        }
        const leaving = this.version;
        this.restorePrevious();
        removeDir(previous);
        // A Node.js swapped in by the update goes back too: the start script swaps .update/node-next in at the restart.
        if (exists(path.join(this.dir, "node-previous"))) {
            removeDir(path.join(this.dir, "node-next"));
            renameRetry(path.join(this.dir, "node-previous"), path.join(this.dir, "node-next"));
        }
        this.state.switched = undefined;
        this.state.skip = leaving;
        this.state.last = { state: "rolled-back", from: back, to: leaving, error: reason, at: new Date(this.now()).toISOString() };
        this.save();
        this.version = back;
        return true;
    }
}

/** `node runner.mjs --rollback`: go back by hand. Prints one line and returns the exit code. */
export function rollbackByHand(u: RunnerUpdater, say: (line: string) => void): number {
    const from = u.version;
    if (!u.rollback("Rolled back by hand (--rollback).")) {
        say("There is no earlier version of this runner to go back to (an update keeps one, until the next update or rollback).");
        return 1;
    }
    say(`Went back from version ${from} to version ${u.version}. Start the runner again (the start script does it by itself). Version ${from} is not installed again automatically; "Update this runner" on the platform installs it.`);
    return 0;
}
