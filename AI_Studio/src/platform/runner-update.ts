/**
 * Runner updates, platform side (docs/features/runner-updates.md): which runners should move to the platform's own runner version, what
 * they are offered (the same prebuilt bundle a new download would hold, and for a complete download the folders that changed), the files
 * themselves, the per-runner "update automatically" setting and the "Update this runner" request, and the Activity rows for what the
 * runners report.
 *
 * Nothing here decides anything by trust in the runner: an offer only names files the platform itself checked (loadBundle and loadComplete
 * check every checksum), and the runner checks every byte it receives against the sha256 in the offer.
 *
 * The setting is a row per runner in `runner_update_settings` (shared-state.ts), so every API process sees the same one: `auto` (absent =
 * on), a pending request and the last report already written to Activity. Before round 26 it was a JSON file in the data folder
 * (runner-updates.json); that file is read once into the empty table and left where it is.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { AgentRecord } from "./agent-store.js";
import type { Db } from "./db.js";
import type { Capabilities, RunnerUpdateOffer, UpdatePart, UpdatePartList } from "../agent-protocol/schema.js";
import { kitDir, loadBundle, type Bundle } from "./runner-kit.js";
import { completeDir, loadComplete, type CompleteBuild, type CompleteTarget, COMPLETE_TARGETS } from "./runner-kit-complete.js";
import { redactCredentials } from "../engine/net/company-network.js";

type OkBundle = Extract<Bundle, { ok: true }>;
type OkBuild = Extract<CompleteBuild, { ok: true }>;

/** The bundle files a runner replaces (the same five every download holds). */
export const UPDATE_FILES = ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"] as const;
const PART_FOLDERS = ["node_modules", "node"] as const;
type PartFolder = (typeof PART_FOLDERS)[number];

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface Setting {
    /** false: the runner updates only when a person asks. Absent: automatic. */
    auto?: boolean;
    /** A person pressed "Update this runner" (ms). Cleared when the runner reports the outcome. */
    requestedAt?: number;
    /** The last update report already written to Activity ("state|at"). */
    reported?: string;
}

/** The runner's target in the complete-download names, from what it reports. */
export function targetOfAgent(c: Pick<Capabilities, "os" | "arch">): CompleteTarget | undefined {
    const os = c.os === "win32" ? "win" : c.os === "darwin" ? "mac" : "linux";
    const t = `${os}-${c.arch}`;
    return (COMPLETE_TARGETS as readonly string[]).includes(t) ? (t as CompleteTarget) : undefined;
}

/** The file names of a complete part: complete-<target>-<folder>.json (the list) and .pack (the compressed files). */
export const partNames = (target: CompleteTarget, folder: PartFolder) => ({ list: `complete-${target}-${folder}.json`, pack: `complete-${target}-${folder}.pack` });

export interface ActivityRow {
    projectId: string;
    agentId: string;
    agentName: string;
    action: "runner-updated" | "runner-update-failed" | "runner-rolled-back";
    detail: string;
}

/** What GET /api/projects/:id/agents shows about a runner's updates. */
export interface PublicUpdate {
    /** The runner can replace its own files (a download from this version on). */
    can: boolean;
    auto: boolean;
    /** The platform's runner version, when the bundle is built. */
    latest?: string;
    outOfDate: boolean;
    requested: boolean;
    state?: string;
    from?: string;
    to?: string;
    error?: string;
    at?: string;
    retryAt?: string;
}

export interface RunnerUpdatesOptions {
    db: Db;
    /** Where the settings file of earlier releases may be (read once into the empty table). */
    dataDir?: string;
    clock?: () => number;
    /** Where Activity rows go (the server passes the user store's writer). */
    activity?: (row: ActivityRow) => void;
}

export class RunnerUpdates {
    private readonly db: Db;
    private readonly clock: () => number;
    private bundleKey = "";
    private bundleCache?: OkBundle;
    private readonly lists = new Map<string, { bytes: Buffer; files: Array<{ offset: number; csize: number }>; packSize: number }>();
    activity?: (row: ActivityRow) => void;

    constructor(opts: RunnerUpdatesOptions) {
        this.db = opts.db;
        this.clock = opts.clock ?? Date.now;
        if (opts.activity) this.activity = opts.activity;
        if (opts.dataDir) this.importSettingsFile(path.join(opts.dataDir, "runner-updates.json"));
    }

    /** The upgrade from the file: only into an empty table, so a later restart never brings back a value changed since. */
    private importSettingsFile(file: string): void {
        let agents: Record<string, Setting>;
        try {
            const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { agents?: Record<string, Setting> };
            if (!raw || typeof raw.agents !== "object" || !raw.agents) return;
            agents = raw.agents;
        } catch {
            return; // none, or unreadable: every runner updates automatically
        }
        if (this.db.get("SELECT agent_id FROM runner_update_settings LIMIT 1")) return;
        for (const [agentId, s] of Object.entries(agents)) {
            if (!agentId || typeof s !== "object" || !s) continue;
            this.write(agentId, {
                ...(typeof s.auto === "boolean" ? { auto: s.auto } : {}),
                ...(typeof s.requestedAt === "number" && Number.isFinite(s.requestedAt) ? { requestedAt: s.requestedAt } : {}),
                ...(typeof s.reported === "string" ? { reported: s.reported } : {}),
            });
        }
    }

    private setting(agentId: string): Setting {
        const r = this.db.get<{ auto: number | null; requested_at: number | null; reported: string | null }>("SELECT auto, requested_at, reported FROM runner_update_settings WHERE agent_id = ?", agentId);
        if (!r) return {};
        return {
            ...(r.auto === null ? {} : { auto: Number(r.auto) === 1 }),
            ...(r.requested_at === null ? {} : { requestedAt: Number(r.requested_at) }),
            ...(r.reported === null ? {} : { reported: r.reported }),
        };
    }

    private write(agentId: string, s: Setting): void {
        this.db.run(
            "INSERT INTO runner_update_settings (agent_id, auto, requested_at, reported, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET auto = excluded.auto, requested_at = excluded.requested_at, reported = excluded.reported, updated_at = excluded.updated_at",
            agentId,
            s.auto === undefined ? null : s.auto ? 1 : 0,
            s.requestedAt === undefined ? null : Math.round(s.requestedAt),
            s.reported ?? null,
            new Date(this.clock()).toISOString(),
        );
    }

    private patch(agentId: string, p: Setting): void {
        const next: Setting = { ...this.setting(agentId), ...p };
        for (const k of Object.keys(next) as Array<keyof Setting>) if (next[k] === undefined) delete next[k];
        this.write(agentId, next);
    }

    /** The prebuilt bundle, checked; read again only when its manifest changes (a rebuild). */
    bundle(): OkBundle | undefined {
        const dir = kitDir();
        let key: string;
        try {
            const st = fs.statSync(path.join(dir, "manifest.json"));
            key = `${dir}|${st.size}|${st.mtimeMs}`;
        } catch {
            this.bundleKey = "";
            this.bundleCache = undefined;
            return undefined;
        }
        if (key !== this.bundleKey) {
            const b = loadBundle(dir);
            this.bundleCache = b.ok ? b : undefined;
            this.bundleKey = key;
            this.lists.clear();
        }
        return this.bundleCache;
    }

    latest(): string | undefined {
        return this.bundle()?.manifest.kitVersion;
    }

    /** Why the platform wants this runner on its version right now, or undefined. */
    wanted(agent: Pick<AgentRecord, "id" | "capabilities">): "auto" | "requested" | undefined {
        const c = agent.capabilities;
        if (!c.update?.can) return undefined;
        const latest = this.latest();
        if (!latest || c.kitVersion === latest) return undefined;
        const s = this.setting(agent.id);
        if (s.requestedAt) return "requested";
        return s.auto === false ? undefined : "auto";
    }

    /** The poll answer's header value, or undefined. */
    hint(agent: Pick<AgentRecord, "id" | "capabilities">): string | undefined {
        const why = this.wanted(agent);
        return why ? `${why} ${this.latest()}` : undefined;
    }

    /** What the runner should fetch, or undefined when it should stay where it is. */
    offer(agent: Pick<AgentRecord, "id" | "capabilities" | "node">): RunnerUpdateOffer | undefined {
        const reason = this.wanted(agent);
        const bundle = this.bundle();
        if (!reason || !bundle) return undefined;
        const files = UPDATE_FILES.map((name) => {
            const f = bundle.manifest.files.find((x) => x.name === name)!;
            return { name, size: f.bytes, sha256: f.sha256 };
        });
        const offer: RunnerUpdateOffer = { version: bundle.manifest.kitVersion, reason, files };
        const c = agent.capabilities;
        const target = c.update?.complete || c.update?.bundledNode ? targetOfAgent(c) : undefined;
        if (target) {
            const build = loadComplete(target, bundle, completeDir());
            if (build.ok) {
                const parts: UpdatePart[] = [];
                const pkgSha = sha256(bundle.files.get("package.json")!);
                if (c.update?.complete && c.update.packageSha256 !== pkgSha) parts.push(this.part(build, "node_modules"));
                if (c.update?.bundledNode && agent.node !== build.manifest.nodeVersion) parts.push(this.part(build, "node"));
                if (parts.length) offer.complete = { target, nodeVersion: build.manifest.nodeVersion, parts };
            }
        }
        return offer;
    }

    private listOf(build: OkBuild, folder: PartFolder) {
        const key = `${build.packPath}|${build.manifest.packSha256}|${folder}`;
        const cached = this.lists.get(key);
        if (cached) return cached;
        const prefix = `${folder}/`;
        const entries = build.manifest.files.filter((f) => f.path.startsWith(prefix));
        const list: UpdatePartList = { format: 1, folder, files: entries.map((f) => ({ path: f.path.slice(prefix.length), mode: f.mode, size: f.size, csize: f.csize, sha256: f.sha256 })) };
        const made = { bytes: Buffer.from(`${JSON.stringify(list)}\n`, "utf8"), files: entries.map((f) => ({ offset: f.offset, csize: f.csize })), packSize: entries.reduce((n, f) => n + f.csize, 0) };
        this.lists.set(key, made);
        return made;
    }

    private part(build: OkBuild, folder: PartFolder): UpdatePart {
        const l = this.listOf(build, folder);
        const names = partNames(build.target, folder);
        return { folder, list: { name: names.list, size: l.bytes.length, sha256: sha256(l.bytes) }, pack: { name: names.pack, size: l.packSize } };
    }

    /**
     * One file of an update: a bundle file (its checked bytes) or a complete part (the list, or its pack streamed from the build). Undefined
     * for anything else, so only what an offer can name is ever served.
     */
    file(name: string): { size: number; sha256?: string; body: Buffer | Readable } | undefined {
        const bundle = this.bundle();
        if (!bundle) return undefined;
        if ((UPDATE_FILES as readonly string[]).includes(name)) {
            const bytes = bundle.files.get(name);
            const f = bundle.manifest.files.find((x) => x.name === name);
            return bytes && f ? { size: bytes.length, sha256: f.sha256, body: Buffer.from(bytes) } : undefined;
        }
        const m = /^complete-([a-z]+-[a-z0-9]+)-(node_modules|node)\.(json|pack)$/.exec(name);
        if (!m || !(COMPLETE_TARGETS as readonly string[]).includes(m[1]!)) return undefined;
        const build = loadComplete(m[1] as CompleteTarget, bundle, completeDir());
        if (!build.ok) return undefined;
        const l = this.listOf(build, m[2] as PartFolder);
        if (m[3] === "json") return { size: l.bytes.length, sha256: sha256(l.bytes), body: l.bytes };
        const packPath = build.packPath;
        async function* body(): AsyncGenerator<Buffer> {
            const fh = await fs.promises.open(packPath, "r");
            try {
                const chunk = Buffer.allocUnsafe(1024 * 1024);
                for (const e of l.files) {
                    let left = e.csize;
                    let pos = e.offset;
                    while (left > 0) {
                        const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, left), pos);
                        if (bytesRead <= 0) throw new Error("the complete download's pack ended early");
                        yield Buffer.from(chunk.subarray(0, bytesRead));
                        left -= bytesRead;
                        pos += bytesRead;
                    }
                }
            } finally {
                await fh.close();
            }
        }
        return { size: l.packSize, body: Readable.from(body(), { objectMode: false }) };
    }

    setAuto(agentId: string, auto: boolean): void {
        this.patch(agentId, { auto: auto ? undefined : false });
    }

    request(agentId: string): void {
        this.patch(agentId, { requestedAt: this.clock() });
    }

    /** Called with what a runner reports (hello and poll): writes the outcome of an update to Activity once, and settles a request. */
    observe(agent: Pick<AgentRecord, "id" | "name" | "projectId">, caps: Capabilities | undefined): void {
        const u = caps?.update;
        if (!u || !u.at || !["updated", "failed", "rolled-back"].includes(u.state)) return;
        const key = `${u.state}|${u.at}`;
        const s = this.setting(agent.id);
        if (s.reported === key) return;
        const at = Date.parse(u.at);
        const settles = s.requestedAt !== undefined && Number.isFinite(at) && at >= s.requestedAt - 60_000;
        this.patch(agent.id, { reported: key, ...(settles ? { requestedAt: undefined } : {}) });
        const error = u.error ? redactCredentials(u.error).slice(0, 300) : "";
        const row: ActivityRow =
            u.state === "updated"
                ? { projectId: agent.projectId, agentId: agent.id, agentName: agent.name, action: "runner-updated", detail: `Runner “${agent.name}” updated itself from ${u.from ?? "an earlier version"} to ${u.to ?? caps?.kitVersion ?? "the platform's version"}.` }
                : u.state === "failed"
                  ? { projectId: agent.projectId, agentId: agent.id, agentName: agent.name, action: "runner-update-failed", detail: `Runner “${agent.name}” could not update${u.to ? ` to ${u.to}` : ""}: ${error || "no reason given"} Still on version ${caps?.kitVersion ?? "unknown"}.` }
                  : { projectId: agent.projectId, agentId: agent.id, agentName: agent.name, action: "runner-rolled-back", detail: `Runner “${agent.name}” went back to version ${caps?.kitVersion ?? u.from ?? "unknown"}${u.to ? ` from ${u.to}` : ""}: ${error || "no reason given"}` };
        try {
            this.activity?.(row);
        } catch {
            /* Activity is a record, never a reason to refuse a runner */
        }
    }

    /** The row's update facts for the Runners list. */
    publicView(agent: Pick<AgentRecord, "id" | "capabilities">): PublicUpdate {
        const u = agent.capabilities.update;
        const latest = this.latest();
        const s = this.setting(agent.id);
        const outOfDate = Boolean(latest && agent.capabilities.kitVersion && agent.capabilities.kitVersion !== latest);
        return {
            can: u?.can === true,
            auto: s.auto !== false,
            ...(latest ? { latest } : {}),
            outOfDate,
            requested: Boolean(s.requestedAt) && outOfDate,
            ...(u?.state ? { state: u.state } : {}),
            ...(u?.from ? { from: u.from } : {}),
            ...(u?.to ? { to: u.to } : {}),
            ...(u?.error ? { error: redactCredentials(u.error).slice(0, 300) } : {}),
            ...(u?.at ? { at: u.at } : {}),
            ...(u?.retryAt ? { retryAt: u.retryAt } : {}),
        };
    }
}

const services = new WeakMap<object, RunnerUpdates>();
/** One per platform (the same object the agent routes and the admin routes use). */
export function runnerUpdatesFor(p: { db: Db; config: { dataDir: string } }): RunnerUpdates {
    let s = services.get(p);
    if (!s) {
        s = new RunnerUpdates({ db: p.db, dataDir: p.config.dataDir });
        services.set(p, s);
    }
    return s;
}
