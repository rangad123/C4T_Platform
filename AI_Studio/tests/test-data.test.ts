/**
 * Test data sets (data-driven tests): importing CSV / JSON / YAML into a named table, rendering one test per row with the row's
 * values, the row cap and its plain message, every validation error, and real runs of data-driven web and API tests where the
 * failing row is named.
 *
 * Browser-launching: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/test-data.test.ts
 * Fixture port: 5513.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { checkDataSet, DataSetError, MAX_DATA_COLUMNS, MAX_DATA_ROWS, MAX_ROWS_PER_SPEC, parseCsv, parseDataSet, resolveRows, unknownPlaceholders } from "../src/engine/testdata/dataset.js";
import { startEnvironmentsApp, type EnvironmentsApp } from "./fixtures/environments-app.js";

const FIXTURE_PORT = 5513;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;

let app: EnvironmentsApp;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let projectId: string;

const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, text: res.body, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body } as { status: number; text: string; body: any };
};
const csv = (name: string, content: string, extra: Record<string, unknown> = {}) => call("POST", `/api/projects/${projectId}/test-data`, { name, content, ...extra });

async function idle(): Promise<void> {
    for (let i = 0; i < 480; i++) {
        const jobs = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ status: string }>;
        if (jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return;
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("project never became idle");
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    app = await startEnvironmentsApp(FIXTURE_PORT, { label: "data", bug: false, token: "unused" });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-testdata-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "1" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
    projectId = (await call("POST", "/api/projects", { name: "Test data" })).body.id;
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await app?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("reading CSV, JSON and YAML into a table", () => {
    it("reads CSV the way spreadsheets write it: quotes, commas inside values, CRLF, a BOM, other delimiters, blank lines", () => {
        const set = parseDataSet('﻿name,note\r\n"Smith, Jo","said ""hi"""\r\n\r\nplain,\r\n', "csv");
        expect(set.columns).toEqual(["name", "note"]);
        expect(set.rows).toEqual([{ name: "Smith, Jo", note: 'said "hi"' }, { name: "plain", note: "" }]);
        expect(parseDataSet("a;b\n1;2\n", "csv").rows).toEqual([{ a: "1", b: "2" }]);
        expect(parseDataSet("a\tb\n1\t2\n", "csv").rows).toEqual([{ a: "1", b: "2" }]);
        expect(parseCsv('a,b\n"line one\nline two",x\n')[1]![0]).toBe("line one\nline two");
        expect(() => parseDataSet('a,b\n"open,1\n', "csv")).toThrow(/quote/);
        expect(() => parseDataSet("a,b\n1,2,3\n", "csv")).toThrow(/Row 1 has 3 values/);
    });

    it("reads JSON lists of objects (values become text), { columns, rows } tables, and refuses nested values", () => {
        expect(parseDataSet('[{"n":1,"ok":true,"s":"x","z":null},{"n":2,"ok":false,"s":"y"}]', "json")).toEqual({ columns: ["n", "ok", "s", "z"], rows: [{ n: "1", ok: "true", s: "x", z: "" }, { n: "2", ok: "false", s: "y", z: "" }] });
        expect(parseDataSet('{"columns":["a","b"],"rows":[["1","2"],["3","4"]]}', "json").rows).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
        expect(() => parseDataSet('[{"a":{"b":1}}]', "json")).toThrow(/plain values only/);
        expect(() => parseDataSet("[[1,2]]", "json")).toThrow(/columns/);
        expect(() => parseDataSet("{nope", "json")).toThrow(/not valid JSON/);
    });

    it("reads YAML lists, and refuses aliases (the way a small file expands into a huge one)", () => {
        expect(parseDataSet("- q: apple\n  shown: apple\n- q: pear\n  shown: pear\n", "yaml").rows).toHaveLength(2);
        expect(() => parseDataSet("base: &a [x, y]\nrows:\n  - *a\n", "yaml")).toThrow(DataSetError);
    });

    it("enforces the limits and names the problem", () => {
        const wide = Array.from({ length: MAX_DATA_COLUMNS + 1 }, (_, i) => `c${i}`).join(",");
        expect(() => parseDataSet(`${wide}\n${wide}\n`, "csv")).toThrow(new RegExp(`at most ${MAX_DATA_COLUMNS}`));
        const tall = "a\n" + Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => String(i)).join("\n");
        expect(() => parseDataSet(tall, "csv")).toThrow(new RegExp(`at most ${MAX_DATA_ROWS}`));
        expect(() => parseDataSet(`a\n${"x".repeat(501)}\n`, "csv")).toThrow(/at most 500/);
        expect(() => parseDataSet("a,b\n", "csv")).toThrow(/no rows/);
        expect(() => parseDataSet("", "csv")).toThrow(/empty/);
        expect(() => parseDataSet("a,a\n1,2\n", "csv")).toThrow(/more than once/);
        expect(() => parseDataSet("first name,b\n1,2\n", "csv")).toThrow(/not allowed/);
        expect(() => parseDataSet("unique,b\n1,2\n", "csv")).toThrow(/already has a meaning/);
        expect(() => checkDataSet({ columns: ["a"], rows: [{}] })).toThrow(/no value/);
    });

    it("caps the rows one spec renders and says so", () => {
        const set = { columns: ["a"], rows: Array.from({ length: 40 }, (_, i) => ({ a: String(i) })) };
        const r = resolveRows("big", { big: set });
        expect(r).toMatchObject({ total: 40, truncated: true });
        expect(r.rows).toHaveLength(MAX_ROWS_PER_SPEC);
        expect(() => resolveRows("missing", { big: set })).toThrow(/no data set with that name/);
    });

    it("finds placeholders that no column, test value or captured value provides (built-ins are fine)", () => {
        const spec = { testData: { dataSet: "x", city: "Oslo" }, steps: [{ action: "request", path: "/a/{{id}}", extract: { token: "t" }, headers: { A: "Bearer {{token}}" }, body: { u: "{{credentials.user.username}}", e: "{{env.REGION}}", c: "{{city}}", q: "{{ q }}", n: "{{nope}}", unique: "{{unique}}" } }] };
        expect(unknownPlaceholders(spec, ["id", "q"])).toEqual(["nope"]);
        expect(unknownPlaceholders(spec, [])).toEqual(["id", "q", "nope"]);
    });
});

describe("rendering one test per row", () => {
    const spec = (o: Record<string, unknown> = {}) => TestSpecSchema.parse({ testId: "WEB-001", title: "Search works", kind: "web", testData: { dataSet: "queries" }, steps: [{ action: "navigate", url: "/search?q={{q}}" }, { action: "assert", check: "text", locator: { by: "css", value: "#results" }, expected: "Results for {{shown}}" }], ...o });
    const sets = { queries: { columns: ["q", "shown"], rows: [{ q: "apple", shown: "apple" }, { q: 'a"b`c${7}', shown: "tricky" }] } };

    it("embeds the rows as plain data and loops over them, with the row number in each title", () => {
        const s = renderScript(spec(), "playwright", { baseUrl: FIXTURE, dataSets: sets });
        expect(s.content).toContain("const ROWS: Array<Record<string, string>> = [");
        expect(s.content).toContain('{ "q": "apple", "shown": "apple" },');
        expect(s.content).toContain("for (const [rowIndex, row] of ROWS.entries()) {");
        expect(s.content).toContain("[row ${rowIndex + 1}/${ROWS.length}]");
        expect(s.content).toContain("data = { ...baseData, ...row, unique };");
        // Row values are JSON string literals: a quote, a backtick or ${...} cannot leave its string.
        expect(s.content).toContain(JSON.stringify('a"b`c${7}'));
        expect(s.content).not.toMatch(/^const data: /m);
    });

    it("renders API specs the same way and resets each row's recorded responses", () => {
        const api = TestSpecSchema.parse({ testId: "API-001", title: "Search answers", kind: "api", testData: { dataSet: "queries" }, steps: [{ action: "request", method: "GET", path: "/search", query: { q: "{{q}}" } }, { action: "assertResponse", check: "bodyContains", expected: "Results for {{shown}}" }] });
        const s = renderScript(api, "playwright-api", { baseUrl: FIXTURE, dataSets: sets });
        expect(s.content).toContain("for (const [rowIndex, row] of ROWS.entries()) {");
        expect(s.content).toContain("responses.length = 0;");
        expect(s.content).not.toContain('need("q")'); // columns are values, not "captured later" variables
    });

    it("renders an ordinary spec exactly as before, whether or not the project has data sets", () => {
        const plain = spec({ testData: {} });
        const a = renderScript(plain, "playwright", { baseUrl: FIXTURE });
        const b = renderScript(plain, "playwright", { baseUrl: FIXTURE, dataSets: sets });
        expect(a.content).toBe(b.content);
        expect(a.content).not.toContain("ROWS");
        expect(a.content).toContain("const data: Record<string, string> = {");
    });

    it("says in the script when rows were left out, and fails plainly for a data set that does not exist", () => {
        const many = { queries: { columns: ["q", "shown"], rows: Array.from({ length: 40 }, (_, i) => ({ q: `q${i}`, shown: `q${i}` })) } };
        const s = renderScript(spec(), "playwright", { baseUrl: FIXTURE, dataSets: many });
        expect(s.content).toContain("Only the first 25 of 40 rows are rendered.");
        expect(s.content.match(/^\s+\{ "q": "q\d+"/gm)).toHaveLength(25);
        expect(() => renderScript(spec(), "playwright", { baseUrl: FIXTURE })).toThrow(/no data set with that name/);
    });
});

describe("the data set API", () => {
    it("imports CSV, lists and shows it", async () => {
        const made = await csv("queries", "q,shown\napple,apple\npear,pear\n");
        expect(made.status, made.text).toBe(201);
        expect(made.body).toMatchObject({ name: "queries", columns: ["q", "shown"], rowCount: 2, usedBy: 0, truncated: false });
        const list = (await call("GET", `/api/projects/${projectId}/test-data`)).body;
        expect(list.dataSets.map((d: any) => d.name)).toEqual(["queries"]);
        expect(list.limits).toMatchObject({ maxRows: 200, maxColumns: 20, maxRowsPerTest: 25 });
        const one = (await call("GET", `/api/projects/${projectId}/test-data/queries`)).body;
        expect(one.rows).toEqual([{ q: "apple", shown: "apple" }, { q: "pear", shown: "pear" }]);
        expect((await call("GET", `/api/projects/${projectId}/test-data/nope`)).status).toBe(404);
    });

    it("accepts JSON and YAML, by file name or by looking at the content", async () => {
        expect((await csv("fromjson", '[{"a":"1"}]', { filename: "d.json" })).body.columns).toEqual(["a"]);
        expect((await csv("fromyaml", "- a: 1\n", { filename: "d.yml" })).body.rowCount).toBe(1);
        expect((await csv("sniffed", '[{"a":"1"},{"a":"2"}]')).body.rowCount).toBe(2);
        expect((await csv("explicit", "a,b\n1,2\n", { format: "csv" })).status).toBe(201);
    });

    it("rejects every kind of bad data set with a plain 400", async () => {
        const dup = await csv("queries", "a\n1\n");
        expect(dup.status).toBe(400);
        expect(dup.body.error).toMatch(/already has a data set called “queries”/);
        const cases: Array<[string, Parameters<typeof csv>, RegExp]> = [
            ["empty file", ["e1", "   "], /empty/],
            ["header only", ["e2", "a,b\n"], /no rows/],
            ["too many rows", ["e3", "a\n" + Array.from({ length: 201 }, (_, i) => i).join("\n")], /201 rows; at most 200/],
            ["too many columns", ["e4", Array.from({ length: 21 }, (_, i) => `c${i}`).join(",") + "\n" + Array.from({ length: 21 }, () => "x").join(",")], /at most 20/],
            ["duplicate columns", ["e5", "a,a\n1,2"], /more than once/],
            ["bad column name", ["e6", "first name\nx"], /not allowed/],
            ["bad data set name", ["bad name", "a\n1"], /Use letters/],
            ["invalid JSON", ["e7", "{nope", { format: "json" }], /not valid JSON/],
            ["Excel", ["e8", "binary", { filename: "data.xlsx" }], /Excel files aren't supported/],
        ];
        for (const [label, args, message] of cases) {
            const r = await csv(...args);
            expect(r.status, label).toBe(400);
            expect(r.text, label).toMatch(message);
        }
        expect((await call("GET", `/api/projects/${projectId}/test-data`)).body.dataSets.map((d: any) => d.name)).toEqual(["explicit", "fromjson", "fromyaml", "queries", "sniffed"]); // the rejected ones were not stored
    });

    it("rejects specs that name a missing data set or use a column it does not have", async () => {
        const base = { testId: "WEB-099", title: "Uses data", kind: "web", steps: [{ action: "navigate", url: "/search?q={{q}}" }] };
        const missing = await call("POST", `/api/projects/${projectId}/specs`, { specs: [{ ...base, testData: { dataSet: "ghost" } }], baseUrl: FIXTURE, validate: false });
        expect(missing.status).toBe(400);
        expect(JSON.stringify(missing.body.details)).toMatch(/no data set called “ghost”/);
        const wrong = await call("POST", `/api/projects/${projectId}/specs`, { specs: [{ ...base, steps: [{ action: "navigate", url: "/search?q={{nope}}" }], testData: { dataSet: "queries" } }], baseUrl: FIXTURE, validate: false });
        expect(wrong.status).toBe(400);
        expect(JSON.stringify(wrong.body.details)).toMatch(/\{\{nope\}\} is not a column of the data set “queries” \(its columns: q, shown\)/);
        expect((await call("GET", `/api/projects/${projectId}/tests`)).body).toHaveLength(0); // nothing was stored
    });
});

describe("data-driven tests, run for real", () => {
    const search = (id: string, title: string, set: string, shown = "{{shown}}") => ({
        testId: id,
        title,
        kind: "web",
        testData: { dataSet: set },
        steps: [{ action: "navigate", url: "/search?q={{q}}" }, { action: "assert", check: "text", locator: { by: "css", value: "#results" }, expected: `Results for ${shown}` }],
    });
    const api = (id: string, title: string, set: string) => ({
        testId: id,
        title,
        kind: "api",
        testData: { dataSet: set },
        steps: [{ action: "request", method: "GET", path: "/search", query: { q: "{{q}}" } }, { action: "assertResponse", check: "bodyContains", expected: "Results for {{shown}}" }],
    });
    const rows = (n: number) => "q,shown\n" + Array.from({ length: n }, (_, i) => `item${i},item${i}`).join("\n");
    let ids: Record<string, string> = {};

    it("validates the tests of every row, names the failing row, and caps a large data set", async () => {
        // Values that would break a careless renderer: a quote, a backtick, ${...}, a closing script-like text.
        await csv("tricky", 'q,shown\nplain,plain\n"a""b`c${7}","a""b`c${7}"\n"x</script>y","x</script>y"\n');
        // The fixture HTML-escapes what it echoes, so the API test (which reads the raw body) gets values without quotes or angle brackets.
        await csv("apirows", 'q,shown\nplain,plain\na`b${7},a`b${7}\n');
        await csv("withbug", "q,shown\none,one\ntwo,TWO-WRONG\nthree,three\n");
        await csv("many", rows(30));
        const imported = await call("POST", `/api/projects/${projectId}/specs`, {
            specs: [search("WEB-001", "Searching shows the query", "tricky"), search("WEB-002", "One row is wrong", "withbug"), api("API-001", "The search answers every row", "apirows"), search("WEB-003", "A big data set", "many")],
            baseUrl: FIXTURE,
        });
        expect(imported.status, imported.text).toBe(202);
        await idle();
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; validationStatus: string; validationReason: string | null }>;
        ids = Object.fromEntries(tests.map((t) => [t.testId, t.id]));
        const by = Object.fromEntries(tests.map((t) => [t.testId, t]));
        // Every row of the tricky set passed on its own: the values were typed into the page as written, not evaluated.
        expect(by["WEB-001"]!.validationStatus, by["WEB-001"]!.validationReason ?? "").toBe("VALIDATED");
        expect(by["API-001"]!.validationStatus, by["API-001"]!.validationReason ?? "").toBe("VALIDATED");
        // One wrong row fails the test, and the failure says which row.
        expect(by["WEB-002"]!.validationStatus).not.toBe("VALIDATED");
        expect(by["WEB-002"]!.validationReason).toMatch(/data row 2 of 3/);
        // The fixture really received the first rows' queries (and the 25-row cap held).
        const searched = app.hits.filter((h) => h.path === "/search").length;
        // 3 + 3 + 2 rows of the small sets and the first 25 of the 30-row set (never the 5 beyond the cap).
        expect(searched).toBeGreaterThanOrEqual(3 + 3 + 2 + 25);
        expect(searched).toBeLessThanOrEqual(3 + 3 + 2 + 25 + 2); // a repeated attempt of the failing test at most
        expect(by["WEB-003"]!.validationStatus).toBe("VALIDATED");
    }, 300_000);

    it("stores one self-contained script per spec, with the rows in it", async () => {
        const script = (await call("GET", `/api/tests/${ids["WEB-001"]}/script`)).text as string;
        expect(script).toContain('{ "q": "plain", "shown": "plain" },');
        expect(script).toContain(JSON.stringify('a"b`c${7}'));
        expect(script).toContain("for (const [rowIndex, row] of ROWS.entries()) {");
        const detail = (await call("GET", `/api/tests/${ids["WEB-001"]}`)).body;
        expect(detail.dataDriven).toEqual({ dataSet: "tricky", found: true, rows: 3, total: 3, truncated: false });
        // One test, one execution: the rows are inside it.
        expect(detail.executions).toHaveLength(1);
        expect(detail.executions[0].status).toBe("passed");
    });

    it("says plainly when a data set is larger than one test renders", async () => {
        const detail = (await call("GET", `/api/tests/${ids["WEB-003"]}`)).body;
        expect(detail.dataDriven).toMatchObject({ dataSet: "many", rows: 25, total: 30, truncated: true });
        expect(detail.dataDriven.note).toMatch(/30 rows; only the first 25/);
        const script = (await call("GET", `/api/tests/${ids["WEB-003"]}/script`)).text as string;
        expect(script).toContain("Only the first 25 of 30 rows are rendered.");
        const jobs = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ jobId: string }>;
        const events = (await Promise.all(jobs.map(async (j) => (await call("GET", `/api/test-generation/${j.jobId}/events`)).body as Array<{ kind: string; message: string }>))).flat();
        expect(events.some((e) => e.kind === "data_set_truncated" && /only the first 25/.test(e.message))).toBe(true);
    });

    it("keeps a data set that tests use: columns they need stay, and it cannot be deleted under them", async () => {
        const shrink = await call("PUT", `/api/projects/${projectId}/test-data/tricky`, { content: "q\nonly\n" });
        expect(shrink.status).toBe(400);
        expect(shrink.body.error).toMatch(/would break tests that use “tricky”: .*\{\{shown\}\}/);
        const del = await call("DELETE", `/api/projects/${projectId}/test-data/tricky`);
        expect(del.status).toBe(409);
        expect(del.body.error).toMatch(/WEB-001/);
        expect((await call("DELETE", `/api/projects/${projectId}/test-data/explicit`)).status).toBe(200);
    });

    it("re-renders from the new rows when a data set is replaced and the test is run again", async () => {
        const put = await call("PUT", `/api/projects/${projectId}/test-data/withbug`, { content: "q,shown\none,one\nthree,three\n" });
        expect(put.status, put.text).toBe(200);
        expect(put.body).toMatchObject({ rowCount: 2, usedBy: 1 });
        const run = await call("POST", `/api/tests/${ids["WEB-002"]}/validate`);
        expect(run.status).toBe(202);
        await idle();
        const detail = (await call("GET", `/api/tests/${ids["WEB-002"]}`)).body;
        expect(detail.validationStatus).toBe("VALIDATED"); // the wrong row is gone
        const script = (await call("GET", `/api/tests/${ids["WEB-002"]}/script`)).text as string;
        expect(script).not.toContain("TWO-WRONG");
        expect(script).toContain('{ "q": "three", "shown": "three" },');
    }, 240_000);
});
