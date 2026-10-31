/**
 * Live interpreter for canonical web steps. Used while *authoring* (so only steps that actually
 * worked against the real app are recorded) and when *replaying* a spec prefix during repair.
 *
 * It must stay semantically aligned with ../generators/playwright.ts; the validator always runs
 * the rendered script, so the rendered script remains the source of truth for pass/fail.
 */
import { expect, type FrameLocator, type Locator as PwLocator, type Page } from "@playwright/test";
import { frameSelector, MAIN_PAGE_ONLY_CHECKS } from "./pages.js";
import { a11yThreshold, runA11yAudit } from "../a11y/audit.js";
import { runHealthCheck } from "../health/checks.js";
import { totp } from "../identity/totp.js";
import { runInputCheck } from "../inputs/checks.js";
import { runPageSpeed } from "../performance/checks.js";
import { checkedAddress } from "../spec/run-address.js";
import { interpolate, type Locator, type Step } from "../spec/schema.js";

export type RuntimeData = Record<string, string>;

export function runtimeData(testData: Record<string, string>, credentials?: { username: string; password: string; totpSecret?: string }): RuntimeData {
    const unique = String(Date.now());
    const data: RuntimeData = { unique };
    for (const [k, v] of Object.entries(testData)) data[k] = interpolate(v, { unique });
    if (credentials) {
        data["credentials.username"] = credentials.username;
        data["credentials.password"] = credentials.password;
        // Computed when read, so a step that runs 40 s after the data was built still gets a valid code.
        if (credentials.totpSecret) {
            const secret = credentials.totpSecret;
            Object.defineProperty(data, "credentials.totp", { enumerable: true, get: () => totp(secret) });
        }
    }
    return data;
}

export function locate(top: Page, l: Locator, data: RuntimeData): PwLocator {
    const value = l.value !== undefined ? interpolate(l.value, data) : undefined;
    // An element inside frames is found through each frame in turn, as the rendered script does (see ./pages.ts).
    const page: Page | FrameLocator = (l.frame ?? []).reduce<Page | FrameLocator>((r, f) => r.frameLocator(frameSelector(f)), top);
    let loc: PwLocator;
    switch (l.by) {
        case "role":
            loc = page.getByRole(l.role as Parameters<Page["getByRole"]>[0], {
                ...(value ? { name: value } : {}),
                ...(l.exact ? { exact: true } : {}),
            });
            break;
        case "label":
            loc = page.getByLabel(value ?? "", { exact: l.exact });
            break;
        case "text":
            loc = page.getByText(value ?? "", { exact: l.exact });
            break;
        case "placeholder":
            loc = page.getByPlaceholder(value ?? "", { exact: l.exact });
            break;
        case "testId":
            loc = page.getByTestId(value ?? "");
            break;
        case "css":
            loc = page.locator(value ?? "");
            break;
    }
    return l.nth !== undefined ? loc.nth(l.nth) : loc;
}

/** The popup an earlier step opened, per page the steps run on (the same rule as the rendered script: "in the popup" means the latest one). */
const popups = new WeakMap<Page, Page>();

/** Where an upload step finds a test file on this machine; without one, upload steps are refused (the interpreter never guesses a path). */
export interface StepOptions {
    testFile?: (name: string) => string | undefined;
}

export async function executeStep(top: Page, step: Step, data: RuntimeData, baseUrl: string, timeout = 6_000, options: StepOptions = {}): Promise<void> {
    const opt = { timeout };
    let page = top;
    if ("inPopup" in step && step.inPopup === true) {
        const p = popups.get(top);
        if (!p || p.isClosed()) throw new Error("No popup window is open. A step before this one must open it (Click ... and wait for the popup).");
        if (step.action === "assert" && MAIN_PAGE_ONLY_CHECKS.has(step.check)) throw new Error(`The check "${step.check}" works on the page the test started on, not in a popup`);
        page = p;
    }
    switch (step.action) {
        case "navigate":
            // The AI writes a test by running its steps here, so its addresses meet the same check as a script's (spec/run-address.ts).
            await page.goto(await checkedAddress(interpolate(step.url, data), baseUrl), { timeout: 30_000, waitUntil: "domcontentloaded" });
            return;
        case "click":
            if (step.opensPopup) {
                const opened = page.waitForEvent("popup", { timeout: Math.max(timeout, 10_000) });
                await locate(page, step.locator, data).click(opt);
                const p = await opened;
                await p.waitForLoadState("domcontentloaded").catch(() => undefined);
                popups.set(top, p);
                return;
            }
            await locate(page, step.locator, data).click(opt);
            return;
        case "upload": {
            const file = options.testFile?.(step.file);
            if (!file) throw new Error(`The test file "${step.file}" is not available here. Upload steps run in test runs, with the project's test files.`);
            const target = locate(page, step.locator, data);
            const isFileInput = await target.evaluate((el) => el instanceof HTMLInputElement && el.type === "file", undefined, opt).catch(() => false);
            if (isFileInput) await target.setInputFiles(file, opt);
            else {
                const chooser = page.waitForEvent("filechooser", opt);
                await target.click(opt);
                await (await chooser).setFiles(file);
            }
            return;
        }
        case "drag":
            await locate(page, step.locator, data).dragTo(locate(page, step.target, data), opt);
            return;
        case "fill":
            await locate(page, step.locator, data).fill(interpolate(step.value, data), opt);
            return;
        case "select":
            await locate(page, step.locator, data).selectOption(interpolate(step.value, data), opt);
            return;
        case "check":
            await locate(page, step.locator, data).setChecked(step.checked, opt);
            return;
        case "press":
            if (step.locator) await locate(page, step.locator, data).press(step.key, opt);
            else await page.keyboard.press(step.key);
            return;
        case "hover":
            await locate(page, step.locator, data).hover(opt);
            return;
        case "wait":
            await page.waitForTimeout(step.ms);
            return;
        case "assert":
            await executeAssert(page, step, data, timeout);
            return;
        case "request":
        case "assertResponse":
            throw new Error(`Step "${step.action}" is not a web step`);
        case "launchApp":
        case "closeApp":
            throw new Error(`Step "${step.action}" is for Windows desktop tests, not a web step`);
        case "useBlock":
            // Reusable steps are put in place before anything runs (engine/blocks/expand.ts). Doing nothing here would let a test pass without running them.
            throw new Error(`The reusable steps “${step.block}” were not put in place before this step ran`);
        case "email":
            // Waiting for an email needs the project's test mailbox, which only a real run reads (see ../auth/run-session.ts): never faked here.
            throw new Error("Waiting for an email works only when the test runs, not while steps are tried one by one");
    }
}

async function executeAssert(page: Page, step: Extract<Step, { action: "assert" }>, data: RuntimeData, timeout: number): Promise<void> {
    const opt = { timeout };
    const exp = step.expected !== undefined ? interpolate(String(step.expected), data) : "";
    const target = step.locator
        ? locate(page, step.locator, data)
        : step.expected !== undefined && (step.check === "visible" || step.check === "hidden")
          ? page.getByText(exp)
          : page.locator("body");
    const re = new RegExp(exp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    switch (step.check) {
        case "visible":
            return expect(target).toBeVisible(opt);
        case "hidden":
            return expect(target).toBeHidden(opt);
        case "enabled":
            return expect(target).toBeEnabled(opt);
        case "disabled":
            return expect(target).toBeDisabled(opt);
        case "text":
            return expect(target).toContainText(exp, opt);
        case "value":
            return expect(target).toHaveValue(exp, opt);
        case "count":
            return expect(target).toHaveCount(Number(step.expected ?? 0), opt);
        case "url":
            return expect(page).toHaveURL(re, opt);
        case "title":
            return expect(page).toHaveTitle(re, opt);
        case "screenshot":
            // Live runs have no baseline to compare with (the validator owns baselines); only check that
            // the page or element can actually be captured.
            await (step.locator ? target : page).screenshot({ animations: "disabled", timeout });
            return;
        case "a11y": {
            // Same scoping rule as the generator: a plain css locator goes to axe as a selector,
            // anything else is resolved by Playwright first. Threshold uses the raw `expected`
            // (no placeholders), exactly like the rendered script.
            const l = step.locator;
            const scope = !l ? undefined : l.by === "css" && l.nth === undefined ? interpolate(l.value ?? "", data) : target;
            return runA11yAudit(page, a11yThreshold(step.expected), scope, timeout);
        }
        case "noConsoleErrors":
        case "noFailedRequests":
        case "noBrokenLinks":
        case "noMixedContent":
        case "pageBasics":
            // Same helper the rendered script carries; the collector is installed on first use (see runHealthCheck).
            return runHealthCheck(page, step.check);
        case "accessDenied":
            throw new Error("Access-control checks run only in generated scripts (they sign in as other accounts in fresh browser contexts).");
        case "inputHandling":
            return runInputCheck(page, typeof step.expected === "string" ? step.expected : undefined);
        case "pageSpeed":
            return runPageSpeed(page, typeof step.expected === "string" ? step.expected : undefined);
        case "looksRight":
            // Judgement happens in the platform after a validation run; while authoring or replaying, only check that the
            // page (or element) can be captured, like the screenshot check does.
            await (step.locator ? target.first() : page).screenshot({ type: "jpeg", quality: 70, animations: "disabled", timeout });
            return;
    }
}
