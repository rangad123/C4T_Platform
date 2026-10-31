/**
 * Spec → Taqwright (Appium) mobile test.
 *
 * Taqwright (Apache-2.0, https://github.com/taqelah/taqwright) deliberately mirrors Playwright's
 * `getBy*` / `expect` vocabulary, so the same canonical locators render to it with `mobile`
 * instead of `page`. Taqwright is consumed as an npm dependency of the *generated* project
 * (`@taqwright/taqwright`); none of its source is copied here.
 *
 * Scripts are executed by validation/mobile-runner.ts on an Android emulator when the platform has an
 * Android toolchain and the project has an app to test; otherwise they stay PENDING (never "passed").
 */
import { describeStep, type LocatorFallback, type Step, type TestSpec } from "../spec/schema.js";
// Phone exploration locators (R24): UiSelector form of a locator for scrolling a list, and XPath literals.
import { uiSelectorOf } from "../mobile/explore/locators.js";
import { isHealthCheck } from "../health/checks.js";
import type { RenderContext, RenderedScript, ScriptGenerator } from "./types.js";
import { commentSafe, concreteLocator, dataDeclaration, expr, fileHeader, lit, scriptFilename } from "./render-utils.js";
import { renderPermissionStep } from "../mobile/state/permission-step.js";
// Phone check tests (start-up, accessibility) carry a marker line the mobile runner reads; every other test renders exactly as before ("").
import { phoneCheckMarker } from "../mobile/quality/findings.js";
// How every phone test starts (the launcher activity the runner resolved on the phone) and its system dialog watch (RUN, round 24).
import { PHONE_START_IMPORT, phoneStartHooks } from "../mobile/device/start-script.js";

type StepLocator = NonNullable<Extract<Step, { action: "click" }>["locator"]>;

/** The `getBy*` call of a locator's own strategy (no number, no fallbacks). */
function baseLocator(l: Pick<StepLocator, "by" | "value" | "role">, value: (v: string) => string = expr): string {
    const v = value(l.value ?? "");
    switch (l.by) {
        case "role":
            return l.value
                ? `mobile.getByRole(${lit(l.role ?? "button")}, { name: ${v} })`
                : `mobile.getByRole(${lit(l.role ?? "button")})`;
        case "label":
            return `mobile.getByLabel(${v})`;
        case "text":
            return `mobile.getByText(${v})`;
        case "placeholder":
            return `mobile.getByPlaceholder(${v})`;
        case "testId":
            return `mobile.getByTestId(${value(l.value ?? "")})`;
        case "css":
            return `mobile.getByCss(${value(l.value ?? "")})`;
    }
}

/** How long a step looks for its element among its main locator and fallbacks before the main locator reports the failure itself. */
export const FIRST_OF_WAIT_MS = 10_000;

/**
 * The helper a phone script gets when a step has fallbacks (phone exploration, explore/locators.ts): the first of an element's locators that
 * shows, looked for together, in order. Taqwright's own `.or()` cannot do this (it stops when the first locator finds nothing). Scripts without
 * fallbacks do not get it and read exactly as before.
 */
export const FIRST_OF_HELPER = `

/** The first of an element's locators that finds it, in order: its main locator, then its fallbacks (written by the phone exploration). */
async function firstOf(ms: number, ...ways: Array<ReturnType<Mobile["getByText"]>>): Promise<ReturnType<Mobile["getByText"]>> {
    const end = Date.now() + ms;
    do {
        for (const way of ways) if (await way.isVisible({ timeout: 50 }).catch(() => false)) return way;
    } while (Date.now() < end);
    // Found by none of them: the main locator, so the step fails in its own words.
    return ways[0]!;
}`;

function fallbackCall(f: LocatorFallback): string {
    const nth = f.nth !== undefined ? `.nth(${f.nth})` : "";
    if (f.by === "uiSelector") return `mobile.getByUiSelector(${lit(f.value)})${nth}`;
    if (f.by === "xpath") return `mobile.getByXpath(${lit(f.value)})${nth}`;
    return namedFallback({ ...f, by: f.by }, nth);
}

function namedFallback(f: Omit<LocatorFallback, "by"> & { by: Exclude<LocatorFallback["by"], "uiSelector" | "xpath"> }, nth: string): string {
    // Fallback values are the app's own words: written as plain strings, never read as {{placeholders}}.
    return `${baseLocator({ by: f.by, value: f.value, ...(f.role ? { role: f.role } : {}) }, lit)}${nth}`;
}

/** The fallbacks a step uses on this platform (UiSelector and XPath are Android only, and exploration writes Android tests). */
const fallbacksOn = (l: StepLocator, platform: TestSpec["platform"]) => (platform === "ios" ? [] : (l.fallbacks ?? []));

/**
 * A locator as Taqwright code. A numbered one gets `.nth(n)`. On Android, a locator with fallbacks becomes `(await firstOf(ms, main,
 * fallback...))`: the first one that finds the element is used, so the main locator wins when it works and a fallback takes over when an app
 * update renamed the element. A locator without fallbacks reads exactly as it always did.
 */
function locatorOn(l: StepLocator, platform: TestSpec["platform"] = "android"): string {
    concreteLocator(l);
    const head = `${baseLocator(l)}${l.nth !== undefined ? `.nth(${l.nth})` : ""}`;
    const fallbacks = fallbacksOn(l, platform);
    if (!fallbacks.length) return head;
    return `(await firstOf(${FIRST_OF_WAIT_MS}, ${[head, ...fallbacks.map(fallbackCall)].join(", ")}))`;
}

/**
 * Scrolling a list until an element shows: as a UiSelector, so Taqwright asks Android's UiScrollable to scroll to it (and swipes and looks
 * again when that is not possible). A fallback already on the screen is used as it is; otherwise the UiSelector scrolls. Undefined when the
 * element cannot be said as a UiSelector.
 */
function scrollTarget(l: StepLocator, platform: TestSpec["platform"]): string | undefined {
    if (platform === "ios") return undefined;
    concreteLocator(l);
    const inner = uiSelectorOf(l);
    if (!inner) return undefined;
    const head = `mobile.getByUiSelector(${lit(l.nth !== undefined ? `${inner}.instance(${l.nth})` : inner)})`;
    const fallbacks = fallbacksOn(l, platform);
    return fallbacks.length ? `(await firstOf(0, ${[head, ...fallbacks.map(fallbackCall)].join(", ")}))` : head;
}

/** Does the script need the `firstOf` helper? */
export const usesFirstOf = (spec: TestSpec): boolean =>
    spec.platform !== "ios" && spec.steps.some((s) => "locator" in s && s.locator !== undefined && (s.locator as StepLocator).fallbacks !== undefined && (s.locator as StepLocator).fallbacks!.length > 0);

const DIRECTIONS = new Set(["up", "down", "left", "right"]);

/**
 * Device gestures a mobile `press` step can name instead of a keyboard key (the spec has no step kinds for them, and `press`
 * is the one step that talks to the device itself): `device:back`, `device:home`, `device:scroll:<direction>`,
 * `device:swipe:<direction>` (the finger moves that way) and, with a locator, `device:scroll-into-view`. Anything else is a key.
 */
function devicePress(step: Extract<Step, { action: "press" }>, platform: TestSpec["platform"]): string | undefined {
    const m = /^device:([a-z-]+)(?::([a-z]+))?$/.exec(step.key);
    if (!m) return undefined;
    const [, what, dir] = m;
    if (what === "back" && !dir) return "await mobile.goBack();";
    if (what === "home" && !dir) return 'await mobile.pressButton("HOME");';
    if ((what === "scroll" || what === "swipe") && dir && DIRECTIONS.has(dir)) return `await mobile.${what}(${lit(dir)});`;
    if (what === "scroll-into-view" && !dir && step.locator) return `await ${locatorOn(step.locator, platform)}.scrollIntoView();`;
    // `device:scroll-to` (phone exploration, R24): a list item reached by scrolling until it shows, through Android's UiScrollable.
    if (what === "scroll-to" && !dir && step.locator) return `await ${scrollTarget(step.locator, platform) ?? locatorOn(step.locator, platform)}.scrollIntoView();`;
    // `device:permission` with the answer's button: answer a permission question the same way when it shows (mobile/state/permission-step.ts).
    if (what === "permission" && !dir && step.locator) return renderPermissionStep(locatorOn(step.locator, platform));
    return undefined;
}

function renderStep(step: Step, platform: TestSpec["platform"] = "android"): string {
    const locator = (l: StepLocator) => locatorOn(l, platform);
    switch (step.action) {
        case "navigate":
            return `await mobile.openDeepLink(${expr(step.url)});`;
        case "click":
            return `await ${locator(step.locator)}.click();`;
        case "fill":
            return `await ${locator(step.locator)}.fill(${expr(step.value)});`;
        case "select":
            return `await ${locator(step.locator)}.selectOption(${expr(step.value)});`;
        case "check":
            return step.checked ? `await ${locator(step.locator)}.check();` : `await ${locator(step.locator)}.uncheck();`;
        case "press":
            return devicePress(step, platform) ?? `await mobile.press(${lit(step.key)});`;
        case "hover":
            return `// hover has no native-mobile equivalent: ${commentSafe(describeStep(step))}`;
        case "wait":
            return `await mobile.waitForTimeout(${step.ms});`;
        case "assert": {
            if (step.check === "url" || step.check === "title" || step.check === "a11y" || step.check === "screenshot" || step.check === "pageSpeed" || step.check === "inputHandling" || step.check === "accessDenied" || step.check === "looksRight" || isHealthCheck(step.check)) {
                return `// ${step.check} assertions apply to web pages only: ${commentSafe(describeStep(step))}`;
            }
            const target = step.locator
                ? locator(step.locator)
                : `mobile.getByText(${expr(String(step.expected ?? ""))})`;
            switch (step.check) {
                case "visible":
                    return `await expect(${target}).toBeVisible();`;
                case "hidden":
                    return `await expect(${target}).toBeHidden();`;
                case "enabled":
                    return `await expect(${target}).toBeEnabled();`;
                case "disabled":
                    return `await expect(${target}).toBeDisabled();`;
                case "text":
                    return `await expect(${target}).toContainText(${expr(String(step.expected ?? ""))});`;
                case "value":
                    return `await expect(${target}).toHaveValue(${expr(String(step.expected ?? ""))});`;
                case "count":
                    return `await expect(${target}).toHaveCount(${Number(step.expected ?? 0)});`;
            }
            return "";
        }
        case "request":
        case "assertResponse":
            throw new Error("API steps cannot be rendered as a mobile UI test");
        case "launchApp":
        case "closeApp":
            throw new Error("Windows desktop steps cannot be rendered as a mobile UI test");
        case "useBlock":
            throw new Error(`The reusable steps “${step.block}” were not expanded before the script was rendered`);
        case "upload":
        case "drag":
        case "email":
            // Web page steps (test files, drag and drop): a phone test has no file field or HTML drag events to drive.
            throw new Error(`The step "${step.action}" works on web pages only and cannot be rendered as a mobile UI test`);
    }
}

export const taqwrightGenerator: ScriptGenerator = {
    framework: "taqwright",
    kind: "mobile",
    executable: true,
    render(spec: TestSpec, _ctx: RenderContext): RenderedScript {
        const steps = spec.steps
            .map((step, i) => {
                const title = `${i + 1}. ${describeStep(step)}`;
                return `    await test.step(${lit(title)}, async () => {\n        ${renderStep(step, spec.platform)}\n    });`;
            })
            .join("\n");
        const content = `${fileHeader(spec, "Taqwright / Appium")}${phoneCheckMarker(spec)}
import { test, expect } from "@taqwright/taqwright";
${PHONE_START_IMPORT}

${dataDeclaration(spec)}

${phoneStartHooks()}${usesFirstOf(spec) ? FIRST_OF_HELPER : ""}

test(${lit(`${spec.testId}: ${spec.title}`)}, async ({ mobile }) => {
${steps}
});
`;
        return { framework: "taqwright", filename: scriptFilename(spec, ".mobile.spec.ts"), content, language: "typescript" };
    },
};
