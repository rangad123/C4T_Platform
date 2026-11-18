/**
 * One lane per account (queue row 181a): scenarios and saved tests that sign in as the same account share that account's server-side
 * state (cart, discount, profile), so they never run at the same time; signed-out ones and other accounts' ones still run in parallel,
 * and the pool never runs more than its limit at once.
 *   - mapLanes (engine/context.ts): the scheduler the authoring pool uses;
 *   - validateBatch with accountLanes: the replays of saved tests, keyed by the account the test signs in as, through a fake executor.
 * No browser, no AI.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { mapLanes, type EngineContext } from "../src/engine/context.js";
import type { ScriptExecutor } from "../src/engine/frameworks/index.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { testAccountLane, validateBatch } from "../src/engine/validation/validator.js";

type Span = { id: string; lane: string | undefined; start: number; end: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
/** The most spans open at one moment. */
const peak = (spans: Span[]) => Math.max(...spans.map((s) => spans.filter((o) => o.start <= s.start && s.start < o.end).length));

describe("mapLanes: one lane per account", () => {
    // 3 scenarios as the main account, 1 as bob, 2 signed out (the proposal's shape), limit 3.
    const items = [
        { id: "M1", lane: "main" },
        { id: "F1", lane: undefined },
        { id: "M2", lane: "main" },
        { id: "R1", lane: "role:bob" },
        { id: "M3", lane: "main" },
        { id: "F2", lane: undefined },
    ];

    it("never overlaps one account, overlaps other accounts and signed-out work, stays within the limit, keeps lane order and result order", async () => {
        const spans: Span[] = [];
        let open = 0;
        let most = 0;
        const results = await mapLanes(items, 3, (i) => i.lane, async (i, index) => {
            const s: Span = { id: i.id, lane: i.lane, start: performance.now(), end: Infinity };
            spans.push(s);
            most = Math.max(most, ++open);
            await sleep(i.lane === "main" ? 40 : 60);
            open--;
            s.end = performance.now();
            return `${i.id}@${index}`;
        });

        expect(results.map((r) => (r.ok ? r.value : "error"))).toEqual(["M1@0", "F1@1", "M2@2", "R1@3", "M3@4", "F2@5"]);
        expect(most).toBeLessThanOrEqual(3);
        expect(peak(spans)).toBeLessThanOrEqual(3);
        const main = spans.filter((s) => s.lane === "main");
        for (const a of main) for (const b of main) if (a !== b) expect(overlaps(a, b), `${a.id} and ${b.id} ran at the same time`).toBe(false);
        // Within the lane, plan order is kept.
        expect(main.map((s) => s.id)).toEqual(["M1", "M2", "M3"]);
        // The other account and the signed-out scenarios run beside the main account's.
        const by = (id: string) => spans.find((s) => s.id === id)!;
        expect(main.some((m) => overlaps(m, by("R1")))).toBe(true);
        expect(main.some((m) => overlaps(m, by("F1")))).toBe(true);
        expect(main.some((m) => overlaps(m, by("F2")))).toBe(true);
        // Signed-out scenarios overlap each other too: they have no lane.
        expect(overlaps(by("F1"), by("F2")) || spans.filter((s) => s.lane !== "main").length < 2).toBe(true);
    });

    it("the longest lane starts first, so it is not left to run alone at the end", async () => {
        const started: string[] = [];
        await mapLanes([{ id: "F1" }, { id: "F2" }, { id: "M1", lane: "main" }, { id: "M2", lane: "main" }], 1, (i) => i.lane, async (i) => void started.push(i.id));
        expect(started[0]).toBe("M1");
        expect(started.indexOf("M1")).toBeLessThan(started.indexOf("M2"));
    });

    it("signed-out work alone runs as wide as the limit, and a failure is kept for its item without stopping its lane", async () => {
        let open = 0;
        let most = 0;
        const out = await mapLanes([1, 2, 3, 4, 5], 3, () => undefined, async (n) => {
            most = Math.max(most, ++open);
            await sleep(20);
            open--;
            return n;
        });
        expect(most).toBe(3);
        expect(out.map((r) => r.ok && r.value)).toEqual([1, 2, 3, 4, 5]);

        const lane = await mapLanes(["a", "b"], 2, () => "main", async (s) => {
            if (s === "a") throw new Error("boom");
            return s;
        });
        expect(lane[0]).toMatchObject({ ok: false, item: "a" });
        expect(lane[1]).toEqual({ ok: true, value: "b" });
    });
});

const signIn = (who?: string): Step[] => [
    { action: "navigate", url: "/login" },
    { action: "fill", locator: { by: "label", value: "Email" }, value: who ? `{{credentials.${who}.username}}` : "{{credentials.username}}" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: who ? `{{credentials.${who}.password}}` : "{{credentials.password}}" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign in" } },
] as Step[];
const spec = (n: number, steps: Step[]) =>
    TestSpecSchema.parse({ testId: `WEB-${String(n).padStart(3, "0")}`, title: `Test ${n}`, kind: "web", steps: [...steps, { action: "navigate", url: "/cart" }] });

describe("testAccountLane: the account a saved test signs in as", () => {
    it("main for the project's account, role:<name> for a named one, none for a signed-out test", () => {
        expect(testAccountLane({ spec: spec(1, signIn()) })).toBe("main");
        expect(testAccountLane({ spec: spec(2, signIn("bob")) })).toBe("role:bob");
        expect(testAccountLane({ spec: spec(3, []) })).toBeUndefined();
        // A hand-written script is read the same way.
        expect(testAccountLane({ spec: spec(4, []), custom: { filename: "t.spec.ts", content: "await page.fill('#e', process.env.TEST_USERNAME!)" } })).toBe("main");
        expect(testAccountLane({ spec: spec(5, []), custom: { filename: "t.spec.ts", content: "await page.fill('#e', process.env.TEST_BOB_USERNAME!)" } })).toBe("role:bob");
    });
});

describe("validateBatch with accountLanes: replays of one account never overlap", () => {
    const config = loadConfig({});
    const ctx: EngineContext = { config, llm: undefined as never, emit: () => undefined };
    const model = { pages: [], apis: [] } as unknown as AppModel;
    const tests = [
        { id: 1, steps: signIn() },
        { id: 2, steps: [] },
        { id: 3, steps: signIn() },
        { id: 4, steps: signIn("bob") },
        { id: 5, steps: signIn() },
        { id: 6, steps: [] },
    ].map((t) => ({ spec: spec(t.id, t.steps), framework: "playwright" as const }));
    const laneOf = (testId: string) => ({ "WEB-001": "main", "WEB-003": "main", "WEB-005": "main", "WEB-004": "role:bob" })[testId];

    /** A fake executor that records when each script of each call ran; WEB-001 fails its first run (so it is run again, inside the lane). */
    function recording() {
        const spans: Span[] = [];
        const runs = new Map<string, number>();
        const executor: ScriptExecutor = {
            name: "fake",
            async execute(_adapter, batch, _env, opts) {
                // A call runs its scripts `workers` at a time, as Playwright does.
                const out: ScriptRun[] = [];
                const queue = [...batch.scripts];
                await Promise.all(
                    Array.from({ length: Math.min(opts.workers, queue.length) }, async () => {
                        for (let s = queue.shift(); s; s = queue.shift()) {
                            const span: Span = { id: s.testId, lane: laneOf(s.testId), start: performance.now(), end: Infinity };
                            spans.push(span);
                            await sleep(30);
                            span.end = performance.now();
                            const n = (runs.get(s.testId) ?? 0) + 1;
                            runs.set(s.testId, n);
                            const failed = s.testId === "WEB-001" && n === 1;
                            out.push({ testId: s.testId, status: failed ? "failed" : "passed", durationMs: 30, failedStepIndex: failed ? 0 : -1, steps: [], artifacts: [], responses: [], ...(failed ? { error: "flaky" } : {}) });
                        }
                    }),
                );
                return batch.scripts.map((s) => out.find((r) => r.testId === s.testId)!);
            },
        };
        return { spans, runs, executor };
    }

    it("same-account replays (first runs and re-runs) never overlap; other accounts and signed-out tests do; at most `workers` at once", async () => {
        const { spans, runs, executor } = recording();
        const outcomes = await validateBatch(
            ctx,
            { scratchDir: config.scratchDir, env: { baseUrl: "http://127.0.0.1:1", headless: true }, render: { baseUrl: "http://127.0.0.1:1" }, model, maxRepairAttempts: 0, workers: 3, retryFailures: 1, executor, accountLanes: true },
            tests.map((t) => ({ ...t })),
            { async onAttempt() {}, async onFinal() {} },
        );
        expect(outcomes.map((o) => o.spec.testId)).toEqual(tests.map((t) => t.spec.testId));
        expect(runs.get("WEB-001")).toBe(2);
        expect(peak(spans)).toBeLessThanOrEqual(3);
        const main = spans.filter((s) => s.lane === "main");
        expect(main).toHaveLength(4);
        for (const a of main) for (const b of main) if (a !== b) expect(overlaps(a, b), `${a.id} and ${b.id} replayed at the same time`).toBe(false);
        // Order within the lane: WEB-001's first run comes before WEB-003's and WEB-005's.
        expect(main[0]!.id).toBe("WEB-001");
        expect(main.findIndex((s) => s.id === "WEB-003")).toBeLessThan(main.findIndex((s) => s.id === "WEB-005"));
        const free = spans.filter((s) => s.lane === undefined);
        expect(free.some((f) => main.some((m) => overlaps(f, m)))).toBe(true);
        expect(spans.filter((s) => s.lane === "role:bob").some((r) => main.some((m) => overlaps(r, m)))).toBe(true);
    });

    it("without accountLanes the batch runs as before: one call, every test at once up to the workers", async () => {
        const { spans, executor } = recording();
        await validateBatch(
            ctx,
            { scratchDir: config.scratchDir, env: { baseUrl: "http://127.0.0.1:1", headless: true }, render: { baseUrl: "http://127.0.0.1:1" }, model, maxRepairAttempts: 0, workers: 3, executor },
            tests.map((t) => ({ ...t })),
            { async onAttempt() {}, async onFinal() {} },
        );
        const main = spans.filter((s) => s.lane === "main");
        expect(main.some((a) => main.some((b) => a !== b && overlaps(a, b)))).toBe(true);
    });
});
