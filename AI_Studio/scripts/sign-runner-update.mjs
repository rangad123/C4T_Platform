// Signs the runner update the platform will offer (docs/features/runner-updates.md, "Signed updates").
//
//   RUNNER_UPDATE_SIGNING_KEY=<PEM> node scripts/sign-runner-update.mjs --kit dist/runner [--complete dist/runner-complete]
//       writes update-manifest.json (the version, every bundle file and every complete part with its size and sha256) and
//       update-manifest.sig (an Ed25519 signature over those exact bytes) into the --kit folder. The key is read from the environment
//       only, never from the command line, and never printed. The manifest carries a sequence number, the signing time in seconds unless
//       --sequence <n> says otherwise: a runner refuses an update whose sequence is not larger than its own (no going back by replay).
//   node scripts/sign-runner-update.mjs --new-key <file>
//       makes a new key pair: the private key goes to <file> (created, readable only by you; an existing file is never replaced) and
//       the public key is printed, to paste into src/agent/update-keys.ts. Run it on your own computer, once.
//
// Node's own modules only, on purpose: the deploy workflow runs this in a job that installs no npm packages, so no package's install
// script ever runs next to the private key. Every file is hashed again here; a bundle whose manifest does not match its files is refused.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_FILE = "update-manifest.json";
export const SIGNATURE_FILE = "update-manifest.sig";
const PART_FOLDERS = ["node_modules", "node"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The same bytes as partListBytes in src/agent-protocol/update-manifest.ts (the platform serves those; a test compares the two). */
export function partListBytes(entries, folder) {
    const prefix = `${folder}/`;
    const files = entries.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), mode: f.mode, size: f.size, csize: f.csize, sha256: f.sha256 }));
    return Buffer.from(`${JSON.stringify({ format: 1, folder, files })}\n`, "utf8");
}

function sha256File(file) {
    const h = createHash("sha256");
    const fd = fs.openSync(file, "r");
    try {
        const buf = Buffer.allocUnsafe(1024 * 1024);
        for (;;) {
            const n = fs.readSync(fd, buf, 0, buf.length, null);
            if (n <= 0) break;
            h.update(buf.subarray(0, n));
        }
    } finally {
        fs.closeSync(fd);
    }
    return h.digest("hex");
}

/** What may be offered, from the files on disk. `notes` says what was left out and why (a complete download that does not fit the bundle). */
export function buildUpdateManifest({ kitDir, completeDir, signedAt = new Date().toISOString(), sequence = Math.floor(Date.parse(signedAt) / 1000) }) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("The sequence number must be a whole number of 1 or more.");
    const kit = readJson(path.join(kitDir, "manifest.json"));
    if (kit.format !== 1 || typeof kit.kitVersion !== "string" || !Array.isArray(kit.files)) throw new Error(`${kitDir}/manifest.json is not a runner build manifest.`);
    const files = kit.files.map((f) => {
        const bytes = fs.readFileSync(path.join(kitDir, f.name));
        if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256) throw new Error(`The runner build in ${kitDir} is damaged (${f.name} does not match its manifest). Build it again.`);
        return { name: f.name, size: bytes.length, sha256: f.sha256 };
    });
    const pkg = kit.files.find((f) => f.name === "package.json");
    const complete = {};
    const notes = [];
    if (completeDir && fs.existsSync(completeDir)) {
        for (const target of fs.readdirSync(completeDir).sort()) {
            const dir = path.join(completeDir, target);
            if (!fs.existsSync(path.join(dir, "manifest.json"))) continue;
            const m = readJson(path.join(dir, "manifest.json"));
            if (m.format !== 1 || m.target !== target || !Array.isArray(m.files)) throw new Error(`The complete download ${target} has a manifest that is not one.`);
            if (!pkg || m.packageJsonSha256 !== pkg.sha256) {
                notes.push(`Left out the complete download ${target}: it was built for other test tools than this runner build.`);
                continue;
            }
            const packFile = path.join(dir, "pack.bin");
            if (!fs.existsSync(packFile) || fs.statSync(packFile).size !== m.packBytes || sha256File(packFile) !== m.packSha256) throw new Error(`The complete download ${target} is damaged (its pack does not match its manifest). Build it again.`);
            const parts = {};
            for (const folder of PART_FOLDERS) {
                const entries = m.files.filter((f) => f.path.startsWith(`${folder}/`));
                if (entries.length === 0) continue;
                const list = partListBytes(m.files, folder);
                parts[folder] = { list: { name: `complete-${target}-${folder}.json`, size: list.length, sha256: sha256(list) }, packSize: entries.reduce((n, f) => n + f.csize, 0) };
            }
            complete[target] = { nodeVersion: m.nodeVersion, parts };
        }
    }
    return { manifest: { format: 1, kind: "ai-studio-runner-update", version: kit.kitVersion, sequence, signedAt, files, complete }, notes };
}

/** The raw 32-byte public key (base64) of an Ed25519 private key, and its id (as src/agent-protocol/update-manifest.ts computes it). */
export function publicKeyOf(privateKey) {
    const x = createPublicKey(privateKey).export({ format: "jwk" }).x;
    const raw = Buffer.from(x, "base64url");
    return { raw: raw.toString("base64"), keyId: sha256(raw).slice(0, 16) };
}

function privateKeyFrom(pem) {
    let key;
    try {
        key = createPrivateKey({ key: String(pem).trim(), format: "pem" });
    } catch {
        throw new Error("RUNNER_UPDATE_SIGNING_KEY is not a private key in PEM form. Make one with --new-key.");
    }
    if (key.asymmetricKeyType !== "ed25519") throw new Error("RUNNER_UPDATE_SIGNING_KEY is not an Ed25519 key. Make one with --new-key.");
    return key;
}

/** Writes the manifest and its signature next to the bundle. Returns what was signed (never the key). */
export function signUpdate({ kitDir, completeDir, privateKeyPem, signedAt, sequence }) {
    const key = privateKeyFrom(privateKeyPem);
    const { manifest, notes } = buildUpdateManifest({ kitDir, completeDir, ...(signedAt ? { signedAt } : {}), ...(sequence !== undefined ? { sequence } : {}) });
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    const { keyId } = publicKeyOf(key);
    const signature = sign(null, Buffer.from(text, "utf8"), key).toString("base64");
    const sigText = `${JSON.stringify({ format: 1, alg: "ed25519", keyId, signature }, null, 2)}\n`;
    // The signature goes last and both are moved into place whole, so the platform never reads a manifest with an older signature.
    for (const [name, body] of [[MANIFEST_FILE, text], [SIGNATURE_FILE, sigText]]) {
        fs.writeFileSync(path.join(kitDir, `${name}.tmp`), body);
        fs.renameSync(path.join(kitDir, `${name}.tmp`), path.join(kitDir, name));
    }
    return { version: manifest.version, sequence: manifest.sequence, keyId, files: manifest.files.length, targets: Object.keys(manifest.complete), notes, manifestText: text, signatureText: sigText };
}

/** A new key pair: the private key into `file` (never over an existing file), the public key returned for update-keys.ts. */
export function newKeyPair(file) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });
    fs.writeFileSync(file, pem, { mode: 0o600, flag: "wx" });
    return publicKeyOf(privateKey);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const arg = (name) => {
        const i = args.indexOf(name);
        return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
    };
    try {
        if (args.includes("--new-key")) {
            const file = arg("--new-key");
            if (!file) throw new Error("--new-key needs the file to write the private key to.");
            if (fs.existsSync(file)) throw new Error(`${file} already exists. Choose another file name; an existing key is never replaced.`);
            const { raw, keyId } = newKeyPair(path.resolve(file));
            console.log(`Wrote the private key to ${file} (readable only by you). Never commit it and never paste it anywhere but the secret.`);
            console.log("");
            console.log("1. Store it as the repository secret RUNNER_UPDATE_SIGNING_KEY, for example:");
            console.log(`     gh secret set RUNNER_UPDATE_SIGNING_KEY < ${file}`);
            console.log("2. Paste this line into PINNED_UPDATE_KEYS in AI_Studio/src/agent/update-keys.ts:");
            console.log(`     "${raw}", // key ${keyId}`);
            console.log("3. Delete the file once the secret is stored (keep an offline copy if you want to sign by hand).");
        } else {
            const kitDir = arg("--kit");
            if (!kitDir) throw new Error("Say which runner build to sign: --kit dist/runner.");
            const pem = process.env.RUNNER_UPDATE_SIGNING_KEY ?? "";
            if (!pem.trim()) throw new Error("RUNNER_UPDATE_SIGNING_KEY is not set, so nothing was signed and the platform will offer no runner update.");
            const sequence = arg("--sequence") === undefined ? undefined : Number(arg("--sequence"));
            const r = signUpdate({ kitDir: path.resolve(kitDir), completeDir: arg("--complete") ? path.resolve(arg("--complete")) : undefined, privateKeyPem: pem, sequence });
            for (const n of r.notes) console.log(n);
            console.log(`Signed runner update ${r.version} (sequence ${r.sequence}) with key ${r.keyId}: ${r.files} files${r.targets.length ? `, complete downloads ${r.targets.join(", ")}` : ", no complete downloads"}.`);
        }
    } catch (e) {
        console.error(`sign-runner-update: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
    }
}
