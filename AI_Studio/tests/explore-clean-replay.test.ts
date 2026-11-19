/**
 * Clean account state for the replays that judge a defect test (row 229, fix 1b), against a local shop that keeps each account's cart on
 * its server (fixtures/account-shop.ts). Row 227 found the independence check and the own-steps replay noisy both ways on the shared
 * test account: a test reading what earlier tests left came out `independent` (WEB-023, 062), the one true positive `state_dependent`
 * (WEB-006), and an observed-only test bound to an earlier test's order passed its own replay (WEB-033).
 *   - registerFreshAccount signs up through the page and checks the new account can sign in; it refuses a required terms box, a
 *     required field it cannot fill, and an account that cannot sign in (an e-mailed link);
 *   - on the shared account, a reproduced failure is `not_on_clean_state` (medium), never `independent`;
 *   - each replay as a newly registered account: the leftover-reading test is `state_dependent`, the true positive `independent` (high),
 *     the observed-only test fails its own replay; each replay its own account;
 *   - a registration that fails falls back to the shared account and says why; a test that never signs in registers nothing.
 * Fixture site: port 9922. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/explore-clean-replay.test.ts
 */
import type { Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanReplayPlan, registerFreshAccount, replayAccountPreparer } from "../src/engine/explore/clean-account.js";
import { confidenceOf } from "../src/engine/explore/finding.js";
import { checkIndependence, replayOwnSteps, type DefectTest } from "../src/engine/explore/independence.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import type { Step } from "../src/engine/spec/schema.js";
import { ALICE, startAccountShop, type AccountShop } from "./fixtures/account-shop.js";

const PORT = 9922;
let shop: AccountShop;
let browser: Browser;
beforeAll(async () => {
    shop = await startAccountShop(PORT);
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    await shop?.close();
});
beforeEach(() => shop.reset(["Mug", "Plate"]));

const signIn: Step[] = [
    { action: "navigate", url: "/login" },
    { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign in", exact: true } },
] as Step[];
const total = (expected: string): Step => ({ action: "assert", check: "exactText", locator: { by: "role", role: "status", value: "Total" }, expected, source: "R-TOTAL" }) as Step;
const add = (item: string): Step => ({ action: "click", locator: { by: "role", role: "link", value: `Add ${item}`, exact: true } }) as Step;

/** Reads what earlier tests left (WEB-062): no add, and the $25.00 it expects is the leftover lines' sum. Captured seeing $30.00. */
const leftoverReader: DefectTest = { steps: [...signIn, { action: "navigate", url: "/cart" } as Step, total("$25.00")], capturedSource: "R-TOTAL", capturedObserved: "$30.00", credentials: ALICE };
/** Sets up its own cart (WEB-006): adds both items, and the seeded defect shows on any account. Captured seeing $30.00. */
const ownSetup: DefectTest = { steps: [...signIn, { action: "navigate", url: "/cart" } as Step, add("Mug"), add("Plate"), total("$25.00")], capturedSource: "R-TOTAL", capturedObserved: "$30.00", credentials: ALICE };
const plan = (steps: readonly Step[]) => cleanReplayPlan({ steps, roleAccount: false, dataChanges: true, signupPath: "/register", startingIds: new Set(["ord-1000"]) });
const fresh = (steps: readonly Step[]) => replayAccountPreparer(plan(steps), () => registerFreshAccount(browser, shop.url, "/register", { loginPath: "/login" }));
const OPTS = { stepTimeoutMs: 4_000 };

describe("registerFreshAccount", () => {
    it("signs up through the page, and the new account signs in; each call is a new account", async () => {
        const a = await registerFreshAccount(browser, shop.url, "/register", { loginPath: "/login" });
        const b = await registerFreshAccount(browser, shop.url, "/register");
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(a.credentials.username).toMatch(/^qa\+replay-[0-9a-z]+@example\.com$/);
        expect(a.credentials.password.length).toBeGreaterThanOrEqual(12);
        expect(b.credentials.username).not.toBe(a.credentials.username);
        expect(shop.registered).toEqual([a.credentials.username, b.credentials.username]);
        // The sign-up signed it in once; the check signed it in again with the credentials it returns.
        expect(shop.signIns.filter((e) => e === a.credentials.username)).toHaveLength(2);
    }, 60_000);

    it("refuses a required terms box and a required field it cannot fill, without sending the form", async () => {
        shop.mode = "terms";
        const terms = await registerFreshAccount(browser, shop.url, "/register");
        expect(terms).toEqual({ ok: false, why: expect.stringMatching(/required checkbox/) });
        shop.mode = "company";
        const company = await registerFreshAccount(browser, shop.url, "/register");
        expect(company).toEqual({ ok: false, why: expect.stringMatching(/cannot fill/) });
        expect(shop.registered).toEqual([]);
    }, 60_000);

    it("an account that cannot sign in yet (an e-mailed link) is no clean account", async () => {
        shop.mode = "verify";
        const r = await registerFreshAccount(browser, shop.url, "/register", { loginPath: "/login" });
        expect(r).toEqual({ ok: false, why: expect.stringMatching(/signing in with the new account did not work/) });
        expect(shop.registered).toHaveLength(1);
    }, 60_000);

    it("a page without a sign-up form is refused", async () => {
        expect(await registerFreshAccount(browser, shop.url, "/register/pending")).toEqual({ ok: false, why: expect.stringMatching(/no password field/) });
    }, 30_000);
});

describe("the independence check on clean account state", () => {
    it("on the shared account a reproduced failure is not checked on clean state: never independent, so medium", async () => {
        const r = await checkIndependence(browser, shop.url, leftoverReader, OPTS);
        expect(r.independence).toBe("not_on_clean_state");
        expect(r.clean).toBe(false);
        expect(confidenceOf({ sourced: true, capture: "captured", independence: r.independence })).toBe("medium");
        for (const x of r.replays) expect(x.summary).toMatch(/^Replay \d in a fresh browser on the shared test account, so not checked on clean state: stopped at step 6/);
        expect(shop.registered).toEqual([]);
    }, 60_000);

    it("as newly registered accounts, a test that reads what earlier tests left is state dependent (WEB-062)", async () => {
        const r = await checkIndependence(browser, shop.url, leftoverReader, { ...OPTS, prepare: fresh(leftoverReader.steps) });
        expect(r.independence).toBe("state_dependent");
        expect(r.clean).toBe(true);
        for (const x of r.replays) expect(x.summary).toMatch(/as a newly registered account: stopped at step 6.*captured \$30\.00, replay saw \$0\.00/);
        // Each replay its own account, and each signed in with it (alice never).
        expect(shop.registered).toHaveLength(2);
        expect(new Set(shop.registered).size).toBe(2);
        expect(shop.signIns).not.toContain(ALICE.username);
        for (const e of shop.registered) expect(shop.signIns).toContain(e);
    }, 90_000);

    it("the true positive: on the shared account it stops early (alice's cart is locked), as new accounts it is independent and high (WEB-006)", async () => {
        shop.locked = true;
        const shared = await checkIndependence(browser, shop.url, ownSetup, OPTS);
        expect(shared.independence).toBe("state_dependent");
        expect(shared.replays[0]!.summary).toMatch(/stopped at step 6 .*a step that is not a check/);
        const clean = await checkIndependence(browser, shop.url, ownSetup, { ...OPTS, prepare: fresh(ownSetup.steps) });
        expect(clean.independence).toBe("independent");
        expect(confidenceOf({ sourced: true, capture: "captured", independence: clean.independence })).toBe("high");
        for (const x of clean.replays) expect(x.summary).toMatch(/as a newly registered account: stopped at step 8 .*saw the same value as when captured \(\$30\.00\)/);
    }, 90_000);

    it("a registration that fails falls back to the shared account and says why: not checked on clean state", async () => {
        shop.mode = "terms";
        const r = await checkIndependence(browser, shop.url, leftoverReader, { ...OPTS, prepare: fresh(leftoverReader.steps) });
        expect(r.independence).toBe("not_on_clean_state");
        expect(r.clean).toBe(false);
        for (const x of r.replays) expect(x.summary).toMatch(/on the shared test account \(a new account could not be registered: the sign-up form has a required checkbox/);
    }, 90_000);

    it("a prepare hook that throws is the shared account too", async () => {
        const r = await checkIndependence(browser, shop.url, leftoverReader, { ...OPTS, prepare: () => Promise.reject(new Error("boom")) });
        expect(r.independence).toBe("not_on_clean_state");
    }, 60_000);

    it("a test that never signs in is clean as it is: independent, and no account is registered", async () => {
        // The public home page says Shop; the check of R-TOTAL expects another heading, so it fails the same way every time.
        const signedOut: DefectTest = { steps: [{ action: "navigate", url: "/" } as Step, { action: "assert", check: "exactText", locator: { by: "role", role: "heading", value: "Shop" }, expected: "Welcome", source: "R-TOTAL" } as Step], capturedSource: "R-TOTAL", capturedObserved: '"Shop"' };
        const r = await checkIndependence(browser, shop.url, signedOut, { ...OPTS, prepare: fresh(signedOut.steps) });
        expect(r.independence).toBe("independent");
        expect(r.clean).toBe(true);
        expect(r.replays.map((x) => x.summary.split(":")[0])).toEqual(["Replay 1 in a fresh browser", "Replay 2 in a fresh browser"]);
        expect(shop.registered).toEqual([]);
    }, 60_000);
});

describe("the own-steps replay on clean account state", () => {
    // Observed only (WEB-033): opens the order an earlier test placed on the shared account.
    const order: DefectTest = { steps: [...signIn, { action: "navigate", url: "/orders" } as Step, { action: "click", locator: { by: "role", role: "link", value: "ord-1008", exact: true } } as Step, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Order ord-1008" } } as Step], credentials: ALICE };

    it("passes on the shared account (and says so), fails as a newly registered account", async () => {
        const shared = await replayOwnSteps(browser, shop.url, order, OPTS);
        expect(shared).toMatchObject({ outcome: "passed", clean: false });
        expect(shared.summary).toMatch(/on the shared test account/);
        const clean = await replayOwnSteps(browser, shop.url, order, { ...OPTS, prepare: fresh(order.steps) });
        expect(clean).toMatchObject({ outcome: "failed", failedStep: 6, clean: true });
        expect(clean.summary).toMatch(/^Replay of the saved test in a fresh browser as a newly registered account: stopped at step 6/);
        expect(shop.registered).toHaveLength(1);
    }, 60_000);
});
