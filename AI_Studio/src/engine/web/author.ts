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
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { generateText, stepCountIs, tool } from "ai";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import type { EngineContext } from "../context.js";
import { activityOfStep, activityLine, pathOf } from "../frames/activity.js";
import type { FrameSink } from "../frames/sink.js";
import { AGENT_STEP_MAX_OUTPUT_TOKENS, LLM_MAX_RETRIES, PROVIDER_OPTIONS } from "../llm/provider.js";
import { addUsage } from "../llm/prompt-cache.js";
import { noteAgentStep, withRoute } from "../llm/routing.js";
import { ariaSnapshot, BrowserSession, settle, type SessionEvents } from "../discovery/browser.js";
import { placeholderCanMoveAddress, RUN_ADDRESS_RULE } from "../spec/run-address.js";
import { CLOCK_OPS, CONDITION_SETS, MAX_CLOCK_MINUTES } from "../spec/schema.js";
import { CONDITION_HELP } from "./conditions.js";
import { REMEMBER_COMPARE, REMEMBER_NAME, WAIT_UNTIL, type ASSERT_CHECKS } from "../spec/schema.js";
import { NEEDS_EXPECTED, NEEDS_LOCATOR } from "./checks.js";
import { captureAriaTemplate } from "./interpreter.js";
import { nearbyTargets } from "./label-fallback.js";
import { describeStep, LocatorSchema, type Locator, type Scenario, type Step, type TestSpec } from "../spec/schema.js";
import type { AppModel, PageModel } from "../understanding/app-model.js";
import { makeLookAtScreen, VISION_AUTHORING_NOTE } from "../vision/look.js";
import { COMPACT_SNAPSHOT_NOTE, RAW_SNAPSHOT_MAX, SnapshotView, snapshotSavingsEvent } from "../snapshots/compact.js";
import { compactSnapshotsOn } from "../snapshots/setting.js";
import { scrubTraceFile } from "../evidence/trace-scrub.js";
import { executeStep, locate, rememberPopup, runtimeData, type RuntimeData } from "./interpreter.js";
import { sampleName, sampleTypeFor, SAMPLE_TYPES } from "./interruptions.js";
import { notesFor, refusalText, refusedBy, type SiteNote } from "../memory/notes.js";
import { knowledgeBlock, usableRules, type KnowledgeRule } from "../planning/planner.js";
import { maskObservedText, observedTextSecrets } from "../evidence/observed-text.js";
import { redactText } from "../../shared/redact-text.js";
import { TEST_DATA_AUTHORING_NOTE, testValueTool, type TestData } from "../testdata/generate.js";
import { findLeftoverUse, LEFTOVER_REDO, leftoverReason } from "./leftovers.js";

export interface AuthorInput {
    ctx: EngineContext;
    browser: Browser;
    baseUrl: string;
    model: AppModel;
    scenario: Scenario;
    credentials?: { username: string; password: string };
    /** Resume mode (repair): steps to replay first, and why the previous version failed. */
    resume?: { prefix: Step[]; failure: string; /** The note is a review's list of changes, not a failed run. */ review?: boolean };
    /** Called for each tool action (the job sink takes it; tool calls are not stored, see repo-sink.ts agentAction). */
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
    /**
     * The leftover check (web/leftovers.ts): a finished test that acts on or checks an item its own earlier steps never added or opened
     * is written once more from the start, told why. A test still doing so is returned as it is (the caller saves it for review) and its
     * defect, if any, is not put to the verdict reviews.
     */
    leftoverCheck?: boolean;
    /** Why an earlier version of this test was not kept (the leftover check's second try): said in the prompt of a fresh authoring run. */
    redo?: string;
    /** The project's notes for the AI (memory/notes.ts): those for the current page go into the prompt, and a "never" note refuses its control. */
    notes?: SiteNote[];
    /** Generated test data for the run (data-changing tests on): the agent gets a testValue tool, and the spec records the run tag. */
    testData?: TestData;
    /** The scenario's rules (stated by a source or confirmed by a person): the test checks them where the scenario reaches them. */
    rules?: KnowledgeRule[];
    /** The ids of the project's requirements (the job's requirements document): an expected result naming one the scenario covers is stated (statedSource). */
    requirementIds?: readonly string[];
    /**
     * The run's other known secrets (authenticator secrets, API tokens, other accounts' passwords): what the application shows in the
     * console, page errors, failed requests and dialogs is masked with them (and the sign-in password) before the AI or a stored record sees
     * it, and the kept trace of a blocked attempt is cleaned with them.
     */
    secrets?: string[];
    /**
     * The exploration loop's bound (explore/loop.ts; CP2 H-2, M-1, M-5): asked before each action reaches the application. A refused
     * action is not performed and the model is told so. Absent outside objective-driven exploration.
     */
    gate?: ActionGate;
    /**
     * Model steps left for this scenario across every pass it takes (the first one, a review's fix, the leftover redo and its review):
     * shared and counted down, so the objective's step budget holds for the whole pursuit. Absent: each pass has `maxSteps` of its own.
     */
    stepBudget?: { left: number };
}

/** An action as the gate sees it before it runs. */
export interface GateAction {
    tool: string;
    args: unknown;
    /** The element(s) the action resolves to on the page now (role and accessible name, plus a digest of its DOM path); absent when it has no target or none is found. */
    target?: string;
    /** The address of the page the action is taken on. */
    url: string;
    /** The action only reads the page (a wait or a check). */
    read: boolean;
}

export interface ActionGate {
    /** Asked before each action reaches the application, in the order the model asked for them; a refusal means it is not performed. */
    before(a: GateAction): { allowed: true } | { allowed: false; reason: string };
    /** Told after an action that was allowed ran (with the address the page is on afterwards). */
    after(a: { tool: string; args: unknown; target?: string; ok: boolean; url: string; read: boolean }): void;
    /** A new browser pass from the start page begins (the first try, a review's fix, the leftover redo): per-pass tracking starts again. */
    freshPass(startUrl: string): void;
    /** Asked before saved steps are replayed in a fresh browser without the AI (`steps` actions): false means the replay is not run. */
    replay(steps: number, what: string): boolean;
}

/** Tools that only read the page: they do not count as a new visit of the state they run on (explore/loop.ts depth). */
const READ_TOOLS = new Set(["assert", "wait", "remember"]);

/** What a target resolves to on `page` now: role and accessible name of the first match and a digest of its DOM path; undefined when nothing matches quickly. */
async function targetIdentity(page: Page, l: Locator, data: RuntimeData): Promise<string | undefined> {
    try {
        const el = locate(page, l, data).first();
        const [aria, domPath] = await Promise.all([
            el.ariaSnapshot({ timeout: 1_000 }),
            el.evaluate((node) => {
                const parts: string[] = [];
                for (let e: Element | null = node; e && e.parentElement; e = e.parentElement) {
                    const tag = e.tagName.toLowerCase();
                    const same = Array.from(e.parentElement.children).filter((c) => c.tagName === e!.tagName);
                    parts.unshift(same.length > 1 ? `${tag}:${same.indexOf(e) + 1}` : tag);
                }
                return parts.join(">");
            }, undefined, { timeout: 1_000 }),
        ]);
        // `- button "Continue"` or `- textbox "Email": typed value`: role and name only, never a value.
        const m = /^- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(aria.split("\n")[0] ?? "");
        const digest = createHash("sha256").update(domPath).digest("hex").slice(0, 12);
        return `${m?.[1] ?? "element"}${m?.[2] !== undefined ? ` ${JSON.stringify(m[2].slice(0, 120))}` : ""} @${digest}`;
    } catch {
        return undefined;
    }
}

/** A step's own target(s), as the gate names them. */
async function stepTarget(page: Page, step: Step, data: RuntimeData): Promise<string | undefined> {
    const loc = "locator" in step ? (step.locator as Locator | undefined) : undefined;
    if (!loc) return undefined;
    const own = await targetIdentity(page, loc, data);
    const to = step.action === "drag" ? await targetIdentity(page, step.target as Locator, data) : undefined;
    return own && step.action === "drag" ? `${own} -> ${to ?? JSON.stringify(step.target)}` : own;
}

const AUTHORING_USE = " Where this scenario reaches what a rule describes, assert the expected behaviour it states; when the application genuinely does otherwise, call finish(result=\"defect\").";

/** The rules section of the authoring prompt (quoted data in a delimited block); undefined when no usable rule is left. */
export const authoringRulesNote = (rules: KnowledgeRule[] | undefined): string | undefined => knowledgeBlock({ rules: rules ?? [], workflows: [] }, AUTHORING_USE);

/** Every secret this authoring run knows: the sign-in password and the caller's list. */
const runSecretsOf = (input: Pick<AuthorInput, "credentials" | "secrets">): string[] =>
    [input.credentials?.password, ...(input.secrets ?? [])].filter((s): s is string => typeof s === "string" && s.length >= 4);

/** `observations`: screens the vision model judged to look wrong while authoring (only when `vision` was on). */
export type AuthorOutcome =
    | { status: "complete"; steps: Step[]; testData: Record<string, string>; explanation: string; observations?: string[] }
    | {
          status: "defect";
          steps: Step[];
          testData: Record<string, string>;
          explanation: string;
          observations?: string[];
          /** Errors the app reported while the agent worked (console, failed requests). */
          evidence?: string[];
          /**
           * "captured": the test ends with a failing check tied to a stated expectation (a rule or an expected result), so the saved
           * test fails while the bug is there; "observed_only": the agent reported the defect without such a check.
           */
          capture?: Capture;
          /** The captured check's source and what the application showed instead (masked, one line). */
          capturedCheck?: { source: string; observed: string };
      }
    | { status: "blocked"; steps: Step[]; testData: Record<string, string>; explanation: string; observations?: string[]; /** The session's Playwright trace (passwords masked), kept as evidence of what blocked it. */ trace?: string };

export type Capture = "captured" | "observed_only";

/** `expected:<n>`: the scenario's n-th expected result as an assert's source. */
const EXPECTED_SOURCE = /^expected:([1-9]\d{0,2})$/;
const normRef = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The source an assert may cite: a usable rule given to this scenario (its ref as stored), or `expected:<n>` for one of its expected
 * results; undefined when it names neither.
 */
export function sourceOf(given: string, scenario: Pick<Scenario, "expectedResults">, rules: readonly KnowledgeRule[] | undefined): string | undefined {
    const n = EXPECTED_SOURCE.exec(given.trim())?.[1];
    if (n) return Number(n) <= scenario.expectedResults.length ? `expected:${Number(n)}` : undefined;
    return usableRules(rules ?? []).find((r) => normRef(r.ref) === normRef(given))?.ref;
}

/**
 * `text` names `ref` as a whole token (not as part of a longer ref: "R-1" is not cited by "R-10" or "R-1.2", nor "1.2" by
 * "1.2.3"), ignoring spacing. A full stop ending the sentence is not part of the token.
 */
function cites(text: string, ref: string): boolean {
    const r = normRef(ref);
    if (!r) return false;
    const escaped = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w-]|\\w\\.)${escaped}(?![\\w-]|\\.\\w)`).test(normRef(text));
}

/**
 * Whether a check's source (as `sourceOf` returns it) is STATED, so a failing check of it captures a defect (queue row 172). A usable rule's
 * ref is. `expected:<n>` is only when the scenario's n-th expected result is itself tied to a stated source: an objective scenario
 * (explore/perturb.ts scenarioFor: a stated objective, and its expected result cites the objective's source as "(source: <ref>)"), or an
 * expected result that names a usable rule given to the scenario by its ref, or that names a requirement id the scenario covers which is
 * also one of the project's requirements (`requirementIds`: the ids of the job's requirements document, as the planner keeps them; the
 * scenario's own list is not enough). A planner's own expected result is not: the AI wrote it, not the application or its documents, so
 * a check of it failing on the clean app too is the planner's guess, not a defect.
 */
export function statedSource(
    source: string,
    scenario: Pick<Scenario, "expectedResults" | "objective" | "requirements">,
    rules: readonly KnowledgeRule[] | undefined,
    requirementIds?: readonly string[],
): boolean {
    const usable = usableRules(rules ?? []);
    const n = EXPECTED_SOURCE.exec(source.trim())?.[1];
    if (!n) return usable.some((r) => normRef(r.ref) === normRef(source));
    const text = scenario.expectedResults[Number(n) - 1];
    if (text === undefined) return false;
    const o = scenario.objective;
    if (o && o.kind !== "coverage-gap" && normRef(text).includes(`(source: ${normRef(o.source).replace(/…$/, "")}`)) return true;
    if (usable.some((r) => cites(text, r.ref))) return true;
    const known = new Set(requirementIds ?? []);
    return (scenario.requirements ?? []).some((id) => known.has(id) && cites(text, id));
}

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
- The test runs on its own: in a fresh browser on a fresh session (signed out, nothing remembered), before or after any other test, on an
  application that may have been reset. It never relies on what another test or an earlier attempt left (items already in a cart, an order or
  record that exists, a setting already changed): set that up with the test's own steps (add the item before checking the cart, create the
  order before checking the Orders list). Make each of the scenario's preconditions true with your first steps; never assume one holds.
  Leftovers you did not add are not yours: work around them, and never remove, change or check them by name (a fresh run will not have them).
- Use {{unique}} in every new record the test creates (names, titles, emails, usernames), so it never clashes with records an earlier run
  or another test made, and {{credentials.username}} / {{credentials.password}} for the provided test account. Never invent real people's
  data; example.com addresses only.
- You MUST finish with assertions: use the assert tool to verify EVERY expected result of the scenario (visible text, URL, value, count...).
  A test without assertions is worthless. Assert on what the user would observe, after the final action, and wait via assertions (they auto-retry) rather than fixed sleeps.
  Assert the OUTCOME, not only that what you clicked is still visible: the confirmation text, the new URL, the changed value or count.
  When an outcome depends on an earlier step, assert that link (the value typed in a form shows in the list or summary afterwards).
- Never perform irreversible/destructive real-world actions (payment, deleting accounts, sending messages). Stop before them and assert on the UI.
- When every expected result is verified, call finish(result="complete").
- If an assertion fails because the application genuinely behaves differently from the expected result, call finish(result="defect") and explain what was observed.
  Give each assertion that checks an expected result or a rule its source, so a failing one is kept as the check that shows the bug.
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

/**
 * The tools' calls run one at a time, in the order they started, so steps are recorded in that order. The AI SDK starts the tool calls
 * of one model turn together; each call settles the page, reads what happened and takes a snapshot before its step is recorded, so a call
 * with a slower aftermath (a click whose new tab is slow to settle) was recorded after a later call of the same turn, and the saved test
 * ran its steps in another order. Each run's tools get their own queue.
 */
export function inStartOrder<T extends object>(tools: T): T {
    let last: Promise<unknown> = Promise.resolve();
    for (const t of Object.values(tools) as Array<{ execute?: (...args: never[]) => unknown }>) {
        const execute = t.execute;
        if (!execute) continue;
        t.execute = (...args) => {
            const mine = last.then(() => execute(...args));
            last = mine.catch(() => undefined);
            return mine;
        };
    }
    return tools;
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

/**
 * The scenario's preconditions as the first things the test sets up with its own steps (a test never assumes another one left them true),
 * or "Preconditions: none".
 */
export function preconditionsNote(preconditions: readonly string[]): string {
    if (!preconditions.length) return "Preconditions: none";
    return `Set up first (the scenario's preconditions: make each true with the test's own first steps, never assume another test left it so):\n${preconditions.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`;
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
        if (input.leftoverCheck && !input.resume && out.status !== "blocked") {
            const uses = findLeftoverUse(out.steps);
            if (uses.length) {
                const redo = `${leftoverReason(uses)} ${LEFTOVER_REDO}`;
                input.ctx.emit({ stage: "generation", kind: "leftover_redo", level: "warn", message: `${input.scenario.scenarioId}: written again from the start: ${leftoverReason(uses)}`, data: { steps: uses.map((u) => u.step) } });
                let again = await authorScenario({ ...input, redo });
                if (again.status === "complete" && input.review) again = await reviewAndFix({ ...input, redo }, again);
                // A second try that could not finish keeps the first test (still flagged: the caller saves it for review).
                if (again.status !== "blocked") out = again;
                if (findLeftoverUse(out.steps).length) return out;
            }
        }
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
/** Why a test was not written when the test writer replied without a tool call (no finish) while it still had steps left. */
export const WRITER_STOPPED = "The test writer stopped before finishing the test";
/** Why a test was not written when the test writer was still acting when its steps ran out. */
const STEP_BUDGET_SPENT = "Step budget exhausted before finishing";
/** The start of what the model is told about an action the exploration refused: it did not reach the application. */
const NOT_PERFORMED = "Not performed:";
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
    // The objective's step budget is shared by every pass of the scenario: a pass that finds it spent does not start (CP2 M-5).
    if (input.stepBudget && input.stepBudget.left <= 0) return { status: "blocked", steps: [], testData: {}, explanation: STEP_BUDGET_SPENT };
    input.gate?.freshPass(new URL(scenario.startPath || "/", baseUrl).href);
    const session = await BrowserSession.launch(browser, { startUrl: baseUrl, secrets: runSecretsOf(input), ...(input.notes?.length ? { notes: input.notes } : {}) });
    const { page } = session;
    page.setDefaultTimeout(6_000);
    /** The new tab the agent works in (a click opened it), else the page the test started on. */
    let tab: Page | undefined;
    const here = (): Page => (tab && !tab.isClosed() ? tab : page);
    /** What the app reported while the agent worked (console and page errors, failed requests): the evidence a bug verdict reads. */
    const evidence: string[] = [];

    const recorded: Step[] = [];
    /** Sourced checks that ran and failed (with what the page showed instead); the last one still failing ends a defect test. */
    const failedChecks: Array<{ step: Step; observed: string; at: number }> = [];
    const masks = observedTextSecrets(runSecretsOf(input));
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
        const run = async (step: Step): Promise<{ ok: boolean; error?: string; /** The whole message up to Playwright's call log (it holds what was received). */ full?: string }> => {
            try {
                await executeStep(page, step, data, baseUrl);
                await settle(here(), 1_500);
                return { ok: true };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { ok: false, error: msg.split("\n").slice(0, 4).join(" ").slice(0, 400), full: msg.split(/\n\s*Call log:/)[0]! };
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
                // Replayed steps reach the application too: the exploration's bound counts them like the model's own (CP2 M-5).
                const { description: _d, ...args } = step as Step & { description?: string };
                const read = READ_TOOLS.has(step.action);
                const target = input.gate ? await stepTarget(here(), step, data) : undefined;
                const verdict = input.gate?.before({ tool: step.action, args, url: here().url(), read, ...(target ? { target } : {}) });
                if (verdict && !verdict.allowed) {
                    return { status: "blocked", steps: recorded, testData, explanation: `Replay of previous steps was refused at "${describeStep(step)}": ${verdict.reason}` };
                }
                const r = await run(step);
                input.gate?.after({ tool: step.action, args, ok: r.ok, url: here().url(), read, ...(target ? { target } : {}) });
                if (!r.ok) {
                    return { status: "blocked", steps: recorded, testData, explanation: `Replay of previous steps failed at "${describeStep(step)}": ${r.error}` };
                }
                recorded.push(step);
            }
        }

        const refuse = refusedBy(input.notes);
        let notesShownFor = pathOf(page.url());
        const record = async (step: Step, toolName: string, args: unknown) => {
            // The browser crashed or went away: nothing more can be done in it, so the scenario ends here with that reason.
            const lost = session.lostReason({ pageClosedCounts: false });
            if (lost) {
                if (!outcome) {
                    outcome = { status: "blocked", steps: recorded, testData, explanation: `${lost}, so this test could not be finished.` };
                    ctx.emit({ stage: "generation", kind: "browser_crashed", level: "warn", message: `${scenario.scenarioId}: ${lost}` });
                }
                return { success: false, error: `${lost}.`, url: "" };
            }
            // A "never ..." note for this page is a hard rule: the control it names is not used.
            const loc = "locator" in step ? (step.locator as Locator | undefined) : undefined;
            const banned = step.action !== "assert" && loc ? refuse({ name: loc.value, url: here().url() }) : undefined;
            if (banned) {
                input.onAction?.({ tool: toolName, args, ok: false, observation: refusalText(banned) });
                return { success: false, error: `${refusalText(banned)} Do not use this control; find another way or finish.`, url: here().url() };
            }
            // Ended (the job was cancelled, or the exploration ended this pursuit): nothing more reaches the application, so the
            // calls the model made in the same reply after a refusal are not performed either.
            if (ctx.signal?.aborted) return { success: false, error: `${NOT_PERFORMED} This test writer's work was ended. Call finish.`, url: here().url() };
            // The exploration's bound is asked before the action runs (CP2 H-2), with the element it resolves to now (M-1).
            const read = READ_TOOLS.has(step.action);
            const target = input.gate ? await stepTarget(here(), step, data) : undefined;
            if (input.gate) {
                const verdict = input.gate.before({ tool: toolName, args, url: here().url(), read, ...(target ? { target } : {}) });
                if (!verdict.allowed) {
                    input.onAction?.({ tool: toolName, args, ok: false, observation: `${NOT_PERFORMED} ${verdict.reason}` });
                    return { success: false, error: `${NOT_PERFORMED} ${verdict.reason} Do not try it again; call finish.`, url: here().url() };
                }
            }
            // Working in a new tab: the step is recorded "in the popup" (the schema's popup support), as the script will run it.
            if (tab && !tab.isClosed() && POPUP_STEPS.has(step.action)) step = { ...step, inPopup: true } as Step;
            session.takeEvents();
            const r = await run(step);
            input.gate?.after({ tool: toolName, args, ok: r.ok, url: here().url(), read, ...(target ? { target } : {}) });
            await session.quiet();
            // A new tab whose page answers slowly is handed out late: waited for here, so the click that opened it is the one told and recorded.
            await session.newTab();
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
            if (step.action === "assert" && step.source) {
                // A sourced check that passed now is no failure to keep any more; one that failed is kept with what the page showed,
                // and with where it ran (the steps recorded by then), so a defect test ends there and not after later actions.
                const same = (s: Step) => JSON.stringify({ ...s, description: "" }) === JSON.stringify({ ...step, description: "" });
                for (let i = failedChecks.length - 1; i >= 0; i--) if (same(failedChecks[i]!.step)) failedChecks.splice(i, 1);
                if (!r.ok) failedChecks.push({ step: { ...step, description: step.description || describeStep(step) } as Step, observed: redactText(maskObservedText(r.full ?? r.error ?? "failed", masks, 400), 400), at: recorded.length });
            }
            input.onAction?.({ tool: toolName, args, ok: r.ok, observation: [r.ok ? `url=${here().url()}` : (r.error ?? "failed"), ...told.lines].join(" ") });
            // Arriving on another page: the notes for that page come with it, once.
            const at = pathOf(here().url());
            const pageNotes = at !== notesShownFor ? notesFor(input.notes, here().url()) : undefined;
            notesShownFor = at;
            return { success: r.ok, ...(r.error ? { error: r.error } : {}), ...(told.lines.length ? { happened: told.lines.join("\n") } : {}), url: here().url(), snapshot, ...(pageNotes ? { notes: pageNotes } : {}) };
        };

        const tools = inStartOrder({
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
                    "Verify something about the page (auto-retries ~6s). check: visible|hidden (locator or expected text), text (locator contains expected), exactText (whole text is expected), notText (does NOT contain expected), value, enabled, disabled, editable, checked, unchecked, focused, inViewport, count (expected number), url (current URL contains expected), urlPattern (expected like /orders/*), title, attribute (name + optional expected), class (expected class), css (name = property, expected = computed value), accessibleName, accessibleErrorMessage (a field's validation message), ariaSnapshot (target = the result list/table/summary; leave expected empty: its structure is captured, numbers and dates become patterns), remembered (target compared with a remembered value: name + compare equals|contains|greater|less). source: what this check proves - a rule's ref from the rules section, or expected:<n> for the scenario's n-th expected result. Passing assertions are recorded; a failing one is recorded only when it has a source, and then only if you finish with result=\"defect\": it becomes the test's last step, the check that shows the bug. A failing assertion without a source is not recorded.",
                inputSchema: z.object({
                    check: z.enum(AUTHOR_CHECKS),
                    target: LocatorSchema.optional(),
                    expected: z.union([z.string(), z.number()]).optional(),
                    name: z.string().max(100).optional().describe("attribute / css: the attribute or property; remembered: the remembered value's name"),
                    compare: z.enum(REMEMBER_COMPARE).optional(),
                    source: z.string().max(500).optional().describe("The rule's ref, or expected:<n> for the scenario's n-th expected result"),
                    why: z.string().optional(),
                }),
                execute: async ({ check, target: t, expected: given, name, compare, source: cited, why }) => {
                    let expected = given;
                    const refuse = (error: string) => {
                        input.onAction?.({ tool: "assert", args: { check, target: t, expected }, ok: false, observation: error });
                        return { success: false, error, url: page.url() };
                    };
                    // The source goes into the saved test as written: only a rule this scenario was given, or one of its expected results.
                    const source = cited?.trim() ? sourceOf(cited, scenario, input.rules) : undefined;
                    if (cited?.trim() && !source)
                        return refuse(`The source ${JSON.stringify(cited.slice(0, 100))} is not a rule given to this scenario nor one of its expected results (expected:1 to expected:${scenario.expectedResults.length}); use one of those, or leave source out.`);
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
                    const extra = { ...(name ? { name } : {}), ...(check === "remembered" ? { compare: compare ?? "equals" } : {}), ...(source ? { source } : {}) };
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
                description: "End the authoring session. A complete test sets up everything it checks with its own steps.",
                inputSchema: z.object({ result: z.enum(["complete", "defect", "blocked"]), explanation: z.string() }),
                execute: async ({ result, explanation }) => {
                    // A complete test must prove the outcome: pushed back (a bounded number of times) and the agent continues.
                    if (result === "complete" && !hasOutcomeAssertion(recorded) && pushbacks < OUTCOME_PUSHBACKS) {
                        pushbacks++;
                        input.onAction?.({ tool: "finish", args: { result }, ok: false, observation: NO_OUTCOME_HINT });
                        return { done: false, error: NO_OUTCOME_HINT };
                    }
                    if (result === "defect") {
                        // The last check of a STATED source still failing becomes the final step, where it ran: the saved test is the steps up
                        // to it, then the check (later steps are dropped, the defect shows there), so it fails while the bug is there. A failing
                        // check of the planner's own expected result is not kept: the defect is observed only (statedSource).
                        const kept = failedChecks.filter((c) => statedSource((c.step as { source: string }).source, scenario, input.rules, input.requirementIds)).at(-1);
                        outcome = {
                            status: result,
                            steps: kept ? [...recorded.slice(0, kept.at), kept.step] : [...recorded],
                            testData,
                            explanation,
                            ...(evidence.length ? { evidence: [...new Set(evidence)].slice(0, 15) } : {}),
                            capture: kept ? "captured" : "observed_only",
                            ...(kept ? { capturedCheck: { source: (kept.step as { source: string }).source, observed: kept.observed } } : {}),
                        };
                    } else outcome = { status: result, steps: [...recorded], testData, explanation };
                    return { done: true };
                },
            }),
        });

        const snapshot = await snapshotFor(9_000);
        const rulesNote = authoringRulesNote(input.rules);
        const prompt = `Scenario ${scenario.scenarioId}: ${scenario.title}
Description: ${scenario.description}
Category: ${scenario.category}   Type: ${scenario.type}
${preconditionsNote(scenario.preconditions)}
Required data: ${scenario.requiredData.join("; ") || "none"}
Expected results (assert ALL of them):
${scenario.expectedResults.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}
Test account: ${credentials ? "available as {{credentials.username}} / {{credentials.password}}" : "NOT available"}
${pageHint(model, scenario)}
${notesFor(input.notes, page.url()) ?? ""}${rulesNote ? `\n${rulesNote}` : ""}
${input.redo && !resume ? `A previous version of this test was not kept. ${input.redo}\nWrite the test again from the start.\n` : ""}${
    resume?.review
        ? `A review of this test against its scenario asked for these changes:\n${resume.failure}\nThe test's steps so far have been replayed (${resume.prefix.length - 1} steps). Continue from the current page state: apply the changes, then assert every expected result.\n`
        : resume
        ? `A previous version of this test FAILED when executed as a standalone script:\n${resume.failure}\nThe steps that already work have been replayed (${resume.prefix.length - 1} steps). Continue from the current page state with corrected steps so the scenario fully completes, and re-assert all expected results.\n`
        : ""
}Current page: ${page.url()}
Accessibility snapshot:
${snapshot}`;

        const generated = await generateText({
            model: ctx.llm.model,
            system: (input.vision ? SYSTEM + VISION_AUTHORING_NOTE : SYSTEM) + (input.testData ? TEST_DATA_AUTHORING_NOTE : "") + (view ? COMPACT_SNAPSHOT_NOTE : ""),
            prompt,
            tools,
            providerOptions: PROVIDER_OPTIONS,
            maxRetries: LLM_MAX_RETRIES,
            maxOutputTokens: AGENT_STEP_MAX_OUTPUT_TOKENS,
            // Ends when finish was accepted (a pushed-back finish lets the agent go on).
            stopWhen: [stepCountIs(Math.min(input.maxSteps ?? 28, input.stepBudget?.left ?? Infinity)), () => outcome !== undefined],
            // Each step's tokens, prompt-cache reads and writes included (the instructions, tools and earlier steps are cached: llm/prompt-cache.ts).
            onStepFinish: (e) => {
                if (input.stepBudget) input.stepBudget.left -= 1;
                addUsage(ctx.llm.usage, e.usage);
                view?.modelStep();
                // A fast model that keeps failing, repeats itself or makes no progress hands the rest of this scenario to the main model (llm/routing.ts).
                noteAgentStep(e);
            },
            abortSignal: ctx.signal,
        });
        if (view) ctx.emit(snapshotSavingsEvent(scenario.scenarioId, view.totals));

        const base: AuthorOutcome =
            outcome ?? {
                status: "blocked",
                steps: recorded,
                testData,
                // A last step that called tools means the writer was still at work when the steps ran out; any other ending (a plain reply) is the writer stopping.
                explanation: pushbacks ? NO_OUTCOME : generated.finishReason === "tool-calls" ? STEP_BUDGET_SPENT : WRITER_STOPPED,
            };
        const result: AuthorOutcome = observations.length ? { ...base, observations: [...observations] } : base;
        // A "complete" test must actually verify the scenario's outcome.
        if (result.status === "complete" && !hasOutcomeAssertion(result.steps)) {
            return { ...result, status: "blocked", explanation: NO_OUTCOME };
        }
        if (result.status === "complete" || result.status === "defect") {
            // Only a captured defect test may end on a failing check (the captured one, its last step); an observed-only one passed every step while authoring.
            const pruned = await pruneByReplay(browser, baseUrl, result.steps, credentials, result.status === "complete" || result.capture !== "captured", input.gate);
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

/** A blocked scenario keeps its authoring trace (masked with every secret the run knows) in the scratch folder; any other ending drops it. Never throws. */
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
        const clean = await scrubTraceFile(file, runSecretsOf(input));
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
 * that fail there. The pruned list is accepted only if every assertion still passes on the replay, so pruning can never hide a real
 * failure nor leave a check its dropped setup made pass. With `requireAllAssertsPass` false (a captured defect test) the one exception is
 * the final step, the captured failing check: it may fail (queue row 183: C1c's WEB-027 lost its setup steps and kept a check of an
 * alert nothing triggers). Otherwise the original steps are kept and normal validation/repair applies.
 */
export async function pruneByReplay(
    browser: Browser,
    baseUrl: string,
    steps: Step[],
    credentials: { username: string; password: string } | undefined,
    requireAllAssertsPass: boolean,
    /** The exploration's bound (CP2 M-5): the replay's steps are counted against the session's actions; refused, nothing is pruned. */
    gate?: Pick<ActionGate, "replay">,
): Promise<{ steps: Step[]; dropped: number }> {
    if (gate && !gate.replay(steps.length, "the replay that drops stale steps")) return { steps, dropped: 0 };
    const session = await BrowserSession.launch(browser, { startUrl: baseUrl, ...(credentials ? { secrets: [credentials.password] } : {}) });
    session.page.setDefaultTimeout(5_000);
    const data = runtimeData({}, credentials);
    const kept: Step[] = [];
    let dropped = 0;
    let assertFailed = false;
    try {
        for (const [i, step] of steps.entries()) {
            try {
                await executeStep(session.page, step, data, baseUrl, 5_000, { near: nearbyTargets(steps, i) });
                await settle(session.page, 1_500);
                kept.push(step);
            } catch {
                if (step.action === "assert") {
                    // A captured defect test is expected to fail on its final assertion (the captured check); any other failing assertion
                    // rejects the pruned list, as for a complete test.
                    assertFailed = true;
                    kept.push(step);
                    if (requireAllAssertsPass || i !== steps.length - 1) break;
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
