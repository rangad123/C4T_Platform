/**
 * The Explorer view, the parts that need no browser: the picture sink (one a second, nothing when nobody watches), the size and scale decisions, which
 * fields are covered, the activity line (facts only), the per-job picture store (one picture, eight jobs, ten and thirty seconds, three reads a second)
 * and what can be watched when. Fast tier.
 */
import { describe, expect, it } from "vitest";
import { activityLine, activityOfStep, pathOf, safeAddress, NOTE_MAX } from "../src/engine/frames/activity.js";
import { createFrameSink, type ExplorerFrame, type FrameTarget } from "../src/engine/frames/sink.js";
import { FRAME_LIMITS, fieldsToCover, firstThatFits, frameScale, shootPage, type Shot } from "../src/engine/frames/shoot.js";
import { secretKindOfField } from "../src/engine/recorder/act.js";
import { FRAME_IDLE_MS, FrameHub, MAX_FRAME_JOBS, READS_PER_SECOND, REASONS, WATCH_WINDOW_MS, watchState } from "../src/platform/frame-hub.js";
import type { Step } from "../src/engine/spec/schema.js";
import { canOfferWatch, finishedWords, pagesWords, phaseWords, updatedWords } from "../web/src/features/explorer/explorer-text.js";

const jpeg = (n = 10) => new Uint8Array(n).fill(7);
const shot = (url = "http://app.test/", title = "Home"): Shot => ({ jpeg: jpeg(), url, title });
const frame = (over: Partial<ExplorerFrame> = {}): ExplorerFrame => ({ jpeg: jpeg(), url: "http://app.test/", title: "Home", note: "Opened /", phase: "exploring", pagesSeen: 1, at: new Date(0).toISOString(), ...over });
const PAGE = {} as never;

describe("the picture sink", () => {
    function setup(over: { watched?: boolean; shoot?: () => Promise<Shot | null>; gap?: number } = {}) {
        let t = 10_000;
        const got: ExplorerFrame[] = [];
        let watched = over.watched ?? true;
        let shots = 0;
        const target: FrameTarget = { wanted: () => watched, accept: (f) => void got.push(f) };
        const sink = createFrameSink(target, {
            now: () => t,
            ...(over.gap !== undefined ? { minGapMs: over.gap } : {}),
            shoot: async () => {
                shots++;
                return over.shoot ? over.shoot() : shot();
            },
        });
        return { sink, got, advance: (ms: number) => void (t += ms), watch: (w: boolean) => void (watched = w), shots: () => shots };
    }
    const facts = { note: "Opened /", phase: "exploring" as const, pagesSeen: 1 };

    it("takes no picture at all when nobody is watching", async () => {
        const s = setup({ watched: false });
        for (let i = 0; i < 5; i++) {
            await s.sink.capture(PAGE, facts);
            s.advance(2000);
        }
        expect(s.shots()).toBe(0);
        expect(s.sink.captures).toBe(0);
        expect(s.got).toHaveLength(0);
    });

    it("takes at most one picture a second", async () => {
        const s = setup();
        await s.sink.capture(PAGE, facts);
        s.advance(400);
        await s.sink.capture(PAGE, facts);
        s.advance(500);
        await s.sink.capture(PAGE, facts);
        expect(s.got).toHaveLength(1);
        s.advance(200); // 1100 ms since the first
        await s.sink.capture(PAGE, { ...facts, note: "Opened /about" });
        expect(s.got.map((f) => f.note)).toEqual(["Opened /", "Opened /about"]);
        expect(s.sink.captures).toBe(2);
    });

    it("never takes a second picture while one is being taken", async () => {
        let release: (s: Shot) => void = () => undefined;
        const s = setup({ gap: 0, shoot: () => new Promise<Shot>((r) => (release = r)) });
        const first = s.sink.capture(PAGE, facts);
        await s.sink.capture(PAGE, facts); // returns at once: a picture is in flight
        expect(s.shots()).toBe(1);
        release(shot());
        await first;
        expect(s.got).toHaveLength(1);
    });

    it("passes on the facts of the moment, a timestamp and the page's address and title", async () => {
        const s = setup();
        await s.sink.capture(PAGE, { note: "Clicked Sign in", phase: "building", pagesSeen: 3 });
        expect(s.got[0]).toMatchObject({ note: "Clicked Sign in", phase: "building", pagesSeen: 3, url: "http://app.test/", title: "Home" });
        expect(new Date(s.got[0]!.at).getTime()).toBe(10_000);
    });

    it("drops a picture when the person stopped watching while it was taken, and survives a camera that fails", async () => {
        let watching = true;
        let accepted = 0;
        const t = createFrameSink(
            { wanted: () => watching, accept: () => void accepted++ },
            { shoot: async () => { watching = false; return shot(); } },
        );
        await t.capture(PAGE, facts);
        expect(accepted).toBe(0);
        expect(t.captures).toBe(0);
        const bad = createFrameSink({ wanted: () => true, accept: () => undefined }, { shoot: async () => { throw new Error("page closed"); } });
        await expect(bad.capture(PAGE, facts)).resolves.toBeUndefined();
        expect(bad.captures).toBe(0);
        const none = setup({ gap: 0, shoot: async () => null });
        await none.sink.capture(PAGE, facts);
        expect(none.sink.captures).toBe(0);
    });
});

describe("size and covering decisions", () => {
    it("shrinks wide pages to 640 px and never enlarges a small one", () => {
        expect(frameScale(1280)).toBeCloseTo(0.5, 5);
        expect(frameScale(640)).toBe(1);
        expect(frameScale(375)).toBe(1);
        expect(frameScale(0)).toBe(1);
        expect(frameScale(2560) * 2560).toBeCloseTo(FRAME_LIMITS.maxWidth, 5);
    });

    it("keeps the first quality that fits 120 KB and gives up when none does", async () => {
        const tried: number[] = [];
        const sizes: Record<number, number> = { 55: 200_000, 40: 130_000, 28: 90_000 };
        const got = await firstThatFits(FRAME_LIMITS.qualities, async (q) => (tried.push(q), new Uint8Array(sizes[q]!)));
        expect(tried).toEqual([55, 40, 28]);
        expect(got?.byteLength).toBe(90_000);
        expect(await firstThatFits(FRAME_LIMITS.qualities, async () => new Uint8Array(FRAME_LIMITS.maxBytes + 1))).toBeNull();
        const first = await firstThatFits(FRAME_LIMITS.qualities, async () => new Uint8Array(FRAME_LIMITS.maxBytes));
        expect(first?.byteLength).toBe(FRAME_LIMITS.maxBytes);
        expect(FRAME_LIMITS.maxBytes).toBe(120 * 1024);
    });

    it("covers password, one-time-code and card fields by the recorder's own rule, and any field holding a stored secret", () => {
        const fields = [
            { tag: "input", type: "text", name: "email" },
            { tag: "input", type: "password" },
            { tag: "input", type: "text", autocomplete: "one-time-code" },
            { tag: "input", type: "text", autocomplete: "cc-number" },
            { tag: "input", type: "text", name: "cvv" },
            { tag: "input", type: "text", name: "search", holdsSecret: true },
            { tag: "textarea", type: "", name: "notes" },
            { tag: "input", type: "text", name: "newPassword" },
        ];
        expect(fieldsToCover(fields)).toEqual([1, 2, 3, 4, 5, 7]);
        // The same decision the recorder's picture uses.
        expect(secretKindOfField({ tag: "input", type: "password" })).toBe("password");
    });
});

describe("covering fails closed", () => {
    const frame = (detached: boolean) => ({ evaluate: async () => { throw new Error("boom"); }, isDetached: () => detached });
    const pageWith = (frames: unknown[], onCamera: () => void) => ({ isClosed: () => false, frames: () => frames, url: () => "http://a.test/", title: async () => "", context: () => { onCamera(); return { newCDPSession: async () => { throw new Error("no camera in this double"); } }; } }) as never;

    it("takes no picture when a frame that is still there cannot be covered", async () => {
        let camera = 0;
        expect(await shootPage(pageWith([frame(false)], () => camera++))).toBeNull();
        expect(camera).toBe(0);
    });

    it("takes no picture when the page has more frames than are looked at", async () => {
        let camera = 0;
        expect(await shootPage(pageWith(Array.from({ length: 13 }, () => ({ evaluate: async () => [], isDetached: () => false })), () => camera++))).toBeNull();
        expect(camera).toBe(0);
    });

    it("goes on past a frame that went away while it was looked at", async () => {
        let camera = 0;
        await shootPage(pageWith([frame(true)], () => camera++));
        expect(camera).toBe(1);
    });
});

describe("the activity line", () => {
    it("is built from facts: a path without its query, a control's name, a count", () => {
        expect(activityLine({ kind: "opened", url: "https://shop.test/pricing?token=abc123&plan=pro#top" })).toBe("Opened /pricing");
        expect(activityLine({ kind: "opened", url: "https://shop.test/#/inbox?x=1" })).toBe("Opened /#/inbox");
        expect(activityLine({ kind: "clicked", name: "Sign in" })).toBe("Clicked Sign in");
        expect(activityLine({ kind: "filled", field: "Search" })).toBe("Filled the Search field");
        expect(activityLine({ kind: "read", links: 12 })).toBe("Read 12 links");
        expect(activityLine({ kind: "read", links: 1 })).toBe("Read 1 link");
        expect(activityLine({ kind: "signedIn" })).toBe("Signed in");
    });

    it("never carries a typed value, and says nothing about a hidden field's name", () => {
        const step: Step = { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}", description: "" };
        expect(activityLine(activityOfStep(step, "https://app.test/login"))).toBe("Filled in a hidden field");
        const mail: Step = { action: "fill", locator: { by: "label", value: "Email" }, value: "someone@example.com", description: "" };
        const line = activityLine(activityOfStep(mail, "https://app.test/login"));
        expect(line).toBe("Filled the Email field");
        expect(line).not.toContain("someone");
        const css: Step = { action: "click", locator: { by: "css", value: "#buy > .x" }, description: "" };
        expect(activityLine(activityOfStep(css, "https://app.test/"))).toBe("Clicked a control");
    });

    it("drops a name or a path that contains a stored secret", () => {
        expect(activityLine({ kind: "clicked", name: "Use code Hunter2-Pass" }, ["Hunter2-Pass"])).toBe("Clicked a control");
        expect(activityLine({ kind: "opened", url: "https://app.test/reset/Hunter2-Pass" }, ["hunter2-pass"])).toBe("Opened a page");
        // A very short secret is not searched for (it would be found inside ordinary words).
        expect(activityLine({ kind: "clicked", name: "Go" }, ["o"])).toBe("Clicked Go");
    });

    it("cuts names and stays within the length cap, with control characters removed", () => {
        const long = "x".repeat(200);
        const line = activityLine({ kind: "clicked", name: `${long}\u0000‮` });
        expect(line.length).toBeLessThanOrEqual(NOTE_MAX);
        expect(line).not.toMatch(/[\u0000‮]/);
        expect(activityLine({ kind: "pressed", key: "Enter" })).toBe("Pressed Enter");
        expect(activityLine({ kind: "pressed", key: "weird\nkey" })).toBe("Pressed a key");
        expect(pathOf("https://a.test/" + "p".repeat(200)).length).toBeLessThanOrEqual(60);
    });

    it("shows an address without credentials or query values", () => {
        expect(safeAddress("https://user:pw@shop.test/cart?session=abc#frag")).toBe("https://shop.test/cart?…");
        expect(safeAddress("https://shop.test/#/orders/3?x=1")).toBe("https://shop.test/#/orders/3");
        expect(safeAddress("about:blank")).toBe("");
        expect(safeAddress("javascript:alert(1)")).toBe("");
    });
});

describe("the per-job picture store", () => {
    function hub() {
        let t = 1_000_000;
        const h = new FrameHub(() => t);
        return { h, advance: (ms: number) => void (t += ms) };
    }

    it("holds one latest picture per job and forgets everything about a job when it is dropped", () => {
        const { h } = hub();
        h.put("j1", frame({ note: "one" }));
        h.put("j1", frame({ note: "two" }));
        expect(h.latest("j1")?.note).toBe("two");
        expect(h.heldJobs).toBe(1);
        h.markWatched("j1");
        h.addSecrets("j1", ["pw-secret"]);
        h.drop("j1");
        expect(h.latest("j1")).toBeUndefined();
        expect(h.isWatched("j1")).toBe(false);
        expect(h.secretsOf("j1")).toEqual([]);
    });

    it("holds pictures of at most eight jobs; the oldest goes first", () => {
        const { h, advance } = hub();
        for (let i = 1; i <= MAX_FRAME_JOBS + 2; i++) {
            h.put(`j${i}`, frame());
            advance(10);
        }
        expect(h.heldJobs).toBe(MAX_FRAME_JOBS);
        expect(h.latest("j1")).toBeUndefined();
        expect(h.latest("j2")).toBeUndefined();
        expect(h.latest("j3")).toBeDefined();
        expect(h.latest(`j${MAX_FRAME_JOBS + 2}`)).toBeDefined();
    });

    it("lets a picture go after thirty seconds without a new one", () => {
        const { h, advance } = hub();
        h.put("j1", frame());
        advance(FRAME_IDLE_MS - 1);
        expect(h.latest("j1")).toBeDefined();
        advance(2);
        expect(h.latest("j1")).toBeUndefined();
    });

    it("counts a job as watched for ten seconds after each read", () => {
        const { h, advance } = hub();
        expect(h.targetFor("j1").wanted()).toBe(false);
        h.markWatched("j1");
        expect(h.targetFor("j1").wanted()).toBe(true);
        advance(WATCH_WINDOW_MS - 1);
        expect(h.isWatched("j1")).toBe(true);
        h.markWatched("j1");
        advance(WATCH_WINDOW_MS - 1);
        expect(h.isWatched("j1")).toBe(true);
        advance(2);
        expect(h.isWatched("j1")).toBe(false);
    });

    it("stores what the target accepts and nothing else", () => {
        const { h } = hub();
        h.targetFor("j9").accept(frame({ note: "from the sink" }));
        expect(h.latest("j9")?.note).toBe("from the sink");
    });

    it("allows three reads a second per job, counted separately for each job", () => {
        const { h, advance } = hub();
        const results = Array.from({ length: READS_PER_SECOND + 2 }, () => h.allowRead("j1"));
        expect(results).toEqual([true, true, true, false, false]);
        expect(h.allowRead("j2")).toBe(true);
        advance(1001);
        expect(h.allowRead("j1")).toBe(true);
    });

    it("lists a job's stored secrets once each, bounded", () => {
        const { h } = hub();
        h.addSecrets("j1", ["a-password", undefined, "", "a-password", null, "other"]);
        expect(h.secretsOf("j1")).toEqual(["a-password", "other"]);
    });
});

describe("what can be watched when", () => {
    const base = { cancelRequested: false } as const;
    const local = new FrameHub();
    local.markLocal();
    const job = (status: string, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ ...base, ...extra, status, options: { maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false, ...options } }) as never;

    it("an exploration can be watched while it explores, and not while it analyses or plans", () => {
        expect(watchState(job("DISCOVERING"), { hub: local }).canWatch).toBe(true);
        expect(watchState(job("DISCOVERING", { planOnly: true }), { hub: local }).canWatch).toBe(true);
        for (const s of ["ANALYZING", "PLANNING", "GENERATING", "VALIDATING", "QUEUED"]) expect(watchState(job(s), { hub: local })).toMatchObject({ canWatch: false, why: "nothing", reason: REASONS.nothing });
    });

    it("creating tests from a plan has no browser to show", () => {
        expect(watchState(job("DISCOVERING", { fromPlan: "j0" }), { hub: local }).canWatch).toBe(false);
    });

    it("a test built from a sentence can be watched while it is built, a plain API test never", () => {
        expect(watchState(job("GENERATING", { mode: "plain", plainKind: "web" }), { hub: local }).canWatch).toBe(true);
        expect(watchState(job("GENERATING", { mode: "plain" }), { hub: local }).canWatch).toBe(true);
        expect(watchState(job("GENERATING", { mode: "plain", plainKind: "api" }), { hub: local }).canWatch).toBe(false);
        expect(watchState(job("VALIDATING", { mode: "plain" }), { hub: local }).canWatch).toBe(false);
    });

    it("says another computer when the run part is on a runner", () => {
        expect(watchState(job("VALIDATING", { mode: "plain" }), { hub: local, ranOnAgent: true })).toMatchObject({ canWatch: false, why: "elsewhere", reason: REASONS.elsewhere });
        expect(REASONS.elsewhere).toBe("This part runs on another computer and cannot be shown.");
        expect(REASONS.nothing).toBe("Nothing to show right now.");
    });

    it("a finished or stopping job shows nothing, and a platform whose worker is elsewhere says so", () => {
        for (const s of ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"]) expect(watchState(job(s), { hub: local })).toMatchObject({ canWatch: false, why: "finished" });
        expect(watchState(job("DISCOVERING", {}, { cancelRequested: true }), { hub: local })).toMatchObject({ canWatch: false, why: "stopping" });
        expect(watchState(job("DISCOVERING"), { hub: new FrameHub() })).toMatchObject({ canWatch: false, why: "unavailable" });
    });
});

describe("the words of the panel", () => {
    it("says the phase, the pages and the age in plain words", () => {
        expect(phaseWords("exploring")).toBe("Exploring pages");
        expect(phaseWords("signing-in")).toBe("Signing in");
        expect(phaseWords("building")).toBe("Building your test");
        expect(pagesWords(12)).toBe("12 pages seen");
        expect(pagesWords(1)).toBe("1 page seen");
        expect(updatedWords(1000)).toBe("Updated just now");
        expect(updatedWords(12_000)).toBe("Updated 12 seconds ago");
        expect(finishedWords("generate", 14)).toBe("Exploration finished: 14 pages seen");
        expect(finishedWords("generate", 3, true)).toBe("Exploration stopped: 3 pages seen");
    });

    it("offers the switch for an exploration and for a sentence, not for runs or creating from a plan", () => {
        expect(canOfferWatch({ mode: "generate" })).toBe(true);
        expect(canOfferWatch({ mode: undefined })).toBe(true);
        expect(canOfferWatch({ mode: "plain" })).toBe(true);
        expect(canOfferWatch({ mode: "generate", fromPlan: "j0" })).toBe(false);
        expect(canOfferWatch({ mode: "validate" })).toBe(false);
        expect(canOfferWatch({ mode: "variants" })).toBe(false);
    });
});
