/**
 * Reusable libraries (routes/libraries.ts, library-store.ts) against a stand-in Crowd4Test sign-in (port 7660): nested folders, items
 * and their versions, a project copying an item and updating its copy, publishing a project's own item, who may read and change a
 * library, and another organisation's ids answering 404. No model and no browser.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { FOLDER_INTO_ITSELF, FOLDER_NOT_EMPTY, FOLDER_TOO_DEEP, LIBRARY_ITEM_NOT_FOUND } from "../src/platform/library-store.js";
import { ALREADY_USED, CANNOT_CHANGE_LIBRARY } from "../src/platform/routes/libraries.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "libraries-owner-key-7a2c41";
const PAGE = { "x-requested-with": "ai-studio" };
const API_PORT = 7660;

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-admin": me("ada", "ADMIN", []),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-rita": me("rita", "CUSTOMER", ["ai_studio.access"], "org-a"),
    "t-bob": me("bob", "CUSTOMER", PERMISSIONS, "org-b"),
    "t-tim": me("tim", "TESTER", PERMISSIONS),
};

let api: http.Server;
let platform: Platform;
let app: App;
let dataDir = "";

const call = (headers: Record<string, string>, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;
const addMember = async (projectId: string, token: string) => accessControlOf(app).projects.store.addMember(projectId, await personOf(token), { role: "owner", projectAdmin: false, source: "added", addedBy: "test" });

const PAY = { by: "role", role: "button", value: "Pay", exact: true };
const STEPS_V1 = { kind: "web", params: [{ name: "amount", default: "10" }], steps: [{ action: "fill", locator: { by: "label", value: "Amount" }, value: "{{amount}}" }, { action: "click", locator: PAY }] };
const STEPS_V2 = { ...STEPS_V1, steps: [...STEPS_V1.steps, { action: "assert", check: "visible", locator: { by: "text", value: "Paid" } }] };
const HELPER = (word: string) => `import type { Page } from "@playwright/test";\nexport async function open(page: Page) {\n  await page.goto("/${word}");\n}\n`;

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-libraries-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "libraries-test-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }),
    );
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

let shop = "";
let stall = "";
let top = "";
let sub = "";
let stepsItem = "";
let helperItem = "";
let elementItem = "";

describe("folders", () => {
    it("lets a customer who writes tests make nested folders in their organisation's library", async () => {
        const lib = (await as("t-cora", "GET", "/api/libraries")).body;
        expect(lib).toMatchObject({ organizations: [{ id: "org-a", canChange: true }], organization: { id: "org-a" }, canChange: true, folders: [], items: [] });
        const made = await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-a", name: "Checkout" });
        expect(made).toMatchObject({ status: 201, body: { name: "Checkout", parentId: null, organizationId: "org-a" } });
        top = made.body.id;
        sub = (await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-a", parentId: top, name: "Payments" })).body.id;
        expect((await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-a", parentId: top, name: " payments " })).status).toBe(409);
        // The same name is fine under another parent.
        expect((await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-a", parentId: sub, name: "Payments" })).status).toBe(201);
        expect((await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-b", name: "Theirs" })).status).toBe(404);
    });

    it("renames and moves folders, never into themselves, and keeps the depth limit", async () => {
        expect(await as("t-cora", "PATCH", `/api/libraries/folders/${sub}`, { name: "Cards" })).toMatchObject({ status: 200, body: { name: "Cards", parentId: top } });
        expect(await as("t-cora", "PATCH", `/api/libraries/folders/${top}`, { parentId: sub })).toMatchObject({ status: 409, body: { error: FOLDER_INTO_ITSELF } });
        expect(await as("t-cora", "PATCH", `/api/libraries/folders/${sub}`, { parentId: null })).toMatchObject({ status: 200, body: { parentId: null } });
        expect((await as("t-cora", "PATCH", `/api/libraries/folders/${sub}`, { parentId: top })).status).toBe(200);
        let parent = sub;
        for (let level = 3; level <= 6; level++) parent = (await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-a", parentId: parent, name: `Level ${level}` })).body.id;
        expect(await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-a", parentId: parent, name: "Level 7" })).toMatchObject({ status: 409, body: { error: FOLDER_TOO_DEEP } });
        // Moving a deep branch lower would break the limit too.
        const other = (await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-a", name: "Other" })).body.id;
        expect(await as("t-cora", "PATCH", `/api/libraries/folders/${top}`, { parentId: other })).toMatchObject({ status: 409, body: { error: FOLDER_TOO_DEEP } });
        expect(await as("t-cora", "DELETE", `/api/libraries/folders/${top}`)).toMatchObject({ status: 409, body: { error: FOLDER_NOT_EMPTY } });
        expect(await as("t-cora", "DELETE", `/api/libraries/folders/${other}`)).toMatchObject({ status: 200, body: { removed: true } });
    });
});

describe("items and versions", () => {
    it("adds reusable steps, a helper and a shared element, each checked like in a project", async () => {
        const steps = await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", folderId: sub, kind: "steps", name: "Pay by card", description: "Pays the basket", content: STEPS_V1, note: "First cut" });
        expect(steps.status, JSON.stringify(steps.body)).toBe(201);
        expect(steps.body).toMatchObject({ item: { kind: "steps", name: "Pay by card", version: 1, folderId: sub }, versions: [{ version: 1, note: "First cut" }], usedBy: { projects: [], otherProjects: 0 } });
        expect(steps.body.stepsText).toHaveLength(2);
        stepsItem = steps.body.item.id;
        helperItem = (await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "helper", name: "open-page", content: { content: HELPER("a") } })).body.item.id;
        elementItem = (await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", folderId: top, kind: "element", name: "Pay button", content: { kind: "web", locator: PAY } })).body.item.id;
        expect(helperItem && elementItem).toBeTruthy();
        // Taken names (per kind, ignoring case), a bad helper name, code the guard refuses, a typed secret, a broken locator.
        expect((await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "steps", name: "pay BY card", content: STEPS_V1 })).status).toBe(409);
        // No content at all reaches the kind's own check (which names what is wrong), not a refusal of the request's shape.
        const empty = await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "steps", name: "Nothing yet" });
        expect(empty.status).toBe(400);
        expect(empty.body.error).toMatch(/^steps: /);
        expect((await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "helper", name: "Open Page", content: { content: HELPER("a") } })).status).toBe(400);
        const evil = await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "helper", name: "evil", content: { content: 'import { exec } from "child_process";\nexport const run = exec;\n' } });
        expect(evil.status).toBe(422);
        const secret = await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "steps", name: "Leaky", content: { ...STEPS_V1, params: [{ name: "amount", default: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }] } });
        expect(secret.status).toBe(400);
        expect((await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "element", name: "Broken", content: { kind: "web", locator: { by: "nothing" } } })).status).toBe(400);
        const list = (await as("t-cora", "GET", "/api/libraries")).body;
        expect(list.items.map((i: { name: string }) => i.name).sort()).toEqual(["open-page", "Pay button", "Pay by card"].sort());
    });

    it("keeps every version, ignores a save that changes nothing, and refuses a stale one", async () => {
        const v2 = await as("t-cora", "PUT", `/api/libraries/items/${stepsItem}/content`, { content: STEPS_V2, note: "Checks it was paid", expectedVersion: 1 });
        expect(v2).toMatchObject({ status: 200, body: { added: true, item: { version: 2 } } });
        expect(v2.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
        expect((await as("t-cora", "PUT", `/api/libraries/items/${stepsItem}/content`, { content: STEPS_V2 })).body).toMatchObject({ added: false, item: { version: 2 } });
        expect((await as("t-cora", "PUT", `/api/libraries/items/${stepsItem}/content`, { content: STEPS_V1, expectedVersion: 1 })).status).toBe(409);
        const one = (await as("t-cora", "GET", `/api/libraries/items/${stepsItem}/versions/1`)).body;
        expect(one.content.steps).toHaveLength(2);
        expect((await as("t-cora", "GET", `/api/libraries/items/${stepsItem}/versions/9`)).status).toBe(404);
        // Rename and move; a name keeps the kind's rules.
        expect((await as("t-cora", "PATCH", `/api/libraries/items/${elementItem}`, { folderId: sub, description: "The main pay button" })).body.item).toMatchObject({ folderId: sub, description: "The main pay button" });
        expect((await as("t-cora", "PATCH", `/api/libraries/items/${helperItem}`, { name: "Not a module name" })).status).toBe(400);
        expect((await as("t-cora", "PATCH", `/api/libraries/items/${helperItem}`, { name: "open-shop" })).body.item.name).toBe("open-shop");
    });
});

describe("a project using the library", () => {
    it("copies an item into the project; the copy is the project's own", async () => {
        shop = (await as("t-cora", "POST", "/api/projects", { name: "Shop", url: "https://shop.example" })).body.id;
        const before = (await as("t-cora", "GET", `/api/projects/${shop}/library`)).body;
        expect(before).toMatchObject({ organization: { id: "org-a" }, canPublish: true });
        expect(before.items.find((i: { id: string }) => i.id === stepsItem)).toMatchObject({ use: null, nameTakenHere: false, version: 2 });
        const used = await as("t-cora", "POST", `/api/projects/${shop}/library/use`, { itemId: stepsItem });
        expect(used.status, JSON.stringify(used.body)).toBe(201);
        expect(used.body).toMatchObject({ version: 2, localName: "Pay by card" });
        const block = (await as("t-cora", "GET", `/api/projects/${shop}/blocks/${encodeURIComponent("Pay by card")}`)).body;
        expect(block.steps).toHaveLength(3);
        expect(await as("t-cora", "POST", `/api/projects/${shop}/library/use`, { itemId: stepsItem })).toMatchObject({ status: 409, body: { error: ALREADY_USED } });
        for (const itemId of [helperItem, elementItem]) expect((await as("t-cora", "POST", `/api/projects/${shop}/library/use`, { itemId })).status).toBe(201);
        expect((await as("t-cora", "GET", `/api/projects/${shop}/helpers/open-shop`)).body.content).toBe(HELPER("a"));
        expect((await as("t-cora", "GET", `/api/projects/${shop}/objects`)).body.elements.map((e: { name: string }) => e.name)).toContain("Pay button");
        // The library shows who uses it.
        expect((await as("t-cora", "GET", `/api/libraries/items/${stepsItem}`)).body.usedBy).toEqual({ projects: [{ projectId: shop, projectName: "Shop", version: 2, localName: "Pay by card", updateAvailable: false }], otherProjects: 0 });
        expect((await as("t-cora", "GET", "/api/libraries")).body.items.find((i: { id: string }) => i.id === stepsItem).usedBy).toBe(1);
    });

    it("says an update is available, applies it only when asked, and protects the project's own changes", async () => {
        await as("t-cora", "PUT", `/api/libraries/items/${helperItem}/content`, { content: { content: HELPER("b") }, note: "New path" });
        const row = (await as("t-cora", "GET", `/api/projects/${shop}/library`)).body.items.find((i: { id: string }) => i.id === helperItem);
        expect(row.use).toMatchObject({ version: 1, updateAvailable: true, changedHere: false, inProject: true });
        // Nothing reached the project on its own.
        expect((await as("t-cora", "GET", `/api/projects/${shop}/helpers/open-shop`)).body.content).toBe(HELPER("a"));
        const up = await as("t-cora", "POST", `/api/projects/${shop}/library/update`, { itemId: helperItem });
        expect(up).toMatchObject({ status: 200, body: { version: 2, upToDate: false } });
        expect((await as("t-cora", "GET", `/api/projects/${shop}/helpers/open-shop`)).body.content).toBe(HELPER("b"));
        expect((await as("t-cora", "POST", `/api/projects/${shop}/library/update`, { itemId: helperItem })).body.upToDate).toBe(true);

        // The project changes its copy, then the library moves on: an update would replace the project's change, so it asks first.
        await as("t-cora", "PUT", `/api/projects/${shop}/helpers/open-shop`, { content: HELPER("mine") });
        await as("t-cora", "PUT", `/api/libraries/items/${helperItem}/content`, { content: { content: HELPER("c") } });
        expect((await as("t-cora", "GET", `/api/projects/${shop}/library`)).body.items.find((i: { id: string }) => i.id === helperItem).use).toMatchObject({ updateAvailable: true, changedHere: true });
        const refused = await as("t-cora", "POST", `/api/projects/${shop}/library/update`, { itemId: helperItem });
        expect(refused).toMatchObject({ status: 409, body: { details: { changedHere: true } } });
        expect((await as("t-cora", "GET", `/api/projects/${shop}/helpers/open-shop`)).body.content).toBe(HELPER("mine"));
        expect((await as("t-cora", "POST", `/api/projects/${shop}/library/update`, { itemId: helperItem, replaceLocalChanges: true })).status).toBe(200);
        expect((await as("t-cora", "GET", `/api/projects/${shop}/helpers/open-shop`)).body.content).toBe(HELPER("c"));

        // An element update goes through the project's element route (its locator changes, the name stays).
        await as("t-cora", "PUT", `/api/libraries/items/${elementItem}/content`, { content: { kind: "web", locator: { by: "role", role: "button", value: "Pay now", exact: true } } });
        expect((await as("t-cora", "POST", `/api/projects/${shop}/library/update`, { itemId: elementItem })).status).toBe(200);
        const el = (await as("t-cora", "GET", `/api/projects/${shop}/objects`)).body.elements.find((e: { name: string }) => e.name === "Pay button");
        expect(el.locator.value).toBe("Pay now");
    });

    it("refuses a copy over the project's own item of the same name, and an item of a project that never took it", async () => {
        stall = (await as("t-cora", "POST", "/api/projects", { name: "Stall", url: "https://stall.example" })).body.id;
        await as("t-cora", "PUT", `/api/projects/${stall}/helpers/open-shop`, { content: HELPER("own") });
        expect((await as("t-cora", "GET", `/api/projects/${stall}/library`)).body.items.find((i: { id: string }) => i.id === helperItem).nameTakenHere).toBe(true);
        expect((await as("t-cora", "POST", `/api/projects/${stall}/library/use`, { itemId: helperItem })).status).toBe(409);
        expect((await as("t-cora", "POST", `/api/projects/${stall}/library/update`, { itemId: stepsItem })).status).toBe(409);
        // The project's own helper was left as it was.
        expect((await as("t-cora", "GET", `/api/projects/${stall}/helpers/open-shop`)).body.content).toBe(HELPER("own"));
    });

    it("publishes a project's own reusable steps as a new item, and a later change as a new version", async () => {
        const made = await as("t-cora", "POST", `/api/projects/${stall}/blocks`, { name: "Search", kind: "web", params: [], steps: [{ action: "fill", locator: { by: "label", value: "Search" }, value: "shoes" }] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const pub = await as("t-cora", "POST", `/api/projects/${stall}/library/publish`, { kind: "steps", name: "search", folderId: top, note: "From the stall" });
        expect(pub).toMatchObject({ status: 201, body: { version: 1, added: true, item: { name: "Search", folderId: top } } });
        const searchItem = pub.body.item.id as string;
        await as("t-cora", "PUT", `/api/projects/${stall}/blocks/Search`, { steps: [{ action: "fill", locator: { by: "label", value: "Search" }, value: "boots" }] });
        // Publishing it as a new item again is refused (the name is taken): it goes in as a version of that item.
        expect((await as("t-cora", "POST", `/api/projects/${stall}/library/publish`, { kind: "steps", name: "Search" })).status).toBe(409);
        const v2 = await as("t-cora", "POST", `/api/projects/${stall}/library/publish`, { kind: "steps", name: "Search", itemId: searchItem, note: "Boots sell better" });
        expect(v2).toMatchObject({ status: 200, body: { version: 2, added: true } });
        const detail = (await as("t-cora", "GET", `/api/libraries/items/${searchItem}`)).body;
        expect(detail.versions[0]).toMatchObject({ version: 2, note: "Boots sell better", fromProject: { id: stall, name: "Stall" } });
        expect(detail.usedBy.projects).toEqual([expect.objectContaining({ projectId: stall, version: 2, updateAvailable: false })]);
        // The project that published it uses that version, unchanged.
        expect((await as("t-cora", "GET", `/api/projects/${stall}/library`)).body.items.find((i: { id: string }) => i.id === searchItem).use).toMatchObject({ version: 2, changedHere: false, updateAvailable: false });
        // A kind mismatch and something the project does not have.
        expect((await as("t-cora", "POST", `/api/projects/${stall}/library/publish`, { kind: "helper", name: "open-shop", itemId: searchItem })).status).toBe(409);
        expect((await as("t-cora", "POST", `/api/projects/${stall}/library/publish`, { kind: "element", name: "Nope" })).status).toBe(404);
    });

    it("removing an item leaves the projects' copies in place", async () => {
        const gone = await as("t-cora", "DELETE", `/api/libraries/items/${elementItem}`);
        expect(gone).toMatchObject({ status: 200, body: { removed: true, projectsKeepTheirCopy: 1 } });
        expect((await as("t-cora", "GET", `/api/projects/${shop}/objects`)).body.elements.map((e: { name: string }) => e.name)).toContain("Pay button");
        expect((await as("t-cora", "GET", `/api/libraries/items/${elementItem}`)).status).toBe(404);
    });
});

describe("who may read and change a library", () => {
    it("lets anyone of the organisation read, but only people who write tests change it", async () => {
        const lib = (await as("t-rita", "GET", "/api/libraries")).body;
        expect(lib.organizations).toEqual([{ id: "org-a", name: "org-a", canChange: false }]);
        expect(lib.items.length).toBeGreaterThan(0);
        expect((await as("t-rita", "GET", `/api/libraries/items/${stepsItem}`)).body.canChange).toBe(false);
        for (const [m, u, b] of [
            ["POST", "/api/libraries/folders", { organizationId: "org-a", name: "Rita's" }],
            ["PATCH", `/api/libraries/folders/${top}`, { name: "Mine" }],
            ["POST", "/api/libraries/items", { organizationId: "org-a", kind: "helper", name: "rita", content: { content: HELPER("r") } }],
            ["PUT", `/api/libraries/items/${stepsItem}/content`, { content: STEPS_V1 }],
        ] as const)
            expect((await as("t-rita", m, u, b)).status, `${m} ${u}`).toBe(403);
    });

    it("answers 404 for another organisation's library, folders and items, also through a project", async () => {
        expect((await as("t-bob", "GET", "/api/libraries")).body).toMatchObject({ organizations: [{ id: "org-b" }], items: [], folders: [] });
        expect((await as("t-bob", "GET", "/api/libraries?organization=org-a")).status).toBe(404);
        expect(await as("t-bob", "GET", `/api/libraries/items/${stepsItem}`)).toMatchObject({ status: 404, body: { error: LIBRARY_ITEM_NOT_FOUND } });
        expect((await as("t-bob", "GET", `/api/libraries/items/${stepsItem}/versions/1`)).status).toBe(404);
        expect((await as("t-bob", "PATCH", `/api/libraries/folders/${top}`, { name: "Mine now" })).status).toBe(404);
        expect((await as("t-bob", "DELETE", `/api/libraries/items/${stepsItem}`)).status).toBe(404);
        expect((await as("t-bob", "PUT", `/api/libraries/items/${stepsItem}/content`, { content: STEPS_V1 })).status).toBe(404);
        const bobs = (await as("t-bob", "POST", "/api/projects", { name: "Bravo", url: "https://bravo.example" })).body.id;
        expect((await as("t-bob", "POST", `/api/projects/${bobs}/library/use`, { itemId: stepsItem })).status).toBe(404);
        expect((await as("t-bob", "POST", `/api/projects/${bobs}/library/publish`, { kind: "steps", name: "x", itemId: stepsItem })).status).toBe(404);
        // A folder of another library can't hold this library's things either.
        expect((await as("t-bob", "POST", "/api/libraries/items", { organizationId: "org-b", folderId: top, kind: "helper", name: "bob", content: { content: HELPER("b") } })).status).toBe(404);
        // Nor can bob reach org-a's project.
        expect((await as("t-bob", "GET", `/api/projects/${shop}/library`)).status).toBe(404);
    });

    it("never lets a crowd tester change a library; they read the libraries of the projects they work on", async () => {
        expect((await as("t-tim", "GET", "/api/libraries")).body.organizations).toEqual([]);
        await addMember(shop, "t-tim");
        const lib = (await as("t-tim", "GET", "/api/libraries")).body;
        expect(lib.organizations).toEqual([{ id: "org-a", name: "org-a", canChange: false }]);
        expect((await as("t-tim", "POST", "/api/libraries/folders", { organizationId: "org-a", name: "Tim's" })).body.error).toBe(CANNOT_CHANGE_LIBRARY);
        expect((await as("t-tim", "GET", `/api/projects/${shop}/library`)).body.canPublish).toBe(false);
        expect((await as("t-tim", "POST", `/api/projects/${shop}/library/publish`, { kind: "steps", name: "Pay by card" })).status).toBe(403);
    });

    it("lets a Crowd4Test administrator reach every library, Crowd4Test internal included", async () => {
        const lib = (await as("t-admin", "GET", "/api/libraries")).body;
        expect(lib.organizations.map((o: { id: string | null }) => o.id)).toEqual(expect.arrayContaining([null, "org-a", "org-b"]));
        expect(lib.organizations.find((o: { id: string | null }) => o.id === null)).toMatchObject({ name: "Crowd4Test internal", canChange: true });
        expect((await as("t-admin", "POST", "/api/libraries/folders", { organizationId: "org-b", name: "Shared" })).status).toBe(201);
        expect((await as("t-bob", "GET", "/api/libraries")).body.folders.map((f: { name: string }) => f.name)).toEqual(["Shared"]);
        // Internal projects share the internal library.
        const internal = await as("t-admin", "POST", "/api/libraries/items", { organizationId: null, kind: "helper", name: "internal-open", content: { content: HELPER("i") } });
        expect(internal.status).toBe(201);
        const own = (await asKey("POST", "/api/projects", { name: "Internal app", url: "https://internal.example" })).body.id;
        expect((await asKey("GET", `/api/projects/${own}/library`)).body.organization).toEqual({ id: null, name: "Crowd4Test internal" });
        expect((await asKey("POST", `/api/projects/${own}/library/use`, { itemId: internal.body.item.id })).status).toBe(201);
        // An org-a item is not for an internal project.
        expect((await asKey("POST", `/api/projects/${own}/library/use`, { itemId: stepsItem })).status).toBe(404);
        expect((await as("t-admin", "GET", "/api/libraries?organization=internal")).body.items.map((i: { name: string }) => i.name)).toEqual(["internal-open"]);
    });

    it("deleting a project forgets what it used, and the library keeps the versions it published", async () => {
        expect((await as("t-cora", "POST", `/api/projects/${stall}/archive`)).status).toBe(200);
        const del = await as("t-cora", "DELETE", `/api/projects/${stall}`, { name: "Stall" });
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        const search = (await as("t-cora", "GET", "/api/libraries")).body.items.find((i: { name: string }) => i.name === "Search");
        expect(search).toMatchObject({ version: 2, usedBy: 0 });
        expect((await as("t-cora", "GET", `/api/libraries/items/${search.id}`)).body.versions[0].fromProject).toEqual({ id: null, name: null });
    });
});
