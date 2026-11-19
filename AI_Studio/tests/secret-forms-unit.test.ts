/**
 * CP3b R-8: a run secret is masked in its base64 forms too (standard, without padding, URL-safe), besides the plain and URL-encoded ones,
 * wherever the shared forms are used: the exploration action log (explore/action-mask.ts), the platform's masking on write
 * (platform/redact-text.ts) and the runner's log (agent/log.ts). Fast tier.
 */
import { describe, expect, it } from "vitest";
import { secretVariants } from "../src/agent-protocol/secret-variants.js";
import { memoryLogger } from "../src/agent/log.js";
import { maskAction, maskActionLog } from "../src/engine/explore/action-mask.js";
import { maskText } from "../src/platform/redact-text.js";

const PW = "Hunt3r!pw22";
const B64 = Buffer.from(PW).toString("base64"); // SHVudDNyIXB3MjI=
const B64_BARE = B64.replace(/=+$/, "");
const B64_URL = Buffer.from("x?>~" + PW).toString("base64url");
const URL_SAFE_SECRET = "x?>~" + PW; // a secret whose base64 has "+" or "/", so the URL-safe form differs
const forms = (s: string) => [s, encodeURIComponent(s), Buffer.from(s).toString("base64"), Buffer.from(s).toString("base64").replace(/=+$/, ""), Buffer.from(s).toString("base64url")];

describe("a run secret's base64 forms are masked like the plain one (CP3b R-8)", () => {
    it("the shared forms hold the base64 ones", () => {
        expect(secretVariants(PW)).toEqual(expect.arrayContaining([PW, encodeURIComponent(PW), B64, B64_BARE]));
        expect(Buffer.from(URL_SAFE_SECRET).toString("base64")).not.toBe(B64_URL);
        expect(secretVariants(URL_SAFE_SECRET)).toEqual(expect.arrayContaining([B64_URL]));
    });

    it("in the exploration action log: an address path holding the secret in any of its forms", () => {
        for (const secret of [PW, URL_SAFE_SECRET])
            for (const f of forms(secret)) {
                const masked = maskAction(`navigate {"url":"http://127.0.0.1:9/share/${f}"}`, [secret]);
                expect(masked, f).not.toContain(f);
                expect(masked).toContain("/share/");
                const row = maskActionLog([{ seq: 1, objectiveId: "o", state: "/", action: `navigate http://127.0.0.1:9/share/${f}`, atMs: 0, result: "performed", reason: `opened /share/${f}` }], [secret])[0]!;
                expect(JSON.stringify(row), f).not.toContain(f);
            }
    });

    it("in the platform's masking on write and in the runner's log", () => {
        for (const f of forms(PW)) expect(maskText(`GET /share/${f} failed`, [PW]), f).toBe("GET /share/[hidden] failed");
        const { log } = memoryLogger();
        log.addSecrets([PW]);
        for (const f of forms(PW)) expect(log.redact(`GET /share/${f} failed`), f).not.toContain(f);
    });

    it("text that only looks like base64 is kept", () => {
        expect(maskText("GET /share/SHVudDNy failed", [PW])).toBe("GET /share/SHVudDNy failed");
        expect(maskAction(`navigate {"url":"http://127.0.0.1:9/share/abc"}`, [PW])).toContain("/share/abc");
    });
});
