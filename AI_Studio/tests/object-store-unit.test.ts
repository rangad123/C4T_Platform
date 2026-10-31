/**
 * The object store (src/platform/object-store.ts): key rules, the local disk implementation, and the helpers for code that needs a file.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { hashObject, keyOfStoredFile, KEY_ESCAPES, LocalDiskStore, localCopyIn, localPathOf, ObjectMissingError, putText, validKey, validPrefix, withLocalCopy, type ObjectInfo, type ObjectStore } from "../src/platform/object-store.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "object-store-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => new LocalDiskStore(path.join(tmp, `s${n++}`));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const text = async (r: Readable) => {
    const parts: Buffer[] = [];
    for await (const c of r) parts.push(c as Buffer);
    return Buffer.concat(parts).toString("utf8");
};

describe("keys", () => {
    it("accepts relative forward-slash keys and refuses anything that could leave the store", () => {
        for (const k of ["p1/_artifacts/job/shot.png", "a", "p/x.spec.ts", "p/_agent/t/out/trace.zip"]) expect(validKey(k)).toBe(k);
        for (const k of ["", "/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", "a/", "C:/x", "c:x", "a\\b", "a/\u0000b", "x".repeat(1025)]) expect(() => validKey(k), JSON.stringify(k)).toThrow(KEY_ESCAPES);
        expect(validPrefix("")).toBe("");
        expect(validPrefix("p1/_agent/")).toBe("p1/_agent");
        expect(() => validPrefix("../p")).toThrow(KEY_ESCAPES);
    });

    it("refuses a bad key on every operation", async () => {
        const s = fresh();
        for (const op of [() => s.put("../x", "a"), () => s.get("/x"), () => s.getBytes("a/../../b"), () => s.head("a\\b"), () => s.delete(".."), () => s.deletePrefix(""), () => s.list("../")]) await expect(op()).rejects.toThrow();
    });
});

describe("the local disk store", () => {
    it("puts bytes, text and streams; reads them back as bytes and as a stream; heads and lists them", async () => {
        const s = fresh();
        const a = await s.put("p/a.txt", "héllo");
        expect(a).toEqual({ key: "p/a.txt", size: Buffer.byteLength("héllo"), sha256: sha("héllo") });
        await s.put("p/sub/b.bin", Buffer.from([1, 2, 3]));
        const c = await s.put("p/sub/c.txt", Readable.from([Buffer.from("one "), Buffer.from("two")]));
        expect(c).toEqual({ key: "p/sub/c.txt", size: 7, sha256: sha("one two") });
        expect((await s.getBytes("p/a.txt")).toString("utf8")).toBe("héllo");
        expect(await text(await s.get("p/sub/c.txt"))).toBe("one two");
        expect(await s.head("p/sub/b.bin")).toMatchObject({ key: "p/sub/b.bin", size: 3 });
        expect(await s.exists("p/nothing")).toBe(false);
        expect(await s.head("p/sub")).toBeUndefined(); // a folder is not an object
        const keys = (l: ObjectInfo[]) => l.map((o) => o.key).sort();
        expect(keys(await s.list("p"))).toEqual(["p/a.txt", "p/sub/b.bin", "p/sub/c.txt"]);
        expect(keys(await s.list("p/sub/"))).toEqual(["p/sub/b.bin", "p/sub/c.txt"]);
        expect(keys(await s.list(""))).toEqual(["p/a.txt", "p/sub/b.bin", "p/sub/c.txt"]);
        // On disk exactly where the platform always kept them.
        expect(fs.readFileSync(path.join(s.root, "p", "sub", "c.txt"), "utf8")).toBe("one two");
        expect((await putText(s, "p/t.spec.ts", "x")).hash).toBe(sha("x"));
    });

    it("a missing object: get and getBytes reject with ObjectMissingError, delete says it was not there", async () => {
        const s = fresh();
        await expect(s.get("p/none")).rejects.toBeInstanceOf(ObjectMissingError);
        await expect(s.getBytes("p/none")).rejects.toMatchObject({ code: "ENOENT" });
        expect(await s.delete("p/none")).toBe(false);
    });

    it("deletes one object, refuses a folder in its place, and deletes a prefix", async () => {
        const s = fresh();
        await s.put("p/x/1", "1");
        await s.put("p/x/2", "2");
        await s.put("p/y", "3");
        expect(await s.delete("p/y")).toBe(true);
        expect(await s.exists("p/y")).toBe(false);
        await expect(s.delete("p/x")).rejects.toThrow("not a plain file");
        await s.deletePrefix("p/x");
        expect(await s.list("p")).toEqual([]);
        await s.deletePrefix("p/never-there"); // nothing to do is fine
    });

    it("a stream that fails, or does not pass its check, leaves nothing and keeps the earlier object", async () => {
        const s = fresh();
        await s.put("p/u.bin", "good");
        const broken = new Readable({ read() {} });
        const pending = s.put("p/u.bin", broken);
        broken.push("half");
        broken.destroy(new Error("cut"));
        await expect(pending).rejects.toThrow("cut");
        await expect(s.put("p/u.bin", Readable.from(["bad"]), { verify: () => { throw new Error("hash differs"); } })).rejects.toThrow("hash differs");
        expect((await s.getBytes("p/u.bin")).toString()).toBe("good");
        expect(fs.readdirSync(path.join(s.root, "p"))).toEqual(["u.bin"]); // no .part file left behind
        let seen: { size: number; sha256: string } | undefined;
        await s.put("p/u.bin", Readable.from(["new"]), { verify: (r) => void (seen = r) });
        expect(seen).toEqual({ size: 3, sha256: sha("new") });
    });

    it("copies and stores files from this machine", async () => {
        const s = fresh();
        const src = path.join(tmp, `src-${n}.png`);
        fs.writeFileSync(src, Buffer.alloc(40, 1));
        expect(await s.putFile("p/_artifacts/j/shot.png", src)).toEqual({ key: "p/_artifacts/j/shot.png", size: 40 });
        expect(await s.copy("p/_artifacts/j/shot.png", "p/_baselines/T/shot.png")).toMatchObject({ size: 40 });
        expect((await s.getBytes("p/_baselines/T/shot.png")).length).toBe(40);
        expect(await hashObject(s, "p/_baselines/T/shot.png")).toBe(sha(Buffer.alloc(40, 1)));
    });

    it("has no signed links: null means the API serves the bytes as it always did", async () => {
        const s = fresh();
        await s.put("p/a.png", "x");
        expect(await s.signedUrl("p/a.png", { ttlSeconds: 60, filename: "a.png" })).toBeNull();
    });

    it("never lists through a link", async () => {
        const s = fresh();
        await s.put("p/a", "x");
        const outside = path.join(tmp, `outside-${n}`);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "secret"), "x");
        try {
            fs.symlinkSync(outside, path.join(s.root, "p", "link"), "junction");
        } catch {
            return;
        }
        expect((await s.list("p")).map((o) => o.key)).toEqual(["p/a"]);
        expect(await s.head("p/link")).toBeUndefined();
    });

    it("removes folders left empty, only below the given one", async () => {
        const s = fresh();
        await s.put("p/_artifacts/t/run/a.png", "x");
        await s.put("p/_artifacts/t/keep.png", "x");
        await s.delete("p/_artifacts/t/run/a.png");
        await s.removeEmptyFolders(["p/_artifacts/t/run/a.png"], "p/_artifacts");
        expect(fs.existsSync(path.join(s.root, "p", "_artifacts", "t", "run"))).toBe(false);
        expect(fs.existsSync(path.join(s.root, "p", "_artifacts", "t"))).toBe(true);
    });
});

describe("code that needs a file on this machine", () => {
    it("on local disk gets the stored file itself, with nothing copied", async () => {
        const s = fresh();
        await s.put("p/_apps/app.apk", "apk");
        const file = path.join(s.root, "p", "_apps", "app.apk");
        expect(await withLocalCopy(s, "p/_apps/app.apk", async (f) => f)).toBe(file);
        expect(await localCopyIn(s, "p/_apps/app.apk", path.join(tmp, "unused"))).toBe(file);
        expect(fs.existsSync(path.join(tmp, "unused"))).toBe(false);
        expect(localPathOf(s, "p/_apps/app.apk")).toBe(file);
        expect(localPathOf(s, "../x")).toBeUndefined();
        expect(keyOfStoredFile(s, file, "p")).toBe("p/_apps/app.apk");
        expect(keyOfStoredFile(s, path.join(tmp, "elsewhere.apk"), "p")).toBeUndefined();
        // Another project's file is outside this project's part of the store.
        expect(keyOfStoredFile(s, file, "q")).toBeUndefined();
        expect(keyOfStoredFile(s, file, "")).toBeUndefined();
    });

    it("on another store gets a temporary copy, removed afterwards (withLocalCopy) or kept in the caller's folder (localCopyIn)", async () => {
        const backing = fresh();
        await backing.put("p/out/trace.zip", "zip");
        // A store that is not local disk: only the interface, as S3 will be.
        const remote: ObjectStore = { ...Object.fromEntries((["put", "putFile", "copy", "get", "getBytes", "head", "exists", "delete", "deletePrefix", "list", "signedUrl"] as const).map((m) => [m, (backing[m] as (...a: unknown[]) => unknown).bind(backing)])), kind: "s3" } as unknown as ObjectStore;
        let seen = "";
        expect(await withLocalCopy(remote, "p/out/trace.zip", async (f) => ((seen = f), fs.readFileSync(f, "utf8")))).toBe("zip");
        expect(seen.startsWith(backing.root)).toBe(false);
        expect(fs.existsSync(seen)).toBe(false);
        const dir = path.join(tmp, `scratch-${n}`);
        const kept = await localCopyIn(remote, "p/out/trace.zip", dir);
        expect(kept).toBe(path.join(dir, "p", "out", "trace.zip"));
        expect(fs.readFileSync(kept, "utf8")).toBe("zip");
        expect(localPathOf(remote, "p/out/trace.zip")).toBeUndefined();
        expect(keyOfStoredFile(remote, "p/_apps/app.apk", "p")).toBe("p/_apps/app.apk");
        expect(keyOfStoredFile(remote, "p/_apps/app.apk", "q")).toBeUndefined();
        expect(keyOfStoredFile(remote, "/abs/app.apk", "p")).toBeUndefined();
    });
});
