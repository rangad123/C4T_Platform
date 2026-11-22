/**
 * Functional security checks (Phase 4 C11), without a browser: the sensitive-field judgement over captured answers, the rate-limit check's
 * stated limit, caps, gate and throwaway account, the stored-injection variant of a written workflow, and the hand-over draft, which no
 * assessment uses until a person saves it. Expected values come from the bench requirements (bench-shop 8.6, bench-rbac 2.14 and 3.15).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RATE_LIMIT_MAX_ATTEMPTS, rateLimitSpec, sensitiveFieldSpecs, sensitiveFields, statedSignInLimit, storedInjectionSpec } from "../src/engine/security/functional.js";
import type { Step } from "../src/engine/spec/schema.js";
import type { CapturedCall } from "../src/engine/web/correlation.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { IdentityStore } from "../src/platform/identity-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";
import { designationFromListEvidence, readDesignation, readDesignationDraft, writeDesignationDraft } from "../src/security/cross-account-store.js";

const call = (body: unknown, more: Partial<CapturedCall> = {}): CapturedCall => ({ method: "GET", path: "/api/profile", status: 200, body: typeof body === "string" ? body : JSON.stringify(body), ...more });
const R_86 = { id: "8.6", text: "No API response ever contains a password or any other sign-in secret." };
const R_214 = { id: "2.14", text: "After 5 failed sign-ins for the same email address within one minute, every sign-in for that email address is refused for one minute with \"Too many failed sign-ins. Try again in a minute.\" (API: 429), even with the right password." };
const R_315 = { id: "3.15", text: "A note's title and text are always shown as plain text, exactly as typed: characters such as < and > never become part of the page's markup." };

describe("sensitive fields in captured answers", () => {
    it("a password field with a value (masked or not) is a hit; names that hold no secret, empty values and refusals are not", () => {
        expect(sensitiveFields([call({ name: "Alice", email: "[hidden]", address: "1 Quay Road", password: "[hidden]" })])).toEqual([{ method: "GET", path: "/api/profile", fields: ["password"], status: 200 }]);
        expect(sensitiveFields([call({ name: "Alice", email: "[hidden]", address: "1 Quay Road" })])).toEqual([]);
        expect(sensitiveFields([call({ passwordPolicy: { minLength: 8 }, hasPassword: true, password: null, pin: "", token: "abc", sessionId: "s1" })])).toEqual([]);
        expect(sensitiveFields([call({ password: "x" }, { status: 401 })])).toEqual([]);
        expect(sensitiveFields([call("<html>password: x</html>")])).toEqual([]);
    });
    it("hash and secret names anywhere in the answer, and hash values under any name, one hit per method and path", () => {
        const bcrypt = `$2b$12$${"a".repeat(53)}`;
        const hits = sensitiveFields([
            call([{ id: 1, password_hash: "x" }], { path: "/api/users?page=1" }),
            call({ id: 2, profile: { digest: bcrypt } }, { path: "/api/users/2" }),
            call({ client_secret: "y" }, { method: "POST", path: "/api/apps", status: 201 }),
            call({ password: "again" }, { path: "/api/users" }),
        ]);
        expect(hits.map((h) => [h.method, h.path, h.fields])).toEqual([
            ["GET", "/api/users", ["0.password_hash"]],
            ["GET", "/api/users/2", ["profile.digest"]],
            ["POST", "/api/apps", ["client_secret"]],
        ]);
    });
    it("only a GET becomes a saved test, sourced from the stated requirement, checking each field is gone", () => {
        const specs = sensitiveFieldSpecs([{ method: "GET", path: "/api/profile", fields: ["password"], status: 200 }, { method: "POST", path: "/api/apps", fields: ["client_secret"], status: 201 }], [R_315, R_86]);
        expect(specs).toHaveLength(1);
        expect(specs[0]!.source).toEqual({ origin: "security-check", requirements: ["8.6"] });
        expect(specs[0]!.steps.at(-1)).toEqual(expect.objectContaining({ action: "assertResponse", check: "jsonType", path: "password", expected: "undefined", source: "8.6" }));
        expect(sensitiveFieldSpecs([{ method: "GET", path: "/api/me", fields: ["password"], status: 200 }])[0]!.source).toEqual({ origin: "security-check" });
    });
});

const signInApis = [
    { method: "POST", path: "/api/register", statuses: [201, 400, 409], requestSchema: { type: "object", required: ["name", "email", "password"], properties: { name: { type: "string" }, email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } } },
    { method: "POST", path: "/api/login", statuses: [200, 401, 429] },
    { method: "POST", path: "/api/admin/users", statuses: [201, 403], requestSchema: { properties: { email: { type: "string" }, password: { type: "string" } } } },
];

describe("rate limit: only from a stated limit, bounded, on a throwaway account", () => {
    it("reads the stated limit (number or word), and nothing from a requirement without one", () => {
        expect(statedSignInLimit([R_86, R_214])).toEqual({ req: R_214, fails: 5, status: 429, rightPassword: true });
        expect(statedSignInLimit([{ id: "9", text: "After three wrong passwords the account is locked." }])).toMatchObject({ fails: 3, status: 429, rightPassword: false });
        expect(statedSignInLimit([{ id: "1", text: "Failed sign-ins are refused with a message." }, { id: "2", text: "Sign-in should be rate limited." }])).toBeUndefined();
    });
    it("no stated limit, no gate, a limit past the cap, no sign-up: no check, and the reason", () => {
        expect(rateLimitSpec({ apis: signInApis, requirements: [R_86], gate: true })).toEqual({ skipped: expect.stringMatching(/No requirement states a sign-in limit/) });
        expect(rateLimitSpec({ apis: signInApis, requirements: [R_214], gate: false })).toEqual({ skipped: expect.stringMatching(/authorization/) });
        expect(rateLimitSpec({ apis: signInApis, requirements: [{ id: "x", text: "After 7 failed sign-ins it is refused (429)." }], gate: true })).toEqual({ skipped: expect.stringMatching(/8 attempts, more than the 7/) });
        // Only the admin's create-a-user has a password field: that is no sign-up, and the shared account is never used instead.
        expect(rateLimitSpec({ apis: signInApis.filter((a) => a.path !== "/api/register"), requirements: [R_214], gate: true })).toEqual({ skipped: expect.stringMatching(/no documented sign-up/) });
    });
    it("a fresh account, then the stated failures and one more: at most 7 attempts, never a test account's credentials", () => {
        const { spec } = rateLimitSpec({ apis: signInApis, requirements: [R_214], gate: true });
        const steps = spec!.steps as Array<Step & { path?: string; body?: Record<string, string> }>;
        const signIns = steps.filter((s) => s.action === "request" && s.path === "/api/login");
        expect(signIns).toHaveLength(6);
        expect(signIns.length).toBeLessThanOrEqual(RATE_LIMIT_MAX_ATTEMPTS);
        expect(steps[0]).toMatchObject({ action: "request", method: "POST", path: "/api/register", auth: "none", body: { name: expect.any(String), email: "rate-limit-{{unique}}@example.test", password: expect.stringContaining("{{unique}}") } });
        // "even with the right password" (2.14): the last attempt uses the fresh account's own password.
        expect(signIns.at(-1)!.body).toEqual({ email: "rate-limit-{{unique}}@example.test", password: steps[0]!.body!.password });
        expect(signIns.slice(0, 5).every((s) => s.body!.password !== steps[0]!.body!.password)).toBe(true);
        expect(steps.at(-1)).toEqual(expect.objectContaining({ action: "assertResponse", check: "status", expected: 429, source: "2.14" }));
        expect(JSON.stringify(spec)).not.toMatch(/credentials\.|"auth":"default"/);
    });
});

const signIn: Step[] = [
    { action: "navigate", url: "/login" },
    // A sign-in field the free-text rule would not recognise: the {{credentials}} value alone keeps it unmarked.
    { action: "fill", locator: { by: "label", value: "Username" }, value: "{{credentials.username}}" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign in" } },
] as Step[];
const workflow: Step[] = [
    ...signIn,
    { action: "navigate", url: "/notes/new" },
    { action: "fill", locator: { by: "label", value: "Title" }, value: "Groceries" },
    { action: "fill", locator: { by: "label", value: "Contact email" }, value: "x@example.test" },
    { action: "fill", locator: { by: "label", value: "Text" }, value: "Milk" },
    { action: "click", locator: { by: "role", role: "button", value: "Save note" } },
    { action: "wait", ms: 0, until: "url", value: "/notes/n" },
    { action: "assert", check: "visible", locator: { by: "text", value: "Groceries" } },
] as Step[];
const created = call({ id: "n5", title: "Groceries" }, { step: 8, method: "POST", path: "/api/notes", status: 201 });

describe("stored injection: the written workflow with a marker", () => {
    it("marks the free-text fields filled before the first successful write, keeps the write and its waits, then looks for the element", () => {
        const spec = storedInjectionSpec({ title: "New note", steps: workflow, calls: [call({ ok: 1 }, { step: 3, method: "POST", path: "/login", status: 401 }), created], requirements: [R_315], dataChanges: true })!;
        const fills = spec.steps.filter((s): s is Extract<Step, { action: "fill" }> => s.action === "fill").map((s) => s.value);
        expect(fills).toEqual(["{{credentials.username}}", "{{credentials.password}}", 'C4T <i data-c4t-probe="1">probe</i> {{unique}}', "x@example.test", 'C4T <i data-c4t-probe="2">probe</i> {{unique}}']);
        expect(spec.steps.slice(0, 10)).toEqual(expect.arrayContaining([workflow[8], workflow[9]]));
        // The writer's own check of the old value is gone; the last check is the marker's, sourced from 3.15.
        expect(spec.steps.some((s) => s.action === "assert" && s.check === "visible")).toBe(false);
        expect(spec.steps.at(-1)).toEqual(expect.objectContaining({ action: "assert", check: "count", locator: { by: "css", value: "[data-c4t-probe]" }, expected: 0, source: "3.15" }));
    });
    it("nothing without data changes, without a successful write, or without a free-text field before it", () => {
        expect(storedInjectionSpec({ title: "t", steps: workflow, calls: [created], dataChanges: false })).toBeUndefined();
        expect(storedInjectionSpec({ title: "t", steps: workflow, calls: [{ ...created, status: 400 }], dataChanges: true })).toBeUndefined();
        expect(storedInjectionSpec({ title: "t", steps: workflow, calls: [{ ...created, readBack: true }], dataChanges: true })).toBeUndefined();
        expect(storedInjectionSpec({ title: "t", steps: workflow, calls: [{ ...created, step: 3 }], dataChanges: true })).toBeUndefined();
    });
});

describe("hand-over: a draft designation a person confirms", () => {
    const rows = [
        { list: "/api/notes", detail: "/api/notes/{id}", items: { anonymous: [], ana: [{ id: "n1" }, { id: "n3" }], ben: [{ id: "n2" }, { id: "n3" }] } },
    ];
    let dir: string;
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let projectId: string;
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-c11-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", WORKER_EMBEDDED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true" }));
        server = await buildServer(platform);
        projectId = platform.repo.createProject({ name: "C11 hand-over" }).id as string;
        new IdentityStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).set(projectId, [
            { name: "ana", username: "ana@example.test", password: "never-typed-1" },
            { name: "ben", username: "ben@example.test", password: "never-typed-2" },
        ]);
    }, 60_000);
    afterAll(async () => {
        await server?.close();
        platform?.db.close?.();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const api = async (method: "GET" | "POST" | "PUT", url: string, body?: unknown) => {
        const r = await server.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}) });
        return { status: r.statusCode, json: r.json() };
    };

    it("drafts A's and B's records from the list evidence, and nothing from lists that tell no owner apart", () => {
        expect(designationFromListEvidence(rows)).toEqual({
            accountA: "ana",
            accountB: "ben",
            resources: [
                { path: "/api/notes/n2", kind: "item", owner: "B", label: "In ben's list of /api/notes, not in ana's" },
                { path: "/api/notes/n1", kind: "item", owner: "A", label: "In ana's list of /api/notes, not in ben's" },
            ],
        });
        expect(designationFromListEvidence([{ ...rows[0]!, items: { ana: [{ id: "n3" }], ben: [{ id: "n3" }] } }])).toBeUndefined();
        expect(designationFromListEvidence([{ ...rows[0]!, items: { ana: [{ id: "n1" }] } }])).toBeUndefined();
    });

    it("the draft is shown with the run and findings it came from, never used, and settled when a person saves", async () => {
        const app = await api("POST", `/api/v1/security/projects/${projectId}/applications`, { name: "Notes (staging)", targetUrl: "http://127.0.0.1:9781/", environment: "staging", maxRequestsPerSecond: 5 });
        expect(app.status, JSON.stringify(app.json)).toBe(201);
        const appId = app.json.application.id as string;
        // No application at another origin: nothing is kept.
        expect(writeDesignationDraft(platform.db, { projectId, origin: "http://127.0.0.1:9999", rows, source: { runId: "r1", findings: [] } })).toBeUndefined();
        const kept = writeDesignationDraft(platform.db, { projectId, origin: "http://127.0.0.1:9781/notes", rows, source: { runId: "run-7", findings: ["API-012"] } });
        expect(kept).toEqual({ applicationId: appId, applicationName: "Notes (staging)" });
        // Never applied: the assessment reads only a saved designation (assessment/runner.ts readDesignation).
        expect(readDesignation(platform.db, appId)).toBeUndefined();
        const got = await api("GET", `/api/v1/security/applications/${appId}/cross-account`);
        expect(got.json.designation).toBeNull();
        expect(got.json.draft).toEqual(expect.objectContaining({ designation: designationFromListEvidence(rows), source: { runId: "run-7", findings: ["API-012"] } }));
        // The person reviews it and saves it (here unchanged): it becomes the designation, and the draft is gone.
        const saved = await api("PUT", `/api/v1/security/applications/${appId}/cross-account`, got.json.draft.designation);
        expect(saved.status, JSON.stringify(saved.json)).toBe(200);
        expect(readDesignation(platform.db, appId)).toEqual(got.json.draft.designation);
        expect(readDesignationDraft(platform.db, appId)).toBeUndefined();
        expect((await api("GET", `/api/v1/security/applications/${appId}/cross-account`)).json.draft).toBeNull();
    });
});
