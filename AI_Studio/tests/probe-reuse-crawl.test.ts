/**
 * Reuse earlier runs (sheet #8 (a)) in a real browser, through crawl() itself: a second crawl of an unchanged site starts from the known
 * pages and does not probe them again (the site counts every opened "More" toggle); a page changed between the crawls (through the
 * benchmark's change proxy) is probed again; a spot check that finds a changed validation message turns reuse off and the pages reused
 * before it are probed again; more than half of the pages changed turns reuse off; and signing in goes straight to the remembered page,
 * still filling the form and checking the result.
 * Fixture site: port 7461, change proxy 7462 (tests/fixtures/reuse-site.ts). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/probe-reuse-crawl.test.ts
 */
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { login } from "../src/engine/discovery/auth.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl, normalizeUrl, type CrawlResult } from "../src/engine/discovery/crawler.js";
import { knownPagesOf, ProbeReuse } from "../src/engine/memory/probe-reuse.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { ChangeProxy } from "../src/eval/bench/repeat/change-proxy.js";
import { REUSE_PAGES, REUSE_SITE_USER, startReuseSite, type ReuseSite } from "./fixtures/reuse-site.js";

const PORT = 7461;
const SITE = `http://127.0.0.1:${PORT}`;
let site: ReuseSite;
let proxy: ChangeProxy;
let browser: Browser;
const events: EngineEvent[] = [];
const ctx = { config: loadConfig({}), emit: (e: EngineEvent) => void events.push(e), llm: null } as unknown as EngineContext;

const asModel = (r: CrawlResult, origin: string): AppModel => ({
    url: `${origin}/`,
    origin,
    siteType: "x",
    purpose: "",
    features: [],
    pages: r.pages,
    navigation: r.navigation,
    apis: [],
    journeys: [],
    externalDependencies: [],
    documentedTestCases: [],
    authentication: { required: false, mechanisms: [], loggedIn: false },
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});

async function crawlOnce(base: string, o: { known?: AppModel; maxDepth?: number } = {}): Promise<{ result: CrawlResult; reuse?: ProbeReuse; events: EngineEvent[] }> {
    events.length = 0;
    const known = o.known ? knownPagesOf(o.known) : undefined;
    const reuse = known ? new ProbeReuse(known, (u) => normalizeUrl(u, base)) : undefined;
    const session = await BrowserSession.launch(browser, { startUrl: base });
    try {
        const result = await crawl(session, ctx, { startUrl: base, maxPages: 20, maxDepth: o.maxDepth ?? 2, maxPerPattern: 10, ...(reuse ? { known: reuse } : {}) });
        return { result, ...(reuse ? { reuse } : {}), events: [...events] };
    } finally {
        await session.close();
    }
}
const byPath = (r: CrawlResult, p: string) => r.pages.find((x) => x.path === p)!;
const opened = () => Object.fromEntries([...site.more.entries()].sort());

beforeAll(async () => {
    site = await startReuseSite(PORT);
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await proxy?.stop();
    await browser?.close();
    site?.server.close();
});

describe("a second crawl of the same site", () => {
    let cold: CrawlResult;

    it("the first crawl probes every page and dates the results", async () => {
        site.reset();
        cold = (await crawlOnce(SITE)).result;
        expect(cold.pages.map((p) => p.path).sort()).toEqual([...REUSE_PAGES].sort());
        expect(opened()).toEqual({ a: 1, b: 1, c: 1, d: 1, e: 1, home: 1 });
        for (const p of cold.pages) {
            expect(p.probedAt, p.path).toBeTruthy();
            expect(p.reusedFrom).toBeUndefined();
            expect(p.forms[0]!.fields.find((f) => f.name === "email")!.validation?.message, p.path).toMatch(/Enter a valid e-mail/);
        }
        expect(byPath(cold, "/a").forms[0]!.conditional).toEqual([{ when: expect.stringMatching(/Business/), shows: ["Company"] }]);
    }, 120_000);

    it("unchanged pages take their probe results from then: their toggles are not opened, the results are the same, and the run says so", async () => {
        site.reset();
        const { result, events: ev } = await crawlOnce(SITE, { known: asModel(cold, SITE) });
        // Spot checks: the first reusable page ("/") and the sixth ("/e"); the other four are reused.
        expect(opened()).toEqual({ e: 1, home: 1 });
        for (const p of ["/a", "/b", "/c", "/d"]) {
            const now = byPath(result, p);
            expect(now.reusedFrom, p).toEqual({ at: byPath(cold, p).probedAt });
            expect(now.forms, p).toEqual(byPath(cold, p).forms);
            expect(now.revealed, p).toEqual(byPath(cold, p).revealed);
            expect(now.interactions, p).toEqual(byPath(cold, p).interactions);
        }
        expect(byPath(result, "/").reusedFrom).toBeUndefined();
        const said = ev.find((e) => e.kind === "probes_reused")!;
        expect(said.message).toMatch(/^reused: 4 pages unchanged since \d{4}-\d\d-\d\d\./);
        expect(said.data).toMatchObject({ pages: 4, spotChecked: 2 });
        expect(ev.some((e) => e.kind === "reuse_off")).toBe(false);
        // The revealed links are followed as before: the screen map keeps the menu transitions of reused pages.
        expect(result.transitions.filter((t) => t.via === "menu").length).toBe(cold.transitions.filter((t) => t.via === "menu").length);
    }, 120_000);

    it("starts from the known pages: with no link followed (depth 0) every known page is still visited", async () => {
        site.reset();
        const shallow = await crawlOnce(SITE, { maxDepth: 0 });
        expect(shallow.result.pages.map((p) => p.path)).toEqual(["/"]);
        const seeded = await crawlOnce(SITE, { known: asModel(cold, SITE), maxDepth: 0 });
        expect(seeded.result.pages.map((p) => p.path).sort()).toEqual([...REUSE_PAGES].sort());
        expect(seeded.events.find((e) => e.kind === "pages_from_memory")?.message).toMatch(/Started from 5 pages the last exploration knew/);
    }, 120_000);

    it("a page changed between the crawls (the change proxy removes its field) is probed again and not reused", async () => {
        proxy = new ChangeProxy(SITE, { id: "c-email-removed", path: "/c", find: /<label for="email">Contact e-mail<\/label><input id="email" name="email" type="email" aria-describedby="email-msg">/g, replace: "", what: "Page c lost its e-mail field." });
        await proxy.start(PORT + 1);
        site.reset();
        const first = (await crawlOnce(proxy.url)).result;
        site.reset();
        proxy.changed = true;
        const { result, reuse, events: ev } = await crawlOnce(proxy.url, { known: asModel(first, proxy.url) });
        proxy.changed = false;
        expect(proxy.hits).toBeGreaterThan(0);
        const c = byPath(result, "/c");
        expect(c.reusedFrom).toBeUndefined();
        expect(c.forms.flatMap((f) => f.fields).some((f) => f.name === "email")).toBe(false);
        expect(site.more.get("c")).toBe(1);
        expect(reuse!.changedPaths).toEqual(["/c"]);
        expect(ev.find((e) => e.kind === "probes_reused")!.data).toMatchObject({ changed: 1 });
        expect(ev.find((e) => e.kind === "probes_reused")!.data!.paths).not.toContain("/c");
        await proxy.stop();
    }, 180_000);
});

describe("reuse switched off for the rest of the run", () => {
    let cold: CrawlResult;
    beforeAll(async () => {
        site.reset();
        cold = (await crawlOnce(SITE)).result;
    }, 120_000);

    it("a spot check that finds a changed validation message turns reuse off, and the pages reused before it are probed again", async () => {
        site.reset();
        // Same fields and headings (same fingerprints): only probing can see the new message. "/e" is the second spot check.
        site.message["/e"] = "That is not an e-mail address";
        const { result, events: ev } = await crawlOnce(SITE, { known: asModel(cold, SITE) });
        const off = ev.find((e) => e.kind === "reuse_off")!;
        expect(off.level).toBe("warn");
        expect(off.message).toMatch(/spot check of \/e found it behaves differently/);
        expect(off.message).toMatch(/including the 4 whose results were already taken/);
        expect(ev.find((e) => e.kind === "reuse_reprobed")!.data).toEqual({ pages: 4 });
        expect(ev.some((e) => e.kind === "probes_reused")).toBe(false);
        // Every page was really probed this run, and none says it was reused.
        expect(opened()).toEqual({ a: 1, b: 1, c: 1, d: 1, e: 1, home: 1 });
        for (const p of result.pages) expect(p.reusedFrom, p.path).toBeUndefined();
        expect(byPath(result, "/e").forms[0]!.fields[0]!.validation?.message).toBe("That is not an e-mail address");
        expect(byPath(result, "/a").forms[0]!.conditional).toEqual(byPath(cold, "/a").forms[0]!.conditional);
    }, 180_000);

    it("more than half of the known pages changed: reuse is off for the run and nothing is reused", async () => {
        site.reset();
        for (const p of ["/a", "/b", "/c", "/d"]) site.heading[p] = `Renamed ${p}`;
        const { result, events: ev } = await crawlOnce(SITE, { known: asModel(cold, SITE) });
        expect(ev.find((e) => e.kind === "reuse_off")!.message).toMatch(/more than half of the 6 known pages changed/);
        for (const p of result.pages) expect(p.reusedFrom, p.path).toBeUndefined();
        expect(opened()).toEqual({ a: 1, b: 1, c: 1, d: 1, e: 1, home: 1 });
    }, 180_000);
});

describe("signing in at the remembered page", () => {
    const creds = { username: REUSE_SITE_USER.email, password: REUSE_SITE_USER.password };
    const withSession = async <T>(fn: (s: BrowserSession) => Promise<T>) => {
        const s = await BrowserSession.launch(browser, { startUrl: SITE });
        try {
            return await fn(s);
        } finally {
            await s.close();
        }
    };

    it("a sign-in page linked from nowhere is not found by the usual search", async () => {
        const r = await withSession((s) => login(s, SITE, creds));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/No login form found/);
    }, 60_000);

    it("goes straight to the remembered page, fills the form and checks the result", async () => {
        site.reset();
        const r = await withSession((s) => login(s, SITE, creds, undefined, { loginPath: "/members/enter" }));
        expect(r).toMatchObject({ ok: true, remembered: "used", loginPath: "/members/enter" });
        expect(new URL(r.landingUrl!).pathname).toBe("/members");
        expect(site.signIns).toBe(1);
    }, 60_000);

    it("wrong details at the remembered page are a failed sign-in, never a pass", async () => {
        site.reset();
        const r = await withSession((s) => login(s, SITE, { ...creds, password: "wrong-password" }, undefined, { loginPath: "/members/enter" }));
        expect(r.ok).toBe(false);
        expect(r.remembered).toBe("failed");
        expect(site.signIns).toBe(1);
    }, 60_000);

    it("a remembered page that no longer has the form falls back to the usual search", async () => {
        const r = await withSession((s) => login(s, SITE, creds, undefined, { loginPath: "/a" }));
        expect(r.remembered).toBe("not-found");
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/No login form found/);
    }, 60_000);
});
