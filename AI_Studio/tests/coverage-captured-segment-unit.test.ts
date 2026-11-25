/**
 * A value an API test captures while it runs (`extract`) and then uses as a whole part of a request path (`/api/orders/{{order}}/pay`):
 * its endpoint is known when the application's documented or observed endpoints (the app model, AppFacts.endpoints) have that template.
 * Then the test is complete and is proposed only when that endpoint is reached. Anything less certain stays "not fully known".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { projectCoverage } from "../src/platform/selection/facts.js";
import { extractCoverage, type AppFacts, type TestFacts } from "../src/platform/selection/coverage.js";
import { previewSelection, readChanges } from "../src/platform/selection/preview.js";

const PATH_LIMIT = "A request's address has a variable inside its path that is missing from the test data or whose value is not one part of a path, so that endpoint is not fully known.";
const place = { action: "request", method: "POST", path: "/api/orders", extract: { order: "id" } };
const api = (steps: unknown[], testData: Record<string, string> = {}): TestFacts => ({ id: "t1", testKey: "API-001", title: "Pay an order", kind: "api", spec: { steps, testData }, runs: [], freshness: { fresh: true, executionId: "run-1" } });
const APP: AppFacts = { appHost: "shop.test", endpoints: [{ method: "POST", path: "/api/orders" }, { method: "POST", path: "/api/orders/{id}/pay" }, { method: "GET", path: "/api/orders/{orderId}" }] };

describe("a captured value as a whole part of a request path", () => {
    it("resolves to the documented template: complete, and proposed only when that endpoint is reached", () => {
        const c = extractCoverage(api([place, { action: "request", method: "POST", path: "/api/orders/{{order}}/pay" }]), APP);
        expect(c.limits).not.toContain(PATH_LIMIT);
        expect(c.completeness).toBe("declared-complete");
        expect(c.items.map((i) => `${i.method} ${i.path}`)).toEqual(["POST /api/orders", "POST /api/orders/{}/pay"]);
        expect(previewSelection([c], readChanges({ endpoints: ["POST /api/orders/{id}/pay"] }, APP).changes).matched.map((t) => t.testId)).toEqual(["t1"]);
        const elsewhere = previewSelection([c], readChanges({ endpoints: ["GET /api/cart"] }, APP).changes);
        expect([elsewhere.matched.length, elsewhere.unknown.length, elsewhere.notMatched.length]).toEqual([0, 0, 1]);
        // The template's own name for the part does not matter.
        expect(extractCoverage(api([place, { action: "request", method: "GET", path: "/api/orders/{{order}}" }]), APP).completeness).toBe("declared-complete");
    });

    it("a literal part of the path matches the template's variable there (`/share/u2` is `/share/{userId}`)", () => {
        const app: AppFacts = { endpoints: [{ method: "DELETE", path: "/api/notes/{id}/share/{userId}" }] };
        const make = { action: "request", method: "POST", path: "/api/notes", extract: { note: "id" } };
        expect(extractCoverage(api([make, { action: "request", method: "DELETE", path: "/api/notes/{{note}}/share/u2" }]), app).limits).not.toContain(PATH_LIMIT);
        // A literal where the template has a literal must be that literal.
        expect(extractCoverage(api([make, { action: "request", method: "DELETE", path: "/api/notes/{{note}}/unshare/u2" }]), app).limits).toContain(PATH_LIMIT);
        // The captured value must sit where the template has a variable.
        expect(extractCoverage(api([make, { action: "request", method: "DELETE", path: "/api/notes/n1/share/{{note}}/x" }]), app).limits).toContain(PATH_LIMIT);
        expect(extractCoverage(api([make, { action: "request", method: "DELETE", path: "/api/{{note}}/n1/share/u2" }]), app).limits).toContain(PATH_LIMIT);
    });

    it("a captured value in a page path resolves to a page template: the app model's page, or a route the repository registers for any method", () => {
        const make = { action: "request", method: "POST", path: "/api/notes", extract: { note: "id" } };
        const view = { action: "request", method: "GET", path: "/notes/{{note}}" };
        expect(extractCoverage(api([make, view]), { endpoints: [{ method: "GET", path: "/notes/{id}" }] }).completeness).toBe("declared-complete");
        expect(extractCoverage(api([make, view]), { endpoints: [{ method: "*", path: "/notes/{}" }] }).completeness).toBe("declared-complete");
        // A template for another method still does not fit.
        expect(extractCoverage(api([make, view]), { endpoints: [{ method: "POST", path: "/notes/{}" }] }).limits).toContain(PATH_LIMIT);
    });

    it("stays not fully known without a documented or observed template of that method and path", () => {
        const pay = { action: "request", method: "POST", path: "/api/orders/{{order}}/pay" };
        expect(extractCoverage(api([place, pay]), { appHost: "shop.test" }).limits).toContain(PATH_LIMIT);
        expect(extractCoverage(api([place, { ...pay, method: "DELETE" }]), APP).limits).toContain(PATH_LIMIT);
        expect(extractCoverage(api([place, { ...pay, path: "/api/orders/{{order}}/refund" }]), APP).limits).toContain(PATH_LIMIT);
    });

    it("stays not fully known when the value is only part of a path segment, or is not captured by an earlier step", () => {
        expect(extractCoverage(api([place, { action: "request", method: "GET", path: "/api/orders/ord-{{order}}" }]), APP).limits).toContain(PATH_LIMIT);
        // Never captured (a data-set column, or set some other way): it may hold several parts.
        expect(extractCoverage(api([{ action: "request", method: "GET", path: "/api/orders/{{order}}" }]), APP).limits).toContain(PATH_LIMIT);
        // Captured only after the request that uses it.
        expect(extractCoverage(api([{ action: "request", method: "GET", path: "/api/orders/{{order}}" }, place]), APP).limits).toContain(PATH_LIMIT);
        // Test data that holds several parts stays as it was, whatever the templates.
        expect(extractCoverage(api([{ action: "request", method: "GET", path: "/api/orders/{{order}}" }], { order: "a/b" }), APP).limits).toContain(PATH_LIMIT);
    });
});

describe("the project's endpoint templates", () => {
    it("come from the latest app model's documented and observed endpoints", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-captured-segment-"));
        const p = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "captured-segment-secret-key-0123456789", API_KEY: "k", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
        try {
            const projectId = String(p.repo.createProject({ name: "Shop" }).id);
            p.repo.createApplication(projectId, "http://shop.test", { ...DEFAULT_JOB_OPTIONS });
            const suiteId = p.repo.getOrCreateSuite(projectId, "Orders", "orders");
            const spec = TestSpecSchema.parse({ testId: "API-001", title: "Pay an order", kind: "api", category: "Orders", steps: [place, { action: "request", method: "POST", path: "/api/orders/{{order}}/pay" }] });
            p.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright-api", validationStatus: "VALIDATED" });
            const limits = async () => (await projectCoverage(p.repo, p.store, projectId)).tests[0]!.limits;
            expect(await limits()).toContain(PATH_LIMIT);
            const endpoints = [{ method: "POST", path: "/api/orders/{id}/pay", origin: "documented" }];
            p.db.run("INSERT INTO app_model_versions (id, project_id, version, model_json, created_at) VALUES (?,?,?,?,?)", "m1", projectId, 1, JSON.stringify({ endpoints }), new Date().toISOString());
            expect(await limits()).not.toContain(PATH_LIMIT);
            // A page test: its page path resolves to the model's page, or to a template a PR's analysis passes (the repository's routes).
            const page = TestSpecSchema.parse({ testId: "API-002", title: "A note page", kind: "api", category: "Notes", steps: [{ action: "request", method: "POST", path: "/api/notes", extract: { note: "id" } }, { action: "request", method: "GET", path: "/notes/{{note}}" }] });
            p.repo.insertTest({ projectId, suiteId, jobId: null, spec: page, framework: "playwright-api", validationStatus: "VALIDATED" });
            const pageLimits = async (o = {}) => (await projectCoverage(p.repo, p.store, projectId, o)).tests.find((t) => t.testKey === "API-002")!.limits;
            expect(await pageLimits()).toContain(PATH_LIMIT);
            expect(await pageLimits({ templates: [{ method: "*", path: "/notes/{}" }] })).not.toContain(PATH_LIMIT);
            p.db.run("INSERT INTO app_model_versions (id, project_id, version, model_json, created_at) VALUES (?,?,?,?,?)", "m2", projectId, 2, JSON.stringify({ endpoints, pages: [{ id: "note", path: "/notes/{id}" }] }), new Date().toISOString());
            expect(await pageLimits()).not.toContain(PATH_LIMIT);
        } finally {
            p.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
