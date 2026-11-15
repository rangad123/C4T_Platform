/**
 * Same-site by the public suffix list, private suffixes included (src/shared/site.ts, tldts): shared hosting domains where each
 * customer gets a sub-domain (vercel.app, github.io, herokuapp.com, s3.amazonaws.com) are suffixes, so two customers' apps there are
 * different sites; country pairs (co.uk) work the same way; IPs and one-label names match only exactly. The one helper decides both
 * which API hosts the same-level API check may replay records on (ownApiHost) and which hosts selection counts as the app's (isOwnHost).
 * No browser, no ports (identity-shared-hosting.test.ts is the browser survey on a shared hosting domain).
 */
import { describe, expect, it } from "vitest";
import { ownApiHost } from "../src/engine/identity/access.js";
import { extractCoverage, isOwnHost, type ObservedRun, type TestFacts } from "../src/platform/selection/coverage.js";
import { previewSelection, readChanges } from "../src/platform/selection/preview.js";
import { sameSite, siteOf } from "../src/shared/site.js";

describe("the site of a host", () => {
    it("is the registrable domain, with private hosting suffixes counted as suffixes", () => {
        expect(siteOf("a.vercel.app")).toBe("a.vercel.app");
        expect(siteOf("api.a.vercel.app")).toBe("a.vercel.app");
        expect(siteOf("team.github.io")).toBe("team.github.io");
        expect(siteOf("shop-a.herokuapp.com")).toBe("shop-a.herokuapp.com");
        expect(siteOf("bucket-a.s3.amazonaws.com")).toBe("bucket-a.s3.amazonaws.com");
        expect(siteOf("www.shop.example.co.uk")).toBe("example.co.uk");
        expect(siteOf("api.shop.example.test")).toBe("example.test");
        expect(siteOf("Shop.Example.COM.:8443")).toBe("example.com");
    });
    it("is none for an IP, a one-label name, or a host that is itself a public suffix", () => {
        for (const h of ["127.0.0.1", "127.0.0.1:8080", "[::1]:3000", "::1", "localhost", "localhost:3000", "vercel.app", "github.io", "co.uk", "s3.amazonaws.com", ""]) expect(siteOf(h), h).toBeUndefined();
    });
});

describe("same site", () => {
    it("tells two customers of one hosting domain apart", () => {
        expect(sameSite("a.vercel.app", "b.vercel.app")).toBe(false);
        expect(sameSite("alice.github.io", "mallory.github.io")).toBe(false);
        expect(sameSite("shop-a.herokuapp.com", "shop-b.herokuapp.com")).toBe(false);
        expect(sameSite("bucket-a.s3.amazonaws.com", "bucket-b.s3.amazonaws.com")).toBe(false);
        expect(sameSite("shop.example.co.uk", "shop.other.co.uk")).toBe(false);
    });
    it("keeps the hosts of one customer together, ports ignored", () => {
        expect(sameSite("a.vercel.app", "api.a.vercel.app")).toBe(true);
        expect(sameSite("www.shop.example.co.uk:443", "api.shop.example.co.uk")).toBe(true);
        expect(sameSite("api.shop-a.herokuapp.com", "shop-a.herokuapp.com:8080")).toBe(true);
        expect(sameSite("localhost:3000", "localhost:5173")).toBe(true);
    });
    it("matches IPs and one-label names only by their exact name", () => {
        expect(sameSite("127.0.0.1:8080", "127.0.0.1:8081")).toBe(true);
        expect(sameSite("127.0.0.1", "127.0.0.2")).toBe(false);
        expect(sameSite("10.0.0.1", "11.0.0.1")).toBe(false);
        expect(sameSite("localhost", "127.0.0.1")).toBe(false);
        expect(sameSite("intranet", "other")).toBe(false);
        expect(sameSite("vercel.app", "a.vercel.app")).toBe(false);
    });
});

describe("the same-level API check on a shared hosting domain (credential replay)", () => {
    it("never counts another customer's app on the same hosting domain as the application's API", () => {
        expect(ownApiHost("https://b.vercel.app/api/note?id=1&token=t", "https://a.vercel.app/")).toBe(false);
        expect(ownApiHost("https://mallory.github.io/v1/note?id=1", "https://alice.github.io/")).toBe(false);
        expect(ownApiHost("http://shop-b.herokuapp.com/v1/note?id=1", "http://shop-a.herokuapp.com/")).toBe(false);
        expect(ownApiHost("https://bucket-b.s3.amazonaws.com/notes/1", "https://bucket-a.s3.amazonaws.com/")).toBe(false);
        expect(ownApiHost("https://api.other.co.uk/v1/x", "https://shop.example.co.uk/")).toBe(false);
        // Not even when a known API address is on the hosting domain: only that host and its own sub-domains are the application's.
        expect(ownApiHost("https://b.vercel.app/v1/x", "https://www.shop.example/", ["https://api-a.vercel.app/v1"])).toBe(false);
    });
    it("still counts the application's own hosts there", () => {
        expect(ownApiHost("https://api.a.vercel.app/v1/note?id=1", "https://a.vercel.app/")).toBe(true);
        expect(ownApiHost("https://a.vercel.app:8443/v1/note?id=1", "https://a.vercel.app/")).toBe(true);
        expect(ownApiHost("https://api-a.vercel.app/v1/x", "https://www.shop.example/", ["https://api-a.vercel.app/v1"])).toBe(true);
        expect(ownApiHost("https://api.shop.example.co.uk/v1/x", "https://shop.example.co.uk/")).toBe(true);
    });
});

describe("selection on a shared hosting domain", () => {
    const test = (requests: ObservedRun["requests"]): TestFacts => ({
        id: "t1",
        testKey: "WEB-001",
        title: "A test",
        kind: "web",
        spec: { steps: [{ action: "navigate", url: "/" }] },
        runs: [{ executionId: "e1", status: "passed", startedAt: "2026-11-10T10:00:00.000Z", complete: true, requests }],
        freshness: { fresh: true, executionId: "e1" },
    });
    const APP = { appHost: "a.vercel.app" };
    const select = (facts: TestFacts, endpoints: string[]) => {
        const { changes, ignored, notProcessed } = readChanges({ endpoints }, APP);
        return previewSelection([extractCoverage(facts, APP)], changes, ignored, { notProcessed });
    };

    it("counts the app's own sub-domains as its own and another customer's app as external", () => {
        expect(isOwnHost("api.a.vercel.app", APP)).toBe(true);
        expect(isOwnHost("a.vercel.app:8080", APP)).toBe(true);
        expect(isOwnHost("b.vercel.app", APP)).toBe(false);
        expect(isOwnHost("x.github.io", { appHost: "y.github.io" })).toBe(false);
        expect(isOwnHost("shop-b.herokuapp.com", { appHost: "shop-a.herokuapp.com" })).toBe(false);
        expect(isOwnHost("bucket-b.s3.amazonaws.com", { appHost: "bucket-a.s3.amazonaws.com" })).toBe(false);
        expect(isOwnHost("shop.other.co.uk", { appHost: "shop.example.co.uk" })).toBe(false);
        expect(isOwnHost("api.shop.example.co.uk", { appHost: "shop.example.co.uk" })).toBe(true);
    });
    it("matches a change to the app's endpoints, and not another customer's endpoint of the same path", () => {
        const own = test([{ method: "POST", type: "fetch", path: "/orders", host: "api.a.vercel.app" }]);
        const other = test([{ method: "POST", type: "fetch", path: "/orders", host: "b.vercel.app" }]);
        expect(extractCoverage(other, APP).items.find((i) => i.kind === "endpoint")).toMatchObject({ host: "b.vercel.app", external: true });
        expect(select(own, ["POST /orders"]).matched.map((t) => t.testKey)).toEqual(["WEB-001"]);
        expect(select(other, ["POST /orders"]).matched).toEqual([]);
        expect(select(other, ["POST https://b.vercel.app/orders"]).matched.map((t) => t.testKey)).toEqual(["WEB-001"]);
    });
});
