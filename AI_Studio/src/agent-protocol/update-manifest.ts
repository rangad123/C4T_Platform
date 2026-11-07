/**
 * Signed runner updates (docs/features/runner-updates.md, "Signed updates").
 *
 * The deploy writes two files next to the runner bundle (scripts/sign-runner-update.mjs):
 *   update-manifest.json  what an update may contain: the version, every bundle file (name, size, sha256) and, per complete download,
 *                         the list file of each part (name, size, sha256) and the size of its pack;
 *   update-manifest.sig   an Ed25519 signature over the exact bytes of update-manifest.json, made with the private key that only the
 *                         deploy workflow holds (the RUNNER_UPDATE_SIGNING_KEY secret).
 * The platform sends both, unchanged, with every offer. The runner checks the signature with a public key built into its own program
 * (src/agent/update-keys.ts) and then that every file the offer names is one the manifest names, with the same size and sha256. Every
 * byte it downloads is then checked against those sha256 values (src/agent/updater.ts), and every file of a pack against its signed list.
 * So a changed file on the platform, a changed offer or a changed manifest is refused: only the holder of the private key can make an
 * update that a runner installs. The manifest also carries a sequence number (larger for every signature) and the signing time: a runner
 * refuses a manifest whose sequence is not larger than the one of the version it runs (runner.json "updateSequence"), so an old signed
 * update sent again cannot move it back. All of this is checked before anything downloaded is run.
 *
 * Node's own crypto only (Ed25519 is built in). Shared by the runner and the platform; nothing here touches the disk.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { RunnerUpdateOffer } from "./schema.js";

export const UPDATE_MANIFEST_FILE = "update-manifest.json";
export const UPDATE_SIGNATURE_FILE = "update-manifest.sig";
/** A manifest larger than this is not one the deploy writes. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MANIFEST_KIND = "ai-studio-runner-update";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Size = z.number().int().min(0).max(400 * 1024 * 1024);
const Entry = z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), size: Size, sha256: Sha }).strict();
const Part = z.object({ list: Entry, packSize: Size }).strict();

export const UpdateManifest = z
    .object({
        format: z.literal(1),
        kind: z.literal(MANIFEST_KIND),
        version: z.string().min(1).max(80),
        /** Larger for every signature the deploy makes (the signing time in seconds): a runner refuses one not newer than its own. */
        sequence: z.number().int().min(1).max(2 ** 52),
        signedAt: z.string().max(40),
        files: z.array(Entry).min(1).max(20),
        complete: z.record(z.string().regex(/^[a-z]+-[a-z0-9]+$/), z.object({ nodeVersion: z.string().max(40), parts: z.object({ node_modules: Part.optional(), node: Part.optional() }).strict() }).strict()),
    })
    .strict();
export type UpdateManifest = z.infer<typeof UpdateManifest>;

export const UpdateSignature = z
    .object({
        format: z.literal(1),
        alg: z.literal("ed25519"),
        /** The first 16 hex characters of the sha256 of the raw public key. */
        keyId: z.string().regex(/^[0-9a-f]{16}$/),
        /** 64 bytes, base64. */
        signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    })
    .strict();
export type UpdateSignature = z.infer<typeof UpdateSignature>;

/** A public key as it is written in src/agent/update-keys.ts: the raw 32 bytes of an Ed25519 key, base64. */
export function publicKeyFromRaw(rawBase64: string): KeyObject | undefined {
    const raw = Buffer.from(rawBase64.trim(), "base64");
    if (raw.length !== 32) return undefined;
    try {
        return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    } catch {
        return undefined;
    }
}

export const keyIdOf = (rawBase64: string): string => createHash("sha256").update(Buffer.from(rawBase64.trim(), "base64")).digest("hex").slice(0, 16);

export type VerifiedManifest = { ok: true; manifest: UpdateManifest; keyId: string } | { ok: false; reason: string };

/** The signature over the manifest's exact bytes, by one of `keys`; then the manifest itself. Each refusal is one plain sentence. */
export function verifySignedManifest(manifestText: string, signatureText: string, keys: readonly string[]): VerifiedManifest {
    if (keys.length === 0) return { ok: false, reason: "This runner has no update key built in, so it installs no update by itself." };
    if (Buffer.byteLength(manifestText, "utf8") > MAX_MANIFEST_BYTES) return { ok: false, reason: "The update's manifest is too large to be a real one." };
    let sig: UpdateSignature;
    try {
        sig = UpdateSignature.parse(JSON.parse(signatureText));
    } catch {
        return { ok: false, reason: "The update's signature is missing or not in the expected format." };
    }
    const raw = keys.find((k) => keyIdOf(k) === sig.keyId);
    const key = raw ? publicKeyFromRaw(raw) : undefined;
    if (!key) return { ok: false, reason: "The update is signed with a key this runner does not trust." };
    let good = false;
    try {
        good = verify(null, Buffer.from(manifestText, "utf8"), key, Buffer.from(sig.signature, "base64"));
    } catch {
        good = false;
    }
    if (!good) return { ok: false, reason: "The update's signature does not match its manifest." };
    let manifest: UpdateManifest;
    try {
        manifest = UpdateManifest.parse(JSON.parse(manifestText));
    } catch {
        return { ok: false, reason: "The signed update manifest is not in the expected format." };
    }
    return { ok: true, manifest, keyId: sig.keyId };
}

/** Why an offer is not covered by the signed manifest, or undefined when every file it names was signed. */
export function offerMismatch(offer: Pick<RunnerUpdateOffer, "version" | "files" | "complete">, m: UpdateManifest): string | undefined {
    if (offer.version !== m.version) return `The update offers version ${offer.version}, but version ${m.version} was signed.`;
    for (const f of offer.files) {
        const e = m.files.find((x) => x.name === f.name);
        if (!e || e.size !== f.size || e.sha256 !== f.sha256) return `The file ${f.name} of the update is not the one that was signed.`;
    }
    if (offer.complete) {
        const c = m.complete[offer.complete.target];
        if (!c || c.nodeVersion !== offer.complete.nodeVersion) return `The complete download for ${offer.complete.target} was not signed.`;
        for (const p of offer.complete.parts) {
            const e = c.parts[p.folder];
            if (!e || e.list.name !== p.list.name || e.list.size !== p.list.size || e.list.sha256 !== p.list.sha256 || e.packSize !== p.pack.size) return `The ${p.folder} part of the update is not the one that was signed.`;
        }
    }
    return undefined;
}

/**
 * The bytes of a complete part's list file, from the complete download's manifest entries (path relative to the download, mode, sizes,
 * sha256). The platform serves exactly these bytes and scripts/sign-runner-update.mjs signs their sha256, so both must make them the same
 * way (tests/runner-update-unit.test.ts checks that they do).
 */
export function partListBytes(entries: ReadonlyArray<{ path: string; mode: number; size: number; csize: number; sha256: string }>, folder: "node_modules" | "node"): Buffer {
    const prefix = `${folder}/`;
    const files = entries.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), mode: f.mode, size: f.size, csize: f.csize, sha256: f.sha256 }));
    return Buffer.from(`${JSON.stringify({ format: 1, folder, files })}\n`, "utf8");
}
