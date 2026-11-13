/**
 * What a Windows desktop spec may contain. The canonical spec schema stays general (a desktop spec is an ordinary spec of kind
 * `desktop` with a `desktop` target); this file adds the rules that only make sense for desktop tests, so an import can say
 * exactly what is wrong in plain words.
 *
 * Vocabulary (documented in docs/features/windows-desktop-tests.md):
 *   launchApp                      start the application of the spec's `desktop` target (must be the first step, once)
 *   click / fill / select / check  act on an element through its UI Automation patterns (Invoke, Value, SelectionItem, Toggle)
 *   wait                           pause, at most 10 s
 *   assert visible | hidden | text | value | enabled | disabled | count
 *   closeApp                       close the application (must be the last step if present; the test closes it anyway)
 * Elements are located by `testId` (the UI Automation id), `label` or `text` (the element's name) and `role` (the control
 * type, which can also narrow the other two). Not allowed: css/placeholder locators, navigate, press, hover, request steps
 * and the page-oriented assertions (url, title, a11y, screenshot, health, ...).
 */
import type { Locator, Step, TestSpec } from "../spec/schema.js";
import { webOnlyProblem } from "../web/checks.js";
import { controlTypeOf, DESKTOP_CONTROL_TYPES, DesktopTargetSchema } from "./target.js";

/** The `assert` checks a desktop test understands. */
export const DESKTOP_ASSERTS = ["visible", "hidden", "text", "value", "enabled", "disabled", "count"] as const;

const WHY: Partial<Record<Step["action"], string>> = {
    navigate: "Desktop tests don't open web addresses",
    press: "Pressing keys would need keyboard input, which desktop tests never use",
    hover: "Hovering would need mouse input, which desktop tests never use",
    request: "API requests belong in API tests",
    assertResponse: "API checks belong in API tests",
};

function locatorProblem(l: Locator): string | undefined {
    if (l.by === "css" || l.by === "placeholder") return `Desktop tests can't locate elements by ${l.by}. Use testId (the automation id), label or text (the element's name) or role (the control type).`;
    if (l.by === "role") {
        if (!controlTypeOf(l.role)) return `"${l.role ?? ""}" isn't a control type. Use one of: ${DESKTOP_CONTROL_TYPES.join(", ")}.`;
        return undefined;
    }
    if (l.value === undefined || l.value === "") return "A locator needs a value (the automation id or the element's name).";
    if (l.role !== undefined && !controlTypeOf(l.role)) return `"${l.role}" isn't a control type. Use one of: ${DESKTOP_CONTROL_TYPES.join(", ")}.`;
    return undefined;
}

/** Plain-word problems that make a spec unusable as a desktop test. Empty = fine. A non-desktop spec is not checked here. */
export function desktopSpecIssues(spec: Pick<TestSpec, "kind" | "steps"> & { desktop?: unknown }): string[] {
    const out: string[] = [];
    if (spec.kind !== "desktop") {
        if (spec.desktop !== undefined) out.push("Only desktop tests have a desktop target.");
        return out;
    }
    if (spec.desktop === undefined) {
        out.push("A desktop test needs a desktop target: { app, windowTitle?, args?, startTimeoutMs? }.");
    } else {
        const r = DesktopTargetSchema.safeParse(spec.desktop);
        if (!r.success) for (const i of r.error.issues) out.push(`${i.path.length ? `desktop.${i.path.join(".")}: ` : ""}${i.message}`);
    }
    const launches = spec.steps.map((s, i) => (s.action === "launchApp" ? i : -1)).filter((i) => i >= 0);
    if (spec.steps[0]?.action !== "launchApp") out.push("A desktop test must start with a launchApp step.");
    if (launches.length > 1) out.push("A desktop test starts its application once: use a single launchApp step.");
    const closes = spec.steps.map((s, i) => (s.action === "closeApp" ? i : -1)).filter((i) => i >= 0);
    if (closes.length > 1 || (closes.length === 1 && closes[0] !== spec.steps.length - 1)) out.push("closeApp can only be the last step, and only once (the test closes the application at the end anyway).");
    spec.steps.forEach((s, i) => {
        const n = i + 1;
        const bad = (m: string) => out.push(`Step ${n}: ${m}`);
        if (WHY[s.action]) return bad(`${WHY[s.action]}.`);
        const webOnly = webOnlyProblem(s);
        if (webOnly) return bad(`${webOnly}.`);
        if (s.action === "click" || s.action === "fill" || s.action === "select" || s.action === "check") {
            const p = locatorProblem(s.locator);
            if (p) bad(p);
        } else if (s.action === "assert") {
            if (!(DESKTOP_ASSERTS as readonly string[]).includes(s.check)) return bad(`"${s.check}" checks a web page. Desktop tests can check: ${DESKTOP_ASSERTS.join(", ")}.`);
            if (!s.locator) return bad("Name the element to check (a locator).");
            const p = locatorProblem(s.locator);
            if (p) bad(p);
            // An empty expected value is a fair question for "value" (is the box empty?) but means nothing for "text" or "count".
            if ((s.check === "text" || s.check === "count") && (s.expected === undefined || s.expected === "")) bad(`"${s.check}" needs an expected value.`);
            if (s.check === "value" && s.expected === undefined) bad('"value" needs an expected value (use "" for an empty box).');
            if (s.check === "count" && !/^\d+$/.test(String(s.expected))) bad('"count" needs a whole number.');
        }
    });
    return out;
}

const nameOf = (l: Locator): string => (l.value ? `"${l.value}"` : "");

/** "the button named "Add"" / "the element with automation id "btnAdd"": the plain-words name of a desktop locator. */
export function describeDesktopLocator(l: Locator): string {
    const type = controlTypeOf(l.role)?.toLowerCase();
    if (l.by === "testId") return `the ${type ?? "element"} with automation id ${nameOf(l)}`;
    return `the ${type ?? "element"}${l.value ? ` named ${nameOf(l)}` : ""}`;
}

/** One plain sentence for a desktop step (used when the spec gives no description). */
export function describeDesktopStep(step: Step): string | undefined {
    if (step.description) return step.description;
    switch (step.action) {
        case "launchApp":
            return "Start the application";
        case "closeApp":
            return "Close the application";
        case "click":
            return `Click ${describeDesktopLocator(step.locator)}`;
        case "fill":
            return `Enter "${step.value}" into ${describeDesktopLocator(step.locator)}`;
        case "select":
            return `Choose "${step.value}" in ${describeDesktopLocator(step.locator)}`;
        case "check":
            return `${step.checked ? "Check" : "Uncheck"} ${describeDesktopLocator(step.locator)}`;
        case "wait":
            return `Wait ${step.ms} ms`;
        case "assert": {
            const who = step.locator ? describeDesktopLocator(step.locator) : "the element";
            switch (step.check) {
                case "visible":
                    return `Check that ${who} is visible`;
                case "hidden":
                    return `Check that ${who} is not visible`;
                case "text":
                    return `Check that ${who} contains "${step.expected ?? ""}"`;
                case "value":
                    return `Check that ${who} has the value "${step.expected ?? ""}"`;
                case "enabled":
                    return `Check that ${who} is enabled`;
                case "disabled":
                    return `Check that ${who} is disabled`;
                case "count":
                    return `Check that there ${Number(step.expected) === 1 ? "is" : "are"} ${step.expected} of ${who}`;
            }
            return undefined;
        }
        default:
            return undefined;
    }
}
