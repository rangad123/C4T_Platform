/**
 * A finding's location stays readable (src/security/findings/redact.ts): hosts, ports and ordinary numeric ids in a path are not secrets,
 * while the secrets the redaction is for are still hidden in the same strings.
 */
import { describe, expect, it } from "vitest";
import { HIDDEN, redactText } from "../src/security/findings/redact.js";

describe("addresses stay readable", () => {
    it("a long path of short parts is an address, not base64 (it used to become http://127.0.0.1:[hidden])", () => {
        expect(redactText("http://127.0.0.1:9501/api/notes/50123/comments/70001")).toBe("http://127.0.0.1:9501/api/notes/50123/comments/70001");
        expect(redactText("https://shop.example/api/v2/customers/1048576/orders/20991/lines/7")).toBe("https://shop.example/api/v2/customers/1048576/orders/20991/lines/7");
    });

    it("a host whose name contains a secret-like word keeps its port and path", () => {
        expect(redactText("http://session.example:8080/x")).toBe("http://session.example:8080/x");
        expect(redactText("https://auth.example.com:8443/login")).toBe("https://auth.example.com:8443/login");
        // A user name in an address is hidden by the existing rules; the host and port stay.
        expect(redactText("postgres://db@token-store.internal:5432/app")).toBe(`postgres://${HIDDEN}@token-store.internal:5432/app`);
    });

    it("hosts, ports and numeric ids are kept", () => {
        for (const s of ["http://127.0.0.1:9501", "localhost:9501", "https://app.example:8443/orders/987654321", "http://10.0.0.5:3000/api/notes/1234567890123"]) expect(redactText(s)).toBe(s);
    });
});

describe("secrets in the same strings are still hidden", () => {
    it("a real base64 or hex secret in a path is hidden, the rest of the address is kept", () => {
        const b64 = "dGhpcyBpcyBhIHZlcnkgc2VjcmV0IGtleSB2YWx1ZQ9xYz";
        expect(redactText(`http://127.0.0.1:9501/api/keys/${b64}`)).toBe(`http://127.0.0.1:9501/api/keys/${HIDDEN}`);
        const withSlash = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdl/Z3JhdWx0Z2FycGx5d2FsZG8x";
        expect(redactText(`http://x.example/k/${withSlash}`)).not.toContain(withSlash);
        expect(redactText("http://x.example/k/0123456789abcdef0123456789abcdef")).toBe(`http://x.example/k/${HIDDEN}`);
    });

    it("secret query values, user:password in an address, tokens and secret config pairs are hidden", () => {
        expect(redactText("http://127.0.0.1:9501/reset?token=abc123def456")).toBe(`http://127.0.0.1:9501/reset?token=${HIDDEN}`);
        expect(redactText("https://bob:hunter22@db.example:5432/app")).toBe(`https://${HIDDEN}@db.example:5432/app`);
        expect(redactText("Authorization was Bearer abcdef123456 for http://127.0.0.1:9501/api")).toBe(`Authorization was Bearer ${HIDDEN} for http://127.0.0.1:9501/api`);
        expect(redactText("session.id: 12345")).toBe(`session.id: ${HIDDEN}`);
        expect(redactText("password: 98765")).toBe(`password: ${HIDDEN}`);
        expect(redactText("api_key=sk_live_51abc")).toBe(`api_key=${HIDDEN}`);
        expect(redactText("seen at http://127.0.0.1:9501/u/7 by ana@example.test")).toBe("seen at http://127.0.0.1:9501/u/7 by [email hidden]");
    });
});
