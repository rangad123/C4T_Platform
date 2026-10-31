import crypto from "node:crypto";

/**
 * A TOTP written separately from src/engine/identity/totp.ts on purpose (bit-twiddling base32, BigInt arithmetic), so fixture
 * servers check codes with something other than the code under test.
 */
export function independentTotp(secretB32: string, nowMs: number): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bitString = "";
    for (const c of secretB32.replace(/=+$/, "")) bitString += alphabet.indexOf(c).toString(2).padStart(5, "0");
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bitString.length; i += 8) bytes.push(parseInt(bitString.slice(i, i + 8), 2));
    let counter = BigInt(Math.floor(nowMs / 30_000));
    const msg = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) {
        msg[i] = Number(counter & 255n);
        counter >>= 8n;
    }
    const mac = crypto.createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
    const off = mac[19]! & 0xf;
    const n = (mac[off]! & 0x7f) * 2 ** 24 + (mac[off + 1]! << 16) + (mac[off + 2]! << 8) + mac[off + 3]!;
    return String(n % 1_000_000).padStart(6, "0");
}

/** Accepted for its own 30-second window and the one before (clock drift), like real services. */
export const totpAccepted = (secretB32: string, code: string) => [0, -30_000].some((d) => independentTotp(secretB32, Date.now() + d) === code);
