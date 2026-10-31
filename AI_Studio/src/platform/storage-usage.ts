/**
 * How much storage the platform uses, by project and by kind of file. Read from the database's file rows; on local disk a capped walk adds
 * the files no row describes (see walk). Cached for a minute, never follows a link, and never reads anything outside the artifact folder.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Platform } from "./bootstrap.js";
import type { Row } from "./db.js";
import { LocalDiskStore } from "./object-store.js";
import { formatBytes } from "../engine/retention/format.js";

export const USAGE_KINDS = ["screenshot", "video", "trace", "evidence", "report", "apk", "baseline", "script", "other"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export interface KindTotals {
    files: number;
    bytes: number;
}
export type ByKind = Record<UsageKind, KindTotals>;

export interface ProjectUsage {
    bytes: number;
    files: number;
    byKind: ByKind;
}

export interface UsageScan {
    scannedAt: number;
    /** The walk stopped at its cap: the numbers are a lower bound. */
    truncated: boolean;
    projects: Map<string, ProjectUsage>;
    /** Files directly in the artifact folder or in a folder that is not a project's. */
    unassigned: ProjectUsage;
    total: ProjectUsage;
}

const CACHE_MS = 60_000;
export const WALK_CAP = { entries: 400_000, depth: 12 } as const;

const emptyKinds = (): ByKind => Object.fromEntries(USAGE_KINDS.map((k) => [k, { files: 0, bytes: 0 }])) as ByKind;
export const emptyUsage = (): ProjectUsage => ({ bytes: 0, files: 0, byKind: emptyKinds() });

/** The kind of a stored artifact row, as the storage view groups them. */
export function usageKindOfArtifact(kind: string): UsageKind {
    switch (kind) {
        case "screenshot":
        case "visual-actual":
        case "visual-diff":
        case "vision-shot":
            return "screenshot";
        case "video":
        case "trace":
        case "evidence":
        case "baseline":
            return kind;
        case "app-model":
        case "requirements-coverage":
            return "report";
        default:
            return /report|coverage|summary/i.test(kind) ? "report" : "other";
    }
}

/** For a file the database does not know (or while it is being written): by the folder it lives in, then by its extension. */
export function usageKindOfPath(rel: string): UsageKind {
    const parts = rel.split("/");
    if (parts[1] === "_apps") return "apk";
    if (parts[1] === "_baselines") return "baseline";
    const file = parts[parts.length - 1] ?? "";
    if (/\.(webm|mp4)$/i.test(file)) return "video";
    if (/^trace\./i.test(file)) return "trace";
    if (/^evidence\./i.test(file)) return "evidence";
    if (/\.(png|jpe?g)$/i.test(file)) return "screenshot";
    if (/\.spec\.ts$/.test(file) && parts[1] !== "_artifacts") return "script";
    if (/\.(json|html|pdf|md|xml)$/i.test(file) && parts[1] === "_artifacts") return "report";
    return "other";
}

function add(into: ProjectUsage, kind: UsageKind, bytes: number): void {
    into.bytes += bytes;
    into.files++;
    into.byKind[kind].bytes += bytes;
    into.byKind[kind].files++;
}

/**
 * Every file the database knows, by key: its kind and size. Artifacts (not yet removed), the current file of each stored script, test files
 * and runner task files. A size the row does not have (NULL) is left to the local walk.
 */
function knownFiles(p: Platform): Map<string, { kind: UsageKind; size: number | null }> {
    const map = new Map<string, { kind: UsageKind; size: number | null }>();
    const put = (key: string, kind: UsageKind, size: unknown) => {
        if (!map.has(key)) map.set(key, { kind, size: size === null || size === undefined ? null : Number(size) });
    };
    for (const r of p.db.all<Row>("SELECT path, kind, size FROM artifacts WHERE pruned_at IS NULL")) put(r.path as string, usageKindOfArtifact(r.kind as string), r.size);
    // Each version of a script is its own row, and a newer one rewrites the same file: the newest row is the file's size.
    for (const r of p.db.all<Row>("SELECT storage_path, octet_length(content) AS size FROM generated_scripts WHERE storage_path IS NOT NULL ORDER BY version DESC, created_at DESC")) put(r.storage_path as string, "script", r.size);
    for (const r of p.db.all<Row>("SELECT path, size FROM test_files")) put(r.path as string, usageKindOfPath(r.path as string), r.size);
    // Only the runner's own folder: an input that is the project's app (<project>/_apps/app.apk) is the app file, which no row sizes.
    for (const r of p.db.all<Row>("SELECT path, size FROM agent_task_files")) if ((r.path as string).split("/")[1] === "_agent") put(r.path as string, usageKindOfPath(r.path as string), r.size);
    return map;
}

/**
 * The numbers come from the database (a bucket listing is slow and costs money). Files no row describes, such as the uploaded app, a file
 * left behind by a crash, or a row without a size, can only be found by looking: that walk exists for the local store only.
 */
async function walk(p: Platform): Promise<UsageScan> {
    const known = knownFiles(p);
    const projects = new Map<string, ProjectUsage>();
    const unassigned = emptyUsage();
    const total = emptyUsage();
    let truncated = false;

    const count = (key: string, kind: UsageKind, size: number) => {
        const parts = key.split("/");
        const owner = parts.length > 1 ? parts[0]! : undefined;
        if (owner) {
            let usage = projects.get(owner);
            if (!usage) projects.set(owner, (usage = emptyUsage()));
            add(usage, kind, size);
        } else add(unassigned, kind, size);
        add(total, kind, size);
    };
    for (const [key, f] of known) if (f.size !== null) count(key, f.kind, f.size);

    if (p.store instanceof LocalDiskStore) {
        let seen = 0;
        const visit = async (dir: string, rel: string[], depth: number): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                return; // a folder that vanished or cannot be read is simply not counted
            }
            for (const e of entries) {
                if (++seen > WALK_CAP.entries) {
                    truncated = true;
                    return;
                }
                // Links are never followed (and never counted): they could point outside the artifact folder.
                if (e.isSymbolicLink()) continue;
                const next = [...rel, e.name];
                if (e.isDirectory()) {
                    if (depth < WALK_CAP.depth) await visit(path.join(dir, e.name), next, depth + 1);
                    else truncated = true;
                    continue;
                }
                if (!e.isFile()) continue;
                const relPath = next.join("/");
                const row = known.get(relPath);
                if (row && row.size !== null) continue; // counted from the database
                let size = 0;
                try {
                    size = (await fsp.lstat(path.join(dir, e.name))).size;
                } catch {
                    continue;
                }
                count(relPath, row?.kind ?? usageKindOfPath(relPath), size);
            }
        };
        await visit(p.store.root, [], 0);
    }
    return { scannedAt: Date.now(), truncated, projects, unassigned, total };
}

const cache = new WeakMap<Platform, { at: number; scan: Promise<UsageScan> }>();

/** The usage scan, at most one minute old. Concurrent callers share one walk. */
export function usageScan(p: Platform, now = Date.now()): Promise<UsageScan> {
    const hit = cache.get(p);
    if (hit && now - hit.at < CACHE_MS) return hit.scan;
    const scan = walk(p);
    cache.set(p, { at: now, scan });
    // A failed walk must not be served for a minute.
    scan.catch(() => cache.delete(p));
    return scan;
}

/** Forget the cached scan (after files were removed or restored). */
export function forgetUsage(p: Platform): void {
    cache.delete(p);
}

export interface DiskInfo {
    freeBytes: number;
    totalBytes: number;
}

export async function diskInfo(dir: string): Promise<DiskInfo | null> {
    try {
        const s = await fsp.statfs(dir);
        const free = Number(s.bavail) * Number(s.bsize);
        const total = Number(s.blocks) * Number(s.bsize);
        return Number.isFinite(free) && Number.isFinite(total) && total > 0 ? { freeBytes: free, totalBytes: total } : null;
    } catch {
        return null;
    }
}

/** Size of the database file and its write-ahead log. */
export function databaseBytes(dbPath: string): number {
    let n = 0;
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
            n += fs.statSync(f).size;
        } catch {
            /* no such file */
        }
    }
    return n;
}

export const usageJson = (u: ProjectUsage) => ({
    bytes: u.bytes,
    text: formatBytes(u.bytes),
    files: u.files,
    byKind: Object.fromEntries(USAGE_KINDS.map((k) => [k, { files: u.byKind[k].files, bytes: u.byKind[k].bytes, text: formatBytes(u.byKind[k].bytes) }])),
});
