/**
 * People and access, the parts that need no network: password hashing, sign-in throttling, the user store (sessions, tokens,
 * invite links, activity), the actor of audit writes, and the route-to-role table checked against every route the server
 * really registers (a route that is missing from the table fails here: map it in src/platform/auth/roles.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { actorLabel, atLeast, currentActor, lowerRole, runAs } from "../src/platform/auth/actor.js";
import { registeredRoutes } from "../src/platform/auth/access.js";
import { FAILS_BEFORE_LOCK, IP_LIMIT, SignInLimiter } from "../src/platform/auth/limiter.js";
import { hashPassword, passwordProblem, verifyPassword } from "../src/platform/auth/password.js";
import { ROUTE_ROLES, ruleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CustomScriptStore } from "../src/platform/custom-script-store.js";
import { Db } from "../src/platform/db.js";
import { buildServer } from "../src/platform/server.js";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, TOKEN_PREFIX, UserStore } from "../src/platform/user-store.js";

const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-usr-unit-"));
    dirs.push(d);
    return d;
};
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("passwords", () => {
    it("hashes with scrypt and a salt, and verifies only the right password", async () => {
        const a = await hashPassword("correct horse battery");
        const b = await hashPassword("correct horse battery");
        expect(a).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
        expect(a).not.toBe(b);
        expect(await verifyPassword("correct horse battery", a)).toBe(true);
        expect(await verifyPassword("correct horse batterY", a)).toBe(false);
        expect(await verifyPassword("anything", null)).toBe(false);
        expect(await verifyPassword("anything", "scrypt$99999999$8$1$x$y")).toBe(false);
        expect(await verifyPassword("anything", "plain-text")).toBe(false);
    });

    it("says in words what is wrong with a weak password", () => {
        expect(passwordProblem("short")).toMatch(/at least 10/);
        expect(passwordProblem("a@example.com", "a@example.com")).toMatch(/at least 10|email/);
        expect(passwordProblem("person@example.com", "Person@Example.com")).toMatch(/not be the email/);
        expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/one character repeated/);
        expect(passwordProblem("x".repeat(201))).toMatch(/at most 200/);
        expect(passwordProblem("a long enough passphrase")).toBeUndefined();
    });
});

describe("sign-in throttling", () => {
    it("locks an email after repeated wrong passwords, known or not, and lets it go after the lock", () => {
        let t = 1_000_000;
        const l = new SignInLimiter(() => t);
        for (let i = 1; i < FAILS_BEFORE_LOCK; i++) expect(l.failed("x@example.com")).toBe(false);
        expect(l.failed("x@example.com")).toBe(true);
        expect(l.locked("x@example.com")).toBe(15);
        expect(l.locked("other@example.com")).toBe(0);
        t += 15 * 60_000 + 1;
        expect(l.locked("x@example.com")).toBe(0);
        l.failed("x@example.com");
        l.succeeded("x@example.com");
        expect(l.locked("x@example.com")).toBe(0);
    });

    it("limits attempts per address in a window", () => {
        let t = 0;
        const l = new SignInLimiter(() => t);
        for (let i = 0; i < IP_LIMIT; i++) expect(l.hit("10.0.0.1")).toBe(0);
        expect(l.hit("10.0.0.1")).toBeGreaterThan(0);
        expect(l.hit("10.0.0.2")).toBe(0);
        t += 10 * 60_000 + 1;
        expect(l.hit("10.0.0.1")).toBe(0);
    });
});

describe("roles and actors", () => {
    it("orders roles and never lets a token exceed its person", () => {
        expect(atLeast("owner", "editor")).toBe(true);
        expect(atLeast("viewer", "editor")).toBe(false);
        expect(lowerRole("owner", "viewer")).toBe("viewer");
        expect(lowerRole("editor", "owner")).toBe("editor");
    });

    it("gives background work the Platform actor and requests their own", async () => {
        expect(currentActor().kind).toBe("system");
        const seen = await runAs({ kind: "user", id: "u1", name: "Ana", role: "editor" }, async () => {
            await new Promise((r) => setTimeout(r, 5));
            return actorLabel();
        });
        expect(seen).toBe("Ana (u1)");
        expect(actorLabel()).toBe("Platform");
    });

    it("HEAD follows GET in the table; unknown routes have no rule (the hook then needs an owner)", () => {
        expect(ruleFor("HEAD", "/api/projects")).toBe("viewer");
        expect(ruleFor("GET", "/api/no-such-route")).toBeUndefined();
        for (const [k, v] of Object.entries(ROUTE_ROLES)) {
            expect(k).toMatch(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS) \S+$/);
            expect(["owner", "editor", "viewer", "public", "own"]).toContain(v);
        }
    });
});

describe("user store", () => {
    let db: Db;
    let users: UserStore;
    beforeAll(() => {
        db = new Db(path.join(tmp(), "t.db"));
        users = new UserStore(db);
        // The built-in project owner row (not a person).
        db.run("INSERT INTO users (id, email, name, created_at) VALUES ('builtin','admin@localhost','Default user','2020-01-01T00:00:00Z')");
    });
    afterAll(() => db.close());

    it("counts only people (rows with a role), and keeps the built-in row out of the list", () => {
        expect(users.peopleCount()).toBe(0);
        const p = users.create({ email: " Ana@Example.com ", name: "Ana", role: "owner" });
        expect(p.email).toBe("ana@example.com");
        expect(users.peopleCount()).toBe(1);
        expect(users.list().map((x) => x.email)).toEqual(["ana@example.com"]);
        expect(users.emailTakenByBuiltIn("ADMIN@localhost")).toBe(true);
        expect(users.byEmail("ana@EXAMPLE.com")?.id).toBe(p.id);
        expect(users.activeOwners()).toBe(1);
    });

    it("stores sessions by hash and ends them after 12 idle hours or 7 days", () => {
        const ana = users.byEmail("ana@example.com")!;
        const { token, session } = users.createSession(ana.id, "password");
        expect(db.get("SELECT * FROM user_sessions WHERE id = ?", token)).toBeUndefined(); // only the hash is stored
        expect(users.sessionFor(token)?.userId).toBe(ana.id);
        expect(users.sessionFor(token, session.lastSeenAt + SESSION_IDLE_MS + 1)).toBeUndefined();
        const two = users.createSession(ana.id, "password");
        db.run("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?", Date.now() + SESSION_ABSOLUTE_MS, two.session.id);
        expect(users.sessionFor(two.token, two.session.createdAt + SESSION_ABSOLUTE_MS + 1)).toBeUndefined();
        const three = users.createSession(ana.id, "password");
        const four = users.createSession(ana.id, "password");
        expect(users.endAllSessions(ana.id, four.session.id)).toBe(1);
        expect(users.sessionFor(three.token)).toBeUndefined();
        expect(users.sessionFor(four.token)).toBeDefined();
    });

    it("makes personal tokens that are shown once, stored hashed, and expire", () => {
        const ana = users.byEmail("ana@example.com")!;
        const made = users.createToken(ana.id, { name: "CI", role: "viewer", expiresInDays: 1 });
        expect(made.token.startsWith(TOKEN_PREFIX)).toBe(true);
        expect(made.info).toMatchObject({ name: "CI", role: "viewer", hint: made.token.slice(-4) });
        expect(JSON.stringify(users.tokens(ana.id))).not.toContain(made.token);
        expect(users.tokenFor(made.token)).toMatchObject({ userId: ana.id, role: "viewer" });
        expect(users.tokenFor(`${TOKEN_PREFIX}nope`)).toBeUndefined();
        db.run("UPDATE user_tokens SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), made.info.id);
        expect(users.tokenFor(made.token)).toBeUndefined();
        expect(users.removeToken("someone-else", made.info.id)).toBe(false);
        expect(users.removeToken(ana.id, made.info.id)).toBe(true);
    });

    it("invite links work once, and a new link replaces the old one", () => {
        const ben = users.create({ email: "ben@example.com", name: "Ben", role: "viewer" });
        const first = users.createInvite(ben.id, "invite");
        expect(users.get(ben.id)?.invitePending).toBe(true);
        const second = users.createInvite(ben.id, "invite");
        expect(users.inviteFor(first.token)).toBeUndefined();
        expect(users.inviteFor(second.token)).toEqual({ userId: ben.id, purpose: "invite" });
        users.useInvite(second.token);
        expect(users.inviteFor(second.token)).toBeUndefined();
    });

    it("filters activity and keeps it capped", () => {
        for (let i = 0; i < 30; i++) users.addActivity({ actorKind: i % 2 ? "key" : "user", actorId: i % 2 ? null : "u1", actorName: i % 2 ? "Access key" : "Ana", action: `POST /api/projects/:id/thing-${i}`, projectId: i < 10 ? "p1" : "p2", status: 200 });
        expect(users.activity({ actorKind: "key", limit: 200 })).toHaveLength(15);
        expect(users.activity({ projectId: "p1", limit: 200 })).toHaveLength(10);
        expect(users.activity({ action: "thing-2", limit: 200 }).map((a) => a.action)).toContain("POST /api/projects/:id/thing-2");
        expect(users.activity({ action: "%", limit: 200 })).toHaveLength(0); // a LIKE wildcard in the filter is just a character
        const page1 = users.activity({ limit: 5 });
        const page2 = users.activity({ limit: 5, before: page1[4]!.id });
        expect(page2[0]!.id).toBeLessThan(page1[4]!.id);
        users.pruneActivity(12, 180);
        expect(users.activity({ limit: 200 })).toHaveLength(12);
        db.run("UPDATE activity SET at = '2000-01-01T00:00:00.000Z' WHERE id IN (SELECT id FROM activity ORDER BY id LIMIT 2)");
        users.pruneActivity(1000, 180);
        expect(users.activity({ limit: 200 })).toHaveLength(10);
    });

    it("records the acting person in the older audit tables", () => {
        db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p1','builtin','P','x','x')");
        const custom = new CustomScriptStore(db);
        runAs({ kind: "user", id: "u9", name: "Cleo", role: "editor" }, () => custom.audit("p1", null, "helper", "util added"));
        custom.audit("p1", null, "helper", "util changed");
        expect(db.all("SELECT actor FROM custom_audit ORDER BY id").map((r) => r.actor)).toEqual(["Cleo (u9)", "Platform"]);
        for (const t of ["custom_audit", "release_audit", "live_session_audit"]) expect(db.all(`PRAGMA table_info(${t})`).map((c) => c.name)).toContain("actor");
    });
});

describe("the route-to-role table covers every registered route", () => {
    let platform: Platform;
    let routes: Array<{ method: string; url: string }>;
    beforeAll(async () => {
        platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", API_KEY: "unit-key-0123456789" }));
        const app = await buildServer(platform);
        await app.ready();
        routes = registeredRoutes(app);
        await app.close();
    }, 60_000);
    afterAll(() => platform?.db.close());

    it("has a rule for each route (add new routes to src/platform/auth/roles.ts)", () => {
        expect(routes.length).toBeGreaterThan(200);
        const missing = [...new Set(routes.filter((r) => r.method !== "HEAD" && ruleFor(r.method, r.url) === undefined).map((r) => `${r.method} ${r.url}`))].sort();
        expect(missing, `Routes without a role in src/platform/auth/roles.ts:\n${missing.join("\n")}`).toEqual([]);
    });

    it("keeps people, activity and single sign-on for owners, and the protocol routes on their own credentials", () => {
        for (const r of routes.filter((x) => /^\/api\/(users|activity|sso-settings)/.test(x.url) && x.method !== "HEAD")) expect(ruleFor(r.method, r.url), `${r.method} ${r.url}`).toBe("owner");
        for (const r of routes.filter((x) => x.url.startsWith("/api/agent/") && x.method !== "HEAD")) expect(ruleFor(r.method, r.url), `${r.method} ${r.url}`).toBe("own");
        // Reading never needs more than a viewer, except owner-only records (people, activity, SSO, runner tokens, whole-project backups,
        // and since round 25 a project's members, which need ai_studio.project.members: owners only on a local install).
        const ownerReads = routes.filter((r) => r.method === "GET" && ruleFor("GET", r.url) === "owner").map((r) => r.url).sort();
        expect(ownerReads).toEqual(["/api/activity", "/api/projects/:id/agent-tokens", "/api/projects/:id/backup", "/api/projects/:id/members", "/api/projects/:id/members/candidates", "/api/sso-settings", "/api/users"]);
    });
});
