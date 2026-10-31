/**
 * The passive assessment (round 18, RUN) without a browser or a server: judging with the existing checks' own logic, the coverage words,
 * retries of transient errors, the plain failure words, and the role rules of RUN's routes.
 */
import { describe, expect, it } from "vitest";
import { ruleFor } from "../src/platform/auth/roles.js";
import type { SecurityCall } from "../src/engine/security/checks.js";
import { countApiOperations, emptyDiscovery, pageKey } from "../src/security/assessment/discover.js";
import { judgeCookies, judgeCors, judgeDisclosure, judgeExposedFiles, judgeHeaders, judgeTls, lineKey } from "../src/security/assessment/judge.js";
import { notInspected, plainFailure } from "../src/security/assessment/runner.js";
import { fetchWithRetry, isTransient } from "../src/security/assessment/scan.js";
import { RefusedError, type Guard, type GuardedAnswer } from "../src/security/assessment/types.js";
import { normalize } from "../src/security/findings/normalize.js";

const call = (url: string, headers: Record<string, string>, text = "", extra: Partial<SecurityCall> = {}): SecurityCall => ({ url, status: 200, headers, text, ...extra });

describe("judging what was seen, with the existing checks' logic", () => {
    it("headers: one result per missing header per page; HSTS only judged on https", async () => {
        const pages = [call("http://app.test/", { "content-type": "text/html" }), call("http://app.test/about", { "content-type": "text/html", "x-frame-options": "DENY" })];
        const r = await judgeHeaders(pages);
        expect(r.every((x) => x.check === "securityHeaders" && x.line?.startsWith("- ["))).toBe(true);
        expect(r.filter((x) => /Content-Security-Policy/.test(x.line!))).toHaveLength(2);
        expect(r.filter((x) => /frame/i.test(x.line!) && x.url.endsWith("/about"))).toHaveLength(0);
        expect(r.some((x) => /Strict-Transport-Security/.test(x.line!))).toBe(false);
        const https = await judgeHeaders([call("https://app.test/", { "content-type": "text/html" })]);
        expect(https.some((x) => /Strict-Transport-Security/.test(x.line!))).toBe(true);
        // FIND turns them into one site-wide finding per header.
        const drafts = r.map((x) => normalize(x)!).filter(Boolean);
        expect(new Set(drafts.filter((d) => /Content-Security-Policy/i.test(d.title)).map((d) => d.fingerprint)).size).toBe(1);
    });

    it("cookies: a session cookie without flags once, from the first answer; other cookies are not judged", async () => {
        const c = call("http://app.test/", {}, "", { setCookies: ["sessionid=abc; Path=/", "theme=light"] });
        const r = await judgeCookies([c, { ...c, url: "http://app.test/again" }]);
        expect(r).toHaveLength(1);
        expect(r[0]!.line).toMatch(/sessionid/);
        expect(r[0]!.url).toBe("http://app.test/");
        expect(await judgeCookies([call("http://app.test/", {}, "", { setCookies: ["sessionid=abc; HttpOnly; SameSite=Lax"] })])).toEqual([]);
    });

    it("CORS: an echoed made-up origin with credentials is high", async () => {
        const probe = call("http://app.test/api/items", { "access-control-allow-origin": "https://untrusted-origin.example", "access-control-allow-credentials": "true" }, "", { sent: { origin: "https://untrusted-origin.example" } });
        const [r] = await judgeCors([probe]);
        expect(r!.line).toMatch(/^- \[high\]/);
    });

    it("exposed files need the content signature; a page answered for every path is no hit", async () => {
        const env = call("http://app.test/.env", { "content-type": "text/plain" }, "DB_PASSWORD=x\n");
        const spa = call("http://app.test/.env", { "content-type": "text/html" }, "<!doctype html><html></html>");
        expect(await judgeExposedFiles([env])).toHaveLength(1);
        expect(await judgeExposedFiles([spa])).toEqual([]);
    });

    it("disclosure: a banner once for the site, a listing per folder", async () => {
        const a = call("http://app.test/", { server: "Apache/2.4.1" });
        const b = call("http://app.test/x", { server: "Apache/2.4.1" });
        const l1 = call("http://app.test/uploads/", {}, "<title>Index of /uploads</title>");
        const l2 = call("http://app.test/files/", {}, "<title>Index of /files</title>");
        const r = await judgeDisclosure([a, b, l1, l2]);
        expect(r.filter((x) => /Server header/.test(x.line!))).toHaveLength(1);
        expect(r.filter((x) => /directory listing/.test(x.line!))).toHaveLength(2);
    });

    it("TLS: the certificate the guard's handshake saw is judged by the check's pure function", () => {
        const r = judgeTls({ url: "https://app.test/", host: "app.test", cert: { valid_to: "Jan 1 00:00:00 2020 GMT", subjectaltname: "DNS:app.test" } }, Date.parse("2026-01-01"));
        expect(r.some((x) => /expired/.test(x.line!))).toBe(true);
        expect(r[0]!.note).toMatch(/valid until/);
    });

    it("line keys ignore numbers (days left change between runs)", () => {
        expect(lineKey("tlsCertificate", "- [medium] The HTTPS certificate expires on 2026-01-05 (in 3 days). Renew it.")).toBe(lineKey("tlsCertificate", "- [medium] The HTTPS certificate expires on 2026-01-05 (in 2 days). Renew it."));
    });
});

describe("discovery helpers", () => {
    it("page keys drop fragments and trailing slashes, and refuse other schemes", () => {
        expect(pageKey("http://a.test/x/#top")).toBe("http://a.test/x");
        expect(pageKey("mailto:a@b.test")).toBeNull();
        expect(pageKey("/y", "http://a.test/x")).toBe("http://a.test/y");
    });
    it("counts API document operations without calling any", () => {
        expect(countApiOperations(JSON.stringify({ paths: { "/a": { get: {}, post: {}, parameters: [] }, "/b": { delete: {} } } }))).toBe(3);
        expect(countApiOperations("paths:\n  /a:\n    get:\n      summary: x\n    put:\n")).toBe(2);
    });
});

describe("coverage words", () => {
    it("never presents the assessment as complete: lists what was not inspected in plain sentences", () => {
        const d = emptyDiscovery("http://app.test/");
        Object.assign(d, {
            signInSeen: true,
            notVisited: 4,
            excluded: ["http://app.test/admin/billing"],
            outOfScope: [{ url: "http://10.0.0.5/internal", reason: "outside" }],
            blockedWrites: [{ method: "POST", url: "http://app.test/api/track" }],
            forms: [{ page: "http://app.test/", method: "POST", action: "/login", fields: [{ name: "username", type: "text" }] }],
            apiSpec: { url: "http://app.test/openapi.json", status: 200, operations: 1 },
        });
        const list = notInspected(d, [{ step: "Checking that /backup.zip cannot be downloaded", ok: false, reason: "The request failed: socket hang up" }], [], { maxPages: 30, maxDepth: 3 });
        const text = list.join("\n");
        expect(text).toMatch(/sign-in form was seen/);
        expect(text).toMatch(/4 pages found were not visited/);
        expect(text).toMatch(/Excluded paths were not requested: http:\/\/app.test\/admin\/billing/);
        expect(text).toMatch(/outside the authorized scope/);
        expect(text).toMatch(/POST http:\/\/app.test\/api\/track/);
        expect(text).toMatch(/never submitted/);
        expect(text).toMatch(/lists 1 operation; it was read, and none of them was called/);
        expect(text).toMatch(/backup.zip.*socket hang up/);
        expect(list[list.length - 1]).toMatch(/Only passive checks were made/);
    });
});

describe("network errors", () => {
    const answer = (status: number): GuardedAnswer => ({ url: "http://app.test/x", status, headers: {}, setCookies: [], body: Buffer.from("ok"), text: "ok" });
    const guardFrom = (steps: Array<() => GuardedAnswer>): Guard & { calls: number } => {
        const g = {
            calls: 0,
            refusal: async () => undefined,
            fetch: async () => steps[Math.min(g.calls++, steps.length - 1)]!(),
            requestsSent: () => g.calls,
        };
        return g;
    };
    const reset = () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    };

    it("retries a transient error a bounded number of times, then gives up", async () => {
        const ok = guardFrom([reset, () => answer(200)]);
        expect((await fetchWithRetry(ok, "http://app.test/x", {}, 2, new AbortController().signal)).status).toBe(200);
        expect(ok.calls).toBe(2);
        const never = guardFrom([reset]);
        await expect(fetchWithRetry(never, "http://app.test/x", {}, 2, new AbortController().signal)).rejects.toThrow(/socket hang up/);
        expect(never.calls).toBe(3);
        const busy = guardFrom([() => answer(503), () => answer(200)]);
        expect((await fetchWithRetry(busy, "http://app.test/x", {}, 1, new AbortController().signal)).status).toBe(200);
    });

    it("never retries a refusal or a non-network error", async () => {
        const refused = guardFrom([
            () => {
                throw new RefusedError("http://elsewhere.test/", "outside the scope", "out-of-scope");
            },
        ]);
        await expect(fetchWithRetry(refused, "http://elsewhere.test/", {}, 2, new AbortController().signal)).rejects.toBeInstanceOf(RefusedError);
        expect(refused.calls).toBe(1);
        expect(isTransient(new Error("Unexpected token"))).toBe(false);
    });

    it("says what failed in words a person can act on", () => {
        expect(plainFailure(new Error("connect ECONNREFUSED 127.0.0.1:1"))).toMatch(/did not accept connections/);
        expect(plainFailure(new Error("getaddrinfo ENOTFOUND nope.test"))).toMatch(/host name could not be found/);
    });
});

describe("roles of RUN's routes", () => {
    it("reading is viewer; starting, cancelling and the emergency stop are editor", () => {
        expect(ruleFor("POST", "/api/v1/security/applications/:appId/assessments")).toBe("editor");
        expect(ruleFor("GET", "/api/v1/security/projects/:id/assessments")).toBe("viewer");
        expect(ruleFor("GET", "/api/v1/security/assessments/:aid")).toBe("viewer");
        expect(ruleFor("POST", "/api/v1/security/assessments/:aid/cancel")).toBe("editor");
        expect(ruleFor("POST", "/api/v1/security/projects/:id/stop-all")).toBe("editor");
    });
});
