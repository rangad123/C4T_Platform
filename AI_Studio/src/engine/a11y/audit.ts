/**
 * Accessibility audit (axe-core via @axe-core/playwright, MPL-2.0) shared by the live interpreter
 * and the a11y finding classifier. The rendered Playwright script carries its own self-contained
 * copy of the same logic (../generators/playwright.ts `A11Y_HELPER`); tests assert both produce
 * the same failure message.
 *
 * Semantics of `assert check:"a11y"`:
 *  - rules: WCAG 2.0 / 2.1, levels A + AA (axe tags below); best-practice rules are not run.
 *  - `expected` = minimum impact that fails: minor < moderate < serious (default) < critical.
 *  - `locator` scopes the audit: css (without nth) is passed to axe `.include()` as-is; any other
 *    strategy is resolved by Playwright and the matched element is tagged with a temporary
 *    data attribute that axe then includes (axe only understands CSS selectors).
 */
// @axe-core/playwright is loaded when an audit runs, not when this file is: the runner program (which bundles this file) must start without
// its test tools installed, so "node runner.mjs --check" can still say what is missing (docs/features/runner-check.md).
import type { Locator as PwLocator, Page } from "@playwright/test";

export const A11Y_IMPACTS = ["minor", "moderate", "serious", "critical"] as const;
export type A11yImpact = (typeof A11Y_IMPACTS)[number];

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

/** First words of every a11y-violation failure; a11yFinding keys on it. */
export const A11Y_FAILURE_PREFIX = "Accessibility audit failed:";

/** Rules / targets kept in the message: it is shown to users and the runner truncates step errors at 800 chars. */
export const A11Y_MAX_RULES = 5;
export const A11Y_MAX_TARGETS = 3;

/** Normalise a spec's `expected` into a threshold; anything unrecognised falls back to "serious". */
export function a11yThreshold(expected: string | number | undefined): A11yImpact {
    const v = String(expected ?? "").trim().toLowerCase();
    return (A11Y_IMPACTS as readonly string[]).includes(v) ? (v as A11yImpact) : "serious";
}

/** Structural subset of axe's Result we rely on. */
export interface A11yViolationLike {
    id: string;
    impact?: string | null;
    help: string;
    nodes: Array<{ target: unknown[] }>;
}

const rank = (impact: string | null | undefined): number => Math.max(0, (A11Y_IMPACTS as readonly string[]).indexOf(impact ?? "minor"));
const clip = (s: string, n: number): string => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 3) + "..." : t;
};

/**
 * Compact, human-readable failure message for the violations at or above `minImpact`, or
 * undefined when none qualify. One line per rule: id, impact, help text, node count, first targets.
 */
export function formatA11yViolations(violations: A11yViolationLike[], minImpact: A11yImpact): string | undefined {
    const failing = violations.filter((v) => rank(v.impact) >= rank(minImpact)).sort((a, b) => rank(b.impact) - rank(a.impact));
    if (failing.length === 0) return undefined;
    const lines = failing.slice(0, A11Y_MAX_RULES).map((v) => {
        const targets = v.nodes
            .slice(0, A11Y_MAX_TARGETS)
            .map((n) => clip(n.target.map((t) => (Array.isArray(t) ? t.join(" >> ") : String(t))).join(" >> "), 60));
        const more = v.nodes.length > A11Y_MAX_TARGETS ? ", ..." : "";
        const count = `${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}`;
        return `- ${v.id} [${v.impact ?? "minor"}]: ${clip(v.help, 100)} (${count}: ${targets.join(", ")}${more})`;
    });
    if (failing.length > A11Y_MAX_RULES) lines.push(`- ...and ${failing.length - A11Y_MAX_RULES} more rule(s)`);
    const n = failing.length;
    return `${A11Y_FAILURE_PREFIX} ${n} WCAG rule${n === 1 ? "" : "s"} violated at "${minImpact}" impact or above\n${lines.join("\n")}`;
}

/**
 * Run the audit on a live page and throw the formatted message on failure. `scope` is a CSS
 * selector (passed to axe as-is) or a Playwright locator (tagged, then included).
 */
export async function runA11yAudit(page: Page, minImpact: A11yImpact, scope?: string | PwLocator, timeout = 8_000): Promise<void> {
    // The interpreter navigates with waitUntil "domcontentloaded"; audit the fully loaded page like the script does.
    await page.waitForLoadState("load", { timeout }).catch(() => undefined);
    const { AxeBuilder } = await import("@axe-core/playwright");
    const builder = new AxeBuilder({ page }).withTags([...WCAG_TAGS]);
    if (typeof scope === "string") {
        await page.locator(scope).first().waitFor({ state: "attached", timeout });
        builder.include(scope);
    } else if (scope) {
        const mark = `a11y-${Math.random().toString(36).slice(2, 10)}`;
        await scope.first().evaluate((el, m) => el.setAttribute("data-a11y-scope", m), mark, { timeout });
        builder.include(`[data-a11y-scope="${mark}"]`);
    }
    const results = await builder.analyze();
    const message = formatA11yViolations(results.violations, minImpact);
    if (message) throw new Error(message);
}
