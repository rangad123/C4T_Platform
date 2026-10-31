/**
 * Smaller page snapshots (src/engine/snapshots/*), the parts that need no browser: the compaction rules and the list of changes on snapshots
 * recorded from a real Chromium (tests/fixtures/snapshots/*.yml, recorded by tests/fixtures/snapshots/record.ts from the sample app and the
 * catalog fixture), the invariant that every element a test can act on keeps its exact role and name, the session view and its counts, the
 * switch, and the smaller phone screen descriptions on the in-memory shop phone. Fast tier. The agent runs are in tests/snapshot-agent.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import type { ScreenElement, ScreenSnapshot } from "../src/engine/mobile/device/types.js";
import { describeScreen, type DescribeInput } from "../src/engine/mobile/explore/describe.js";
import { explore, ModelBudget } from "../src/engine/mobile/explore/explorer.js";
import { DEFAULT_LIMITS } from "../src/engine/mobile/explore/types.js";
import { actionableNames, compactSnapshot, diffSnapshots, FULL_EVERY, parseSnapshot, renderSnapshot, SnapshotView, snapshotSavingsEvent } from "../src/engine/snapshots/compact.js";
import { compactScreenLines } from "../src/engine/snapshots/phone.js";
import { compactSnapshotSetting, compactSnapshotsOn, EVENT_SNAPSHOT_SAVINGS, setCompactSnapshotSource } from "../src/engine/snapshots/setting.js";
import { MemoryDevice, shopApp, SHOP, type AppDef } from "./fixtures/memory-device.js";
import { parseScreen, scriptedPhoneModel } from "./fixtures/phone-model.js";

const DIR = path.join(REPO_ROOT, "tests/fixtures/snapshots");
const FIXTURES = fs.readdirSync(DIR).filter((f) => f.endsWith(".yml")).sort();
const read = (name: string) => fs.readFileSync(path.join(DIR, name), "utf8").replace(/\r\n/g, "\n").trimEnd();
const tokens = (chars: number) => Math.ceil(chars / 4);

afterEach(() => setCompactSnapshotSource(undefined));

describe("compaction rules on recorded snapshots", () => {
    it("has the recorded snapshots of the sample app and the catalog", () => {
        expect(FIXTURES).toEqual(expect.arrayContaining(["catalog.yml", "catalog-added.yml", "sample-login.yml", "sample-login-filled.yml", "sample-products.yml", "sample-account.yml"]));
    });

    it("keeps every actionable element's exact role and name, on every fixture", () => {
        for (const f of FIXTURES) {
            const raw = read(f);
            const { text } = compactSnapshot(raw);
            for (const token of actionableNames(raw)) expect(text, `${f}: ${token}`).toContain(token);
        }
    });

    it("never rewrites a kept line: each one is in the raw snapshot, apart from the inlined address", () => {
        for (const f of FIXTURES) {
            const raw = read(f);
            const rawLines = new Set(raw.split("\n").map((l) => l.trim()));
            const urls = new Set(raw.split("\n").filter((l) => l.trim().startsWith("- /url: ")).map((l) => l.trim().slice("- /url: ".length)));
            for (const line of compactSnapshot(raw).text.split("\n")) {
                const t = line.trim();
                if (t.startsWith("- (") && /more \S+ like the \d+ above/.test(t)) continue; // a collapsed run
                if (/… \(\d+ more characters\)"$/.test(t)) continue; // a shortened text
                const url = / \[url=([^\]]*)\]$/.exec(t);
                const head = url ? t.slice(0, -url[0].length) : t;
                if (url) expect(urls.has(url[1]!), `${f}: ${t}`).toBe(true);
                // A link whose only child was its address loses the trailing ":"; anything else is verbatim.
                expect(rawLines.has(head) || rawLines.has(`${head}:`), `${f}: ${t}`).toBe(true);
            }
        }
    });

    it("drops decorations, shortens long text and collapses look-alike runs on the catalog", () => {
        const raw = read("catalog.yml");
        const { text, stats } = compactSnapshot(raw);
        // Hidden and aria-hidden parts are already absent from Playwright's snapshot; decorations are dropped here.
        expect(raw).not.toContain("Mobile menu");
        expect(raw).not.toContain("Hidden admin");
        expect(raw).toMatch(/^\s*- img$/m);
        expect(text).not.toMatch(/^\s*- img$/m);
        expect(text).not.toMatch(/^\s*- separator$/m);
        expect(text).not.toContain('text: "|"');
        expect(text).not.toContain("text: ·");
        // The long paragraph keeps its start and says how much was left out.
        expect(text).toMatch(/paragraph: "Every item in this catalog is tested on real trails[^"]*… \(\d+ more characters\)"/);
        // 40 product cards: 3 in full, then one line naming the other 37 in page order; 24 order rows: 3 in full.
        expect(text).toContain("(37 more article like the 3 above, each: heading [link], paragraph, button \"Add to cart\". In order: link \"Headlamp Pro 1\", $31.50; link \"Rain Shell 1\"");
        expect(text).toContain("(21 more row like the 3 above");
        expect(text).toContain('link "Sleeping Pad 5"');
        expect(text.indexOf('link "Headlamp Pro 1"')).toBeLessThan(text.indexOf('link "Sleeping Pad 5"'));
        expect(stats.collapsedRuns).toBe(2);
        expect(stats.collapsedItems).toBe(58);
        expect(stats.shortenedTexts).toBe(1);
        // The measured effect on this page (printed for the report).
        console.log(`catalog: ${raw.length} → ${text.length} characters (about ${tokens(raw.length)} → ${tokens(text.length)} tokens)`);
        expect(text.length).toBeLessThan(raw.length * 0.4);
    });

    it("leaves a small page nearly as it is and keeps its order", () => {
        const raw = read("sample-login.yml");
        const { text } = compactSnapshot(raw);
        expect(text).toBe(
            [
                "- banner:",
                "  - strong: DemoShop",
                '  - navigation "Main":',
                '    - link "Home" [url=/]',
                '    - link "Products" [url=/products]',
                '    - link "Cart (1)" [url=/cart]',
                '    - link "Login" [url=/login]',
                "- main:",
                '  - heading "Login" [level=1]',
                "  - text: Email",
                '  - textbox "Email"',
                "  - text: Password",
                '  - textbox "Password"',
                '  - button "Log in"',
            ].join("\n"),
        );
    });

    it("reads YAML quoting without changing it (a name with a colon, an escaped quote, a quoted value)", () => {
        const raw = ["- 'button \"Save: draft\"'", '- link "Say \\"hi\\"":', "  - /url: /hi", '- paragraph: "Price: $5"', "- 'heading \"It''s here\" [level=2]'"].join("\n");
        const tree = parseSnapshot(raw);
        expect(tree.map((n) => [n.role, n.name])).toEqual([
            ["button", '"Save: draft"'],
            ["link", '"Say \\"hi\\""'],
            ["paragraph", undefined],
            ["heading", '"It\'s here"'],
        ]);
        expect(renderSnapshot(parseSnapshot(raw))).toBe(raw);
        const { text } = compactSnapshot(raw);
        expect(text).toContain("- 'button \"Save: draft\"'");
        expect(text).toContain('- link "Say \\"hi\\"" [url=/hi]');
        expect(text).toContain('- paragraph: "Price: $5"');
        expect(actionableNames(raw)).toEqual(['button "Save: draft"', 'link "Say \\"hi\\""']);
    });

    it("does not collapse a short run, or a run it could not shorten", () => {
        const nav = Array.from({ length: 8 }, (_, i) => `- link "Section ${i + 1}"`).join("\n");
        expect(compactSnapshot(nav).text).toBe(nav);
        const five = Array.from({ length: 5 }, (_, i) => `- listitem:\n  - link "Item ${i}"\n  - button "Remove"`).join("\n");
        expect(compactSnapshot(five).text).toBe(five);
    });
});

describe("what changed", () => {
    it("says only what changed after an action on the catalog (cart count and status)", () => {
        const before = compactSnapshot(read("catalog.yml"));
        const after = compactSnapshot(read("catalog-added.yml"));
        const diff = diffSnapshots(before.tree, after.tree)!;
        expect(diff.text).toContain('At banner > navigation "Main":');
        expect(diff.text).toContain('- link "Cart (1)" [url=/cart]');
        expect(diff.text).toMatch(/changed:\n\s+- status: Added product 7 to the cart\n\s+\(was: status\)/);
        expect(diff.changes).toBe(3);
        expect(diff.text.length).toBeLessThan(after.text.length * 0.1);
    });

    it("shows a typed value as one changed line", () => {
        const diff = diffSnapshots(compactSnapshot(read("sample-login.yml")).tree, compactSnapshot(read("sample-login-filled.yml")).tree)!;
        expect(diff.text).toBe(['At main:', "  changed:", '    - textbox "Email": demo@example.com', '    (was: textbox "Email")'].join("\n"));
    });

    it("finds no change between a snapshot and itself", () => {
        const t = compactSnapshot(read("catalog.yml")).tree;
        expect(diffSnapshots(t, t)).toEqual({ text: "", changes: 0 });
    });
});

describe("one authoring session's view", () => {
    const URL1 = "http://127.0.0.1:7310/";

    it("sends the compact snapshot first, then what changed, then nothing-changed, and a new page in full", () => {
        const v = new SnapshotView();
        const first = v.show(URL1, read("catalog.yml"), 9_000);
        expect(first).toBe(compactSnapshot(read("catalog.yml")).text);
        const second = v.show(`${URL1}?added=7`, read("catalog-added.yml"), 7_000);
        expect(second).toMatch(/^Same page \(\/\?added=7, heading "Catalog", \d+ controls\), changes since your last look \(the rest is as before\):\nAt banner/);
        expect(second).toContain('link "Cart (1)"');
        const third = v.show(`${URL1}?added=7`, read("catalog-added.yml"), 7_000);
        expect(third).toMatch(/^Same page \(\/\?added=7, heading "Catalog", \d+ controls\): nothing changed since your last look\.$/);
        const login = v.show("http://127.0.0.1:7310/login", read("sample-login.yml"), 7_000);
        expect(login).toBe(compactSnapshot(read("sample-login.yml")).text);
        expect(v.totals).toMatchObject({ snapshots: 4, compact: 2, diffs: 2, wholePage: 0 });
        // Before: the full snapshot cut at the same limits.
        expect(v.totals.baselineChars).toBe(9_000 + "\n…(truncated)".length + 2 * (7_000 + "\n…(truncated)".length) + read("sample-login.yml").length);
        expect(v.totals.sentChars).toBe(first.length + second.length + third.length + login.length);
    });

    it("gives the untouched page on request and compares the next snapshot with it", () => {
        const v = new SnapshotView();
        v.show(URL1, read("catalog.yml"), 9_000);
        const whole = v.whole(URL1, read("catalog.yml"));
        expect(whole).toBe(read("catalog.yml"));
        expect(whole).toContain('link "Sleeping Pad 5":');
        expect(v.show(URL1, read("catalog.yml"), 7_000)).toMatch(/nothing changed since your last look/);
        expect(v.totals.wholePage).toBe(1);
    });

    it("sends the whole compact snapshot again after a long series of change lists", () => {
        const v = new SnapshotView();
        const a = read("sample-login.yml");
        const b = read("sample-login-filled.yml");
        v.show(URL1, a, 7_000);
        for (let i = 0; i < FULL_EVERY; i++) expect(v.show(URL1, i % 2 ? a : b, 7_000).startsWith("Same page (")).toBe(true);
        expect(v.show(URL1, a, 7_000)).toBe(compactSnapshot(a).text);
    });

    it("passes an unavailable snapshot on as it is", () => {
        const v = new SnapshotView();
        expect(v.show(URL1, "(accessibility snapshot unavailable)", 7_000)).toBe("(accessibility snapshot unavailable)");
        expect(v.show(URL1, read("sample-login.yml"), 7_000)).toBe(compactSnapshot(read("sample-login.yml")).text);
    });

    it("counts what each model step read, and writes one plain job event", () => {
        const v = new SnapshotView();
        const first = v.show(URL1, read("catalog.yml"), 9_000); // in the opening prompt
        const second = v.show(`${URL1}?added=7`, read("catalog-added.yml"), 7_000); // result of step 1's tool call
        v.modelStep(); // step 1 read the first snapshot only
        v.modelStep(); // step 2 read both
        const t = v.totals;
        expect(t.sentInputChars).toBe(first.length + (first.length + second.length));
        expect(t.baselineInputChars).toBeGreaterThan(t.sentInputChars * 2);
        const e = snapshotSavingsEvent("S-001", t);
        expect(e.kind).toBe(EVENT_SNAPSHOT_SAVINGS);
        expect(e.message).toMatch(/^S-001: smaller page snapshots, about [\d.k]+ tokens instead of [\d.k]+ \(\d+% fewer\)$/);
        expect(e.data).toMatchObject({ kind: "web", snapshots: 2, savedTokens: expect.any(Number) });
    });
});

describe("the switch", () => {
    it("is on by default, off with LLM_COMPACT_SNAPSHOTS=false/off/0/no, and a choice saved in Settings wins", () => {
        expect(compactSnapshotSetting({})).toEqual({ enabled: true, source: "default" });
        expect(compactSnapshotSetting({ LLM_COMPACT_SNAPSHOTS: " " })).toEqual({ enabled: true, source: "default" });
        for (const off of ["false", "off", "0", "no", " OFF "]) expect(compactSnapshotsOn({ LLM_COMPACT_SNAPSHOTS: off })).toBe(false);
        expect(compactSnapshotSetting({ LLM_COMPACT_SNAPSHOTS: "true" })).toEqual({ enabled: true, source: "environment" });
        setCompactSnapshotSource(() => true);
        expect(compactSnapshotSetting({ LLM_COMPACT_SNAPSHOTS: "off" })).toEqual({ enabled: true, source: "app" });
        setCompactSnapshotSource(() => undefined);
        expect(compactSnapshotSetting({ LLM_COMPACT_SNAPSHOTS: "off" })).toEqual({ enabled: false, source: "environment" });
        setCompactSnapshotSource(() => {
            throw new Error("database gone");
        });
        expect(compactSnapshotsOn({})).toBe(true);
    });
});

// ── phone ───────────────────────────────────────────────────────────────────

const el = (index: number, o: Partial<ScreenElement> = {}): ScreenElement => ({
    index, cls: "TextView", text: "", desc: "", id: "", clickable: true, longClickable: false, scrollable: false, editable: false, password: false, checkable: false, checked: false, enabled: true, focused: false, bounds: [0, 0, 10, 10], ...o,
});
const screen = (elements: ScreenElement[]): ScreenSnapshot => ({ package: SHOP, activity: "ProductsActivity", width: 360, height: 640, elements, fingerprint: "f", keyboard: false, outsideApp: false });
const describeBase: Omit<DescribeInput, "snapshot"> = {
    appPackage: SHOP, screenId: "S2", isNew: true, visited: [{ id: "S1", title: "Shop" }], path: ["opened Shop"], changed: "The last action opened a different screen.", refused: [],
    budget: { actions: 40, minutes: 9, screens: 20 }, allowDataChanges: false, credentialsGiven: false, secrets: [],
};
const longList = () =>
    screen([
        el(0, { text: "Products", id: "title", clickable: false }),
        el(1, { cls: "FrameLayout", clickable: false }), // decorative: nothing to act on or read
        el(2, { cls: "RecyclerView", id: "product_list", scrollable: true, clickable: false }),
        ...Array.from({ length: 30 }, (_, i) => el(3 + i, { text: `Product ${i + 1}`, id: `product_${i + 1}` })),
        el(33, { cls: "Button", text: "Check out", id: "checkout_button" }),
    ]);

describe("smaller phone screen descriptions", () => {
    it("is exactly the description of before when off, and for the shop's small screens when on", () => {
        const small = screen([el(0, { text: "Sign in", id: "signin_button" }), el(1, { cls: "EditText", editable: true, text: "Username", id: "user" }), el(2, { cls: "RecyclerView", id: "list", scrollable: true, clickable: false })]);
        expect(describeScreen({ ...describeBase, snapshot: small, compact: true })).toBe(describeScreen({ ...describeBase, snapshot: small }));
        expect(describeScreen({ ...describeBase, snapshot: small, compact: false })).toBe(describeScreen({ ...describeBase, snapshot: small }));
    });

    it("leaves out decorations and lists a long run by number and name, keeping every number and name", () => {
        const s = longList();
        const before = describeScreen({ ...describeBase, snapshot: s });
        const after = describeScreen({ ...describeBase, snapshot: s, compact: true });
        expect(after).not.toContain("[1] FrameLayout");
        expect(after).toContain('[3] TextView "Product 1" id=product_1');
        expect(after).toContain("(27 more TextView id like product_# like the 3 above; each listed by number and name only)");
        expect(after).toContain('[32] "Product 30"');
        expect(after).toContain('[33] Button "Check out" id=checkout_button');
        // The scripted model reads both forms; every element except the decoration is there with its number and text.
        const parsedBefore = parseScreen(before).filter((p) => p.index !== 1).map((p) => [p.index, p.text]);
        expect(parseScreen(after).map((p) => [p.index, p.text])).toEqual(parsedBefore);
        console.log(`phone long list: ${before.length} → ${after.length} characters (about ${tokens(before.length)} → ${tokens(after.length)} tokens)`);
        expect(after.length).toBeLessThan(before.length * 0.85);
    });

    it("never collapses elements in different states, and leaves lines it cannot read as they are", () => {
        const lines = [
            ...Array.from({ length: 7 }, (_, i) => `[${i}] CheckBox "Option ${i}" (checkbox, ${i % 2 ? "checked" : "not checked"})`),
            '[9] TextView "He said "hi"" (label only)',
        ];
        const out = compactScreenLines(lines);
        expect(out.lines.map((l) => l.text)).toEqual(lines);
        expect(out.dropped).toBe(0);
    });

    it("explores a long list the same way, tapping an element listed by number and name only", async () => {
        const app: AppDef = {
            pkg: SHOP,
            start: "list",
            screens: {
                list: {
                    activity: "ProductsActivity",
                    els: () => [
                        { text: "Products", id: "title" },
                        { cls: "FrameLayout" },
                        ...Array.from({ length: 30 }, (_, i) => ({ text: `Product ${i + 1}`, id: `product_${i + 1}`, tap: i === 24 ? "detail" : undefined })),
                    ],
                },
                detail: { activity: "ProductActivity", els: () => [{ text: "Product 25 details", id: "product_title" }, { text: "Add to cart", id: "add_to_cart_button", tap: () => undefined }] },
            },
        };
        const run = async (setting: string) => {
            const device = new MemoryDevice(app);
            const llm = scriptedPhoneModel([{ tap: "Product 25" }, { back: true }, { finish: true }]);
            const events: EngineEvent[] = [];
            const ctx: EngineContext = { config: { LLM_COMPACT_SNAPSHOTS: setting } as never, llm, emit: (e) => events.push(e) };
            const model = await explore({ ctx, session: device, appPackage: SHOP, credentialsGiven: false, allowDataChanges: false, secrets: [] }, new ModelBudget(DEFAULT_LIMITS.maxModelCalls));
            return { model, device, llm, events };
        };
        const off = await run("off");
        const on = await run("on");
        expect(on.device.tapped).toEqual(off.device.tapped);
        expect(on.device.tapped).toContain("Product 25");
        expect(on.model.screens.map((s) => s.title)).toEqual(off.model.screens.map((s) => s.title));
        expect(on.model.edges).toEqual(off.model.edges);
        expect(on.llm.turns[0]).toContain('"Product 25"');
        expect(on.llm.turns[0]).not.toContain('TextView "Product 25"');
        const sent = (t: string[]) => t.reduce((a, s) => a + s.length, 0);
        console.log(`phone exploration: ${sent(off.llm.turns)} → ${sent(on.llm.turns)} characters over ${on.llm.turns.length} turns`);
        expect(sent(on.llm.turns)).toBeLessThan(sent(off.llm.turns));
        const ev = on.events.find((e) => e.kind === EVENT_SNAPSHOT_SAVINGS);
        expect(ev?.message).toMatch(/^Phone exploration: smaller screen descriptions, about [\d.k]+ tokens instead of [\d.k]+ \(\d+% fewer\)$/);
        expect(off.events.some((e) => e.kind === EVENT_SNAPSHOT_SAVINGS)).toBe(false);
    });

    it("explores the shop exactly as before (its screens are small)", async () => {
        const run = async (setting: string) => {
            const device = new MemoryDevice(shopApp());
            const llm = scriptedPhoneModel([{ tap: "Allow" }, { tap: "Products" }, { tap: "Product 2" }, { back: true }, { back: true }, { tap: "Cart" }, { finish: true }]);
            const ctx: EngineContext = { config: { LLM_COMPACT_SNAPSHOTS: setting } as never, llm, emit: () => undefined };
            await explore({ ctx, session: device, appPackage: SHOP, credentialsGiven: false, allowDataChanges: false, secrets: [] }, new ModelBudget(DEFAULT_LIMITS.maxModelCalls));
            return llm.turns;
        };
        expect(await run("on")).toEqual(await run("off"));
    });
});
