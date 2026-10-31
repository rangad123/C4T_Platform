/** TOTP: verified against the RFC 6238 test vectors, and the script-side copy against the engine's. */
import { describe, expect, it } from "vitest";
import { base32Decode, loadTotpRuntime, secondsLeft, totp, usesTotp } from "../src/engine/identity/totp.js";

// RFC 6238 appendix B: the SHA-1 secret is the ASCII string "12345678901234567890" (base32 below), 8-digit codes.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const VECTORS: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
];

describe("TOTP (RFC 6238)", () => {
    it("matches every SHA-1 test vector in the RFC", () => {
        for (const [seconds, code] of VECTORS) expect(totp(SECRET, { now: seconds * 1000, digits: 8 }), `T=${seconds}`).toBe(code);
    });
    it("gives the usual 6-digit code (the last six digits of the 8-digit one)", () => {
        for (const [seconds, code] of VECTORS) expect(totp(SECRET, { now: seconds * 1000 })).toBe(code.slice(2));
    });
    it("keeps the same code through a 30 s window and changes at the boundary", () => {
        expect(totp(SECRET, { now: 30_000 })).toBe(totp(SECRET, { now: 59_999 }));
        expect(totp(SECRET, { now: 59_999 })).not.toBe(totp(SECRET, { now: 60_000 }));
    });
    it("reads secrets the way authenticator apps show them", () => {
        expect(base32Decode("gezd gnbv-gy3t qojq").toString()).toBe("1234567890");
        expect(base32Decode("GEZDGNBVGY3TQOJQ====").toString()).toBe("1234567890");
        expect(() => base32Decode("not base32!")).toThrow(/not valid base32/);
    });
    it("counts the seconds left in a window", () => {
        expect(secondsLeft(30_000)).toBe(30);
        expect(secondsLeft(45_000)).toBe(15);
        expect(secondsLeft(59_000)).toBe(1);
    });
});

describe("script-side helper", () => {
    const rt = loadTotpRuntime();
    it("computes the same codes as the engine", () => {
        for (const [seconds] of VECTORS) expect(rt.totpAt(SECRET, seconds * 1000)).toBe(totp(SECRET, { now: seconds * 1000 }));
        expect(rt.totpAt("JBSWY3DPEHPK3PXP", 1_700_000_000_000)).toBe(totp("JBSWY3DPEHPK3PXP", { now: 1_700_000_000_000 }));
    });
    it("waits for the next window when fewer than 3 s remain, so a code is never submitted as it expires", () => {
        const slept: number[] = [];
        const nearEnd = 29_000 + 60_000 * 5; // 1 s left in its window
        const code = rt.totpCode(SECRET, { now: nearEnd, sleep: (ms) => void slept.push(ms) });
        expect(slept).toEqual([1100]);
        expect(code).toBe(totp(SECRET, { now: nearEnd + 1100 })); // the code of the NEXT window
        expect(code).not.toBe(totp(SECRET, { now: nearEnd }));
    });
    it("does not wait when there is time", () => {
        const slept: number[] = [];
        const code = rt.totpCode(SECRET, { now: 60_000 * 5 + 10_000, sleep: (ms) => void slept.push(ms) });
        expect(slept).toEqual([]);
        expect(code).toBe(totp(SECRET, { now: 60_000 * 5 + 10_000 }));
    });
    it("says what is wrong when there is no secret", () => {
        expect(() => rt.totpCode("")).toThrow(/TEST_TOTP_SECRET is not set/);
    });
});

describe("placeholder detection", () => {
    it("finds the one-time-code placeholder, plain or per role", () => {
        expect(usesTotp('{"value":"{{credentials.totp}}"}')).toBe(true);
        expect(usesTotp('{"value":"{{ credentials.admin.totp }}"}')).toBe(true);
        expect(usesTotp('{"value":"{{credentials.password}}"}')).toBe(false);
        expect(usesTotp("totp")).toBe(false);
    });
});
