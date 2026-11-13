/**
 * Spec authoring agent: scenario → canonical web test spec, by actually performing the scenario
 * in a real browser.
 *
 * Built on autospec's executor (MIT, Copyright (c) 2024 Zach Blume, src/executor.ts): an LLM
 * tool-calling loop (`generateText` + `tool` + `stopWhen`) over semantic browser tools that return
 * the fresh accessibility snapshot after every action. Differences from autospec:
 *   - every successful action is recorded as a *canonical step* (structured locator), not as a
 *     tool-call trace later string-mapped to Playwright;
 *   - assertion tools exist and are mandatory, so specs verify the scenario's expected results
 *     (autospec's replay files contain no assertions);
 *   - the loop can resume from a replayed spec prefix with a failure description (repair).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { generateText, stepCountIs, tool } from "ai";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import type { EngineContext } from "../context.js";
import { activityOfStep, activityLine, pathOf } from "../frames/activity.js";
import type { FrameSink } from "../frames/sink.js";
import { LLM_MAX_RETRIES, PROVIDER_OPTIONS } from "../llm/provider.js";
import { addUsage } from "../llm/prompt-cache.js";
import { noteAgentStep, withRoute } from "../llm/routing.js";
import { ariaSnapshot, BrowserSession, settle, type SessionEvents } from "../discovery/browser.js";
import { placeholderCanMoveAddress, RUN_ADDRESS_RULE } from "../spec/run-address.js";
import { CLOCK_OPS, CONDITION_SETS, MAX_CLOCK_MINUTES } from "../spec/schema.js";
import { CONDITION_HELP } from "./conditions.js";
import { REMEMBER_COMPARE, REMEMBER_NAME, WAIT_UNTIL, type ASSERT_CHECKS } from "../spec/schema.js";
import { NEEDS_EXPECTED, NEEDS_LOCATOR } from "./checks.js";
import { captureAriaTemplate } from "./interpreter.js";
import { describeStep, LocatorSchema, type Locator, type Scenario, type Step, type TestSpec } from "../spec/schema.js";
import type { AppModel, PageModel } from "../understanding/app-model.js";
import { makeLookAtScreen, VISION_AUTHORING_NOTE } from "../vision/look.js";
import { COMPACT_SNAPSHOT_NOTE, RAW_SNAPSHOT_MAX, SnapshotView, snapshotSavingsEvent } from "../snapshots/compact.js";
import { compactSnapshotsOn } from "../snapshots/setting.js";
import { scrubTraceFile } from "../evidence/trace-scrub.js";
import { executeStep, locate, rememberPopup, runtimeData, type RuntimeData } from "./interpreter.js";
import { sampleName, sampleTypeFor, SAMPLE_TYPES } from "./interruptions.js";
import { notesFor, refusalText, refusedBy, type SiteNote } from "../memory/notes.js";
import { TEST_DATA_AUTHORING_NOTE, testValueTool, type TestData } from "../testdata/generate.js";

export interface AuthorInput {
    ctx: EngineContext;
    browser: Browser;
    baseUrl: string;
    model: AppModel;
    scenario: Scenario;
    credentials?: { username: string; password: string };
    /** Resume mode (repair): steps to replay first, and why the previous version failed. */
    resume?: { prefix: Step[]; failure: string; /** The note is a review's list of changes, not a failed run. */ review?: boolean };
    /** Called for each tool action, for observability (agent_actions). */
    onAction?: (a: { tool: string; args: unknown; ok: boolean; observation: string }) => void;
    maxSteps?: number;
    /** Opt-in (job option visionChecks): the agent gets a lookAtScreen tool backed by a vision model. */
    vision?: boolean;
    /** The Explorer view (the plain-English builder only): a picture is offered after each action, when someone watches. */
    frames?: FrameSink;
    /** After a complete test: an AI review against its scenario; its fixes are applied once by resuming authoring (the exploration's test writers). */
    review?: boolean;
    /** A blocked scenario is tried once more in a fresh browser context before it is reported as not authored. */
    retryBlocked?: boolean;
    /** The project's notes for the AI (memory/notes.ts): those for the current page go into the prompt, and a "never" note refuses its control. */
    notes?: SiteNote[];
    /** Generated test data for the run (data-changing tests on): the agent gets a testValue tool, and the spec records the run tag. */
    testData?: TestData;
}

/** `observations`: screens the vision model judged to look wrong while authoring (only when `vision` was on). */
export type AuthorOutcome =
    | { status: "complete"; steps: Step[]; testData: Record<string, string>; explanation: string; observations?: string[] }
    | { status: "defect"; steps: Step[]; testData: Record<string, string>; explanation: string; observations?: string[]; /** Errors the app reported while the agent worked (console, failed requests). */ evidence?: string[] }
    | { status: "blocked"; steps: Step[]; testData: Record<string, string>; explanation: string; observations?: string[]; /** The session's Playwright trace (passwords masked), kept as evidence of what blocked it. */ trace?: string };

const SYSTEM = `You are an automated QA engineer authoring ONE end-to-end test by performing it in a real browser.
Every action you perform successfully is recorded into a reusable Playwright test, so be deliberate:
- Perform the scenario step by step; after each action you receive the page's accessibility snapshot. Look before you act.
- Locate elements the way a user would: by="role" (role + accessible name) first, then "label", "placeholder", "text". Use "css" only as a last resort.
  Role names are ARIA roles (button, link, textbox, checkbox, combobox, heading, tab, menuitem...). Copy accessible names from the snapshot.
- If a locator matches several elements the action fails; make it more specific (exact=true, a different role/name), narrow it with
  within (a container: the dialog, the list, the table row) or filter (hasText / has: the row that holds "Blue mug"); nth only as a last resort.
  Images: by="altText"; an element named only by its title attribute: by="title".
- Use the strongest check that fits: exactText for a total or a status, notText for what must be gone, checked/unchecked, focused, attribute,
  accessibleErrorMessage for a field's validation message, ariaSnapshot for a result list or summary. To prove a value carries over
  (the product page price is the cart price), remember it first and assert check "remembered" later.
- Wait for things (wait until url / response / hidden / visible), never a fixed time.
- Use {{unique}} inside values that must be unique (emails/usernames you create), and {{credentials.username}} / {{credentials.password}}
  for the provided test account. Never invent real people's data; example.com addresses only.
- You MUST finish with assertions: use the assert tool to verify EVERY expected result of the scenario (visible text, URL, value, count...).
  A test without assertions is worthless. Assert on what the user would observe, after the final action, and wait via assertions (they auto-retry) rather than fixed sleeps.
  Assert the OUTCOME, not only that what you clicked is still visible: the confirmation text, the new URL, the changed value or count.
  When an outcome depends on an earlier step, assert that link (the value typed in a form shows in the list or summary afterwards).
- Never perform irreversible/destructive real-world actions (payment, deleting accounts, sending messages). Stop before them and assert on the UI.
- When every expected result is verified, call finish(result="complete").
- If an assertion fails because the application genuinely behaves differently from the expected result, call finish(result="defect") and explain what was observed.
- If you cannot make progress (element missing, blocked), call finish(result="blocked") and explain.
- Be efficient: do not explore unrelated pages. Do not repeat failed actions unchanged.
- Stay in the UI: do not navigate to API/JSON endpoints; verify what a user sees in the pages.
- Dialogs (confirm "Delete?") are dismissed unless you call dialog(response="accept") right before the action that opens one. A new tab a click opens is where your next actions go.
- Tool results tell you what happened (dialogs, new tabs, downloads, console errors, failed requests). A server error (HTTP 5xx) after an action is a defect to report, not a reason to test something else.`;

const target = LocatorSchema.describe("How to find the element");
/** The longest fixed pause the agent may record (a wait for something is the better step; the review flags fixed ones). */
const MAX_FIXED_WAIT_MS = 3_000;
/** The checks the agent may use; the deterministic families (health, speed, audits) come from their own generators. */
const AUTHOR_CHECKS = ["visible", "hidden", "text", "exactText", "notText", "value", "enabled", "disabled", "editable", "checked", "unchecked", "focused", "inViewport", "count", "url", "urlPattern", "title", "attribute", "class", "css", "accessibleName", "accessibleErrorMessage", "ariaSnapshot", "remembered"] as const satisfies readonly (typeof ASSERT_CHECKS)[number][];

/** Steps that can work in a new tab (the schema's `inPopup`). */
const POPUP_STEPS = new Set<Step["action"]>(["navigate", "click", "fill", "select", "check", "press", "hover", "upload", "drag", "dialog", "download", "assert"]);

/** What the session saw during one action, told to the agent in plain words (and the new tab to continue in, if one opened). */
async function interruptionNotes(e: SessionEvents, step: Step, ok: boolean): Promise<{ lines: string[]; popup?: Page }> {
    const lines: string[] = [];
    for (const d of e.dialogs) {
        lines.push(
            d.armed
                ? `A ${d.type} dialog appeared: "${d.message}" - it was ${d.answer}, as prepared.`
                : `A ${d.type} dialog appeared: "${d.message}" - it was dismissed. To accept it, call dialog(response="accept") right before the action that opens it, then do that action again.`,
        );
    }
    const popup = e.opened.find((p) => !p.isClosed());
    if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
        lines.push(`A new tab opened: ${popup.url()}. Your next actions work in it; switchTab(to="main") goes back to the first page.`);
    }
    if (step.action !== "download") for (const name of e.downloads) lines.push(`A download started: "${name}". To check a download, use the download tool on the control that starts it.`);
    if (e.problems.length) lines.push(`The application reported errors during this action:\n${e.problems.map((p) => `- ${p}`).join("\n")}`);
    if (e.serverError && ok)
        lines.push('The server answered with an error (HTTP 5xx). That is an application defect, not something to write a test around: assert what the user sees now if it shows the failure, then finish(result="defect") and name the failing request.');
    return { lines, ...(popup ? { popup } : {}) };
}

/** The `accept` attribute of the file field a target is, holds, or labels (empty when there is none or it cannot be read). */
async function acceptOf(page: Page, l: Locator): Promise<string> {
    return locate(page, l, {})
        .first()
        .evaluate((el) => {
            const field = el instanceof HTMLInputElement ? el : (el.querySelector("input[type=file]") ?? (el instanceof HTMLLabelElement ? el.control : null));
            return field instanceof HTMLInputElement ? field.accept : "";
        }, undefined, { timeout: 2_000 })
        .catch(() => "");
}

function pageHint(model: AppModel, scenario: Scenario): string {
    const start = scenario.startPath.split("?")[0];
    const related = model.pages.filter((p) => p.path.split("?")[0] === start).slice(0, 1);
    const journeyPages = model.journeys.find((j) => j.name === scenario.journey)?.pages ?? [];
    const more = model.pages.filter((p) => journeyPages.includes(p.path.split("?")[0]!) && !related.includes(p)).slice(0, 3);
    const fmt = (p: PageModel) =>
        `- ${p.path} [${p.type}] forms: ${p.forms.map((f) => `${f.purpose}(${f.fields.map((x) => x.label || x.placeholder || x.name).join(", ")})`).join("; ") || "none"}; controls: ${p.components
            .slice(0, 10)
            .map((c) => `${c.role}:"${c.name}"`)
            .join(", ")}`;
    const lines = [...related, ...more].map(fmt);
    return lines.length ? `Known pages (from discovery; verify against the live page):\n${lines.join("\n")}` : "";
}

/**
 * One scenario in its own route scope (llm/routing.ts): with a fast model set, its steps go to the fast model (a repair's re-authoring to
 * the main one), and the rest of the scenario moves to the main model when the fast one struggles. Without a fast model nothing changes.
 */
export function authorWebSpec(input: AuthorInput): Promise<AuthorOutcome> {
    return withRoute({ task: input.resume ? "repair" : "authoring", what: `Scenario ${input.scenario.scenarioId}` }, async () => {
        let out = await authorScenario(input);
        if (out.status === "blocked" && input.retryBlocked && !input.resume) {
            input.ctx.emit({ stage: "generation", kind: "scenario_retry", level: "warn", message: `${input.scenario.scenarioId} was blocked (${out.explanation}); trying once more in a fresh browser` });
            out = await authorScenario(input);
        }
        if (out.status === "complete" && input.review && !input.resume) out = await reviewAndFix(input, out);
        if (out.status === "defect") out = await confirmDefect(input, out);
        return out;
    });
}

const VERDICT_SYSTEM = `You judge ONE suspected bug found by an automated test writer in a web application. Answer only "yes" when the evidence shows the application itself misbehaves (wrong result, error, crash, server error), or "no" when it is more likely the test writer's mistake (wrong element, wrong expectation, a step not done, timing).`;
const VERDICT_TRIES = 3;
/** One verdict answer: yes, no, or undefined when it says neither. */
export const parseVerdict = (answer: string): boolean | undefined => (/^\W*yes\b/i.test(answer) ? true : /^\W*no\b/i.test(answer) ? false : undefined);

/**
 * Before a "defect" is stored: the review model is asked 3 times whether this is a real application bug (answers vary between tries),
 * and the majority is kept. A majority of "no" makes the outcome "blocked" (not reported as a bug); answers that say neither, or failed
 * calls, do not count, so without clear answers the defect stands.
 */
async function confirmDefect(input: AuthorInput, out: Extract<AuthorOutcome, { status: "defect" }>): Promise<AuthorOutcome> {
    const { ctx, scenario } = input;
    const prompt = `Scenario ${scenario.scenarioId}: ${scenario.title}\nDescription: ${scenario.description}\nExpected results:\n${scenario.expectedResults.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}\n\nWhat the test writer reports: ${out.explanation}\n\nSteps performed:\n${out.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join("\n")}\n\nErrors the application reported:\n${out.evidence?.map((e) => `- ${e}`).join("\n") || "none"}\n\nIs this a real application bug? Answer yes or no.`;
    let yes = 0;
    let no = 0;
    for (let i = 0; i < VERDICT_TRIES; i++) {
        const v = await ctx.llm.text({ system: VERDICT_SYSTEM, prompt, maxOutputTokens: 20, purpose: "review" }).then(parseVerdict, () => undefined);
        if (v === true) yes++;
        else if (v === false) no++;
    }
    if (no > yes) {
        ctx.emit({ stage: "generation", kind: "defect_unconfirmed", level: "warn", message: `${scenario.scenarioId}: not reported as a bug: ${no} of ${VERDICT_TRIES} reviews said it is not a real application bug` });
        return { status: "blocked", steps: out.steps, testData: out.testData, explanation: `Not reported as a bug (${no} of ${VERDICT_TRIES} reviews said it is not a real application bug): ${out.explanation}`, ...(out.observations ? { observations: out.observations } : {}) };
    }
    ctx.emit({ stage: "generation", kind: "defect_confirmed", message: `${scenario.scenarioId}: ${yes} of ${VERDICT_TRIES} reviews said this is a real application bug` });
    return out;
}

const OUTCOME_PUSHBACKS = 2;
const NO_OUTCOME = "Authoring finished without recording any assertion on the expected outcome";
const NO_OUTCOME_HINT =
    "Not finished: the test has no assertion on the scenario's expected outcome after the last action. Assert what the user should now observe (text, value, URL or count), not only that the element you used is visible, then call finish again.";
const INTERACTIONS = new Set<Step["action"]>(["navigate", "click", "fill", "select", "check", "press", "hover", "upload", "drag", "download"]);

/** An assertion after the last action that is more than "the element I just used is visible": it proves the scenario's outcome. */
export function hasOutcomeAssertion(steps: readonly Step[]): boolean {
    const key = (l: unknown) => JSON.stringify(l);
    const touched = new Set(steps.flatMap((s) => (INTERACTIONS.has(s.action) && "locator" in s && s.locator ? [key(s.locator)] : [])));
    const lastAction = steps.findLastIndex((s) => INTERACTIONS.has(s.action));
    // A download step checks its own outcome (the file arrived, named as expected, not empty).
    if (steps[lastAction]?.action === "download") return true;
    return steps.slice(lastAction + 1).some((s) => s.action === "assert" && !(s.check === "visible" && s.locator && touched.has(key(s.locator))));
}

const REVIEW_SYSTEM = `You review ONE automatically written end-to-end web test against the scenario it must prove.
Ask for a change only for: an expected result with no assertion that would fail if the outcome did not happen; an assertion that only checks that a clicked element is visible;
an outcome that depends on an earlier step but is not checked (the value typed in a form should show afterwards); a weak locator (css or nth where a role, label or text exists);
a step that does not match the scenario's intent; a fixed wait ("Wait Nms") where waiting for the address, a response or an element would do;
a pass with no observable evidence (nothing a person would see changes is checked). Never ask to remove or loosen an assertion.
Answer exactly OK when nothing must change. Otherwise answer one concrete change per line, each starting with "- ", and, when an existing step must change
(not only assertions added), a last line "First wrong step: <number>".`;

/** The reviewer's answer: no changes ("OK", or nothing usable), or the changes and the first step that must change. */
export function parseReview(answer: string): { fixes: string[]; firstWrongStep?: number } {
    const fixes = answer.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean).slice(0, 5);
    const step = Number(/first wrong step:\s*(\d+)/i.exec(answer)?.[1]);
    return { fixes, ...(fixes.length && step >= 1 ? { firstWrongStep: step } : {}) };
}

/** The review pass: one short AI review of a finished test; its fixes are applied once through the resume path. A failed review or fix keeps the test as it was. */
async function reviewAndFix(input: AuthorInput, out: AuthorOutcome): Promise<AuthorOutcome> {
    const { ctx, scenario } = input;
    let review: ReturnType<typeof parseReview>;
    try {
        review = parseReview(await ctx.llm.text({
            system: REVIEW_SYSTEM,
            prompt: `Scenario ${scenario.scenarioId}: ${scenario.title}\nDescription: ${scenario.description}\nExpected results:\n${scenario.expectedResults.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}\n\nTest steps:\n${out.steps.map((s, i) => `${i + 1}. ${describeStep(s)} ${JSON.stringify(s)}`).join("\n")}`,
            maxOutputTokens: 600,
            // The review always goes to the strongest model (llm/routing.ts STRONG_TASKS), never the fast one.
            purpose: "review",
        }));
    } catch (err) {
        ctx.emit({ stage: "generation", kind: "review_skipped", level: "warn", message: `${scenario.scenarioId}: the test was not reviewed: ${err instanceof Error ? err.message : String(err)}` });
        return out;
    }
    const { fixes } = review;
    if (!fixes.length) return out;
    ctx.emit({ stage: "generation", kind: "review_fixes", message: `${scenario.scenarioId}: review asked for ${fixes.length} change(s): ${fixes.join("; ")}` });
    const cut = review.firstWrongStep ? Math.min(out.steps.length, Math.max(1, review.firstWrongStep - 1)) : out.steps.length;
    const fixed = await authorScenario({ ...input, resume: { prefix: out.steps.slice(0, cut), failure: fixes.map((f) => `- ${f}`).join("\n"), review: true } });
    if (fixed.status === "complete" || fixed.status === "defect") return fixed;
    ctx.emit({ stage: "generation", kind: "review_fix_failed", level: "warn", message: `${scenario.scenarioId}: the review's changes could not be applied (${fixed.explanation}); the test is kept as it was` });
    return out;
}

async function authorScenario(input: AuthorInput): Promise<AuthorOutcome> {
    const { ctx, browser, baseUrl, model, scenario, credentials, resume } = input;
    const session = await BrowserSession.launch(browser, { startUrl: baseUrl, ...(input.notes?.length ? { notes: input.notes } : {}) });
    const { page } = session;
    page.setDefaultTimeout(6_000);
    /** The new tab the agent works in (a click opened it), else the page the test started on. */
    let tab: Page | undefined;
    const here = (): Page => (tab && !tab.isClosed() ? tab : page);
    /** What the app reported while the agent worked (console and page errors, failed requests): the evidence a bug verdict reads. */
    const evidence: string[] = [];

    const recorded: Step[] = [];
    const observations: string[] = [];
    const data: RuntimeData = runtimeData({}, credentials);
    const testData: Record<string, string> = {};
    let outcome: AuthorOutcome | undefined;
    let pushbacks = 0;
    // Smaller page snapshots (setting LLM_COMPACT_SNAPSHOTS, on by default): off = exactly the snapshots, tools and instructions of before.
    const view = compactSnapshotsOn(ctx.config) ? new SnapshotView() : undefined;
    /** The page as the model gets it: the whole snapshot cut at `max`, or (smaller snapshots on) the compact one or what changed. */
    const snapshotFor = async (max: number) => (view ? view.show(here().url(), await ariaSnapshot(here(), RAW_SNAPSHOT_MAX), max) : await ariaSnapshot(here(), max));
    // The session is traced; the trace is kept only when the scenario ends blocked (keepBlockedTrace).
    const traced = await session.context.tracing.start({ snapshots: true, screenshots: true }).then(() => true, () => false);
    let finished: AuthorOutcome | undefined;

    try {
        return (finished = await (async (): Promise<AuthorOutcome> => {
        const run = async (step: Step): Promise<{ ok: boolean; error?: string }> => {
            try {
                await executeStep(page, step, data, baseUrl);
                await settle(here(), 1_500);
                return { ok: true };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { ok: false, error: msg.split("\n").slice(0, 4).join(" ").slice(0, 400) };
            }
        };

        // Fixed first step: open the scenario's start page.
        const open: Step = { action: "navigate", url: scenario.startPath || "/", description: `Open ${scenario.startPath || "/"}` };
        let first = await run(open);
        // A flaky connection (timeouts, ERR_NETWORK_CHANGED, DNS) on the very first load should not cost the
        // whole scenario: retry the opening navigation a couple of times before giving up.
        for (let retry = 1; !first.ok && retry <= 2 && /timeout|net::|ERR_|ENOTFOUND|ECONN/i.test(first.error ?? ""); retry++) {
            await new Promise((r) => setTimeout(r, 2_000 * retry));
            first = await run(open);
        }
        if (!first.ok) {
            return { status: "blocked", steps: [], testData, explanation: `Could not open ${scenario.startPath}: ${first.error}` };
        }
        recorded.push(open);
        const seenPaths = new Set<string>([pathOf(page.url())]);
        const show = async (step: Step, secrets: readonly string[] = []) => {
            seenPaths.add(pathOf(page.url()));
            await input.frames?.capture(page, { note: activityLine(activityOfStep(step, page.url()), secrets), phase: "building", pagesSeen: seenPaths.size });
        };
        await show(open);

        // Repair mode: replay the already-working prefix (minus its own opening navigate).
        if (resume) {
            for (const step of resume.prefix.slice(1)) {
                const r = await run(step);
                if (!r.ok) {
                    return { status: "blocked", steps: recorded, testData, explanation: `Replay of previous steps failed at "${describeStep(step)}": ${r.error}` };
                }
                recorded.push(step);
            }
        }

        const refuse = refusedBy(input.notes);
        let notesShownFor = pathOf(page.url());
        const record = async (step: Step, toolName: string, args: unknown) => {
            // A "never ..." note for this page is a hard rule: the control it names is not used.
            const loc = "locator" in step ? (step.locator as Locator | undefined) : undefined;
            const banned = step.action !== "assert" && loc ? refuse({ name: loc.value, url: here().url() }) : undefined;
            if (banned) {
                input.onAction?.({ tool: toolName, args, ok: false, observation: refusalText(banned) });
                return { success: false, error: `${refusalText(banned)} Do not use this control; find another way or finish.`, url: here().url() };
            }
            // Working in a new tab: the step is recorded "in the popup" (the schema's popup support), as the script will run it.
            if (tab && !tab.isClosed() && POPUP_STEPS.has(step.action)) step = { ...step, inPopup: true } as Step;
            session.takeEvents();
            const r = await run(step);
            await session.quiet();
            const events = session.takeEvents();
            const told = await interruptionNotes(events, step, r.ok);
            evidence.push(...events.problems.slice(0, 5));
            if (told.popup) {
                tab = told.popup;
                rememberPopup(page, told.popup);
                await settle(tab, 1_500);
            }
            const snapshot = await snapshotFor(7_000);
            if (r.ok) {
                // A click that opened a new tab is recorded as one that waits for it, so a replay and the script follow it too.
                recorded.push({ ...step, ...(told.popup && step.action === "click" ? { opensPopup: true } : {}), description: step.description || describeStep(step) } as Step);
                await show(step, credentials ? [credentials.password] : []);
            } else if (recorded.at(-1)?.action === "dialog") {
                // The answer armed for a dialog belongs right before the action that opens it: an action that failed drops it.
                recorded.pop();
                told.lines.push("The prepared dialog answer was dropped because this action failed. Prepare it again right before the action that opens the dialog.");
            }
            input.onAction?.({ tool: toolName, args, ok: r.ok, observation: [r.ok ? `url=${here().url()}` : (r.error ?? "failed"), ...told.lines].join(" ") });
            // Arriving on another page: the notes for that page come with it, once.
            const at = pathOf(here().url());
            const pageNotes = at !== notesShownFor ? notesFor(input.notes, here().url()) : undefined;
            notesShownFor = at;
            return { success: r.ok, ...(r.error ? { error: r.error } : {}), ...(told.lines.length ? { happened: told.lines.join("\n") } : {}), url: here().url(), snapshot, ...(pageNotes ? { notes: pageNotes } : {}) };
        };

        const tools = {
            click: tool({
                description: "Click an element.",
                inputSchema: z.object({ target, why: z.string().optional().describe("Short user-facing description of this step") }),
                execute: ({ target: t, why }) => record({ action: "click", locator: t as Locator, description: why ?? "" }, "click", t),
            }),
            fill: tool({
                description: "Type text into an input (replaces existing content).",
                inputSchema: z.object({ target, value: z.string(), why: z.string().optional() }),
                execute: ({ target: t, value, why }) =>
                    record({ action: "fill", locator: t as Locator, value, description: why ?? "" }, "fill", { target: t, value: value.includes("credentials.password") ? "{{credentials.password}}" : value }),
            }),
            select: tool({
                description: "Choose an option (by value or visible label) in a <select>.",
                inputSchema: z.object({ target, value: z.string(), why: z.string().optional() }),
                execute: ({ target: t, value, why }) => record({ action: "select", locator: t as Locator, value, description: why ?? "" }, "select", { target: t, value }),
            }),
            check: tool({
                description: "Check or uncheck a checkbox/radio.",
                inputSchema: z.object({ target, checked: z.boolean().default(true), why: z.string().optional() }),
                execute: ({ target: t, checked, why }) => record({ action: "check", locator: t as Locator, checked, description: why ?? "" }, "check", { target: t, checked }),
            }),
            press: tool({
                description: "Press a keyboard key (Enter, Tab, Escape...), optionally focused on an element.",
                inputSchema: z.object({ key: z.string(), target: LocatorSchema.optional(), why: z.string().optional() }),
                execute: ({ key, target: t, why }) => record({ action: "press", key, locator: t as Locator | undefined, description: why ?? "" }, "press", { key, target: t }),
            }),
            hover: tool({
                description: "Hover an element (reveals menus/tooltips).",
                inputSchema: z.object({ target, why: z.string().optional() }),
                execute: ({ target: t, why }) => record({ action: "hover", locator: t as Locator, description: why ?? "" }, "hover", t),
            }),
            upload: tool({
                description: "Put a small generated file into a file field (or the button that opens the file chooser). The file's type follows the field's accepted types unless fileType is given. Never a person's own files.",
                inputSchema: z.object({ target, fileType: z.enum(SAMPLE_TYPES as [string, ...string[]]).optional(), why: z.string().optional() }),
                execute: async ({ target: t, fileType, why }) => {
                    const type = fileType ?? sampleTypeFor(await acceptOf(here(), t as Locator));
                    return record({ action: "upload", locator: t as Locator, file: sampleName(type), description: why ?? "" }, "upload", { target: t, fileType: type });
                },
            }),
            drop: tool({
                description: "Drop a small generated file onto a drop zone (drag-and-drop file upload area).",
                inputSchema: z.object({ target, fileType: z.enum(SAMPLE_TYPES as [string, ...string[]]).optional(), why: z.string().optional() }),
                execute: async ({ target: t, fileType, why }) => {
                    const type = fileType ?? sampleTypeFor(await acceptOf(here(), t as Locator));
                    return record({ action: "upload", locator: t as Locator, file: sampleName(type), drop: true, description: why ?? "" }, "drop", { target: t, fileType: type });
                },
            }),
            drag: tool({
                description: "Drag an element and drop it on another one (reorder a list, move a card).",
                inputSchema: z.object({ target, to: LocatorSchema.describe("Where it is dropped"), why: z.string().optional() }),
                execute: ({ target: t, to, why }) => record({ action: "drag", locator: t as Locator, target: to as Locator, description: why ?? "" }, "drag", { target: t, to }),
            }),
            dialog: tool({
                description:
                    "Prepare the answer to the NEXT alert/confirm/prompt dialog, then perform the action that opens it. Without this, dialogs are dismissed (a confirmed delete does nothing). message: text the dialog should contain; promptText: what to type into a prompt.",
                inputSchema: z.object({ response: z.enum(["accept", "dismiss"]), message: z.string().max(300).optional(), promptText: z.string().max(500).optional(), why: z.string().optional() }),
                execute: ({ response, message, promptText, why }) =>
                    record({ action: "dialog", response, ...(message ? { message } : {}), ...(promptText !== undefined ? { promptText } : {}), description: why ?? "" }, "dialog", { response, message, promptText }),
            }),
            download: tool({
                description: "Click a control that downloads a file, wait for the download, and check the file is not empty (and its name contains filename, if given).",
                inputSchema: z.object({ target, filename: z.string().max(200).optional(), why: z.string().optional() }),
                execute: ({ target: t, filename, why }) => record({ action: "download", locator: t as Locator, ...(filename ? { filename } : {}), description: why ?? "" }, "download", { target: t, filename }),
            }),
            switchTab: tool({
                description: "Work in the first page again (main) or in the latest new tab (newTab). Records no step.",
                inputSchema: z.object({ to: z.enum(["main", "newTab"]) }),
                execute: async ({ to }) => {
                    const opened = session.context.pages().filter((p) => p !== page && !p.isClosed()).at(-1);
                    if (to === "newTab" && !opened) return { success: false, error: "No new tab is open.", url: here().url() };
                    tab = to === "main" ? undefined : opened;
                    if (tab) rememberPopup(page, tab);
                    input.onAction?.({ tool: "switchTab", args: { to }, ok: true, observation: `url=${here().url()}` });
                    return { success: true, url: here().url(), snapshot: await snapshotFor(7_000) };
                },
            }),
            navigate: tool({
                description: "Navigate to a path or URL on the application.",
                inputSchema: z.object({ url: z.string() }),
                execute: async ({ url }) => {
                    // Text that goes on to be stored passes no save check, so the rule of a save holds here (the address itself is checked when the step runs).
                    if (process.env.BLOCK_PRIVATE_TARGETS === "true" && placeholderCanMoveAddress(url)) return { success: false, error: `${RUN_ADDRESS_RULE}: a {{placeholder}} must come after the site's address.`, url: page.url() };
                    return record({ action: "navigate", url, description: `Open ${url}` }, "navigate", { url });
                },
            }),
            clock: tool({
                description:
                    "Control the page's time, for session timeouts, expiry, countdowns and \"x minutes ago\". op install: take over the clock (from `time`, or now) - do it BEFORE opening the page that reads the time; fastForward: jump `minutes` ahead (timers due fire); pauseAt: stop at `time`; resume. time like 2025-01-15T09:30:00Z.",
                inputSchema: z.object({ op: z.enum(CLOCK_OPS), time: z.string().max(40).optional(), minutes: z.number().min(0).max(MAX_CLOCK_MINUTES).optional(), why: z.string().optional() }),
                execute: ({ op, time, minutes, why }) => record({ action: "clock", op, ...(time ? { time } : {}), ...(minutes !== undefined ? { minutes } : {}), description: why ?? "" }, "clock", { op, time, minutes }),
            }),
            condition: tool({
                description: `Change a browser condition from now on (then assert how the app copes, e.g. its offline message or "location refused" text). ${CONDITION_HELP}`,
                inputSchema: z.object({ set: z.enum(CONDITION_SETS), value: z.string().max(200).optional(), why: z.string().optional() }),
                execute: ({ set, value, why }) => record({ action: "condition", set, ...(value ? { value } : {}), description: why ?? "" }, "condition", { set, value }),
            }),
            wait: tool({
                description: `Wait for something: until "url" (the address contains value), "response" (a response whose address contains value, caused by your previous action), "hidden" or "visible" (target). A fixed pause (ms, at most ${MAX_FIXED_WAIT_MS}) only when nothing can be waited for; asserts auto-wait anyway.`,
                inputSchema: z.object({ until: z.enum(WAIT_UNTIL).optional(), value: z.string().max(500).optional(), target: LocatorSchema.optional(), ms: z.number().int().min(0).max(MAX_FIXED_WAIT_MS).optional() }),
                execute: async ({ until, value, target: t, ms }) => {
                    const missing = until === "url" || until === "response" ? (!value ? `waiting for a ${until} needs value` : undefined) : until ? (!t ? `waiting until ${until} needs a target` : undefined) : ms === undefined ? "give until, or ms for a fixed pause" : undefined;
                    if (missing) {
                        input.onAction?.({ tool: "wait", args: { until, value, ms }, ok: false, observation: missing });
                        return { success: false, error: missing, url: page.url() };
                    }
                    const step: Step = until ? { action: "wait", ms: 0, until, ...(value ? { value } : {}), ...(t ? { locator: t as Locator } : {}), description: "" } : { action: "wait", ms: ms!, description: `Wait ${ms}ms` };
                    return record(step, "wait", { until, value, target: t, ms });
                },
            }),
            remember: tool({
                description: "Remember the text (or a field's value) of an element under a name, to compare later (assert check remembered) or reuse as {{name}}: e.g. the price on the product page, checked in the cart.",
                inputSchema: z.object({ target, name: z.string().regex(REMEMBER_NAME), from: z.enum(["text", "value"]).default("text"), why: z.string().optional() }),
                execute: ({ target: t, name, from, why }) => record({ action: "remember", locator: t as Locator, name, from, description: why ?? "" }, "remember", { target: t, name, from }),
            }),
            assert: tool({
                description:
                    "Verify something about the page (auto-retries ~6s). check: visible|hidden (locator or expected text), text (locator contains expected), exactText (whole text is expected), notText (does NOT contain expected), value, enabled, disabled, editable, checked, unchecked, focused, inViewport, count (expected number), url (current URL contains expected), urlPattern (expected like /orders/*), title, attribute (name + optional expected), class (expected class), css (name = property, expected = computed value), accessibleName, accessibleErrorMessage (a field's validation message), ariaSnapshot (target = the result list/table/summary; leave expected empty: its structure is captured, numbers and dates become patterns), remembered (target compared with a remembered value: name + compare equals|contains|greater|less). Only passing assertions are recorded.",
                inputSchema: z.object({
                    check: z.enum(AUTHOR_CHECKS),
                    target: LocatorSchema.optional(),
                    expected: z.union([z.string(), z.number()]).optional(),
                    name: z.string().max(100).optional().describe("attribute / css: the attribute or property; remembered: the remembered value's name"),
                    compare: z.enum(REMEMBER_COMPARE).optional(),
                    why: z.string().optional(),
                }),
                execute: async ({ check, target: t, expected: given, name, compare, why }) => {
                    let expected = given;
                    const refuse = (error: string) => {
                        input.onAction?.({ tool: "assert", args: { check, target: t, expected }, ok: false, observation: error });
                        return { success: false, error, url: page.url() };
                    };
                    if (NEEDS_LOCATOR.has(check) && !t) return refuse(`"${check}" needs a target`);
                    if ((check === "attribute" || check === "css" || check === "remembered") && !name) return refuse(`"${check}" needs a name`);
                    // The region's structure, captured now as a template a later run with other numbers still matches.
                    if (check === "ariaSnapshot") {
                        if (!t) return refuse('"ariaSnapshot" needs a target: the list, table or summary that shows the result');
                        try {
                            expected = await captureAriaTemplate(page, t as Locator, data);
                        } catch (err) {
                            return refuse(err instanceof Error ? err.message.split("\n")[0]! : String(err));
                        }
                    }
                    if (NEEDS_EXPECTED.has(check) && (expected === undefined || expected === "")) return refuse(`"${check}" needs a non-empty expected value`);
                    const extra = { ...(name ? { name } : {}), ...(check === "remembered" ? { compare: compare ?? "equals" } : {}) };
                    // An empty expectation makes url/title/text/value checks vacuous (e.g. toHaveURL(/(?:)/i)
                    // always passes) yet would still satisfy the "has an assertion" rule — refuse it.
                    const needsExpected = ["url", "title", "text", "value", "count"].includes(check);
                    const needsSubject = (check === "visible" || check === "hidden") && !t && (expected === undefined || expected === "");
                    if ((needsExpected && (expected === undefined || expected === "")) || needsSubject) {
                        const error = needsSubject ? `"${check}" needs a target or expected text` : `"${check}" needs a non-empty expected value`;
                        input.onAction?.({ tool: "assert", args: { check, target: t, expected }, ok: false, observation: error });
                        return { success: false, error, url: page.url() };
                    }
                    return record({ action: "assert", check, locator: t as Locator | undefined, expected, ...extra, description: why ?? "" }, "assert", { check, target: t, expected, ...extra });
                },
            }),
            ...(input.vision ? { lookAtScreen: makeLookAtScreen({ ctx, browser, page, scenarioId: scenario.scenarioId, observations, onAction: input.onAction }) } : {}),
            ...(input.testData ? { testValue: testValueTool(input.testData, testData, input.onAction) } : {}),
            ...(view
                ? {
                      seeWholePage: tool({
                          description: "The whole page again: the full snapshot, nothing shortened. Records no step.",
                          inputSchema: z.object({}),
                          execute: async () => {
                              const snapshot = view.whole(page.url(), await ariaSnapshot(page, RAW_SNAPSHOT_MAX));
                              input.onAction?.({ tool: "seeWholePage", args: {}, ok: true, observation: `url=${page.url()}` });
                              return { url: page.url(), snapshot };
                          },
                      }),
                  }
                : {}),
            finish: tool({
                description: "End the authoring session.",
                inputSchema: z.object({ result: z.enum(["complete", "defect", "blocked"]), explanation: z.string() }),
                execute: async ({ result, explanation }) => {
                    // A complete test must prove the outcome: pushed back (a bounded number of times) and the agent continues.
                    if (result === "complete" && !hasOutcomeAssertion(recorded) && pushbacks < OUTCOME_PUSHBACKS) {
                        pushbacks++;
                        input.onAction?.({ tool: "finish", args: { result }, ok: false, observation: NO_OUTCOME_HINT });
                        return { done: false, error: NO_OUTCOME_HINT };
                    }
                    outcome = result === "defect" ? { status: result, steps: [...recorded], testData, explanation, ...(evidence.length ? { evidence: [...new Set(evidence)].slice(0, 15) } : {}) } : { status: result, steps: [...recorded], testData, explanation };
                    return { done: true };
                },
            }),
        };

        const snapshot = await snapshotFor(9_000);
        const prompt = `Scenario ${scenario.scenarioId}: ${scenario.title}
Description: ${scenario.description}
Category: ${scenario.category}   Type: ${scenario.type}
Preconditions: ${scenario.preconditions.join("; ") || "none"}
Required data: ${scenario.requiredData.join("; ") || "none"}
Expected results (assert ALL of them):
${scenario.expectedResults.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}
Test account: ${credentials ? "available as {{credentials.username}} / {{credentials.password}}" : "NOT available"}
${pageHint(model, scenario)}
${notesFor(input.notes, page.url()) ?? ""}
${
    resume?.review
        ? `A review of this test against its scenario asked for these changes:\n${resume.failure}\nThe test's steps so far have been replayed (${resume.prefix.length - 1} steps). Continue from the current page state: apply the changes, then assert every expected result.\n`
        : resume
        ? `A previous version of this test FAILED when executed as a standalone script:\n${resume.failure}\nThe steps that already work have been replayed (${resume.prefix.length - 1} steps). Continue from the current page state with corrected steps so the scenario fully completes, and re-assert all expected results.\n`
        : ""
}Current page: ${page.url()}
Accessibility snapshot:
${snapshot}`;

        await generateText({
            model: ctx.llm.model,
            system: (input.vision ? SYSTEM + VISION_AUTHORING_NOTE : SYSTEM) + (input.testData ? TEST_DATA_AUTHORING_NOTE : "") + (view ? COMPACT_SNAPSHOT_NOTE : ""),
            prompt,
            tools,
            providerOptions: PROVIDER_OPTIONS,
            maxRetries: LLM_MAX_RETRIES,
            // Ends when finish was accepted (a pushed-back finish lets the agent go on).
            stopWhen: [stepCountIs(input.maxSteps ?? 28), () => outcome !== undefined],
            // Each step's tokens, prompt-cache reads and writes included (the instructions, tools and earlier steps are cached: llm/prompt-cache.ts).
            onStepFinish: (e) => {
                addUsage(ctx.llm.usage, e.usage);
                view?.modelStep();
                // A fast model that keeps failing, repeats itself or makes no progress hands the rest of this scenario to the main model (llm/routing.ts).
                noteAgentStep(e);
            },
            abortSignal: ctx.signal,
        });
        if (view) ctx.emit(snapshotSavingsEvent(scenario.scenarioId, view.totals));

        const base: AuthorOutcome =
            outcome ?? { status: "blocked", steps: recorded, testData, explanation: pushbacks ? NO_OUTCOME : "Step budget exhausted before finishing" };
        const result: AuthorOutcome = observations.length ? { ...base, observations: [...observations] } : base;
        // A "complete" test must actually verify the scenario's outcome.
        if (result.status === "complete" && !hasOutcomeAssertion(result.steps)) {
            return { ...result, status: "blocked", explanation: NO_OUTCOME };
        }
        if (result.status === "complete" || result.status === "defect") {
            const pruned = await pruneByReplay(browser, baseUrl, result.steps, credentials, result.status === "complete");
            if (pruned.dropped > 0) {
                ctx.emit({
                    stage: "generation",
                    kind: "steps_pruned",
                    message: `${scenario.scenarioId}: dropped ${pruned.dropped} stale step(s) left over from abandoned attempts`,
                });
                return { ...result, steps: pruned.steps };
            }
        }
        return result;
        })());
    } finally {
        if (traced) await keepBlockedTrace(input, session, finished);
        await session.close();
    }
}

/** Where blocked authoring traces are kept, inside the scratch folder. On a runner that folder is the task's own and goes with the task. */
export const AUTHORING_TRACES = "authoring-traces";
const TRACE_MAX_AGE_MS = 60 * 60_000;
const TRACE_MAX_TOTAL = 256 * 1024 * 1024;

/**
 * Removes kept authoring traces older than an hour (as validation's run folders are), then the oldest ones until the rest fit in
 * 256 MB (the newest is removed last). Never throws.
 */
export async function pruneAuthoringTraces(scratchDir: string, now = Date.now()): Promise<void> {
    const dir = path.join(scratchDir, AUTHORING_TRACES);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const files = (await Promise.all(names.map(async (n) => ({ file: path.join(dir, n), st: await fs.stat(path.join(dir, n)).catch(() => null) })))).filter((f) => f.st?.isFile());
    files.sort((a, b) => a.st!.mtimeMs - b.st!.mtimeMs);
    let total = files.reduce((sum, f) => sum + f.st!.size, 0);
    for (const f of files) {
        if (now - f.st!.mtimeMs <= TRACE_MAX_AGE_MS && total <= TRACE_MAX_TOTAL) continue;
        await fs.rm(f.file, { force: true }).catch(() => undefined);
        total -= f.st!.size;
    }
}

/** A blocked scenario keeps its authoring trace (masked with the sign-in password) in the scratch folder; any other ending drops it. Never throws. */
async function keepBlockedTrace(input: AuthorInput, session: BrowserSession, finished: AuthorOutcome | undefined): Promise<void> {
    try {
        if (finished?.status !== "blocked") {
            await session.context.tracing.stop();
            return;
        }
        const file = path.join(input.ctx.config.scratchDir, AUTHORING_TRACES, `${input.scenario.scenarioId.replace(/[^\w-]/g, "_").slice(0, 60)}-${Date.now()}.zip`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await session.context.tracing.stop({ path: file });
        await pruneAuthoringTraces(input.ctx.config.scratchDir);
        const clean = await scrubTraceFile(file, input.credentials?.password ? [input.credentials.password] : []);
        if (!clean.ok) {
            await fs.rm(file, { force: true });
            return;
        }
        finished.trace = file;
        input.ctx.emit({ stage: "generation", kind: "authoring_trace_kept", message: `${input.scenario.scenarioId}: the browser trace of the blocked attempt was kept`, data: { scenarioId: input.scenario.scenarioId } });
    } catch {
        /* a trace is evidence only: it never changes the outcome */
    }
}

/**
 * Every action that succeeded while authoring is recorded, including ones from attempts the agent then
 * abandoned and redid (e.g. a second login sequence). Replayed in order those leftovers break, because
 * the app has already moved on. Replay the steps once in a clean browser and drop *non-assertion* steps
 * that fail there. The pruned list is accepted only if it still reaches every assertion it should
 * (all of them for a "complete" test), so pruning can never hide a real failure — otherwise the
 * original steps are kept and normal validation/repair applies.
 */
export async function pruneByReplay(
    browser: Browser,
    baseUrl: string,
    steps: Step[],
    credentials: { username: string; password: string } | undefined,
    requireAllAssertsPass: boolean,
): Promise<{ steps: Step[]; dropped: number }> {
    const session = await BrowserSession.launch(browser, { startUrl: baseUrl });
    session.page.setDefaultTimeout(5_000);
    const data = runtimeData({}, credentials);
    const kept: Step[] = [];
    let dropped = 0;
    let assertFailed = false;
    try {
        for (const step of steps) {
            try {
                await executeStep(session.page, step, data, baseUrl, 5_000);
                await settle(session.page, 1_500);
                kept.push(step);
            } catch {
                if (step.action === "assert") {
                    // A "defect" test is expected to fail on its final assertion; keep it and stop.
                    assertFailed = true;
                    kept.push(step);
                    if (requireAllAssertsPass) break;
                } else {
                    dropped++;
                }
            }
        }
    } finally {
        await session.close();
    }
    const intact = kept.length + dropped === steps.length;
    if (!intact || (requireAllAssertsPass && assertFailed) || !kept.some((s) => s.action === "assert")) {
        return { steps, dropped: 0 };
    }
    return { steps: kept, dropped };
}

/** Assemble a full canonical spec from a finished authoring outcome. */
export function toSpec(scenario: Scenario, outcome: AuthorOutcome, testId: string): TestSpec {
    return {
        testId,
        title: scenario.title,
        description: scenario.description,
        kind: "web",
        category: scenario.category,
        type: scenario.type,
        priority: scenario.priority,
        preconditions: scenario.preconditions,
        steps: outcome.steps,
        expectedResults: scenario.expectedResults,
        testData: outcome.testData,
        tags: [scenario.type, scenario.priority],
        source: {
            scenarioId: scenario.scenarioId,
            journey: scenario.journey,
            origin: "browser-agent",
            ...(scenario.requirements.length ? { requirements: scenario.requirements } : {}),
        },
    };
}
