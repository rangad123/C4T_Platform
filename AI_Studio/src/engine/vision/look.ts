/**
 * The `lookAtScreen` tool of the authoring agent (opt-in: job option `visionChecks`).
 *
 * Ported idea from autospec (MIT, Copyright (c) 2024 Zach Blume): after an interaction, ask a vision model whether the UI
 * behaved sensibly. Here the answer is the structured verdict from verdict.ts, the number of looks per scenario is capped, every
 * picture is shrunk before it is sent, and a screen that looks wrong is recorded as an observation on the scenario (an event and
 * `AuthorOutcome.observations`), never silently dropped. When the model cannot look (no model, no image support) the tool says so
 * once and stops being useful; authoring itself carries on from the text snapshots as before.
 */
import { tool } from "ai";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import type { EngineContext } from "../context.js";
import { judgeImage } from "./judge.js";
import { clipProblem, VISION_MAX_LOOKS_PER_SCENARIO, weigh } from "./verdict.js";

export const VISION_AUTHORING_NOTE = `
You also have a lookAtScreen tool: a vision model looks at a screenshot and says whether the screen looks right (overlapping or cut-off elements, broken images, unreadable text, stray error banners). Use it sparingly — after a key step such as a page change, a dialog opening or a result appearing, at most ${VISION_MAX_LOOKS_PER_SCENARIO} times. It is a judgement, not a measurement: never use it instead of assertions, and do not change your plan because of a low-confidence answer. A screen it reports as wrong is recorded as an observation for the people reading the results.`;

export function makeLookAtScreen(args: {
    ctx: EngineContext;
    browser: Browser;
    page: Page;
    scenarioId: string;
    /** Receives one line per screen the model judged to look wrong (high or medium confidence). */
    observations: string[];
    onAction?: (a: { tool: string; args: unknown; ok: boolean; observation: string }) => void;
}) {
    const { ctx, browser, page, scenarioId, observations } = args;
    let looks = 0;
    let unavailable: string | undefined;
    return tool({
        description: `Ask a vision model whether the screen currently looks right. At most ${VISION_MAX_LOOKS_PER_SCENARIO} per scenario. Returns { looksRight, confidence, problems }.`,
        inputSchema: z.object({ question: z.string().max(300).optional().describe('What to look for, e.g. "the cart total is visible and not overlapped"') }),
        execute: async ({ question }) => {
            const log = (ok: boolean, observation: string) => args.onAction?.({ tool: "lookAtScreen", args: { question }, ok, observation });
            if (unavailable) return { available: false, note: `The screen cannot be judged: ${unavailable}. Continue without it.` };
            if (looks >= VISION_MAX_LOOKS_PER_SCENARIO) {
                log(false, "look limit reached");
                return { available: false, note: `You have used all ${VISION_MAX_LOOKS_PER_SCENARIO} looks for this scenario. Continue with the page snapshot.` };
            }
            looks++;
            let image: Buffer;
            try {
                image = await page.screenshot({ type: "jpeg", quality: 70, animations: "disabled", timeout: 5_000 });
            } catch (err) {
                log(false, "screenshot failed");
                return { available: false, note: `The screen could not be captured (${err instanceof Error ? err.message.split("\n")[0] : "unknown problem"}).` };
            }
            const res = await judgeImage(ctx, browser, { image, expected: question, context: `while authoring ${scenarioId}` });
            if (res.state === "unavailable") {
                unavailable = res.reason;
                log(false, `unavailable: ${res.reason}`);
                ctx.emit({ stage: "generation", kind: "vision_unavailable", level: "warn", message: `${scenarioId}: the AI could not look at the screen: ${res.reason}. Authoring continues from text snapshots.` });
                return { available: false, note: `The screen cannot be judged: ${res.reason}. Continue without it.` };
            }
            const v = res.verdict;
            const w = weigh(v);
            log(true, `ok=${v.ok} confidence=${v.confidence}`);
            if (w.kind === "finding") {
                const where = (() => {
                    try {
                        return new URL(page.url()).pathname || "/";
                    } catch {
                        return page.url();
                    }
                })();
                const line = `${where}: ${(v.problems.length ? v.problems : ["the model says something looks wrong"]).slice(0, 3).map((p) => clipProblem(p, 160)).join("; ")} (${v.confidence} confidence)`;
                observations.push(line);
                ctx.emit({ stage: "generation", kind: "vision_observation", level: "warn", message: `${scenarioId}: the AI thinks a screen may not look right — ${line}` });
            }
            return { available: true, looksRight: v.ok, confidence: v.confidence, problems: v.problems.slice(0, 5).map((p) => clipProblem(p)) };
        },
    });
}
