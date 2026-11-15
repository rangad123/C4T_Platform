/**
 * Same-level API checks on the application's separate API hosts and on query-scoped record reads: which hosts count as the
 * application's own, how a read with a query string is kept (secret-named values masked, never stored), and that the check in the
 * script replays the address with the viewer's own value for each secret-named parameter, or refuses to judge without one.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { apiRecordAddress, generateAccessSpecs, ownApiHost, recordValues, type ApiRecordSeen, type Reach } from "../src/engine/identity/access.js";
import { accessHelper, fakeBrowser, setAccounts, type FakeAnswer } from "./identity-fake-browser.js";

const API = "http://127.0.0.1:8081";
const rec = (url: string, page: string, body: unknown): ApiRecordSeen => {
    const a = apiRecordAddress(new URL(url))!;
    const origin = new URL(url).origin === "http://127.0.0.1:8080" ? undefined : new URL(url).origin;
    return { path: a.path, ...(origin ? { origin } : {}), ...(a.secrets.length ? { secrets: a.secrets } : {}), pattern: (origin ?? "") + a.pattern, page, values: recordValues(body) };
};
const note = (title: string, body: string) => ({ kind: "personal note", title, body });
const reach = (who: string, api: ApiRecordSeen[]): Reach => ({ who, pages: [{ path: "/", heading: "Notes app" }], api });
const alice = reach("alice", [rec(`${API}/v1/note?id=1&access_token=alice-secret-token`, "/notes/1", note("Alice tax plan 2026", "Quarterly figures"))]);
const bob = reach("bob", [rec(`${API}/v1/note?id=2&access_token=bob-secret-token`, "/notes/2", note("Bob holiday budget", "Train tickets"))]);
const apiChecks = (reaches: Reach[]) => generateAccessSpecs(reaches).filter((s) => s.title.includes("through the API"));
const cfgOf = (s: ReturnType<typeof generateAccessSpecs>[number]) => JSON.parse(String((s.steps[1] as { expected: string }).expected)) as Record<string, unknown>;

describe("which API hosts are the application's own", () => {
    const app = "http://127.0.0.1:8080/";
    it("accepts the app's host on another port, a known API host, and another host of the same site", () => {
        expect(ownApiHost("http://127.0.0.1:8081/v1/note?id=1", app)).toBe(true);
        expect(ownApiHost("https://api.shop.example/v1/x", "https://www.shop.example/")).toBe(true);
        expect(ownApiHost("https://api.shop.example.co.uk/v1/x", "https://shop.example.co.uk/")).toBe(true);
        expect(ownApiHost("http://127.0.0.2:9000/v1/x", app, ["http://127.0.0.2:9000/v1"])).toBe(true);
    });
    it("refuses other hosts: another IP, localhost for 127.0.0.1, a third-party service, another country site, and non-web addresses", () => {
        expect(ownApiHost("http://127.0.0.2:8080/v1/x", app)).toBe(false);
        expect(ownApiHost("http://localhost:8080/v1/x", app)).toBe(false);
        expect(ownApiHost("https://api.analytics-vendor.example/collect?id=1", "https://www.shop.example/")).toBe(false);
        // A look-alike name ending in the app's name is another site: the viewer's sign-in must never be replayed to it.
        expect(ownApiHost("https://evilshop.example/v1/x", "https://shop.example/")).toBe(false);
        expect(ownApiHost("https://api.other.co.uk/x", "https://shop.example.co.uk/")).toBe(false);
        expect(ownApiHost("ws://127.0.0.1:8080/x", app)).toBe(false);
        expect(ownApiHost("not a url", app)).toBe(false);
    });
});

describe("sibling and shared-hosting API hosts stay refused unless set as the project's API address", () => {
    const SIBLINGS: Array<[string, string]> = [
        ["https://api.shop.example/v1/note?id=1", "https://app.shop.example/"],
        ["https://b.vercel.app/v1/note?id=1", "https://a.vercel.app/"],
        ["https://x.herokuapp.com/v1/note?id=1", "https://y.herokuapp.com/"],
        ["https://api.shop.example/v1/note?id=1", "https://shop.example.net/"],
    ];
    it("at the survey: not the application's own, by parent domain or hosting provider", () => {
        for (const [url, app] of SIBLINGS) {
            expect(ownApiHost(url, app), `${url} for ${app}`).toBe(false);
            expect(ownApiHost(url, app, [`${new URL(url).origin}/v1`]), `${url} configured`).toBe(true);
        }
    });
    it("at the survey on a hosting domain: another customer's app is refused, the app's own hosts and its API address are not", () => {
        expect(ownApiHost("https://mallory.github.io/v1/note?id=1", "https://alice.github.io/")).toBe(false);
        expect(ownApiHost("https://bucket-b.s3.amazonaws.com/notes/1", "https://bucket-a.s3.amazonaws.com/")).toBe(false);
        // Not even when a known API address is on the hosting domain: only that host and its own sub-domains are the application's.
        expect(ownApiHost("https://b.vercel.app/v1/x", "https://www.shop.example/", ["https://api-a.vercel.app/v1"])).toBe(false);
        expect(ownApiHost("https://api.a.vercel.app/v1/note?id=1", "https://a.vercel.app/")).toBe(true);
        expect(ownApiHost("https://a.vercel.app:8443/v1/note?id=1", "https://a.vercel.app/")).toBe(true);
        expect(ownApiHost("https://api-a.vercel.app/v1/x", "https://www.shop.example/", ["https://api-a.vercel.app/v1"])).toBe(true);
    });
    it("at spec generation: no check replays a record on a sibling or neighbour host", () => {
        for (const [url, app] of SIBLINGS) {
            const origin = new URL(url).origin;
            const at = (who: string, id: number, title: string) => {
                const a = apiRecordAddress(new URL(`${origin}/v1/note?id=${id}&access_token=${who}-token`))!;
                return reach(who, [{ path: a.path, origin, secrets: a.secrets, pattern: origin + a.pattern, page: `/notes/${id}`, values: recordValues(note(title, "Body text here")) }]);
            };
            const reaches = [at("alice", 1, "Alice tax plan 2026"), at("bob", 2, "Bob holiday budget")];
            expect(apiChecks(reaches).length, url).toBe(2); // without the application's address nothing can be judged here
            expect(generateAccessSpecs(reaches, { maxSpecs: 8, maxOrdinary: 3, appUrl: app }).filter((s) => s.title.includes("through the API")), url).toEqual([]);
            expect(generateAccessSpecs(reaches, { maxSpecs: 8, maxOrdinary: 3, appUrl: app, apiHosts: [origin] }).filter((s) => s.title.includes("through the API")).length, url).toBe(2);
        }
    });
});

describe("how a record read with a query string is kept", () => {
    it("keeps the query string, masks secret-named values, and turns id-named record ids into the kind of record", () => {
        const a = apiRecordAddress(new URL("http://h/v1/note?id=12&view=full&access_token=abc123secret"))!;
        expect(a).toEqual({ path: "/v1/note?id=12&view=full&access_token=•••", pattern: "/v1/note?id={}&view=full&access_token=•••", secrets: ["access_token"] });
        expect(apiRecordAddress(new URL("http://h/v1/notes/7?sig=xyz"))).toEqual({ path: "/v1/notes/7?sig=•••", pattern: "/v1/notes/{}?sig=•••", secrets: ["sig"] });
        expect(apiRecordAddress(new URL("http://h/v1/note?noteId=0b9e2c4a1f2d"))!.pattern).toBe("/v1/note?noteId={}");
    });
    it("is not a record read without an id in the path or an id-named query parameter", () => {
        expect(apiRecordAddress(new URL("http://h/v1/notes?page=2"))).toBeUndefined();
        expect(apiRecordAddress(new URL("http://h/v1/notes?token=12345"))).toBeUndefined();
    });
});

describe("checks for a separate API host with query-scoped reads", () => {
    it("names the full address with the secret masked, and carries the host and the secret names, never the secret", () => {
        const checks = apiChecks([alice, bob]);
        expect(checks.map((s) => s.title).sort()).toEqual([
            "“alice” account: cannot read a record of “bob” through the API (GET http://127.0.0.1:8081/v1/note?id=2&access_token=•••)",
            "“bob” account: cannot read a record of “alice” through the API (GET http://127.0.0.1:8081/v1/note?id=1&access_token=•••)",
        ]);
        const one = checks.find((s) => s.title.includes("id=1"))!;
        expect(cfgOf(one)).toMatchObject({ api: true, as: "bob", of: "alice", origin: API, path: "/v1/note?id=1&access_token=•••", secrets: ["access_token"], pattern: `${API}/v1/note?id={}&access_token=•••`, page: "/notes/2" });
        expect(JSON.stringify(checks)).not.toContain("secret-token");
        expect(JSON.stringify(checks)).not.toContain("Alice tax plan");
    });
    it("does not pair records of the same path on different hosts", () => {
        const elsewhere = reach("bob", [rec("https://api.other.example/v1/note?id=2&access_token=x", "/notes/2", note("Bob holiday budget", "Train tickets"))]);
        expect(apiChecks([alice, elsewhere])).toEqual([]);
    });
});

describe("the check in the script, for a separate API host with a secret query parameter", () => {
    beforeAll(() => setAccounts(["alice", "bob"]));
    const ALICE = JSON.stringify(note("Alice tax plan 2026", "Quarterly figures"));
    const cfg = cfgOf(apiChecks([alice, bob]).find((s) => s.title.includes("id=1"))!);
    /** Visiting an account's own page makes the app's own call with that account's token (when `tokens` is set). The owner is answered with its note. */
    const run = async (viewer: FakeAnswer, tokens = true, over: Record<string, unknown> = {}) => {
        const f = fakeBrowser({ answer: (c) => (c.who === "alice" ? { status: 200, body: ALICE } : viewer), ownCall: (who) => (tokens ? { url: `${API}/v1/note?id=2&access_token=${who}-own-token` } : undefined) });
        const r = await accessHelper.accessAssert(f.page, "http://127.0.0.1:8080", JSON.stringify({ ...cfg, ...over })).then(() => "passed", (e: Error) => e.message);
        return { r, calls: f.calls };
    };

    it("replays the owner's record on the API host with each account's own token, and reports a leak with the token masked", async () => {
        const open = await run({ status: 200, body: ALICE });
        expect(open.calls.map((c) => c.url)).toEqual([`${API}/v1/note?id=1&access_token=alice-own-token`, `${API}/v1/note?id=1&access_token=bob-own-token`]);
        expect(open.r).toContain("Access control check failed: 1 record may be open to another account");
        expect(open.r).toContain(`GET ${API}/v1/note?id=1&access_token=••• (HTTP 200)`);
        expect(open.r).not.toContain("own-token");
        expect(open.r).not.toContain("Alice tax plan");
    });
    it("passes when the API host refuses or answers without the owner's content", async () => {
        expect((await run({ status: 403, body: ALICE })).r).toBe("passed");
        expect((await run({ status: 200, body: JSON.stringify(note("Bob holiday budget", "Train tickets")) })).r).toBe("passed");
    });
    it("refuses to judge, making no request, when the account's own calls carry no value for the secret parameter", async () => {
        const none = await run({ status: 200, body: ALICE }, false);
        expect(none.r).toContain("carried no value of its own for access_token");
        expect(none.r).not.toContain("Access control check failed");
        expect(none.calls).toEqual([]);
    });
    it("refuses, before any request, a path that would leave the recorded API host", async () => {
        for (const path of ["//evil.example/v1/note?id=1&access_token=•••", "https://evil.example/v1/note?id=1"]) {
            const r = await run({ status: 200, body: ALICE }, true, { path });
            expect(r.r).toContain("is not a path on the application's API host (http://127.0.0.1:8081)");
            expect(r.calls).toEqual([]);
        }
    });
    it("refuses, before anything is opened, an API host in the check's settings that is not the application's own", async () => {
        for (const origin of ["http://10.0.0.5", "https://evil.example", "http://127.0.0.2:8081", "http://127.0.0.1.evil.example:8081", "ftp://127.0.0.1:8081"]) {
            const f = fakeBrowser({ answer: () => ({ status: 200, body: ALICE }), ownCall: (who) => ({ url: `${origin}/v1/note?id=2&access_token=${who}-own-token` }) });
            const r = await accessHelper.accessAssert(f.page, "http://127.0.0.1:8080", JSON.stringify({ ...cfg, origin })).then(() => "passed", (e: Error) => e.message);
            expect(r, origin).toContain(`The API host ${origin} in this check is not the application's own address (http://127.0.0.1:8080) or its API address, so it was not called`);
            expect(r).not.toContain("Access control check failed");
            expect(f.calls).toEqual([]);
            expect(f.contexts()).toBe(0);
        }
    });
    it("accepts an API host under the app's own name, and refuses a neighbour on a shared hosting domain", async () => {
        const judge = async (base: string, origin: string) => {
            const f = fakeBrowser({ answer: (c) => (c.who === "alice" ? { status: 200, body: ALICE } : { status: 403, body: "" }), ownCall: (who) => ({ url: `${origin}/v1/note?id=2&access_token=${who}-own-token` }) });
            const r = await accessHelper.accessAssert(f.page, base, JSON.stringify({ ...cfg, origin })).then(() => "passed", (e: Error) => e.message);
            return r === "passed" ? "called" : r.includes("so it was not called") ? "refused" : r;
        };
        expect(await judge("https://www.shop.example", "https://api.shop.example")).toBe("called");
        expect(await judge("https://shop-a.herokuapp.com", "https://api.shop-a.herokuapp.com")).toBe("called");
        expect(await judge("https://shop-a.herokuapp.com", "https://shop-b.herokuapp.com")).toBe("refused");
        expect(await judge("https://www.shop.example", "https://api.shop.example.evil.test")).toBe("refused");
        expect(await judge("https://app.shop.example", "https://api.shop.example")).toBe("refused");
        expect(await judge("https://a.vercel.app", "https://b.vercel.app")).toBe("refused");
        expect(await judge("https://y.herokuapp.com", "https://x.herokuapp.com")).toBe("refused");
        expect(await judge("https://shop.example.net", "https://api.shop.example")).toBe("refused");
        expect(await judge("http://127.0.0.1:8080", "http://1.127.0.0.1:8080")).toBe("refused");
    });
    it("accepts the project's API address on another machine name (API_BASE_URL of the run)", async () => {
        const other = "http://127.0.0.2:9000";
        const viaEnv = async () => {
            const f = fakeBrowser({ answer: (c) => (c.who === "alice" ? { status: 200, body: ALICE } : { status: 403, body: "" }), ownCall: (who) => ({ url: `${other}/v1/note?id=2&access_token=${who}-own-token` }) });
            const r = await accessHelper.accessAssert(f.page, "http://127.0.0.1:8080", JSON.stringify({ ...cfg, origin: other })).then(() => "passed", (e: Error) => e.message);
            return { r, calls: f.calls.map((c) => c.url) };
        };
        const had = process.env.API_BASE_URL;
        try {
            process.env.API_BASE_URL = `${other}/v1`;
            expect(await viaEnv()).toEqual({ r: "passed", calls: [`${other}/v1/note?id=1&access_token=alice-own-token`, `${other}/v1/note?id=1&access_token=bob-own-token`] });
            delete process.env.API_BASE_URL;
            expect((await viaEnv()).calls).toEqual([]);
        } finally {
            if (had === undefined) delete process.env.API_BASE_URL;
            else process.env.API_BASE_URL = had;
        }
    });
    it("does not keep a record read whose path would name another host", () => {
        expect(apiRecordAddress(new URL(`${API}//evil.example/api/x/123`))).toBeUndefined();
        expect(apiRecordAddress(new URL(`${API}/api/x/123`))?.path).toBe("/api/x/123");
    });
});

describe("the page form of the check stays on the application's own site", () => {
    const page = (path: string) => JSON.stringify({ as: "anonymous", path, marker: "Users", by: "admin", sev: "high" });
    it("refuses, before any browser context is opened, a path that names another host or a scheme", async () => {
        for (const path of ["//other.example/x", "http://10.0.0.5/", "https://other.example/admin", "/\\other.example/x", "\\\\other.example/x", "admin/users", "javascript:alert(1)"]) {
            const f = fakeBrowser({ answer: () => null });
            const r = await accessHelper.accessAssert(f.page, "http://127.0.0.1:8080", page(path)).then(() => "passed", (e: Error) => e.message);
            expect(r, path).toContain("is not a page of the application (http://127.0.0.1:8080), so it was not opened");
            expect(r).not.toContain("Access control check failed");
            expect(f.contexts()).toBe(0);
        }
    });
    it("opens a page of the application as before", async () => {
        const f = fakeBrowser({ answer: () => null });
        expect(await accessHelper.accessAssert(f.page, "http://127.0.0.1:8080", page("/admin/users?tab=all#top")).then(() => "passed", (e: Error) => e.message)).toBe("passed");
        expect(f.contexts()).toBe(1);
    });
});
