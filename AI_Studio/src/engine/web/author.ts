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
import { generateText, stepCountIs, tool } from "ai";
import type { Browser } from "playwright";
import { z } from "zod";
import type { EngineContext } from "../context.js";
import { activityOfStep, activityLine, pathOf } from "../frames/activity.js";
import type { FrameSink } from "../frames/sink.js";
import { LLM_MAX_RETRIES, PROVIDER_OPTIONS } from "../llm/provider.js";
import { addUsage } from "../llm/prompt-cache.js";
import { noteAgentStep, withRoute } from "../llm/routing.js";
import { ariaSnapshot, BrowserSession, settle } from "../discovery/browser.js";
import { placeholderCanMoveAddress, RUN_ADDRESS_RULE } from "../spec/run-address.js";
import { describeStep, LocatorSchema, type Locator, type Scenario, type Step, type TestSpec } from "../spec/schema.js";
import type { AppModel, PageModel } from "../understanding/app-model.js";
import { makeLookAtScreen, VISION_AUTHORING_NOTE } from "../vision/look.js";
import { COMPACT_SNAPSHOT_NOTE, RAW_SNAPSHOT_MAX, SnapshotView, snapshotSavingsEvent } from "../snapshots/compact.js";
import { compactSnapshotsOn } from "../snapshots/setting.js";
import { executeStep, runtimeData, type RuntimeData } from "./interpreter.js";
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
    | { status: "defect"; steps: Step[]; testData: Record<string, string>; explanation: string; observations?: string[] }
    | { status: "blocked"; steps: Step[]; testData: Record<string, string>; explanation: string; observations?: string[] };

const SYSTEM = `You are an automated QA engineer authoring ONE end-to-end test by performing it in a real browser.
Every action you perform successfully is recorded into a reusable Playwright test, so be deliberate:
- Perform the scenario step by step; after each action you receive the page's accessibility snapshot. Look before you act.
- Locate elements the way a user would: by="role" (role + accessible name) first, then "label", "placeholder", "text". Use "css" only as a last resort.
  Role names are ARIA roles (button, link, textbox, checkbox, combobox, heading, tab, menuitem...). Copy accessible names from the snapshot.
- If a locator matches several elements the action fails; make it more specific (exact=true, a different role/name) or use nth.
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
- Stay in the UI: do not navigate to API/JSON endpoints; verify what a user sees in the pages.`;

const target = LocatorSchema.describe("How to find the element");

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
        return out;
    });
}

const OUTCOME_PUSHBACKS = 2;
const NO_OUTCOME = "Authoring finished without recording any assertion on the expected outcome";
const NO_OUTCOME_HINT =
    "Not finished: the test has no assertion on the scenario's expected outcome after the last action. Assert what the user should now observe (text, value, URL or count), not only that the element you used is visible, then call finish again.";
const INTERACTIONS = new Set<Step["action"]>(["navigate", "click", "fill", "select", "check", "press", "hover"]);

/** An assertion after the last action that is more than "the element I just used is visible": it proves the scenario's outcome. */
export function hasOutcomeAssertion(steps: readonly Step[]): boolean {
    const key = (l: unknown) => JSON.stringify(l);
    const touched = new Set(steps.flatMap((s) => (INTERACTIONS.has(s.action) && "locator" in s && s.locator ? [key(s.locator)] : [])));
    const lastAction = steps.findLastIndex((s) => INTERACTIONS.has(s.action));
    return steps.slice(lastAction + 1).some((s) => s.action === "assert" && !(s.check === "visible" && s.locator && touched.has(key(s.locator))));
}

const REVIEW_SYSTEM = `You review ONE automatically written end-to-end web test against the scenario it must prove.
Ask for a change only for: an expected result with no assertion that would fail if the outcome did not happen; an assertion that only checks that a clicked element is visible;
an outcome that depends on an earlier step but is not checked (the value typed in a form should show afterwards); a weak locator (css or nth where a role, label or text exists);
a step that does not match the scenario's intent. Never ask to remove or loosen an assertion.
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
    const session = await BrowserSession.launch(browser, { startUrl: baseUrl });
    const { page } = session;
    page.setDefaultTimeout(6_000);

    const recorded: Step[] = [];
    const observations: string[] = [];
    const data: RuntimeData = runtimeData({}, credentials);
    const testData: Record<string, string> = {};
    let outcome: AuthorOutcome | undefined;
    let pushbacks = 0;
    // Smaller page snapshots (setting LLM_COMPACT_SNAPSHOTS, on by default): off = exactly the snapshots, tools and instructions of before.
    const view = compactSnapshotsOn(ctx.config) ? new SnapshotView() : undefined;
    /** The page as the model gets it: the whole snapshot cut at `max`, or (smaller snapshots on) the compact one or what changed. */
    const snapshotFor = async (max: number) => (view ? view.show(page.url(), await ariaSnapshot(page, RAW_SNAPSHOT_MAX), max) : await ariaSnapshot(page, max));

    try {
        const run = async (step: Step): Promise<{ ok: boolean; error?: string }> => {
            try {
                await executeStep(page, step, data, baseUrl);
                await settle(page, 1_500);
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
            const banned = step.action !== "assert" && loc ? refuse({ name: loc.value, url: page.url() }) : undefined;
            if (banned) {
                input.onAction?.({ tool: toolName, args, ok: false, observation: refusalText(banned) });
                return { success: false, error: `${refusalText(banned)} Do not use this control; find another way or finish.`, url: page.url() };
            }
            const r = await run(step);
            const snapshot = await snapshotFor(7_000);
            if (r.ok) {
                recorded.push({ ...step, description: step.description || describeStep(step) });
                await show(step, credentials ? [credentials.password] : []);
            }
            input.onAction?.({ tool: toolName, args, ok: r.ok, observation: r.ok ? `url=${page.url()}` : (r.error ?? "failed") });
            // Arriving on another page: the notes for that page come with it, once.
            const here = pathOf(page.url());
            const pageNotes = here !== notesShownFor ? notesFor(input.notes, page.url()) : undefined;
            notesShownFor = here;
            return { success: r.ok, ...(r.error ? { error: r.error } : {}), url: page.url(), snapshot, ...(pageNotes ? { notes: pageNotes } : {}) };
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
            navigate: tool({
                description: "Navigate to a path or URL on the application.",
                inputSchema: z.object({ url: z.string() }),
                execute: async ({ url }) => {
                    // Text that goes on to be stored passes no save check, so the rule of a save holds here (the address itself is checked when the step runs).
                    if (process.env.BLOCK_PRIVATE_TARGETS === "true" && placeholderCanMoveAddress(url)) return { success: false, error: `${RUN_ADDRESS_RULE}: a {{placeholder}} must come after the site's address.`, url: page.url() };
                    return record({ action: "navigate", url, description: `Open ${url}` }, "navigate", { url });
                },
            }),
            wait: tool({
                description: "Pause (ms). Prefer assert, which auto-waits.",
                inputSchema: z.object({ ms: z.number().int().min(0).max(5000) }),
                execute: ({ ms }) => record({ action: "wait", ms, description: `Wait ${ms}ms` }, "wait", { ms }),
            }),
            assert: tool({
                description:
                    "Verify something about the page (auto-retries ~6s). check: visible|hidden (locator or expected text), text (locator contains expected), value, enabled, disabled, count (expected number), url (current URL contains expected), title. Only passing assertions are recorded.",
                inputSchema: z.object({
                    check: z.enum(["visible", "hidden", "text", "value", "enabled", "disabled", "count", "url", "title"]),
                    target: LocatorSchema.optional(),
                    expected: z.union([z.string(), z.number()]).optional(),
                    why: z.string().optional(),
                }),
                execute: async ({ check, target: t, expected, why }) => {
                    // An empty expectation makes url/title/text/value checks vacuous (e.g. toHaveURL(/(?:)/i)
                    // always passes) yet would still satisfy the "has an assertion" rule — refuse it.
                    const needsExpected = ["url", "title", "text", "value", "count"].includes(check);
                    const needsSubject = (check === "visible" || check === "hidden") && !t && (expected === undefined || expected === "");
                    if ((needsExpected && (expected === undefined || expected === "")) || needsSubject) {
                        const error = needsSubject ? `"${check}" needs a target or expected text` : `"${check}" needs a non-empty expected value`;
                        input.onAction?.({ tool: "assert", args: { check, target: t, expected }, ok: false, observation: error });
                        return { success: false, error, url: page.url() };
                    }
                    return record({ action: "assert", check, locator: t as Locator | undefined, expected, description: why ?? "" }, "assert", { check, target: t, expected });
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
                    outcome = { status: result, steps: [...recorded], testData, explanation };
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
    } finally {
        await session.close();
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
