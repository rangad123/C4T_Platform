/**
 * Clean account state for the replays (row 229, fix 1b), the rules without a browser (fast tier):
 *   - cleanReplayPlan: a replay that signs in as the main account is registered as a new account only when the project allows data
 *     changes, the exploration found a sign-up page, the test is not a named role's and does not use the main account's starting data;
 *     a test that never signs in is clean as it is; every other case says why it stays on the shared account;
 *   - replayAccountPreparer registers once per call and falls back to the shared account (with the reason) when that fails or throws;
 *   - `not_on_clean_state` is a valid finding verdict that is never high, and the run page explains it.
 * The browser side is tests/explore-clean-replay.test.ts; the job side tests/orchestrator-clean-replay.test.ts.
 */
import { describe, expect, it } from "vitest";
import { cleanReplayPlan, replayAccountPreparer, signupPathOf, usesTestAccount } from "../src/engine/explore/clean-account.js";
import { CandidateFindingSchema, confidenceOf, INDEPENDENCE_RESULTS } from "../src/engine/explore/finding.js";
import type { Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { confidenceMeaning } from "../web/src/features/runs/findings.js";

const signIn: Step[] = [
    { action: "navigate", url: "/login" },
    { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
] as Step[];
const cart: Step[] = [...signIn, { action: "navigate", url: "/cart" } as Step];
const base = { steps: cart, roleAccount: false, dataChanges: true, signupPath: "/register", startingIds: new Set(["ord-1000", "ord-1001"]) };

describe("cleanReplayPlan", () => {
    it("registers a new account when every condition holds", () => {
        expect(cleanReplayPlan(base)).toEqual({ register: true, signupPath: "/register" });
        // An id that is not starting data (one an earlier test made) does not stop it: the new account simply will not have it.
        expect(cleanReplayPlan({ ...base, steps: [...cart, { action: "navigate", url: "/orders/ord-1008" } as Step] })).toEqual({ register: true, signupPath: "/register" });
    });

    it("a test that never signs in is clean as it is", () => {
        expect(cleanReplayPlan({ ...base, steps: [{ action: "navigate", url: "/cart" } as Step], dataChanges: false, signupPath: undefined })).toEqual({ register: false, clean: true, why: "signed out in a fresh browser" });
        expect(usesTestAccount([{ action: "navigate", url: "/" } as Step])).toBe(false);
        expect(usesTestAccount(signIn)).toBe(true);
    });

    it("otherwise stays on the shared account and says why", () => {
        const shared = (over: Partial<typeof base>) => cleanReplayPlan({ ...base, ...over }) as { register: false; clean: boolean; why: string };
        for (const [over, why] of [
            [{ dataChanges: false }, /does not allow tests that change data/],
            [{ signupPath: undefined }, /no sign-up page/],
            [{ roleAccount: true }, /named test account/],
            [{ steps: [...cart, { action: "click", locator: { by: "role", role: "link", value: "ord-1000" } } as Step] }, /starting data, ord-1000/],
        ] as const) {
            const p = shared(over as Partial<typeof base>);
            expect(p.register).toBe(false);
            expect(p.clean).toBe(false);
            expect(p.why).toMatch(why);
            expect(p.why).toMatch(/^on the shared test account \(.*\), so not checked on clean state$/);
        }
    });
});

describe("signupPathOf", () => {
    const model = (auth: Partial<AppModel["authentication"]>, pages: Array<{ path: string; type: string }>) => ({ authentication: { required: true, mechanisms: [], loggedIn: true, ...auth }, pages }) as unknown as AppModel;
    it("takes the model's sign-up path, else the first page the crawl classed as registration (the bench model has only the page)", () => {
        expect(signupPathOf(model({ signupPath: "/join" }, [{ path: "/register", type: "register" }]))).toBe("/join");
        expect(signupPathOf(model({}, [{ path: "/login", type: "login" }, { path: "/register", type: "register" }]))).toBe("/register");
        expect(signupPathOf(model({}, [{ path: "/login", type: "login" }]))).toBeUndefined();
        expect(signupPathOf(undefined)).toBeUndefined();
    });
});

describe("replayAccountPreparer", () => {
    const creds = { username: "qa+replay-1@example.com", password: "Qa-secret-7z!" };
    it("registers once per call and gives that account, clean", async () => {
        let n = 0;
        const prepare = replayAccountPreparer({ register: true, signupPath: "/register" }, async () => ({ ok: true, credentials: { ...creds, username: `qa+replay-${++n}@example.com` } }));
        expect(await prepare()).toEqual({ credentials: { ...creds, username: "qa+replay-1@example.com" }, clean: true, note: "as a newly registered account" });
        expect((await prepare()).credentials?.username).toBe("qa+replay-2@example.com");
        expect(n).toBe(2);
    });

    it("a registration that fails or throws falls back to the shared account and says why", async () => {
        const failed = await replayAccountPreparer({ register: true, signupPath: "/register" }, async () => ({ ok: false, why: "the sign-up form has a required checkbox (terms or consent)" }))();
        expect(failed).toEqual({ clean: false, note: "on the shared test account (a new account could not be registered: the sign-up form has a required checkbox (terms or consent)), so not checked on clean state" });
        const threw = await replayAccountPreparer({ register: true, signupPath: "/register" }, () => Promise.reject(new Error("browser closed\nstack")))();
        expect(threw).toMatchObject({ clean: false, note: expect.stringMatching(/could not be registered: registering failed: browser closed\)/) });
    });

    it("a plan without registering never registers", async () => {
        let n = 0;
        const why = "on the shared test account (x), so not checked on clean state";
        expect(await replayAccountPreparer({ register: false, clean: false, why }, async () => (n++, { ok: true, credentials: creds }))()).toEqual({ clean: false, note: why });
        expect(await replayAccountPreparer({ register: false, clean: true, why: "signed out in a fresh browser" }, async () => (n++, { ok: true, credentials: creds }))()).toEqual({ clean: true, note: "signed out in a fresh browser" });
        expect(n).toBe(0);
    });
});

describe("not checked on clean state", () => {
    it("is a finding verdict that is never high, and the run page says what it means", () => {
        expect(INDEPENDENCE_RESULTS).toContain("not_on_clean_state");
        expect(confidenceOf({ sourced: true, capture: "captured", independence: "not_on_clean_state" })).toBe("medium");
        expect(confidenceOf({ sourced: true, capture: "captured", independence: "independent" })).toBe("high");
        const finding = {
            objective: null, actions: { stepCount: 5 }, expected: { text: "The total is $25.00", source: "R-TOTAL" }, observed: "The total shows $30.00",
            evidence: { screenshots: [], requests: [], console: [] }, capture: "captured", independence: "not_on_clean_state", confidence: "medium", fingerprint: "a".repeat(64), modelVersion: null, replays: [],
        };
        expect(CandidateFindingSchema.safeParse(finding).success).toBe(true);
        expect(CandidateFindingSchema.safeParse({ ...finding, confidence: "high" }).success).toBe(false);
        expect(confidenceMeaning({ confidence: "medium", independence: "not_on_clean_state" })).toMatch(/failed the same way when replayed, but on the shared test account/);
    });
});
