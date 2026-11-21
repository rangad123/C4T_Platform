/**
 * Session ends on sign-out: when the check is made (a sign-out and a signed-in target are needed), what it holds (addresses and a
 * control's name, never a cookie), and that the script-side helper is part of the access helper the generated scripts carry.
 */
import { describe, expect, it } from "vitest";
import { ACCESS_HELPER_SOURCE, type Reach } from "../src/engine/identity/access.js";
import { generateSessionEndSpecs } from "../src/engine/identity/session-end.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessHelper, fakeBrowser, setAccounts } from "./identity-fake-browser.js";

const cfg = (s: ReturnType<typeof generateSessionEndSpecs>[number]) => JSON.parse(String((s.steps[1] as { expected: string }).expected)) as Record<string, unknown>;
const anon: Reach = { who: "anonymous", pages: [{ path: "/", heading: "Notes app" }, { path: "/login", heading: "Sign in" }] };
const ana: Reach = { who: "ana", pages: [{ path: "/", heading: "Notes app" }, { path: "/notes", heading: "Your notes" }] };
const RBAC = [
    { method: "POST", path: "/api/login", statuses: [200, 401] },
    { method: "POST", path: "/api/logout", statuses: [200] },
    { method: "GET", path: "/api/me", statuses: [200, 401] },
    { method: "GET", path: "/api/notes", statuses: [200] },
    { method: "GET", path: "/api/notes/{id}", statuses: [200, 401, 404] },
];

describe("session end on sign-out", () => {
    it("signs out through the documented endpoint and tries the old session on a who-am-I endpoint documented to answer 401 (bench-rbac BR-05)", () => {
        const [spec, ...rest] = generateSessionEndSpecs({ apis: RBAC, reach: [anon, ana] });
        expect(rest).toEqual([]);
        expect(spec!.title).toBe("“ana” account: the session ends on sign-out");
        expect(spec).toMatchObject({ kind: "web", type: "security", category: "Access control", priority: "high", source: { origin: "access-check" } });
        expect(cfg(spec!)).toEqual({ sessionEnd: true, as: "ana", signOut: { api: "/api/logout" }, api: true, path: "/api/me", sev: "high" });
    });

    it("without a documented endpoint, uses a sign-out control and a page only the account reached", () => {
        const withControl: Reach = { ...ana, controls: [{ path: "/notes", names: ["New note", "Sign out"] }] };
        const [spec] = generateSessionEndSpecs({ apis: [], reach: [anon, withControl] });
        expect(cfg(spec!)).toEqual({ sessionEnd: true, as: "ana", signOut: { control: "Sign out" }, path: "/notes", marker: "Your notes", sev: "high" });
    });

    it("is not made without a sign-out, without a signed-in target, or without a signed-in account", () => {
        expect(generateSessionEndSpecs({ apis: RBAC.filter((a) => a.path !== "/api/logout"), reach: [anon, ana] })).toEqual([]);
        expect(generateSessionEndSpecs({ apis: [{ method: "POST", path: "/api/logout" }], reach: [anon, { ...ana, pages: anon.pages }] })).toEqual([]);
        expect(generateSessionEndSpecs({ apis: RBAC, reach: [anon] })).toEqual([]);
        expect(generateSessionEndSpecs({ apis: RBAC, reach: [anon, { ...ana, incomplete: "crashed" }] })).toEqual([]);
        // a GET endpoint not documented to refuse visitors says nothing about the session
        expect(generateSessionEndSpecs({ apis: [{ method: "POST", path: "/api/logout" }, { method: "GET", path: "/api/me", statuses: [200] }], reach: [ana] })).toEqual([]);
    });

    it("holds no cookie or secret: only addresses, a control's name and the account's name; the helper is in the access helper", () => {
        const [spec] = generateSessionEndSpecs({ apis: RBAC, reach: [anon, ana] });
        expect(JSON.stringify(spec)).not.toMatch(/cookie\s*[:=]|sid=|password/i);
        expect(ACCESS_HELPER_SOURCE).toContain("async function accessSessionEndAssert(page, base, cfg)");
        expect(ACCESS_HELPER_SOURCE).toContain("if (cfg.sessionEnd) return await accessSessionEndAssert(page, base, cfg);");
        expect(() => new Function(ACCESS_HELPER_SOURCE)).not.toThrow();
    });

    it("signs in only where HTTPS errors are not ignored on a normal project (T4's rule), and the web script declares that rule", async () => {
        setAccounts(["ana", "bob"]);
        const [spec] = generateSessionEndSpecs({ apis: RBAC, reach: [anon, ana] });
        const runs = [
            cfg(spec!),
            { as: "ana", path: "/notes", marker: "Your notes", sev: "high" },
            { api: true, as: "bob", path: "/api/notes/1", origin: "http://app.test", by: "ana", of: "ana", sev: "high", pattern: "/api/notes/{}", evidence: [] },
        ];
        for (const run of runs) {
            const f = fakeBrowser({ answer: () => ({ status: 200, body: "{}" }) });
            await accessHelper.accessAssert(f.page, "http://app.test", JSON.stringify(run)).catch(() => undefined);
            expect(f.options.length, JSON.stringify(run)).toBeGreaterThan(0);
            for (const o of f.options) expect(o.ignoreHTTPSErrors, JSON.stringify(run)).toBe(false);
        }
        expect(ACCESS_HELPER_SOURCE).not.toMatch(/ignoreHTTPSErrors:\s*true/);
        const { content } = renderScript(TestSpecSchema.parse({ ...spec, testId: "ACC-001" }), "playwright", { baseUrl: "http://app.test" });
        expect(content).toContain("const IGNORE_HTTPS_ERRORS = false;");
    });
});
