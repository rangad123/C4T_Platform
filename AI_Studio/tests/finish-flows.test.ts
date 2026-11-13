/**
 * Tests that can finish what they start, with a scripted model double (never a real model) against a local sample site: a confirmed
 * delete, a cookie banner, a newsletter popup a note names, an upload and a dropped file (generated files), a drag list, a download,
 * a link that opens a new tab, and a server error on submit. Each flow is authored, rendered and passes in a real Playwright run;
 * the crawler never accepts a dialog; a suspected bug is kept only when most of 3 verdicts say it is real.
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl } from "../src/engine/discovery/crawler.js";
import { playwrightGenerator } from "../src/engine/generators/playwright.js";
import type { SiteNote } from "../src/engine/memory/notes.js";
import { ScenarioSchema, type Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { validateBatch } from "../src/engine/validation/validator.js";
import { authorWebSpec, toSpec, type AuthorOutcome } from "../src/engine/web/author.js";
import { newerThan, scanPlaywrightApis } from "../src/engine/portable/playwright-apis.js";
import { DIALOG_HELPER_SOURCE, DOWNLOAD_HELPER_SOURCE, overlayHelperSource, overlayRules, sampleTypeFor } from "../src/engine/web/interruptions.js";
import { uploadFilesOf } from "../src/engine/web/pages.js";

const PORT = 9300;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;
let browser: Browser;
const hits: string[] = [];

const page = (title: string, body: string) => `<!doctype html><html lang="en"><title>${title}</title><body>${body}</body></html>`;
const SITE: Record<string, string> = {
    "/courses": page("Courses", `<h1>Courses</h1><ul><li id="c1">Algebra <button onclick="if (confirm('Delete course?')) { document.getElementById('c1').remove(); document.getElementById('m').textContent = 'Course deleted'; }">Delete course</button></li></ul><p id="m"></p>`),
    "/": page("Home", `<h1>Home</h1><div id="cb" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div role="region" aria-label="Cookies"><p>We use cookies.</p><button onclick="document.getElementById('cb').remove();document.getElementById('c').textContent='Consent: accepted'">Accept all</button><button onclick="document.getElementById('cb').remove();document.getElementById('c').textContent='Consent: rejected'">Reject all</button></div></div><p id="c">Consent: none</p><button onclick="document.getElementById('s').textContent='Started'">Start</button><p id="s"></p>`),
    "/news": page("News", `<h1>News</h1><div class="modal" style="position:fixed;inset:0;background:#eee"><h2>Join our newsletter</h2><button onclick="this.parentElement.remove()">No thanks</button></div><button onclick="document.getElementById('a').textContent='Article opened'">Read more</button><p id="a"></p>`),
    "/upload": page("Upload", `<h1>Upload</h1><label>Avatar <input type="file" accept="image/png" onchange="document.getElementById('u').textContent='Uploaded: '+this.files[0].name+' ('+this.files[0].type+')'"></label><p id="u"></p>
<div id="dz" style="width:200px;height:80px;border:1px solid" ondragover="event.preventDefault()" ondrop="event.preventDefault();var f=event.dataTransfer.files[0];document.getElementById('d').textContent='Dropped: '+f.name+' '+f.size+' bytes'">Drop files here</div><p id="d"></p>`),
    "/drag": page("Drag", `<h1>Order</h1><ul id="l"><li draggable="true" id="A">Item A</li><li draggable="true" id="B">Item B</li><li draggable="true" id="C">Item C</li></ul><p id="o"></p><script>
let dragged; const l = document.getElementById('l');
const show = () => document.getElementById('o').textContent = 'Order: ' + [...l.children].map((li) => li.id).join(', ');
for (const li of l.children) { li.ondragstart = (e) => { dragged = li; e.dataTransfer.setData('text/plain', li.id); }; li.ondragover = (e) => e.preventDefault(); li.ondrop = (e) => { e.preventDefault(); li.after(dragged); show(); }; }
</script>`),
    "/download": page("Download", `<h1>Reports</h1><a href="/report.csv">Download report</a>`),
    "/blank": page("Links", `<h1>Links</h1><a href="/help" target="_blank">Open help</a>`),
    "/help": page("Help", `<h1>Help centre</h1>`),
    "/form": page("Form", `<h1>Form</h1><button onclick="fetch('/api/save',{method:'POST'}).then(r=>{document.getElementById('r').textContent=r.ok?'Saved':'Something went wrong'})">Submit</button><p id="r"></p>`),
    "/crawl": page("Crawl", `<h1>Crawl</h1><script>if (confirm('Leave this page?')) fetch('/accepted');</script><a href="/crawl2">Next</a>`),
    "/crawl2": page("Crawl two", `<h1>Two</h1><script>if (confirm('Really?')) fetch('/accepted');</script>`),
};

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const url = (req.url ?? "/").split("?")[0]!;
        hits.push(url);
        if (url === "/report.csv") return void res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report-2026.csv"' }).end("name,total\nA,1\n");
        if (url === "/api/save") return void res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
        const html = SITE[url];
        res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(html ?? "not found");
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    server?.close();
});

type Call = { tool: string; input: Record<string, unknown> };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function scripted(calls: Call[]) {
    let i = 0;
    const results: unknown[] = [];
    const model = new MockLanguageModelV3({
        doGenerate: async (opts) => {
            const last = opts.prompt.at(-1);
            if (last?.role === "tool") for (const part of last.content) if (part.type === "tool-result") results.push(part.output);
            const next = calls[i++];
            if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
    return { model, results };
}
function ctxFor(model: MockLanguageModelV3, answers: string[] = []) {
    const events: EngineEvent[] = [];
    const asked: string[] = [];
    let n = 0;
    const ctx: EngineContext = {
        config: loadConfig({}),
        emit: (e) => events.push(e),
        llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async (a) => (asked.push(a.prompt), answers[n++] ?? "") },
    };
    return { ctx, events, asked };
}
const emptyModel = (url: string): AppModel => ({
    url, origin: url, siteType: "other", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});
const scenarioAt = (id: string, startPath: string, expected: string) =>
    ScenarioSchema.parse({ scenarioId: id, title: `Flow ${id}`, description: expected, category: "Flows", startPath, expectedResults: [expected] });
const role = (r: string, value: string) => ({ by: "role", role: r, value });
const finish = (result = "complete") => ({ tool: "finish", input: { result, explanation: "done" } });
const text = (value: string) => ({ tool: "assert", input: { check: "visible", expected: value } });

const notes: SiteNote[] = [{ text: "Close the newsletter popup with 'No thanks' before reading." }];
const FLOWS: Array<{ id: string; path: string; calls: Call[]; check: (steps: Step[], results: string) => void }> = [
    {
        id: "S-DEL", path: "/courses",
        calls: [
            { tool: "click", input: { target: role("button", "Delete course") } },
            { tool: "dialog", input: { response: "accept", message: "Delete course?" } },
            { tool: "click", input: { target: role("button", "Delete course") } },
            text("Course deleted"),
            finish(),
        ],
        check: (steps, results) => {
            expect(results).toMatch(/A confirm dialog appeared: \\?"Delete course\?\\?" - it was dismissed/);
            expect(steps.map((s) => s.action)).toContain("dialog");
        },
    },
    { id: "S-COOK", path: "/", calls: [{ tool: "click", input: { target: role("button", "Start") } }, text("Started"), text("Consent: rejected"), finish()], check: () => undefined },
    { id: "S-NEWS", path: "/news", calls: [{ tool: "click", input: { target: role("button", "Read more") } }, text("Article opened"), finish()], check: () => undefined },
    {
        id: "S-UP", path: "/upload",
        calls: [{ tool: "upload", input: { target: { by: "label", value: "Avatar" } } }, text("Uploaded: generated-sample.png (image/png)"), { tool: "drop", input: { target: { by: "text", value: "Drop files here" } } }, text("Dropped: generated-sample.txt"), finish()],
        check: (steps) => expect(steps.filter((s) => s.action === "upload").map((s) => (s as { file: string }).file)).toEqual(["generated-sample.png", "generated-sample.txt"]),
    },
    { id: "S-DRAG", path: "/drag", calls: [{ tool: "drag", input: { target: { by: "text", value: "Item A" }, to: { by: "text", value: "Item C" } } }, text("Order: B, C, A"), finish()], check: () => undefined },
    { id: "S-DOWN", path: "/download", calls: [{ tool: "download", input: { target: role("link", "Download report"), filename: "report" } }, finish()], check: () => undefined },
    {
        id: "S-TAB", path: "/blank",
        calls: [{ tool: "click", input: { target: role("link", "Open help") } }, { tool: "assert", input: { check: "visible", target: role("heading", "Help centre") } }, finish()],
        check: (steps, results) => {
            expect(results).toMatch(/A new tab opened: http:\/\/127\.0\.0\.1:9300\/help/);
            expect(steps[1]).toMatchObject({ action: "click", opensPopup: true });
            expect(steps[2]).toMatchObject({ action: "assert", inPopup: true });
        },
    },
];

describe("finish flows: authored, rendered, passing in a real run", () => {
    it("authors every flow and each rendered script passes", async () => {
        const authored: Array<{ out: AuthorOutcome; id: string }> = [];
        for (const f of FLOWS) {
            const { model, results } = scripted(f.calls);
            const { ctx } = ctxFor(model);
            const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario: scenarioAt(f.id, f.path, "works"), notes });
            expect(out.status, `${f.id}: ${out.explanation}`).toBe("complete");
            f.check(out.steps, JSON.stringify(results));
            authored.push({ out, id: f.id });
        }
        const specs = authored.map(({ out, id }, i) => ({ spec: toSpec(scenarioAt(id, "/", "works"), out, `WEB-${String(301 + i)}`), id }));
        // Generated files are made by the script: they are never asked for from the project's test files.
        expect(uploadFilesOf(specs.find((s) => s.id === "S-UP")!.spec)).toEqual([]);
        const script = playwrightGenerator.render(specs[0]!.spec, { baseUrl: BASE, notes }).content;
        expect(script).toContain("await installOverlayHandlers(page);");
        expect(script).toContain('dialogPending = armDialog(page, "accept")');
        expect(script).toContain('"phrase":"newsletter"');

        const { ctx } = ctxFor(scripted([]).model);
        const outcomes = await validateBatch(
            ctx,
            { browser, scratchDir: ctx.config.scratchDir, env: { baseUrl: BASE, headless: true }, render: { baseUrl: BASE, notes }, model: emptyModel(BASE), maxRepairAttempts: 0, workers: 1 },
            specs.map(({ spec, id }) => ({ spec, framework: "playwright" as const, scenario: scenarioAt(id, "/", "works") })),
            { onAttempt: async () => undefined, onFinal: async () => undefined },
        );
        for (const [i, o] of outcomes.entries()) expect(o.status, `${specs[i]!.id}: ${o.reason ?? ""}`).toBe("VALIDATED");
    }, 300_000);

    it("a rendered dialog step fails when the dialog says something else", async () => {
        const out: AuthorOutcome = { status: "complete", testData: {}, explanation: "", steps: [
            { action: "navigate", url: "/courses", description: "" },
            { action: "dialog", response: "accept", message: "Archive course?", description: "" },
            { action: "click", locator: { by: "role", role: "button", value: "Delete course" }, description: "" },
            { action: "assert", check: "visible", expected: "Course deleted", description: "" },
        ] };
        const spec = toSpec(scenarioAt("S-X", "/courses", "x"), out, "WEB-399");
        const { ctx } = ctxFor(scripted([]).model);
        const [o] = await validateBatch(
            ctx,
            { browser, scratchDir: ctx.config.scratchDir, env: { baseUrl: BASE, headless: true }, render: { baseUrl: BASE }, model: emptyModel(BASE), maxRepairAttempts: 0, workers: 1 },
            [{ spec, framework: "playwright" as const, scenario: scenarioAt("S-X", "/courses", "x") }],
            { onAttempt: async () => undefined, onFinal: async () => undefined },
        );
        expect(o!.status).toBe("FAILED_VALIDATION");
        expect(o!.reason ?? "").toMatch(/The dialog said .*Delete course\?.*not .*Archive course\?/);
    }, 120_000);
});

describe("server errors and bug verdicts", () => {
    const calls = [{ tool: "click", input: { target: role("button", "Submit") } }, text("Something went wrong"), { tool: "finish", input: { result: "defect", explanation: "Submitting fails with a server error" } }];

    it("tells the agent about the 5xx and keeps a defect most verdicts confirm", async () => {
        const { model, results } = scripted(calls);
        const { ctx, events, asked } = ctxFor(model, ["yes", "no", "Yes, the server failed."]);
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario: scenarioAt("S-500", "/form", "The form is saved") });
        expect(JSON.stringify(results)).toMatch(/POST \/api\/save answered HTTP 500/);
        expect(JSON.stringify(results)).toMatch(/finish\(result=\\?"defect\\?"\)/);
        expect(out.status).toBe("defect");
        expect(asked).toHaveLength(3);
        expect(asked[0]).toContain("POST /api/save answered HTTP 500");
        expect(events.some((e) => e.kind === "defect_confirmed")).toBe(true);
    }, 60_000);

    it("a defect with verdicts yes / no / no is not reported as a bug", async () => {
        const { model } = scripted(calls);
        const { ctx, events, asked } = ctxFor(model, ["yes", "no", "no"]);
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario: scenarioAt("S-501", "/form", "The form is saved") });
        expect(asked).toHaveLength(3);
        expect(out.status).toBe("blocked");
        expect(out.explanation).toMatch(/^Not reported as a bug \(2 of 3 reviews/);
        expect(events.some((e) => e.kind === "defect_unconfirmed")).toBe(true);
    }, 60_000);
});

describe("exploring never accepts a dialog", () => {
    it("the crawler's session dismisses and records every dialog", async () => {
        hits.length = 0;
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        try {
            const { ctx } = ctxFor(scripted([]).model);
            const r = await crawl(session, ctx, { startUrl: BASE + "/crawl", maxPages: 3, maxDepth: 2, maxPerPattern: 2 });
            expect(r.pages.length).toBeGreaterThanOrEqual(2);
            const { dialogs } = session.takeEvents();
            expect(dialogs.length).toBeGreaterThanOrEqual(2);
            expect(dialogs.every((d) => d.answer === "dismissed" && !d.armed)).toBe(true);
            expect(dialogs.map((d) => d.message)).toEqual(expect.arrayContaining(["Leave this page?", "Really?"]));
            expect(hits).not.toContain("/accepted");
        } finally {
            await session.close();
        }
    }, 60_000);
});

describe("pieces", () => {
    it("reads overlays from notes and file types from accept", () => {
        expect(overlayRules([{ text: "close the newsletter popup" }, { text: "Dismiss the chat widget with \"Not now\"" }, { text: "the coupon TEST10 works" }])).toEqual([
            { phrase: "newsletter" },
            { phrase: "chat", button: "Not now" },
        ]);
        expect(sampleTypeFor("image/*,.pdf")).toBe("png");
        expect(sampleTypeFor(".pdf")).toBe("pdf");
        expect(sampleTypeFor("")).toBe("txt");
    });

    it("the script helpers use only Playwright APIs of the oldest supported version", () => {
        for (const src of [overlayHelperSource([{ phrase: "newsletter", button: "No thanks" }]), DIALOG_HELPER_SOURCE, DOWNLOAD_HELPER_SOURCE]) {
            const scan = scanPlaywrightApis(src);
            expect(scan.unknown).toEqual([]);
            expect(newerThan(scan)).toEqual([]);
        }
    });
});
