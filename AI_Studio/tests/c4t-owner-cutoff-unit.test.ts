/**
 * A person cut off on Crowd4Test stops receiving runs (round 47): what their latest arrival said is kept (ownerMayRun), and a schedule or
 * deploy trigger that runs in their name asks Crowd4Test first, refusing with a sentence when it cannot answer. Also: a person's runner
 * switches change on every live credential they have. A stand-in Crowd4Test service on port 8880; nothing else is called.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { personFor, type C4tUser } from "../src/platform/auth/crowd4test.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { assertC4tOwnerMayRun, OWNER_MAY_NOT_RUN, OWNER_NOT_ACTIVE, OWNER_UNCONFIRMED } from "../src/platform/c4t-service.js";
import { ProjectAccessStore } from "../src/platform/project-access-store.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { UserStore } from "../src/platform/user-store.js";

const PORT = 8880;
/** Who the stand-in's people search answers as active, by email; "down@…" makes it fail. */
const active = new Set<string>();
let server: http.Server;
let platform: Platform;
let tmp = "";
let projectId = "";

const account = (id: string, over: Partial<C4tUser> = {}): C4tUser => ({ id, email: `${id}@people.example`, role: "TESTER", status: "ACTIVE", firstName: id, lastName: null, emailVerified: true, permissions: [...PERMISSIONS], organisationId: null, ...over });
const arrive = (u: C4tUser) => personFor(new UserStore(platform.db), new ProjectAccessStore(platform.db), u);
const idOf = (c4tId: string) => platform.db.get<{ id: string }>("SELECT id FROM users WHERE sso_subject = ?", `crowd4test:${c4tId}`)!.id;
const mayRun = (c4tId: string) => getAgentServices(platform).store.ownerMayRun(idOf(c4tId), projectId);
const member = (c4tId: string) => platform.db.run("INSERT INTO user_projects (user_id, project_id, role, created_at) VALUES (?,?,?,?)", idOf(c4tId), projectId, "editor", new Date().toISOString());

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const q = new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "";
        if (q.startsWith("down")) return res.writeHead(500).end();
        const id = q.split("@")[0]!;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: active.has(q) ? [{ id, name: id, email: q, kind: "TESTER", organisationId: null }] : [] }));
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cutoff-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: tmp, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "cutoff-unit-secret-key-0123456789abc", C4T_API_ORIGIN: `http://127.0.0.1:${PORT}`, C4T_SITE_URL: "http://site.example", C4T_SERVICE_TOKEN: "t".repeat(40) }),
    );
    projectId = platform.repo.createProject({ name: "Shop" }).id as string;
});

afterAll(async () => {
    platform?.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
});

describe("ownerMayRun for a Crowd4Test account", () => {
    it("follows ai_studio.tests.run as of the latest arrival", () => {
        arrive(account("ria"));
        member("ria");
        expect(mayRun("ria")).toBe(true);
        arrive(account("ria", { permissions: PERMISSIONS.filter((c) => c !== "ai_studio.tests.run") }));
        expect(mayRun("ria")).toBe(false);
        arrive(account("ria"));
        expect(mayRun("ria")).toBe(true);
    });

    it("stops when Crowd4Test says the account is not active or has no AI Studio, and starts again once it is let in", () => {
        arrive(account("sam"));
        member("sam");
        expect(mayRun("sam")).toBe(true);
        expect(arrive(account("sam", { status: "SUSPENDED" }))).toEqual({ refused: "Your Crowd4Test account is not active." });
        expect(mayRun("sam")).toBe(false);
        arrive(account("sam"));
        expect(mayRun("sam")).toBe(true);
        expect(arrive(account("sam", { permissions: [] }))).toMatchObject({ refused: expect.stringMatching(/access to AI Studio/) });
        expect(mayRun("sam")).toBe(false);
        // Let in again on Crowd4Test: nothing to undo here.
        expect(arrive(account("sam"))).toMatchObject({ person: { status: "active" } });
        expect(mayRun("sam")).toBe(true);
    });
});

describe("before a schedule or trigger runs in a Crowd4Test account's name", () => {
    it("asks Crowd4Test: active runs, gone or unanswered is refused with a sentence", async () => {
        for (const id of ["ann", "bob", "down"]) arrive(account(id));
        active.add("ann@people.example");
        await expect(assertC4tOwnerMayRun(platform, idOf("ann"))).resolves.toBeUndefined();
        await expect(assertC4tOwnerMayRun(platform, idOf("bob"))).rejects.toThrow(OWNER_NOT_ACTIVE);
        await expect(assertC4tOwnerMayRun(platform, idOf("down"))).rejects.toThrow(OWNER_UNCONFIRMED);
        arrive(account("ann", { permissions: ["ai_studio.access"] }));
        await expect(assertC4tOwnerMayRun(platform, idOf("ann"))).rejects.toThrow(OWNER_MAY_NOT_RUN);
        // Not a Crowd4Test account, or nobody: nothing to ask.
        await expect(assertC4tOwnerMayRun(platform, null)).resolves.toBeUndefined();
    });

    it("a due schedule of a person Crowd4Test no longer has is not started, and says why", async () => {
        arrive(account("cat"));
        const svc = getScheduleServices(platform);
        const s = svc.store.create({ projectId, name: "Nightly", kind: "validate", cadence: { type: "daily", time: "02:00" }, createdBy: idOf("cat") });
        platform.db.run("UPDATE schedules SET next_run_at = ? WHERE id = ?", Date.now() - 1000, s.id);
        const [r] = await svc.scheduler.tick();
        expect(r).toMatchObject({ scheduleId: s.id, result: "error", note: OWNER_NOT_ACTIVE });
        expect(svc.store.get(s.id)).toMatchObject({ lastOutcome: "error", lastNote: OWNER_NOT_ACTIVE });
    });
});

describe("runner switches", () => {
    it("change on every live computer of the person, not only one", () => {
        const store = getAgentServices(platform).store;
        const a = store.createPersonalToken({ ownerId: "u-two", label: "Laptop", createdBy: "test" }).record;
        const b = store.createPersonalToken({ ownerId: "u-two", label: "Desktop", createdBy: "test" }).record;
        const other = store.createPersonalToken({ ownerId: "u-else", label: "Theirs", createdBy: "test" }).record;
        // One per person: the second replaced the first.
        expect(store.getToken(a.id)).toBeUndefined();
        expect(store.setTokenSwitches(b.id, { allowCodeScripts: false, allowRealPhone: true })).toBe(true);
        expect(store.getToken(b.id)).toMatchObject({ allowCodeScripts: false, allowRealPhone: true });
        expect(store.getToken(other.id)).toMatchObject({ allowCodeScripts: true, allowRealPhone: false });
        // A removed credential changes nothing.
        expect(store.setTokenSwitches(a.id, { allowCodeScripts: true })).toBe(false);
        expect(store.getToken(b.id)).toMatchObject({ allowCodeScripts: false });
    });
});
