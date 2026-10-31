/**
 * The findings of the phone quality checks, in the platform's findings contract: a failed run whose message starts with one of the stable prefixes
 * below is an application finding (Needs a look), never a broken test and never "repaired"; `validation/validator.ts` asks `phoneQualityFinding`,
 * `validation/severity.ts` asks `phoneQualitySeverity`, the `ai-test` CLI files them by prefix.
 *
 * Also the markers a phone check test carries in its rendered script (`// phone-check: …`), so the mobile runner knows to measure the start-up
 * or check the screen at the end, wherever the script runs (this computer or a runner).
 */
import type { TestSpec } from "../../spec/schema.js";
import type { ScriptRun } from "../../validation/runner.js";
import { formatMs } from "./startup.js";
import type { AppCrash, ExploreCrash, PhoneQualityPlan, QualityTestKind, ScreenA11y, StartupMeasure } from "./types.js";

export const PHONE_CRASH_PREFIX = "The app crashed: ";
export const PHONE_ANR_PREFIX = "The app stopped responding: ";
export const PHONE_SLOW_START_PREFIX = "Slow start-up: ";
export const PHONE_A11Y_PREFIX = "Phone accessibility: ";
export const PHONE_QUALITY_PREFIXES = [PHONE_CRASH_PREFIX, PHONE_ANR_PREFIX, PHONE_SLOW_START_PREFIX, PHONE_A11Y_PREFIX] as const;

export const PHONE_CRASH_BASIS = "the app crashed or stopped responding on the phone";
export const PHONE_START_BASIS = "the app starts slower than the project's budget";
export const PHONE_A11Y_BASIS = "phone screen accessibility";

/** Tags of the check tests the plan creates. */
export const TAG_CRASH = "phone-crash";
export const TAG_STARTUP = "phone-check-startup";
export const TAG_A11Y = "phone-check-a11y";
const BUDGET_TAG = /^startup-budget:(\d{3,5})$/;
export const budgetTag = (ms: number): string => `startup-budget:${Math.round(ms)}`;

const MAX_REASON = 3000;

/** The first line of a crash finding: "The app crashed: java.lang.IllegalStateException: Cart is null". */
export function crashHeadline(c: AppCrash): string {
    return `${c.kind === "anr" ? PHONE_ANR_PREFIX : PHONE_CRASH_PREFIX}${c.exception}`.slice(0, 300);
}

/** The finding text of a crash: headline, where it happened, the steps, the stack (each part already cleaned and capped). */
export function crashReason(c: AppCrash, extra: { where?: string; screenBefore?: string; steps?: readonly string[]; seenWhile?: string } = {}): string {
    const parts = [crashHeadline(c)];
    if (extra.seenWhile) parts.push(extra.seenWhile);
    if (extra.where) parts.push(`Where: ${extra.where}`);
    if (extra.screenBefore) parts.push(`Screen before it: ${extra.screenBefore}`);
    if (extra.steps?.length) parts.push(`Steps that led to it:\n${extra.steps.slice(-15).map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
    if (c.stack.length) parts.push(`${c.kind === "anr" ? "Details" : "Stack trace"} (cut):\n${c.stack.map((l) => `  ${l}`).join("\n")}`);
    if (c.package) parts.push(`Process: ${c.package}`);
    return cap(parts.join("\n"));
}

export function exploreCrashReason(x: ExploreCrash): string {
    return crashReason(x.crash, {
        seenWhile: "Seen while the AI explored the app. Run this test to check it again: it repeats the same steps on the phone.",
        where: `on “${x.screen.title}”`,
        screenBefore: `“${x.screen.title}”${x.screen.texts.length ? `, showing ${x.screen.texts.map((t) => `“${t}”`).join(", ")}` : ""}`,
        steps: x.steps,
    });
}

export function slowStartReason(m: StartupMeasure, budgetMs: number, seenWhile?: string): string {
    const lines = [`${PHONE_SLOW_START_PREFIX}the app took ${formatMs(m.totalMs)} to show its first screen from a cold start; the budget is ${formatMs(budgetMs)}.`];
    if (seenWhile) lines.push(seenWhile);
    lines.push(`Measured by Android (am start -W): TotalTime ${m.totalMs} ms${m.waitMs !== undefined ? `, WaitTime ${m.waitMs} ms` : ""}${m.launchState ? `, ${m.launchState.toLowerCase()} start` : ""}.`);
    return lines.join("\n");
}

export function a11yReason(r: ScreenA11y, seenWhile?: string): string {
    const n = r.issues.length;
    const lines = [`${PHONE_A11Y_PREFIX}${n} problem${n === 1 ? "" : "s"} on “${r.title}”.`];
    if (seenWhile) lines.push(seenWhile);
    for (const i of r.issues) lines.push(`- [${i.severity}] ${i.message}`);
    if (r.densityAssumed) lines.push("Sizes in dp are estimated: the phone did not report its screen density.");
    return cap(lines.join("\n"));
}

const cap = (s: string) => (s.length > MAX_REASON ? `${s.slice(0, MAX_REASON - 1)}…` : s);

/** The finding a failed phone run proves by itself (a crash, a freeze, a slow start, accessibility problems), or undefined. */
export function phoneQualityFinding(spec: Pick<TestSpec, "kind">, run: Pick<ScriptRun, "status" | "error">): string | undefined {
    if (spec.kind !== "mobile" || run.status === "passed" || !run.error) return undefined;
    return PHONE_QUALITY_PREFIXES.some((p) => run.error!.startsWith(p)) ? cap(run.error) : undefined;
}

/** The severity of a phone quality finding from its reason, or undefined when the reason is not one. */
export function phoneQualitySeverity(reason: string): { severity: "high" | "medium" | "low"; basis: string } | undefined {
    if (reason.startsWith(PHONE_CRASH_PREFIX) || reason.startsWith(PHONE_ANR_PREFIX)) return { severity: "high", basis: PHONE_CRASH_BASIS };
    if (reason.startsWith(PHONE_SLOW_START_PREFIX)) return { severity: "medium", basis: PHONE_START_BASIS };
    if (reason.startsWith(PHONE_A11Y_PREFIX)) return { severity: /^- \[medium\]/m.test(reason) ? "medium" : "low", basis: PHONE_A11Y_BASIS };
    return undefined;
}

/** How many check tests of each kind creating the plan makes (accessibility only when it is switched on). */
export function qualityCounts(q: PhoneQualityPlan | undefined, o: { accessibility: boolean }): Record<QualityTestKind, number> {
    const t = q?.tests ?? [];
    return { crash: t.filter((x) => x.kind === "crash").length, startup: t.filter((x) => x.kind === "startup").length, accessibility: o.accessibility ? t.filter((x) => x.kind === "accessibility").length : 0 };
}

// ── markers in rendered scripts ─────────────────────────────────────────────

export interface PhoneChecks {
    accessibility: boolean;
    /** A start-up check, with the budget written into the test when it was created (absent: the project's or the default budget). */
    startup?: { budgetMs?: number };
}

/** The marker lines the Taqwright generator adds for a phone check test ("" for every other test, so their scripts stay as they were). */
export function phoneCheckMarker(spec: Pick<TestSpec, "kind" | "tags">): string {
    if (spec.kind !== "mobile") return "";
    const lines: string[] = [];
    if (spec.tags.includes(TAG_STARTUP)) {
        const budget = spec.tags.map((t) => BUDGET_TAG.exec(t)?.[1]).find(Boolean);
        lines.push(`// phone-check: start-up${budget ? ` budget=${budget}` : ""}`);
    }
    if (spec.tags.includes(TAG_A11Y)) lines.push("// phone-check: accessibility");
    return lines.length ? `\n${lines.join("\n")}` : "";
}

/** The checks a rendered script asks the mobile runner for (read from its marker lines only). */
export function phoneChecksOf(content: string): PhoneChecks {
    const head = content.slice(0, 2000);
    const start = /^\/\/ phone-check: start-up(?: budget=(\d{3,5}))?\s*$/m.exec(head);
    return { accessibility: /^\/\/ phone-check: accessibility\s*$/m.test(head), ...(start ? { startup: start[1] ? { budgetMs: Number(start[1]) } : {} } : {}) };
}
