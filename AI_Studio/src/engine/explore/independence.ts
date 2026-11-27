/**
 * The independence check (testing-engine Phase 3, P3-10): after a defect test is authored, its steps are replayed twice, each in a
 * fresh browser context, the way `pruneByReplay` (web/author.ts) replays them. The finding is `independent` only when both replays reach
 * the CAPTURED check (the defect test's failing check of a stated source: the last check citing `capturedSource`, else its last sourced
 * check) and both fail there, at that check itself (a replay whose time ran out before it started never ran it) (CP3b R-3), the same way it
 * failed when it was captured (CP3c T-2): an assertion that saw a value when it was captured is reproduced only by an assertion that
 * saw the SAME value (CP3d U-1: compared with spacing folded; a count by its number), not by another wrong value ($0.00 for a captured
 * $30.00, or a count of 0: a fresh browser without the state authoring left), a check that ran out of time or one that found no
 * element; a capture of another kind is reproduced by the same kind. Without the captured text, both replays must see one value. The
 * replay's message is masked and capped the way authoring kept the captured one, so the two compare alike. The captured check gets its full step time: when the
 * replay's time leaves it less, it is not run. It is `state_dependent` when they stop at
 * different steps, at a step before the captured check (an earlier check of the planner's own guess, or a step that is not a check: state
 * left by authoring or by the first replay, as D1's WEB-034), or do not fail at all; a replay that stops before the captured check says
 * so in its summary. It is `not_run` when the test has no sourced check or a replay could not start. No AI calls.
 *
 * Bounded: each step gets at most `stepTimeoutMs` (default 10 s, the runner's action time) and each replay at most `steps x stepTimeoutMs`, so both together take
 * at most 2 x steps x 10 s (plus opening and closing the two browser contexts, and at most SHOT_MS per picture).
 *
 * Account state (row 229): a replay of a test that signs in uses the account `prepare` gives (clean-account.ts: a newly registered one
 * when the project allows it), so what earlier tests left on the shared test account does not decide the verdict. Without a clean
 * account, two replays that reproduce it give `not_on_clean_state` (medium), never `independent`. A test that never signs in is clean.
 *
 * `shoot` (queue row 173): where a replay stops, the page is handed to it before the browser context closes; it takes and stores a
 * picture and returns a reference to it, which the check lists in `screenshots` (a picture that fails is simply left out).
 */
import type { Browser, Page } from "playwright";
import { BrowserSession, settle } from "../discovery/browser.js";
import { maskObservedText, observedTextSecrets } from "../evidence/observed-text.js";
import { redactText } from "../../shared/redact-text.js";
import { describeStep, type Step } from "../spec/schema.js";
import { executeStep, runtimeData } from "../web/interpreter.js";
import { nearbyTargets } from "../web/label-fallback.js";
import { RUN_VALUE } from "../web/leftovers.js";
import { usesTestAccount, type ReplayAccount } from "./clean-account.js";
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
    /** Every replay ran on clean account state (clean-account.ts): a newly registered account, or a test that never signs in. */
    clean?: boolean;
    /**
     * Each replay as an attempt: where it stopped and the pages it loaded, for the judge of a check the test itself is at fault for
     * (findings/expectation.ts ownCheckFault: a page the test opened that answered 404). Not part of the finding's evidence.
     */
    attempts?: Array<{ outcome: IndependenceReplay["outcome"]; failedStep?: number; requests: PageLoad[] }>;
}

/** A page a replay loaded: its address path, method, HTTP status and whether it is the application's own origin. */
export interface PageLoad {
    method: string;
    path: string;
    status: number | null;
    own: boolean;
}

export interface IndependenceOptions {
    stepTimeoutMs?: number;
    /** Takes and stores a picture of the page a replay stopped at; returns its reference, or undefined when none was kept. */
    shoot?: (page: Page) => Promise<string | undefined>;
    /**
     * Called before each replay (row 229): who the replay signs in as and whether that is clean account state (clean-account.ts
     * replayAccountPreparer). Absent: the test's own credentials, clean only when the test never signs in.
     */
    prepare?: () => Promise<ReplayAccount>;
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

// The platform runner's actionTimeout (validation/runner.ts): a replay as patient as the run that later validates the test (row 236).
const STEP_TIMEOUT_MS = 10_000;
const SETTLE_MS = 1_000;
const MESSAGE_MAX = 300;
/** A picture of the stopped page gets at most this long. */
const SHOT_MS = 10_000;

/** A page check, or an answer check (a relation a UI–API read-back ends on, Phase 4 C4), that names its stated source. */
const isSourcedCheck = (s: Step | undefined): boolean => (s?.action === "assert" || s?.action === "assertResponse") && Boolean(s.source);

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
    // An ARIA snapshot check (web/interpreter.ts): the value is the whole received snapshot, spacing folded (CP3d U-6).
    const snapshot = /^\s*The structure of the region does not match its snapshot\.[\s\S]*?\bReceived:\s*([\s\S]*)$/.exec(message);
    if (snapshot) return { kind: "value", value: snapshot[1]!.replace(/\s+/g, " ").trim() };
    // A relation check (validation/relation.ts) that failed: the same relation failing is the same value, whatever this run's own values
    // were (a new id each replay); one that could not be judged ("$x is not a number") keeps its reason in the value.
    const relation = /^\s*(Relation check failed\b[\s\S]*?)\. Values: /.exec(message);
    if (relation) return { kind: "value", value: relation[1]!.replace(/\s+/g, " ").trim() };
    // On its own line in Playwright's message; the kept observation has its lines joined (author.ts redactText).
    const received = /\bReceived(?: [a-z]+)?:\s*("(?:[^"\\]|\\.)*"|\S+)/.exec(message);
    if (received) return { kind: "value", value: received[1]! };
    if (/did not finish within|time ran out|Timeout \d+ms exceeded/i.test(message)) return { kind: "timeout" };
    if (opts.plainIsValue && !/^(expect\(|Error\b|[\w.]+: )/.test(message.trim())) return { kind: "value", value: message.trim() };
    return { kind: "other" };
}

/** A seen value as compared (CP3d U-1): a quoted one unquoted, spacing folded, and a {{unique}} value of the run as {{unique}} (V10 R10: each replay types a new one). */
function normalValue(v: string): string {
    let s = v.trim();
    if (/^"(?:[^"\\]|\\.)*"$/.test(s)) {
        try {
            s = String(JSON.parse(s));
        } catch {
            s = s.slice(1, -1);
        }
    }
    return s.replace(RUN_VALUE, "{{unique}}").replace(/\s+/g, " ").trim();
}
/**
 * Whether a replay's failure of the captured check is the captured failure itself, judged as the independence check judges it: the same
 * kind (never "other"), and for an assertion that saw a value, the same value. Without the captured text, never. An element that is not
 * there never counts: it is missing the same way whether or not the dropped steps ran (paid rbac-2 WEB-054 lost its Save this way).
 */
export function failsAsCaptured(capturedObserved: string | undefined, replayed: string | undefined): boolean {
    if (capturedObserved === undefined || replayed === undefined) return false;
    const want = failureKind(capturedObserved, { plainIsValue: true });
    const got = failureKind(asKept(replayed, []));
    if (got.kind !== want.kind || got.kind === "other" || got.kind === "missing") return false;
    return got.kind !== "value" || normalValue(got.value) === normalValue((want as { value: string }).value);
}

/** A value as a replay summary shows it. */
const shown = (v: string): string => {
    const n = normalValue(v);
    return n.length > 80 ? `${n.slice(0, 79)}…` : n;
};
/** A replay's failure message as authoring kept the captured one (web/author.ts: masked, joined to one line, capped at 400). */
const asKept = (message: string, forms: readonly string[]): string => redactText(maskObservedText(message, forms, 400), 400);

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

const SHARED_NOTE = "on the shared test account, so not checked on clean state";

/** Who the next replay signs in as (`prepare`), or the test's own account: clean only when the test never signs in. */
async function accountFor(test: DefectTest, prepare: IndependenceOptions["prepare"]): Promise<ReplayAccount> {
    const fallback: ReplayAccount = usesTestAccount(test.steps) ? { clean: false, note: SHARED_NOTE } : { clean: true, note: "" };
    if (!prepare) return fallback;
    return prepare().catch((): ReplayAccount => fallback);
}

async function replay(
    browser: Browser,
    baseUrl: string,
    test: DefectTest,
    label: string,
    stepTimeoutMs: number,
    shoot?: IndependenceOptions["shoot"],
    captured?: number,
    account: ReplayAccount = { clean: true, note: "" },
    /** Also a picture of the last page when every step passed. */
    shootAtEnd = false,
): Promise<IndependenceReplay & { screenshot?: string; notReached?: boolean; failure?: FailureKind; clean: boolean; pages?: PageLoad[] }> {
    // A replay as a newly registered account signs in with that account's credentials (clean-account.ts); its summary says who it was.
    const credentials = account.credentials ?? test.credentials;
    const secrets = [credentials?.password ?? "", credentials?.totpSecret ?? "", test.credentials?.password ?? ""].filter(Boolean);
    const who = account.note && usesTestAccount(test.steps) ? `${label} ${account.note}` : label;
    const clean = account.clean;
    let session: BrowserSession;
    try {
        session = await BrowserSession.launch(browser, { startUrl: baseUrl, ...(secrets.length ? { secrets } : {}) });
    } catch (e) {
        return { label, outcome: "error", summary: `${who}: the fresh browser could not start (${cleanMessage(e, secrets)}).`, clean };
    }
    session.page.setDefaultTimeout(stepTimeoutMs);
    const pages: PageLoad[] = [];
    const own = new URL(baseUrl).origin;
    session.page.on("response", (r) => {
        if (r.request().resourceType() !== "document") return;
        const u = new URL(r.url());
        pages.push({ method: r.request().method(), path: u.pathname + u.search, status: r.status(), own: u.origin === own });
    });
    const data = runtimeData(test.testData ?? {}, credentials);
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
                const what = isSourcedCheck(step) ? `the check of ${(step as { source?: string }).source ?? ""}` : step.action === "assert" ? "a check with no stated source" : "a step that is not a check";
                const screenshot = shoot ? await within(shoot(session.page), SHOT_MS).catch(() => undefined) : undefined;
                const raw = e instanceof Error ? e.message.split(/\n\s*Call log:/)[0]! : String(e);
                let failure: FailureKind = e instanceof OutOfTime ? { kind: "timeout" } : failureKind(raw);
                // The value as authoring would have kept it (CP3d U-1), so it compares with the captured one.
                if (failure.kind === "value") {
                    const kept = failureKind(asKept(raw, observedTextSecrets(secrets)));
                    if (kept.kind === "value") failure = kept;
                }
                return { label, outcome: "failed", failedStep: i + 1, summary: `${who}: stopped at step ${i + 1} (${describeStep(step)}), ${what}: ${cleanMessage(e, secrets)}`, ...(screenshot ? { screenshot } : {}), ...(e instanceof NotReached ? { notReached: true } : {}), failure, clean, pages };
            }
        }
        const screenshot = shoot && shootAtEnd ? await within(shoot(session.page), SHOT_MS).catch(() => undefined) : undefined;
        return { label, outcome: "passed", summary: `${who}: all ${test.steps.length} steps passed; the defect did not show.`, ...(screenshot ? { screenshot } : {}), clean };
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
export async function replayOwnSteps(
    browser: Browser,
    baseUrl: string,
    test: DefectTest,
    opts: { stepTimeoutMs?: number; prepare?: IndependenceOptions["prepare"]; /** A picture of the page where the replay stopped, or of its last page when every step passed (the finding's evidence). */ shoot?: IndependenceOptions["shoot"] } = {},
): Promise<IndependenceReplay & { clean: boolean; screenshot?: string }> {
    const account = await accountFor(test, opts.prepare);
    const { notReached: _n, failure: _f, pages: _p, ...r } = await replay(browser, baseUrl, test, "Replay of the saved test in a fresh browser", opts.stepTimeoutMs ?? STEP_TIMEOUT_MS, opts.shoot, undefined, account, true);
    return r;
}

/** Replays a defect test twice, each in a fresh browser context, and says whether its failure stands on its own. */
export async function checkIndependence(browser: Browser, baseUrl: string, test: DefectTest, opts: IndependenceOptions = {}): Promise<IndependenceCheck> {
    const captured = capturedStep(test);
    if (captured === undefined) return { independence: "not_run", replays: [] };
    const stepTimeoutMs = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    // Each replay its own account (row 229): a newly registered one when `prepare` gives one.
    const shot = [await replay(browser, baseUrl, test, "Replay 1 in a fresh browser", stepTimeoutMs, opts.shoot, captured, await accountFor(test, opts.prepare))];
    shot.push(await replay(browser, baseUrl, test, "Replay 2 in a fresh browser", stepTimeoutMs, opts.shoot, captured, await accountFor(test, opts.prepare)));
    const clean = shot.every((r) => r.clean);
    // How the captured check failed when it was captured; without its text, as an assertion that saw a value.
    const want = test.capturedObserved !== undefined ? failureKind(test.capturedObserved, { plainIsValue: true }) : undefined;
    // Without the captured text, the value both replays saw (they must agree on it).
    const values = shot.map((r) => (r.failure?.kind === "value" ? normalValue(r.failure.value) : undefined));
    // The same way (CP3c T-2): an assertion that saw a value is reproduced only by one that saw the same value (CP3d U-1); any other
    // kind by the same kind.
    const sameValue = (f: FailureKind & { kind: "value" }) => (want?.kind === "value" ? normalValue(f.value) === normalValue(want.value) : values.every((v) => v === normalValue(f.value)));
    const sameWay = (f: FailureKind | undefined) => f !== undefined && (want ? f.kind === want.kind && f.kind !== "other" : f.kind === "value") && (f.kind !== "value" || sameValue(f));
    // A replay reproduces the defect only when it fails at the captured check itself, the same way; one that stops earlier, or whose time
    // ran out before the check, never ran it (CP3b R-3).
    const reproduced = (r: (typeof shot)[number]) => r.outcome === "failed" && r.failedStep === captured && !r.notReached && sameWay(r.failure);
    // The finding's replay entries carry no picture: the references are listed apart.
    const attempts = shot.map((r) => ({ outcome: r.outcome, ...(r.failedStep !== undefined ? { failedStep: r.failedStep } : {}), requests: r.pages ?? [] }));
    const replays: IndependenceReplay[] = shot.map(({ screenshot: _s, notReached, failure, clean: _c, pages: _p, ...r }) => {
        const said = r.summary.replace(/\.+$/, "");
        if (r.outcome !== "failed" || r.failedStep === undefined) return r;
        if (r.failedStep < captured) return { ...r, summary: `${said}. It did not reach the captured check (step ${captured}), so it does not reproduce the defect.` };
        if (r.failedStep !== captured) return r;
        if (notReached) return { ...r, summary: `${said}. The captured check was not run, so it does not reproduce the defect.` };
        if (failure?.kind === "value" && want?.kind === "value") {
            if (!sameWay(failure)) return { ...r, summary: `${said}. It failed at the captured check, but saw another value: captured ${shown(want.value)}, replay saw ${shown(failure.value)}, so it does not reproduce the defect.` };
            return { ...r, summary: `${said}. It saw the same value as when captured (${shown(failure.value)}).` };
        }
        if (failure?.kind === "value" && !sameWay(failure)) return { ...r, summary: `${said}. The two replays saw different values (${values.map((v) => (v === undefined ? "none" : shown(v))).join(" and ")}), so it does not reproduce the defect.` };
        if (!sameWay(failure)) return { ...r, summary: `${said}. It failed at the captured check, but not the way it failed when captured, so it does not reproduce the defect.` };
        return r;
    });
    const screenshots = opts.shoot ? { screenshots: shot.flatMap((r) => (r.screenshot ? [r.screenshot] : [])) } : {};
    if (replays.some((r) => r.outcome === "error")) return { independence: "not_run", replays, ...screenshots, clean, attempts };
    // Reproduced on the shared account only: not checked on clean state, so never `independent` (row 227: leftovers reproduce too).
    const result: IndependenceResult = shot.every(reproduced) ? (clean ? "independent" : "not_on_clean_state") : "state_dependent";
    return { independence: result, replays, ...screenshots, clean, attempts };
}
