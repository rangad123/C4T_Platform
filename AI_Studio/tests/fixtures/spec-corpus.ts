/**
 * Specs made by the platform's own generation paths, with no model and no browser: the API generators (OpenAPI, workflows, latency,
 * load, access), the check families (page health, security, accessibility, input handling, page speed, AI judgement, visual,
 * access control), the recorder, the plain-English API builder and the web steps a model or a person writes (every kind of locator and
 * every action). Used to prove that the text format can express whatever the platform itself produces.
 */
import { generateA11ySpecs } from "../../src/engine/a11y/specs.js";
import { generateApiSpecs } from "../../src/engine/api/test-specs.js";
import { apiDraft, buildApiSteps } from "../../src/engine/authoring/api.js";
import { generateApiWorkflowSpecs } from "../../src/engine/api/workflows.js";
import { generateHealthSpecs } from "../../src/engine/health/specs.js";
import { generateAccessSpecs, generateApiAccessSpecs } from "../../src/engine/identity/access.js";
import { generateInputSpecs } from "../../src/engine/inputs/specs.js";
import { generateLatencySpecs } from "../../src/engine/performance/latency.js";
import { generateLoadSpecs } from "../../src/engine/performance/load.js";
import { generatePerformanceSpecs } from "../../src/engine/performance/specs.js";
import { buildRecordedSpec } from "../../src/engine/recorder/spec.js";
import type { RecStep } from "../../src/engine/recorder/model.js";
import { generateSecuritySpecs } from "../../src/engine/security/specs.js";
import { TestSpecSchema, type TestSpec } from "../../src/engine/spec/schema.js";
import type { ApiEndpointModel, OpenApiOperation } from "../../src/engine/understanding/app-model.js";
import { generateVisionSpecs } from "../../src/engine/vision/specs.js";
import { generateVisualSpecs } from "../../src/engine/visual/baseline.js";
import { modelFor } from "./checks-app.js";

export interface CorpusItem {
    /** Which generation path made it. */
    path: string;
    spec: TestSpec;
}

const Pet = { type: "object", required: ["id", "name"], properties: { id: { type: "integer", readOnly: true }, name: { type: "string" }, tag: { type: "string" } } };

function op(method: string, p: string, detail: Partial<OpenApiOperation> = {}, extra: Partial<ApiEndpointModel> = {}): ApiEndpointModel {
    const spec: OpenApiOperation = { tags: [], parameters: [], responses: [], security: [], ...detail };
    return { method, path: p, origin: "http://api.test", statuses: spec.responses.map((r) => Number(r.status)), queryParams: [], requiresAuth: spec.security.length > 0, source: "openapi", spec, usedIn: [], ...extra };
}
const petIdParam = { name: "petId", location: "path" as const, required: true, type: "integer" };

/** An API like the ones people analyse: lists, details, create/update/delete, a sign-in, a secured profile, query parameters. */
export const PETSTORE: ApiEndpointModel[] = [
    op("GET", "/pets", { parameters: [{ name: "limit", location: "query", required: true, type: "integer" }], responses: [{ status: "200", description: "ok", schema: { type: "array", items: Pet } }] }),
    op("POST", "/pets", { requestBody: { required: true, contentType: "application/json", schema: Pet }, responses: [{ status: "201", description: "created", schema: Pet }] }),
    op("GET", "/pets/{petId}", { parameters: [petIdParam], responses: [{ status: "200", description: "ok", schema: Pet }, { status: "404", description: "missing" }] }),
    op("PUT", "/pets/{petId}", { parameters: [petIdParam], requestBody: { required: true, contentType: "application/json", schema: Pet }, responses: [{ status: "200", description: "ok", schema: Pet }] }),
    op("DELETE", "/pets/{petId}", { parameters: [petIdParam], responses: [{ status: "204", description: "deleted" }] }),
    op("POST", "/auth/login", { requestBody: { required: true, contentType: "application/json", schema: { type: "object", properties: { username: { type: "string" }, password: { type: "string" } } } }, responses: [{ status: "200", description: "ok", schema: { type: "object", properties: { access_token: { type: "string" } } } }] }),
    op("GET", "/me", { security: ["bearerAuth"], responses: [{ status: "200", description: "ok", schema: { type: "object", properties: { email: { type: "string" } } } }] }),
    op("GET", "/admin/users", { security: ["bearerAuth"], responses: [{ status: "200", description: "ok", schema: { type: "array", items: { type: "object" } } }] }),
];

const page = (path: string, type: string, extra: Record<string, unknown> = {}) => ({ path, type, ...extra }) as never;
const field = (name: string, type = "text") => ({ type, name, required: false });

let n = 0;
const withId = (d: unknown, prefix: string): TestSpec => TestSpecSchema.parse({ ...(d as object), testId: `${prefix}-${String(++n).padStart(3, "0")}` });

/** Hand-written steps the way a model or a person writes them: every kind of locator and every action. */
function webSteps(): TestSpec[] {
    const t = (title: string, steps: unknown[], extra: Record<string, unknown> = {}) => withId({ title, kind: "web", category: "Shop", source: { origin: "browser-agent" }, steps, ...extra }, "WEB");
    const role = (r: string, name?: string, more: Record<string, unknown> = {}) => ({ by: "role", role: r, ...(name !== undefined ? { value: name } : {}), ...more });
    return [
        // The audit's own example: a status message with no accessible name.
        t("Add a product to the cart", [
            { action: "navigate", url: "/products/1" },
            { action: "click", locator: role("button", "Add to cart") },
            { action: "assert", check: "text", locator: role("status"), expected: "Added to the cart" },
        ]),
        t("Roles without a name, and roles that share a word with the grammar", [
            { action: "navigate", url: "/" },
            { action: "assert", check: "visible", locator: role("status") },
            { action: "assert", check: "visible", locator: role("application") },
            { action: "assert", check: "visible", locator: role("alert") },
            { action: "assert", check: "visible", locator: role("navigation") },
            { action: "assert", check: "visible", locator: role("main") },
            { action: "assert", check: "visible", locator: role("status", "Cart updated") },
            { action: "assert", check: "visible", locator: role("application", "Shop") },
            { action: "assert", check: "text", locator: role("heading", "Welcome", { exact: true }), expected: "Welcome" },
        ]),
        t("Every locator strategy", [
            { action: "navigate", url: "/login" },
            { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
            { action: "fill", locator: { by: "placeholder", value: "Password" }, value: "{{credentials.password}}" },
            { action: "click", locator: { by: "text", value: "Forgot your password?" } },
            { action: "click", locator: { by: "testId", value: "submit-button" } },
            { action: "click", locator: { by: "css", value: "form > button.primary" } },
            { action: "click", locator: { by: "label", value: "Remember me", exact: true, nth: 1 } },
            { action: "click", locator: { by: "role", role: "link", value: "Home", exact: false } },
        ]),
        t("Every action", [
            { action: "navigate", url: "https://other.example/start?x=1#top" },
            { action: "select", locator: { by: "label", value: "Size" }, value: "Large" },
            { action: "check", locator: { by: "label", value: "Gift wrap" }, checked: true },
            { action: "check", locator: { by: "label", value: "Newsletter" }, checked: false },
            { action: "press", key: "Enter", locator: { by: "label", value: "Search" } },
            { action: "press", key: "Escape" },
            { action: "hover", locator: role("button", "Menu") },
            { action: "wait", ms: 500 },
        ]),
        t("Every check", [
            { action: "navigate", url: "/" },
            { action: "assert", check: "visible", expected: "Welcome back" },
            { action: "assert", check: "hidden", expected: "Error" },
            { action: "assert", check: "enabled", locator: role("button", "Pay") },
            { action: "assert", check: "disabled", locator: role("button", "Pay") },
            { action: "assert", check: "value", locator: { by: "label", value: "Email" }, expected: "ada@example.test" },
            { action: "assert", check: "count", locator: role("listitem", "Item"), expected: 3 },
            { action: "assert", check: "count", locator: role("listitem"), expected: "3" },
            { action: "assert", check: "url", expected: "/dashboard" },
            { action: "assert", check: "title", expected: "Dashboard" },
            { action: "assert", check: "text", expected: "Order placed" },
            { action: "assert", check: "a11y" },
            { action: "assert", check: "a11y", expected: "serious" },
            { action: "assert", check: "screenshot" },
            { action: "assert", check: "screenshot", expected: 50 },
            { action: "assert", check: "screenshot", locator: { by: "testId", value: "header" }, expected: 50 },
            { action: "assert", check: "looksRight" },
            { action: "assert", check: "looksRight", expected: "the cart total is visible" },
        ]),
        t("A step with a note, header lines and data", [{ action: "navigate", url: "/", description: "Open the home page" }, { action: "click", locator: role("button", "Go"), description: "" }], {
            description: "Checks the home page.",
            type: "smoke",
            priority: "high",
            tags: ["smoke", "home"],
            preconditions: ["The shop is open"],
            expectedResults: ["The home page is shown"],
            testData: { name: "Ada" },
        }),
    ];
}

export function generatedSpecs(): CorpusItem[] {
    n = 0;
    const out: CorpusItem[] = [];
    const add = (path: string, drafts: unknown[], prefix: string) => {
        for (const d of drafts) out.push({ path, spec: withId(d, prefix) });
    };

    // API generation from OpenAPI (with and without data-changing tests), workflows, latency, load, access.
    add("api: openapi", generateApiSpecs(PETSTORE, { allowMutating: true, maxPerEndpoint: 8 }).specs, "API");
    add("api: openapi (no contract)", generateApiSpecs(PETSTORE, { allowMutating: false, maxPerEndpoint: 8, contractChecks: false }).specs, "API");
    add("api: workflows", generateApiWorkflowSpecs(PETSTORE, { allowMutating: true, maxWorkflows: 10 }).specs, "API");
    add("api: latency", generateLatencySpecs(PETSTORE, { maxEndpoints: 3 }), "API");
    add("api: latency (budget)", generateLatencySpecs(PETSTORE, { maxEndpoints: 2, budgets: "p95:500 max:2000 runs:15" }), "API");
    add("api: load", generateLoadSpecs(PETSTORE, { maxEndpoints: 3, hasCredential: true }), "API");
    add("api: access", generateApiAccessSpecs([{ method: "GET", path: "/admin/users", called: "/admin/users", status: { anonymous: 401, member: 200 } }]), "API");

    // Check families.
    const home = page("/", "home", { forms: [{ purpose: "search", method: "get", fields: [field("q", "search")] }] });
    const model = modelFor("https://shop.example", [home, page("/products", "listing"), page("/login", "login", { forms: [{ purpose: "login", method: "post", fields: [field("email", "email"), field("password", "password")] }] }), page("/cart", "cart")], PETSTORE.map((e) => ({ ...e, origin: "https://shop.example" })));
    add("checks: health", generateHealthSpecs(model, { maxPages: 4 }), "WEB");
    add("checks: security", generateSecuritySpecs(model), "API");
    add("checks: accessibility", generateA11ySpecs(model, { maxPages: 4 }), "WEB");
    add("checks: accessibility (threshold)", generateA11ySpecs(model, { maxPages: 2, threshold: "critical" }), "WEB");
    add("checks: input handling", generateInputSpecs(model, { maxPages: 3, allowMutating: false }), "WEB");
    add("checks: page speed", generatePerformanceSpecs(model, { maxPages: 3 }), "WEB");
    add("checks: page speed (budgets)", generatePerformanceSpecs(model, { maxPages: 2, budgets: "lcp:3000 weight:5000000 slow-4g" }), "WEB");
    add("checks: ai judgement", generateVisionSpecs(model, { maxPages: 2 }), "WEB");
    add("checks: visual", generateVisualSpecs(model, { maxPages: 3 }), "WEB");
    add("checks: access control", generateAccessSpecs([{ who: "anonymous", pages: [{ path: "/", heading: "Home" }] }, { who: "admin", pages: [{ path: "/", heading: "Home" }, { path: "/admin/users", heading: "Users" }, { path: "/admin/settings", heading: "Settings" }] }]), "WEB");

    // The recorder: roles, labels, placeholders, text, test ids, CSS, every step kind.
    const rec = (index: number, step: Partial<RecStep> & Pick<RecStep, "kind">): RecStep => ({ index, describe: `step ${index + 1}`, ...step }) as RecStep;
    const recorded = buildRecordedSpec({
        title: "Recorded checkout",
        startUrl: "https://shop.example/",
        steps: [
            rec(0, { kind: "goto", url: "https://shop.example/products" }),
            rec(1, { kind: "click", locator: { strategy: "role", value: "link", name: "Mug" } }),
            rec(2, { kind: "click", locator: { strategy: "role", value: "button", name: "Add to cart", exact: true } }),
            rec(3, { kind: "fill", locator: { strategy: "label", value: "Quantity" }, value: "2" }),
            rec(4, { kind: "fill", locator: { strategy: "placeholder", value: "Coupon" }, value: "SAVE10" }),
            rec(5, { kind: "select", locator: { strategy: "label", value: "Size" }, value: "L" }),
            rec(6, { kind: "check", locator: { strategy: "label", value: "Gift wrap" } }),
            rec(7, { kind: "uncheck", locator: { strategy: "label", value: "Newsletter" } }),
            rec(8, { kind: "click", locator: { strategy: "text", value: "Checkout" } }),
            rec(9, { kind: "click", locator: { strategy: "testId", value: "pay" } }),
            rec(10, { kind: "click", locator: { strategy: "css", value: "#terms" } }),
            rec(11, { kind: "press", value: "Enter", locator: { strategy: "label", value: "Coupon" } }),
            rec(12, { kind: "assert", locator: { strategy: "role", value: "status" }, assert: { check: "text", expected: "Order placed" } }),
            rec(13, { kind: "assert", assert: { check: "text", expected: "Thank you for your order" } }),
        ] as RecStep[],
    });
    out.push({ path: "recorder", spec: withId(recorded.spec, "WEB") });

    // The plain-English builder for API calls: a plain read, an answer with fields, a status, text, a change when allowed.
    const plain = (description: string, plan: Record<string, unknown>, requiresAuth = false) => {
        const built = buildApiSteps({ explanation: "x", pathValues: {}, query: {}, expect: { fields: [], bodyContains: [] }, ...plan } as never, PETSTORE, { allowChanges: true });
        out.push({ path: "plain english", spec: withId(apiDraft(description, built, requiresAuth), "API") });
    };
    plain("Get pet 1 and check its name", { operation: "GET /pets/{petId}", pathValues: { petId: "1" }, expect: { fields: [{ path: "name", type: "string" }, { path: "id", equals: 1 }], bodyContains: ["name"] } });
    plain("List pets with a limit of 5 and expect 200", { operation: "GET /pets", query: { limit: 5 }, expect: { status: 200, fields: [], bodyContains: [] } });
    plain("Create a pet called Rex", { operation: "POST /pets", body: { name: "Rex", tag: "dog" }, expect: { status: 201, fields: [{ path: "name", equals: "Rex" }], bodyContains: [] } });
    plain("Show my profile", { operation: "GET /me", expect: { fields: [{ path: "email" }], bodyContains: [] } }, true);
    plain("Something no operation fits", { operation: null, explanation: "No such call." });

    // The steps a web scenario starts from.
    for (const s of webSteps()) out.push({ path: "web steps", spec: s });
    return out;
}
