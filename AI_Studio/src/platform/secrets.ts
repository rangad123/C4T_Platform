import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SECRET_KEY_MISSING =
    "SECRET_KEY is not set, and this install requires it (SECRET_KEY_REQUIRED=true). Set SECRET_KEY from the secret store, the same value on every process, and start again.";

/**
 * Where the encryption key comes from: the environment, or (self-hosted installs only) the key file `.secret` in the data folder. A hosted
 * install sets SECRET_KEY_REQUIRED, so it never makes a key file of its own: the API and worker do not share a disk there, and a key made per
 * process would leave every stored secret unreadable by the other. Throws SECRET_KEY_MISSING then.
 */
export function secretKeySource(config: { SECRET_KEY?: string; SECRET_KEY_REQUIRED?: boolean }): "environment" | "data-folder" {
    if (config.SECRET_KEY) return "environment";
    if (config.SECRET_KEY_REQUIRED) throw new Error(SECRET_KEY_MISSING);
    return "data-folder";
}

/**
 * The start-up line about the key, or undefined when there is nothing to say. Never contains the key or the folder's path. The key file and
 * SECRET_KEY are interchangeable: SECRET_KEY set to the file's contents is the same key, which is how a self-hosted install moves it.
 */
export function secretKeyNote(config: { SECRET_KEY?: string; dataDir: string }): string | undefined {
    const file = path.join(config.dataDir, ".secret");
    if (!config.SECRET_KEY) {
        return "SECRET_KEY is not set, so stored credentials are encrypted with the key file .secret in the data folder (self-hosted installs only). To move the key into the environment, set SECRET_KEY to that file's contents; a hosted install sets SECRET_KEY and SECRET_KEY_REQUIRED=true.";
    }
    let stored: string;
    try {
        stored = fs.readFileSync(file, "utf8");
    } catch {
        return undefined; // no key file: nothing can disagree
    }
    const same = timingSafeEqual(createHash("sha256").update(stored).digest(), createHash("sha256").update(config.SECRET_KEY).digest());
    return same
        ? undefined
        : "SECRET_KEY is set, and the data folder also has a key file .secret with a different key: credentials stored while that file was the key cannot be read. Set SECRET_KEY to that file's contents to keep them.";
}

/** AES-256-GCM encryption for stored test credentials. Key = SECRET_KEY env, else a per-install key file (see secretKeySource). */
export class SecretBox {
    private readonly key: Buffer;

    constructor(dataDir: string, secretKey?: string) {
        if (secretKey) {
            if (secretKey.length < 16) throw new Error("SECRET_KEY must be at least 16 characters");
            this.key = createHash("sha256").update(secretKey).digest();
        } else {
            const file = path.join(dataDir, ".secret");
            fs.mkdirSync(dataDir, { recursive: true });
            if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
            this.key = createHash("sha256").update(fs.readFileSync(file, "utf8")).digest();
        }
    }

    encrypt(plain: unknown): string {
        const iv = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", this.key, iv);
        const enc = Buffer.concat([c.update(JSON.stringify(plain), "utf8"), c.final()]);
        return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
    }

    decrypt<T>(blob: string): T {
        const [iv, tag, enc] = blob.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer];
        const d = createDecipheriv("aes-256-gcm", this.key, iv);
        d.setAuthTag(tag);
        return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString("utf8")) as T;
    }
}
