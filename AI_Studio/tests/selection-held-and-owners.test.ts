/**
 * Test-selection preview, held tests and test owners, against a real platform (no browser, no worker, no AI): (1) API tests count as covered only with a
 * fresh passing run; (2) a test a run would hold back because a shared part it uses changed after its approval is found read-only and
 * listed as "Cannot run" (or, when the policy approves it again at once, its older run is out of date); (3) a deploy token whose maker
 * Crowd4Test no longer has active goes through the trigger's own check and requires a full run. A stand-in Crowd4Test service answers on
 * 127.0.0.1:9655; nothing else is called. Automatic selection stays off: nothing here runs or skips a test.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { personFor, type C4tUser } from "../src/platform/auth/crowd4test.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { BlockStore } from "../src/platform/block-store.js";
import { ProjectAccessStore } from "../src/platform/project-access-store.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { buildServer } from "../src/platform/server.js";
import { UserStore } from "../src/platform/user-store.js";

const API_KEY = "selection-held-key-0123456789";
const C4T_PORT = 9655;
const APP = "http://127.0.0.1:9656";
/** Who the stand-in's people search answers as active, by email; "down@…" makes it fail. */
const active = new Set<string>();

let c4t: http.Server;
let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let projectId: string;

const send = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: { "x-api-key": API_KEY } });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body };
};
const preview = async (body: unknown) => {
    const res = await send("POST", `/api/projects/${projectId}/selection-preview`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
};
const ago = (days: number, minute = 600): string => {
    const d = new Date(Date.now() - days * 86_400_000);
    d.setUTCHours(0, minute, 0, 0);
    return d.toISOString();
};
async function importSpec(spec: unknown): Promise<string> {
    const title = (spec as { title: string }).title;
    const res = await send("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [spec] });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    return platform.repo.listTests(projectId).find((t) => t.title === title)!.id;
}
/** A finished run on the deploy target, of the latest approved version (an API test's run keeps no record). */
function recordRun(testId: string, status: string, startedAt: string): void {
    const scriptId = (platform.repo.getCurrentScript(testId) as { id: string } | undefined)?.id ?? null;
    const execId = platform.repo.addExecution({ testId, scriptId, jobId: null, attempt: 1, status, durationMs: 500, startedAt, steps: [] });
    platform.db.run("UPDATE test_executions SET test_version_id = (SELECT id FROM test_versions WHERE test_case_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1) WHERE id = ?", testId, execId);
}
const byTitle = (list: Array<{ title: string }>, title: string) => list.find((t) => t.title === title) as { why?: string } | undefined;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    c4t = http.createServer((req, res) => {
        const q = new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "";
        if (q.startsWith("down")) return res.writeHead(500).end();
        const id = q.split("@")[0]!;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: active.has(q) ? [{ id, name: id, email: q, kind: "TESTER", organisationId: null }] : [] }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-selection-held-"));
    platform = bootstrap(
        loadConfig({
            DATA_DIR: dataDir,
            SCHEDULER_ENABLED: "false",
            WORKER_EMBEDDED: "false",
            API_KEY,
            SECRET_KEY: "selection-held-secret-key-0123456789",
            C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`,
            C4T_SITE_URL: "http://site.example",
            C4T_SERVICE_TOKEN: "t".repeat(40),
        }),
    );
    server = await buildServer(platform);
    projectId = (await send("POST", "/api/projects", { name: "Shop" })).body.id;
}, 60_000);

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    await new Promise((r) => c4t.close(r));
});

describe("1. API tests need a fresh passing run", () => {
    it("is unknown before any run, fully known from its steps after a failed or passing recent run, and out of date outside the window", async () => {
        const id = await importSpec({ title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] });
        const change = { endpoints: ["POST /orders"] };
        let p = await preview(change);
        expect(byTitle(p.unknown, "Health answers")?.why).toBe("Proposed because what it touches is not fully known: No run of it has been recorded yet, so what it touches is only known from its steps.");
        expect(p.fullRunRequired).toBe(true);
        recordRun(id, "failed", ago(1, 600));
        p = await preview(change);
        // A failed run of its current version: its steps are still what it calls, so it stays fully known (lead 2026-11-25).
        expect(byTitle(p.notMatched, "Health answers")?.why).toBe("Not proposed: what it touches is fully known from its steps (1 page or endpoint), and none of it is in the change.");
        recordRun(id, "passed", ago(1, 660));
        p = await preview(change);
        expect(byTitle(p.notMatched, "Health answers")?.why).toBe("Not proposed: what it touches is fully known from its steps (1 page or endpoint), and none of it is in the change.");
        expect(p.fullRunRequired).toBe(false);
        // The passing run moved outside the window (the failed one removed): out of date.
        platform.db.run("DELETE FROM test_executions WHERE test_case_id = ? AND status = 'failed'", id);
        platform.db.run("UPDATE test_executions SET started_at = ? WHERE test_case_id = ?", ago(20), id);
        p = await preview(change);
        expect(byTitle(p.unknown, "Health answers")?.why).toMatch(/is older than 14 days/);
        platform.db.run("DELETE FROM test_executions WHERE test_case_id = ?", id);
        platform.db.run("DELETE FROM test_cases WHERE id = ?", id);
    });
});

describe("2. a shared part changed after approval", () => {
    it("lists a test runs would hold back as Cannot run, read-only, and an older run as out of date when the policy approves it again", async () => {
        const blocks = new BlockStore(platform.db);
        const login = blocks.create(projectId, { name: "Log in", kind: "web", params: [], steps: [{ action: "navigate", url: "/login" }] as never });
        const id = await importSpec({ title: "Checkout", kind: "web", category: "Shop", steps: [{ action: "useBlock", block: "Log in" }, { action: "navigate", url: "/checkout" }] });
        // Imported here, it is approved at once, with the shared parts recorded as they are now; then a recent passing run.
        const reviews = new ReviewStore(platform.db);
        const v = reviews.approved(id)!;
        expect(platform.db.get("SELECT recorded FROM test_version_deps WHERE version_id = ?", v.id)).toEqual({ recorded: "approval" });
        recordRun(id, "passed", ago(1));
        let p = await preview({ pages: ["/elsewhere"] });
        expect(p.cannotRun.map((t: any) => t.title)).not.toContain("Checkout");

        // The reusable steps change outside the review (nothing drafts a version): a run would hold the test back.
        blocks.update(projectId, login.id, { name: "Log in", kind: "web", params: [], steps: [{ action: "navigate", url: "/sign-in" }] as never });
        const snapshot = () => JSON.stringify([platform.db.all("SELECT * FROM test_version_deps ORDER BY version_id"), platform.db.all("SELECT id, state FROM test_versions ORDER BY id"), platform.db.all("SELECT id FROM test_version_comments ORDER BY id")]);
        const before = snapshot();
        p = await preview({ pages: ["/checkout"] });
        expect(byTitle(p.cannotRun, "Checkout")?.why).toBe("Cannot run: the reusable steps “Log in” changed after its approval, so runs hold it back until it is approved again.");
        expect(p.matched.map((t: any) => t.title)).not.toContain("Checkout");
        // No runner runs it until it is approved again: it is not "cannot run on your runner", but a held test always makes a full run
        // required, with a reason naming it (approved policy).
        expect(p.fullRunReasons.join(" ")).not.toMatch(/cannot run on your runner/);
        expect(p.fullRunRequired).toBe(true);
        expect(p.fullRunReasons).toContain(
            `1 test is held back because a shared part it uses changed after its approval, so runs leave it out until approved again and the deploy tests less than the project has: ${p.cannotRun.find((t: any) => t.title === "Checkout").testKey} “Checkout” (the reusable steps “Log in” changed after its approval, so runs hold it back until it is approved again).`,
        );
        // Read-only: no dependency record, version or comment was written.
        expect(snapshot()).toBe(before);

        // A project whose policy approves such changes at once: the test runs at the next run, so it is not held; its latest run was
        // before the change, so it is out of date.
        reviews.setPolicy(projectId, { edits: false }, "test");
        p = await preview({ pages: ["/checkout"] });
        expect(p.cannotRun.map((t: any) => t.title)).not.toContain("Checkout");
        // Proposed: its declared /checkout matches, and its coverage is out of date.
        expect(p.matched.map((t: any) => t.title)).toContain("Checkout");
        const cov = ((await send("GET", `/api/projects/${projectId}/test-coverage`)).body.tests as any[]).find((t) => t.title === "Checkout");
        expect(cov.stale).toBe(`The reusable steps “Log in” changed after its latest run (${ago(1).slice(0, 10)}), and no run on the deploy target has used the change yet.`);
        expect(p.fullRunReasons.join(" ")).toMatch(/recorded coverage is out of date/);
        expect(snapshot()).toBe(before);

        // The preview agrees with the run's own check (which writes: done last, after the read-only checks).
        reviews.setPolicy(projectId, { edits: true }, "test");
        expect(reviews.toRun(id).held).toBe("A shared step it uses changed after approval; approve it again to run it. Changed: the reusable steps “Log in”.");
    });
});

describe("3. a deploy token whose maker Crowd4Test no longer has", () => {
    const account = (id: string): C4tUser => ({ id, email: `${id}@people.example`, role: "TESTER", status: "ACTIVE", firstName: id, lastName: null, emailVerified: true, permissions: [...PERMISSIONS], organisationId: null });
    const idOf = (c4tId: string) => platform.db.get<{ id: string }>("SELECT id FROM users WHERE sso_subject = ?", `crowd4test:${c4tId}`)!.id;
    const addToken = (id: string, label: string, createdBy: string) =>
        platform.db.run("INSERT INTO trigger_tokens (id, project_id, label, token_hash, hint, allow_url, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)", id, projectId, label, `hash-${id}`, id.slice(-4), 0, new Date().toISOString(), createdBy);

    it("goes through the trigger's own check: gone, unanswered or not allowed to run is unresolved and requires a full run", async () => {
        const jobs = platform.db.all("SELECT id FROM generation_jobs").length;
        for (const id of ["ann", "bob", "down"]) personFor(new UserStore(platform.db), new ProjectAccessStore(platform.db), account(id));
        active.add("ann@people.example");
        addToken("tok-ann1", "Ann's CI", idOf("ann"));
        addToken("tok-bob1", "Bob's CI", idOf("bob"));
        addToken("tok-down", "Unanswered", idOf("down"));
        const p = await preview({ pages: ["/checkout"] });
        const why = Object.fromEntries((p.triggers as Array<{ trigger: string; why?: string }>).map((t) => [t.trigger, t.why]));
        // Ann is still active there: her token is compared as before (no Crowd4Test words).
        expect(why["“Ann's CI” (…ann1)"] ?? "").not.toMatch(/Crowd4Test/);
        expect(p.fullRunReasons).toContain("The deploy trigger “Bob's CI” (…bob1) cannot be compared with your runner: Crowd4Test says the person who made it no longer has an active account, so its runs do not start.");
        expect(p.fullRunReasons).toContain("The deploy trigger “Unanswered” (…down) cannot be compared with your runner: Crowd4Test could not confirm that the person who made it may still run tests, so whether its runs start is not known.");
        expect(p.fullRunRequired).toBe(true);

        // Ann may no longer run tests (her latest arrival said so): the trigger would refuse, and so the preview says.
        platform.db.run("UPDATE users SET c4t_runs_tests = 0 WHERE id = ?", idOf("ann"));
        const q = await preview({ pages: ["/checkout"] });
        expect(q.fullRunReasons).toContain("The deploy trigger “Ann's CI” (…ann1) cannot be compared with your runner: Crowd4Test says the person who made it may no longer run tests, so its runs do not start.");
        // Nothing was started.
        expect(platform.db.all("SELECT id FROM generation_jobs").length).toBe(jobs);
    });
});
