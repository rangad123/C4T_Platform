/**
 * Self-healing locators, deterministic and model-free.
 *
 * When a web test fails because an element could not be found, open the page at that step in a real browser (the steps before
 * it are replayed with the live interpreter, as repair does), look at what the page offers now and, if exactly one element
 * clearly stands for the old locator, describe it as a PROPOSAL. Nothing is changed here: applying a proposal is a person's
 * decision (see platform/routes/healing.ts).
 *
 * EXTENSION POINT: `proposeHeal` is where a model-based fallback would go (for example, "ask a model to choose among these
 * candidates") when the ranking finds nothing. It is deliberately absent: the heal must stay free, repeatable and testable,
 * and a model that picks an element makes it easier to heal a real defect by accident.
 */
import type { Browser, Page } from "playwright";
import { BrowserSession, settle } from "../discovery/browser.js";
import { executeStep, locate, runtimeData, type RuntimeData } from "../web/interpreter.js";
import type { Locator, Step, TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "../validation/runner.js";
import { COLLECT_SOURCE, MARKER, type Candidate } from "./candidates.js";
import { eligibility } from "./failure.js";
import { confidenceLabel, describeLocator, rank, whyPicked, type Confidence } from "./rank.js";

export interface HealProposal {
    stepIndex: number;
    oldLocator: Locator;
    newLocator: Locator;
    /** 0..1: how sure the ranking is that this is the same control. */
    confidence: number;
    confidenceLabel: Confidence;
    /** Plain-language explanation shown to the person who approves it. */
    reason: string;
    /** "the “Add to cart” button" */
    oldDescription: string;
    newDescription: string;
}

export type HealResult = { status: "proposed"; proposal: HealProposal } | { status: "none"; reason: string };

export interface HealInput {
    browser: Browser;
    baseUrl: string;
    spec: TestSpec;
    run: ScriptRun;
    credentials?: { username: string; password: string; totpSecret?: string };
}

/** Steps that change the page and are therefore replayed to reach the failing step. Checks are not repeated. */
const REPLAYED = new Set<Step["action"]>(["navigate", "click", "fill", "select", "check", "press", "hover", "wait", "upload", "drag", "dialog", "remember", "clock", "condition"]);
const STEP_TIMEOUT = 6_000;
const OVERALL_TIMEOUT = 90_000;

const none = (reason: string): HealResult => ({ status: "none", reason });

/** Locators that could stand for `cand`, best first. The first one that finds exactly this element wins. */
export function locatorOptions(old: Locator, c: Candidate): Locator[] {
    const usable = (s: string | null | undefined): s is string => Boolean(s) && !s!.includes("{{") && s!.length < 200;
    const byRole: Locator[] = c.role && usable(c.name) ? [{ by: "role", role: c.role, value: c.name, exact: true }] : [];
    const byTestId: Locator[] = usable(c.testId) ? [{ by: "testId", value: c.testId }] : [];
    switch (old.by) {
        case "role":
            return [...byRole, ...byTestId];
        case "text":
            return [...(usable(c.text) ? [{ by: "text", value: c.text, exact: true } as Locator] : []), ...byRole, ...byTestId];
        case "label":
            return [...(usable(c.label) ? [{ by: "label", value: c.label, exact: true } as Locator] : []), ...byRole, ...byTestId];
        case "placeholder":
            return [...(usable(c.placeholder) ? [{ by: "placeholder", value: c.placeholder, exact: true } as Locator] : []), ...byRole, ...byTestId];
        case "testId":
            return [...byTestId, ...byRole];
        case "css":
            return [...byTestId, ...(c.id && /^[\w-]+$/.test(c.id) ? [{ by: "css", value: `#${c.id}` } as Locator] : []), ...byRole];
        // An image by its alt text, an element by its title: the page names them for people, so the accessible name is the replacement.
        case "altText":
        case "title":
            return [...byRole, ...byTestId];
    }
}

/** The first option that Playwright resolves to exactly the candidate element. */
async function verified(page: Page, options: Locator[], c: Candidate, data: RuntimeData): Promise<Locator | undefined> {
    for (const option of options) {
        try {
            const loc = locate(page, option, data);
            if ((await loc.count()) !== 1) continue;
            if ((await loc.getAttribute(MARKER, { timeout: 2_000 })) === String(c.key)) return option;
        } catch {
            /* this option cannot be used; try the next */
        }
    }
    return undefined;
}

async function heal(input: HealInput): Promise<HealResult> {
    const { spec, run } = input;
    const eligible = eligibility(spec, run);
    if (!eligible.ok) return none(eligible.reason);
    const { stepIndex, step, locator: old } = eligible.target;

    const session = await BrowserSession.launch(input.browser, { startUrl: input.baseUrl });
    try {
        const { page } = session;
        page.setDefaultTimeout(STEP_TIMEOUT);
        const data = runtimeData(spec.testData, input.credentials);
        for (const prior of spec.steps.slice(0, stepIndex)) {
            if (!REPLAYED.has(prior.action)) continue;
            try {
                await executeStep(page, prior, data, input.baseUrl, STEP_TIMEOUT);
            } catch {
                return none("the steps before the failing one could not be repeated, so the page could not be examined");
            }
        }
        await settle(page);

        // The element must really be absent now; if it is there but unusable (hidden, disabled), renaming is not the problem.
        if ((await locate(page, old, data).count()) > 0) return none("the element is on the page, so it is not missing");

        const all = (await page.evaluate(COLLECT_SOURCE)) as Candidate[];
        const interactive = step.action !== "assert" && step.action !== "hover";
        const candidates = interactive ? all.filter((c) => !c.disabled) : all;
        const ranking = rank(old, step.action, candidates);
        if (ranking.status === "ambiguous") {
            const names = ranking.options.map((o) => `“${o.cand.name || o.cand.text || o.cand.testId || o.cand.tag}”`).join(", ");
            return none(`${ranking.options.length} elements look like a match (${names}); guessing would risk testing the wrong one`);
        }
        if (ranking.status === "none") return none("nothing on the page is a close enough match");

        const best = ranking.best;
        const newLocator = await verified(page, locatorOptions(old, best.cand), best.cand, data);
        if (!newLocator) return none("the matching element cannot be described by a locator that finds only it");

        // The expectation of a check never changes. It has to hold for the element we would point it at, as it stands now;
        // if it does not, the application is what is different and this stays a finding.
        if (step.action === "assert") {
            try {
                await executeStep(page, { ...step, locator: newLocator }, data, input.baseUrl, 2_500);
            } catch {
                return none("a similar element exists, but the check still fails on it: that is a result about the application, not a broken locator");
            }
        }
        return {
            status: "proposed",
            proposal: {
                stepIndex,
                oldLocator: old,
                newLocator,
                confidence: Math.round(best.score * 100) / 100,
                confidenceLabel: confidenceLabel(best.score),
                reason: whyPicked(old, best),
                oldDescription: describeLocator(old),
                newDescription: describeLocator(newLocator),
            },
        };
    } finally {
        await session.close();
    }
}

/** Never throws and never takes longer than a minute and a half: a failed analysis only means "no proposal". */
export async function proposeHeal(input: HealInput): Promise<HealResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            heal(input),
            new Promise<HealResult>((resolve) => {
                timer = setTimeout(() => resolve(none("the analysis took too long")), OVERALL_TIMEOUT);
            }),
        ]);
    } catch (err) {
        return none(`the page could not be examined (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    } finally {
        clearTimeout(timer);
    }
}
