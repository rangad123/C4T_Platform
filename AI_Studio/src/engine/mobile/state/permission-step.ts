/**
 * Permission questions as test steps.
 *
 * When the AI explorer answered a system permission question ("Allow Shop to send you notifications?"), a test written from that exploration starts with
 * a step that gives the same answer IF the question shows, and goes on when it does not: whether Android asks again depends on the phone's history (a
 * fresh install or cleared data asks, a phone that already answered does not), so the step can never fail a test.
 *
 * The step is an ordinary `press` with the device key `device:permission` and the answer's button as its element (by its visible text), so it needs no
 * new step kind: the Taqwright generator renders it, the text format has a phrase for it, and its title (the step description) reads
 * `Allow "send you notifications" when asked` or `Don't allow "…" when asked`.
 */
import type { Step } from "../../spec/schema.js";
import type { ScreenElement, ScreenSnapshot } from "../device/types.js";
import { permissionWords } from "../explore/safety.js";
import { cleanAppText } from "../explore/text.js";

/** The device key of the step. */
export const PERMISSION_KEY = "device:permission";
/** How long a written test looks for the question before going on without it. */
export const PERMISSION_WAIT_MS = 3000;
/** Most permission steps a test starts with (an app that asks more on its first start is unusual; the rest is left to the explorer's notes). */
export const MAX_PERMISSION_STEPS = 3;

/** One answered question, as the exploration keeps it. */
export interface PermissionAnswer {
    /** What the app asked for, in its own words, cleaned and short ("send you notifications"). */
    question: string;
    /** The button the explorer tapped ("Don't allow", "Allow", "While using the app"). */
    choice: string;
    allowed: boolean;
}

/** "Allow Shop to send you notifications?" reads as "send you notifications"; a question in another shape is kept whole (cleaned, cut). */
export function questionOf(message: string): string {
    const clean = cleanAppText(message, 120).replace(/[?？]\s*$/, "").trim();
    const m = /^allow\s+.+?\s+to\s+(.+)$/i.exec(clean);
    return cleanAppText((m?.[1] ?? clean).trim(), 60) || "this permission";
}

/** The answer the explorer gave on a permission dialog `snap` by tapping `el`; undefined when there is nothing to keep (no button text). */
export function permissionAnswerOf(snap: ScreenSnapshot, el: Pick<ScreenElement, "text" | "desc" | "index">): PermissionAnswer | undefined {
    const choice = cleanAppText(el.text || el.desc, 40);
    if (!choice) return undefined;
    // The question is the longest text on the dialog that is not one of its buttons.
    const message = snap.elements.filter((e) => !e.clickable && e.index !== el.index && (e.text || e.desc)).map((e) => e.text || e.desc).sort((a, b) => b.length - a.length)[0] ?? "";
    const allowed = !permissionWords.deny.test(choice);
    return { question: questionOf(message), choice, allowed };
}

/** Adds an answer to the list once (the same question answered again is the same step). */
export function rememberAnswer(list: PermissionAnswer[], a: PermissionAnswer | undefined): void {
    if (!a || list.length >= MAX_PERMISSION_STEPS * 2) return;
    if (!list.some((x) => x.question === a.question && x.choice === a.choice)) list.push(a);
}

/** The step title a person reads. */
export function permissionTitle(a: Pick<PermissionAnswer, "question" | "allowed">): string {
    return `${a.allowed ? "Allow" : "Don't allow"} "${a.question.replace(/"/g, "'")}" when asked`;
}

/** The steps a test starts with: one per distinct question, at most three. */
export function permissionSteps(answers: readonly PermissionAnswer[] | undefined): Step[] {
    const out: Step[] = [];
    const seen = new Set<string>();
    for (const a of answers ?? []) {
        if (out.length >= MAX_PERMISSION_STEPS || seen.has(a.question)) continue;
        seen.add(a.question);
        out.push({ action: "press", key: PERMISSION_KEY, locator: { by: "text", value: a.choice }, description: permissionTitle(a) } as Step);
    }
    return out;
}

export function isPermissionStep(step: Step): boolean {
    return step.action === "press" && step.key === PERMISSION_KEY;
}

/**
 * The Taqwright code of the step, given the rendered locator of the answer button: wait a little for the question, tap the answer when it is there,
 * go on when it is not. A tap that fails because the dialog went away by itself is not a failure either.
 */
export function renderPermissionStep(locatorExpr: string): string {
    const tries = Math.round(PERMISSION_WAIT_MS / 500);
    return [
        "// A permission question shows only on some starts (a fresh install, cleared data): give the same answer when it shows, go on when it does not.",
        `const answer = ${locatorExpr};`,
        `for (let i = 0; i < ${tries} && !(await answer.isVisible().catch(() => false)); i++) await mobile.waitForTimeout(500);`,
        "if (await answer.isVisible().catch(() => false)) await answer.click().catch(() => undefined);",
    ].join("\n        ");
}
