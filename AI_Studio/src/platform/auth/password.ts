/**
 * Password hashing with Node's own scrypt (no dependency). The stored form carries its parameters, so they can be raised later
 * without breaking existing hashes: `scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>`.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
    new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

/** N=2^15 takes ~50-100 ms on a laptop: slow enough to make guessing expensive, fast enough for a sign-in. */
const PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEY_LEN = 64;
/** scrypt needs 128*N*r bytes; the default maxmem (32 MB) is exactly at the limit for N=2^15, so allow a little more. */
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** A plain sentence when the password is not acceptable, else undefined. */
export function passwordProblem(password: string, email?: string): string | undefined {
    if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for the password.`;
    if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters for the password.`;
    if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return "The password must not be the email address.";
    if (/^(.)\1+$/.test(password)) return "The password must not be one character repeated.";
    return undefined;
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, KEY_LEN, { ...PARAMS, maxmem: MAXMEM });
    return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
    // Unknown account or no password yet: still spend the same work, so the answer time does not tell whether the account exists.
    const parts = (stored ?? "").split("$");
    const valid = parts.length === 6 && parts[0] === "scrypt";
    const N = valid ? Number(parts[1]) : PARAMS.N;
    const r = valid ? Number(parts[2]) : PARAMS.r;
    const p = valid ? Number(parts[3]) : PARAMS.p;
    if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
    const salt = valid ? Buffer.from(parts[4]!, "base64url") : randomBytes(16);
    const expected = valid ? Buffer.from(parts[5]!, "base64url") : randomBytes(KEY_LEN);
    const got = await scrypt(password, salt, expected.length || KEY_LEN, { N, r, p, maxmem: Math.max(MAXMEM, 128 * N * r * 2) });
    return valid && got.length === expected.length && timingSafeEqual(got, expected);
}
