/**
 * The benchmark harness for Phase 4 (PHASE_4_PLAN T1, T3), pure functions and read-only commands: no app, platform or model.
 *   - `--catalogue 2026-11-21.1` loads the original catalogue plus the bench extension; the default stays 2026-11-14.1;
 *   - extension seeds are scored apart: the original score of a run is what it would be without them, and a rescore keeps it so;
 *   - `--roles catalogue` turns the catalogue's accounts into test accounts that carry only a name, a username and a password;
 *   - per-layer counts from each test's meta.layer, and `bench-report --layers`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROLE_NAME } from "../src/platform/identity-store.js";
import { CATALOGUE_FILE, EXTENSION_CATALOGUE_FILE, loadCatalogue, loadCatalogueVersion } from "../src/eval/bench/catalogue.js";
import { benchReportMain, parseBenchArgs } from "../src/eval/bench/cli.js";
import { catalogueRoles } from "../src/eval/bench/controller.js";
import { benchMetrics, categorize, extensionScore, layerCounts, rescored } from "../src/eval/bench/metrics.js";
import { benchMarkdown, layersMarkdown } from "../src/eval/bench/report.js";
import { BenchmarkSchema, type BenchFinding, type Benchmark } from "../src/eval/bench/schema.js";
import type { EvalRun } from "../src/eval/run.js";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-ext-"));
    dirs.push(d);
    return d;
};

describe("the catalogue a run names", () => {
    it("default: the original 2026-11-14.1, unchanged; 2026-11-21.1: the same defects plus the extension's, marked", () => {
        const base = loadCatalogueVersion(undefined);
        expect(base).toEqual(loadCatalogue());
        expect(base.version).toBe("2026-11-14.1");
        expect(base.defects).toHaveLength(20);
        expect(base.defects.some((d) => d.set)).toBe(false);
        expect(loadCatalogueVersion("2026-11-14.1")).toEqual(base);
        const ext = loadCatalogueVersion("2026-11-21.1");
        expect(ext.version).toBe("2026-11-21.1");
        // BS-09: unreachable in the base (row 233, no token); the extension lifts the mark (T4's API sign-in reaches it), nothing else changes.
        const { unreachable: bs09Why, ...bs09 } = base.defects.find((d) => d.id === "BS-09")!;
        expect(bs09Why).toMatch(/row 233/);
        expect(ext.defects.slice(0, 20)).toEqual(base.defects.map((d) => (d.id === "BS-09" ? bs09 : d)));
        expect(ext.defects.slice(20).map((d) => [d.id, d.set])).toEqual(["BS-13", "BS-14", "BS-15", "BS-16", "BS-17", "BS-18", "BS-19", "BS-20", "BR-09", "BR-10", "BR-11"].map((id) => [id, "extension"]));
        expect(ext.defects.filter((d) => d.storedDataOnly).map((d) => d.id)).toEqual(["BS-18", "BR-11"]);
        expect(ext.sha256).not.toBe(base.sha256);
        expect(ext.accounts).toEqual(base.accounts);
        expect(() => loadCatalogueVersion("2099-01-01.1")).toThrow(/no catalogue 2099-01-01.1/);
    });

    it("refuses an extension that is not built on the base, or that re-uses or does not mark a defect", () => {
        const d = tmp();
        const ext = JSON.parse(fs.readFileSync(EXTENSION_CATALOGUE_FILE, "utf8"));
        const write = (o: unknown) => {
            const f = path.join(d, `ext-${Math.random()}.json`);
            fs.writeFileSync(f, JSON.stringify(o));
            return f;
        };
        expect(() => loadCatalogueVersion("2026-11-21.1", CATALOGUE_FILE, write({ ...ext, extends: "2026-01-01.1" }))).toThrow(/extends 2026-01-01.1/);
        expect(() => loadCatalogueVersion("2026-11-21.1", CATALOGUE_FILE, write({ ...ext, defects: [{ ...ext.defects[0], id: "BS-01" }] }))).toThrow(/BS-01/);
        expect(() => loadCatalogueVersion("2026-11-21.1", CATALOGUE_FILE, write({ ...ext, defects: [{ ...ext.defects[0], set: undefined }] }))).toThrow(/BS-13/);
        // it may lift only an unreachable mark the base sets
        expect(() => loadCatalogueVersion("2026-11-21.1", CATALOGUE_FILE, write({ ...ext, reachable: { ...ext.reachable, "BS-01": "x" } }))).toThrow(/BS-01/);
        expect(() => loadCatalogueVersion("2026-11-21.1", CATALOGUE_FILE, write({ ...ext, reachable: { "BS-99": "x" } }))).toThrow(/BS-99/);
    });

    it("the command takes --catalogue and --roles catalogue, and nothing else for --roles", () => {
        expect(parseBenchArgs([])).not.toHaveProperty("catalogue");
        expect(parseBenchArgs([])).not.toHaveProperty("roles");
        expect(parseBenchArgs(["--catalogue", "2026-11-21.1", "--roles", "catalogue"])).toMatchObject({ catalogue: "2026-11-21.1", roles: "catalogue" });
        expect(() => parseBenchArgs(["--roles", "admin"])).toThrow(/--roles is catalogue/);
    });
});

describe("--roles catalogue", () => {
    it("the catalogue's accounts become test accounts with a valid name, the email as username and the password: nothing else", () => {
        const c = loadCatalogueVersion("2026-11-21.1");
        const shop = catalogueRoles(c.accounts!["bench-shop"]!);
        const rbac = catalogueRoles(c.accounts!["bench-rbac"]!);
        expect(shop.map((r) => r.name)).toEqual(["alice", "bob"]);
        expect(rbac).toEqual([
            { name: "ana", username: "ana@example.test", password: "Password1!" },
            { name: "ben", username: "ben@example.test", password: "Password1!" },
            { name: "mia", username: "mia@example.test", password: "Password1!" },
            { name: "ada", username: "ada@example.test", password: "Password1!" },
        ]);
        for (const r of [...shop, ...rbac]) {
            expect(Object.keys(r).sort()).toEqual(["name", "password", "username"]);
            expect(r.name).toMatch(ROLE_NAME);
            expect(r.name).not.toBe("main");
        }
        // No field of any defect reaches the platform this way (the catalogue's accounts only).
        const sent = JSON.stringify([shop, rbac]);
        for (const d of c.defects) {
            expect(sent).not.toContain(d.id);
            for (const k of ["expected", "actual", "impact", "preconditions", "category", "workflow"]) expect(sent, `${d.id} ${k}`).not.toContain(String((d as Record<string, unknown>)[k]));
        }
        expect(catalogueRoles([{ email: "9.Odd+Name@example.test", password: "p" }])[0]!.name).toMatch(ROLE_NAME);
    });
});

const f = (testKey: string, replay: BenchFinding["replay"], over: Partial<BenchFinding> = {}): BenchFinding => {
    const { category, defects } = categorize(replay);
    return { id: `id-${testKey}`, testKey, title: `Test ${testKey}`, source: "authoring", replay, category, defects, firstSeenAt: null, ...over };
};
const FINDINGS: BenchFinding[] = [
    f("WEB-001", { seeded: "failed", clean: "passed", single: { "BS-01": "failed", "BS-13": "passed" } }, { layer: "api" }),
    f("WEB-002", { seeded: "failed", clean: "passed", single: { "BS-01": "passed", "BS-13": "failed" } }, { layer: "page" }),
    f("WEB-003", { seeded: "failed", clean: "failed", single: {} }, { layer: "page" }),
    f("WEB-004", { seeded: "failed", clean: "failed", single: {} }, { reason: "Not reported as a finding: leftovers" }),
];
const inputs = { startedAt: "2026-11-21T10:00:00.000Z", cost: null, testsGenerated: 6, workflows: 5, workflowsCovered: 3, executionFailures: 0, flaky: 0, durationMs: 1000, aiCalls: 5, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, findings: FINDINGS, unreachable: ["BS-18"] };

describe("the extension score is apart from the original score", () => {
    it("a finding attributed to an extension seed counts in the extension score only; the original score is as without the extension", () => {
        const original = benchMetrics({ ...inputs, seeded: ["BS-01", "BS-09"] });
        const onlyOriginalFindings = benchMetrics({ ...inputs, seeded: ["BS-01", "BS-09"], findings: FINDINGS.filter((x) => !x.defects.includes("BS-13")) });
        expect([original.seeded, original.detected, original.missed, original.detectionRate]).toEqual([2, 1, 1, 0.5]);
        expect([onlyOriginalFindings.seeded, onlyOriginalFindings.detected]).toEqual([2, 1]);
        expect(extensionScore({ ...inputs, seeded: ["BS-13", "BS-18"] })).toEqual({ seeded: 2, detected: 1, missed: 1, detectedLabeled: 0, reachable: 1, detectionRate: 0.5 });
    });

    const result = (seeded: string[], catalogueVersion: string, extension?: Benchmark["extension"]): Benchmark => ({
        format: 1,
        scoring: 2,
        mode: "discovery",
        baseline: false,
        config: { engineCommit: "abc1234", engineDirty: false, prompts: [], model: { provider: "p", model: "m", fastModel: null, planningModel: null, temperature: "x" }, catalogueVersion, apps: [{ id: "bench-shop", version: "v" }], options: {}, prices: null, approvedBudget: null, dailyCallCap: null, resumes: 0, runtime: { node: "v24", platform: "linux" } },
        apps: [
            {
                id: "bench-shop",
                entryId: "bench-shop",
                status: "done",
                appVersion: "v",
                seededDefects: seeded,
                defects: seeded.map((id) => ({ id, category: "c", workflow: "w", severity: "high", detected: id === "BS-01" || id === "BS-13", labeledOnly: false, ...(id.startsWith("BS-1") && id !== "BS-10" ? { set: "extension" as const } : {}), findings: [] })),
                findings: FINDINGS,
                metrics: benchMetrics({ ...inputs, seeded: seeded.filter((id) => !["BS-13", "BS-18"].includes(id)) }),
                ...(extension ? { extension } : {}),
                layers: layerCounts(["api", "page", "page", undefined, "database", "api"], FINDINGS),
            },
        ],
        metrics: benchMetrics({ ...inputs, seeded: seeded.filter((id) => !["BS-13", "BS-18"].includes(id)) }),
        ...(extension ? { extension } : {}),
        notes: [],
    });
    const run = (b: Benchmark) => ({ format: 1, startedAt: "2026-11-21T10:00:00.000Z", finishedAt: "2026-11-21T11:00:00.000Z", benchmark: b }) as unknown as EvalRun;
    const ext = extensionScore({ ...inputs, seeded: ["BS-13", "BS-18"] });

    it("a rescore of a run with the extension gives the same original and extension scores; one without it has no extension score", () => {
        const withExt = result(["BS-01", "BS-09", "BS-13", "BS-18"], "2026-11-21.1 (abcdef012345)", ext);
        expect(BenchmarkSchema.safeParse(withExt).success).toBe(true);
        const r = rescored(withExt, ["BS-09", "BS-18"], ["BS-13", "BS-18"]);
        expect(r.apps[0]!.metrics.seeded).toBe(2);
        expect(r.metrics.detected).toBe(withExt.metrics.detected);
        expect(r.extension).toEqual(ext);
        expect(r.apps[0]!.extension).toEqual(ext);
        // A result of the original catalogue (Phase 3): the extension ids change nothing.
        const old = result(["BS-01", "BS-09"], "2026-11-14.1 (abcdef012345)");
        expect(rescored(old, ["BS-09"], ["BS-13", "BS-18"])).toEqual(rescored(old, ["BS-09"]));
        expect(rescored(old, ["BS-09"])).not.toHaveProperty("extension");
    });

    it("the report shows the extension score on a line of its own and marks the extension seeds; without the extension, no such line", () => {
        const withExt = result(["BS-01", "BS-13"], "2026-11-21.1 (abcdef012345)", ext);
        const md = benchMarkdown(withExt, run(withExt));
        expect(md).toContain("| Detected (confirmed by replay) | 1 |");
        expect(md).toContain("| Extension seeds (scored apart): detected | 1 of 2 (effective maximum 1; 50%) |");
        expect(md).toMatch(/\| BS-13 \(extension\) \|/);
        const old = result(["BS-01", "BS-09"], "2026-11-14.1 (x)");
        expect(benchMarkdown(old, run(old))).not.toMatch(/Extension seeds|\(extension\)/);
    });

    it("bench-report --rescore and --layers read a folder, print, and write nothing", async () => {
        const d = tmp();
        fs.writeFileSync(path.join(d, "a-benchmark-discovery.json"), JSON.stringify(run(result(["BS-01", "BS-09", "BS-13", "BS-18"], "2026-11-21.1 (abcdef012345)", ext))));
        const before = fs.readdirSync(d);
        const lines: string[] = [];
        expect(await benchReportMain(["--rescore", d], { log: (s) => lines.push(s) })).toBe(0);
        // 2026-11-21.1 lifts BS-09's unreachable mark: both original seeds are reachable (2 → 2). The base catalogue keeps it (2 → 1).
        expect(lines.join("\n")).toMatch(/\| [^|]*a-benchmark-discovery\.json \| v2 → v2 \| 1 → 1 \| 2 → 2 \|/);
        expect(lines.join("\n")).toMatch(/Extension seeds \(scored apart from the original ones\):[\s\S]*\| [^|]*a-benchmark-discovery\.json \| 1 → 1 \| 1 of 2 \|/);
        lines.length = 0;
        expect(await benchReportMain(["--layers", d], { log: (s) => lines.push(s) })).toBe(0);
        const out = lines.join("\n");
        expect(out).toContain("| api | 2 | 1 | 1 | 0 |");
        expect(out).toContain("| page | 2 | 2 | 1 | 1 |");
        expect(out).toContain("| database | 1 | 0 | 0 | 0 |");
        expect(out).toContain("| unlabelled | 1 | 1 | 0 | 0 |");
        expect(out).toContain("| BS-01 | original | yes | api |");
        expect(out).toContain("| BS-13 | extension | yes | page |");
        expect(out).toContain("| BS-18 | extension | no | - |");
        expect(out).toContain("Original seeds detected: 1 of 2. Extension seeds detected: 1 of 2.");
        expect(fs.readdirSync(d)).toEqual(before);
        const b = tmp();
        fs.writeFileSync(path.join(b, "b-benchmark-discovery.json"), JSON.stringify(run(result(["BS-01", "BS-09"], "2026-11-14.1 (abcdef012345)"))));
        lines.length = 0;
        expect(await benchReportMain(["--rescore", b], { log: (s) => lines.push(s) })).toBe(0);
        expect(lines.join("\n")).toMatch(/\| [^|]*b-benchmark-discovery\.json \| v2 → v2 \| 1 → 1 \| 2 → 1 \|/);
    });
});

describe("tests per layer", () => {
    it("counts tests, findings, confirmed findings and false positives per layer; a test without a layer is unlabelled; the engine's unreported tests are no false positives", () => {
        expect(layerCounts(["api", undefined], FINDINGS)).toEqual({
            api: { tests: 1, findings: 1, confirmed: 1, falsePositives: 0 },
            page: { tests: 0, findings: 2, confirmed: 1, falsePositives: 1 },
            unlabelled: { tests: 1, findings: 1, confirmed: 0, falsePositives: 0 },
        });
    });

    it("a result written before layers were recorded says so", () => {
        const b = { apps: [{ id: "bench-shop", status: "done", seededDefects: [], defects: [], findings: [] }] } as unknown as Benchmark;
        expect(layersMarkdown("t", b, { defects: [] })).toContain("Tests per layer: not available");
    });
});
