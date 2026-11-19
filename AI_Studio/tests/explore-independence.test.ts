/**
 * The independence check (Phase 3 P3-10): a defect test is replayed twice, each time in a fresh browser, and is `independent` only when
 * both replays stop at the same failing sourced check. D1's WEB-034 failed on replay because of what earlier runs left in the app; that
 * is the case the check must catch.
 *
 * The fixture app keeps state on the server: signing up a name works once, and afterwards that name is "already taken" and the page has
 * no "Continue to cart" link. The cart's total is wrong (seeded defect: 10 + 15 shows $30.00).
 */
import http from "node:http";
import type { Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CandidateFindingSchema, confidenceOf } from "../src/engine/explore/finding.js";
import { checkIndependence } from "../src/engine/explore/independence.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";

const PORT = 9886;
const BASE = `http://127.0.0.1:${PORT}`;
const taken = new Set<string>();
let seeded = true;
let visits = 0;

const server = http.createServer((req, res) => {
    const page = (title: string, body: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`);
    };
    if (req.method === "POST" && req.url === "/signup") {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => {
            const name = new URLSearchParams(b).get("name") ?? "";
            if (taken.has(name)) return page("Sign up", `<h1>That name is already taken</h1>`);
            taken.add(name);
            return page("Welcome", `<h1>Welcome ${name}</h1><a href="/cart">Continue to cart</a>`);
        });
        return;
    }
    if (req.url === "/hang") return; // never answers
    if (req.url?.startsWith("/busy")) {
        // A correct, slow page (CP3c T-2 case A): served after `?ms=`, it keeps a request open (so the network is never idle) and its
        // Total becomes $25.00 2.6 s after load.
        const ms = Number(new URL(req.url, BASE).searchParams.get("ms") ?? 0);
        return void setTimeout(() => page("Cart", `<h1>Cart</h1><p>Total: <output aria-label="Total">...</output></p><script>fetch('/hang');setTimeout(()=>{document.querySelector('output').textContent='$25.00'},2600)</script>`), ms);
    }
    if (req.url === "/cookiecart") {
        // Case B: the Total exists only with the cart cookie authoring's own session left; a fresh browser has an empty cart.
        const has = /cart=1/.test(req.headers.cookie ?? "");
        return page("Cart", `<h1>Cart</h1>${has ? `<p>Total: <output aria-label="Total">$30.00</output></p>` : `<p>Your cart is empty</p>`}`);
    }
    if (req.url === "/visit") {
        // Counts up on every load: a check of "Visit 1" passed while authoring (the planner's own guess) and fails in every fresh replay.
        visits += 1;
        return page("Cart", `<h1>Visit ${visits}</h1><p>Total: <output aria-label="Total">$30.00</output></p>`);
    }
    if (req.url === "/signup") return page("Sign up", `<h1>Sign up</h1><form method="post" action="/signup"><label>Name <input name="name"></label><button type="submit">Sign up</button></form>`);
    return page("Cart", `<h1>Cart</h1><ul><li>Mug $10.00</li><li>Plate $15.00</li></ul><p>Total: <output aria-label="Total">${seeded ? "$30.00" : "$25.00"}</output></p>`);
});

let browser: Browser;
beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    server.close();
});
beforeEach(() => {
    taken.clear();
    seeded = true;
});

const stepsOf = (steps: unknown[]): Step[] => TestSpecSchema.parse({ testId: "WEB-034", title: "Defect test", kind: "web", category: "c", source: { origin: "browser-agent" }, steps }).steps;
const totalCheck = { action: "assert", check: "exactText", locator: { by: "label", value: "Total" }, expected: "$25.00", source: "expected:1" };
/** Signs up a fixed name, goes on to the cart, checks the total: the sign-up leaves state that a second run trips over. */
const leaking = stepsOf([
    { action: "navigate", url: "/signup" },
    { action: "fill", locator: { by: "label", value: "Name" }, value: "bob" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign up" } },
    { action: "click", locator: { by: "role", role: "link", value: "Continue to cart" } },
    totalCheck,
]);
/** Opens the cart and checks the total: nothing it does changes the app. */
const clean = stepsOf([{ action: "navigate", url: "/cart" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Cart" } }, totalCheck]);

describe("independence check", () => {
    it("a clean defect test is independent: both fresh replays stop at the same failing sourced check", async () => {
        const r = await checkIndependence(browser, BASE, { steps: clean });
        expect(r.independence).toBe("independent");
        expect(r.replays).toHaveLength(2);
        for (const replay of r.replays) expect(replay).toMatchObject({ outcome: "failed", failedStep: 3 });
        expect(r.replays[0]!.summary).toMatch(/expected:1/);
        // The two summaries go into the finding's evidence as they are.
        const finding = CandidateFindingSchema.parse({
            objective: null, actions: { stepCount: clean.length }, expected: { text: "Total is $25.00", source: "expected:1" },
            observed: "Total showed $30.00", evidence: { screenshots: [], requests: [], console: [] },
            capture: "captured", independence: r.independence,
            confidence: confidenceOf({ sourced: true, capture: "captured", independence: r.independence }),
            fingerprint: "0".repeat(64), modelVersion: null, replays: r.replays,
        });
        expect(finding.confidence).toBe("high");
    }, 60_000);

    it("a test whose second run sees the state the first one left is state_dependent", async () => {
        const r = await checkIndependence(browser, BASE, { steps: leaking });
        expect(taken.has("bob")).toBe(true);
        expect(r.independence).toBe("state_dependent");
        expect(r.replays[0]).toMatchObject({ outcome: "failed", failedStep: 5 });
        expect(r.replays[1]).toMatchObject({ outcome: "failed", failedStep: 4 });
    }, 60_000);

    it("state left by authoring (the first replay fails before the check) is state_dependent", async () => {
        taken.add("bob");
        const r = await checkIndependence(browser, BASE, { steps: leaking });
        expect(r.independence).toBe("state_dependent");
        expect(r.replays[0]).toMatchObject({ outcome: "failed", failedStep: 4 });
    }, 60_000);

    it("a failing check without a source is not independent", async () => {
        const unsourced = stepsOf([{ action: "navigate", url: "/cart" }, { ...totalCheck, source: undefined }, totalCheck]);
        const r = await checkIndependence(browser, BASE, { steps: unsourced });
        expect(r.replays[0]).toMatchObject({ outcome: "failed", failedStep: 2 });
        expect(r.independence).toBe("state_dependent");
    }, 60_000);

    it("a defect that no longer shows (both replays pass) is not independent", async () => {
        seeded = false;
        const r = await checkIndependence(browser, BASE, { steps: clean });
        expect(r.replays.map((x) => x.outcome)).toEqual(["passed", "passed"]);
        expect(r.independence).toBe("state_dependent");
    }, 60_000);

    it("replays that stop at an earlier sourced check, never reaching the captured one, do not make it independent (CP3b R-3)", async () => {
        visits = 1;
        const steps = stepsOf([
            { action: "navigate", url: "/visit" },
            { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Visit 1" }, source: "expected:2" },
            totalCheck,
        ]);
        const r = await checkIndependence(browser, BASE, { steps, capturedSource: "expected:1" }, { stepTimeoutMs: 2_000 });
        // Both replays stop at the same sourced check, but it is the planner's guess at step 2, not the captured check at step 3.
        expect(r.replays.map((x) => x.failedStep)).toEqual([2, 2]);
        expect(r.independence).not.toBe("independent");
        for (const replay of r.replays) expect(replay.summary).toMatch(/did not reach the captured check \(step 3\)/);
        expect(confidenceOf({ sourced: true, capture: "captured", independence: r.independence })).not.toBe("high");
    }, 60_000);

    it("the captured check is the one named by its source, not just any later sourced check", async () => {
        // The captured check is expected:1 at step 2; a later sourced check (expected:2, the planner's) is not the captured one.
        const steps = stepsOf([{ action: "navigate", url: "/cart" }, totalCheck, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Cart" }, source: "expected:2" }]);
        const r = await checkIndependence(browser, BASE, { steps, capturedSource: "expected:1" });
        expect(r.replays.map((x) => x.failedStep)).toEqual([2, 2]);
        expect(r.independence).toBe("independent");
    }, 60_000);

    // CP3c T-2: "fails the same way". The captured check's failure while authoring (`capturedObserved`, Playwright's message) is an
    // assertion that saw a value; a replay reproduces it only by failing at that check the same kind of way.
    // As the defect test keeps them (author.ts: Playwright's message, its lines joined).
    const sawValue = (v: string) => `expect(locator).toHaveText(expected) failed Locator: getByLabel('Total') Expected: "$25.00" Received: "${v}" Timeout: 5000ms`;
    const sawNothing = `expect(locator).toBeVisible() failed Locator: getByLabel('Total') Expected: visible Timeout: 5000ms Error: element(s) not found`;

    it("case B: captured with a wrong Total, but the fresh browser has no Total at all: element missing is not the same failure", async () => {
        const steps = stepsOf([{ action: "navigate", url: "/cookiecart" }, totalCheck]);
        const r = await checkIndependence(browser, BASE, { steps, capturedSource: "expected:1", capturedObserved: sawValue("$30.00") }, { stepTimeoutMs: 1_500 });
        expect(r.replays.map((x) => x.failedStep)).toEqual([2, 2]);
        expect(r.independence).toBe("state_dependent");
        for (const replay of r.replays) expect(replay.summary).toMatch(/not the way it failed when captured/);
        expect(confidenceOf({ sourced: true, capture: "captured", independence: r.independence })).toBe("medium");
    }, 60_000);

    it("case A: a check the replay's time leaves less than its full step time is not run, so a slow correct page is no reproduction", async () => {
        // 1.5 s to serve the page plus 1 s to settle leave the check 1.5 of its 2 s.
        const steps = stepsOf([{ action: "navigate", url: "/busy?ms=1500" }, totalCheck]);
        const r = await checkIndependence(browser, BASE, { steps, capturedSource: "expected:1", capturedObserved: sawValue("$30.00") }, { stepTimeoutMs: 2_000 });
        expect(r.independence).toBe("state_dependent");
        for (const replay of r.replays) expect(replay.summary).toMatch(/time ran out before/);
    }, 60_000);

    it("the not-reached rule: a check the replay's time ran out before is no reproduction, even of a captured timeout", async () => {
        // Captured as a check that ran out of time: a replay's timeout there would be the same kind of failure, so only the rule that
        // a check never started reproduces nothing keeps this from being independent.
        const steps = stepsOf([{ action: "navigate", url: "/busy?ms=1500" }, totalCheck]);
        const r = await checkIndependence(browser, BASE, { steps, capturedSource: "expected:1", capturedObserved: "did not finish within 5 s" }, { stepTimeoutMs: 2_000 });
        expect(r.replays.map((x) => x.failedStep)).toEqual([2, 2]);
        expect(r.independence).toBe("state_dependent");
    }, 60_000);

    it("the same value as captured, or another wrong value, is the same failure: independent", async () => {
        const same = await checkIndependence(browser, BASE, { steps: clean, capturedSource: "expected:1", capturedObserved: sawValue("$30.00") });
        expect(same.independence).toBe("independent");
        expect(same.replays[0]!.summary).toMatch(/the same value as when captured/);
        const other = await checkIndependence(browser, BASE, { steps: clean, capturedSource: "expected:1", capturedObserved: sawValue("$31.00") });
        expect(other.independence).toBe("independent");
        expect(other.replays[0]!.summary).toMatch(/another value than when captured/);
    }, 60_000);

    it("a check captured as finding no element reproduces when the replays find none either", async () => {
        const steps = stepsOf([{ action: "navigate", url: "/cookiecart" }, { action: "assert", check: "visible", locator: { by: "label", value: "Total" }, source: "expected:1" }]);
        const r = await checkIndependence(browser, BASE, { steps, capturedSource: "expected:1", capturedObserved: sawNothing }, { stepTimeoutMs: 1_500 });
        expect(r.independence).toBe("independent");
    }, 60_000);

    it("without the captured failure's text, only an assertion that saw a value reproduces it", async () => {
        const steps = stepsOf([{ action: "navigate", url: "/cookiecart" }, totalCheck]);
        const r = await checkIndependence(browser, BASE, { steps, capturedSource: "expected:1" }, { stepTimeoutMs: 1_500 });
        expect(r.independence).toBe("state_dependent");
    }, 60_000);

    it("a test with no sourced check is not run (no browser opened)", async () => {
        const fake = { newContext: () => Promise.reject(new Error("no browser should open")) } as unknown as Browser;
        const r = await checkIndependence(fake, BASE, { steps: stepsOf([{ action: "navigate", url: "/cart" }, { ...totalCheck, source: undefined }]) });
        expect(r).toEqual({ independence: "not_run", replays: [] });
    });

    it("a replay that cannot start leaves the check not run", async () => {
        const fake = { newContext: () => Promise.reject(new Error("browser gone")) } as unknown as Browser;
        const r = await checkIndependence(fake, BASE, { steps: clean });
        expect(r.independence).toBe("not_run");
        expect(r.replays[0]).toMatchObject({ outcome: "error" });
    });

    it("both replays are bounded: a step that hangs stops at the step timeout, total within 2 x steps x the step timeout", async () => {
        const hanging = stepsOf([{ action: "navigate", url: "/hang" }, totalCheck]);
        const started = Date.now();
        const r = await checkIndependence(browser, BASE, { steps: hanging }, { stepTimeoutMs: 1_000 });
        const took = Date.now() - started;
        expect(r.independence).toBe("state_dependent");
        expect(r.replays.map((x) => x.failedStep)).toEqual([1, 1]);
        // 2 replays x 2 steps x 1 s, plus opening and closing two browser contexts.
        expect(took).toBeLessThan(2 * hanging.length * 1_000 + 3_000);
    }, 60_000);
});
