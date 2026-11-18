/**
 * Run as its own process by explore-loop-unit.test.ts (CP2 H-1): a session already stopped by a budget (`argv[2]`: actions, ai_calls or
 * tokens) is cancelled while its pursuit winds down on a 100 ms timer. Prints one JSON line when the session ends; a starved event loop
 * never prints, and the parent's timeout kills it. Uses the loop's own default wait (a real timer), as the platform does.
 */
import { runExploration } from "../../src/engine/explore/loop.js";

const kind = process.argv[2] ?? "actions";
const cancel = new AbortController();
const u = { aiCalls: 0, tokens: 0 };
let ticks = 0;
const beat = setInterval(() => (ticks += 1), 10);
const t0 = Date.now();
const r = await runExploration({
    objectives: [{ id: "o1", priority: 1, fingerprint: "f1" }],
    budgets: { objectives: 5, actions: 1, aiCalls: 1, tokens: 10, minutes: 10, depth: 5 },
    now: Date.now,
    usage: () => ({ ...u }),
    reset: async () => undefined,
    cancel: cancel.signal,
    runObjective: async (_o, ctx) => {
        if (kind === "actions") {
            ctx.act({ state: "s", action: "a1" });
            ctx.act({ state: "s", action: "a2" }); // refused: the actions budget stops the session
        } else {
            if (kind === "ai_calls") u.aiCalls += 1;
            else u.tokens += 50;
            ctx.check(); // the AI budget stops the session
        }
        cancel.abort(); // a person presses Stop while the pursuit winds down
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: "completed" };
    },
});
clearInterval(beat);
console.log(JSON.stringify({ stopReason: r.stopReason, status: r.outcomes[0]?.status, ms: Date.now() - t0, ticks }));
