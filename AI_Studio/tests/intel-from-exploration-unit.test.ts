/**
 * The exploration's stored understanding model as a source of application knowledge: pages with their elements, forms, constraints and
 * messages, dialogs/menus/tables, requests per control, navigation, endpoints, workflows from the analysed journeys, and roles from the
 * access survey. A model stored by an older runner (none of the newer page fields) still converts, with one sentence saying what is
 * missing. Every item carries evidence and no rule is produced: what the application does is never an expectation.
 */
import { describe, expect, it } from "vitest";
import { fragmentFromExploration } from "../src/engine/intel/from-exploration.js";
import { ModelFragmentSchema } from "../src/engine/intel/fragment.js";
import type { Reach } from "../src/engine/identity/access.js";
import type { AppModel as UnderstandingModel, PageModel } from "../src/engine/understanding/app-model.js";
import { analyzeApplication } from "../src/engine/understanding/analyzer.js";
import type { EngineContext } from "../src/engine/context.js";
import type { LlmClient } from "../src/engine/llm/provider.js";

const NOW = "2026-11-16T10:00:00.000Z";

function page(path: string, extra: Partial<PageModel> = {}): PageModel {
    return {
        url: `http://shop.test${path}`,
        path,
        title: path,
        type: "content",
        depth: 1,
        status: 200,
        headings: [],
        forms: [],
        components: [],
        links: [],
        aria: "",
        text: "",
        apiCalls: [],
        revealed: [],
        consoleErrors: [],
        ...extra,
    };
}

/** A model as an older runner stored it: none of the newer page fields. */
function phaseOneModel(): UnderstandingModel {
    return {
        url: "http://shop.test/",
        origin: "http://shop.test",
        siteType: "ecommerce",
        purpose: "A shop",
        features: [],
        pages: [
            page("/", { purpose: "Home page", components: [{ role: "link", name: "Orders", locatorHint: "" }, { role: "button", name: "Help", locatorHint: "" }] }),
            page("/register", {
                type: "register",
                forms: [{ id: "signup", action: "http://shop.test/register", method: "post", purpose: "signup", fields: [{ type: "email", name: "email", label: "Email", required: true }] }],
            }),
            page("/orders"),
        ],
        navigation: [
            { from: "/", to: "/register", label: "Register" },
            { from: "/", to: "/orders", label: "Orders" },
        ],
        apis: [
            { method: "GET", path: "/api/orders/{id}", origin: "http://shop.test", statuses: [200, 404], queryParams: ["expand"], source: "network", usedIn: ["/orders"] },
            { method: "POST", path: "/api/orders", origin: "http://shop.test", statuses: [], queryParams: [], source: "openapi", usedIn: [] },
            { method: "GET", path: "/api/legacy", origin: "http://shop.test", statuses: [], queryParams: [], source: "documentation", usedIn: [] },
        ],
        openApi: { url: "http://shop.test/openapi.json", version: "3.0.0", title: "Shop", operationCount: 1, baseUrl: "http://shop.test" },
        authentication: { required: false, mechanisms: [], loggedIn: false },
        journeys: [{ name: "Place an order", description: "Buy something", steps: ["Open orders", "Create an order"], priority: "critical", pages: ["/orders"], requiresAuth: true }],
        externalDependencies: [],
        documentedTestCases: [],
        stats: { pagesVisited: 3, pagesSkipped: 0, apisFound: 3, durationMs: 1000 },
    };
}

/** The same app crawled by a current runner. */
function currentModel(): UnderstandingModel {
    const m = phaseOneModel();
    m.pages = m.pages.map((p) => ({ ...p, discovery: 2 as const }));
    const register = m.pages[1]!;
    register.forms[0]!.fields = [
        { type: "email", name: "email", label: "Email", required: true, validation: { check: "type", message: "Enter an email address" } },
        { type: "number", name: "age", label: "Age", required: true, min: "18", max: "120" },
        { type: "text", name: "username", label: "Username", required: true, minLength: 3, maxLength: 20, pattern: "[a-z0-9]+" },
        { type: "select", name: "country", label: "Country", required: true, options: ["India", "Norway"] },
    ];
    const home = m.pages[0]!;
    home.dialogs = ["Getting help"];
    home.menus = [{ name: "Account", items: ["Profile"] }];
    home.tables = [{ name: "Recent orders", headers: ["Order", "Status"] }];
    home.interactions = [{ control: "Open details", method: "GET", path: "/api/orders/{id}" }];
    m.screenMap = { screens: [{ key: "/register", heading: "Create an account", type: "register", paths: ["/register"] }], transitions: [], conditional: [] };
    return m;
}

const reach: Reach[] = [
    { who: "anonymous", pages: [{ path: "/", heading: "Home" }, { path: "/register", heading: "Register" }] },
    { who: "admin", pages: [{ path: "/", heading: "Home" }, { path: "/orders", heading: "Orders" }, { path: "/admin", heading: "Admin" }] },
    { who: "clerk", pages: [{ path: "/", heading: "Home" }, { path: "/orders", heading: "Orders" }] },
];
const differences = ["“admin” can open /admin (“Admin”); “clerk” did not reach it."];

describe("converting an exploration's understanding model", () => {
    it("converts a model stored by an older runner, with one sentence naming what is missing", () => {
        const f = fragmentFromExploration({ model: phaseOneModel(), ref: "http://shop.test/", now: NOW });
        expect(() => ModelFragmentSchema.parse(f)).not.toThrow();
        expect(f.source).toMatchObject({ kind: "exploration", ref: "http://shop.test/", status: "processed", processedAt: NOW });
        expect(f.source.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(f.model.pages.map((p) => p.path)).toEqual(["/", "/register", "/orders"]);
        expect(f.model.pages[0]!.purpose).toBe("Home page");
        expect(f.model.pages[0]!.elements).toEqual([
            { role: "link", name: "Orders", kind: "link" },
            { role: "button", name: "Help", kind: "button" },
        ]);
        expect(f.model.pages[1]!.forms).toEqual([{ name: "signup", fields: [{ name: "email", label: "Email", type: "email", required: true }] }]);
        expect(f.model.pages.flatMap((p) => [...p.structures, ...p.interactions])).toEqual([]);
        expect(f.model.missingContext).toHaveLength(1);
        expect(f.model.missingContext[0]).toMatchObject({ source: "exploration", text: expect.stringMatching(/older runner/) });
        expect(f.rules).toEqual([]);
    });

    it("carries a current crawl's constraints, messages, structures, requests per control and screen ids, with nothing missing", () => {
        const f = fragmentFromExploration({ model: currentModel(), ref: "http://shop.test/", now: NOW });
        const [home, register] = f.model.pages;
        expect(register!.forms[0]!.fields).toEqual([
            { name: "email", label: "Email", type: "email", required: true, message: "Enter an email address" },
            { name: "age", label: "Age", type: "number", required: true, min: "18", max: "120" },
            { name: "username", label: "Username", type: "text", required: true, minLength: 3, maxLength: 20, pattern: "[a-z0-9]+" },
            { name: "country", label: "Country", type: "select", required: true, options: ["India", "Norway"] },
        ]);
        expect(home!.structures).toEqual([
            { kind: "dialog", name: "Getting help" },
            { kind: "menu", name: "Account" },
            { kind: "table", name: "Recent orders", headers: ["Order", "Status"] },
        ]);
        expect(home!.interactions).toEqual([{ control: "Open details", method: "GET", path: "/api/orders/{id}" }]);
        expect(register!.screenId).toBe("/register");
        expect(home!.screenId).toBeUndefined();
        expect(f.model.missingContext).toEqual([]);
        expect(f.rules).toEqual([]);
    });

    it("records observed traffic as observed, OpenAPI-sourced endpoints as documented, and nothing else", () => {
        const f = fragmentFromExploration({ model: phaseOneModel(), ref: "http://shop.test/", now: NOW });
        expect(f.model.endpoints.map((e) => [e.method, e.path, e.origin])).toEqual([
            ["GET", "/api/orders/{id}", "observed"],
            ["POST", "/api/orders", "documented"],
        ]);
        const [observed, documented] = f.model.endpoints;
        expect(observed!.evidence[0]!.kind).toBe("request");
        expect(observed!.parameters).toEqual(expect.arrayContaining([{ name: "expand", in: "query", required: false, type: "" }]));
        expect(documented!.evidence.some((e) => e.kind === "openapi" && e.ref.startsWith("http://shop.test/openapi.json#"))).toBe(true);
    });

    it("gives navigation, workflows and roles their evidence; workflows from the analysis are inferred", () => {
        const f = fragmentFromExploration({ model: phaseOneModel(), ref: "http://shop.test/", now: NOW, reach, roleDifferences: differences });
        const id = (path: string) => f.model.pages.find((p) => p.path === path)!.id;
        expect(f.model.navigation.map((n) => [n.from, n.to, n.control])).toEqual([
            [id("/"), id("/register"), "Register"],
            [id("/"), id("/orders"), "Orders"],
        ]);
        expect(f.model.workflows).toHaveLength(1);
        expect(f.model.workflows[0]).toMatchObject({ name: "Place an order", sourceType: "inferred", steps: [{ order: 0, action: "Open orders" }, { order: 1, action: "Create an order" }] });
        // Roles: what each account reached (a page only an account reached is added), and the differences that name it.
        expect(f.model.roles.map((r) => r.name)).toEqual(["admin", "clerk"]);
        const admin = f.model.roles[0]!;
        expect(admin.reaches.sort()).toEqual([id("/"), id("/orders"), id("/admin")].sort());
        expect(admin.differs).toEqual(differences);
        expect(f.model.roles[1]!.differs).toEqual(differences);
        expect(f.model.pages.find((p) => p.path === "/orders")!.reachableBy).toEqual(["admin", "clerk"]);
        expect(f.model.pages.find((p) => p.path === "/orders")!.requiresSignIn).toBe(true);
        expect(f.model.pages.find((p) => p.path === "/register")!.requiresSignIn).toBe(false);
        // Every item carries evidence.
        for (const item of [...f.model.navigation, ...f.model.endpoints, ...f.model.workflows, ...f.model.roles]) expect(item.evidence.length).toBeGreaterThan(0);
        expect(f.rules).toEqual([]);
    });

    it("gives each journey step the page it happens on and, where the crawl saw one, the request it sends", () => {
        const m = currentModel();
        m.pages.push(
            page("/products/p1", { discovery: 2, components: [{ role: "button", name: "Add to cart", locatorHint: "" }] }),
            page("/cart", { discovery: 2, components: [{ role: "button", name: "Check out", locatorHint: "" }], interactions: [{ control: "Check out", method: "GET", path: "/api/checkout/summary" }] }),
        );
        m.apis.push({ method: "POST", path: "/api/cart/items", origin: "http://shop.test", statuses: [201], queryParams: [], source: "network", usedIn: ["/products/p1"] });
        m.journeys = [
            {
                name: "Browse products and add to cart",
                description: "",
                steps: ["Open the home page", "Open a product", "Press Add to cart", "Open the cart and press Check out"],
                priority: "critical",
                pages: ["/", "/products/p1", "/cart"],
                requiresAuth: false,
            },
        ];
        const f = fragmentFromExploration({ model: m, ref: "x", now: NOW });
        const id = (path: string) => f.model.pages.find((p) => p.path === path)!.id;
        expect(f.model.workflows[0]!.steps).toEqual([
            { order: 0, action: "Open the home page", page: id("/") },
            { order: 1, action: "Open a product", page: id("/products/p1") },
            { order: 2, action: "Press Add to cart", page: id("/products/p1"), endpoint: "POST /api/cart/items" },
            { order: 3, action: "Open the cart and press Check out", page: id("/cart"), endpoint: "GET /api/checkout/summary" },
        ]);
    });

    it("takes the page and request the analysis named for a step when the model lists them, and nothing it did not list", () => {
        const m = currentModel();
        m.pages.push(page("/cart", { discovery: 2 }));
        m.apis.push(
            { method: "PATCH", path: "/api/cart/items/{productId}", origin: "http://shop.test", statuses: [], queryParams: [], source: "openapi", usedIn: [] },
            { method: "GET", path: "/api/cart", origin: "http://shop.test", statuses: [200], queryParams: [], source: "network", usedIn: ["/cart"] },
        );
        m.journeys = [
            {
                name: "Change a quantity in the cart",
                description: "",
                steps: ["Open the cart", "Change the quantity and press Update", "Press Remove", "Read the order"],
                // A documented request the crawl never sent, written with a :param; one the model does not list; a page the crawl never saw.
                stepLinks: [{ page: "/cart", endpoint: "GET /api/cart" }, { endpoint: "patch /api/cart/items/:productId" }, { page: "/cart", endpoint: "DELETE /api/cart/items/{productId}" }, { page: "/nowhere", endpoint: "GET /api/orders/ord-7" }],
                priority: "high",
                pages: ["/cart"],
                requiresAuth: true,
            },
        ];
        const f = fragmentFromExploration({ model: m, ref: "x", now: NOW });
        const cart = f.model.pages.find((p) => p.path === "/cart")!.id;
        expect(f.model.workflows[0]!.steps).toEqual([
            { order: 0, action: "Open the cart", page: cart, endpoint: "GET /api/cart" },
            { order: 1, action: "Change the quantity and press Update", page: cart, endpoint: "PATCH /api/cart/items/{productId}" },
            { order: 2, action: "Press Remove", page: cart },
            // A concrete address of a listed template is that template.
            { order: 3, action: "Read the order", page: cart, endpoint: "GET /api/orders/{id}" },
        ]);
    });

    it("leaves a step without a page when its journey names no page the crawl saw", () => {
        const m = currentModel();
        m.journeys = [{ name: "Elsewhere", description: "", steps: ["Do a thing"], priority: "low", pages: ["/never-seen"], requiresAuth: false }];
        expect(fragmentFromExploration({ model: m, ref: "x", now: NOW }).model.workflows[0]!.steps).toEqual([{ order: 0, action: "Do a thing" }]);
    });

    it("gives the same fragment for the same model", () => {
        const a = fragmentFromExploration({ model: currentModel(), ref: "x", now: NOW, reach, roleDifferences: differences });
        const b = fragmentFromExploration({ model: currentModel(), ref: "x", now: NOW, reach, roleDifferences: differences });
        expect(a).toEqual(b);
        const changed = currentModel();
        changed.pages[0]!.dialogs = ["Something else"];
        expect(fragmentFromExploration({ model: changed, ref: "x", now: NOW, reach, roleDifferences: differences }).source.fingerprint).not.toBe(a.source.fingerprint);
    });
});

describe("the analysis names each journey step's page and request", () => {
    const answer = {
        siteType: "ecommerce",
        purpose: "Sells",
        features: [],
        pagePurposes: [],
        journeys: [
            {
                name: "Apply a discount code",
                description: "",
                steps: [{ action: "Open the cart", page: "/cart", endpoint: "GET /api/cart" }, { action: "Enter a code and press Apply", page: "/cart", endpoint: "POST /api/cart/discount" }, { action: "Read the new total", page: "/cart", endpoint: "" }],
                priority: "high",
                pages: ["/cart"],
                requiresAuth: true,
            },
        ],
        authenticationMechanisms: [],
    };
    const run = async (opts: { linkSteps?: boolean }) => {
        const asked: Array<{ system: string; schema: { safeParse: (v: unknown) => { success: boolean } } }> = [];
        const llm = { modelName: "scripted", usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: async (a: (typeof asked)[number]) => (asked.push(a), answer) } as unknown as LlmClient;
        const ctx = { config: {}, llm, emit: () => undefined } as unknown as EngineContext;
        const { siteType: _s, purpose: _p, features: _f, journeys: _j, ...base } = { ...phaseOneModel(), pages: [page("/cart")] };
        return { model: await analyzeApplication(ctx, base, opts), asked: asked[0]! };
    };

    it("asks for one feature per journey and the page and request of every step, and keeps them beside the steps", async () => {
        const { model, asked } = await run({});
        expect(asked.system).toMatch(/one feature/i);
        expect(asked.system).toMatch(/endpoint/i);
        expect(asked.schema.safeParse(answer).success).toBe(true);
        expect(model.journeys[0]!.steps).toEqual(["Open the cart", "Enter a code and press Apply", "Read the new total"]);
        expect(model.journeys[0]!.stepLinks).toEqual([{ page: "/cart", endpoint: "GET /api/cart" }, { page: "/cart", endpoint: "POST /api/cart/discount" }, { page: "/cart" }]);
    });

    it("an older runner's analysis (no page understanding) asks as before: plain steps, no links", async () => {
        const { model, asked } = await run({ linkSteps: false });
        expect(asked.system).not.toMatch(/one feature/i);
        expect(asked.schema.safeParse(answer).success).toBe(false);
        expect(model.journeys[0]!).not.toHaveProperty("stepLinks");
    });
});
