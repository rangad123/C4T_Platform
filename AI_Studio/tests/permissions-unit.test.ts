/**
 * The permission catalogue and the route-to-permission table (auth/permissions.ts, auth/roles.ts), without Crowd4Test: the 16 codes
 * as ACCESS_MODEL.md names them, the never-lists, what a Crowd4Test account ends up holding, that every registered route has a
 * rule that is a known code, and that for local accounts every route allows and refuses exactly what it did when the table named
 * roles (the table as it was is kept in tests/fixtures/route-roles-before-permissions.json). Also the cost filter and the migration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { registeredRoutes } from "../src/platform/auth/access.js";
import { atLeast, permissionRefusal, permissionsOf, type Role } from "../src/platform/auth/actor.js";
import { COST_FIELDS, withoutCost } from "../src/platform/auth/cost-hiding.js";
import { ALL_PERMISSIONS, leastRoleFor, NEVER_FOR_CUSTOMER, NEVER_FOR_TESTER, PERMISSIONS, permissionsForC4t, ROLE_PERMISSIONS, type Permission } from "../src/platform/auth/permissions.js";
import { permissionRuleFor, ROUTE_PERMISSIONS, ROUTE_ROLES, ruleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db } from "../src/platform/db.js";
import { ProjectAccessStore } from "../src/platform/project-access-store.js";
import { buildServer } from "../src/platform/server.js";

const BEFORE: Record<string, "owner" | "editor" | "viewer" | "public" | "own"> = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/route-roles-before-permissions.json"), "utf8"));
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-permu-"));
    dirs.push(d);
    return d;
};
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("the catalogue", () => {
    it("has the 16 codes of ACCESS_MODEL.md, as stable strings", () => {
        expect([...PERMISSIONS]).toEqual([
            "ai_studio.access",
            "ai_studio.project.create",
            "ai_studio.project.settings",
            "ai_studio.project.members",
            "ai_studio.tests.write",
            "ai_studio.tests.generate",
            "ai_studio.tests.approve",
            "ai_studio.tests.run",
            "ai_studio.agent.run",
            "ai_studio.reports.export",
            "ai_studio.tests.delete",
            "ai_studio.runners.manage",
            "ai_studio.ai_keys.manage",
            "ai_studio.usage.view",
            "ai_studio.security.use",
            "ai_studio.platform.settings",
        ]);
        expect([...NEVER_FOR_TESTER].sort()).toEqual(["ai_studio.ai_keys.manage", "ai_studio.platform.settings", "ai_studio.project.create", "ai_studio.project.members", "ai_studio.usage.view"]);
        expect([...NEVER_FOR_CUSTOMER]).toEqual(["ai_studio.platform.settings"]);
    });

    it("gives Crowd4Test accounts what was granted, minus their never-list, and ADMIN everything", () => {
        expect(permissionsForC4t("ADMIN", [])).toBe(ALL_PERMISSIONS);
        const granted = [...PERMISSIONS, "project.read", "ai_studio.made_up", 42 as unknown as string];
        expect([...permissionsForC4t("SUB_ADMIN", granted)]).toEqual([...PERMISSIONS]);
        expect([...permissionsForC4t("CUSTOMER", granted)]).toEqual(PERMISSIONS.filter((c) => c !== "ai_studio.platform.settings"));
        expect([...permissionsForC4t("TESTER", granted)]).toEqual(PERMISSIONS.filter((c) => !NEVER_FOR_TESTER.has(c)));
        expect([...permissionsForC4t("TESTER", ["ai_studio.usage.view"])]).toEqual([]);
    });

    it("words a refusal for Crowd4Test accounts in their terms, and for local ones as before", () => {
        const c4t = { kind: "user" as const, id: "u", name: "T", role: "editor" as const, via: "crowd4test" as const, permissions: new Set<Permission>(["ai_studio.access"]) };
        expect(permissionRefusal(c4t, "ai_studio.tests.run")).toBe("You don't have permission to run tests. Ask your Crowd4Test administrator.");
        expect(permissionRefusal({ kind: "user", id: "v", name: "V", role: "viewer" }, "ai_studio.tests.run")).toBe("This needs the Editor role, and you have Viewer. Ask an owner of this platform if you need it.");
        // An actor made without permissions (background work, older callers) holds its role's codes.
        expect(permissionsOf({ kind: "schedule", name: "Schedule", role: "editor" })).toBe(ROLE_PERMISSIONS.editor);
    });
});

describe("the route-to-permission table", () => {
    let platform: Platform;
    let routes: Array<{ method: string; url: string }>;
    beforeAll(async () => {
        platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", API_KEY: "permu-key-0123456789", SECURITY_ASSESSMENT: "on" }));
        const app = await buildServer(platform);
        await app.ready();
        routes = registeredRoutes(app).filter((r) => r.method !== "HEAD");
        await app.close();
    }, 60_000);
    afterAll(() => platform?.db.close());

    it("has a known permission rule for every registered route (add new routes to src/platform/auth/roles.ts)", () => {
        expect(routes.length).toBeGreaterThan(300);
        const known = new Set<string>([...PERMISSIONS, "read", "public", "own"]);
        const missing = [...new Set(routes.filter((r) => !known.has(String(permissionRuleFor(r.method, r.url)))).map((r) => `${r.method} ${r.url}`))].sort();
        expect(missing, `Routes without a permission rule in src/platform/auth/roles.ts:\n${missing.join("\n")}`).toEqual([]);
        for (const v of Object.values(ROUTE_PERMISSIONS)) expect(known.has(v), v).toBe(true);
        // ai_studio.access itself is spelled "read" in the table.
        expect(Object.values(ROUTE_PERMISSIONS)).not.toContain("ai_studio.access");
    });

    const REMOVED_ROUND_45 = new Set(["GET /api/projects/:id/agent-tokens", "POST /api/projects/:id/agent-tokens", "DELETE /api/projects/:id/agent-tokens/:tid", "POST /api/projects/:id/runner-kits", "GET /api/projects/:id/runner-kits/info", "PUT /api/projects/:id/agents/:agentId/updates", "POST /api/projects/:id/agents/:agentId/update"]);
    it("keeps every route's answer for owners, editors and viewers exactly as when the table named roles", () => {
        expect(Object.keys(BEFORE).length).toBeGreaterThan(350);
        const changed: string[] = [];
        for (const [k, before] of Object.entries(BEFORE)) {
            const rule = ROUTE_PERMISSIONS[k];
            if (rule === undefined) {
                // Round 45 removed the project runner tokens, kits and per-project update routes (one runner per person, set up in Settings).
                if (REMOVED_ROUND_45.has(k)) continue;
                changed.push(`${k}: gone from the table`);
                continue;
            }
            if (before === "public" || before === "own") {
                if (rule !== before) changed.push(`${k}: ${before} → ${rule}`);
                continue;
            }
            if (rule === "public" || rule === "own") {
                changed.push(`${k}: ${before} → ${rule}`);
                continue;
            }
            const code: Permission = rule === "read" ? "ai_studio.access" : rule;
            for (const role of ["owner", "editor", "viewer"] as Role[]) {
                if (ROLE_PERMISSIONS[role].has(code) !== atLeast(role, before)) changed.push(`${k}: ${role} ${atLeast(role, before) ? "allowed" : "refused"} before, not now (${code})`);
            }
            if (ROUTE_ROLES[k] !== before || ruleFor(k.split(" ")[0]!, k.split(" ")[1]!) !== before) changed.push(`${k}: derived role ${ROUTE_ROLES[k]}, was ${before}`);
        }
        expect(changed, changed.join("\n")).toEqual([]);
    });

    it("holds nested role sets: a viewer's codes are an editor's, an editor's an owner's, and an owner holds all", () => {
        for (const c of ROLE_PERMISSIONS.viewer) expect(ROLE_PERMISSIONS.editor.has(c)).toBe(true);
        for (const c of ROLE_PERMISSIONS.editor) expect(ROLE_PERMISSIONS.owner.has(c)).toBe(true);
        expect(ROLE_PERMISSIONS.owner.size).toBe(PERMISSIONS.length);
        expect(leastRoleFor("ai_studio.usage.view")).toBe("viewer");
        expect(leastRoleFor("ai_studio.tests.write")).toBe("editor");
        expect(leastRoleFor("ai_studio.project.members")).toBe("owner");
    });

    it("puts the usage, price and budget reads behind ai_studio.usage.view", () => {
        const usage = routes.filter((r) => r.method === "GET" && /usage/.test(r.url) && !r.url.includes("/blocks/"));
        expect(usage.map((r) => r.url).sort()).toEqual(["/api/jobs/:id/usage", "/api/projects/:id/usage-budget", "/api/usage", "/api/usage/budgets", "/api/usage/prices"]);
        for (const r of usage) expect(permissionRuleFor("GET", r.url), r.url).toBe("ai_studio.usage.view");
    });
});

describe("the cost filter", () => {
    it("removes cost and token fields at any depth, and the AI limit's numbers from its events", () => {
        const job = { jobId: "j", counters: { testsGenerated: 2, llmInputTokens: 10, llmOutputTokens: 5 }, nested: [{ cost: 1.2, price: { a: 1 }, keep: "yes", performanceBudgets: { lcp: 1 } }] };
        expect(withoutCost(job)).toEqual({ jobId: "j", counters: { testsGenerated: 2 }, nested: [{ keep: "yes", performanceBudgets: { lcp: 1 } }] });
        expect(withoutCost({ kind: "ai_budget_stop", message: "used 1,000,000 tokens", data: { used: 1 } })).toEqual({ kind: "ai_budget_stop", message: "The AI usage limit was reached. AI work stops here; what was already created is kept." });
        expect(withoutCost({ kind: "constructor", message: "kept" })).toEqual({ kind: "constructor", message: "kept" });
        expect(withoutCost({ tokens: [{ name: "ci" }] })).toEqual({ tokens: [{ name: "ci" }] });
        expect(COST_FIELDS.has("tokens")).toBe(false);
        // what smaller snapshots saved: its numbers, its sentence, and a job's summary of it
        const saved = { kind: "snapshot_savings", message: "about 1.2k tokens instead of 9k (87% fewer)", data: { kind: "web", baselineTokens: 9000, sentTokens: 1200, savedTokens: 7800 } };
        expect(withoutCost(saved)).toEqual({ kind: "snapshot_savings", message: "Smaller page snapshots were used." });
        expect(withoutCost({ jobId: "j", snapshotSavings: { baselineTokens: 1, sentTokens: 1, summary: "saved about 7,800 tokens" } })).toEqual({ jobId: "j" });
    });
});

describe("the membership migration", () => {
    it("adds the Project Admin flag, Crowd4Test accounts and organizations, and keeps a flag when the People screen re-saves", () => {
        const db = new Db(path.join(tmp(), "m.db"));
        try {
            const cols = (t: string) => db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
            expect(cols("user_projects")).toEqual(expect.arrayContaining(["project_admin", "source", "added_by"]));
            expect(cols("users")).toEqual(expect.arrayContaining(["c4t_role", "organization_id"]));
            expect(cols("projects")).toContain("organization_id");
            expect(cols("organizations")).toEqual(["id", "name", "status", "synced_at"]);
            db.run("INSERT INTO users (id, email, name, role, created_at) VALUES ('u1','u@x.example','U','editor','2020-01-01T00:00:00Z')");
            db.run("INSERT INTO users (id, email, name, created_at) VALUES ('builtin','admin@localhost','Default user','2020-01-01T00:00:00Z')");
            db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p1','builtin','P','x','x'), ('p2','builtin','Q','x','x')");
            const store = new ProjectAccessStore(db);
            store.set("u1", { mode: "only", projects: [{ projectId: "p1", role: "editor" }] });
            expect(store.member("p1", "u1")).toMatchObject({ projectAdmin: false, source: "added", kind: "local" });
            store.setProjectAdmin("p1", "u1", true);
            store.set("u1", { mode: "only", projects: [{ projectId: "p1", role: "viewer" }, { projectId: "p2", role: "viewer" }] });
            expect(store.isProjectAdmin("p1", "u1")).toBe(true);
            expect(store.isProjectAdmin("p2", "u1")).toBe(false);
            expect(store.projectAdminCount("p1")).toBe(1);
            store.setMode("u1", "all");
            expect(store.accessOf("u1")).toEqual({ mode: "all" });
            expect(store.members("p1")).toHaveLength(1);
            store.setProjectOrganization("p1", "org-1");
            expect(store.projectOrganization("p1")).toBe("org-1");
            expect(store.organization("org-1")).toMatchObject({ id: "org-1", name: null });
        } finally {
            db.close();
        }
    });
});
