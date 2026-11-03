/**
 * Notion as an issue tracker: pages created in a database, over real HTTP against a local receiver shaped like the Notion API
 * (databases and pages, the version header, 2000-character rich-text pieces, 100 child blocks, the error bodies Notion sends).
 * No browser and no LLM; nothing leaves this machine.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildIssueDraft, type Block } from "../src/platform/issues/content.js";
import { NOTION_MAX_BLOCKS, NOTION_TEXT_LIMIT, NOTION_VERSION, richText, toNotionBlocks } from "../src/platform/issues/notion.js";
import { extractNotionDatabaseId } from "../src/platform/issues/types.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 5730;
const NOTION = `http://127.0.0.1:${PORT}`;
const TOKEN = "secret_NotionSentinelToken0123456789abcdef";
const DB_OK = "a1b2c3d4-e5f6-4789-8abc-0123456789ab";
const DB_RENAMED = "b1b2c3d4-e5f6-4789-8abc-0123456789ab"; // title column is called "Task"
const DB_HIDDEN = "c1b2c3d4-e5f6-4789-8abc-0123456789ab"; // not shared with the integration
const DB_ODD = "d1b2c3d4-e5f6-4789-8abc-0123456789ab"; // Notion answers 400
const DB_PLAIN = "e1b2c3d4-e5f6-4789-8abc-0123456789ab"; // "Name" exists but is not the title column

interface Recorded {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    raw: string;
    body: any;
}
const calls: Recorded[] = [];
let revoked = false;
let pageNo = 0;
let server: http.Server;

const send = (res: http.ServerResponse, code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
};
const error = (res: http.ServerResponse, status: number, code: string, message: string) => send(res, status, { object: "error", status, code, message });

/** https://developers.notion.com/reference/retrieve-a-database and /reference/post-page (the parts we use) */
function notion(req: http.IncomingMessage, body: any, res: http.ServerResponse) {
    if (req.headers.authorization !== `Bearer ${TOKEN}` || revoked) return error(res, 401, "unauthorized", "API token is invalid.");
    if (req.headers["notion-version"] !== NOTION_VERSION) return error(res, 400, "invalid_request", "Unsupported Notion-Version");
    const url = req.url!.split("?")[0]!;
    const db = /^\/v1\/databases\/([^/]+)$/.exec(url);
    if (db && req.method === "GET") {
        const id = decodeURIComponent(db[1]!);
        if (id === DB_HIDDEN) return error(res, 404, "object_not_found", `Could not find database with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`);
        if (id === DB_ODD) return error(res, 400, "validation_error", "path failed validation: path.database_id should be a valid uuid");
        if (id === DB_RENAMED) return send(res, 200, { object: "database", id, title: [{ plain_text: "Bugs" }], properties: { Task: { type: "title" }, Status: { type: "select" } } });
        if (id === DB_PLAIN) return send(res, 200, { object: "database", id, title: [], properties: { Name: { type: "rich_text" }, Title: { type: "title" } } });
        if (id === DB_OK) return send(res, 200, { object: "database", id, title: [{ plain_text: "QA " }, { plain_text: "findings" }], properties: { Name: { type: "title" }, Status: { type: "select" } } });
        return error(res, 404, "object_not_found", "Could not find database");
    }
    if (url === "/v1/pages" && req.method === "POST") {
        const parent = body?.parent?.database_id;
        const titleProp = parent === DB_RENAMED ? "Task" : "Name";
        const title = body?.properties?.[titleProp]?.title;
        if (![DB_OK, DB_RENAMED].includes(parent)) return error(res, 404, "object_not_found", "Could not find database");
        if (!Array.isArray(title)) return error(res, 400, "validation_error", `${titleProp} is expected to be title.`);
        if (!Array.isArray(body.children) || body.children.length > 100) return error(res, 400, "validation_error", "body.children.length should be ≤ `100`");
        const tooLong = JSON.stringify(body).match(/"content":"((?:[^"\\]|\\.){2001,})"/);
        if (tooLong) return error(res, 400, "validation_error", "body.children[0].paragraph.rich_text[0].text.content.length should be ≤ `2000`");
        const n = ++pageNo;
        const hex = String(n).padStart(32, "0");
        return send(res, 200, { object: "page", id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, url: `https://www.notion.so/Finding-${hex}` });
    }
    error(res, 404, "invalid_request_url", `Invalid request URL.`);
}

let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;

const spec = (testId: string, title: string, extra: Partial<TestSpec> = {}): TestSpec =>
    TestSpecSchema.parse({
        testId,
        title,
        kind: "api",
        category: "Checkout",
        priority: "high",
        steps: [
            { action: "request", method: "GET", path: "/api/cart" },
            { action: "assertResponse", check: "statusBelow", expected: 500 },
        ],
        expectedResults: ["The cart loads without a server error"],
        ...extra,
    });

function seed(testSpec: TestSpec, reason: string): string {
    const { repo } = platform;
    const id = repo.insertTest({ projectId, suiteId: repo.getOrCreateSuite(projectId, testSpec.category, "checkout"), jobId: null, spec: testSpec, framework: "playwright-api", validationStatus: "NEEDS_REVIEW" });
    repo.updateTest(id, { reason, validationStatus: "NEEDS_REVIEW" });
    repo.addExecution({
        testId: id,
        scriptId: null,
        jobId: null,
        attempt: 1,
        status: "failed",
        durationMs: 120,
        startedAt: new Date().toISOString(),
        steps: [
            { index: 0, title: "GET /api/cart", status: "passed" },
            { index: 1, title: "Verify response", status: "failed", error: "boom" },
        ],
    });
    return id;
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            let body: any;
            try {
                body = raw ? JSON.parse(raw) : undefined;
            } catch {
                body = raw;
            }
            calls.push({ method: req.method!, url: req.url!, headers: req.headers, raw, body });
            notion(req, body, res);
        });
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-notion-"));
    process.env.PUBLIC_URL = "https://platform.example.test";
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir }));
    app = await buildServer(platform);
    projectId = platform.repo.createProject({ name: "Notion demo" }).id as string;
    platform.repo.createApplication(projectId, "https://shop.example.test", {});
}, 30_000);

afterAll(async () => {
    delete process.env.PUBLIC_URL;
    delete process.env.BLOCK_PRIVATE_TARGETS;
    await app?.close();
    platform?.db.close();
    server?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, text: res.body };
};
const connect = (over: Record<string, unknown> = {}) => call("POST", `/api/projects/${projectId}/integrations`, { kind: "notion", databaseId: DB_OK, token: TOKEN, apiUrl: NOTION, ...over });

describe("finding the database in what a user pastes", () => {
    it.each([
        [DB_OK, DB_OK],
        [DB_OK.replace(/-/g, ""), DB_OK],
        [DB_OK.toUpperCase(), DB_OK],
        [`https://www.notion.so/${DB_OK.replace(/-/g, "")}`, DB_OK],
        // the view id after ?v= is not the database
        [`https://www.notion.so/acme/${DB_OK.replace(/-/g, "")}?v=${"f".repeat(32)}&pvs=4`, DB_OK],
        [`https://www.notion.so/acme/QA-findings-${DB_OK.replace(/-/g, "")}?v=${"f".repeat(32)}`, DB_OK],
        [`  https://notion.so/${DB_OK}  `, DB_OK],
    ])("%s", (input, id) => {
        expect(extractNotionDatabaseId(input)).toBe(id);
    });

    it.each(["", "not a link", "https://www.notion.so/acme/QA-findings", "1234", "g".repeat(32), `${"a".repeat(31)}`, "javascript:alert(1)"])("refuses %j", (input) => {
        expect(extractNotionDatabaseId(input)).toBeUndefined();
    });

    it("is also done when connecting: a pasted link is stored as the plain id", async () => {
        const res = await connect({ databaseId: `https://www.notion.so/acme/QA-${DB_OK.replace(/-/g, "")}?v=${"f".repeat(32)}` });
        expect(res.status).toBe(201);
        expect(res.body.config).toMatchObject({ kind: "notion", databaseId: DB_OK, titleProperty: "Name" });
        await call("DELETE", `/api/integrations/${res.body.id}`);
        const bad = await connect({ databaseId: "https://www.notion.so/acme/nothing-here" });
        expect(bad.status).toBe(400);
        expect(bad.text).toMatch(/link to your Notion database/);
    });
});

describe("connecting Notion", () => {
    let id = "";

    it("checks the database with a real call (version header, bearer token) and never returns the token", async () => {
        const before = calls.length;
        const res = await connect();
        expect(res.status).toBe(201);
        id = res.body.id;
        expect(res.body).toMatchObject({ kind: "notion", name: `Notion database ${DB_OK.slice(0, 8)}`, config: { kind: "notion", databaseId: DB_OK, titleProperty: "Name", apiUrl: NOTION } });
        expect(res.text).not.toContain(TOKEN);
        const check = calls.slice(before).find((c) => c.method === "GET")!;
        expect(check.url).toBe(`/v1/databases/${DB_OK}`);
        expect(check.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(check.headers["notion-version"]).toBe("2022-06-28");
        const list = await call("GET", `/api/projects/${projectId}/integrations`);
        expect(list.body).toHaveLength(1);
        expect(list.text).not.toContain(TOKEN);
    });

    it("stores the token encrypted: not in the table, not in the database files", () => {
        const row = platform.db.get<{ secret_enc: string; config_json: string }>("SELECT secret_enc, config_json FROM integrations WHERE id = ?", id)!;
        expect(row.secret_enc + row.config_json).not.toContain(TOKEN);
        expect(row.secret_enc.split(".")).toHaveLength(3);
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        for (const f of fs.readdirSync(dataDir).filter((n) => n.startsWith("platform.db"))) expect(fs.readFileSync(path.join(dataDir, f)).includes(TOKEN)).toBe(false);
    });

    it("explains a wrong token in Notion's words and saves nothing", async () => {
        const res = await connect({ token: "secret_wrongwrongwrong" });
        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/Notion didn’t accept the token/);
        expect(res.body.details).toMatchObject({ code: "unauthorized", upstreamStatus: 401 });
        expect(res.text).not.toContain("secret_wrongwrongwrong");
        expect((await call("GET", `/api/projects/${projectId}/integrations`)).body).toHaveLength(1);
    });

    it("tells the user to share a database that Notion cannot see", async () => {
        const res = await connect({ databaseId: DB_HIDDEN });
        expect(res.status).toBe(502);
        expect(res.body.details.code).toBe("not_found");
        expect(res.body.error).toMatch(/Notion can’t see that database/);
        expect(res.body.error).toMatch(/share it with your integration/);
    });

    it("passes on Notion's own message for a request it rejects", async () => {
        const res = await connect({ databaseId: DB_ODD });
        expect(res.status).toBe(502);
        expect(res.body.details.code).toBe("rejected");
        expect(res.body.error).toContain("path.database_id should be a valid uuid");
    });

    it("checks the title column and names the real one", async () => {
        const missing = await connect({ databaseId: DB_RENAMED });
        expect(missing.status).toBe(502);
        expect(missing.body.error).toBe("That database has no column called “Name”. Its title column is “Task”: use that name.");
        const ok = await connect({ databaseId: DB_RENAMED, titleProperty: "Task" });
        expect(ok.status).toBe(201);
        await call("DELETE", `/api/integrations/${ok.body.id}`);
        const wrongType = await connect({ databaseId: DB_PLAIN });
        expect(wrongType.status).toBe(502);
        expect(wrongType.body.error).toBe("“Name” is not the title column of that database. Its title column is “Title”: use that name.");
    });

    it("validates input", async () => {
        expect((await connect({ token: "" })).status).toBe(400);
        expect((await connect({ titleProperty: "x".repeat(101) })).status).toBe(400);
        expect((await connect({ apiUrl: "ftp://x" })).status).toBe(400);
        expect((await call("POST", `/api/projects/nope/integrations`, { kind: "notion", databaseId: DB_OK, token: "t" })).status).toBe(404);
    });

    it("tests a saved connection with a real call and reports a revoked token as an answer", async () => {
        const ok = await call("POST", `/api/integrations/${id}/test`);
        expect(ok.body).toMatchObject({ ok: true });
        expect(ok.body.message).toBe("Connected to the Notion database “QA findings”.");
        revoked = true;
        const bad = await call("POST", `/api/integrations/${id}/test`);
        revoked = false;
        expect(bad.status).toBe(200);
        expect(bad.body).toMatchObject({ ok: false, code: "unauthorized" });
        expect(bad.body.message).not.toContain(TOKEN);
    });

    it("can be renamed, pointed at another database by a pasted link, and given a new token", async () => {
        const res = await call("PATCH", `/api/integrations/${id}`, { name: "QA board", token: TOKEN, titleProperty: "Name", databaseId: `https://www.notion.so/${DB_OK.replace(/-/g, "")}?v=${"1".repeat(32)}` });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: "QA board", config: { databaseId: DB_OK, titleProperty: "Name" } });
        expect(res.text).not.toContain(TOKEN);
        expect((await call("POST", `/api/integrations/${id}/test`)).body.ok).toBe(true);
        expect((await call("PATCH", `/api/integrations/${id}`, { databaseId: "nope" })).status).toBe(400);
    });
});

describe("creating a Notion page from a finding", () => {
    let id = "";
    let testId = "";
    beforeAll(async () => {
        id = (await call("GET", `/api/projects/${projectId}/integrations`)).body[0].id;
        testId = seed(spec("API-001", "Cart loads for a signed-in shopper", { priority: "critical" }), "Server error: GET /api/cart returned 503 (step \"Verify response\").");
    });

    it("creates a page in the database with the title, the details as blocks and the Notion version header", async () => {
        const before = calls.length;
        const res = await call("POST", `/api/tests/${testId}/issue`, { integrationId: id });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ existing: false, link: { provider: "notion", externalId: "page", url: expect.stringMatching(/^https:\/\/www\.notion\.so\/Finding-0+1$/) } });

        const sent = calls.slice(before).find((c) => c.method === "POST")!;
        expect(sent.url).toBe("/v1/pages");
        expect(sent.headers["notion-version"]).toBe("2022-06-28");
        expect(sent.body.parent).toEqual({ database_id: DB_OK });
        expect(sent.body.properties.Name.title).toEqual([{ type: "text", text: { content: "[Critical] Cart loads for a signed-in shopper" } }]);
        const children: any[] = sent.body.children;
        expect(children.length).toBeGreaterThan(8);
        expect(children.length).toBeLessThanOrEqual(NOTION_MAX_BLOCKS);
        expect(new Set(children.map((c) => c.type))).toEqual(new Set(["heading_3", "paragraph", "code", "bulleted_list_item", "numbered_list_item"]));
        const all = JSON.stringify(children);
        expect(all).toContain("Server error: GET /api/cart returned 503");
        expect(all).toContain("Severity: Critical (server error on a critical journey)");
        expect(all).toContain("← failed here");
        // the link back to the test is a real link on the text
        expect(children.some((c) => c.paragraph?.rich_text?.[0]?.text?.link?.url === `https://platform.example.test/#/tests/${testId}`)).toBe(true);
    });

    it("sends the token in the Authorization header only: not in the address, the body or the stored link", async () => {
        const post = calls.filter((c) => c.method === "POST").at(-1)!;
        expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(post.url).not.toContain(TOKEN);
        expect(post.raw).not.toContain(TOKEN);
        const link = (await call("GET", `/api/tests/${testId}/issues`)).body;
        expect(JSON.stringify(link)).not.toContain(TOKEN);
    });

    it("is idempotent: asking again returns the same page and sends nothing", async () => {
        const posts = () => calls.filter((c) => c.method === "POST").length;
        const before = posts();
        const again = await call("POST", `/api/tests/${testId}/issue`, { integrationId: id });
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ existing: true, link: { provider: "notion" } });
        expect(posts()).toBe(before);
    });

    it("a double click creates one page, not two", async () => {
        const t = seed(spec("API-002", "Coupon code is applied"), "Verify response: expected 200 but got 404");
        const before = calls.filter((c) => c.method === "POST").length;
        const [a, b] = await Promise.all([call("POST", `/api/tests/${t}/issue`, { integrationId: id }), call("POST", `/api/tests/${t}/issue`, { integrationId: id })]);
        expect([a.status, b.status].sort()).toEqual([200, 201]);
        expect(a.body.link.id).toBe(b.body.link.id);
        expect(calls.filter((c) => c.method === "POST").length).toBe(before + 1);
    });

    it("uses the title column the connection names", async () => {
        const conn = await connect({ databaseId: DB_RENAMED, titleProperty: "Task" });
        expect(conn.status).toBe(201);
        const t = seed(spec("API-003", "Search finds a product"), "Server error: GET /api/search returned 500");
        const res = await call("POST", `/api/tests/${t}/issue`, { integrationId: conn.body.id });
        expect(res.status).toBe(201);
        const sent = calls.filter((c) => c.method === "POST").at(-1)!;
        expect(sent.body.parent.database_id).toBe(DB_RENAMED);
        expect(sent.body.properties.Task.title[0].text.content).toBe("[High] Search finds a product");
    });

    it("turns Notion failures into plain sentences and creates no link", async () => {
        const t = seed(spec("API-004", "Another finding"), "Server error: GET /api/x returned 500");
        revoked = true;
        const res = await call("POST", `/api/tests/${t}/issue`, { integrationId: id });
        revoked = false;
        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/Notion didn’t accept the token/);
        expect((await call("GET", `/api/tests/${t}/issues`)).body).toEqual([]);
        // and a retry once it works creates the page
        expect((await call("POST", `/api/tests/${t}/issue`, { integrationId: id })).status).toBe(201);
    });

    it("the same test can have a page in Notion and nothing else is affected", async () => {
        const links = (await call("GET", `/api/tests/${testId}/issues`)).body;
        expect(links.map((l: any) => l.provider)).toEqual(["notion"]);
    });
});

describe("the text of a page", () => {
    const longText = "x".repeat(5300);

    it("splits any text into pieces of at most 2000 characters and loses nothing", () => {
        const pieces = richText(longText);
        expect(pieces.map((p) => p.text.content.length)).toEqual([2000, 2000, 1300]);
        expect(pieces.map((p) => p.text.content).join("")).toBe(longText);
        expect(richText("")).toEqual([]);
        // an emoji is two UTF-16 units: it is never cut in half, and no piece is over the limit
        const emoji = richText("😀".repeat(1500));
        expect(emoji.every((p) => p.text.content.length <= NOTION_TEXT_LIMIT)).toBe(true);
        expect(emoji.map((p) => p.text.content).join("")).toBe("😀".repeat(1500));
        expect(emoji.every((p) => !/[\ud800-\udbff]$/.test(p.text.content))).toBe(true);
    });

    it("keeps markup and look-alike links as plain text (Notion shows content literally)", () => {
        const hostile = "**bold** [click](https://evil.example) <script>alert(1)</script> ``` # heading @everyone";
        const [piece] = richText(hostile);
        expect(piece!.text.content).toBe(hostile);
        expect(piece!.text.link).toBeUndefined();
        expect(Object.keys(piece!)).toEqual(["type", "text"]); // no annotations, no mention
        const blocks = toNotionBlocks([{ t: "paragraph", text: hostile }, { t: "link", label: "Open", url: "javascript:alert(1)" }]);
        expect(JSON.stringify(blocks)).not.toContain("javascript:");
    });

    it("never builds more than 100 blocks, and says where the rest is", () => {
        const blocks: Block[] = [{ t: "heading", text: "Steps" }, { t: "list", ordered: true, items: Array.from({ length: 400 }, (_, i) => `Step ${i + 1}`) }];
        const out = toNotionBlocks(blocks);
        expect(out).toHaveLength(NOTION_MAX_BLOCKS);
        expect(JSON.stringify(out.at(-1))).toContain("The rest of the details are in the AI Testing Platform.");
        expect(out[1]!.type).toBe("numbered_list_item");
    });

    it("holds a long failure message in one code block of several pieces", () => {
        const out = toNotionBlocks([{ t: "code", text: longText }]);
        expect(out).toHaveLength(1);
        const code = out[0] as any;
        expect(code.type).toBe("code");
        expect(code.code.language).toBe("plain text");
        expect(code.code.rich_text).toHaveLength(3);
    });

    it("builds a whole issue within the limits", () => {
        const s = spec("WEB-001", "Checkout works");
        const draft = buildIssueDraft({ testKey: "WEB-001", title: "Checkout works", suite: "Checkout", spec: s, validationStatus: "NEEDS_REVIEW", reason: "y".repeat(9000), stepResults: [], testUrl: "https://p.example/#/tests/1" });
        const blocks = toNotionBlocks(draft.blocks);
        expect(blocks.length).toBeLessThanOrEqual(NOTION_MAX_BLOCKS);
        const texts = JSON.stringify(blocks).match(/"content":"((?:[^"\\]|\\.)*)"/g)!;
        expect(texts.every((t) => t.length - 12 <= NOTION_TEXT_LIMIT)).toBe(true);
    });
});

describe("outbound address guard", () => {
    it("refuses a private apiUrl when BLOCK_PRIVATE_TARGETS is on, when saving and when calling, and sends nothing", async () => {
        const saved = await connect({ databaseId: DB_OK });
        expect(saved.status).toBe(201);
        const t = seed(spec("API-020", "Guard finding"), "Server error: GET /api/z returned 500");
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const hits = calls.length;
            const use = await call("POST", `/api/tests/${t}/issue`, { integrationId: saved.body.id });
            expect(use.status).toBe(502);
            expect(use.body.details.code).toBe("blocked");
            const local = await connect();
            expect(local.status).toBe(400);
            expect(local.body.error).toMatch(/private|loopback/i);
            expect((await connect({ apiUrl: "http://169.254.169.254" })).status).toBe(400);
            // A new address needs the token again (the stored one is only sent where it was entered for); with it, the guard refuses the address.
            expect((await call("PATCH", `/api/integrations/${saved.body.id}`, { apiUrl: "http://localhost:5730" })).body.error).toMatch(/Enter the token/);
            const moved = await call("PATCH", `/api/integrations/${saved.body.id}`, { apiUrl: "http://localhost:5730", token: TOKEN });
            expect(moved.status).toBe(400);
            expect(moved.body.error).toMatch(/private|loopback/i);
            expect(calls.length).toBe(hits);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
    });

    it("never follows a redirect (the Authorization header would travel with it)", async () => {
        const redirect = http.createServer((_req, res) => {
            res.writeHead(302, { location: `${NOTION}/v1/databases/${DB_OK}` });
            res.end();
        });
        await new Promise<void>((r) => redirect.listen(5731, "127.0.0.1", r));
        const before = calls.length;
        const res = await connect({ apiUrl: "http://127.0.0.1:5731" });
        redirect.close();
        expect(res.status).toBe(502);
        expect(res.body.details.code).toBe("rejected");
        expect(calls.length).toBe(before);
    });
});

describe("the default address", () => {
    it("is Notion's own API (nothing is sent anywhere else unless an apiUrl is given)", async () => {
        // Read from the source of the provider rather than calling out: this test must never reach the real service.
        const src = fs.readFileSync(path.join(REPO_ROOT, "src/platform/issues/notion.ts"), "utf8");
        expect(src).toContain('"https://api.notion.com"');
    });
});
