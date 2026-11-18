/**
 * A written test case as the AI script writers read it: its title as a test's title, and what it says as a data block for a model
 * (case-phone-script.ts for Android). A web case is not written here: it is built in a real browser against the application, as
 * Test scripts, Describe it builds a test (platform/case-scripts.ts), so its checks are what the application shows.
 *
 * The case is untrusted text (a person or the AI wrote it): it goes to the model as data between markers.
 */

/** Cases turned into scripts by one request. */
export const MAX_SCRIPTS_PER_CALL = 20;
/** Text of one case sent to the model. */
const MAX_CASE_CHARS = 6000;

export const NO_MODEL_FOR_SCRIPTS =
    "The AI model isn’t set up yet. Writing test scripts from test cases needs access to an AI model. Add your own AI key in Settings, AI keys, or ask an admin to assign one, then try again. You can still write test scripts by hand.";

export interface CaseForScript {
    ref: string;
    title: string;
    area: string;
    priority: string;
    steps: Array<{ action: string; expected: string }>;
    /** The requirement the case comes from, in words, when it has one. */
    requirement: string;
    /** The references of the requirements the case comes from (REQ-01...), kept on a phone script's spec. */
    requirementRefs?: string[];
}

/** The shortest title a test may have (TestSpecSchema). */
const MIN_TITLE = 3;
/**
 * The title a script made from this case gets: the case's own title, or, when that is shorter than a test's title may be (a case title
 * may be one character), the case's reference before it ("TC-004: Go"). Set in code before the AI is asked, so the AI is never asked to
 * fix it.
 */
export function scriptTitleOf(c: Pick<CaseForScript, "ref" | "title">): string {
    const t = c.title.trim();
    if (t.length >= MIN_TITLE) return t;
    const ref = c.ref.trim();
    const named = ref && t ? `${ref}: ${t}` : ref || t;
    return named.length >= MIN_TITLE ? named : `Test case ${named}`.trim();
}

/** The markers around data in the prompts, taken out of the data itself so a case (or the model's own text) cannot end its block early. */
const MARKER = /<<<\s*(?:CASE|SCRIPT|PAGES)|(?:CASE|SCRIPT|PAGES)\s*>>>/gi;
export function unmarked(s: string): string {
    // Again until nothing changes: taking one marker out must not join the pieces around it into another.
    for (let cur = s; ; ) {
        const next = cur.replace(MARKER, "");
        if (next === cur) return cur;
        cur = next;
    }
}

/** What the case says, as the data block's text: its reference, title, area, priority, requirement and steps, markers taken out, capped. */
export function caseData(c: CaseForScript): string {
    const steps = c.steps.map((s, i) => `${i + 1}. ${s.action}${s.expected ? `\n   Expected: ${s.expected}` : ""}`).join("\n");
    return unmarked(
        [`Case: ${c.ref}`, `Title: ${c.title.replace(/"/g, "'")}`, `Area: ${c.area.replace(/"/g, "'") || "Test cases"}`, `Priority: ${c.priority}`, c.requirement ? `Requirement: ${c.requirement}` : "", "Steps:", steps || "(none written)"].filter(Boolean).join("\n"),
    ).slice(0, MAX_CASE_CHARS);
}
