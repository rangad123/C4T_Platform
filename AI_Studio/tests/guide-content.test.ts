import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { glossary, topics, wants } from "../web/src/features/guide/content/index.js";
import { GROUP_TITLES } from "../web/src/features/guide/types.js";
import type { GroupId, Topic } from "../web/src/features/guide/types.js";

/**
 * The written content of the in-app guide (topics, glossary, "I want to..." list). Fast tier: reads files, starts nothing.
 * It guards the shapes, the ids, that every on-screen name is real, that the vocabulary is the product's, and that nothing reads like jargon.
 */

const ROOT = join(__dirname, "..");
const WEB_SRC = join(ROOT, "web", "src");
const CONTENT_DIR = join(WEB_SRC, "features", "guide", "content");
const FEATURE_DOCS = join(ROOT, "docs", "features");

/** Feature documents that are not the "more detail" of any topic, each with the reason. */
const NOT_A_TOPIC: Record<string, string> = {
    "crowd4test-sign-in.md": "how aistudio.crowd4test.com shares the crowd4test.com sign-in, and the settings an administrator sets for it; a tester never sees a sign-in here at all, only the portal's AI Studio entry and the Portal button",
    "phone-test-ideas.md": "how a phone plan's ideas, screen names and locators are made: each idea's own sentence (\"Covers the Jobs tab.\") and the plan say what a tester needs; the document is the technical detail",
    "phone-test-runs.md": "how a phone run picks its device and opens the app: the run's own sentences (\"Ran on CPH2467 (R58N20ABCDE), a phone on this computer.\"), the \"Where phone tests run\" setting's help and the user guide's phone sections say what a tester needs; the document is the technical detail",
    "smaller-snapshots.md": "a cost saving behind one switch in Settings, AI model (on by default) that changes nothing a tester does; the switch's own sentence and the user guide's section say what it does",
    "prompt-caching.md":"a cost saving behind one switch in Settings, AI model (on by default) that changes nothing a tester does; the user guide's AI usage section and the switch's own sentence say what it does",
    "repair-and-reuse-without-ai.md": "two cost savings behind switches in Settings, AI model (on by default) that change nothing a tester does; the switches' own help, the job's activity and the user guide's section say what they do",
    "model-routing.md":"an administrator's cost setting in Settings, AI model (a fast model for routine steps, empty by default); the field's own help, the user guide's section on it and the job's activity explain it",
    "framework-adapters.md": "internal structure; the document itself says nothing changes for a user",
    "test-suite.md": "how the platform's own developers run its test suite and release gate; nothing a tester sees",
    "phone-device-session.md": "how the platform talks to a phone or emulator through adb (the device session); the phone topics link phone-ai-tests.md and ux-phone-ai.md, which say what a tester sees",
    "phone-setup-simple.md": "the runner fetching Google's phone tools by itself; the phone topic (Test a phone app) says it in a good-to-know line, the runner's row says it, and the user guide section Phones on a runner covers it",
    "live-session.md": "its feature (an assistant trying a test in a live browser) is one step of the AI assistant topic, which links mcp-server.md",
    "approved-tests-and-shared-parts.md": "how a changed shared step, element or helper holds an approved test back; the run's own sentence and the review queue say what a person needs; the document is the technical detail",
    "run-live-view.md": "how the run page builds its live view from a runner's events; the run page itself shows it; the document is the technical detail",
    "runner-enrollment.md": "how a runner trades its one-time code for its credential and stores it; the Add this computer steps say what a person does; the document is the technical detail",
    "runner-journey-test.md": "the end-to-end test of installing, running and reconnecting a runner, for developers",
    "runner-personal.md": "the rules for a person's own computer as a runner; people see them as the runner topic and on the runner's page",
    "runner-protocol-2.md": "the wire protocol between runners and the platform, for developers",
    "runner-sessions-personal.md": "who may use recordings and phone sessions on a person's own computer; the choosers and the runner's switches say what a person needs; the document is the technical detail",
    "runner-only-mode.md": "how a hosted server runs tests only on runners (EXECUTION_MODE=runners), for whoever runs the platform; people see it as the runner topic",
    "runner-agent-setup.md": "install and token steps for the person who sets up a runner; the runner topic links runner-agent.md and the admin guide",
    "runner-installer.md": "how the runner installer program is built, what it checks and where it installs; the runners topic covers what a tester does",
    "runner-installer-mac.md": "how the Mac installer app is built and what it has not been tested on; the runners topic covers what a tester does",
    "runner-kit.md": "how the runner download is built and what is inside it; the runners topic covers what a tester does",
    "runner-complete-kit.md": "how the complete runner download (its own Node.js and test tools) is built and served; the runners topic and the user guide cover what a tester does",
    "emulator-setup.md": "how the downloadable \"set up the Android emulator\" script is built and served; Settings, Mobile testing offers the download and the steps, so there is nothing else a tester does",
    "ux-add-runner.md": "the guided Add a runner download; the runners topic walks through the same steps",
    "evaluation.md": "the owner's command that measures the AI tester on a list of real apps (a Settings list shows the results); not a tester's task, covered by the user guide section Quality of the AI tester",
    "device-farms.md": "running phone tests on a cloud device farm is set up where the phone topic (Test a phone app) already sends you, Settings, Mobile app, whose Device farm section explains itself; covered by the user guide section Phones in the cloud",
    "production-hosting.md":"server operation for the person who hosts the platform (probes, metrics, logs, backups, deploy kit); nothing a tester sees, covered by the admin guide",
    "real-machine-checks.md": "the developers' smoke script and the GitHub workflow that run the runner download on real Windows, macOS and Linux machines; nothing a tester sees, covered by the admin guide",
    "runner-browsers.md": "which browser a runner uses (the computer's Chrome or Edge, or Playwright's Chromium) and when it downloads one; the runner window, the runner's card and the run details say it in place, covered by the user guide section Which browser a runner uses",
    "portable-code-tests.md": "how a downloaded test folder is made to run on any computer (exact versions, lockfile, the supported Playwright range, the real-machine check); the Share a report topic's Download tests step and the Code tab's Run it on your own computer say what a tester does, covered by the user guide section Run downloaded tests on your own computer",
    "runner-updates.md": "how a runner downloads, checks and switches to the platform's new version, and how to go back; the runner's row says what it is doing and has the switch and the button, covered by the user guide section Runners keep themselves up to date",
    "runner-check.md": "the check-computer files in a runner download and the runner's own --check; the runner's row and the Add a runner panel say it in place, covered by the user guide section Check this computer",
    "company-networks.md":"proxy and company-certificate settings for the person who starts a runner or hosts the platform on a company network; the runner window says what to do, covered by the user guide section Runners on a company network and the admin guide",
    "security-assessment.md": "the Security Assessment module is a separate section of the app with its own pages, empty states and wording; covered by the user guide and admin guide sections Security assessment",
    "security-scanners.md": "the external scanners are tools an administrator installs (ZAP, nuclei, Schemathesis, promptfoo) that a tester never installs or runs by hand; the user guide section Security assessment links this document and says which profile reaches which tool, and the admin guide section 21 gives the environment variables",
    "tooltips.md": "how UI code uses the tooltip, the help button and the shared definitions; a tester sees the explanations in place on every page, covered by the user guide's Help inside the app section (Explanations in place)",
};

const GROUPS = Object.keys(GROUP_TITLES) as GroupId[];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
}

/** All the text of the web code, except the guide's own content (which would make every label "exist"). */
const corpus = walk(WEB_SRC)
    .filter((f) => !f.startsWith(CONTENT_DIR + sep))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

/** Sections each place defines, read from the router's lists. */
function sectionsOf(): Record<string, string[]> {
    const router = readFileSync(join(WEB_SRC, "lib", "router.ts"), "utf8");
    const read = (name: string): string[] => {
        const m = router.match(new RegExp(`export const ${name}_SECTIONS = \\[([^\\]]*)\\]`));
        if (!m) throw new Error(`router.ts has no ${name}_SECTIONS`);
        return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    };
    return { runs: read("RUNS"), library: read("LIBRARY"), setup: read("SETUP"), release: read("RELEASE") };
}

/** Everything a person reads in a topic, apart from the glossary-only fields. */
function proseOf(t: Topic): string[] {
    return [t.title, t.what, t.why, ...t.steps.map((s) => s.text), ...(t.goodToKnow ?? [])];
}

const uiLabels = (t: Topic) => t.steps.flatMap((s) => s.ui ?? []);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Text with the on-screen names taken out: a screen may use a word the guide itself avoids (for example inside a button name). */
function withoutLabels(text: string, labels: string[]): string {
    let out = text;
    for (const l of [...labels].sort((a, b) => b.length - a.length)) out = out.split(l).join(" ");
    return out;
}

const BANNED: [string, RegExp][] = [
    ["seamless", /\bseamless/i],
    ["leverage", /\bleverag/i],
    ["unlock", /\bunlock/i],
    ["empower", /\bempower/i],
    ["cutting-edge", /cutting-edge/i],
    ["game-changing", /game-changing/i],
    ["solutions", /\bsolutions\b/i],
    ["simply", /\bsimply\b/i],
    ["just", /\bjust\b/i],
    ["exclamation mark", /!/],
    ["emoji", /\p{Extended_Pictographic}/u],
];

/** Retired words (COMMON15): allowed only as "also called" in the glossary. */
const RETIRED: [string, RegExp][] = [
    ["validated / validation", /\bvalidat/i],
    ["analysis", /\banaly[sz]/i],
    ["hand-written", /\bhand-?written\b/i],
    ["runbook", /\brunbooks?\b/i],
    ["object(s)", /\bobjects?\b/i],
    ["block(s)", /\bblocks?\b/i],
    ["scenario", /\bscenarios?\b/i],
    ["spec / specification", /\b(specs?|specifications?)\b/i],
    ["healing", /\bheal(ing)?\b/i],
    ["take over", /\btake over\b/i],
    ["needs attention", /\bneeds? (attention|review)\b/i],
    ["runner agent / agent", /\bagents?\b/i],
    ["custom test / script", /\bcustom (tests?|scripts?)\b/i],
];

/** Jargon: allowed only where the topic names a glossary entry that explains it (or the glossary entry is that very term). */
const JARGON: { word: string; re: RegExp; glossedBy: string[] }[] = [
    { word: "spec", re: /\bspecs?\b/i, glossedBy: [] },
    { word: "adapter", re: /\badapters?\b/i, glossedBy: [] },
    { word: "token", re: /\btokens?\b/i, glossedBy: ["api-token", "deploy-token"] },
    { word: "endpoint", re: /\bendpoints?\b/i, glossedBy: ["api-endpoint"] },
    { word: "selector", re: /\bselectors?\b/i, glossedBy: [] },
    { word: "DOM", re: /\bDOM\b/, glossedBy: [] },
    { word: "CI", re: /\bCI\b/, glossedBy: [] },
    { word: "assertion", re: /\bassertions?\b/i, glossedBy: [] },
    { word: "headless", re: /\bheadless\b/i, glossedBy: [] },
    { word: "regression", re: /\bregressions?\b/i, glossedBy: [] },
    { word: "locator", re: /\blocators?\b/i, glossedBy: [] },
    { word: "payload", re: /\bpayloads?\b/i, glossedBy: [] },
];

const topicById = new Map(topics.map((t) => [t.id, t]));
const glossaryIds = new Set(glossary.map((g) => g.id));

describe("guide content: shapes and ids", () => {
    it("has the three exports filled", () => {
        expect(topics.length).toBeGreaterThanOrEqual(60);
        expect(glossary.length).toBeGreaterThanOrEqual(40);
        expect(wants.length).toBeGreaterThanOrEqual(30);
        expect(wants.length).toBeLessThanOrEqual(40);
    });

    it("has unique kebab-case ids for topics and glossary entries", () => {
        for (const list of [topics.map((t) => t.id), glossary.map((g) => g.id)]) {
            const seen = new Set<string>();
            for (const id of list) {
                expect(id, `id ${id} is not kebab-case`).toMatch(KEBAB);
                expect(seen.has(id), `duplicate id ${id}`).toBe(false);
                seen.add(id);
            }
        }
    });

    it("defines every glossary term once", () => {
        const seen = new Set<string>();
        for (const g of glossary) {
            const k = g.term.trim().toLowerCase();
            expect(seen.has(k), `term ${g.term} is defined twice`).toBe(false);
            seen.add(k);
            expect(g.meaning.length, `${g.id} meaning`).toBeGreaterThan(10);
            expect(g.meaning.length, `${g.id} meaning is long`).toBeLessThanOrEqual(220);
            expect((g.meaning.match(/[.?]\s/g) ?? []).length, `${g.id} meaning has more than one sentence`).toBeLessThanOrEqual(1);
        }
    });

    it("gives every topic its fields, within sane lengths", () => {
        for (const t of topics) {
            const at = `topic ${t.id}`;
            expect(GROUPS, `${at} group`).toContain(t.group);
            expect(t.title.length, `${at} title`).toBeGreaterThan(2);
            expect(t.title.length, `${at} title length`).toBeLessThanOrEqual(70);
            expect(t.what.length, `${at} what`).toBeGreaterThan(10);
            expect(t.what.length, `${at} what length`).toBeLessThanOrEqual(200);
            expect(t.why.length, `${at} why`).toBeGreaterThan(5);
            expect(t.why.length, `${at} why length`).toBeLessThanOrEqual(160);
            expect(t.steps.length, `${at} steps`).toBeGreaterThanOrEqual(2);
            expect(t.steps.length, `${at} has more than 6 steps`).toBeLessThanOrEqual(6);
            for (const s of t.steps) {
                expect(s.text.length, `${at} step "${s.text}"`).toBeGreaterThan(3);
                expect(s.text.length, `${at} step is long: ${s.text}`).toBeLessThanOrEqual(200);
            }
            const gtk = t.goodToKnow ?? [];
            expect(gtk.length, `${at} goodToKnow`).toBeLessThanOrEqual(3);
            for (const g of gtk) expect(g.length, `${at} goodToKnow is long: ${g}`).toBeLessThanOrEqual(200);
            expect(t.keywords?.length ?? 0, `${at} keywords`).toBeGreaterThanOrEqual(5);
            expect(t.keywords!.length, `${at} keywords`).toBeLessThanOrEqual(10);
            const rel = t.related ?? [];
            expect(rel.length, `${at} related`).toBeGreaterThanOrEqual(2);
            expect(rel.length, `${at} related`).toBeLessThanOrEqual(3);
            if (t.open) {
                expect(t.open.label.length, `${at} open label`).toBeGreaterThan(3);
                expect(t.open.label.length, `${at} open label`).toBeLessThanOrEqual(40);
            }
        }
    });

    it("keeps each topic between 40 and 110 words", () => {
        for (const t of topics) {
            const n = proseOf(t).reduce((a, s) => a + words(s), 0);
            expect(n, `topic ${t.id} has ${n} words`).toBeGreaterThanOrEqual(40);
            expect(n, `topic ${t.id} has ${n} words`).toBeLessThanOrEqual(110);
        }
    });

    it("points words, related and wants only at ids that exist", () => {
        for (const t of topics) {
            for (const w of t.words ?? []) expect(glossaryIds.has(w), `topic ${t.id}: unknown glossary id ${w}`).toBe(true);
            for (const r of t.related ?? []) {
                expect(topicById.has(r), `topic ${t.id}: unknown related topic ${r}`).toBe(true);
                expect(r, `topic ${t.id} lists itself as related`).not.toBe(t.id);
            }
        }
        for (const w of wants) expect(topicById.has(w.topic), `want "${w.text}": unknown topic ${w.topic}`).toBe(true);
    });

    it("has the four topics that are not features", () => {
        for (const id of ["first-steps", "places", "help", "control"]) expect(topicById.has(id), id).toBe(true);
    });

    it("has at least 3 topics in every group", () => {
        for (const g of GROUPS) expect(topics.filter((t) => t.group === g).length, `group ${g}`).toBeGreaterThanOrEqual(3);
    });

    it("has wants that are plain, unique and cover every group", () => {
        const seen = new Set<string>();
        for (const w of wants) {
            expect(w.text.length, w.text).toBeGreaterThan(8);
            expect(w.text.length, w.text).toBeLessThanOrEqual(70);
            expect(seen.has(w.text.toLowerCase()), `duplicate want "${w.text}"`).toBe(false);
            seen.add(w.text.toLowerCase());
        }
        const covered = new Set(wants.map((w) => topicById.get(w.topic)?.group));
        for (const g of GROUPS) expect(covered.has(g), `no "I want to" for group ${g}`).toBe(true);
    });
});

describe("guide content: it matches the app", () => {
    it("uses on-screen names that exist in the web code", () => {
        const missing: string[] = [];
        for (const t of topics) {
            for (const s of t.steps) {
                for (const label of s.ui ?? []) {
                    expect(s.text.includes(label), `topic ${t.id}: ui "${label}" is not in its step text`).toBe(true);
                    if (!corpus.includes(label)) missing.push(`${t.id}: "${label}"`);
                }
            }
        }
        expect(missing, `on-screen names not found in web/src:\n${missing.join("\n")}`).toEqual([]);
    });

    it("opens only places and sections that the router defines", () => {
        const sections = sectionsOf();
        const places = new Set(["projects", "new-project", "settings", "overview", "tests", "runs", "library", "release", "setup"]);
        for (const t of topics) {
            if (!t.open) continue;
            const { place, section } = t.open.to;
            expect(places.has(place), `topic ${t.id}: unknown place ${place}`).toBe(true);
            if (section) expect(sections[place] ?? [], `topic ${t.id}: ${place} has no section ${section}`).toContain(section);
        }
    });

    it("links a feature document that exists, and every feature document is linked or explained", () => {
        for (const t of topics) {
            if (t.moreDoc) expect(existsSync(join(ROOT, t.moreDoc)), `topic ${t.id}: ${t.moreDoc} does not exist`).toBe(true);
        }
        const linked = new Set(topics.map((t) => t.moreDoc && relative(ROOT, join(ROOT, t.moreDoc)).split(sep).join("/")));
        const orphans = readdirSync(FEATURE_DOCS)
            .filter((f) => f.endsWith(".md"))
            .filter((f) => !linked.has(`docs/features/${f}`) && !(f in NOT_A_TOPIC));
        expect(orphans, `feature documents with no topic and no reason: ${orphans.join(", ")}`).toEqual([]);
        for (const f of Object.keys(NOT_A_TOPIC)) expect(existsSync(join(FEATURE_DOCS, f)), `NOT_A_TOPIC lists a missing file ${f}`).toBe(true);
    });
});

describe("guide content: vocabulary and tone", () => {
    const prose = topics.flatMap((t) => proseOf(t).map((text) => ({ where: `topic ${t.id}`, text, labels: uiLabels(t) })));
    const glossaryProse = glossary.flatMap((g) => [{ where: `glossary ${g.id}`, text: `${g.term}. ${g.meaning}`, labels: [] as string[] }]);

    it("avoids banned words, exclamation marks and emoji", () => {
        const hits: string[] = [];
        for (const p of [...prose, ...glossaryProse]) for (const [name, re] of BANNED) if (re.test(p.text)) hits.push(`${p.where}: ${name} in "${p.text}"`);
        expect(hits).toEqual([]);
    });

    it("keeps retired words out of the main text (glossary alsoCalled excepted)", () => {
        const hits: string[] = [];
        for (const p of [...prose, ...glossaryProse]) {
            const text = withoutLabels(p.text, p.labels);
            for (const [name, re] of RETIRED) if (re.test(text)) hits.push(`${p.where}: ${name} in "${p.text}"`);
        }
        expect(hits).toEqual([]);
    });

    it("explains jargon: no jargon word without a glossary entry for it", () => {
        const hits: string[] = [];
        for (const t of topics) {
            const own = new Set(t.words ?? []);
            for (const text of proseOf(t)) {
                const plain = withoutLabels(text, uiLabels(t));
                for (const j of JARGON) if (j.re.test(plain) && !j.glossedBy.some((id) => own.has(id))) hits.push(`topic ${t.id}: "${j.word}" in "${text}"`);
            }
        }
        for (const g of glossary) {
            for (const j of JARGON) {
                if (j.re.test(g.meaning) && !j.glossedBy.includes(g.id)) hits.push(`glossary ${g.id}: "${j.word}" in "${g.meaning}"`);
            }
        }
        expect(hits).toEqual([]);
    });

    it("writes sentence-case titles with no trailing full stop", () => {
        for (const t of topics) {
            expect(t.title, t.id).not.toMatch(/[.:]$/);
            expect(/^[A-Z]/.test(t.title), `${t.id} title starts with a capital`).toBe(true);
        }
    });

    it("has steps that start with a verb-like word, not a pronoun or filler", () => {
        for (const t of topics) {
            for (const s of t.steps) expect(s.text, `${t.id}: "${s.text}"`).not.toMatch(/^(you|the platform|it|there|then|now)\b/i);
        }
    });
});
