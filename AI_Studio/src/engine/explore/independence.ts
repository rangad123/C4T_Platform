/**
 * The independence check (testing-engine Phase 3, P3-10): after a defect test is authored, its steps are replayed twice, each in a
 * fresh browser context, the way `pruneByReplay` (web/author.ts) replays them. The finding is `independent` when both replays stop at
 * the same failing sourced check, and `state_dependent` when they stop at different steps, stop at a step that is not a sourced check
 * (state left by authoring or by the first replay, as D1's WEB-034), or do not fail at all. It is `not_run` when the test has no sourced
 * check or a replay could not start. No AI calls.
 *
 * Bounded: each step gets at most `stepTimeoutMs` (default 5 s) and each replay at most `steps x stepTimeoutMs`, so both together take
 * at most 2 x steps x 5 s (plus opening and closing the two browser contexts, and at most SHOT_MS per picture).
 *
 * `shoot` (queue row 173): where a replay stops, the page is handed to it before the browser context closes; it takes and stores a
 * picture and returns a reference to it, which the check lists in `screenshots` (a picture that fails is simply left out).
 */
import type { Browser, Page } from "playwright";
import { BrowserSession, settle } from "../discovery/browser.js";
import { describeStep, type Step } from "../spec/schema.js";
import { executeStep, runtimeData } from "../web/interpreter.js";
import { nearbyTargets } from "../web/label-fallback.js";
import type { IndependenceResult } from "./finding.js";

/** One replay, in the shape of a candidate finding's `replays` entry (explore/finding.ts). */
export interface IndependenceReplay {
    label: string;
    outcome: "failed" | "passed" | "error";
    /** 1-based step the replay stopped at. */
    failedStep?: number;
    summary: string;
}

export interface IndependenceCheck {
    independence: IndependenceResult;
    /** The two replays (none when the check was not run for want of a sourced check), for the finding's evidence. */
    replays: IndependenceReplay[];
    /** What `shoot` returned for the page where each replay stopped, in replay order (absent without `shoot`). */
    screenshots?: string[];
}

export interface IndependenceOptions {
    stepTimeoutMs?: number;
    /** Takes and stores a picture of the page a replay stopped at; returns its reference, or undefined when none was kept. */
    shoot?: (page: Page) => Promise<string | undefined>;
}

export interface DefectTest {
    steps: readonly Step[];
    testData?: Record<string, string>;
    credentials?: { username: string; password: string; totpSecret?: string };
}

const STEP_TIMEOUT_MS = 5_000;
const SETTLE_MS = 1_000;
const MESSAGE_MAX = 300;
/** A picture of the stopped page gets at most this long. */
const SHOT_MS = 10_000;

const isSourcedCheck = (s: Step | undefined): boolean => s?.action === "assert" && Boolean(s.source);

class OutOfTime extends Error {}
/** Resolves with `work`, or rejects when `ms` pass first (the step keeps running until its session is closed). */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expire = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new OutOfTime(`did not finish within ${Math.round(ms / 100) / 10} s`)), Math.max(0, ms))));
    return Promise.race([work, expire]).finally(() => clearTimeout(timer));
}

function cleanMessage(e: unknown, secrets: string[]): string {
    let m = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.trim();
    for (const s of secrets) if (s) m = m.split(s).join("***");
    return m.length > MESSAGE_MAX ? `${m.slice(0, MESSAGE_MAX - 1)}…` : m;
}

async function replay(browser: Browser, baseUrl: string, test: DefectTest, label: string, stepTimeoutMs: number, shoot?: IndependenceOptions["shoot"]): Promise<IndependenceReplay & { screenshot?: string }> {
    const secrets = [test.credentials?.password ?? "", test.credentials?.totpSecret ?? ""].filter(Boolean);
    let session: BrowserSession;
    try {
        session = await BrowserSession.launch(browser, { startUrl: baseUrl, ...(secrets.length ? { secrets } : {}) });
    } catch (e) {
        return { label, outcome: "error", summary: `${label}: the fresh browser could not start (${cleanMessage(e, secrets)}).` };
    }
    session.page.setDefaultTimeout(stepTimeoutMs);
    const data = runtimeData(test.testData ?? {}, test.credentials);
    const deadline = Date.now() + test.steps.length * stepTimeoutMs;
    try {
        for (const [i, step] of test.steps.entries()) {
            const left = () => deadline - Date.now();
            try {
                if (left() <= 0) throw new OutOfTime("the replay's time ran out before this step");
                await within(executeStep(session.page, step, data, baseUrl, Math.min(stepTimeoutMs, left()), { near: nearbyTargets(test.steps, i) }), Math.min(stepTimeoutMs, left()));
                if (left() > 0) await within(settle(session.page, Math.min(SETTLE_MS, left())), left()).catch(() => undefined);
            } catch (e) {
                const what = isSourcedCheck(step) ? `the check of ${step.action === "assert" ? step.source : ""}` : step.action === "assert" ? "a check with no stated source" : "a step that is not a check";
                const screenshot = shoot ? await within(shoot(session.page), SHOT_MS).catch(() => undefined) : undefined;
                return { label, outcome: "failed", failedStep: i + 1, summary: `${label}: stopped at step ${i + 1} (${describeStep(step)}), ${what}: ${cleanMessage(e, secrets)}`, ...(screenshot ? { screenshot } : {}) };
            }
        }
        return { label, outcome: "passed", summary: `${label}: all ${test.steps.length} steps passed; the defect did not show.` };
    } finally {
        await session.close();
    }
}

/**
 * An observed-only defect test (no failing check of a stated source was kept, so every step it saved passed while authoring) replayed
 * once in a fresh browser context, the way the independence check replays. A replay that stops at a step means the saved test cannot
 * pass its own steps (a check bound to a value the authoring session saw, a step leaning on state the session left): it is a broken
 * test, not evidence of a defect (queue row 180, C1c's WEB-027/030/033/046). No AI calls.
 */
export function replayOwnSteps(browser: Browser, baseUrl: string, test: DefectTest, opts: { stepTimeoutMs?: number } = {}): Promise<IndependenceReplay> {
    return replay(browser, baseUrl, test, "Replay of the saved test in a fresh browser", opts.stepTimeoutMs ?? STEP_TIMEOUT_MS);
}

/** Replays a defect test twice, each in a fresh browser context, and says whether its failure stands on its own. */
export async function checkIndependence(browser: Browser, baseUrl: string, test: DefectTest, opts: IndependenceOptions = {}): Promise<IndependenceCheck> {
    if (!test.steps.some(isSourcedCheck)) return { independence: "not_run", replays: [] };
    const stepTimeoutMs = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    const shot = [await replay(browser, baseUrl, test, "Replay 1 in a fresh browser", stepTimeoutMs, opts.shoot)];
    shot.push(await replay(browser, baseUrl, test, "Replay 2 in a fresh browser", stepTimeoutMs, opts.shoot));
    // The finding's replay entries carry no picture: the references are listed apart.
    const replays: IndependenceReplay[] = shot.map(({ screenshot: _s, ...r }) => r);
    const [first, second] = replays as [IndependenceReplay, IndependenceReplay];
    const screenshots = opts.shoot ? { screenshots: shot.flatMap((r) => (r.screenshot ? [r.screenshot] : [])) } : {};
    if (replays.some((r) => r.outcome === "error")) return { independence: "not_run", replays, ...screenshots };
    const same = first.outcome === "failed" && second.outcome === "failed" && first.failedStep === second.failedStep;
    const atSourcedCheck = first.failedStep !== undefined && isSourcedCheck(test.steps[first.failedStep - 1]);
    return { independence: same && atSourcedCheck ? "independent" : "state_dependent", replays, ...screenshots };
}
