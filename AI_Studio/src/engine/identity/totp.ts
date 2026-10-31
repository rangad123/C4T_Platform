/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1) for logging in to apps that use an authenticator app, with no
 * dependency beyond node:crypto. Email and SMS codes cannot be generated this way and are out of scope.
 *
 * Two copies of the same algorithm exist on purpose and are tested against each other and against the RFC's own vectors:
 *  - `totp()` for the engine (discovery login, the live interpreter);
 *  - `TOTP_HELPER_SOURCE`, plain JavaScript pasted into generated scripts that use `{{credentials.totp}}`, so a downloaded
 *    script computes the code itself from the TEST_TOTP_SECRET environment variable.
 * The secret never appears in a script; only the name of the environment variable does.
 */
import { createHmac } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an RFC 4648 base32 secret as authenticator apps show it: any case, spaces and dashes allowed, padding optional. */
export function base32Decode(input: string): Buffer {
    const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        const idx = B32.indexOf(ch);
        if (idx < 0) throw new Error("The authenticator secret is not valid base32 (letters A-Z and digits 2-7).");
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export interface TotpOptions {
    /** Milliseconds since the epoch; defaults to now. */
    now?: number;
    digits?: number;
    /** Seconds each code is valid. */
    step?: number;
}

/** The code an authenticator app would show for `secret` (base32) at the given time. */
export function totp(secret: string, opts: TotpOptions = {}): string {
    const digits = opts.digits ?? 6;
    const step = opts.step ?? 30;
    const counter = Math.floor((opts.now ?? Date.now()) / 1000 / step);
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
    const offset = h[h.length - 1]! & 0x0f;
    const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
    return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Seconds until the current code stops being valid. */
export const secondsLeft = (now = Date.now(), step = 30) => step - ((now / 1000) % step);

/**
 * Script-side copy. Needs `createHmac` in scope (the generator adds `import { createHmac } from "node:crypto"`).
 * `totpCode(secret)` waits for the next window when fewer than 3 s remain, so a code is never submitted just as it expires.
 * `opts.now` / `opts.sleep` exist so tests can drive the clock.
 */
export const TOTP_HELPER_SOURCE = String.raw`function totpBase32(input) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const clean = String(input).toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        const i = A.indexOf(ch);
        if (i < 0) throw new Error("TEST_TOTP_SECRET is not valid base32 (letters A-Z and digits 2-7).");
        value = (value << 5) | i;
        bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}
function totpAt(secret, nowMs) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30000)));
    const h = createHmac("sha1", totpBase32(secret)).update(msg).digest();
    const o = h[h.length - 1] & 15;
    const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(bin % 1000000).padStart(6, "0");
}
function totpCode(secret, opts) {
    if (!secret) throw new Error("This test needs a one-time code, but TEST_TOTP_SECRET is not set.");
    const o = opts || {};
    const sleep = o.sleep || ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
    let now = o.now !== undefined ? o.now : Date.now();
    const left = 30000 - (now % 30000);
    if (left < 3000) {
        sleep(left + 100);
        now = o.now !== undefined ? now + left + 100 : Date.now();
    }
    return totpAt(secret, now);
}
`;

export interface TotpRuntime {
    totpCode(secret: string, opts?: { now?: number; sleep?: (ms: number) => void }): string;
    totpAt(secret: string, nowMs: number): string;
}

let runtime: TotpRuntime | undefined;

/** The exact helper the generated scripts carry, compiled for tests. */
export function loadTotpRuntime(): TotpRuntime {
    runtime ??= new Function("createHmac", `${TOTP_HELPER_SOURCE}\nreturn { totpCode, totpAt };`)(createHmac) as TotpRuntime;
    return runtime;
}

/** Does this spec text use a one-time code? (Then the generated script must carry the helper.) */
export const usesTotp = (text: string) => /\{\{\s*credentials\.(?:[\w-]+\.)?totp\s*\}\}/.test(text);
