/**
 * What the crawl understands about a page beyond its links: each form field's constraints, the dialogs, menus and tables a page
 * has (table headers only, never cell text), and a marker on every page this crawl produced. Never a value typed or shown in a cell.
 * A local app on this file's own port (tests/fixtures/understanding-app.mjs).
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/crawler-understanding.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl, VALIDATION_PROBES, type CrawlResult } from "../src/engine/discovery/crawler.js";
import { fragmentFromExploration } from "../src/engine/intel/from-exploration.js";
import type { AppModel as UnderstandingModel, FormFieldModel } from "../src/engine/understanding/app-model.js";

const PORT = 9720;
const BASE = `http://127.0.0.1:${PORT}`;
let app: ChildProcess;
let browser: Browser;

interface Stats {
    posts: number;
    formGets: number;
    api: string[];
    saves: string[];
    ws: string[];
}
async function stats(): Promise<Stats> {
    return (await fetch(`${BASE}/__stats`)).json() as Promise<Stats>;
}

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/understanding-app.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
        if (await fetch(`${BASE}/__stats`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    app?.kill();
});

function context(): EngineContext {
    return { config: loadConfig({}), emit: () => undefined, llm: null } as unknown as EngineContext;
}

/** What the browser held when the crawl ended: its cookies and how many pages were still open. */
let ended: { cookies: string[]; openPages: number };

async function crawlApp(extra: { pageUnderstanding?: boolean } = {}): Promise<CrawlResult> {
    const session = await BrowserSession.launch(browser, { startUrl: BASE });
    try {
        const r = await crawl(session, context(), { startUrl: BASE, maxPages: 5, maxDepth: 1, maxPerPattern: 2, ...extra });
        // Long enough for anything a page scheduled (a delayed save) to have gone out.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        ended = { cookies: (await session.context.cookies()).map((c) => c.name), openPages: session.context.pages().length };
        return r;
    } finally {
        await session.close();
    }
}

let result: CrawlResult;
const pageAt = (p: string) => result.pages.find((x) => x.path === p)!;

describe("the crawl's understanding of a page", () => {
    beforeAll(async () => {
        result = await crawlApp();
    }, 120_000);

    it("records each form field's constraints exactly as the page declares them", () => {
        const fields = pageAt("/register").forms[0]!.fields.map(({ type, name, required, min, max, minLength, maxLength, pattern, options }) => ({ type, name, required, min, max, minLength, maxLength, pattern, options }));
        expect(fields).toEqual([
            { type: "email", name: "email", required: true },
            { type: "number", name: "age", required: true, min: "18", max: "120" },
            { type: "text", name: "username", required: true, minLength: 3, maxLength: 20, pattern: "[a-z0-9]+" },
            { type: "select", name: "country", required: true, options: ["India", "Norway", "Peru"] },
            { type: "tel", name: "phone", required: false },
            { type: "text", name: "nickname", required: true },
            { type: "text", name: "city", required: true },
            { type: "text", name: "referral", required: true },
            { type: "text", name: "draft", required: true },
            { type: "text", name: "resetcode", required: true },
            { type: "password", name: "password", required: true, minLength: 8 },
            { type: "textarea", name: "bio", required: false, maxLength: 200 },
        ].map((f) => ({ min: undefined, max: undefined, minLength: undefined, maxLength: undefined, pattern: undefined, options: undefined, ...f })));
    });

    it("lists the page's dialogs, menus and tables, with table headers only", () => {
        const home = pageAt("/");
        expect(home.dialogs).toEqual(["Session expiring", "Getting help"]);
        expect(home.menus).toEqual([{ name: "Account", items: ["Profile", "Preferences"] }]);
        expect(home.tables).toEqual([
            { name: "Recent orders", headers: ["Order", "Status", "Total"] },
            { name: "Stock levels", headers: ["Item", "On hand"] },
        ]);
        expect(pageAt("/register").tables ?? []).toEqual([]);
    });

    it("stores no cell text and no field value in what it adds", () => {
        const added = JSON.stringify(result.pages.map((p) => ({ forms: p.forms, dialogs: p.dialogs, menus: p.menus, tables: p.tables })));
        expect(added).not.toMatch(/CELL-/);
        expect(added).not.toContain("hidden-value");
        expect(added).not.toContain("5550100");
    });

    it("reads validation messages by typing an invalid value and leaving the field", () => {
        const fields: Record<string, FormFieldModel["validation"]> = Object.fromEntries(pageAt("/register").forms[0]!.fields.map((f) => [f.name ?? "", f.validation]));
        // Native messages are the browser's own wording: only that there is one is fixed. The app's own message is read as shown.
        expect(fields).toEqual({
            email: { check: "type", message: expect.any(String) },
            age: { check: "min", message: expect.any(String) },
            username: { check: "minLength", message: expect.any(String) },
            country: undefined,
            phone: { check: "type", message: "Enter digits only, at least 7" },
            nickname: { check: "required", message: expect.any(String) },
            city: { check: "required", message: expect.any(String) },
            referral: { check: "required", message: expect.any(String) },
            draft: { check: "required", message: expect.any(String) },
            // A destructive-sounding name, a password and a field with nothing to break are left alone.
            resetcode: undefined,
            password: undefined,
            bio: undefined,
        });
        for (const f of Object.values(fields)) if (f) expect(f.message.trim().length).toBeGreaterThan(0);
    });

    it("never sends a form, even when leaving a field makes the page try to", async () => {
        // Leaving fields calls requestSubmit() and submit() on a novalidate form, navigates with the values, and POSTs in the background;
        // nothing reached the server, by POST or by GET.
        expect(await stats()).toMatchObject({ posts: 0, formGets: 0 });
    });

    it("lets nothing typed leave the browser, by any route, and closes every page it opened", async () => {
        const fields = Object.fromEntries(pageAt("/profile").forms[0]!.fields.map((f) => [f.name, f.validation?.check]));
        // All eight were probed (each handler really ran), on the right fields although the page's fields moved before the probe.
        expect(fields).toEqual({ contact: "type", debounced: "type", blank: "type", opener: "type", lookup: "type", beacon: "type", framed: "type", socket: "type" });
        const seen = await stats();
        expect(seen.saves).toEqual([]);
        expect(seen.ws).toEqual([]);
        expect(ended.cookies).not.toContain("wrong_field");
        expect(ended.openPages).toBe(1);
    });

    it("stores none of the values it typed", () => {
        const all = JSON.stringify(result);
        for (const v of Object.values(VALIDATION_PROBES)) if (v) expect(all).not.toContain(v);
    });

    it("ties a request to the safe interaction that caused it, and none to the page load", () => {
        // "Open details" calls GET /api/orders/42; the page load's GET /api/summary belongs to no control; Help and the menu call nothing.
        expect(pageAt("/").interactions).toEqual([{ control: "Open details", method: "GET", path: "/api/orders/{id}" }]);
        expect(pageAt("/").apiCalls).toContain("GET /api/summary");
    });

    it("converts into application knowledge with the constraints, messages, structures and requests intact, and nothing missing", () => {
        const model: UnderstandingModel = {
            url: `${BASE}/`,
            origin: BASE,
            siteType: "webapp",
            purpose: "",
            features: [],
            pages: result.pages,
            navigation: result.navigation,
            apis: [],
            authentication: { required: false, mechanisms: [], loggedIn: false },
            journeys: [],
            externalDependencies: [],
            documentedTestCases: [],
            stats: { pagesVisited: result.pages.length, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
        };
        const f = fragmentFromExploration({ model, ref: BASE, now: new Date(0).toISOString() });
        const home = f.model.pages.find((p) => p.path === "/")!;
        const register = f.model.pages.find((p) => p.path === "/register")!;
        expect(register.forms[0]!.fields.find((x) => x.name === "age")).toMatchObject({ type: "number", required: true, min: "18", max: "120", message: expect.any(String) });
        expect(register.forms[0]!.fields.find((x) => x.name === "phone")!.message).toBe("Enter digits only, at least 7");
        expect(home.structures.map((x) => `${x.kind}:${x.name}`)).toEqual(["dialog:Session expiring", "dialog:Getting help", "menu:Account", "table:Recent orders", "table:Stock levels"]);
        expect(home.interactions).toEqual([{ control: "Open details", method: "GET", path: "/api/orders/{id}" }]);
        expect(f.model.missingContext).toEqual([]);
        expect(f.rules).toEqual([]);
    });

    it("marks every page it produced", () => {
        expect(result.pages.length).toBeGreaterThanOrEqual(2);
        for (const p of result.pages) expect(p.discovery).toBe(2);
    });

    it("adds none of this when page understanding is switched off, as an older runner would send", async () => {
        const old = await crawlApp({ pageUnderstanding: false });
        expect(old.pages.map((p) => p.path).sort()).toEqual(result.pages.map((p) => p.path).sort());
        for (const p of old.pages) {
            expect([p.discovery, p.dialogs, p.menus, p.tables, p.interactions]).toEqual([undefined, undefined, undefined, undefined, undefined]);
            for (const f of p.forms.flatMap((x) => x.fields)) expect(Object.keys(f).sort()).toEqual(["label", "name", "placeholder", "required", "type"]);
        }
    }, 120_000);
});
