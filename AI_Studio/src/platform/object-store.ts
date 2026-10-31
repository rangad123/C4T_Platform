/**
 * Where the platform keeps its files: generated scripts, run evidence, runner task files, apps, test files and restored backups.
 *
 * Callers name a file by its key, the same relative path the database already stores (`<projectId>/_artifacts/<job>/shot.png`), so moving
 * to object storage needs no rewrite of rows: today's path becomes the object key (docs/product-restructure/POSTGRES_S3_MIGRATION.md §4).
 * Keys are relative, use forward slashes only, and are checked here: nothing outside the store can be named.
 *
 * `LocalDiskStore` keeps today's layout under DATA_DIR/generated-tests. An S3 store (M4) implements the same interface, which is why it has
 * no local path in it. Code that genuinely needs a file on this machine (a child process, a hash of a file still to be sent) goes through
 * `withLocalCopy` or `localCopyIn` below: on local disk they hand over the stored file itself, so nothing is copied and nothing changes.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ObjectInfo {
    key: string;
    size: number;
    modifiedMs: number;
}

export interface PutResult {
    key: string;
    size: number;
    /** Hex sha256 of what was written. Set for bytes and streams; a plain file copy on local disk does not read the file to compute it. */
    sha256?: string;
}

export interface PutOptions {
    contentType?: string;
    /** The size the caller expects (an S3 store uses it to choose a single or multipart upload). */
    size?: number;
    /**
     * Streams only: called with the size and hash once every byte arrived, before the object becomes visible. Throwing discards it, so an
     * upload whose hash disagrees never replaces the file that was there.
     */
    verify?: (r: { size: number; sha256: string }) => void | Promise<void>;
}

export interface SignedUrlOptions {
    ttlSeconds: number;
    /** Offered as a download under this name (Content-Disposition: attachment). */
    filename?: string;
    contentType?: string;
}

export interface ObjectStore {
    readonly kind: "local" | "s3";
    put(key: string, body: Buffer | Uint8Array | string | Readable, o?: PutOptions): Promise<PutResult>;
    /** Store a file from this machine (a run's scratch file). */
    putFile(key: string, file: string, o?: PutOptions): Promise<PutResult>;
    /** Copy one stored object to another key (accepting a screenshot as the new baseline). */
    copy(fromKey: string, toKey: string): Promise<PutResult>;
    /** The object as a stream. Rejects with ObjectMissingError when there is none. */
    get(key: string): Promise<Readable>;
    getBytes(key: string): Promise<Buffer>;
    /** Size and time of a plain stored object; undefined when there is none (a link or a folder on local disk counts as none). */
    head(key: string): Promise<ObjectInfo | undefined>;
    exists(key: string): Promise<boolean>;
    /** Remove one object: true when it was there, false when it already was not. Throws when it cannot be removed. */
    delete(key: string): Promise<boolean>;
    /** Remove everything below a folder-like prefix (`<project>/_agent/<task>`); "" is refused. */
    deletePrefix(prefix: string): Promise<void>;
    /** Every object below a folder-like prefix ("" = all), keys in no particular order. Slow and costly on S3: not for request paths. */
    list(prefix: string): Promise<ObjectInfo[]>;
    /** A short-lived link a browser can follow, or null when the store has none and the API serves the bytes itself (local disk). */
    signedUrl(key: string, o: SignedUrlOptions): Promise<string | null>;
}

export class ObjectMissingError extends Error {
    readonly code = "ENOENT";
    constructor(key: string) {
        super(`No stored file ${key.slice(0, 200)}`);
        this.name = "ObjectMissingError";
    }
}

/** The message every refused key gets (the same words the earlier artifact store used, which retention's error sample shows). */
export const KEY_ESCAPES = "Path escapes the artifact store";

/** Check a key: relative, forward slashes, no empty, "." or ".." part, no drive letter, no control characters. Returns it unchanged. */
export function validKey(key: string): string {
    if (typeof key !== "string" || key.length === 0 || key.length > 1024) throw new Error(KEY_ESCAPES);
    if (/[\\\u0000-\u001f]/.test(key) || key.startsWith("/") || /^[A-Za-z]:/.test(key)) throw new Error(KEY_ESCAPES);
    for (const part of key.split("/")) if (part === "" || part === "." || part === "..") throw new Error(KEY_ESCAPES);
    return key;
}

/** A folder-like prefix: "" (everything) or a valid key, with or without one trailing slash. Returned without the slash. */
export function validPrefix(prefix: string): string {
    if (prefix === "") return "";
    return validKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

const sha256Of = (b: Buffer | Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** Counts and hashes what passes through. */
class Measure extends Transform {
    size = 0;
    readonly hash = createHash("sha256");
    override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
        this.size += chunk.length;
        this.hash.update(chunk);
        cb(null, chunk);
    }
}

/** Today's layout: one folder per project below DATA_DIR/generated-tests. */
export class LocalDiskStore implements ObjectStore {
    readonly kind = "local" as const;
    readonly root: string;

    constructor(root: string) {
        this.root = path.resolve(root);
    }

    /** Local disk only, and only for the helpers below: the file a key names. Not part of ObjectStore on purpose. */
    localPath(key: string): string {
        const full = path.resolve(this.root, validKey(key));
        if (!full.startsWith(this.root + path.sep)) throw new Error(KEY_ESCAPES);
        return full;
    }

    /** The key of a file inside this store, or undefined when the file is elsewhere. */
    keyOf(file: string): string | undefined {
        const rel = path.relative(this.root, path.resolve(file));
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
        const key = rel.split(path.sep).join("/");
        try {
            return validKey(key);
        } catch {
            return undefined;
        }
    }

    async put(key: string, body: Buffer | Uint8Array | string | Readable, o: PutOptions = {}): Promise<PutResult> {
        const full = this.localPath(key);
        // A stream that fails while the folder is made is reported by the pipeline below, not as an unhandled error.
        if (body instanceof Readable) body.on("error", () => undefined);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        if (!(body instanceof Readable)) {
            // Bytes are written in place, as the platform always did.
            await fsp.writeFile(full, body, typeof body === "string" ? "utf8" : undefined);
            return { key, size: typeof body === "string" ? Buffer.byteLength(body) : body.length, sha256: sha256Of(body) };
        }
        // A stream is never written straight to its final name: a half-sent file must not be mistaken for a stored one.
        const tmp = `${full}.part-${randomBytes(6).toString("hex")}`;
        const measure = new Measure();
        try {
            await pipeline(body, measure, fs.createWriteStream(tmp, { flags: "wx" }));
            const r = { size: measure.size, sha256: measure.hash.digest("hex") };
            await o.verify?.(r);
            await fsp.rename(tmp, full);
            return { key, ...r };
        } catch (e) {
            await fsp.rm(tmp, { force: true }).catch(() => undefined);
            throw e;
        }
    }

    async putFile(key: string, file: string): Promise<PutResult> {
        const full = this.localPath(key);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.copyFile(file, full);
        return { key, size: (await fsp.stat(full)).size };
    }

    async copy(fromKey: string, toKey: string): Promise<PutResult> {
        return this.putFile(toKey, this.localPath(fromKey));
    }

    async get(key: string): Promise<Readable> {
        const full = this.localPath(key);
        let handle: fsp.FileHandle;
        try {
            handle = await fsp.open(full, "r");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ObjectMissingError(key);
            throw e;
        }
        return handle.createReadStream();
    }

    async getBytes(key: string): Promise<Buffer> {
        try {
            return await fsp.readFile(this.localPath(key));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ObjectMissingError(key);
            throw e;
        }
    }

    async head(key: string): Promise<ObjectInfo | undefined> {
        let st: fs.Stats;
        try {
            st = await fsp.lstat(this.localPath(key));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
            throw e;
        }
        return st.isFile() ? { key, size: st.size, modifiedMs: st.mtimeMs } : undefined;
    }

    async exists(key: string): Promise<boolean> {
        return (await this.head(key)) !== undefined;
    }

    async delete(key: string): Promise<boolean> {
        const full = this.localPath(key);
        let st: fs.Stats;
        try {
            st = await fsp.lstat(full);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw e;
        }
        // A link or a folder where a file should be is never removed: that is somebody else's.
        if (!st.isFile()) throw new Error("it is not a plain file");
        await fsp.unlink(full);
        return true;
    }

    async deletePrefix(prefix: string): Promise<void> {
        const p = validPrefix(prefix);
        if (!p) throw new Error("Refusing to remove every stored file");
        await fsp.rm(this.localPath(p), { recursive: true, force: true });
    }

    async list(prefix: string): Promise<ObjectInfo[]> {
        const p = validPrefix(prefix);
        const out: ObjectInfo[] = [];
        const visit = async (dir: string, rel: string): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                // Links are never followed: they could point outside the store.
                if (e.isSymbolicLink()) continue;
                const key = rel ? `${rel}/${e.name}` : e.name;
                if (e.isDirectory()) await visit(path.join(dir, e.name), key);
                else if (e.isFile() && !/\.part-[0-9a-f]{12}$/.test(e.name)) {
                    try {
                        const st = await fsp.lstat(path.join(dir, e.name));
                        out.push({ key, size: st.size, modifiedMs: st.mtimeMs });
                    } catch {
                        /* gone meanwhile */
                    }
                }
            }
        };
        await visit(p ? this.localPath(p) : this.root, p);
        return out;
    }

    async signedUrl(key: string, _o: SignedUrlOptions): Promise<string | null> {
        validKey(key);
        return null;
    }

    /**
     * Retention only: remove folders left empty by `keys`, walking up but never above `<under>`. S3 has no folders, so this is local disk
     * housekeeping and not part of ObjectStore.
     */
    async removeEmptyFolders(keys: string[], under: string): Promise<void> {
        const guard = this.localPath(validPrefix(under));
        const dirs = new Set<string>();
        for (const k of keys) {
            try {
                dirs.add(path.dirname(this.localPath(k)));
            } catch {
                /* a bad key was already reported */
            }
        }
        for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
            let dir = d;
            while (dir.startsWith(guard + path.sep) && dir.length > guard.length) {
                try {
                    await fsp.rmdir(dir); // fails on a folder with anything in it: that is the point
                } catch {
                    break;
                }
                dir = path.dirname(dir);
            }
        }
    }
}

/** The platform's store. Only local disk exists until M4 adds S3 behind configuration. */
export function createObjectStore(config: { artifactsDir: string }): ObjectStore {
    return new LocalDiskStore(config.artifactsDir);
}

// ── code that needs a real file ─────────────────────────────────────────────

/**
 * Run `fn` with the object as a file on this machine. On local disk that is the stored file itself (nothing is copied, so `fn` must not
 * change it); on any other store a temporary copy, removed when `fn` finishes.
 */
export async function withLocalCopy<T>(store: ObjectStore, key: string, fn: (file: string) => Promise<T>): Promise<T> {
    if (store instanceof LocalDiskStore) return fn(store.localPath(key));
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aitp-object-"));
    try {
        const file = path.join(dir, path.posix.basename(validKey(key)));
        await pipeline(await store.get(key), fs.createWriteStream(file, { flags: "wx" }));
        return await fn(file);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/**
 * The object as a file on this machine that outlives one call (a runner's upload handed to the run's result). On local disk the stored
 * file itself; elsewhere a copy below `dir`, which the caller removes with that folder.
 */
export async function localCopyIn(store: ObjectStore, key: string, dir: string): Promise<string> {
    if (store instanceof LocalDiskStore) return store.localPath(key);
    const file = path.join(dir, ...validKey(key).split("/"));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await pipeline(await store.get(key), fs.createWriteStream(file));
    return file;
}

/**
 * Synchronous code that still hands a path to the engine (baselines and upload-step files, `GenerationSink.loadBaselines`): the stored file
 * on local disk, undefined for any other store. M1 makes the sink async, and these become `localCopyIn` into the run's folder.
 */
export function localPathOf(store: ObjectStore, key: string): string | undefined {
    if (!(store instanceof LocalDiskStore)) return undefined;
    try {
        return store.localPath(key);
    } catch {
        return undefined;
    }
}

const validKeyOrUndefined = (key: string): string | undefined => {
    try {
        return validKey(key);
    } catch {
        return undefined;
    }
};

/**
 * The key of an app file saved in a project's phone settings. The settings hold the file's full path on this machine (inside the local
 * store); another store's settings would hold the key itself. Undefined for anything outside the project's part of the store.
 */
export function keyOfStoredFile(store: ObjectStore, file: string, projectId: string): string | undefined {
    if (!file) return undefined;
    // On local disk the value is a path, resolved as it always was.
    const key = store instanceof LocalDiskStore ? store.keyOf(file) : validKeyOrUndefined(file);
    // Only this project's own files: a stored path must never reach another project's.
    return key?.startsWith(`${projectId}/`) ? key : undefined;
}

/** sha256 of a stored object, streamed (an app can be hundreds of megabytes). */
export async function hashObject(store: ObjectStore, key: string): Promise<string> {
    const h = createHash("sha256");
    for await (const chunk of await store.get(key)) h.update(chunk as Buffer);
    return h.digest("hex");
}

/** Store a text file (a script) and return its sha256, the hash `generated_scripts.content_hash` keeps. */
export async function putText(store: ObjectStore, key: string, content: string): Promise<{ key: string; size: number; hash: string }> {
    const r = await store.put(key, content, { contentType: "text/plain; charset=utf-8" });
    return { key, size: r.size, hash: r.sha256 ?? sha256Of(content) };
}
