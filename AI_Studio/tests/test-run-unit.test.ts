/**
 * The release gate's rules (scripts/test-verdict.mjs) and the tier split (scripts/test-tiers.mjs). Pure: no browser, no vitest child.
 * A failure is never dropped; a test that passes only on its retry is flaky and blocks the gate unless a valid allow-list entry covers it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type FileResult = { file: string; ms: number; tests: number; passed: number; skipped: number; failed: string[]; fileError?: string; unhandled?: boolean; noResult?: boolean };
type Finding = { file: string; test: string; detail: string; retried: boolean };
type Entry = { file: string; test: string; reason?: string; expires?: string };
interface Verdict {
    filesOf(results: unknown, rel: (abs: string) => string): Map<string, FileResult>;
    classify(o: { first: Map<string, FileResult>; second: Map<string, FileResult>; unhandled?: string[]; notRun?: string[] }): { failures: Finding[]; flaky: Finding[] };
    readAllowlist(parsed: unknown, today?: Date): { valid: Entry[]; problems: string[] };
    gate(r: { failures: Finding[]; flaky: Finding[] }, valid: Entry[]): { ok: boolean; allowed: Finding[]; blocking: Finding[] };
}
interface Tiers {
    tiers(): { all: string[]; fast: string[]; phone: string[]; browser: string[]; missingFast: string[] };
}
// Plain .mjs scripts (run by node directly): imported through a computed path so the type checker does not look for declarations.
const verdictPath = "../scripts/test-verdict.mjs";
const tiersPath = "../scripts/test-tiers.mjs";
const V = (await import(verdictPath)) as Verdict;
const T = (await import(tiersPath)) as Tiers;

const ok = (file: string, tests = 3): FileResult => ({ file, ms: 10, tests, passed: tests, skipped: 0, failed: [] });
const bad = (file: string, failed: string[], fileError?: string): FileResult => ({ file, ms: 10, tests: 3, passed: 3 - failed.length, skipped: 0, failed, ...(fileError ? { fileError } : {}) });
const map = (...r: FileResult[]) => new Map(r.map((x) => [x.file, x]));
const TODAY = new Date("2026-10-18T12:00:00Z");

describe("reading vitest's JSON results", () => {
    it("takes failed test names, durations, and an error outside the tests (a hook time-out) per file", () => {
        const results = {
            testResults: [
                { name: "/r/tests/a.test.ts", status: "passed", startTime: 1000, endTime: 4000, assertionResults: [{ status: "passed", fullName: "a > one" }, { status: "skipped", fullName: "a > two" }] },
                { name: "/r/tests/b.test.ts", status: "failed", startTime: 0, endTime: 500, assertionResults: [{ status: "failed", fullName: "b > breaks" }, { status: "passed", fullName: "b > fine" }] },
                { name: "/r/tests/c.test.ts", status: "failed", message: "Hook timed out in 30000ms.\nIf this is a long-running hook…", startTime: 0, endTime: 30_000, assertionResults: [{ status: "passed", fullName: "c > all good" }] },
            ],
        };
        const files = V.filesOf(results, (abs) => abs.replace("/r/", ""));
        expect(files.get("tests/a.test.ts")).toMatchObject({ ms: 3000, tests: 2, passed: 1, skipped: 1, failed: [] });
        expect(files.get("tests/a.test.ts")!.fileError).toBeUndefined();
        expect(files.get("tests/b.test.ts")).toMatchObject({ failed: ["b > breaks"] });
        expect(files.get("tests/c.test.ts")).toMatchObject({ failed: [], fileError: "Hook timed out in 30000ms." });
    });
});

describe("failures and flaky tests", () => {
    it("a test that fails twice is a failure; one that passes on its retry is flaky; passing files are not retried", () => {
        const first = map(ok("tests/a.test.ts"), bad("tests/b.test.ts", ["b > twice", "b > once"]));
        const second = map(bad("tests/b.test.ts", ["b > twice"]));
        const r = V.classify({ first, second });
        expect(r.failures).toEqual([{ file: "tests/b.test.ts", test: "b > twice", detail: "", retried: true }]);
        expect(r.flaky.map((f) => f.test)).toEqual(["b > once"]);
    });

    it("without a retry every first failure stays a failure (nothing is hidden)", () => {
        const r = V.classify({ first: map(bad("tests/b.test.ts", ["b > x"])), second: new Map() });
        expect(r.failures).toHaveLength(1);
        expect(r.flaky).toHaveLength(0);
    });

    it("an error outside the tests (a hook) that does not come back is flaky; one that comes back is a failure", () => {
        const first = map(bad("tests/h.test.ts", [], "Hook timed out in 30000ms."), bad("tests/k.test.ts", [], "Hook timed out in 30000ms."));
        const second = map(ok("tests/h.test.ts"), bad("tests/k.test.ts", [], "Hook timed out in 30000ms."));
        const r = V.classify({ first, second });
        expect(r.flaky).toEqual([{ file: "tests/h.test.ts", test: "(file)", detail: "Hook timed out in 30000ms.", retried: true }]);
        expect(r.failures.map((f) => f.file)).toEqual(["tests/k.test.ts"]);
    });

    it("an unhandled error, a file that did not run, and a retry without results are failures unless the retry is clean", () => {
        const first = map(ok("tests/u.test.ts"));
        const second = map(ok("tests/u.test.ts"), { ...ok("tests/n.test.ts"), noResult: true, fileError: "no result on the retry (exit code 1)" });
        const r = V.classify({ first, second, unhandled: ["tests/u.test.ts"], notRun: ["tests/n.test.ts"] });
        expect(r.flaky).toEqual([{ file: "tests/u.test.ts", test: "(unhandled error)", detail: "an error outside any test, while this file ran", retried: true }]);
        expect(r.failures).toEqual([{ file: "tests/n.test.ts", test: "(not run)", detail: "the file did not run", retried: true }]);
    });

    it("a retry with its own unhandled error is not a clean pass", () => {
        const r = V.classify({ first: map(bad("tests/b.test.ts", ["b > x"])), second: map({ ...ok("tests/b.test.ts"), unhandled: true }) });
        expect(r.failures).toHaveLength(1);
    });

    it("a test that passed first and fails on the retry is flaky too", () => {
        const r = V.classify({ first: map(bad("tests/b.test.ts", ["b > x"])), second: map(bad("tests/b.test.ts", ["b > y"])) });
        expect(r.flaky).toEqual([
            { file: "tests/b.test.ts", test: "b > x", detail: "", retried: true },
            { file: "tests/b.test.ts", test: "b > y", detail: "passed on the first attempt, failed on the retry", retried: true },
        ]);
    });
});

describe("the reviewed allow-list and the gate", () => {
    const flakyB = { failures: [], flaky: [{ file: "tests/b.test.ts", test: "b > once", detail: "", retried: true }] };

    it("a flaky test blocks the gate unless an entry with a reason and a near expiry date allows it", () => {
        expect(V.gate(flakyB, []).ok).toBe(false);
        const { valid, problems } = V.readAllowlist({ allowed: [{ file: "tests/b.test.ts", test: "b > once", reason: "port clash under load; QA fixing", expires: "2026-11-01" }] }, TODAY);
        expect(problems).toEqual([]);
        const g = V.gate(flakyB, valid);
        expect(g).toMatchObject({ ok: true, blocking: [] });
        expect(g.allowed).toHaveLength(1);
    });

    it("expired, far-future, reasonless and malformed entries allow nothing and are reported", () => {
        const { valid, problems } = V.readAllowlist(
            {
                allowed: [
                    { file: "tests/b.test.ts", test: "b > once", reason: "was flaky last month", expires: "2026-10-01" },
                    { file: "tests/b.test.ts", test: "b > once", reason: "allow it for a year", expires: "2027-10-18" },
                    { file: "tests/b.test.ts", test: "b > once", reason: "", expires: "2026-11-01" },
                    { file: "tests/b.test.ts", test: "b > once", reason: "a fine reason here", expires: "next week" },
                    { test: "b > once" },
                ],
            },
            TODAY,
        );
        expect(valid).toEqual([]);
        expect(problems).toHaveLength(5);
        expect(problems.join("\n")).toMatch(/expired on 2026-10-01/);
        expect(problems.join("\n")).toMatch(/more than 90 days ahead/);
        expect(V.gate(flakyB, valid).ok).toBe(false);
    });

    it("an allow-list never turns a failure into a pass", () => {
        const { valid } = V.readAllowlist({ allowed: [{ file: "tests/b.test.ts", test: "b > x", reason: "known, being fixed by QA", expires: "2026-11-01" }] }, TODAY);
        expect(V.gate({ failures: [{ file: "tests/b.test.ts", test: "b > x", detail: "", retried: true }], flaky: [] }, valid).ok).toBe(false);
    });

    it("an entry for (file) covers errors outside the tests of that file only", () => {
        const { valid } = V.readAllowlist({ allowed: [{ file: "tests/h.test.ts", test: "(file)", reason: "teardown waits on a probe; QA", expires: "2026-11-01" }] }, TODAY);
        expect(V.gate({ failures: [], flaky: [{ file: "tests/h.test.ts", test: "(file)", detail: "", retried: true }] }, valid).ok).toBe(true);
        expect(V.gate({ failures: [], flaky: [{ file: "tests/h.test.ts", test: "h > a test", detail: "", retried: true }] }, valid).ok).toBe(false);
    });

    it("the allow-list in the repository is valid and short", () => {
        const parsed = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "flaky-allowlist.json"), "utf8"));
        const { valid, problems } = V.readAllowlist(parsed);
        expect(problems).toEqual([]);
        expect(valid.length).toBeLessThanOrEqual(20);
    });
});

describe("tiers", () => {
    it("every test file is in exactly one tier, and every file the fast config names exists", () => {
        const t = T.tiers();
        expect(t.missingFast).toEqual([]);
        const seen = [...t.fast, ...t.phone, ...t.browser];
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.sort()).toEqual([...t.all].sort());
        expect(t.fast).toContain("tests/test-run-unit.test.ts");
        expect(t.phone).toContain("tests/mobile.test.ts");
        expect(t.browser).toContain("tests/recorder.test.ts");
    });
});
