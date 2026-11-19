/**
 * The independence check (testing-engine Phase 3, P3-10): after a defect test is authored, its steps are replayed twice, each in a
 * fresh browser context, the way `pruneByReplay` (web/author.ts) replays them. The finding is `independent` only when both replays reach
 * the CAPTURED check (the defect test's failing check of a stated source: the last check citing `capturedSource`, else its last sourced
 * check) and both fail there, at that check itself (a replay whose time ran out before it started never ran it) (CP3b R-3), the same way it
 * failed when it was captured (CP3c T-2): an assertion that saw a value (the same one, or another wrong one) when it was captured is
 * reproduced only by an assertion that saw a value, not by a check that ran out of time or found no element (a fresh browser without
 * the state authoring left); a capture of that kind is reproduced by the same kind. The captured check gets its full step time: when the
 * replay's time leaves it less, it is not run. It is `state_dependent` when they stop at
 * different steps, at a step before the captured check (an earlier check of the planner's own guess, or a step that is not a check: state
 * left by authoring or by the first replay, as D1's WEB-034), or do not fail at all; a replay that stops before the captured check says
 * so in its summary. It is `not_run` when the test has no sourced check or a replay could not start. No AI calls.
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
    /** The captured check's source (`capturedCheck.source`): the replays must fail at the last check citing it. Absent: the last sourced check. */
    capturedSource?: string;
    /**
     * How the captured check failed while authoring (`capturedCheck.observed`: Playwright's message, or the value seen). The replays must
     * fail there the same kind of way. Absent: as an assertion that saw a value.
     */
    capturedObserved?: string;
    testData?: Record<string, string>;
    credentials?: { username: string; password: string; totpSecret?: string };
}

const STEP_TIMEOUT_MS = 5_000;
const SETTLE_MS = 1_000;
const MESSAGE_MAX = 300;
/** A picture of the stopped page gets at most this long. */
const SHOT_MS = 10_000;

const isSourcedCheck = (s: Step | undefined): boolean => s?.action === "assert" && Boolean(s.source);

/** The 1-based step of the captured check: the last check citing `capturedSource` (when given), else the last sourced check; undefined when none. */
function capturedStep(test: DefectTest): number | undefined {
    for (let i = test.steps.length - 1; i >= 0; i--) {
        const s = test.steps[i];
        if (isSourcedCheck(s) && (test.capturedSource === undefined || (s as { source?: string }).source === test.capturedSource)) return i + 1;
    }
    return undefined;
}

/**
 * The kind of a check's failure (CP3c T-2): an assertion that saw a value (Playwright's "Received" line; `value` is what it saw), no
 * element found, or out of time / any other error. A captured observation that is not a Playwright message is the value seen.
 */
type FailureKind = { kind: "value"; value: string } | { kind: "missing" } | { kind: "timeout" } | { kind: "other" };
export function failureKind(message: string, opts: { plainIsValue?: boolean } = {}): FailureKind {
    if (/element\(s\) not found/i.test(message)) return { kind: "missing" };
    // On its own line in Playwright's message; the kept observation has its lines joined (author.ts redactText).
    const received = /\bReceived(?: [a-z]+)?:\s*("(?:[^"\\]|\\.)*"|\S+)/.exec(message);
    if (received) return { kind: "value", value: received[1]! };
    if (/did not finish within|time ran out|Timeout \d+ms exceeded/i.test(message)) return { kind: "timeout" };
    if (opts.plainIsValue && !/^(expect\(|Error\b|[\w.]+: )/.test(message.trim())) return { kind: "value", value: message.trim() };
    return { kind: "other" };
}

class OutOfTime extends Error {}
/** The replay's time ran out before a step started: that step was never run. */
class NotReached extends OutOfTime {}
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

async function replay(
    browser: Browser,
    baseUrl: string,
    test: DefectTest,
    label: string,
    stepTimeoutMs: number,
    shoot?: IndependenceOptions["shoot"],
    captured?: number,
): Promise<IndependenceReplay & { screenshot?: string; notReached?: boolean; failure?: FailureKind }> {
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
                if (left() <= 0) throw new NotReached("the replay's time ran out before this step");
                // The captured check gets its full step time, or is not run (a check cut short fails for want of time, not the defect).
                if (i + 1 === captured && left() < stepTimeoutMs) throw new NotReached("the replay's time ran out before this check could get its full step time");
                // Playwright's own time-out a little before ours, so a check that fails says what it saw.
                const ms = Math.min(stepTimeoutMs, left());
                await within(executeStep(session.page, step, data, baseUrl, i + 1 === captured ? Math.max(ms - 250, ms / 2) : ms, { near: nearbyTargets(test.steps, i) }), ms);
                if (left() > 0) await within(settle(session.page, Math.min(SETTLE_MS, left())), left()).catch(() => undefined);
            } catch (e) {
                const what = isSourcedCheck(step) ? `the check of ${step.action === "assert" ? step.source : ""}` : step.action === "assert" ? "a check with no stated source" : "a step that is not a check";
                const screenshot = shoot ? await within(shoot(session.page), SHOT_MS).catch(() => undefined) : undefined;
                const failure = e instanceof OutOfTime ? { kind: "timeout" as const } : failureKind(e instanceof Error ? e.message.split(/\n\s*Call log:/)[0]! : String(e));
                return { label, outcome: "failed", failedStep: i + 1, summary: `${label}: stopped at step ${i + 1} (${describeStep(step)}), ${what}: ${cleanMessage(e, secrets)}`, ...(screenshot ? { screenshot } : {}), ...(e instanceof NotReached ? { notReached: true } : {}), failure };
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
    const captured = capturedStep(test);
    if (captured === undefined) return { independence: "not_run", replays: [] };
    const stepTimeoutMs = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    const shot = [await replay(browser, baseUrl, test, "Replay 1 in a fresh browser", stepTimeoutMs, opts.shoot, captured)];
    shot.push(await replay(browser, baseUrl, test, "Replay 2 in a fresh browser", stepTimeoutMs, opts.shoot, captured));
    // How the captured check failed when it was captured; without its text, as an assertion that saw a value.
    const want = test.capturedObserved !== undefined ? failureKind(test.capturedObserved, { plainIsValue: true }) : undefined;
    // The same way (CP3c T-2): an assertion that saw a value is reproduced by one that saw a value; any other kind by the same kind.
    const sameWay = (f: FailureKind | undefined) => f !== undefined && (want ? f.kind === want.kind && f.kind !== "other" : f.kind === "value");
    // A replay reproduces the defect only when it fails at the captured check itself, the same way; one that stops earlier, or whose time
    // ran out before the check, never ran it (CP3b R-3).
    const reproduced = (r: (typeof shot)[number]) => r.outcome === "failed" && r.failedStep === captured && !r.notReached && sameWay(r.failure);
    // The finding's replay entries carry no picture: the references are listed apart.
    const replays: IndependenceReplay[] = shot.map(({ screenshot: _s, notReached, failure, ...r }) => {
        const said = r.summary.replace(/\.+$/, "");
        if (r.outcome !== "failed" || r.failedStep === undefined) return r;
        if (r.failedStep < captured) return { ...r, summary: `${said}. It did not reach the captured check (step ${captured}), so it does not reproduce the defect.` };
        if (r.failedStep !== captured) return r;
        if (notReached) return { ...r, summary: `${said}. The captured check was not run, so it does not reproduce the defect.` };
        if (!sameWay(failure)) return { ...r, summary: `${said}. It failed at the captured check, but not the way it failed when captured, so it does not reproduce the defect.` };
        if (failure?.kind === "value" && want?.kind === "value") return { ...r, summary: `${said}. It saw ${failure.value === want.value ? "the same value as when captured" : "another value than when captured"}.` };
        return r;
    });
    const screenshots = opts.shoot ? { screenshots: shot.flatMap((r) => (r.screenshot ? [r.screenshot] : [])) } : {};
    if (replays.some((r) => r.outcome === "error")) return { independence: "not_run", replays, ...screenshots };
    return { independence: shot.every(reproduced) ? "independent" : "state_dependent", replays, ...screenshots };
}
