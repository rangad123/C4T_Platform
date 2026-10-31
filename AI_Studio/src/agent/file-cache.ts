/**
 * The agent's file cache: baselines and APKs the platform sends, kept by content hash.
 *
 * - A file is addressed by its sha256. The same baseline or APK is downloaded once, however many tasks use it.
 * - Every download is verified (size and sha256) before it enters the cache; a file that does not match is deleted and the
 *   task fails with a plain message, so a truncated or tampered download can never be used by a test.
 * - The cache has a size cap. When it is over, the least recently used files are deleted first; files in use by a running
 *   task are never deleted.
 * - Names inside the cache are `<sha256><ext>` only, so no name from the platform is ever part of a path.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FileRef } from "../agent-protocol/schema.js";

/** What a download function reports after it wrote the file. */
export interface Downloaded {
    size: number;
    sha256: string;
}

export type DownloadFn = (destination: string) => Promise<Downloaded>;

export class CacheIntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CacheIntegrityError";
    }
}

const ENTRY = /^[0-9a-f]{64}(\.[A-Za-z0-9]{1,8})?$/;

export class FileCache {
    private readonly inFlight = new Map<string, Promise<string>>();
    private readonly pins = new Map<string, number>();

    constructor(
        readonly dir: string,
        private readonly maxBytes: number,
    ) {}

    /** Create the folder and remove half-finished downloads left by an earlier run that was killed. */
    async init(): Promise<void> {
        await fsp.mkdir(this.dir, { recursive: true });
        for (const f of await fsp.readdir(this.dir).catch(() => [] as string[])) if (f.startsWith(".tmp-")) await fsp.rm(path.join(this.dir, f), { force: true });
    }

    private pathOf(sha256: string, ext: string): string {
        return path.join(this.dir, `${sha256}${ext}`);
    }

    /**
     * The local path of the file `ref` describes, downloading it with `download` if it is not cached. The file stays pinned
     * (safe from pruning) until `release` is called with the returned path.
     */
    async get(ref: Pick<FileRef, "size" | "sha256">, download: DownloadFn, ext = ""): Promise<string> {
        const safeExt = /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : "";
        const dest = this.pathOf(ref.sha256, safeExt);
        this.pin(dest);
        try {
            const existing = await fsp.stat(dest).catch(() => undefined);
            if (existing?.isFile() && existing.size === ref.size) {
                const now = new Date();
                await fsp.utimes(dest, now, now).catch(() => undefined); // "used just now" for the LRU order
                return dest;
            }
            let pending = this.inFlight.get(dest);
            if (!pending) {
                pending = this.fetchInto(dest, ref, download).finally(() => this.inFlight.delete(dest));
                this.inFlight.set(dest, pending);
            }
            await pending;
            return dest;
        } catch (e) {
            this.unpin(dest);
            throw e;
        }
    }

    release(paths: Iterable<string>): void {
        for (const p of paths) this.unpin(p);
    }

    private async fetchInto(dest: string, ref: Pick<FileRef, "size" | "sha256">, download: DownloadFn): Promise<string> {
        const tmp = path.join(this.dir, `.tmp-${crypto.randomUUID()}`);
        try {
            const got = await download(tmp);
            if (got.size !== ref.size || got.sha256 !== ref.sha256) {
                throw new CacheIntegrityError("A file the platform sent did not match its checksum, so it was not used. Try the run again.");
            }
            await fsp.rename(tmp, dest);
        } finally {
            await fsp.rm(tmp, { force: true }).catch(() => undefined);
        }
        await this.prune();
        return dest;
    }

    private pin(p: string): void {
        this.pins.set(p, (this.pins.get(p) ?? 0) + 1);
    }
    private unpin(p: string): void {
        const n = (this.pins.get(p) ?? 1) - 1;
        if (n <= 0) this.pins.delete(p);
        else this.pins.set(p, n);
    }

    /** Delete least recently used files until the cache fits its cap. Returns how many files were deleted. */
    async prune(): Promise<number> {
        const entries: Array<{ file: string; size: number; used: number }> = [];
        for (const f of await fsp.readdir(this.dir).catch(() => [] as string[])) {
            if (!ENTRY.test(f)) continue;
            const file = path.join(this.dir, f);
            const st = await fsp.stat(file).catch(() => undefined);
            if (st?.isFile()) entries.push({ file, size: st.size, used: st.mtimeMs });
        }
        let total = entries.reduce((n, e) => n + e.size, 0);
        let removed = 0;
        for (const e of entries.sort((a, b) => a.used - b.used)) {
            if (total <= this.maxBytes) break;
            if (this.pins.has(e.file)) continue;
            await fsp.rm(e.file, { force: true });
            total -= e.size;
            removed++;
        }
        return removed;
    }
}

/** Hash a file on disk (streamed, constant memory). */
export function sha256OfFile(file: string): Promise<{ size: number; sha256: string }> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        let size = 0;
        const s = fs.createReadStream(file);
        s.on("data", (c) => {
            size += c.length;
            hash.update(c);
        });
        s.on("error", reject);
        s.on("end", () => resolve({ size, sha256: hash.digest("hex") }));
    });
}
