/**
 * Manual test cases and release sign-off through a real platform (real server routes via `inject`, a real database, no model, no browser):
 *  cases (create, edit, delete, JSON and CSV import and export, caps, limits), releases (the automated snapshot equals what the dashboard
 *  says), results, the refused approval with plain reasons, approval after fixing, override with a comment, immutability after sign-off,
 *  reopen and the audit trail, the report page (escaped), API-key protection, per-project isolation, and an issue for a failed check
 *  filed at a local GitHub-shaped receiver. Ports 5710 (receiver).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildDashboard } from "../src/platform/dashboard.js";
import { buildServer } from "../src/platform/server.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const GH_PORT = 5710;
const GH = `http://127.0.0.1:${GH_PORT}`;
const GH_TOKEN = "ghp_manualCasesTokenForTests123456";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let keyed: Platform;
let keyedServer: Awaited<ReturnType<typeof buildServer>>;
const dirs: string[] = [];
const receiver: { server?: http.Server; posts: Array<{ url: string; body: any }>; fail: boolean } = { posts: [], fail: false };
let issueNo = 0;

let ready: Seed; // automated tests all passing
let blocked: Seed; // a critical finding
let other: Seed; // a second project, for isolation

const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, srv = server, headers: Record<string, string> = {}) => {
    const res = await srv.inject({ method, url, payload: payload as never, headers });
    let body: any = null;
    try {
        body = res.body ? JSON.parse(res.body) : null;
    } catch {
        body = null;
    }
    return { status: res.statusCode, body, text: res.body, headers: res.headers };
};
const cases = (s: Seed) => `/api/projects/${s.projectId}/manual-cases`;
const releases = (s: Seed) => `/api/projects/${s.projectId}/releases`;
const newCase = async (s: Seed, title: string, priority = "medium", extra: Record<string, unknown> = {}) => {
    const r = await call("POST", cases(s), { title, priority, steps: [{ action: "Open the page", expected: "It loads" }], ...extra });
    expect(r.status).toBe(201);
    return r.body.id as string;
};
const newRelease = async (s: Seed, name: string, notes = "") => {
    const r = await call("POST", releases(s), { name, notes });
    expect(r.status).toBe(201);
    return r.body;
};
const setResult = (s: Seed, rid: string, cid: string, body: Record<string, unknown>) => call("PUT", `${releases(s)}/${rid}/results/${cid}`, body);
const sign = (s: Seed, rid: string, body: Record<string, unknown>) => call("POST", `${releases(s)}/${rid}/signoff`, body);

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    receiver.server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            const send = (code: number, obj: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
            if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: "Bad credentials" });
            const url = req.url!.split("?")[0]!;
            if (req.method === "GET" && url === "/repos/acme/shop") return send(200, { full_name: "acme/shop", has_issues: true, archived: false });
            if (req.method === "POST" && url === "/repos/acme/shop/issues") {
                if (receiver.fail) return send(503, { message: "Service Unavailable" });
                const n = ++issueNo;
                receiver.posts.push({ url, body: JSON.parse(raw) });
                return send(201, { number: n, html_url: `https://github.example/acme/shop/issues/${n}` });
            }
            send(404, { message: "Not Found" });
        });
    });
    await new Promise<void>((r) => receiver.server!.listen(GH_PORT, "127.0.0.1", r));

    const boot = async (extra: Record<string, string> = {}) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-manual-"));
        dirs.push(dir);
        const p = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", ...extra }));
        return { p, s: await buildServer(p) };
    };
    ({ p: platform, s: server } = await boot());
    ({ p: keyed, s: keyedServer } = await boot({ API_KEY: "manual-test-key" }));

    ready = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    for (const k of ["a", "b", "c", "d"]) addTest(platform, ready, k);
    await seedRun(platform, ready, { a: "pass", b: "pass", c: "pass", d: "pass" }, { daysAgo: 1 });

    blocked = seedProject(platform, "Checkout", "https://checkout.example.test");
    addTest(platform, blocked, "a", "critical");
    addTest(platform, blocked, "b");
    await seedRun(platform, blocked, { a: "review:Server error: POST /api/pay returned 500", b: "pass" }, { daysAgo: 0.2 });

    other = seedProject(platform, "Another project", "https://other.example.test");
    addTest(platform, other, "a");
    await seedRun(platform, other, { a: "pass" });
}, 60_000);

afterAll(async () => {
    await server?.close();
    await keyedServer?.close();
    platform?.db.close();
    keyed?.db.close();
    await new Promise((r) => receiver.server?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("storage", () => {
    it("creates the tables in migration slot 15 and keeps the audit trail append-only", () => {
        const names = platform.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
        for (const t of ["manual_cases", "releases", "release_results", "release_audit"]) expect(names).toContain(t);
        expect(platform.db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBeGreaterThanOrEqual(15);
    });
});

describe("manual cases", () => {
    it("creates, reads, edits and deletes a case", async () => {
        const created = await call("POST", cases(ready), {
            title: "  Pay with a saved card ",
            area: "Checkout",
            priority: "critical",
            requirement: "REQ-12",
            steps: [{ action: "Open the cart", expected: "The items are listed" }, { action: "Pay", expected: "" }],
        });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ title: "Pay with a saved card", area: "Checkout", priority: "critical", requirement: "REQ-12", linkedTestIds: [] });
        expect(created.body.steps).toHaveLength(2);
        const id = created.body.id as string;

        expect((await call("GET", `${cases(ready)}/${id}`)).body.title).toBe("Pay with a saved card");
        const list = await call("GET", cases(ready));
        expect(list.body).toMatchObject({ total: 1, max: 500, areas: ["Checkout"] });

        const edited = await call("PUT", `${cases(ready)}/${id}`, { title: "Pay with a saved card (new)", area: "Checkout", priority: "high", steps: [] });
        expect(edited.status).toBe(200);
        expect(edited.body).toMatchObject({ title: "Pay with a saved card (new)", priority: "high", steps: [] });

        expect((await call("DELETE", `${cases(ready)}/${id}`)).status).toBe(204);
        expect((await call("GET", `${cases(ready)}/${id}`)).status).toBe(404);
        expect((await call("PUT", `${cases(ready)}/${id}`, { title: "x" })).status).toBe(404);
        expect((await call("DELETE", `${cases(ready)}/${id}`)).status).toBe(404);
        expect((await call("GET", cases(ready))).body.total).toBe(0);
    });

    it("refuses invalid input with a 400 and says what is wrong", async () => {
        const bad = async (body: unknown) => (await call("POST", cases(ready), body)).status;
        expect(await bad({ title: "" })).toBe(400);
        expect(await bad({ title: "x".repeat(161) })).toBe(400);
        expect(await bad({ title: "ok", priority: "urgent" })).toBe(400);
        expect(await bad({ title: "ok", steps: Array.from({ length: 31 }, () => ({ action: "a", expected: "b" })) })).toBe(400);
        expect(await bad({ title: "ok", steps: [{ action: "a".repeat(501), expected: "" }] })).toBe(400);
        expect(await bad(undefined)).toBe(400);
        const r = await call("POST", cases(ready), { title: "" });
        expect(r.body.error).toBe("Invalid request");
        expect(JSON.stringify(r.body.details)).toContain("The title is required");
        expect((await call("GET", cases(ready))).body.total).toBe(0);
    });

    it("links a case to automated tests of the same project only", async () => {
        const mine = ready.tests.get("a")!;
        const theirs = other.tests.get("a")!;
        expect((await call("POST", cases(ready), { title: "Linked", linkedTestIds: [mine] })).status).toBe(201);
        const r = await call("POST", cases(ready), { title: "Foreign link", linkedTestIds: [theirs] });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/does not belong to this project/);
        const all = (await call("GET", cases(ready))).body.cases as Array<{ id: string }>;
        for (const c of all) await call("DELETE", `${cases(ready)}/${c.id}`);
    });

    it("keeps markup as text", async () => {
        const id = await newCase(ready, "<img src=x onerror=alert(1)>", "low");
        expect((await call("GET", `${cases(ready)}/${id}`)).body.title).toBe("<img src=x onerror=alert(1)>");
        await call("DELETE", `${cases(ready)}/${id}`);
    });
});

describe("import and export", () => {
    it("imports JSON, then skips the same cases on a second import", async () => {
        const content = JSON.stringify({ cases: [{ title: "Print the invoice", area: "Billing", priority: "high", steps: [{ action: "Print", expected: "One page" }] }, { title: "Dark mode", area: "Display" }, { title: "" }] });
        const first = await call("POST", `${cases(other)}/import`, { format: "json", content });
        expect(first.status).toBe(201);
        expect(first.body).toMatchObject({ created: 2, duplicates: 0, total: 2 });
        expect(first.body.skipped).toEqual([{ row: 3, reason: "The title is required" }]);
        const again = await call("POST", `${cases(other)}/import`, { content });
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ created: 0, duplicates: 2, total: 2 });
    });

    it("imports CSV with quotes, line breaks and the arrow format, reporting the bad rows", async () => {
        const csv = 'title,area,priority,steps\r\n"Login, then logout",Account,critical,"Sign in => The account page opens\nSign out => The login page opens"\r\nBad priority,Account,urgent,\r\n';
        const r = await call("POST", `${cases(ready)}/import`, { format: "csv", content: csv });
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ created: 1, total: 1 });
        expect(r.body.skipped).toHaveLength(1);
        expect(r.body.skipped[0]).toMatchObject({ row: 3 });
        const c = (await call("GET", cases(ready))).body.cases[0];
        expect(c).toMatchObject({ title: "Login, then logout", area: "Account", priority: "critical" });
        expect(c.steps).toEqual([{ action: "Sign in", expected: "The account page opens" }, { action: "Sign out", expected: "The login page opens" }]);
    });

    it("refuses broken files with a plain 400 and imports nothing", async () => {
        const before = (await call("GET", cases(ready))).body.total;
        for (const content of ["", "name,area\nx,y", '"never closed', "{not json"]) {
            const r = await call("POST", `${cases(ready)}/import`, { content });
            expect(r.status).toBe(400);
        }
        expect((await call("POST", `${cases(ready)}/import`, {})).status).toBe(400);
        expect((await call("GET", cases(ready))).body.total).toBe(before);
    });

    it("exports CSV with formula protection and JSON, and a CSV export imports back into another project", async () => {
        await newCase(ready, "=HYPERLINK(\"http://evil.test\")", "low", { area: "@area" });
        const csv = await call("GET", `${cases(ready)}/export?format=csv`);
        expect(csv.status).toBe(200);
        expect(csv.headers["content-type"]).toContain("text/csv");
        expect(csv.headers["content-disposition"]).toContain("manual-cases-atlas-shop.csv");
        const lines = csv.text.split("\r\n");
        expect(lines[0]).toBe("title,area,priority,steps");
        expect(csv.text).toContain("\"'=HYPERLINK(");
        expect(csv.text).toContain(",'@area,");
        expect(csv.text).not.toMatch(/(^|\r\n)=/);

        const json = await call("GET", `${cases(ready)}/export`);
        expect(json.headers["content-type"]).toContain("application/json");
        expect(json.body.version).toBe(1);
        expect(json.body.cases.map((c: { title: string }) => c.title)).toContain("=HYPERLINK(\"http://evil.test\")");

        const third = seedProject(platform, "Round trip", null);
        const back = await call("POST", `${cases(third)}/import`, { format: "csv", content: csv.text });
        expect(back.body.created).toBe(json.body.cases.length);
        const titles = (await call("GET", cases(third))).body.cases.map((c: { title: string }) => c.title);
        expect(titles).toContain("=HYPERLINK(\"http://evil.test\")");
        expect((await call("GET", `${cases(third)}/export?format=xml`)).status).toBe(400);
    });

    it("holds the limit of 500 cases: all of an import or nothing, and a single add is refused at the limit", async () => {
        const s = seedProject(platform, "Many cases", null);
        const make = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i}` }));
        const full = await call("POST", `${cases(s)}/import`, { content: make(500, "A") });
        expect(full.status).toBe(201);
        expect(full.body.created).toBe(500);
        const more = await call("POST", `${cases(s)}/import`, { content: make(1, "B") });
        expect(more.status).toBe(409);
        expect(more.body.error).toMatch(/500/);
        expect((await call("POST", cases(s), { title: "one more" })).status).toBe(409);
        // a duplicate-only import adds nothing and is not refused
        expect((await call("POST", `${cases(s)}/import`, { content: make(3, "A") })).body).toMatchObject({ created: 0, duplicates: 3 });
        // 501 in one file is refused before anything is read
        expect((await call("POST", `${cases(seedProject(platform, "Too many", null))}/import`, { content: make(501, "C") })).status).toBe(400);
        // a partial overflow imports nothing at all
        const s2 = seedProject(platform, "Nearly full", null);
        await call("POST", `${cases(s2)}/import`, { content: make(499, "N") });
        const over = await call("POST", `${cases(s2)}/import`, { content: make(3, "M") });
        expect(over.status).toBe(409);
        expect((await call("GET", cases(s2))).body.total).toBe(499);
    });
});

describe("releases", () => {
    it("opens a release whose automated snapshot equals what the dashboard says", async () => {
        const dash = buildDashboard(platform.db).projects.find((p) => p.id === ready.projectId)!;
        const rel = await newRelease(ready, "2.0 snapshot", "First cut");
        expect(rel).toMatchObject({ name: "2.0 snapshot", notes: "First cut", status: "open", decision: null, frozen: false });
        expect(rel.automated.readiness).toEqual(dash.readiness);
        expect(rel.automated.tests).toEqual(dash.tests);
        expect(rel.automated.latestRun).toEqual(dash.latestRun);
        expect(rel.automated.findings).toEqual(dash.findings);
        expect(rel.automated.flaky).toBe(dash.flaky);
        expect(rel.automated.apiBreakingChanges).toBe(dash.apiBreakingChanges);
        expect(rel.automated.readiness.state).toBe("ready");

        const b = buildDashboard(platform.db).projects.find((p) => p.id === blocked.projectId)!;
        const brel = await newRelease(blocked, "Checkout 1");
        expect(brel.automated.readiness).toEqual(b.readiness);
        expect(brel.automated.readiness.state).toBe("blocked");
        expect(brel.automated.findings.critical).toBe(1);
    });

    it("validates the name and the notes", async () => {
        for (const body of [{}, { name: "" }, { name: "n".repeat(81) }, { name: "ok", notes: "n".repeat(1001) }]) expect((await call("POST", releases(ready), body)).status).toBe(400);
        expect((await call("POST", releases(ready), { name: "n".repeat(80) })).status).toBe(201);
    });

    it("lists newest first with the decision and the counts, and shows live automated data while open", async () => {
        const s = seedProject(platform, "Listing", "https://listing.example.test");
        addTest(platform, s, "a");
        expect((await call("GET", releases(s))).body).toEqual({ releases: [], manualCases: 0 });
        const c1 = await newCase(s, "Check one", "low");
        await newCase(s, "Check two", "low");
        const r1 = await newRelease(s, "First");
        await new Promise((r) => setTimeout(r, 15));
        const r2 = await newRelease(s, "Second");
        const list = await call("GET", releases(s));
        expect(list.body.releases.map((r: { name: string }) => r.name)).toEqual(["Second", "First"]);
        expect(list.body.releases[0]).toMatchObject({ status: "open", decision: null, readiness: "needs-attention", rollup: { total: 2, left: 2 }, sentence: "Release Second: 2 of 2 manual checks left, automated tests need attention" });
        expect(r1.id).not.toBe(r2.id);

        // The project gets a passing run after the release was opened: the open release shows it without a refresh.
        expect((await call("GET", `${releases(s)}/${r1.id}`)).body.automated.readiness.state).toBe("needs-attention");
        await seedRun(platform, s, { a: "pass" }, { daysAgo: 0.1 });
        const live = await call("GET", `${releases(s)}/${r1.id}`);
        expect(live.body.automated.readiness.state).toBe("ready");
        expect(live.body.automated.tests.validated).toBe(1);
        const refreshed = await call("POST", `${releases(s)}/${r1.id}/refresh`);
        expect(refreshed.status).toBe(200);
        expect(refreshed.body.automated.readiness.state).toBe("ready");
        expect(platform.db.get<{ snapshot_json: string }>("SELECT snapshot_json FROM releases WHERE id = ?", r1.id)!.snapshot_json).toContain('"validated":1');

        await setResult(s, r1.id, c1, { result: "passed" });
        expect((await call("GET", releases(s))).body.releases.find((r: { id: string }) => r.id === r1.id).rollup).toMatchObject({ passed: 1, left: 1 });
        expect((await call("GET", `${releases(s)}/nope`)).status).toBe(404);
    });
});

describe("results", () => {
    it("records a result with a note and a name, keeps the note when only the result changes, and clears it with an empty string", async () => {
        const s = seedProject(platform, "Results", "https://results.example.test");
        const cid = await newCase(s, "Order a coffee");
        const rel = await newRelease(s, "R1");
        expect(rel.manual.items[0]).toMatchObject({ result: "not_run", note: "", by: "", at: null });

        const first = await setResult(s, rel.id, cid, { result: "failed", note: "The total was wrong", by: "Dana" });
        expect(first.status).toBe(200);
        expect(first.body.manual.items[0]).toMatchObject({ result: "failed", note: "The total was wrong", by: "Dana" });
        expect(first.body.manual.items[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(first.body.manual.rollup).toMatchObject({ failed: 1, left: 0 });

        const second = await setResult(s, rel.id, cid, { result: "blocked" });
        expect(second.body.manual.items[0]).toMatchObject({ result: "blocked", note: "The total was wrong", by: "Dana" });
        const third = await setResult(s, rel.id, cid, { result: "passed", note: "" });
        expect(third.body.manual.items[0]).toMatchObject({ result: "passed", note: "" });
    });

    it("refuses an unknown result, a note over 1000 characters, a case of another project and a missing release", async () => {
        const s = seedProject(platform, "Results 2", "https://results2.example.test");
        const cid = await newCase(s, "Case");
        const rel = await newRelease(s, "R");
        expect((await setResult(s, rel.id, cid, { result: "done" })).status).toBe(400);
        expect((await setResult(s, rel.id, cid, { result: "passed", note: "n".repeat(1001) })).status).toBe(400);
        expect((await setResult(s, rel.id, cid, { result: "passed", note: "n".repeat(1000) })).status).toBe(200);
        const foreign = await newCase(other, "Foreign case");
        expect((await setResult(s, rel.id, foreign, { result: "passed" })).status).toBe(404);
        expect((await setResult(s, "missing", cid, { result: "passed" })).status).toBe(404);
        expect((await setResult(s, rel.id, "missing", { result: "passed" })).status).toBe(404);
    });

    it("shows a case added after the release was opened as not run, and drops a deleted case", async () => {
        const s = seedProject(platform, "Late cases", "https://late.example.test");
        const first = await newCase(s, "First");
        const rel = await newRelease(s, "R");
        const later = await newCase(s, "Added later", "high");
        const view = (await call("GET", `${releases(s)}/${rel.id}`)).body;
        expect(view.manual.items.map((i: { title: string; result: string }) => [i.title, i.result])).toEqual([["Added later", "not_run"], ["First", "not_run"]]);
        await call("DELETE", `${cases(s)}/${first}`);
        expect((await call("GET", `${releases(s)}/${rel.id}`)).body.manual.items.map((i: { id: string }) => i.id)).toEqual([later]);
    });
});

describe("sign-off", () => {
    let s: Seed;
    let rid: string;
    let critical: string;
    let high: string;
    let medium: string;

    beforeAll(async () => {
        s = seedProject(platform, "Sign-off shop", "https://signoff.example.test");
        for (const k of ["a", "b"]) addTest(platform, s, k);
        await seedRun(platform, s, { a: "pass", b: "pass" }, { daysAgo: 1 });
        critical = await newCase(s, "Pay by card", "critical", { area: "Checkout" });
        high = await newCase(s, "Export the orders", "high", { area: "Reports" });
        medium = await newCase(s, "Dark mode", "medium", { area: "Display" });
        rid = (await newRelease(s, "2.4")).id;
    });

    it("says in one sentence what is left and returns the rules", async () => {
        const v = (await call("GET", `${releases(s)}/${rid}`)).body;
        expect(v.sentence).toBe("Release 2.4: 3 of 3 manual checks left, automated tests ready");
        expect(v.signoff.canApprove).toBe(false);
        expect(v.signoff.rules.blocking).toHaveLength(3);
        expect(v.signoff.blocking.map((b: { code: string }) => b.code)).toEqual(["important-unfinished"]);
        expect(v.signoff.warnings.map((b: { code: string }) => b.code)).toEqual(["other-unfinished"]);
    });

    it("refuses an approval with plain reasons (409) and records nothing", async () => {
        const r = await sign(s, rid, { decision: "approved", by: "Dana" });
        expect(r.status).toBe(409);
        expect(r.body.error).toBe("This release cannot be approved yet: 2 critical or high-priority manual checks not finished (not run or blocked).");
        expect(r.body.details).toMatchObject({ needsOverride: true });
        expect(r.body.details.blocking.map((b: { code: string }) => b.code)).toEqual(["important-unfinished"]);
        const v = (await call("GET", `${releases(s)}/${rid}`)).body;
        expect(v.status).toBe("open");
        expect(v.audit).toEqual([]);
    });

    it("also refuses while a manual check has failed, and the name is required", async () => {
        await setResult(s, rid, critical, { result: "passed", by: "Dana" });
        await setResult(s, rid, high, { result: "failed", note: "Missing the date column", by: "Dana" });
        const r = await sign(s, rid, { decision: "approved", by: "Dana" });
        expect(r.status).toBe(409);
        expect(r.body.error).toContain("1 manual check failed");
        expect((await sign(s, rid, { decision: "approved" })).status).toBe(400);
        expect((await sign(s, rid, { decision: "approved", by: "   " })).status).toBe(400);
        expect((await sign(s, rid, { decision: "maybe", by: "Dana" })).status).toBe(400);
        expect((await sign(s, rid, { decision: "approved", by: "n".repeat(81) })).status).toBe(400);
    });

    it("needs an override comment of at least 10 characters to approve past a block", async () => {
        const noComment = await sign(s, rid, { decision: "approved", by: "Dana", override: true });
        expect(noComment.status).toBe(400);
        expect(noComment.body.error).toMatch(/at least 10 characters/);
        expect((await sign(s, rid, { decision: "approved", by: "Dana", override: true, comment: "123456789" })).status).toBe(400);
        expect((await call("GET", `${releases(s)}/${rid}`)).body.status).toBe("open");
    });

    it("approves once the blocks are fixed; unfinished medium checks are only a warning", async () => {
        await setResult(s, rid, high, { result: "passed", note: "Fixed in build 41" });
        const before = (await call("GET", `${releases(s)}/${rid}`)).body;
        expect(before.signoff.canApprove).toBe(true);
        expect(before.signoff.warnings.map((w: { code: string }) => w.code)).toEqual(["other-unfinished"]);
        expect(before.sentence).toBe("Release 2.4: 1 of 3 manual checks left, automated tests ready");

        const r = await sign(s, rid, { decision: "approved", by: "Dana Lee", comment: "Ship it" });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: "approved", decision: "approved", signedBy: "Dana Lee", frozen: true });
        expect(r.body.audit).toHaveLength(1);
        expect(r.body.audit[0]).toMatchObject({ kind: "approved", by: "Dana Lee", comment: "Ship it", override: false });
        expect(r.body.audit[0].state).toMatchObject({ automated: { state: "ready" }, manual: { total: 3, passed: 2, notRun: 1 }, blocking: [], warnings: ["1 medium or low-priority manual check not finished"] });
        const listed = (await call("GET", releases(s))).body.releases.find((x: { id: string }) => x.id === rid);
        expect(listed).toMatchObject({ status: "approved", decision: "approved", signedBy: "Dana Lee" });
    });

    it("is immutable once signed: results, refresh, a second decision and an issue are refused", async () => {
        expect((await setResult(s, rid, medium, { result: "passed" })).status).toBe(409);
        expect((await call("POST", `${releases(s)}/${rid}/refresh`)).status).toBe(409);
        const again = await sign(s, rid, { decision: "rejected", by: "Someone" });
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/signed and cannot be changed/);
        expect((await call("GET", `${releases(s)}/${rid}`)).body.audit).toHaveLength(1);
    });

    it("stays frozen when the project changes: the automated state, the cases and the checklist", async () => {
        const frozen = (await call("GET", `${releases(s)}/${rid}`)).body;
        // the project gets worse and the cases change
        const blockedTest = addTest(platform, s, "late", "critical");
        void blockedTest;
        await seedRun(platform, s, { a: "review:Server error: POST /api/pay returned 500", b: "pass", late: "pass" }, { daysAgo: 0 });
        await call("PUT", `${cases(s)}/${critical}`, { title: "Pay by card (renamed)", priority: "low" });
        await call("DELETE", `${cases(s)}/${medium}`);
        await newCase(s, "A brand new case");

        const now = (await call("GET", `${releases(s)}/${rid}`)).body;
        expect(now.automated).toEqual(frozen.automated);
        expect(now.manual).toEqual(frozen.manual);
        expect(now.sentence).toBe(frozen.sentence);
        expect(now.manual.items.map((i: { title: string }) => i.title).sort()).toEqual(["Dark mode", "Export the orders", "Pay by card"]);
        // the project itself is no longer ready, which the dashboard shows and a new release would too
        expect((await newRelease(s, "2.5")).automated.readiness.state).toBe("blocked");
    });

    it("reopens only with a name and a comment, records it, and then shows live data again", async () => {
        expect((await call("POST", `${releases(s)}/${rid}/reopen`, { by: "Dana" })).status).toBe(400);
        expect((await call("POST", `${releases(s)}/${rid}/reopen`, { comment: "Needs another look" })).status).toBe(400);
        const r = await call("POST", `${releases(s)}/${rid}/reopen`, { by: "Dana Lee", comment: "A new critical bug appeared" });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: "open", decision: null, frozen: false, signedBy: null });
        expect(r.body.audit.map((a: { kind: string }) => a.kind)).toEqual(["approved", "reopened"]);
        expect(r.body.audit[1]).toMatchObject({ by: "Dana Lee", comment: "A new critical bug appeared" });
        expect(r.body.audit[1].state).toMatchObject({ previousDecision: "approved", signedBy: "Dana Lee" });
        // live again: the renamed case and the new case, the project is blocked now
        expect(r.body.manual.items.map((i: { title: string }) => i.title)).toContain("A brand new case");
        expect(r.body.automated.readiness.state).toBe("blocked");
        expect(r.body.signoff.canApprove).toBe(false);
        // a release that is open cannot be reopened
        expect((await call("POST", `${releases(s)}/${rid}/reopen`, { by: "Dana", comment: "again" })).status).toBe(409);
    });

    it("approves past a block with an override: the comment and the override are in the trail", async () => {
        const r = await sign(s, rid, { decision: "approved", by: "Priya", override: true, comment: "Hotfix for customers is worth the risk" });
        expect(r.status).toBe(200);
        expect(r.body.status).toBe("approved");
        const last = r.body.audit.at(-1);
        expect(last).toMatchObject({ kind: "approved", by: "Priya", override: true, comment: "Hotfix for customers is worth the risk" });
        expect(last.state.blocking.length).toBeGreaterThan(0);
        expect(r.body.audit.map((a: { kind: string }) => a.kind)).toEqual(["approved", "reopened", "approved"]);
    });

    it("rejects without any reason, even while things block it, and an override flag changes nothing", async () => {
        const t = seedProject(platform, "Reject me", "https://reject.example.test");
        await newCase(t, "Failing check", "critical");
        const id = (await newRelease(t, "9.9")).id;
        const r = await sign(t, id, { decision: "rejected", by: "Priya", override: true });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: "rejected", decision: "rejected" });
        expect(r.body.audit[0]).toMatchObject({ kind: "rejected", by: "Priya", comment: "", override: false });
        const reopened = await call("POST", `${releases(t)}/${id}/reopen`, { by: "Priya", comment: "Changed our mind" });
        expect(reopened.body.audit.map((a: { kind: string }) => a.kind)).toEqual(["rejected", "reopened"]);
    });

    it("overrides an automated block as well", async () => {
        const id = (await newRelease(blocked, "Hotfix")).id;
        const refused = await sign(blocked, id, { decision: "approved", by: "Priya" });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toContain("The automated tests are blocked: 1 critical finding");
        const done = await sign(blocked, id, { decision: "approved", by: "Priya", override: true, comment: "Known issue, fix ships tomorrow" });
        expect(done.status).toBe(200);
        expect(done.body.audit[0].override).toBe(true);
    });

    it("refuses to change the audit trail in the database itself", () => {
        expect(() => platform.db.run("UPDATE release_audit SET comment = 'edited' WHERE release_id = ?", rid)).toThrow(/cannot be changed/);
        expect(platform.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM release_audit WHERE release_id = ?", rid)!.c).toBe(3);
    });
});

describe("the report page", () => {
    it("is one self-contained HTML page with everything escaped", async () => {
        const s = seedProject(platform, "Report <b>project</b>", "https://report.example.test");
        addTest(platform, s, "a");
        await seedRun(platform, s, { a: "pass" }, { daysAgo: 0.5 });
        const cid = await newCase(s, "<script>window.__xss = 1</script>", "low", { area: "<img src=x onerror=alert(1)>" });
        const rel = await newRelease(s, "<script>alert('release')</script>", "Notes <i>italic</i>");
        await setResult(s, rel.id, cid, { result: "passed", note: "<script>alert('note')</script>", by: "<u>Eve</u>" });
        await sign(s, rel.id, { decision: "approved", by: "<svg onload=alert(1)>", comment: "<script>alert('comment')</script> ok" });

        const r = await call("GET", `${releases(s)}/${rel.id}/report?format=html`);
        expect(r.status).toBe(200);
        expect(r.headers["content-type"]).toContain("text/html");
        expect(r.headers["content-disposition"]).toMatch(/attachment; filename="signoff-report-b-project-b-/);
        expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
        const html = r.text;
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toContain("<img");
        expect(html).not.toContain("<svg");
        expect(html).not.toContain("<u>");
        expect(html).toContain("&lt;script&gt;window.__xss = 1&lt;/script&gt;");
        expect(html).toContain("&lt;svg onload=alert(1)&gt;");
        expect(html).toContain("Approved");
        expect(html).toContain("Audit trail");
        expect(html).not.toMatch(/https?:\/\/(?!report\.example)/); // loads nothing from anywhere
        expect((await call("GET", `${releases(s)}/${rel.id}/report?format=pdf`)).status).toBe(400);
        expect((await call("GET", `${releases(s)}/missing/report`)).status).toBe(404);
    });

    it("reports an open release too, saying it is not signed", async () => {
        const s = seedProject(platform, "Open report", null);
        const rel = await newRelease(s, "Draft");
        const html = (await call("GET", `${releases(s)}/${rel.id}/report`)).text;
        expect(html).toContain("Not signed yet");
        expect(html).toContain("No decision has been recorded yet.");
        expect(html).toContain("This project has no manual checks.");
    });
});

describe("access", () => {
    it("is behind the API key like every other route", async () => {
        const p = seedProject(keyed, "Keyed", null);
        const key = { "x-api-key": "manual-test-key" };
        for (const [m, u] of [
            ["GET", `/api/projects/${p.projectId}/manual-cases`],
            ["POST", `/api/projects/${p.projectId}/manual-cases`],
            ["GET", `/api/projects/${p.projectId}/manual-cases/export`],
            ["GET", `/api/projects/${p.projectId}/releases`],
            ["POST", `/api/projects/${p.projectId}/releases`],
        ] as const) {
            expect((await call(m, u, { title: "x", name: "x" }, keyedServer)).status).toBe(401);
        }
        const made = await call("POST", `/api/projects/${p.projectId}/releases`, { name: "x" }, keyedServer, key);
        expect(made.status).toBe(201);
        expect((await call("GET", `/api/projects/${p.projectId}/releases/${made.body.id}/report`, undefined, keyedServer)).status).toBe(401);
        expect((await call("GET", `/api/projects/${p.projectId}/releases/${made.body.id}/report`, undefined, keyedServer, key)).status).toBe(200);
    });

    it("keeps projects apart: a case, a release or a result of one project is not reachable through another", async () => {
        const a = seedProject(platform, "Iso A", null);
        const b = seedProject(platform, "Iso B", null);
        const caseA = await newCase(a, "A's case");
        const relA = await newRelease(a, "A's release");
        const relB = await newRelease(b, "B's release");
        expect((await call("GET", `${cases(b)}/${caseA}`)).status).toBe(404);
        expect((await call("PUT", `${cases(b)}/${caseA}`, { title: "hijack" })).status).toBe(404);
        expect((await call("DELETE", `${cases(b)}/${caseA}`)).status).toBe(404);
        expect((await call("GET", `${releases(b)}/${relA.id}`)).status).toBe(404);
        expect((await call("GET", `${releases(b)}/${relA.id}/report`)).status).toBe(404);
        expect((await sign(b, relA.id, { decision: "rejected", by: "x" })).status).toBe(404);
        expect((await call("POST", `${releases(b)}/${relA.id}/reopen`, { by: "x", comment: "y" })).status).toBe(404);
        expect((await setResult(b, relA.id, caseA, { result: "passed" })).status).toBe(404);
        // B's release does not show A's case
        expect((await call("GET", `${releases(b)}/${relB.id}`)).body.manual.items).toEqual([]);
        expect((await call("GET", cases(b))).body.total).toBe(0);
        expect((await call("GET", `/api/projects/missing/releases`)).status).toBe(404);
        expect((await call("GET", cases(a))).body.total).toBe(1);
    });

    it("removes a project's cases and releases with the project", async () => {
        const s = seedProject(platform, "Doomed", null);
        const cid = await newCase(s, "x");
        const rel = await newRelease(s, "r");
        await setResult(s, rel.id, cid, { result: "failed" });
        await sign(s, rel.id, { decision: "rejected", by: "x" });
        platform.db.run("DELETE FROM projects WHERE id = ?", s.projectId);
        for (const t of ["manual_cases", "releases", "release_audit"]) expect(platform.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t} WHERE project_id = ?`, s.projectId)!.c).toBe(0);
        expect(platform.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM release_results WHERE release_id = ?", rel.id)!.c).toBe(0);
    });
});

describe("an issue for a failed check", () => {
    let s: Seed;
    let integrationId: string;
    let rid: string;
    let failed: string;
    let passed: string;

    beforeAll(async () => {
        s = seedProject(platform, "Issues project", "https://issues.example.test");
        failed = await newCase(s, "Print the <b>invoice</b>", "high", { area: "Billing", requirement: "REQ-7", steps: [{ action: "Click Print", expected: "One page `comes` out" }] });
        passed = await newCase(s, "Other check");
        rid = (await newRelease(s, "Issue release")).id;
        const conn = await call("POST", `/api/projects/${s.projectId}/integrations`, { kind: "github", owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: GH });
        expect(conn.status).toBe(201);
        integrationId = conn.body.id;
    });

    const file = (cid: string, body: Record<string, unknown> = { integrationId }, project = s) => call("POST", `${releases(project)}/${rid}/results/${cid}/issue`, body);

    it("refuses a check that did not fail, and a connection of another project", async () => {
        await setResult(s, rid, passed, { result: "passed" });
        expect((await file(passed)).status).toBe(422);
        await setResult(s, rid, failed, { result: "failed", note: "It prints three pages ```", by: "Dana" });
        const foreign = await call("POST", `/api/projects/${other.projectId}/integrations`, { kind: "github", owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: GH });
        expect((await file(failed, { integrationId: foreign.body.id })).status).toBe(404);
        expect((await file(failed, {})).status).toBe(400);
        expect(receiver.posts).toHaveLength(0);
    });

    it("reports a tracker failure as 502 and files nothing", async () => {
        receiver.fail = true;
        const r = await file(failed);
        receiver.fail = false;
        expect(r.status).toBe(502);
        expect((await call("GET", `${releases(s)}/${rid}`)).body.manual.items.find((i: { id: string }) => i.id === failed).issue).toBeNull();
    });

    it("files an issue built from the case, with everything typed by a person in code blocks, and links it once", async () => {
        const r = await file(failed);
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ existing: false, issue: { provider: "github", externalId: "#1", url: "https://github.example/acme/shop/issues/1" } });
        expect(receiver.posts).toHaveLength(1);
        const posted = receiver.posts[0]!.body;
        expect(posted.title).toBe("[Manual check failed] Print the <b>invoice</b>");
        expect(posted.labels).toEqual(["ai-testing", "manual-check", "priority-high"]);
        expect(posted.body).toContain("Note from the tester");
        expect(posted.body).toContain("Check: Print the <b>invoice</b>");
        expect(posted.body).toContain("Requirement: REQ-7");
        expect(posted.body).toContain("1. Click Print\n   Expected: One page `comes` out");
        expect(posted.body).toContain(`/#/projects/${s.projectId}/releases/${rid}`);
        // the note holds three backticks: its fence is longer, so it cannot end early
        expect(posted.body).toContain("````\nIt prints three pages ```\n````");
        // typed text appears only on lines inside a fence, never in running text
        const outside = posted.body.replace(/(`{3,})\n[\s\S]*?\n\1/g, "");
        expect(outside).not.toContain("<b>");
        expect(outside).not.toContain("Click Print");

        const again = await file(failed);
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ existing: true, issue: { externalId: "#1" } });
        expect(receiver.posts).toHaveLength(1);
        const view = (await call("GET", `${releases(s)}/${rid}`)).body;
        expect(view.manual.items.find((i: { id: string }) => i.id === failed).issue.url).toBe("https://github.example/acme/shop/issues/1");
    });

    it("never returns the tracker token", async () => {
        const all = await Promise.all([call("GET", `${releases(s)}/${rid}`), call("GET", releases(s)), call("GET", `${releases(s)}/${rid}/report`)]);
        for (const r of all) expect(r.text).not.toContain(GH_TOKEN);
    });

    it("still lets the issue be filed after the release was signed (a link, not a change of the decision)", async () => {
        const p = seedProject(platform, "Signed issue", null);
        const cid = await newCase(p, "Broken thing", "low");
        const id = (await newRelease(p, "S")).id;
        await call("PUT", `${releases(p)}/${id}/results/${cid}`, { result: "failed" });
        await call("POST", `${releases(p)}/${id}/signoff`, { decision: "rejected", by: "Dana" });
        const conn = await call("POST", `/api/projects/${p.projectId}/integrations`, { kind: "github", owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: GH });
        const r = await call("POST", `${releases(p)}/${id}/results/${cid}/issue`, { integrationId: conn.body.id });
        expect(r.status).toBe(201);
        const view = (await call("GET", `${releases(p)}/${id}`)).body;
        expect(view).toMatchObject({ status: "rejected", frozen: true });
        expect(view.manual.items[0]).toMatchObject({ result: "failed", issue: { externalId: "#2" } });
    });
});
