/**
 * Small web-app rules found in an audit (no browser, no server): what a refused sign-in says now that Settings has no access-key
 * card, and links made from addresses other systems send back (issue trackers, Sentry, device farms) keeping only http(s).
 */
import { describe, expect, it } from "vitest";
import { api, ApiError, downloadFrom } from "../web/src/api.js";
import { downloadMyRunner } from "../web/src/features/runners/my-runner.js";
import { describeApiError, signedOutText } from "../web/src/lib/labels.js";
import { externalHref } from "../web/src/lib/url.js";

describe("a refused sign-in (401)", () => {
    const SIGNED_OUT = "You are signed out, or the access key was not accepted. Reload the page to sign in again.";

    it("never sends the person to an access-key card in Settings", async () => {
        // The runner download in Settings says the same as every other refused call (the fetch is a stand-in answering 401).
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Missing or invalid x-api-key" }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
        const download = await downloadMyRunner("windows", "x64", () => undefined).then(
            () => "saved",
            (e: Error) => e.message,
        );
        globalThis.fetch = realFetch;
        for (const text of [describeApiError(new ApiError(401, "Missing or invalid x-api-key")), download]) {
            expect(text).toBe(SIGNED_OUT);
            expect(text).not.toMatch(/settings/i);
        }
    });

    it("keeps the server's own sentence when it says what to do", () => {
        expect(describeApiError(new ApiError(401, "Your Crowd4Test session needs renewing"))).toBe("Your Crowd4Test session needs renewing");
        const ticket = "This live-update link was already used or has expired. Reload the page to get a new one.";
        expect(describeApiError(new ApiError(401, ticket))).toBe(ticket);
        expect(signedOutText("Sign in first, or send an access key or a personal API token")).toBe(SIGNED_OUT);
        expect(signedOutText("Unauthorized")).toBe(SIGNED_OUT);
        expect(signedOutText("")).toBe(SIGNED_OUT);
    });
});

describe("one way to call the platform (round 47)", () => {
    /** A stand-in fetch answering in turn; it records every address asked for. */
    function answering(...answers: Array<[number, unknown]>) {
        const asked: string[] = [];
        const real = globalThis.fetch;
        globalThis.fetch = (async (url: string) => {
            asked.push(String(url));
            if (!String(url).startsWith("/api")) return new Response("", { status: 200 });
            const [status, body] = answers.shift()!;
            return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        return { asked, restore: () => (globalThis.fetch = real) };
    }
    const RENEW = { error: "Your Crowd4Test session needs renewing", details: { crowd4test: "renew", signInUrl: "https://c4t.test/login", refreshUrl: "https://c4t.test/refresh", portalUrl: "https://c4t.test" } };

    it("renews an expired Crowd4Test sign-in and keeps the whole refusal (the code, recorder and text pages need its diagnostics)", async () => {
        const f = answering([401, RENEW], [422, { error: "The script has problems", diagnostics: [{ line: 2, message: "Missing )" }] }]);
        const e = await api("/tests/t1/script", { method: "PUT", body: { content: "x" } }).catch((x: unknown) => x);
        f.restore();
        expect(f.asked).toEqual(["/api/tests/t1/script", "https://c4t.test/refresh", "/api/tests/t1/script"]);
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(422);
        expect((e as ApiError).body.diagnostics).toEqual([{ line: 2, message: "Missing )" }]);
    });

    it("renews the sign-in for a download too, and says the server's refusal in words", async () => {
        const f = answering([401, RENEW], [403, { error: "Forbidden" }]);
        const e = await downloadFrom("/projects/p1/manual-cases/export?format=csv", "test-cases.csv").catch((x: unknown) => x);
        f.restore();
        // Asked twice: once refused for the expired session, once more after renewing (a renewal within 2 s of another is shared).
        expect(f.asked.filter((u) => u.startsWith("/api"))).toEqual(["/api/projects/p1/manual-cases/export?format=csv", "/api/projects/p1/manual-cases/export?format=csv"]);
        expect(describeApiError(e)).toBe("Your role in this project does not allow this. Ask a project owner.");
    });

    it("describes an error once: the first rejected field, the server's sentence, a refused role", () => {
        expect(describeApiError(new ApiError(400, "Invalid body", [{ path: ["title"], message: "Give the test case a title." }]))).toBe("Give the test case a title.");
        expect(describeApiError(new ApiError(403, "Only a project owner can sign a release."))).toBe("Only a project owner can sign a release.");
        expect(describeApiError(new ApiError(0, "Could not reach the platform server"))).toBe("We couldn’t reach the platform server. Check that it is running and try again.");
        expect(describeApiError(new ApiError(500, ""))).toBe("Something went wrong. Try again.");
    });
});

describe("links to other systems", () => {
    it("keep http and https addresses", () => {
        expect(externalHref("https://acme.atlassian.net/browse/SHOP-12")).toBe("https://acme.atlassian.net/browse/SHOP-12");
        expect(externalHref("http://jira.local:8080/browse/A-1")).toBe("http://jira.local:8080/browse/A-1");
    });

    it("drop any other scheme, so a tracker's answer cannot run script in the page", () => {
        for (const bad of ["javascript:alert(document.cookie)", " JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "not a url", "", null, undefined]) {
            expect(externalHref(bad)).toBeUndefined();
        }
    });
});
