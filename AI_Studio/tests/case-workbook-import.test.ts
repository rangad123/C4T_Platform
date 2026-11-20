/**
 * Importing the test case workbook into a code project (founder 2026-11-19, SPEC R6, owner decisions Q1 and Q3; task C6), through a real
 * platform (Fastify inject, a real database, a stand-in Crowd4Test sign-in on port 7693; no model, no browser):
 *   - the Test cases sheet maps to test cases: Type and Priority without regard to case, Steps only on Manual rows (an Automated row's Steps
 *     are ignored and counted), preconditions, expected result, page and the workbook's ID kept, Requirement matched to a REQ-n reference;
 *   - a case already here is left out: the same workbook ID, or the same title on the same page;
 *   - the project's 5,000-case limit (FX15) refuses the whole file with how many would fit; a damaged or wrong file is a 400 sentence; nothing saved;
 *   - only people who may write test cases import, and another organisation's project is a 404;
 *   - JSON export and import keep the new fields;
 *   - FX16: the Export download is the same three-sheet workbook, and it imports into another code project as the same cases;
 *   - migration 69: a database at 68 keeps every case, which reads as having none of the new fields; one already at 69 opens unchanged;
 *   - FX7: a project backup carries the four new fields and its restore keeps them; an older backup without them restores with none;
 *   - FX1: a literal `_xHHHH_` in a cell comes back exactly (the writer escapes it as `_x005F_xHHHH_`).
 *
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/case-workbook-import.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { casesFromWorkbook } from "../src/engine/manual/workbook-import.js";
import { readTable } from "../src/engine/manual/xlsx-read.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import type { CaseOutcome, CaseOutcomeCase } from "../src/platform/case-outcome-types.js";
import { buildBackup, restoreBackup } from "../src/platform/backup.js";
import { ManualCaseStore } from "../src/platform/manual-case-store.js";
import { buildCaseWorkbook } from "../src/platform/case-workbook.js";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";
import { buildServer } from "../src/platform/server.js";
import { buildXlsx } from "../src/shared/xlsx.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const API_PORT = 7693;
const PAGE = { "x-requested-with": "ai-studio" };
const me = (id: string, permissions: readonly string[], organisationId: string) => ({
    data: { user: { id, email: `${id}@people.example`, role: "CUSTOMER", status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-cora": me("cora", PERMISSIONS, "org-a"),
    // May see the project, may not change its test cases.
    "t-rita": me("rita", ["ai_studio.access"], "org-a"),
    "t-bob": me("bob", PERMISSIONS, "org-b"),
};

let api: http.Server;
let platform: Platform;
let app: App;
const dirs: string[] = [];

const as = (token: string, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? (JSON.parse(r.body) as any) : r.body, text: r.body }));
const cora = (method: string, url: string, payload?: unknown) => as("t-cora", method, url, payload);
const project = async (token: string, name: string) => {
    const r = await as(token, "POST", "/api/projects", { name, platforms: ["web"], testingModes: ["code"] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const importXlsx = (pid: string, bytes: Uint8Array, token = "t-cora") => as(token, "POST", `/api/projects/${pid}/manual-cases/import`, { format: "xlsx", content: b64(bytes) });
const casesOf = async (pid: string) => (await cora("GET", `/api/projects/${pid}/manual-cases`)).body.cases as any[];

const tc = (over: Partial<CaseOutcomeCase>): CaseOutcomeCase => ({ id: "TC-001", title: "A case", type: "automated", priority: "medium", page: "/", preconditions: [], steps: [], expected: [], requirement: "", ...over });
const outcome = (cases: CaseOutcomeCase[]): CaseOutcome => ({
    caseAgent: true,
    runs: [],
    pages: [
        { path: "/login", url: "http://127.0.0.1:4000/login", title: "Sign in", purpose: "Sign in" },
        { path: "/cart", url: "http://127.0.0.1:4000/cart", title: "Cart", purpose: "Pay" },
    ],
    tree: [
        { node: "/login", parent: null, page: "/login", title: "Sign in", cases: 1 },
        { node: "/cart", parent: "/login", page: "/cart", title: "Cart", cases: 1 },
    ],
    cases,
    notOpened: 0,
    missing: [],
});

/** A workbook as a person might have edited it: headers in another order and case, words in other cases, a sheet before it. */
const handMade = (rows: string[][], header = ["title", "TYPE", "Priority", "id", "page", "steps", "Expected Result", "preconditions", "requirement"]) =>
    buildXlsx([
        { name: "Notes", rows: [["Read me"]] },
        { name: "Test cases", rows: [header, ...rows], header: true },
    ]);

beforeAll(async () => {
    api = http.createServer((rq, res) => {
        const auth = String(rq.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-wb-import-"));
    dirs.push(dir);
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "wb-import-secret-key-0123456789ab", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }));
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => api?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("reading the Test cases sheet", () => {
    it("matches Type and Priority without regard to case, keeps Steps only on Manual rows and counts the Automated rows whose Steps it ignored", () => {
        const r = casesFromWorkbook(
            handMade([
                ["Sign in", "AUTOMATED", "HIGH", "TC-001", "/login", "Type the password => Signed in", "The account page opens", "An account exists\nIt is active", "REQ-1"],
                ["Look at the logo", "manual", "low", "TC-002", "/", "Open the page => The logo shows\nZoom in", "", "", ""],
                ["Pay", "Automated", "Critical", "TC-003", "/cart", "", "Paid", "", ""],
                ["Bad type", "Robot", "high", "TC-004", "/", "", "", "", ""],
                ["Bad priority", "Manual", "urgent", "TC-005", "/", "", "", "", ""],
            ]),
        );
        expect(r.stepsIgnored).toBe(1);
        expect(r.skipped).toEqual([
            { row: 5, reason: "Type “Robot” is not Automated or Manual" },
            { row: 6, reason: "Priority “urgent” is not one of critical, high, medium or low" },
        ]);
        expect(r.cases.map((c) => [c.title, c.automation, c.priority])).toEqual([
            ["Sign in", "automated", "high"],
            ["Look at the logo", "manual", "low"],
            ["Pay", "automated", "critical"],
        ]);
        expect(r.cases[0]).toMatchObject({ steps: [], preconditions: ["An account exists", "It is active"], expected: "The account page opens", page: "/login", area: "/login", sourceRef: "TC-001", requirement: "REQ-1", requirementRef: "REQ-1" });
        expect(r.cases[1]!.steps).toEqual([
            { action: "Open the page", expected: "The logo shows" },
            { action: "Zoom in", expected: "" },
        ]);
    });

    it("reads the platform's own workbook back exactly, including a literal _xHHHH_ in a cell (FX1)", () => {
        const odd = "Pay _x0041_ now, then _x0041_x0042_ and _x005F_";
        const wb = buildCaseWorkbook(outcome([tc({ title: odd, expected: ["Shows _x000D_ as typed"], preconditions: ["_x0020_"] })]));
        const [row] = readTable(wb, "Test cases", { columns: ["Title", "Expected result", "Preconditions"], required: ["Title"] });
        expect(row!.values).toEqual({ Title: odd, "Expected result": "Shows _x000D_ as typed", Preconditions: "_x0020_" });
        expect(casesFromWorkbook(wb).cases[0]!.title).toBe(odd);
    });
});

describe("POST /api/projects/:id/manual-cases/import with format xlsx", () => {
    it("imports the downloaded workbook: every row, with type, priority, page, preconditions, expected result and the workbook ID; steps only on Manual", async () => {
        const pid = await project("t-cora", "Atlas code");
        const req = await cora("POST", `/api/projects/${pid}/requirements`, { ref: "REQ-3", title: "People sign in" });
        expect(req.status, JSON.stringify(req.body)).toBe(201);
        const wb = buildCaseWorkbook(
            outcome([
                tc({ id: "TC-001", title: "Sign in with a password", type: "automated", priority: "critical", page: "/login", preconditions: ["An account exists"], expected: ["The account page opens"], requirement: "REQ-3" }),
                tc({ id: "TC-002", title: "The cart looks right", type: "manual", priority: "low", page: "/cart", steps: [{ action: "Open the cart", expected: "The lines line up" }], expected: ["Nothing overlaps"], requirement: "The cart is readable" }),
                // The same title on another page is another case.
                tc({ id: "TC-003", title: "Sign in with a password", page: "/cart" }),
            ]),
        );
        const r = await importXlsx(pid, wb);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body).toMatchObject({ created: 3, duplicates: 0, skipped: [], stepsIgnored: 0, total: 3 });
        const saved = await casesOf(pid);
        expect(saved.map((c) => [c.ref, c.sourceRef, c.title, c.automation, c.priority, c.page])).toEqual([
            ["TC-001", "TC-001", "Sign in with a password", "automated", "critical", "/login"],
            ["TC-002", "TC-002", "The cart looks right", "manual", "low", "/cart"],
            ["TC-003", "TC-003", "Sign in with a password", "automated", "medium", "/cart"],
        ]);
        expect(saved[0]).toMatchObject({ preconditions: ["An account exists"], expected: "The account page opens", steps: [], requirement: "REQ-3", requirementId: req.body.id });
        expect(saved[1]).toMatchObject({ steps: [{ action: "Open the cart", expected: "The lines line up" }], expected: "Nothing overlaps", requirement: "The cart is readable", requirementId: null });
        // The requirement now counts the case that comes from it.
        const reqView = await cora("GET", `/api/projects/${pid}/requirements/${req.body.id}`);
        expect(JSON.stringify(reqView.body)).toContain(saved[0].id);
    });

    it("leaves out a case already here: the same workbook ID (even with a changed title), or the same title on the same page", async () => {
        const pid = await project("t-cora", "Again code");
        const first = await importXlsx(pid, handMade([["Sign in", "Automated", "high", "TC-001", "/login", "", "", "", ""]]));
        expect(first.body).toMatchObject({ created: 1, duplicates: 0 });
        const again = await importXlsx(
            pid,
            handMade([
                ["Sign in again, renamed", "Automated", "high", "tc-001", "/login", "", "", "", ""], // same ID
                ["Sign in", "Manual", "low", "TC-009", "/login", "", "", "", ""], // same title and page
                ["Sign in", "Automated", "high", "TC-010", "/other", "", "", "", ""], // same title, another page: new
            ]),
        );
        expect(again.status).toBe(201);
        expect(again.body).toMatchObject({ created: 1, duplicates: 2, total: 2 });
        expect((await casesOf(pid)).map((c) => [c.sourceRef, c.page])).toEqual([
            ["TC-001", "/login"],
            ["TC-010", "/other"],
        ]);
        // The whole file again: nothing new, and not refused.
        const third = await importXlsx(pid, handMade([["Sign in", "Automated", "high", "TC-001", "/login", "", "", "", ""]]));
        expect(third).toMatchObject({ status: 200, body: { created: 0, duplicates: 1, total: 2 } });
    });

    it("says how many Automated rows had steps that were not imported", async () => {
        const pid = await project("t-cora", "Steps code");
        const r = await importXlsx(
            pid,
            handMade([
                ["One", "Automated", "", "TC-1", "/", "Click => Done", "", "", ""],
                ["Two", "automated", "", "TC-2", "/", "Click", "", "", ""],
                ["Three", "Manual", "", "TC-3", "/", "Click => Done", "", "", ""],
            ]),
        );
        expect(r.body).toMatchObject({ created: 3, stepsIgnored: 2 });
        expect((await casesOf(pid)).map((c) => c.steps.length)).toEqual([0, 0, 1]);
    });

    it("refuses the whole file when it would pass the project's 5,000 test cases, saying how many would fit", async () => {
        const pid = await project("t-cora", "Full code");
        const many = Array.from({ length: 4998 }, (_, i) => ({ title: `Case ${i}` }));
        expect((await cora("POST", `/api/projects/${pid}/manual-cases/import`, { format: "json", content: JSON.stringify(many) })).body.created).toBe(4998);
        const r = await importXlsx(pid, handMade(Array.from({ length: 5 }, (_, i) => [`New ${i}`, "Automated", "", `TC-${i}`, "/", "", "", "", ""])));
        expect(r.status).toBe(409);
        expect(r.body.error).toBe("This project can hold 5000 test cases and already has 4998, so at most 2 more can be imported. This file has 5 new ones. Nothing was imported.");
        expect((await casesOf(pid)).length).toBe(4998);
    });

    it("refuses a damaged or wrong file with one sentence and saves nothing", async () => {
        const pid = await project("t-cora", "Refusals code");
        const refusals: Array<[unknown, RegExp]> = [
            ["not base64!!", /base64/],
            [b64(new TextEncoder().encode("title,steps\nA,B")), /not an Excel workbook/],
            [b64(buildXlsx([{ name: "Pages", rows: [["Page"]] }])), /no sheet named “Test cases”/],
            [b64(handMade([["x"]], ["ID", "Type"])), /no “Title” column/],
            [{ some: "object" }, /base64/],
        ];
        for (const [content, msg] of refusals) {
            const r = await cora("POST", `/api/projects/${pid}/manual-cases/import`, { format: "xlsx", content });
            expect(r.status, JSON.stringify(r.body)).toBe(400);
            expect(r.body.error).toMatch(msg);
        }
        expect(await casesOf(pid)).toEqual([]);
    });

    it("is refused to a person who may not write test cases, and another organisation's project is a 404", async () => {
        const pid = await project("t-cora", "Guarded code");
        const rita = (await as("t-rita", "GET", "/api/auth/state")).body.me.id as string;
        accessControlOf(app).projects.store.addMember(pid, rita, { role: "editor", projectAdmin: false, source: "added", addedBy: "test" });
        const wb = handMade([["Sign in", "Automated", "high", "TC-001", "/login", "", "", "", ""]]);
        expect((await as("t-rita", "GET", `/api/projects/${pid}/manual-cases`)).status).toBe(200);
        expect((await importXlsx(pid, wb, "t-rita")).status).toBe(403);
        const theirs = await project("t-bob", "Bob's code");
        const r = await importXlsx(theirs, wb, "t-cora");
        expect(r.status).toBe(404);
        expect(await casesOf(pid)).toEqual([]);
        expect((await as("t-bob", "GET", `/api/projects/${theirs}/manual-cases`)).body.cases).toEqual([]);
    });
});

describe("JSON export and import", () => {
    it("keep preconditions, expected result, page and the source ID", async () => {
        const pid = await project("t-cora", "Json from");
        await importXlsx(pid, handMade([["Sign in", "Automated", "high", "TC-007", "/login", "", "The account opens", "An account\nA password", ""]]));
        const out = await cora("GET", `/api/projects/${pid}/manual-cases/export?format=json`);
        const to = await project("t-cora", "Json to");
        const back = await cora("POST", `/api/projects/${to}/manual-cases/import`, { format: "json", content: out.text });
        expect(back.body.created).toBe(1);
        expect((await casesOf(to))[0]).toMatchObject({ title: "Sign in", automation: "automated", preconditions: ["An account", "A password"], expected: "The account opens", page: "/login", sourceRef: "TC-007" });
    });

    it("keeps the new fields when an edit does not send them", async () => {
        const pid = await project("t-cora", "Edit code");
        await importXlsx(pid, handMade([["Sign in", "Automated", "high", "TC-007", "/login", "", "Opens", "An account", ""]]));
        const [c] = await casesOf(pid);
        const put = await cora("PUT", `/api/projects/${pid}/manual-cases/${c.id}`, { title: "Sign in, edited", priority: "high", steps: [] });
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        expect(put.body).toMatchObject({ title: "Sign in, edited", preconditions: ["An account"], expected: "Opens", page: "/login", sourceRef: "TC-007" });
    });
});

describe("GET /api/projects/:id/manual-cases/export?format=xlsx (FX16)", () => {
    const download = (pid: string, format = "xlsx", token = "t-cora") => app.inject({ method: "GET", url: `/api/projects/${pid}/manual-cases/export?format=${format}`, headers: { cookie: `c4t_access=${token}` } });
    /** What makes two cases the same case, whatever project they are in. */
    const same = (c: any) => ({ title: c.title, automation: c.automation, priority: c.priority, page: c.page, preconditions: c.preconditions, steps: c.steps, expected: c.expected, requirement: c.requirement });

    it("downloads the three-sheet workbook, which imports into another code project as the same cases", async () => {
        const from = await project("t-cora", "Workbook from");
        await importXlsx(
            from,
            handMade([
                ["Sign in", "Automated", "high", "TC-007", "/login", "", "The account opens\nThe name shows", "An account\nA password", "REQ-1"],
                ["The cart lines up", "Manual", "low", "TC-008", "/cart", "Open the cart => The lines line up\nZoom in", "", "", "The cart is readable"],
                ["Pay by card", "Automated", "critical", "TC-009", "/cart", "", "Paid", "", ""],
            ]),
        );
        // Written by hand, with no page; a title that looks like a formula stays text.
        expect((await cora("POST", `/api/projects/${from}/manual-cases`, { title: '=HYPERLINK("http://evil.test")', steps: [{ action: "Look", expected: "" }] })).status).toBe(201);

        const r = await download(from);
        expect(r.statusCode, r.body).toBe(200);
        expect(r.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        expect(r.headers["content-disposition"]).toBe('attachment; filename="manual-cases-workbook-from.xlsx"');
        const wb = new Uint8Array(r.rawPayload);
        // The same sheets as a Test Case Generation project's workbook; Pages and Tree name each page once.
        expect(Object.keys(unzipSync(wb)).filter((f) => f.startsWith("xl/worksheets/")).length).toBe(3);
        expect(readTable(wb, "Pages", { columns: ["Page", "Address", "Purpose"], required: ["Page"] }).map((t) => t.values.Page)).toEqual(["/login", "/cart"]);
        expect(readTable(wb, "Tree", { columns: ["Node", "Parent", "Page"], required: ["Node"] }).map((t) => [t.values.Node, t.values.Parent, t.values.Page])).toEqual([
            ["/login", "", "/login"],
            ["/cart", "", "/cart"],
        ]);
        expect(readTable(wb, "Test cases", { columns: ["ID"], required: ["ID"] }).map((t) => t.values.ID)).toEqual(["TC-001", "TC-002", "TC-003", "TC-004"]);

        const to = await project("t-cora", "Workbook to");
        const back = await importXlsx(to, wb);
        expect(back.body).toMatchObject({ created: 4, duplicates: 0, skipped: [], stepsIgnored: 0 });
        const original = await casesOf(from);
        const copy = await casesOf(to);
        expect(copy.map(same)).toEqual(original.map(same));
        // Each copy names the case it came from by the ID people read there.
        expect(copy.map((c) => c.sourceRef)).toEqual(original.map((c) => c.ref));
        // The same file again adds nothing.
        expect((await importXlsx(to, wb)).body).toMatchObject({ created: 0, duplicates: 4 });
    });

    it("is allowed and refused exactly as the JSON export is", async () => {
        const pid = await project("t-cora", "Workbook private");
        for (const token of ["t-cora", "t-rita", "t-bob"]) expect((await download(pid, "xlsx", token)).statusCode, token).toBe((await download(pid, "json", token)).statusCode);
        expect((await download(pid, "xlsx", "t-bob")).statusCode).toBe(404);
    });
});

describe("backup and restore (FX7)", () => {
    // The backup and restore functions the routes call (the routes need a platform administrator, which this file's accounts are not).
    const backupOf = async (pid: string) => (await buildBackup(platform, pid, { evidence: false, maxEvidenceMB: 1, withoutSecurity: false })).bytes;
    const restore = async (zip: Uint8Array, name: string) => (await restoreBackup(platform, zip, { name })).project.id as string;

    /** The restored project's cases, read from the store (the restored project belongs to no organisation of this file's accounts). */
    const storedCases = (pid: string) => new ManualCaseStore(platform.db).listCases(pid) as any[];

    it("carries preconditions, expected result, page and the source ID of every case", async () => {
        const pid = await project("t-cora", "Backup from");
        await importXlsx(
            pid,
            handMade([
                ["Sign in", "Automated", "high", "TC-007", "/login", "", "The account opens\nIts name shows", "An account\nA password", ""],
                ["Look at the logo", "Manual", "low", "TC-008", "/", "Open the page => The logo shows", "", "", ""],
            ]),
        );
        const zip = await backupOf(pid);
        const written = JSON.parse(strFromU8(unzipSync(zip)["manual-cases.json"]!)) as any[];
        expect(written.map((c) => [c.title, c.preconditions, c.expected, c.page, c.sourceRef])).toEqual([
            ["Sign in", ["An account", "A password"], "The account opens\nIts name shows", "/login", "TC-007"],
            ["Look at the logo", [], "", "/", "TC-008"],
        ]);
        const to = await restore(zip, "Backup to");
        const pick = (c: any) => ({ title: c.title, automation: c.automation, steps: c.steps, preconditions: c.preconditions, expected: c.expected, page: c.page, sourceRef: c.sourceRef });
        expect(storedCases(to).map(pick)).toEqual((await casesOf(pid)).map(pick));
        expect(storedCases(to)[0]).toMatchObject({ preconditions: ["An account", "A password"], expected: "The account opens\nIts name shows", page: "/login", sourceRef: "TC-007" });
    });

    it("leaves out the outcome's \"forget what we learned\" time (C4's case-outcome/forgotten.json): a backup carries no runs, so the cut-off has nothing to cut", async () => {
        const pid = await project("t-cora", "Forgotten from");
        await importXlsx(pid, handMade([["Sign in", "Automated", "high", "TC-001", "/login", "", "Opens", "", ""]]));
        // A fixture of the file C4 writes; the jobs it cuts off are not in a backup either.
        await platform.store.put(`${pid}/case-outcome/forgotten.json`, JSON.stringify({ at: "2026-11-20T10:00:00.000Z" }));
        const zip = await backupOf(pid);
        const entries = unzipSync(zip);
        const all = Object.entries(entries).map(([name, bytes]) => `${name}\n${strFromU8(bytes)}`).join("\n");
        expect(all).not.toContain("forgotten");
        expect(all).not.toContain("2026-11-20T10:00:00.000Z");
        const to = await restore(zip, "Forgotten to");
        expect(platform.repo.listJobs(to)).toEqual([]);
        await expect(platform.store.getBytes(`${to}/case-outcome/forgotten.json`)).rejects.toThrow();
    });

    it("restores a backup made before these fields existed, with none of them", async () => {
        const pid = await project("t-cora", "Old backup from");
        await importXlsx(pid, handMade([["Sign in", "Automated", "high", "TC-001", "/login", "", "Opens", "An account", ""]]));
        const entries = unzipSync(await backupOf(pid));
        const old = (JSON.parse(strFromU8(entries["manual-cases.json"]!)) as any[]).map(({ preconditions: _p, expected: _e, page: _g, sourceRef: _s, ...rest }) => rest);
        entries["manual-cases.json"] = strToU8(JSON.stringify(old));
        const to = await restore(zipSync(entries), "Old backup to");
        expect(storedCases(to)[0]).toMatchObject({ title: "Sign in", preconditions: [], expected: "", page: "", sourceRef: "" });
    });
});

describe("migration 69", () => {
    const at = "2026-11-19T10:00:00.000Z";
    const schemaOf = (db: Db) => db.all("SELECT name, type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('manual_cases') ORDER BY name");

    it("is known to this code", () => {
        expect(knownSchemaVersion()).toBeGreaterThanOrEqual(69);
    });

    it("upgrades a database at 68: every case keeps its row and reads as having no preconditions, expected result, page or source ID", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mig69-"));
        dirs.push(dir);
        const file = path.join(dir, "at68.db");
        createDatabaseAtVersion(file, 68);
        const raw = new DatabaseSync(file);
        raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
        raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("p1", "u-1", "Shop", at, at);
        const insert = raw.prepare("INSERT INTO manual_cases (id, project_id, title, area, priority, requirement, steps_json, linked_json, automation, number, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
        insert.run("c1", "p1", "Sign in", "Accounts", "high", "REQ-1", JSON.stringify([{ action: "Sign in", expected: "In" }]), "[]", "manual", 1, at, at);
        insert.run("c2", "p1", "Pay", "Checkout", "critical", "", "[]", "[]", "automated", 2, at, at);
        const before = raw.prepare("SELECT * FROM manual_cases ORDER BY id").all();
        raw.close();

        const db = new Db(file);
        expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(knownSchemaVersion());
        const after = db.all("SELECT * FROM manual_cases ORDER BY id");
        expect(after).toEqual(before.map((r) => ({ ...r, preconditions_json: "[]", expected: "", page: "", source_ref: "" })));
        const fresh = new Db(":memory:");
        expect(schemaOf(db)).toEqual(schemaOf(fresh));
        fresh.close();
        db.close();

        // Opened again (now at 69): nothing runs twice and nothing changes.
        const again = new Db(file);
        expect(again.all("SELECT version FROM schema_version WHERE version = 69")).toHaveLength(1);
        expect(again.all("SELECT * FROM manual_cases ORDER BY id")).toEqual(after);
        again.close();
    });

    it("opens a database already at 69 with its imported fields as they are", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mig69b-"));
        dirs.push(dir);
        const file = path.join(dir, "at69.db");
        createDatabaseAtVersion(file, 69);
        const raw = new DatabaseSync(file);
        raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
        raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("p1", "u-1", "Shop", at, at);
        raw.prepare("INSERT INTO manual_cases (id, project_id, title, area, priority, requirement, steps_json, linked_json, automation, number, preconditions_json, expected, page, source_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("c1", "p1", "Sign in", "/login", "high", "", "[]", "[]", "automated", 1, '["An account"]', "Opens", "/login", "TC-001", at, at);
        raw.close();
        const db = new Db(file);
        expect(db.all("SELECT version FROM schema_version WHERE version = 69")).toHaveLength(1);
        expect(db.all("SELECT preconditions_json, expected, page, source_ref FROM manual_cases")).toEqual([{ preconditions_json: '["An account"]', expected: "Opens", page: "/login", source_ref: "TC-001" }]);
        db.close();
    });
});
