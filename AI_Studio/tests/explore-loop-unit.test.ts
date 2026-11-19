/**
 * The bounded exploration loop and state fingerprints (Phase 3, P3-06). Pure (fast tier): no browser, no AI.
 *
 * Expected values come from the Phase 3 plan and spec (E6): objectives are pursued by priority; an objective whose fingerprint was
 * already done is skipped; a pursuit stops when it revisits one state more often than the depth allows or repeats the same action on
 * the same state (re-explored 0 times); budgets are counted by the loop from the injected usage counter, never from what the objective
 * run reports; a safe reset runs between objectives; N consecutive environment failures stop the session (instability); and every
 * session ends with exactly one stop reason from the fixed list.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runExploration, STOP_REASONS, type Budgets, type LoopObjective, type ObjectiveContext, type ObjectiveRun } from "../src/engine/explore/loop.js";
import { outlineShape, pathPattern, stateFingerprint } from "../src/engine/explore/state.js";

// ---------------------------------------------------------------------------------------------------------------- state fingerprints

describe("pathPattern", () => {
    it("replaces numeric, uuid and long id segments with :id and keeps words", () => {
        expect(pathPattern("https://shop.test/orders/1234")).toBe("/orders/:id");
        expect(pathPattern("https://shop.test/orders/9")).toBe("/orders/:id");
        expect(pathPattern("https://shop.test/u/3f2b9c1e-8a7d-4c2b-9e1f-0a1b2c3d4e5f/profile")).toBe("/u/:id/profile");
        expect(pathPattern("https://shop.test/item/5f8a9c0d12ef")).toBe("/item/:id");
        expect(pathPattern("https://shop.test/orders/ord_8f3k2x9")).toBe("/orders/:id");
        expect(pathPattern("https://shop.test/checkout-step-2")).toBe("/checkout-step-2");
        expect(pathPattern("https://shop.test/api/v2/cart")).toBe("/api/v2/cart");
        expect(pathPattern("https://shop.test/checkout/shipping/")).toBe("/checkout/shipping");
    });

    it("keeps query keys but never their values, so two searches are one state", () => {
        expect(pathPattern("https://shop.test/search?q=mug&page=2")).toBe(pathPattern("https://shop.test/search?page=9&q=lamp"));
        expect(pathPattern("https://shop.test/search?q=mug")).not.toBe(pathPattern("https://shop.test/search"));
    });

    it("reads a hash route as part of the path", () => {
        expect(pathPattern("https://app.test/#/orders/77")).toBe("/#/orders/:id");
    });
});

const CART_A = `- banner:
  - heading "Shop" [level=1]
  - link "Cart (3)":
    - /url: /cart
- main:
  - textbox "Email": alice@example.com
  - text: Welcome back Alice
  - list:
    - listitem: Blue mug
    - listitem: Red lamp
  - button "Checkout"`;

// The same screen with other text values, another count in a name and a longer list.
const CART_B = `- banner:
  - heading "Shop" [level=1]
  - link "Cart (4)":
    - /url: /cart?x=1
- main:
  - textbox "Email": bob@example.com
  - text: Welcome back Bob
  - list:
    - listitem: Green cup
    - listitem: Red lamp
    - listitem: Desk
  - button "Checkout"`;

describe("stateFingerprint", () => {
    it("ignores text values, counts in names and list length", () => {
        expect(stateFingerprint("https://shop.test/cart", CART_A)).toBe(stateFingerprint("https://shop.test/cart", CART_B));
    });

    it("ignores a text line that comes and goes (a status message is a value, not a new screen)", () => {
        expect(stateFingerprint("https://shop.test/cart", CART_A + "\n- text: Saved.")).toBe(stateFingerprint("https://shop.test/cart", CART_A));
    });

    it("differs when a role or a name changes, or the path pattern changes", () => {
        const base = stateFingerprint("https://shop.test/cart", CART_A);
        expect(stateFingerprint("https://shop.test/cart", CART_A.replace('button "Checkout"', 'button "Pay now"'))).not.toBe(base);
        expect(stateFingerprint("https://shop.test/cart", CART_A.replace('button "Checkout"', 'link "Checkout"'))).not.toBe(base);
        expect(stateFingerprint("https://shop.test/basket", CART_A)).not.toBe(base);
    });

    it("starts with the path pattern so a log reader can tell states apart", () => {
        expect(stateFingerprint("https://shop.test/orders/12", CART_A).startsWith("/orders/:id|")).toBe(true);
        expect(stateFingerprint("https://shop.test/orders/12", CART_A)).toBe(stateFingerprint("https://shop.test/orders/13", CART_A));
    });

    it("drops lines that are not part of the outline (a truncation mark, an unavailable snapshot)", () => {
        expect(outlineShape(CART_A + "\n…(truncated)")).toBe(outlineShape(CART_A));
        expect(outlineShape("(accessibility snapshot unavailable)")).toBe("");
    });
});

// ---------------------------------------------------------------------------------------------------------------- the loop

const BUDGETS: Budgets = { objectives: 10, actions: 100, aiCalls: 100, tokens: 1_000_000, minutes: 60, depth: 3 };

interface Obj extends LoopObjective {
    script?: (ctx: ObjectiveContext) => Promise<ObjectiveRun>;
}

const obj = (id: string, priority: number, over: Partial<Obj> = {}): Obj => ({ id, priority, fingerprint: `fp-${id}`, ...over });

/** A fake world: a clock, an AI usage counter, and a log of resets. */
function world() {
    const w = { clock: 0, aiCalls: 0, tokens: 0, resets: 0, order: [] as string[] };
    return {
        w,
        now: () => w.clock,
        usage: () => ({ aiCalls: w.aiCalls, tokens: w.tokens }),
        reset: async () => {
            w.resets += 1;
            w.order.push("reset");
        },
    };
}

const done = (): ObjectiveRun => ({ status: "completed" });

/** Performs `n` distinct actions on distinct states, then completes; stops early when the loop refuses. */
const walk =
    (n: number, perAction: (w: ReturnType<typeof world>["w"]) => void = () => undefined, w?: ReturnType<typeof world>["w"]) =>
    async (ctx: ObjectiveContext): Promise<ObjectiveRun> => {
        for (let i = 0; i < n; i++) {
            const v = ctx.act({ state: `s${i}`, action: `click #${i}` });
            if (!v.allowed) return done();
            if (w) perAction(w);
        }
        return done();
    };

function run(objectives: Obj[], over: Partial<Parameters<typeof runExploration<Obj>>[0]> = {}, fake = world()) {
    return runExploration<Obj>({
        objectives,
        budgets: BUDGETS,
        now: fake.now,
        usage: fake.usage,
        reset: fake.reset,
        runObjective: async (o, ctx) => {
            fake.w.order.push(o.id);
            return o.script ? o.script(ctx) : done();
        },
        ...over,
    });
}

describe("runExploration: order, dedupe and reset", () => {
    it("pursues objectives by priority (stable on ties) and resets between them, not before the first or after the last", async () => {
        const fake = world();
        const r = await run([obj("low", 1), obj("high", 9), obj("mid", 5), obj("mid2", 5)], {}, fake);
        expect(fake.w.order).toEqual(["high", "reset", "mid", "reset", "mid2", "reset", "low"]);
        expect(r.stopReason).toBe("objectives_done");
        expect(r.outcomes.map((o) => [o.objectiveId, o.status])).toEqual([
            ["high", "completed"],
            ["mid", "completed"],
            ["mid2", "completed"],
            ["low", "completed"],
        ]);
    });

    it("skips an objective whose fingerprint was already done (in this session or before it)", async () => {
        const fake = world();
        const r = await run([obj("a", 9, { fingerprint: "same" }), obj("b", 5, { fingerprint: "same" }), obj("c", 1, { fingerprint: "old" })], { doneFingerprints: ["old"] }, fake);
        expect(fake.w.order).toEqual(["a"]);
        expect(r.outcomes.find((o) => o.objectiveId === "b")).toMatchObject({ status: "skipped" });
        expect(r.outcomes.find((o) => o.objectiveId === "c")).toMatchObject({ status: "skipped" });
        expect(r.outcomes.find((o) => o.objectiveId === "b")!.reason).toMatch(/already/i);
        expect(r.stopReason).toBe("objectives_done");
    });

    it("never changes the caller's objective list", async () => {
        const list = [obj("b", 1), obj("a", 9)];
        const copy = structuredClone(list);
        await run(list);
        expect(list).toEqual(copy);
    });
});

describe("runExploration: repeated state and action", () => {
    it("refuses the same action on the same state, so it is re-explored 0 times", async () => {
        const verdicts: boolean[] = [];
        const r = await run([
            obj("a", 1, {
                script: async (ctx) => {
                    verdicts.push(ctx.act({ state: "s1", action: "click Add" }).allowed);
                    verdicts.push(ctx.act({ state: "s1", action: "click Add" }).allowed);
                    return done();
                },
            }),
        ]);
        expect(verdicts).toEqual([true, false]);
        expect(r.actionLog.filter((row) => row.result === "performed")).toHaveLength(1);
        expect(r.outcomes[0]).toMatchObject({ status: "stopped", actions: 1 });
        expect(r.outcomes[0]!.reason).toMatch(/same action/i);
        expect(r.usage.actions).toBe(1);
    });

    it("refuses an action its tracker refuses (the request bound, CP3b R-2): not performed, and the pursuit ends", async () => {
        const verdicts: boolean[] = [];
        const r = await run([
            obj("a", 1, {
                script: async (ctx) => {
                    verdicts.push(ctx.act({ state: "s1", action: "click Order", refusal: "The request POST /order was already sent 2 times in this pursuit." }).allowed);
                    verdicts.push(ctx.act({ state: "s2", action: "click Other" }).allowed);
                    return done();
                },
            }),
        ]);
        expect(verdicts).toEqual([false, false]);
        expect(r.actionLog.filter((row) => row.result === "performed")).toHaveLength(0);
        expect(r.outcomes[0]).toMatchObject({ status: "stopped", actions: 0, reason: "The request POST /order was already sent 2 times in this pursuit." });
    });

    it("stops a pursuit that visits one state more often than the depth allows", async () => {
        const verdicts: boolean[] = [];
        const r = await run(
            [
                obj("a", 1, {
                    script: async (ctx) => {
                        for (let i = 0; i < 5; i++) verdicts.push(ctx.act({ state: "home", action: `click link ${i}` }).allowed);
                        return done();
                    },
                }),
            ],
            { budgets: { ...BUDGETS, depth: 2 } },
        );
        expect(verdicts).toEqual([true, true, false, false, false]);
        expect(r.outcomes[0]).toMatchObject({ status: "stopped", actions: 2 });
        expect(r.outcomes[0]!.reason).toMatch(/state/i);
    });

    it("lets the next objective repeat an action after the reset (tracking is per pursuit)", async () => {
        const same = async (ctx: ObjectiveContext) => (ctx.act({ state: "login", action: "sign in" }).allowed ? done() : done());
        const r = await run([obj("a", 2, { script: same }), obj("b", 1, { script: same })]);
        expect(r.outcomes.map((o) => o.status)).toEqual(["completed", "completed"]);
        expect(r.usage.actions).toBe(2);
    });

    it("aborts the pursuit's signal when it refuses an action", async () => {
        let aborted = false;
        await run([
            obj("a", 1, {
                script: async (ctx) => {
                    ctx.act({ state: "s", action: "x" });
                    ctx.act({ state: "s", action: "x" });
                    aborted = ctx.signal.aborted;
                    return done();
                },
            }),
        ]);
        expect(aborted).toBe(true);
    });

    it("logs at most one refused row per pursuit, however often a pursuit keeps asking", async () => {
        const r = await run([
            obj("a", 1, {
                script: async (ctx) => {
                    for (let i = 0; i < 10_000; i++) ctx.act({ state: "s", action: "x" });
                    return done();
                },
            }),
        ]);
        expect(r.actionLog).toHaveLength(2);
        expect(r.actionLog[1]).toMatchObject({ result: "refused" });
    });
});

describe("runExploration: every stop reason is reachable (E6)", () => {
    it("actions: the loop's own count, never past the budget", async () => {
        const r = await run([obj("a", 2, { script: walk(50) }), obj("b", 1, { script: walk(50) })], { budgets: { ...BUDGETS, actions: 7 } });
        expect(r.stopReason).toBe("actions");
        expect(r.usage.actions).toBe(7);
        expect(r.actionLog.filter((row) => row.result === "performed")).toHaveLength(7);
        expect(r.outcomes.find((o) => o.objectiveId === "b")).toMatchObject({ status: "not_reached" });
    });

    it("ai_calls: counted from the injected usage counter", async () => {
        const fake = world();
        const r = await run([obj("a", 2, { script: walk(50, (w) => (w.aiCalls += 1), fake.w) }), obj("b", 1)], { budgets: { ...BUDGETS, aiCalls: 4 } }, fake);
        expect(r.stopReason).toBe("ai_calls");
        expect(r.usage.aiCalls).toBe(4);
        expect(fake.w.order).not.toContain("b");
    });

    it("tokens: counted from the injected usage counter", async () => {
        const fake = world();
        const r = await run([obj("a", 1, { script: walk(50, (w) => (w.tokens += 300), fake.w) })], { budgets: { ...BUDGETS, tokens: 1_000 } }, fake);
        expect(r.stopReason).toBe("tokens");
        expect(r.usage.tokens).toBe(1_200);
    });

    it("time: from the injected clock", async () => {
        const fake = world();
        const r = await run([obj("a", 1, { script: walk(50, (w) => (w.clock += 60_000), fake.w) })], { budgets: { ...BUDGETS, minutes: 3 } }, fake);
        expect(r.stopReason).toBe("time");
        expect(r.usage.actions).toBe(3);
    });

    it("time: a pursuit that never returns is abandoned when the time is up", async () => {
        const fake = world();
        let signal: AbortSignal | undefined;
        const r = await run(
            [
                obj("a", 1, {
                    script: (ctx) => {
                        signal = ctx.signal;
                        return new Promise<ObjectiveRun>(() => undefined);
                    },
                }),
            ],
            {
                wait: async () => {
                    fake.w.clock += 61 * 60_000;
                },
            },
            fake,
        );
        expect(r.stopReason).toBe("time");
        expect(r.outcomes[0]).toMatchObject({ status: "interrupted" });
        expect(signal?.aborted).toBe(true);
    });

    it("objectives_done: the objectives budget caps how many are pursued", async () => {
        const fake = world();
        const r = await run([obj("a", 3), obj("b", 2), obj("c", 1)], { budgets: { ...BUDGETS, objectives: 2 } }, fake);
        expect(r.stopReason).toBe("objectives_done");
        expect(fake.w.order.filter((x) => x !== "reset")).toEqual(["a", "b"]);
        expect(r.outcomes.find((o) => o.objectiveId === "c")).toMatchObject({ status: "not_reached" });
    });

    it("objectives_done: an empty list ends at once", async () => {
        const r = await run([]);
        expect(r.stopReason).toBe("objectives_done");
        expect(r.outcomes).toEqual([]);
    });

    it("instability: N consecutive environment failures (a thrown error counts as one)", async () => {
        const fake = world();
        const fail = async (): Promise<ObjectiveRun> => ({ status: "environment_failure", reason: "page did not load" });
        const boom = async (): Promise<ObjectiveRun> => {
            throw new Error("browser closed");
        };
        const r = await run([obj("a", 5, { script: fail }), obj("b", 4, { script: boom }), obj("c", 3, { script: fail }), obj("d", 1)], { instabilityLimit: 3 }, fake);
        expect(r.stopReason).toBe("instability");
        expect(fake.w.order).not.toContain("d");
        expect(r.outcomes.find((o) => o.objectiveId === "b")).toMatchObject({ status: "environment_failure" });
        expect(r.outcomes.find((o) => o.objectiveId === "b")!.reason).toMatch(/browser closed/);
    });

    // Row 186: a test writer that stopped before finishing is its own outcome, not a broken environment and not a finished pursuit.
    it("a pursuit whose test writer stopped is recorded as such, with its reason, and the session goes on", async () => {
        const stopped = async (): Promise<ObjectiveRun> => ({ status: "writer_stopped", reason: "The test writer stopped before finishing the test." });
        const fake = world();
        const r = await run([obj("a", 5, { script: stopped }), obj("b", 4, { script: stopped }), obj("c", 3, { script: stopped }), obj("d", 1)], { instabilityLimit: 2 }, fake);
        expect(r.stopReason).toBe("objectives_done");
        expect(fake.w.order.filter((x) => x !== "reset")).toEqual(["a", "b", "c", "d"]);
        expect(r.outcomes.map((o) => [o.objectiveId, o.status, o.reason])).toEqual([
            ["a", "writer_stopped", "The test writer stopped before finishing the test."],
            ["b", "writer_stopped", "The test writer stopped before finishing the test."],
            ["c", "writer_stopped", "The test writer stopped before finishing the test."],
            ["d", "completed", "Pursued to the end."],
        ]);
    });

    it("instability: a success in between resets the count", async () => {
        const fail = async (): Promise<ObjectiveRun> => ({ status: "environment_failure", reason: "x" });
        const r = await run([obj("a", 5, { script: fail }), obj("b", 4, { script: fail }), obj("c", 3), obj("d", 2, { script: fail }), obj("e", 1, { script: fail })], { instabilityLimit: 3 });
        expect(r.stopReason).toBe("objectives_done");
    });

    it("instability: a failing reset counts as an environment failure", async () => {
        const fake = world();
        const r = await run([obj("a", 3), obj("b", 2), obj("c", 1)], {
            instabilityLimit: 1,
            reset: async () => {
                throw new Error("could not open a new browser context");
            },
        }, fake);
        expect(r.stopReason).toBe("instability");
        expect(fake.w.order).toEqual(["a"]);
        expect(r.stopDetail).toMatch(/new browser context/);
    });

    it("safety: an objective run that reports an unsafe action stops the session", async () => {
        const fake = world();
        const r = await run([obj("a", 2, { script: async () => ({ status: "unsafe", reason: "a payment button outside the allowed address" }) }), obj("b", 1)], {}, fake);
        expect(r.stopReason).toBe("safety");
        expect(fake.w.order).toEqual(["a"]);
        expect(r.outcomes[0]).toMatchObject({ status: "unsafe" });
    });

    it("cancelled: before the first objective", async () => {
        const ac = new AbortController();
        ac.abort();
        const fake = world();
        const r = await run([obj("a", 1)], { cancel: ac.signal }, fake);
        expect(r.stopReason).toBe("cancelled");
        expect(fake.w.order).toEqual([]);
    });

    it("cancelled: during a pursuit, which is abandoned and its signal aborted", async () => {
        const ac = new AbortController();
        let signal: AbortSignal | undefined;
        const r = await run(
            [
                obj("a", 2, {
                    script: (ctx) => {
                        signal = ctx.signal;
                        setTimeout(() => ac.abort(), 1);
                        return new Promise<ObjectiveRun>(() => undefined);
                    },
                }),
                obj("b", 1),
            ],
            { cancel: ac.signal },
        );
        expect(r.stopReason).toBe("cancelled");
        expect(signal?.aborted).toBe(true);
        expect(r.outcomes.map((o) => o.status)).toEqual(["interrupted", "not_reached"]);
    });

    it("STOP_REASONS is the fixed list from the plan", () => {
        expect([...STOP_REASONS].sort()).toEqual(["actions", "ai_calls", "cancelled", "instability", "objectives_done", "safety", "time", "tokens"]);
    });
});

describe("runExploration: budgets are the loop's, not the objective's", () => {
    it("a run that claims budget left does not extend the budget", async () => {
        const fake = world();
        const liar = async (ctx: ObjectiveContext): Promise<ObjectiveRun> => {
            for (let i = 0; i < 3; i++) {
                ctx.act({ state: `s${i}`, action: "x" });
                fake.w.aiCalls += 1;
            }
            return { status: "completed", budgetLeft: { aiCalls: 1_000, actions: 1_000 }, usage: { aiCalls: 0, actions: 0 } } as unknown as ObjectiveRun;
        };
        const r = await run([obj("a", 3, { script: liar }), obj("b", 2, { script: liar }), obj("c", 1, { script: liar })], { budgets: { ...BUDGETS, aiCalls: 5 } }, fake);
        expect(r.stopReason).toBe("ai_calls");
        expect(r.usage.aiCalls).toBe(6);
        expect(fake.w.order.filter((x) => x !== "reset")).toEqual(["a", "b"]);
    });

    it("counts usage from the session start, not the counter's absolute value", async () => {
        const fake = world();
        fake.w.aiCalls = 500;
        const r = await run([obj("a", 1, { script: walk(3, (w) => (w.aiCalls += 1), fake.w) })], { budgets: { ...BUDGETS, aiCalls: 10 } }, fake);
        expect(r.stopReason).toBe("objectives_done");
        expect(r.usage.aiCalls).toBe(3);
    });

    it("check() reports a spent budget before the pursuit spends more", async () => {
        const fake = world();
        let seen: string | null = "unset";
        await run(
            [
                obj("a", 1, {
                    script: async (ctx) => {
                        fake.w.tokens += 5_000;
                        seen = ctx.check();
                        return done();
                    },
                }),
            ],
            { budgets: { ...BUDGETS, tokens: 1_000 } },
            fake,
        );
        expect(seen).toBe("tokens");
    });

    it("a budget below 1 is refused before anything runs", async () => {
        await expect(run([obj("a", 1)], { budgets: { ...BUDGETS, actions: 0 } })).rejects.toThrow(/actions/);
        await expect(run([obj("a", 1)], { budgets: { ...BUDGETS, minutes: Number.NaN } })).rejects.toThrow(/minutes/);
    });
});

describe("runExploration: exactly one stop reason", () => {
    it("every session above ends with one reason from the list and a sentence", async () => {
        const sessions = await Promise.all([
            run([obj("a", 1)]),
            run([obj("a", 1, { script: walk(9) })], { budgets: { ...BUDGETS, actions: 2 } }),
            run([obj("a", 1, { script: async () => ({ status: "unsafe", reason: "x" }) })]),
        ]);
        for (const s of sessions) {
            expect(STOP_REASONS).toContain(s.stopReason);
            expect(typeof s.stopReason).toBe("string");
            expect(s.stopDetail.length).toBeGreaterThan(0);
        }
    });

    it("a budget spent and then a safety report in the same pursuit: the first recorded is the stop reason, the outcome keeps the report", async () => {
        const r = await run(
            [
                obj("a", 1, {
                    script: async (ctx) => {
                        ctx.act({ state: "s0", action: "x" });
                        ctx.act({ state: "s1", action: "y" });
                        return { status: "unsafe", reason: "high-impact gate" };
                    },
                }),
            ],
            { budgets: { ...BUDGETS, actions: 1 } },
        );
        expect(r.stopReason).toBe("actions");
        expect(r.outcomes[0]).toMatchObject({ status: "unsafe" });
    });

    it("action log rows carry the objective, state, action, time and sequence", async () => {
        const fake = world();
        const r = await run([obj("a", 1, { script: walk(2, (w) => (w.clock += 1_000), fake.w) })], {}, fake);
        expect(r.actionLog).toEqual([
            { seq: 1, objectiveId: "a", state: "s0", action: "click #0", atMs: 0, result: "performed" },
            { seq: 2, objectiveId: "a", state: "s1", action: "click #1", atMs: 1_000, result: "performed" },
        ]);
    });
});

describe("runExploration: the live list is told of each pursuit (row 173)", () => {
    it("tells each pursuit's start before it runs and its end with its outcome; skipped and unreached objectives are not told", async () => {
        const told: string[] = [];
        const fake = world();
        const r = await run(
            [obj("a", 9), obj("dup", 8, { fingerprint: "fp-a" }), obj("bad", 7, { script: async () => ({ status: "environment_failure", reason: "gone" }) }), obj("c", 6)],
            {
                budgets: { ...BUDGETS, objectives: 2 },
                onPursuit: (o, outcome) => {
                    told.push(outcome ? `${o.id} finished ${outcome.status}` : `${o.id} started`);
                    fake.w.order.push(`told ${o.id}`);
                },
            },
            fake,
        );
        expect(told).toEqual(["a started", "a finished completed", "bad started", "bad finished environment_failure"]);
        // Started is told before the objective runs.
        expect(fake.w.order.slice(0, 2)).toEqual(["told a", "a"]);
        expect(r.outcomes.map((o) => [o.objectiveId, o.status])).toEqual([
            ["a", "completed"],
            ["dup", "skipped"],
            ["bad", "environment_failure"],
            ["c", "not_reached"],
        ]);
    });

    it("a listener that throws changes nothing", async () => {
        const quiet = await run([obj("a", 2), obj("b", 1)]);
        const loud = await run([obj("a", 2), obj("b", 1)], { onPursuit: () => { throw new Error("listener broke"); } });
        expect(loud).toEqual(quiet);
    });
});

describe("runExploration: a cancel after a budget already stopped the session (CP2 H-1)", () => {
    const script = fileURLToPath(new URL("./fixtures/loop-cancel-after-stop.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    // Its own process: a starved event loop would also starve this test's own timeout.
    for (const kind of ["actions", "ai_calls", "tokens"]) {
        it(`${kind}: the session still ends, and the event loop keeps running while it waits`, () => {
            const p = spawnSync(tsx, [script, kind], { encoding: "utf8", timeout: 8_000 });
            expect(p.stdout.trim(), `the session never ended within 8 s (event loop starved); ${p.error?.message ?? ""} ${p.stderr}`).not.toBe("");
            const out = JSON.parse(p.stdout.trim().split("\n").pop()!) as { stopReason: string; status: string; ms: number; ticks: number };
            // The first stop reason stays; the cancelled pursuit is abandoned at once instead of awaited.
            expect(out.stopReason).toBe(kind);
            expect(out.status).toBe("interrupted");
            expect(out.ms).toBeLessThan(2_000);
        }, 20_000);
    }

    it("an injected wait that returns at once is not spun on after the cancel", async () => {
        const fake = world();
        const cancel = new AbortController();
        let waits = 0;
        let finish: (r: ObjectiveRun) => void = () => undefined;
        const r = await run(
            [
                obj("a", 1, {
                    script: (ctx) => {
                        ctx.act({ state: "s", action: "a1" });
                        ctx.act({ state: "s", action: "a2" });
                        cancel.abort();
                        return new Promise<ObjectiveRun>((resolve) => (finish = resolve));
                    },
                }),
            ],
            {
                budgets: { ...BUDGETS, actions: 1 },
                cancel: cancel.signal,
                // A loop that keeps waiting is let out after 50 rounds (the pursuit ends), so the test fails instead of hanging.
                wait: async () => {
                    waits += 1;
                    if (waits >= 50) finish(done());
                },
            },
            fake,
        );
        expect(r.stopReason).toBe("actions");
        expect(r.outcomes[0]).toMatchObject({ status: "interrupted" });
        expect(waits).toBeLessThanOrEqual(1);
    });
});

describe("runExploration: reads, passes and replays (CP2 M-1, M-5)", () => {
    it("a read is counted and refused on a repeat, but is not a new visit of its state for the depth", async () => {
        let verdicts: boolean[] = [];
        const r = await run([
            obj("a", 1, {
                script: async (ctx) => {
                    // More checks on one state than the depth of 3 allows: all performed.
                    verdicts = [1, 2, 3, 4, 5].map((i) => ctx.act({ state: "s", action: `assert ${i}`, read: true }).allowed);
                    verdicts.push(ctx.act({ state: "s", action: "assert 1", read: true }).allowed);
                    return done();
                },
            }),
        ]);
        expect(verdicts).toEqual([true, true, true, true, true, false]);
        expect(r.usage.actions).toBe(5);
        expect(r.outcomes[0]).toMatchObject({ status: "stopped", reason: expect.stringMatching(/^The same action on the same state/) });
    });

    it("a fresh pass starts repeat and depth tracking again, and keeps the session's totals", async () => {
        const seen: boolean[] = [];
        const r = await run(
            [
                obj("a", 1, {
                    script: async (ctx) => {
                        for (let pass = 0; pass < 3; pass++) {
                            ctx.freshPass();
                            seen.push(ctx.act({ state: "s", action: "click" }).allowed);
                        }
                        return done();
                    },
                }),
            ],
            { budgets: { ...BUDGETS, actions: 2 } },
        );
        // The repeat is allowed again in a new pass, but the actions budget is the session's: the third is refused.
        expect(seen).toEqual([true, true, false]);
        expect(r.stopReason).toBe("actions");
        expect(r.usage.actions).toBe(2);
    });

    it("a replay is counted against the session's actions and refused (without ending the pursuit) when it would go past them", async () => {
        const verdicts: boolean[] = [];
        const r = await run(
            [
                obj("a", 1, {
                    script: async (ctx) => {
                        verdicts.push(ctx.act({ state: "s", action: "click" }).allowed);
                        verdicts.push(ctx.replay(6, "two fresh replays").allowed);
                        verdicts.push(ctx.replay(4, "one more").allowed);
                        verdicts.push(ctx.signal.aborted);
                        verdicts.push(ctx.act({ state: "t", action: "click" }).allowed);
                        return done();
                    },
                }),
            ],
            { budgets: { ...BUDGETS, actions: 8 } },
        );
        expect(verdicts).toEqual([true, true, false, false, true]);
        expect(r.usage.actions).toBe(8);
        expect(r.outcomes[0]!.actions).toBe(8);
        expect(r.actionLog.map((a) => [a.action, a.result])).toEqual([
            ["click", "performed"],
            ["replay: two fresh replays (6 steps)", "performed"],
            ["replay: one more (4 steps)", "refused"],
            ["click", "performed"],
        ]);
    });

    it("the objectives budget's stop sentence names what it counts: objective pursuits (CP2 M-6)", async () => {
        const r = await run([obj("a", 3), obj("b", 2), obj("c", 1)], { budgets: { ...BUDGETS, objectives: 2 } });
        expect(r.stopReason).toBe("objectives_done");
        expect(r.stopDetail).toBe("The session's limit of 2 objective pursuits was reached.");
    });
});
