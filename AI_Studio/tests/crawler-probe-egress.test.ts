/**
 * Nothing typed while validation is probed ever leaves the browser, by any channel: not by the probe page itself, its workers, shared
 * workers, sockets, other tabs (BroadcastChannel), nor later pages of the crawl reading what the probe page left in storage or cookies.
 * A local app on this file's own ports (tests/fixtures/egress-app.mjs) records every request, WebSocket message and UDP packet that
 * carries the typed value.
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/crawler-probe-egress.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl, type CrawlResult } from "../src/engine/discovery/crawler.js";

const PORT = 9721;
const BASE = `http://127.0.0.1:${PORT}`;
let app: ChildProcess;
let browser: Browser;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/egress-app.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
        if (await fetch(`${BASE}/__hits`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    app?.kill();
});

it("lets nothing typed during validation probing leave the browser, then or later in the crawl", async () => {
    const session = await BrowserSession.launch(browser, { startUrl: BASE });
    let result: CrawlResult;
    try {
        result = await crawl(session, { config: loadConfig({}), emit: () => undefined, llm: null } as unknown as EngineContext, { startUrl: BASE, maxPages: 3, maxDepth: 1, maxPerPattern: 3 });
        // Long enough for every delayed send the page, its workers or later pages scheduled.
        await new Promise((r) => setTimeout(r, 5_000));
    } finally {
        await session.close();
    }
    // The probe really ran: the field's message was read, and the later pages were crawled after it.
    expect(result.pages.map((p) => p.path).sort()).toEqual(["/", "/next", "/third"]);
    expect(result.pages.find((p) => p.path === "/")!.forms[0]!.fields[0]!.validation).toMatchObject({ check: "type", message: expect.any(String) });
    const hits = (await (await fetch(`${BASE}/__hits`)).json()) as Array<{ channel: string; text: string }>;
    expect(hits.map((h) => h.channel)).toEqual([]);
}, 120_000);
