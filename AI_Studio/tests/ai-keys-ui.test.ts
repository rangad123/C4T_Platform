/**
 * AI keys in a real browser against the built page and a real platform (port 9450), with a stand-in Crowd4Test sign-in (9451) and a
 * stand-in AI provider (9452): no real provider is called. Two kinds of key only: personal (any account adds its own, nobody else sees it)
 * and organisational (admins add it and assign it to admins or sub-admins). Each person chooses one key; projects have no AI setting.
 *
 * The first part stands in for GET /api/me/ai and /api/admin/ai-keys with browser routes shaped like the contract, so every state can be
 * driven; the second part uses the real routes with four people: an admin, a sub-admin, a customer and a tester. Requires `web/dist`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 9450;
const C4T_PORT = 9451;
const PROVIDER_PORT = 9452;
const BASE = `http://127.0.0.1:${PORT}`;
const GOOD = "PERSONAL-ui-key-sentinel-1234";
const ORG = "ORG-ui-key-sentinel-5678";
const BAD = "BAD-ui-key-sentinel-9999";
const NO_KEY = "You have no AI key. Add your own key in Settings, AI keys, or ask an admin to assign an organisational key.";

const user = (id: string, role: string, permissions: readonly string[], organisationId: string | null) => ({ data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } } });
const TESTER_CODES = ["ai_studio.access", "ai_studio.tests.run", "ai_studio.tests.generate", "ai_studio.tests.write"];
const ACCOUNTS: Record<string, unknown> = {
    "t-ada": user("ada", "ADMIN", PERMISSIONS, null),
    "t-sam": user("sam", "SUB_ADMIN", PERMISSIONS.filter((c) => c !== "ai_studio.platform.settings"), null),
    "t-cora": user("cora", "CUSTOMER", PERMISSIONS.filter((c) => c !== "ai_studio.platform.settings"), "org-a"),
    "t-tim": user("tim", "TESTER", TESTER_CODES, null),
};

let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let c4t: http.Server;
let provider: http.Server;
let dir = "";
const contexts: BrowserContext[] = [];

const pageFor = async (token: string, viewport?: { width: number; height: number }) => {
    const ctx = await browser.newContext(viewport ? { viewport } : {});
    contexts.push(ctx);
    await ctx.addCookies([{ name: "c4t_access", value: token, url: BASE }]);
    return ctx.newPage();
};
const axe = async (page: Page) => {
    const r = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    provider = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (String(req.headers.authorization).includes("BAD")) {
                res.statusCode = 401;
                return res.end(JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } }));
            }
            res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }));
        });
    });
    await new Promise<void>((r) => provider.listen(PROVIDER_PORT, "127.0.0.1", r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ai-keys-ui-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: "ai-keys-ui-key-1", SECRET_KEY: "ai-keys-ui-secret-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example", WEB_DIST: path.join(REPO_ROOT, "web/dist") } as never),
    );
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    browser = await chromium.launch();
    // Each person opens AI Studio once, so the server knows them (an admin assigns keys only to people it knows).
    for (const t of Object.keys(ACCOUNTS)) await server.inject({ method: "GET", url: "/api/auth/state", headers: { cookie: `c4t_access=${t}` } });
}, 120_000);

afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    await new Promise((r) => provider?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

// ── part 1: the page against stand-ins shaped like the contract ──────────────

const key = (o: Partial<Record<string, unknown>> & { id: string; kind: "personal" | "organisational"; label: string }) => ({
    provider: "openai-compatible",
    providerWords: "Custom endpoint",
    model: "stand-in-model",
    fastModel: null,
    baseUrl: "https://llm.example/v1",
    keyHint: "1234",
    status: "working",
    statusNote: null,
    lastValidatedAt: new Date().toISOString(),
    chosen: false,
    ...o,
});
type Fake = { chosen: string | null; personal: Array<ReturnType<typeof key>>; organisational: Array<ReturnType<typeof key>>; problem: string | null; admin: boolean };
const answerOf = (f: Fake) => {
    const mark = (k: ReturnType<typeof key>) => ({ ...k, chosen: k.id === f.chosen });
    const all = [...f.personal, ...f.organisational].map(mark);
    const chosen = all.find((k) => k.chosen) ?? null;
    return { chosen, problem: chosen ? f.problem : NO_KEY, personal: f.personal.map(mark), organisational: f.organisational.map(mark), canManageOrganisational: f.admin, openServer: null };
};

async function stand(page: Page, f: Fake, calls: Array<{ method: string; path: string; body: unknown }>) {
    const record = (r: Route) => calls.push({ method: r.request().method(), path: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
    await page.route("**/api/me/ai", (r) => r.fulfill({ json: answerOf(f) }));
    await page.route("**/api/me/ai/chosen", async (r) => {
        record(r);
        f.chosen = (r.request().postDataJSON() as { keyId: string }).keyId;
        await r.fulfill({ json: answerOf(f) });
    });
    await page.route("**/api/me/ai/keys", async (r) => {
        record(r);
        const b = r.request().postDataJSON() as { label: string; apiKey: string };
        const made = key({ id: `k-${f.personal.length + 1}`, kind: "personal", label: b.label, keyHint: b.apiKey.slice(-4), status: "untested", lastValidatedAt: null });
        f.personal.push(made);
        // As the server does: a person's first key becomes their chosen one.
        if (!f.chosen) f.chosen = made.id;
        await r.fulfill({ json: { key: made } });
    });
    await page.route("**/api/me/ai/keys/*", async (r) => {
        record(r);
        const id = decodeURIComponent(new URL(r.request().url()).pathname.split("/").at(-1)!);
        if (r.request().method() === "DELETE") {
            f.personal = f.personal.filter((k) => k.id !== id);
            if (f.chosen === id) f.chosen = null;
        }
        await r.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/me/ai/keys/*/test", async (r) => {
        record(r);
        await r.fulfill({ json: { ok: true, message: "It worked: stand-in-model answered in 120 ms." } });
    });
    await page.route("**/api/admin/ai-keys", (r) => (f.admin ? r.fulfill({ json: { keys: f.organisational.map((k) => ({ ...k, assignees: [{ id: "p-sam", name: "Sam Person" }] })), people: [{ id: "p-ada", name: "Ada Person", role: "ADMIN" }, { id: "p-sam", name: "Sam Person", role: "SUB_ADMIN" }] } }) : r.fulfill({ status: 403, json: { error: "Only admins manage organisational keys." } })));
    await page.route("**/api/admin/ai-keys/*/assignees", async (r) => {
        record(r);
        await r.fulfill({ json: { ok: true } });
    });
}

describe("Settings, AI keys (stand-ins)", () => {
    it("no key: says why AI can't start, the side bar says AI not set up, and a first key added becomes the chosen one", async () => {
        const page = await pageFor("t-cora");
        const f: Fake = { chosen: null, personal: [], organisational: [], problem: null, admin: false };
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        await stand(page, f, calls);
        await page.goto(`${BASE}/#/settings#ai-keys`);
        const sec = page.getByTestId("ai-keys");
        await pwExpect(sec).toHaveAttribute("data-state", "no-key");
        await pwExpect(sec.getByTestId("ai-problem")).toHaveText(NO_KEY);
        await pwExpect(page.getByTestId("ai-chip")).toHaveText(/AI not set up/);
        await pwExpect(page.getByTestId("org-keys")).toHaveCount(0);
        await axe(page);
        await sec.getByRole("button", { name: "Add your own key" }).click();
        const form = sec.getByTestId("ai-key-new-form");
        await form.getByLabel("Name").fill("My OpenRouter");
        await form.getByLabel("Provider").selectOption({ label: "Custom endpoint" });
        await form.getByLabel("Address").fill("https://llm.example/v1");
        await form.getByLabel("Model", { exact: true }).fill("stand-in-model");
        await form.getByLabel("Key", { exact: true }).fill(GOOD);
        await form.getByRole("button", { name: "Save key" }).click();
        await pwExpect(sec).toHaveAttribute("data-state", "ready");
        await pwExpect(sec.getByTestId("ai-chosen")).toContainText("My OpenRouter");
        expect(calls.filter((c) => c.path === "/api/me/ai/chosen")).toEqual([]);
        expect(calls.find((c) => c.path === "/api/me/ai/keys")?.body).toMatchObject({ label: "My OpenRouter", provider: "openai-compatible", apiKey: GOOD });
        expect(await page.content()).not.toContain(GOOD);
        await pwExpect(page.getByTestId("ai-chip")).toHaveText(/AI connected/);
    }, 90_000);

    it("chooses an assigned organisational key, which has no Change or Remove; removing the chosen own key says AI stops", async () => {
        const page = await pageFor("t-sam");
        const f: Fake = { chosen: "k-mine", personal: [key({ id: "k-mine", kind: "personal", label: "Mine" })], organisational: [key({ id: "k-org", kind: "organisational", label: "Crowd4Test main", keyHint: "5678" })], problem: null, admin: false };
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        await stand(page, f, calls);
        await page.goto(`${BASE}/#/settings`);
        const sec = page.getByTestId("ai-keys");
        const org = sec.locator('[data-testid="ai-key"][data-key="k-org"]');
        await pwExpect(org.getByText("Organisational", { exact: true })).toBeVisible();
        await pwExpect(org.getByRole("button", { name: /Change|Remove/ })).toHaveCount(0);
        await org.getByRole("button", { name: "Use Crowd4Test main for my AI work" }).click();
        await pwExpect(org).toHaveAttribute("data-chosen", "true");
        await pwExpect(sec.getByTestId("ai-chosen")).toContainText("Crowd4Test main");
        // Back to their own key, then remove it: the page says the AI work stops.
        await sec.getByRole("button", { name: "Use Mine for my AI work" }).click();
        const mine = sec.locator('[data-testid="ai-key"][data-key="k-mine"]');
        await mine.getByRole("button", { name: "Remove Mine…" }).click();
        await pwExpect(mine.getByText("Your AI work stops until you choose another key.")).toBeVisible();
        await mine.getByRole("button", { name: "Remove Mine", exact: true }).click();
        await pwExpect(sec).toHaveAttribute("data-state", "no-key");
        expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/me/ai/keys/k-mine"]);
        await axe(page);
    }, 90_000);

    it("a chosen key whose last test failed only warns: AI work stays ready, as the server lets it start", async () => {
        const page = await pageFor("t-cora");
        const f: Fake = { chosen: "k-x", personal: [key({ id: "k-x", kind: "personal", label: "Flaky key", status: "failed", statusNote: "Provider busy. Try again later." })], organisational: [], problem: null, admin: false };
        await stand(page, f, []);
        await page.goto(`${BASE}/#/settings`);
        const sec = page.getByTestId("ai-keys");
        await pwExpect(sec).toHaveAttribute("data-state", "ready");
        await pwExpect(sec.getByTestId("ai-chosen-warning")).toContainText("AI work still starts with it.");
        await pwExpect(page.getByTestId("ai-chip")).toHaveText(/AI connected/);
    }, 60_000);

    it("an account the server does not answer for (403): no AI keys section, and the side bar says AI not set up, never Checking AI", async () => {
        const page = await pageFor("t-cora");
        await page.route("**/api/me/ai", (r) => r.fulfill({ status: 403, json: { error: "You don't have permission to use the AI to write tests." } }));
        await page.goto(`${BASE}/#/settings`);
        await pwExpect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
        await pwExpect(page.getByTestId("ai-chip")).toHaveText(/AI not set up/);
        await pwExpect(page.getByTestId("ai-keys")).toHaveCount(0);
    }, 60_000);

    it("a failing chosen key: the server's sentence is shown as it is", async () => {
        const page = await pageFor("t-cora");
        const said = "Your chosen key did not work the last time it was used. Test it, or choose another key.";
        const f: Fake = { chosen: "k-x", personal: [key({ id: "k-x", kind: "personal", label: "Old key", status: "failed", statusNote: "Key refused. Check the key." })], organisational: [], problem: said, admin: false };
        await stand(page, f, []);
        await page.goto(`${BASE}/#/settings`);
        await pwExpect(page.getByTestId("ai-problem")).toHaveText(said);
        await pwExpect(page.getByTestId("ai-key").getByText("Not working", { exact: true })).toBeVisible();
    }, 60_000);

    it("an admin gets Organisational keys and assigns one to admins and sub-admins; nobody else sees that card", async () => {
        const page = await pageFor("t-ada");
        const f: Fake = { chosen: null, personal: [], organisational: [key({ id: "k-org", kind: "organisational", label: "Crowd4Test main", keyHint: "5678" })], problem: null, admin: true };
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        await stand(page, f, calls);
        await page.goto(`${BASE}/#/settings`);
        const card = page.getByTestId("org-keys");
        await pwExpect(card.getByTestId("org-key-assignees")).toHaveText("Assigned to 1 person: Sam Person");
        await card.getByRole("button", { name: "Choose who may use Crowd4Test main" }).click();
        const assign = card.getByTestId("ai-assign");
        await assign.getByLabel("Find an admin or sub-admin").fill("ada");
        await pwExpect(assign.getByRole("checkbox")).toHaveCount(1);
        await assign.getByRole("checkbox", { name: /Ada Person/ }).check();
        await assign.getByRole("button", { name: "Save who may use it" }).click();
        await pwExpect(card.getByTestId("ai-assign")).toHaveCount(0);
        expect((calls.find((c) => c.path.endsWith("/assignees"))?.body as { personIds: string[] }).personIds.sort()).toEqual(["p-ada", "p-sam"]);
        await axe(page);
    }, 90_000);

    it("fits a phone: no sideways scrolling", async () => {
        const page = await pageFor("t-ada", { width: 375, height: 800 });
        const f: Fake = { chosen: "k-org", personal: [key({ id: "k-mine", kind: "personal", label: "A rather long personal key name for a phone" })], organisational: [key({ id: "k-org", kind: "organisational", label: "Crowd4Test main" })], problem: null, admin: true };
        await stand(page, f, []);
        await page.goto(`${BASE}/#/settings`);
        await pwExpect(page.getByTestId("org-keys")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }, 60_000);
});

describe("no project AI anywhere", () => {
    it("the web source has no project AI setting, no /projects/:id/ai call and no old configuration routes", () => {
        const files: string[] = [];
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
            }
        };
        walk(path.join(REPO_ROOT, "web/src"));
        const bad = files.filter((f) => /\/projects\/\$\{[^}]+\}\/ai\b|\/ai-configurations|ProjectAiSettings|AI configuration|who pays|managed AI/i.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(REPO_ROOT, f));
        expect(bad).toEqual([]);
    });

    it("a project's Settings has no AI section", async () => {
        const page = await pageFor("t-cora");
        await page.goto(BASE);
        const id = await page.evaluate(async () => {
            const r = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ai-studio" }, body: JSON.stringify({ name: "Shop" }) });
            return (await r.json()).id as string;
        });
        await page.goto(`${BASE}/#/projects/${id}/settings`);
        await pwExpect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
        await pwExpect(page.getByText(/AI configuration|Who pays/)).toHaveCount(0);
    }, 60_000);
});

// ── part 2: the real routes ──────────────────────────────────────────────────

const fill = async (page: Page, prefix: string, label: string, apiKey: string) => {
    const form = page.getByTestId(`${prefix}-form`);
    await form.getByLabel("Name").fill(label);
    await form.getByLabel("Provider").selectOption({ label: "Custom endpoint" });
    await form.getByLabel("Address").fill(`http://127.0.0.1:${PROVIDER_PORT}/v1`);
    await form.getByLabel("Model", { exact: true }).fill("stand-in-model");
    await form.getByLabel("Key", { exact: true }).fill(apiKey);
    await form.getByRole("button", { name: "Save key" }).click();
};

describe("against the real routes", () => {
    it("a customer adds a personal key, tests it, and it becomes their chosen key; a bad key says plainly it did not work", async () => {
        const page = await pageFor("t-cora");
        await page.goto(`${BASE}/#/settings`);
        const sec = page.getByTestId("ai-keys");
        await pwExpect(sec).toHaveAttribute("data-state", "no-key");
        await sec.getByRole("button", { name: "Add your own key" }).click();
        await fill(page, "ai-key-new", "Cora key", GOOD);
        const row = sec.getByTestId("ai-key").filter({ hasText: "Cora key" });
        await pwExpect(row).toHaveAttribute("data-chosen", "true");
        await row.getByRole("button", { name: "Test this key: Cora key" }).click();
        await pwExpect(row.getByText("The key works")).toBeVisible();
        await pwExpect(sec).toHaveAttribute("data-state", "ready");
        await sec.getByRole("button", { name: "Add your own key" }).click();
        await fill(page, "ai-key-new", "Broken key", BAD);
        const broken = sec.getByTestId("ai-key").filter({ hasText: "Broken key" });
        await broken.getByRole("button", { name: "Test this key: Broken key" }).click();
        await pwExpect(broken.getByText("The key did not work")).toBeVisible();
        expect(await page.content()).not.toContain(GOOD);
        expect(await page.content()).not.toContain(BAD);
        await pwExpect(page.getByTestId("org-keys")).toHaveCount(0);
        await axe(page);
    }, 120_000);

    it("an admin adds an organisational key and assigns it to the sub-admin, who then sees and chooses it; others never see it", async () => {
        const ada = await pageFor("t-ada");
        await ada.goto(`${BASE}/#/settings`);
        const card = ada.getByTestId("org-keys");
        await card.getByRole("button", { name: "Add an organisational key" }).click();
        await fill(ada, "org-key-new", "Crowd4Test main", ORG);
        const row = card.getByTestId("org-key").filter({ hasText: "Crowd4Test main" });
        await pwExpect(row.getByTestId("org-key-assignees")).toHaveText("Assigned to nobody");
        // Cora's personal key is never listed for the admin, in either key list.
        await pwExpect(card.getByText("Cora key")).toHaveCount(0);
        await pwExpect(ada.getByTestId("ai-keys").getByText("Cora key")).toHaveCount(0);
        await row.getByRole("button", { name: "Choose who may use Crowd4Test main" }).click();
        await row.getByTestId("ai-assign").getByRole("checkbox", { name: /sam/i }).check();
        // Customers and testers are never offered.
        await pwExpect(row.getByTestId("ai-assign").getByRole("checkbox", { name: /cora|tim/i })).toHaveCount(0);
        await row.getByRole("button", { name: "Save who may use it" }).click();
        await pwExpect(row.getByTestId("org-key-assignees")).toContainText("Assigned to 1 person");
        await axe(ada);

        const sam = await pageFor("t-sam");
        await sam.goto(`${BASE}/#/settings`);
        const mine = sam.getByTestId("ai-keys").getByTestId("ai-key").filter({ hasText: "Crowd4Test main" });
        await pwExpect(mine).toHaveAttribute("data-kind", "organisational");
        await mine.getByRole("button", { name: "Use Crowd4Test main for my AI work" }).click();
        await pwExpect(mine).toHaveAttribute("data-chosen", "true");
        await pwExpect(sam.getByTestId("org-keys")).toHaveCount(0);

        for (const t of ["t-cora", "t-tim"]) {
            const other = await pageFor(t);
            await other.goto(`${BASE}/#/settings`);
            await pwExpect(other.getByTestId("ai-keys")).toBeVisible();
            await pwExpect(other.getByText("Crowd4Test main")).toHaveCount(0);
        }
        expect(await ada.content()).not.toContain(ORG);
    }, 150_000);
});
