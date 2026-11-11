/**
 * The in-app guide, without a browser: search, the Help panel's text for every place, how a place in the guide opens in the app,
 * and the tour's steps. The written topics and words belong to tests/guide-content.test.ts; here they are only used as real data.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { CASES_SECTIONS, LIBRARY_SECTIONS, RELEASE_SECTIONS, RUNS_SECTIONS, SCRIPTS_SECTIONS, SETTINGS_SECTIONS, SETUP_SECTIONS, routes } from "../web/src/lib/router.js";
import { glossary, topics, wants } from "../web/src/features/guide/content/index.js";
import { PLACE_IDS, PLACES, placeOf, type PlaceId } from "../web/src/features/guide/places.js";
import { editDistance, searchGuide, stem, tokens } from "../web/src/features/guide/search.js";
import { CHAPTERS, NO_PROJECT_STEP, TOUR_STEPS, chaptersOf, counter, nextChapterStart, onPage, pageHref, stepsFor, type TourHave } from "../web/src/features/guide/tour-steps.js";
import { SECTIONS_OF, needsProject, whereToHref } from "../web/src/features/guide/where.js";
import type { GlossaryEntry, Topic, WhereTo } from "../web/src/features/guide/types.js";

const WEB = path.join(REPO_ROOT, "web", "src");

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
}
const files = walk(WEB).map((p) => ({ p: p.replace(/\\/g, "/"), text: fs.readFileSync(p, "utf8") }));
/** Everything the screens say, outside the guide itself (the guide's own files would make every check pass by naming themselves). */
const screenText = files.filter((f) => !f.p.includes("/features/guide/")).map((f) => f.text).join("\n");

/** A route from an address such as `#/projects/p1/runs?section=trends`. */
function route(href: string) {
    // A place inside a page (`#/settings#runner`) is not part of the route, as in lib/router.ts.
    const [pathPart, qs] = href.replace(/^#/, "").split("#")[0]!.split("?");
    return { parts: pathPart!.split("/").filter(Boolean), query: new URLSearchParams(qs ?? "") };
}

// ── search ──────────────────────────────────────────────────────────────────

describe("guide search", () => {
    const fixtureTopics: Topic[] = [
        { id: "alpha", group: "running", title: "Run tests every night", what: "Tests run by themselves on a timetable.", why: "Wake up to results.", steps: [{ text: "Open Schedules." }], keywords: ["nightly", "cron", "timetable"] },
        { id: "beta", group: "running", title: "Run tests now", what: "Start one run right away.", why: "See results at once.", steps: [{ text: "Choose Run." }], keywords: ["start", "execute"] },
        { id: "gamma", group: "checks", title: "Check accessibility", what: "Find pages people with disabilities cannot use.", why: "Reach everyone.", steps: [{ text: "Tick accessibility when you explore." }], keywords: ["screen reader", "contrast"] },
        { id: "delta", group: "one-test", title: "Stop a flaky test from raising alarms", what: "Hold back a test that passes and fails on the same code.", why: "Fewer false alarms.", steps: [{ text: "Choose Quarantine." }], keywords: ["unreliable", "keeps failing"] },
    ];
    const fixtureWords: GlossaryEntry[] = [{ id: "flaky", term: "Flaky", meaning: "A test that passes one time and fails the next on the same code.", alsoCalled: ["unstable"] }];
    const top = (q: string) => searchGuide(q, fixtureTopics, fixtureWords)[0];

    it("trims plurals and endings, drops small words, and measures typos", () => {
        expect(stem("tests")).toBe("test");
        expect(stem("schedules")).toBe("schedule");
        expect(stem("pages")).toBe("page");
        expect(stem("accessibility")).toBe("accessibility");
        expect(tokens("How do I run the tests?")).toEqual(["run", "test"]);
        expect(editDistance("schedule", "scheduel")).toBe(2);
        expect(editDistance("night", "light", 1)).toBe(1);
        expect(editDistance("abc", "abcdefgh", 2)).toBeGreaterThan(2);
    });

    it("finds a topic from a question in the person's own words", () => {
        expect(top("how do I run tests every night")?.id).toBe("alpha");
        expect(top("run tests now")?.id).toBe("beta");
    });

    it("does not mind case, plurals or a word that is only the start of another", () => {
        expect(top("NIGHT")?.id).toBe("alpha");
        expect(top("Accessibility checks")?.id).toBe("gamma");
        expect(top("nightl")?.id).toBe("alpha");
    });

    it("forgives a typo or two in a longer word, but not in a short one", () => {
        expect(top("acessibility")?.id).toBe("gamma");
        expect(top("quarantnie")?.id).toBe("delta");
        // "nigth" is five letters with two letters swapped: too far from "night" to be trusted.
        expect(searchGuide("zzq", fixtureTopics, fixtureWords)).toEqual([]);
    });

    it("ranks a title or keyword hit above a hit in running text", () => {
        const hits = searchGuide("results", fixtureTopics, fixtureWords);
        expect(hits.map((h) => h.id)).toContain("alpha");
        const keyword = searchGuide("timetable", fixtureTopics, fixtureWords);
        expect(keyword[0]?.id).toBe("alpha");
        const title = searchGuide("flaky", fixtureTopics, fixtureWords);
        // The word itself and the topic named after it are both found; the topic that only mentions "keeps failing" comes with them.
        expect(title.map((h) => h.id)).toEqual(expect.arrayContaining(["flaky", "delta"]));
    });

    it("finds a word by an older name, and tells words from topics", () => {
        const hit = searchGuide("unstable", fixtureTopics, fixtureWords)[0];
        expect(hit).toMatchObject({ kind: "word", id: "flaky" });
    });

    it("returns nothing for nothing and for gibberish", () => {
        expect(searchGuide("", fixtureTopics, fixtureWords)).toEqual([]);
        expect(searchGuide("   ", fixtureTopics, fixtureWords)).toEqual([]);
        expect(searchGuide("how do i", fixtureTopics, fixtureWords)).toEqual([]);
        expect(searchGuide("qqxzv", fixtureTopics, fixtureWords)).toEqual([]);
    });

    it("answers real questions with the real topics", () => {
        const ask = (q: string) => searchGuide(q, topics, glossary).filter((h) => h.kind === "topic").map((h) => h.id);
        expect(ask("run tests every night").slice(0, 3)).toContain("schedules");
        expect(ask("a flaky test keeps failing").slice(0, 4)).toContain("quarantine");
        expect(ask("stop a run").slice(0, 3)).toContain("stop-a-run");
        expect(ask("scheduel")).toContain("schedules");
    });

    it("gives every topic a way to be found by its own title", () => {
        for (const t of topics) {
            const ids = searchGuide(t.title, topics, glossary, 5).map((h) => h.id);
            expect(ids, `"${t.title}"`).toContain(t.id);
        }
    });
});

// ── place help ──────────────────────────────────────────────────────────────

describe("place help covers every place in the router", () => {
    const expected: Array<[string, PlaceId]> = [
        [routes.home, "projects"],
        [routes.newProject(), "new-project"],
        [routes.newProject({ project: "p1" }), "new-project"],
        [routes.project("p1"), "overview"],
        // Round 38: the runnable tests are the Test scripts list; Test cases holds the written cases.
        [routes.tests("p1"), "scripts"],
        [routes.cases("p1"), "tests"],
        [routes.runs("p1"), "runs-runs"],
        [routes.run("p1", "j1"), "run-detail"],
        [routes.schedule("p1"), "runs-schedules"],
        // Round 45: every runner link is Your runner in Settings.
        [routes.allRunners, "settings"],
        ["#/runners", "runners-global"],
        [routes.objects("p1"), "library-elements"],
        [routes.blocks("p1"), "library-steps"],
        [routes.blocks("p1", "Sign in"), "library-steps-edit"],
        [routes.helpers("p1"), "library-helpers"],
        [routes.record("p1"), "recorder"],
        [routes.record("p1", "s1"), "recorder"],
        [routes.compliance("p1"), "release-compliance"],
        [routes.releases("p1"), "release-releases"],
        [routes.release("p1", "r1"), "release-detail"],
        [routes.manualCases("p1"), "release-manual"],
        [routes.test("t1"), "test-steps"],
        [routes.testTab("t1", "steps"), "test-steps"],
        [routes.testTab("t1", "text"), "test-text"],
        [routes.testTab("t1", "code"), "test-code"],
        [routes.testTab("t1", "history"), "test-history"],
        [routes.code("t1", { history: true }), "test-code"],
        [routes.builder("t1"), "test-steps"],
        [routes.writeCode("p1", { title: "x", kind: "web" }), "write-code"],
        [routes.settings, "settings"],
        [routes.guide, "guide"],
        [routes.guideTopic("schedules"), "guide-topic"],
        [routes.guideWords, "guide-words"],
    ];
    it.each(expected)("%s is the place %s", (href, id) => {
        expect(placeOf(route(href))).toBe(id);
        expect(PLACES[id], id).toBeDefined();
    });

    it("has help for every section of every hub the router lists", () => {
        for (const s of RUNS_SECTIONS) expect(PLACES[placeOf(route(routes.runs("p1", s)))], `runs ${s}`).toBeDefined();
        for (const s of LIBRARY_SECTIONS) expect(PLACES[placeOf(route(routes.library("p1", s)))], `library ${s}`).toBeDefined();
        for (const s of RELEASE_SECTIONS) expect(PLACES[placeOf(route(routes.releaseHub("p1", s)))], `release ${s}`).toBeDefined();
        for (const s of SETUP_SECTIONS) expect(PLACES[placeOf(route(routes.setup("p1", s)))], `setup ${s}`).toBeDefined();
        // An unknown section opens the first one (as the page does), so it never has a place of its own.
        expect(placeOf(route("#/projects/p1/setup?section=nonsense"))).toBe("setup-runners");
    });

    it("has help for every route the app's page switch knows", () => {
        const main = files.find((f) => f.p.endsWith("/web/src/main.tsx"))!.text;
        const pages = main.slice(main.indexOf("function Pages()"), main.indexOf("function App()"));
        const first = new Set([...pages.matchAll(/\ba === "([a-z-]+)"/g)].map((m) => m[1]!));
        const third = new Set([...pages.matchAll(/\bc === "([a-z-]+)"/g)].map((m) => m[1]!));
        expect(first.size).toBeGreaterThanOrEqual(5);
        expect(third.size).toBeGreaterThanOrEqual(6);
        for (const a of first) {
            if (a === "projects") continue;
            const id = placeOf({ parts: [a, "x"], query: new URLSearchParams() });
            expect(PLACES[id], `/${a}`).toBeDefined();
            // Not the fallback: a route that is not in `placeOf` falls back to the projects list.
            if (a !== "") expect(id, `/${a} has a place of its own`).not.toBe("projects");
        }
        for (const c of third) {
            const id = placeOf({ parts: ["projects", "p1", c], query: new URLSearchParams() });
            expect(PLACES[id], `/projects/:id/${c}`).toBeDefined();
            // The fallback of a project route is the overview, so a new route without help would land there.
            expect(id, `/projects/:id/${c} has a place of its own`).not.toBe("overview");
        }
    });

    it("lists exactly the places the type says, none empty", () => {
        expect(new Set(PLACE_IDS).size).toBe(PLACE_IDS.length);
        expect(PLACE_IDS.length).toBeGreaterThanOrEqual(35);
        for (const id of PLACE_IDS) {
            const p = PLACES[id];
            expect(p.title.length, id).toBeGreaterThan(2);
            expect(p.what.length, id).toBeGreaterThan(20);
            expect(p.canDo.length, id).toBeGreaterThanOrEqual(3);
            expect(p.canDo.length, id).toBeLessThanOrEqual(6);
            expect(p.next.length, id).toBeGreaterThanOrEqual(1);
            expect(p.next.length, id).toBeLessThanOrEqual(2);
            expect(p.words.length, id).toBeGreaterThanOrEqual(1);
        }
    });
});

describe("place help uses real topics, words, places and on-screen names", () => {
    const topicIds = new Set(topics.map((t) => t.id));
    const wordIds = new Set(glossary.map((g) => g.id));
    const targets = PLACE_IDS.flatMap((id) => [...PLACES[id].canDo.map((a) => ({ id, to: a.to })), ...PLACES[id].next.map((n) => ({ id, to: n.to }))]);

    it("only points at topics that exist, and at real sections of real places", () => {
        for (const { id, to } of targets) {
            if ("topic" in to) expect(topicIds.has(to.topic), `${id}: topic ${to.topic}`).toBe(true);
            else if ("where" in to) {
                const w = to.where;
                if (w.section) expect(SECTIONS_OF[w.place]?.includes(w.section), `${id}: ${w.place}/${w.section}`).toBe(true);
                expect(whereToHref(w, "p1"), `${id}: ${w.place}`).toMatch(/^#\//);
            } else if ("search" in to) expect(to.search.length, id).toBeGreaterThan(3);
            else expect(["steps", "text", "code", "history"]).toContain(to.testTab);
        }
        for (const id of PLACE_IDS) {
            const t = PLACES[id].topic;
            if (t) expect(topicIds.has(t), `${id}: main topic ${t}`).toBe(true);
            for (const w of PLACES[id].words) expect(wordIds.has(w), `${id}: word ${w}`).toBe(true);
        }
    });

    it("writes every button, tab and menu name exactly as it is on screen", () => {
        let checked = 0;
        for (const id of PLACE_IDS) {
            const p = PLACES[id];
            const names = [...(p.ui ?? []), ...p.canDo.flatMap((a) => a.ui ?? []), ...p.next.flatMap((n) => n.ui ?? [])];
            for (const n of names) {
                checked++;
                expect(screenText.includes(n), `${id}: "${n}" is not on any screen`).toBe(true);
            }
            // A name written in the sentence is listed, so it is checked: anything the text says a person can "choose" or "open" in quotes.
            for (const a of p.canDo) for (const n of a.ui ?? []) expect(`${a.text} ${a.button}`.includes(n), `${id}: "${n}" is listed but not used in "${a.text}"`).toBe(true);
        }
        expect(checked).toBeGreaterThan(40);
    });

    it("lists the names the text tells the person to choose", () => {
        // Anything after "Choose" up to the end of the clause must be a listed on-screen name, so a typo in a button name cannot slip through.
        for (const id of PLACE_IDS) {
            for (const a of PLACES[id].canDo) {
                const m = a.text.match(/^Choose (.+)$/);
                if (m) expect((a.ui ?? []).some((n) => m[1]!.startsWith(n)), `${id}: "${a.text}" does not start with a listed name`).toBe(true);
            }
        }
    });

    const BANNED = /\b(seamless|seamlessly|leverage|unlock|empower|cutting-edge|game-changing)\b/i;
    const JARGON = /\b(spec|specs|adapter|adapters|endpoint|endpoints|selector|selectors|DOM|CI|assertion|assertions|headless|regression|locator|locators)\b/;
    const EMOJI = /\p{Extended_Pictographic}/u;
    const allText = () => PLACE_IDS.flatMap((id) => [PLACES[id].title, PLACES[id].what, ...PLACES[id].canDo.flatMap((a) => [a.text, a.button]), ...PLACES[id].next.flatMap((n) => [n.text, n.button])].map((t) => ({ id, t })));

    it("is plain language: short sentences, no jargon, no banned words, no emoji, no exclamation marks", () => {
        for (const { id, t } of allText()) {
            expect(t, id).not.toMatch(BANNED);
            expect(t, id).not.toMatch(JARGON);
            expect(EMOJI.test(t), `${id}: ${t}`).toBe(false);
            expect(t.includes("!"), `${id}: ${t}`).toBe(false);
            expect(t.includes(" · "), `${id}: ${t}`).toBe(false);
            for (const s of t.split(/(?<=[.?])\s+/)) expect(s.split(/\s+/).length, `${id}: "${s}"`).toBeLessThanOrEqual(30);
        }
    });

    it("uses the decided words and not the retired ones", () => {
        const retired = /\b(validated|validation|needs review|analysis|re-validation|objects?|locators?|runbook|hand-written|healing|specification|scenario|block|blocks)\b/i;
        for (const { id, t } of allText()) expect(t, `${id}: ${t}`).not.toMatch(retired);
    });

    it("starts every button with a verb, in sentence case", () => {
        for (const id of PLACE_IDS) {
            for (const b of [...PLACES[id].canDo.map((a) => a.button), ...PLACES[id].next.map((n) => n.button)]) {
                expect(b, `${id}: ${b}`).toMatch(/^(Read|Open|Show|Start|Back) /);
                expect(b.length, b).toBeLessThanOrEqual(60);
            }
        }
    });
});

// ── opening places from the guide ───────────────────────────────────────────

describe("WhereTo opens the right place", () => {
    const P = "p1";
    const cases: Array<[WhereTo, string | null, string | null]> = [
        [{ place: "projects" }, routes.home, routes.home],
        [{ place: "new-project" }, routes.newProject(), routes.newProject()],
        [{ place: "settings" }, routes.settings, routes.settings],
        [{ place: "overview" }, null, routes.project(P)],
        [{ place: "tests" }, null, routes.tests(P)],
        [{ place: "runs" }, null, routes.runs(P)],
        [{ place: "runs", section: "schedules" }, null, routes.runs(P, "schedules")],
        [{ place: "runs", section: "deploys" }, null, routes.runs(P, "deploys")],
        [{ place: "runs", section: "trends" }, null, routes.runs(P, "trends")],
        [{ place: "library" }, null, routes.library(P)],
        [{ place: "library", section: "elements" }, null, routes.library(P, "elements")],
        [{ place: "library", section: "accounts" }, null, routes.library(P, "accounts")],
        [{ place: "release", section: "manual" }, null, routes.releaseHub(P, "manual")],
        [{ place: "setup", section: "alerts" }, null, routes.setup(P, "alerts")],
        [{ place: "setup", section: "storage" }, null, routes.setup(P, "storage")],
    ];
    it.each(cases)("%j with no project and with one", (where, without, withProject) => {
        expect(whereToHref(where, undefined)).toBe(without);
        expect(whereToHref(where, P)).toBe(withProject);
        expect(needsProject(where)).toBe(without === null);
    });

    it("opens a place's first section for an unknown one, and the sections the router lists", () => {
        expect(whereToHref({ place: "setup", section: "nope" }, P)).toBe(routes.setup(P));
        for (const s of SETUP_SECTIONS) expect(placeOf(route(whereToHref({ place: "setup", section: s }, P)!))).toBe(s === "runners" ? "settings" : `setup-${s}`);
        // Releases and compliance moved from the Release place into Runs (round 25); they keep the help they had there.
        for (const s of RUNS_SECTIONS) expect(placeOf(route(whereToHref({ place: "runs", section: s }, P)!))).toBe(s === "releases" || s === "compliance" ? `release-${s}` : `runs-${s}`);
        for (const s of LIBRARY_SECTIONS) expect(placeOf(route(whereToHref({ place: "library", section: s }, P)!))).toBe(`library-${s}`);
        for (const s of RELEASE_SECTIONS) expect(placeOf(route(whereToHref({ place: "release", section: s }, P)!))).toBe(`release-${s}`);
    });

    it("opens every topic's own 'Open it in the app' button in a place that has help", () => {
        let n = 0;
        for (const t of topics) {
            if (!t.open) continue;
            n++;
            const sec = t.open.to.section;
            if (sec) expect(SECTIONS_OF[t.open.to.place]?.includes(sec), `${t.id}: ${t.open.to.place}/${sec}`).toBe(true);
            const href = whereToHref(t.open.to, P);
            expect(href, t.id).toMatch(/^#\//);
            expect(PLACES[placeOf(route(href!))], t.id).toBeDefined();
        }
        expect(n).toBeGreaterThan(20);
    });

    it("has a topic for every 'I want to' goal, and every topic can be reached from a group", () => {
        const ids = new Set(topics.map((t) => t.id));
        for (const w of wants) expect(ids.has(w.topic), w.text).toBe(true);
    });
});

// ── the tour ────────────────────────────────────────────────────────────────

describe("the tour", () => {
    const ALL: TourHave = { project: "p1", test: "t1", failing: "t2", job: "j1", release: "r1", phone: true, module: true, security: true, account: true };
    const WEB: TourHave = { project: "p1", test: "t1", job: "j1", release: "r1" };
    const ids = (h: TourHave) => stepsFor(h).map((s) => s.id);

    it("has at least 30 steps with unique ids, in the seven chapters in order, with short plain text", () => {
        expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(30);
        expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
        expect(CHAPTERS.map((c) => c.title)).toEqual(["Getting around", "Making tests", "Running and results", "Release and settings", "Phones", "Security assessment", "Help"]);
        // Chapters never interleave: each one is a single run of steps, in the chapter list's order.
        const order = CHAPTERS.map((c) => c.id);
        const seen = TOUR_STEPS.map((s) => order.indexOf(s.chapter));
        expect(seen).toEqual([...seen].sort((a, b) => a - b));
        for (const c of CHAPTERS) expect(TOUR_STEPS.some((s) => s.chapter === c.id), c.id).toBe(true);
        const retired = /\b(validated|validation|needs review|analysis|re-validation|objects?|locators?|runbook|hand-written|healing|specification|scenario|block|blocks)\b/i;
        for (const s of [...TOUR_STEPS, NO_PROJECT_STEP]) {
            expect(s.title.split(/\s+/).length, s.id).toBeLessThanOrEqual(8);
            expect(s.text.split(/(?<=\.)\s+/).length, s.id).toBeLessThanOrEqual(2);
            for (const sentence of s.text.split(/(?<=\.)\s+/)) expect(sentence.split(/\s+/).length, `${s.id}: ${sentence}`).toBeLessThanOrEqual(30);
            expect(`${s.title} ${s.text}`, s.id).not.toMatch(/!|seamless|leverage|unlock|empower|cutting-edge|game-changing/i);
            expect(`${s.title} ${s.text}`, s.id).not.toMatch(/\b(spec|adapter|endpoint|selector|DOM|assertion|headless)\b/);
            expect(`${s.title} ${s.text}`, s.id).not.toMatch(retired);
        }
    });

    it("covers what the brief asks for in each chapter", () => {
        const of = (c: string) => TOUR_STEPS.filter((s) => s.chapter === c).map((s) => s.target ?? s.id);
        expect(of("around")).toEqual(expect.arrayContaining(["nav-dashboard", "nav-projects", "nav-agents", "nav-develop", "nav-libraries", "nav-settings", "nav-help", "nav-account", "tab-overview", "tab-requirements", "tab-tests", "tab-scripts", "tab-suites", "tab-runs", "tab-settings"]));
        expect(of("making")).toEqual(expect.arrayContaining(["new-test", "wb-steps", "wb-text", "wb-code", "wb-history", "wb-edit", "scripts-steps", "scripts-elements", "settings-data"]));
        // Round 38: the New test script menu no longer records, so its tour has one card fewer (the menu, describe, build, code, import).
        expect(TOUR_STEPS.filter((s) => s.target === "new-test").length).toBeGreaterThanOrEqual(5);
        expect(of("running")).toEqual(expect.arrayContaining(["run", "run-strip", "runs-runs", "run-tests", "last-run", "runs-schedules", "runs-trends"]));
        expect(of("release")).toEqual(expect.arrayContaining(["runs-releases", "release-signoff", "tests-manual", "runs-compliance", "your-runner", "settings-environments", "settings-alerts", "settings-issues", "mobile-app", "settings-storage", "testing-type"]));
        expect(of("phones")).toEqual(expect.arrayContaining(["settings-mobile", "explore-phone", "explorer-view"]));
        expect(of("security")).toEqual(expect.arrayContaining(["sec-projects", "sec-applications", "sec-new", "sec-assessments", "sec-stop", "sec-findings", "sec-downloads", "sec-activity", "sec-notifications"]));
        expect(of("help")).toEqual(expect.arrayContaining(["help", "guide-wants", "tips", "guide-tour"]));
    });

    // The marks a step can point at: written out (`data-tour="x"`, `dataTour="x"`, `tour="x"`, a sidebar item's "x"), or made from a list.
    const sources = files.filter((f) => !/tour-steps\.ts$|\/Tour\.tsx$/.test(f.p));
    const literal = new Set<string>();
    for (const f of sources) for (const m of f.text.matchAll(/(?:data-tour|dataTour|\btour)="([a-z-]+)"/g)) literal.add(m[1]!);
    // The sidebar items and the project tabs pass their mark to a small helper that sets data-tour.
    for (const m of files.find((f) => f.p.endsWith("/components/Shell.tsx"))!.text.matchAll(/"(nav-[a-z-]+)"\)/g)) literal.add(m[1]!);
    for (const m of files.find((f) => f.p.endsWith("/pages/ProjectOverview.tsx"))!.text.matchAll(/"(tab-[a-z-]+)"\)/g)) literal.add(m[1]!);
    const made = new Set<string>();
    const hub = files.find((f) => f.p.endsWith("/components/ProjectHub.tsx"))!.text;
    // The hubs since round 25: Test cases (place "tests"), Test scripts, Runs and Settings.
    for (const [place, list] of [["tests", CASES_SECTIONS], ["scripts", SCRIPTS_SECTIONS], ["runs", RUNS_SECTIONS], ["settings", SETTINGS_SECTIONS]] as const) for (const s of list) made.add(`${place}-${s}`);
    const workbench = files.find((f) => f.p.endsWith("/features/workbench/Workbench.tsx"))!.text;
    for (const t of ["steps", "text", "code", "history"]) made.add(`wb-${t}`);
    const chrome = files.find((f) => f.p.endsWith("/features/security/SecurityChrome.tsx"))!.text;
    for (const m of chrome.slice(chrome.indexOf("const TABS"), chrome.indexOf("export function SecurityTabs")).matchAll(/key: "([a-z]+)"/g)) made.add(`sec-${m[1]}`);

    it("points only at elements that are in the app, and every mark in the app is used", () => {
        // The marks made from a list are really made where the list is shown.
        expect(hub).toContain("data-tour={`${place}-${s.key}`}");
        expect(workbench).toContain("data-tour={`wb-${k}`}");
        expect(chrome).toContain("data-tour={`sec-${t.key}`}");
        expect(made.size).toBeGreaterThan(20);
        for (const s of TOUR_STEPS) {
            for (const t of [s.target, s.alt]) if (t) expect(literal.has(t) || made.has(t), `${s.id}: nothing in web/src is marked data-tour="${t}"`).toBe(true);
        }
        const used = new Set(TOUR_STEPS.flatMap((s) => [s.target, s.alt]).filter(Boolean));
        for (const m of literal) expect(used.has(m), `data-tour="${m}" is not used by a step`).toBe(true);
    });

    it("leaves out what needs a project when there is none, and says so once", () => {
        const none = ids({});
        expect(none).toContain("no-project");
        expect(none.filter((id) => id === "no-project").length).toBe(1);
        // Only steps that need nothing remain, plus that one card.
        for (const id of none) if (id !== "no-project") expect(TOUR_STEPS.find((s) => s.id === id)!.needs ?? [], id).toEqual([]);
        expect(none).toEqual(["nav-dashboard", "projects", "nav-agents", "nav-develop", "nav-libraries", "nav-integrations", "nav-settings", "nav-help", "no-project", "help", "guide", "tips", "again"]);
        // A signed-in person adds their sidebar step even without a project. Round 37: Security assessment is not in the sidebar.
        expect(ids({ module: true, account: true })).toEqual(expect.arrayContaining(["account"]));
        expect(TOUR_STEPS.map((s) => s.id)).not.toContain("nav-security");
    });

    it("gives an ordinary web project more than 30 steps, and leaves out phones and security until the project has them", () => {
        const web = stepsFor(WEB);
        expect(web.length).toBeGreaterThanOrEqual(30);
        expect(web.some((s) => s.chapter === "phones" || s.chapter === "security")).toBe(false);
        expect(ids(WEB)).not.toContain("testing-type");
        // Phones only with a phone app.
        expect(stepsFor({ ...WEB, phone: true }).filter((s) => s.chapter === "phones").length).toBe(TOUR_STEPS.filter((s) => s.chapter === "phones").length);
        // Security only with the module on AND the project using it.
        expect(stepsFor({ ...WEB, module: true }).some((s) => s.chapter === "security")).toBe(false);
        expect(stepsFor({ ...WEB, security: true }).some((s) => s.chapter === "security")).toBe(false);
        expect(stepsFor({ ...WEB, module: true, security: true }).filter((s) => s.chapter === "security").length).toBe(TOUR_STEPS.filter((s) => s.chapter === "security").length);
        // Everything, when the project has everything.
        expect(ids(ALL)).toEqual(TOUR_STEPS.map((s) => s.id));
        // Without a test, a run or a release, the steps that open one are left out and nothing else.
        const bare = ids({ project: "p1" });
        for (const id of ["test-tabs", "wb-steps", "wb-text", "wb-code", "wb-history", "wb-save", "failure", "run-detail", "signoff"]) expect(bare, id).not.toContain(id);
        expect(bare).toContain("new-test");
        // A project for security assessment only leaves out functional testing.
        const secOnly = stepsFor({ ...ALL, securityOnly: true });
        expect(secOnly.some((s) => ["making", "running", "phones"].includes(s.chapter))).toBe(false);
        expect(secOnly.filter((s) => s.chapter === "security").length).toBeGreaterThan(5);
        expect(secOnly.map((s) => s.id)).toContain("testing-type");
    });

    it("lists the chapters with their first step and size, finds the next chapter, and counts honestly", () => {
        const steps = stepsFor(WEB);
        const ch = chaptersOf(steps);
        expect(ch.map((c) => c.id)).toEqual(["around", "making", "running", "release", "help"]);
        expect(ch.reduce((n, c) => n + c.count, 0)).toBe(steps.length);
        for (const c of ch) expect(steps[c.first]!.chapter).toBe(c.id);
        expect(nextChapterStart(steps, 0)).toBe(ch[1]!.first);
        expect(nextChapterStart(steps, ch[1]!.first + 2)).toBe(ch[2]!.first);
        expect(nextChapterStart(steps, steps.length - 1)).toBe(-1);
        expect(counter(0, 31, new Set())).toEqual({ position: 1, total: 31 });
        expect(counter(6, 31, new Set([2, 9]))).toEqual({ position: 6, total: 29 });
        expect(counter(10, 31, new Set([2, 9]))).toEqual({ position: 9, total: 29 });
    });

    it("knows the address of every step's page, and the Help panel knows each of them", () => {
        for (const s of stepsFor(ALL)) {
            const href = pageHref(s.page, ALL);
            if (s.page.kind === "any") {
                expect(href, s.id).toBeNull();
                continue;
            }
            expect(href, s.id).toMatch(/^#\//);
            expect(PLACES[placeOf(route(href!))], `${s.id}: ${href}`).toBeDefined();
            expect(onPage(s.page, href!, ALL), s.id).toBe(true);
        }
        expect(pageHref({ kind: "runs", section: "schedules" }, WEB)).toBe(routes.runs("p1", "schedules"));
        expect(pageHref({ kind: "setup", section: "runners" }, WEB)).toBe(routes.setup("p1", "runners"));
        // Round 45: a person's runner is Your runner in Settings.
        expect(pageHref({ kind: "runners" }, WEB)).toBe("#/settings#runner");
        expect(routes.setup("p1", "runners")).toBe("#/settings#runner");
        expect(pageHref({ kind: "test", tab: "history" }, WEB)).toBe(routes.testTab("t1", "history"));
        expect(pageHref({ kind: "failing" }, WEB)).toBe(routes.testTab("t1", "steps"));
        expect(pageHref({ kind: "failing" }, ALL)).toBe(routes.testTab("t2", "steps"));
        expect(pageHref({ kind: "run" }, ALL)).toBe(routes.run("p1", "j1"));
        expect(pageHref({ kind: "release-detail" }, ALL)).toBe(routes.release("p1", "r1"));
        expect(pageHref({ kind: "security", section: "overview" }, ALL)).toBe("#/projects/p1/security");
        expect(pageHref({ kind: "security", section: "reports" }, ALL)).toBe("#/projects/p1/security/reports");
        expect(pageHref({ kind: "project" }, {})).toBeNull();
        expect(pageHref({ kind: "run" }, { project: "p1" })).toBeNull();
        expect(onPage({ kind: "any" }, "#/whatever", {})).toBe(true);
        expect(onPage({ kind: "project" }, "#/projects/p1/tests", WEB)).toBe(false);
        expect(onPage({ kind: "runs", section: "runs" }, "#/projects/p1/runs", WEB)).toBe(true);
    });

    it("only reads: the tour's code sends nothing but GET requests and clicks nothing", () => {
        const tour = files.filter((f) => /\/features\/guide\/(Tour\.tsx|tour-steps\.ts)$/.test(f.p)).map((f) => f.text).join("\n");
        expect(tour).not.toMatch(/method\s*:/);
        expect(tour).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
        expect(tour).not.toMatch(/\.click\(|dispatchEvent|requestSubmit|\.submit\(/);
    });
});
