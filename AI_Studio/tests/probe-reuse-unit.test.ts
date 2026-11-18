/**
 * Reuse earlier runs (sheet #8 (a)) without a browser: which known page's probes are skipped, the spot checks, the "more than half
 * changed" rule, expiry after 30 days or 5 reuses, the AI model kept in site memory, journeys whose tests were written and not run, a
 * person's Run updating the memory, version 1 records, and project isolation. The browser crawl is in probe-reuse-crawl.test.ts and the
 * real jobs in probe-reuse-pipeline.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { distillKnowledge } from "../src/engine/memory/distill.js";
import { knownPagesOf, MAX_REUSES, PROBE_TTL_DAYS, ProbeReuse, sameProbes, probesOf, type KnownPages } from "../src/engine/memory/probe-reuse.js";
import { planReuse } from "../src/engine/memory/reuse.js";
import { MEMORY_VERSION } from "../src/engine/memory/types.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { loadMemory, noteRunInMemory, saveMemory } from "../src/platform/memory-store.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const page = (p: string, over: Partial<PageModel> = {}): PageModel => ({
    url: `http://shop.test${p}`,
    path: p,
    title: `Title of ${p}`,
    type: "content",
    depth: 1,
    status: 200,
    headings: [`Heading of ${p}`],
    forms: [{ purpose: "other", fields: [{ type: "email", name: "email", required: false, validation: { check: "type", message: `Bad e-mail on ${p}` } }] }],
    components: [{ role: "button", name: "More", locatorHint: "" }],
    links: [],
    aria: "",
    text: "",
    apiCalls: [],
    revealed: [`More → link "Hidden of ${p}"`],
    revealedLinks: [{ text: "Hidden", href: `http://shop.test/hidden${p}` }],
    interactions: [{ control: "More", method: "GET", path: `/api/more${p}` }],
    consoleErrors: [],
    discovery: 2,
    probedAt: daysAgo(1),
    reuses: 0,
    ...over,
});
const model = (pages: PageModel[], over: Partial<AppModel> = {}): AppModel => ({
    url: "http://shop.test/",
    origin: "http://shop.test",
    siteType: "shop",
    purpose: "Sells things",
    features: [],
    navigation: [],
    apis: [],
    pages,
    journeys: [],
    externalDependencies: [],
    documentedTestCases: [],
    authentication: { required: false, mechanisms: [], loggedIn: false },
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
    ...over,
});
/** The same page as read again now, before its probes (the probe results are not there yet). */
const fresh = (p: PageModel, over: Partial<PageModel> = {}): PageModel => {
    const copy: PageModel = JSON.parse(JSON.stringify(p));
    delete copy.probedAt;
    delete copy.reuses;
    copy.revealed = [];
    copy.revealedLinks = [];
    copy.interactions = [];
    for (const f of copy.forms) for (const x of f.fields) delete x.validation;
    return { ...copy, ...over };
};
const reuseOf = (known: KnownPages) => new ProbeReuse(known, (u) => u, () => NOW);
const PATHS = ["/", "/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h", "/i"];

describe("which known page's probes are skipped", () => {
    it("an unchanged page takes its earlier results and is marked as reused from then; a new page is probed", () => {
        const before = page("/a");
        const r = reuseOf(knownPagesOf(model([page("/"), before]))!);
        expect(r.decide(fresh(page("/"))).kind).toBe("spot"); // the first reusable page is always spot-checked
        const now = fresh(before);
        const d = r.decide(now);
        expect(d.kind).toBe("reuse");
        if (d.kind !== "reuse") return;
        const links = r.take(now, d.known);
        expect(links).toEqual(before.revealedLinks);
        expect(now.forms[0]!.fields[0]!.validation).toEqual(before.forms[0]!.fields[0]!.validation);
        expect(now.interactions).toEqual(before.interactions);
        expect(now.reusedFrom).toEqual({ at: before.probedAt });
        expect(now.reuses).toBe(1);
        expect(r.decide(fresh(page("/new"))).kind).toBe("probe");
    });

    it("a page whose structure or controls changed is probed again and counted as changed", () => {
        const r = reuseOf(knownPagesOf(model(PATHS.map((p) => page(p))))!);
        expect(r.decide(fresh(page("/a"), { headings: ["A new heading"] })).kind).toBe("probe");
        expect(r.decide(fresh(page("/b"), { components: [{ role: "button", name: "Less", locatorHint: "" }] })).kind).toBe("probe");
        expect(r.decide(fresh(page("/c"), { forms: [{ purpose: "other", fields: [{ type: "text", name: "phone", required: false }] }] })).kind).toBe("probe");
        expect(r.changedPaths).toEqual(["/a", "/b", "/c"]);
        expect(r.off).toBeUndefined();
    });

    it("every fifth reusable page (the first always) is a spot check: 20%", () => {
        const r = reuseOf(knownPagesOf(model(PATHS.map((p) => page(p))))!);
        const kinds = PATHS.map((p) => r.decide(fresh(page(p))).kind);
        expect(kinds).toEqual(["spot", "reuse", "reuse", "reuse", "reuse", "spot", "reuse", "reuse", "reuse", "reuse"]);
    });

    it("a spot check that finds anything different turns reuse off for the rest of the run", () => {
        const r = reuseOf(knownPagesOf(model(PATHS.map((p) => page(p))))!);
        const home = fresh(page("/"));
        const d = r.decide(home);
        expect(d.kind).toBe("spot");
        if (d.kind !== "spot") return;
        // Probed now: the validation message changed behind the same field (the fingerprints cannot see that).
        home.revealed = page("/").revealed;
        home.revealedLinks = page("/").revealedLinks;
        home.interactions = page("/").interactions;
        home.forms[0]!.fields[0]!.validation = { check: "type", message: "Please give a real e-mail" };
        expect(r.check(home, d.known)).toBe(false);
        expect(r.off).toMatch(/spot check of \/ found it behaves differently/);
        for (const p of PATHS.slice(1)) expect(r.decide(fresh(page(p))).kind).toBe("probe");
    });

    it("a spot check that finds the same lets reuse go on", () => {
        const r = reuseOf(knownPagesOf(model(PATHS.map((p) => page(p))))!);
        const home = fresh(page("/"));
        const d = r.decide(home);
        if (d.kind !== "spot") throw new Error("expected a spot check");
        Object.assign(home, { revealed: [...page("/").revealed].map((x) => x.replace("Hidden", "hidden")), revealedLinks: page("/").revealedLinks, interactions: page("/").interactions });
        home.forms[0]!.fields[0]!.validation = page("/").forms[0]!.fields[0]!.validation;
        expect(r.check(home, d.known)).toBe(true);
        expect(r.off).toBeUndefined();
        expect(r.decide(fresh(page("/a"))).kind).toBe("reuse");
    });

    it("more than half of the known pages changed: reuse is off for the run; exactly half is not", () => {
        const known = knownPagesOf(model(PATHS.map((p) => page(p))))!; // 10 known pages
        const half = reuseOf(known);
        for (const p of PATHS.slice(0, 5)) half.decide(fresh(page(p), { headings: ["Changed"] }));
        expect(half.off).toBeUndefined();
        expect(half.decide(fresh(page("/f"))).kind).toBe("spot");

        const more = reuseOf(known);
        for (const p of PATHS.slice(0, 6)) more.decide(fresh(page(p), { headings: ["Changed"] }));
        expect(more.off).toMatch(/more than half of the 10 known pages changed/);
        expect(more.decide(fresh(page("/g"))).kind).toBe("probe");
        expect(more.decide(fresh(page("/h"))).kind).toBe("probe");
    });

    it(`results older than ${PROBE_TTL_DAYS} days, or reused ${MAX_REUSES} runs in a row, are found again`, () => {
        const pages = [page("/", { probedAt: daysAgo(PROBE_TTL_DAYS + 1) }), page("/a", { reuses: MAX_REUSES }), page("/b", { probedAt: daysAgo(PROBE_TTL_DAYS - 1), reuses: MAX_REUSES - 1 }), page("/c")];
        const r = reuseOf(knownPagesOf(model(pages))!);
        expect(r.decide(fresh(pages[0]!)).kind).toBe("probe");
        expect(r.decide(fresh(pages[1]!)).kind).toBe("probe");
        expect(r.expired).toBe(2);
        expect(r.decide(fresh(pages[2]!)).kind).toBe("spot");
        const c = fresh(pages[3]!);
        const d = r.decide(c);
        if (d.kind !== "reuse") throw new Error("expected reuse");
        r.take(c, d.known);
        expect(c.reuses).toBe(1);
        // The day of the last real probe travels with the page, so the 30 days count from it, not from the last reuse.
        expect(c.probedAt).toBe(pages[3]!.probedAt);
    });

    it("pages from crawls that did not date their probes, error pages and older crawls are not known", () => {
        const k = knownPagesOf(model([page("/"), page("/old", { probedAt: undefined }), page("/v1", { discovery: undefined }), page("/err", { type: "error" }), page("/404", { status: 404 })]))!;
        expect(k.pages.map((p) => p.path)).toEqual(["/"]);
        expect(knownPagesOf(null)).toBeUndefined();
        expect(knownPagesOf(model([page("/x", { probedAt: undefined })]))).toBeUndefined();
    });

    it("a reused page brings the endpoints its menus called; the seeds keep the depth and the way the page was reached", () => {
        const apis = [
            { method: "GET", path: "/api/more/a", origin: "http://shop.test", statuses: [200], queryParams: [], source: "network" as const, usedIn: ["/a"] },
            { method: "GET", path: "/api/other", origin: "http://shop.test", statuses: [200], queryParams: [], source: "network" as const, usedIn: ["/b"] },
        ];
        const k = knownPagesOf(model([page("/"), page("/a", { depth: 2 })], { apis, navigation: [{ from: "/", to: "/a", label: "Page a" }] }))!;
        expect(k.pages[1]!.apis.map((a) => a.path)).toEqual(["/api/more/a"]);
        const r = reuseOf(k);
        expect(r.seeds()).toEqual([
            { url: "http://shop.test/", depth: 1 },
            { url: "http://shop.test/a", depth: 2, via: { from: "/", label: "Page a" } },
        ]);
        r.decide(fresh(page("/")));
        const a = fresh(page("/a", { depth: 2 }));
        const d = r.decide(a);
        if (d.kind !== "reuse") throw new Error("expected reuse");
        r.take(a, d.known);
        expect(r.reusedApis().map((x) => x.path)).toEqual(["/api/more/a"]);
    });

    it("the crawl does not start from sign-in or sign-up pages (the sign-in and the signed-out pass read those)", () => {
        const r = reuseOf(knownPagesOf(model([page("/"), page("/login", { type: "login" }), page("/register", { type: "register" }), page("/a")]))!);
        expect(r.seeds().map((x) => x.url)).toEqual(["http://shop.test/", "http://shop.test/a"]);
    });

    it("probe results compare equal with numbers, spacing and order blurred, and differ on any real difference", () => {
        const a = probesOf(page("/a"));
        expect(sameProbes(a, probesOf(page("/a", { revealed: ["More  →  link \"Hidden of /a\""] })))).toBe(true);
        expect(sameProbes(probesOf(page("/a", { revealed: ["3 new items"] })), probesOf(page("/a", { revealed: ["12 new items"] })))).toBe(true);
        expect(sameProbes(a, probesOf(page("/a", { revealedLinks: [] })))).toBe(false);
        expect(sameProbes(a, probesOf(page("/a", { interactions: [] })))).toBe(false);
        const cond = page("/a");
        cond.forms[0]!.conditional = [{ when: "Kind = Business", shows: ["Company"] }];
        expect(sameProbes(a, probesOf(cond))).toBe(false);
    });
});

describe("the AI model in site memory", () => {
    const seen = model([page("/", { purpose: "The front page" }), page("/a", { purpose: "Page a" })]);
    it("memory names the model that understood each page (version 2)", () => {
        const k = distillKnowledge(seen, { modelName: "model-one" });
        expect(k.version).toBe(2);
        expect(MEMORY_VERSION).toBe(2);
        expect(k.pages.map((p) => p.model)).toEqual(["model-one", "model-one"]);
    });
    it("the same model reuses the understanding of unchanged pages; another model, or none recorded, reads them again", () => {
        const k = distillKnowledge(seen, { modelName: "model-one" });
        expect(planReuse(k, seen, [], "model-one").pages.size).toBe(2);
        expect(planReuse(k, seen, [], "model-two").pages.size).toBe(0);
        expect(planReuse(distillKnowledge(seen), seen, [], "model-one").pages.size).toBe(0);
    });
});

describe("journeys and tests that were written, not run", () => {
    const m = model([page("/"), page("/a")], { journeys: [{ name: "Browse", description: "d", steps: ["s"], priority: "high", pages: ["/a"], requiresAuth: false }] });
    const previous = distillKnowledge(m, { scenarios: [{ title: "Browse page a", journey: "Browse", startPath: "/a", validated: true }] });
    it("a journey whose test was written and not run keeps its validated tests", () => {
        const k = distillKnowledge(m, { previous, scenarios: [{ title: "Browse page a", journey: "Browse", startPath: "/a", validated: false, ran: false }] });
        expect(k.journeys[0]!.validated).toEqual(["Browse page a"]);
    });
    it("with another journey's test run, a journey whose own test was only written still keeps its validated tests", () => {
        const two = model([page("/"), page("/a")], {
            journeys: [
                { name: "Browse", description: "d", steps: ["s"], priority: "high", pages: ["/a"], requiresAuth: false },
                { name: "Home", description: "d", steps: ["s"], priority: "low", pages: ["/"], requiresAuth: false },
            ],
        });
        const before = distillKnowledge(two, { scenarios: [{ title: "Browse page a", journey: "Browse", startPath: "/a", validated: true }] });
        const k = distillKnowledge(two, {
            previous: before,
            scenarios: [
                { title: "Browse page a", journey: "Browse", startPath: "/a", validated: false, ran: false },
                { title: "Open home", journey: "Home", startPath: "/", validated: true, ran: true },
            ],
        });
        expect(k.journeys.map((j) => [j.name, j.validated])).toEqual([
            ["Browse", ["Browse page a"]],
            ["Home", ["Open home"]],
        ]);
    });
    it("a journey whose test ran and failed loses it", () => {
        const k = distillKnowledge(m, { previous, scenarios: [{ title: "Browse page a", journey: "Browse", startPath: "/a", validated: false, ran: true }] });
        expect(k.journeys[0]!.validated).toEqual([]);
    });
});

describe("site memory storage: a person's Run, version 1 records, projects", () => {
    let platform: Platform;
    let dir: string;
    const ORIGIN = "http://shop.test";
    const m = model([page("/"), page("/a")], {
        journeys: [
            { name: "Browse", description: "d", steps: ["s"], priority: "high", pages: ["/a"], requiresAuth: false },
            { name: "Contact", description: "d", steps: ["s"], priority: "low", pages: ["/"], requiresAuth: false },
        ],
    });
    beforeAll(() => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-probe-reuse-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
    });
    afterAll(() => {
        platform.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const newProject = (name: string) => (platform.repo.createProject({ name }) as { id: string }).id;

    it("a Run adds the journey tests that passed and takes off those that failed; tests of no journey change nothing", () => {
        const p = newProject("run");
        saveMemory(platform.db, { projectId: p, knowledge: distillKnowledge(m, { scenarios: [{ title: "Send the contact form", journey: "Contact", startPath: "/", validated: true }] }), changes: null });
        const r = noteRunInMemory(platform.db, {
            projectId: p,
            origin: ORIGIN,
            jobId: "job-1",
            results: [
                { title: "Browse page a", journey: "Browse", startPath: "/a", passed: true },
                { title: "Send the contact form", journey: "Contact", startPath: "/", passed: false },
                { title: "Something else", journey: "Unknown", startPath: "/zzz", passed: true },
            ],
        });
        expect(r).toEqual({ validated: 1, noLonger: 1 });
        const k = loadMemory(platform.db, p, ORIGIN).knowledge!;
        expect(k.journeys.find((j) => j.name === "Browse")!.validated).toEqual(["Browse page a"]);
        expect(k.journeys.find((j) => j.name === "Contact")!.validated).toEqual([]);
        expect(k.validationKnown).toBe(true);
        expect(platform.db.get<{ job_id: string }>("SELECT job_id FROM site_memory WHERE project_id = ?", p)!.job_id).toBe("job-1");
    });

    it("a Run never creates a memory, never reaches another project's, and scrubs what it stores", () => {
        const a = newProject("a");
        const b = newProject("b");
        saveMemory(platform.db, { projectId: a, knowledge: distillKnowledge(m), changes: null });
        expect(noteRunInMemory(platform.db, { projectId: b, origin: ORIGIN, jobId: "job-b", results: [{ title: "Browse page a", journey: "Browse", startPath: "/a", passed: true }] })).toBeNull();
        expect(loadMemory(platform.db, b, ORIGIN).knowledge).toBeNull();
        expect(loadMemory(platform.db, a, ORIGIN).knowledge!.journeys[0]!.validated).toEqual([]);
        noteRunInMemory(platform.db, { projectId: a, origin: ORIGIN, jobId: "job-a", results: [{ title: "Sign in as pat@example.test with Hunter-22", journey: "Browse", startPath: "/a", passed: true }], secrets: ["Hunter-22"] });
        expect(JSON.stringify(loadMemory(platform.db, a, ORIGIN).knowledge)).not.toMatch(/pat@example|Hunter-22/);
    });

    it("a version 1 record is read as version 2 whose pages name no model (so their understanding is read again)", () => {
        const p = newProject("v1");
        const k = distillKnowledge(m, { modelName: "model-one" });
        saveMemory(platform.db, { projectId: p, knowledge: k, changes: null });
        const v1 = { ...k, version: 1, pages: k.pages.map(({ model: _m, ...rest }) => rest) };
        platform.db.run("UPDATE site_memory SET version = 1, knowledge_json = ? WHERE project_id = ?", JSON.stringify(v1), p);
        const loaded = loadMemory(platform.db, p, ORIGIN);
        expect(loaded.warning).toBeUndefined();
        expect(loaded.knowledge!.version).toBe(2);
        expect(planReuse(loaded.knowledge!, m, [], "model-one").pages.size).toBe(0);
    });
});
