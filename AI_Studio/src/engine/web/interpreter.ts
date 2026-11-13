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
import { armDialog } from "../discovery/browser.js";
import { dialogProblem, downloadProblem, generatedSample } from "./interruptions.js";
import { applyClock, applyCondition } from "./conditions.js";
import { interpolate, type Locator, type PlainLocator, type Step } from "../spec/schema.js";
import { ARIA_TEMPLATE_MAX, classPattern, ariaTemplate, numberIn, urlPatternRegex, WEB_REQUEST_RULE, WEB_RESPONSE_CHECKS } from "./checks.js";

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
    // An element inside frames is found through each frame in turn, as the rendered script does (see ./pages.ts).
    const scope: Page | FrameLocator = (l.frame ?? []).reduce<Page | FrameLocator>((r, f) => r.frameLocator(frameSelector(f)), top);
    // Container, strategy, filter, nth: the order the generator writes them (../generators/render-utils.ts locatorCall).
    const own = locatePlain(l.within ? locatePlain(scope, l.within, data, true) : scope, l, data, false);
    const f = l.filter;
    const filtered = f
        ? own.filter({
              ...(f.hasText !== undefined ? { hasText: interpolate(f.hasText, data) } : {}),
              ...(f.hasNotText !== undefined ? { hasNotText: interpolate(f.hasNotText, data) } : {}),
              ...(f.has ? { has: locatePlain(scope, f.has, data, true) } : {}),
              ...(f.hasNot ? { hasNot: locatePlain(scope, f.hasNot, data, true) } : {}),
          })
        : own;
    return l.nth !== undefined ? filtered.nth(l.nth) : filtered;
}

function locatePlain(page: Page | FrameLocator | PwLocator, l: PlainLocator, data: RuntimeData, withNth: boolean): PwLocator {
    const value = l.value !== undefined ? interpolate(l.value, data) : undefined;
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
        case "altText":
            loc = page.getByAltText(value ?? "", { exact: l.exact });
            break;
        case "title":
            loc = page.getByTitle(value ?? "", { exact: l.exact });
            break;
    }
    return withNth && l.nth !== undefined ? loc.nth(l.nth) : loc;
}

/** The latest answer of a request step, per page the steps run on (what the next response check judges). */
const lastCalls = new WeakMap<Page, { status: number; headers: Record<string, string>; text: string; json: unknown }>();
/** Addresses of the responses each page received, so a "wait for the response" step after the action that caused it still sees it. */
const seenResponses = new WeakMap<Page, string[]>();
const at = (json: unknown, path: string): unknown => path.split(".").filter(Boolean).reduce<unknown>((acc, k) => (acc === null || acc === undefined ? undefined : (acc as Record<string, unknown>)[k]), json);
const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

/** The popup an earlier step opened, per page the steps run on (the same rule as the rendered script: "in the popup" means the latest one). */
const popups = new WeakMap<Page, Page>();

/** Where an upload step finds a test file on this machine; without one, upload steps are refused (the interpreter never guesses a path). */
export interface StepOptions {
    testFile?: (name: string) => string | undefined;
}

/** A popup the authoring session saw a click open (the click is then recorded with opensPopup): later "in the popup" steps work in it. */
export function rememberPopup(top: Page, popup: Page): void {
    popups.set(top, popup);
}

/** The dialog a dialog step armed on each page: checked after the step that follows it (the step that should open it), as the script does. */
const pendingDialogs = new WeakMap<Page, { shown: Promise<string>; message?: string }>();

export async function executeStep(top: Page, step: Step, data: RuntimeData, baseUrl: string, timeout = 6_000, options: StepOptions = {}): Promise<void> {
    const pending = step.action === "dialog" ? undefined : pendingDialogs.get(top);
    pendingDialogs.delete(top);
    await runOneStep(top, step, data, baseUrl, timeout, options);
    if (!pending) return;
    const message = await Promise.race([pending.shown, new Promise<undefined>((r) => setTimeout(() => r(undefined), Math.max(timeout, 3_000)))]);
    const problem = dialogProblem(message, pending.message);
    if (problem) throw new Error(problem);
}

async function runOneStep(top: Page, step: Step, data: RuntimeData, baseUrl: string, timeout: number, options: StepOptions): Promise<void> {
    const opt = { timeout };
    let page = top;
    if (!seenResponses.has(top) && typeof top.on === "function") {
        const seen: string[] = [];
        seenResponses.set(top, seen);
        top.on("response", (r) => {
            if (seen.push(r.url()) > 300) seen.shift();
        });
    }
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
            // A generated sample (./interruptions.ts) is made here; any other name is one of the project's test files.
            const file = generatedSample(step.file) ?? options.testFile?.(step.file);
            if (!file) throw new Error(`The test file "${step.file}" is not available here. Upload steps run in test runs, with the project's test files.`);
            const target = locate(page, step.locator, data);
            if (step.drop) {
                await target.drop({ files: file }, opt);
                return;
            }
            const isFileInput = await target.evaluate((el) => el instanceof HTMLInputElement && el.type === "file", undefined, opt).catch(() => false);
            if (isFileInput) await target.setInputFiles(file, opt);
            else {
                const chooser = page.waitForEvent("filechooser", opt);
                await target.click(opt);
                await (await chooser).setFiles(file);
            }
            return;
        }
        case "dialog": {
            const message = step.message !== undefined ? interpolate(step.message, data) : undefined;
            const promptText = step.promptText !== undefined ? interpolate(step.promptText, data) : undefined;
            pendingDialogs.set(top, { shown: armDialog(page, step.response, promptText), ...(message ? { message } : {}) });
            return;
        }
        case "download": {
            const started = page.waitForEvent("download", { timeout: Math.max(timeout, 10_000) });
            await locate(page, step.locator, data).click(opt);
            const problem = await downloadProblem(await started, step.filename !== undefined ? interpolate(step.filename, data) : undefined);
            if (problem) throw new Error(problem);
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
        case "wait": {
            const value = interpolate(step.value ?? "", data);
            if (step.until === "url") return page.waitForURL(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), opt);
            if (step.until === "response") {
                const seen = seenResponses.get(top) ?? [];
                const i = seen.findIndex((u) => u.includes(value));
                // Seen already (the action before caused it): taken, so the next wait for the same address waits for a new one.
                if (i >= 0) return void seen.splice(0, i + 1);
                await page.waitForResponse((r) => r.url().includes(value), opt);
                return void seen.splice(0);
            }
            if (step.until) {
                if (!step.locator) throw new Error(`Waiting until an element is ${step.until} needs the element (a locator)`);
                return locate(page, step.locator, data).waitFor({ state: step.until, timeout });
            }
            await page.waitForTimeout(step.ms);
            return;
        }
        case "remember": {
            const target = locate(page, step.locator, data);
            data[step.name] = step.from === "value" ? await target.inputValue(opt) : (await target.innerText(opt)).replace(/\s+/g, " ").trim();
            return;
        }
        case "assert":
            await executeAssert(page, step, data, timeout);
            return;
        case "request": {
            // Through the page's own request context: the browser's cookies for that site go with it, and only to the application's own site.
            const target = await checkedAddress(interpolate(step.path, data), baseUrl);
            if (new URL(target).origin !== new URL(baseUrl).origin) throw new Error(`${WEB_REQUEST_RULE} (this request went to ${new URL(target).origin}). Nothing was sent.`);
            const fill = (r?: Record<string, string>) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, interpolate(v, data)])) : undefined);
            const body = step.body === undefined ? undefined : JSON.parse(interpolate(JSON.stringify(step.body), data));
            const res = await page.request.fetch(target, { method: step.method, headers: fill(step.headers), params: fill(step.query), data: body, failOnStatusCode: false, maxRedirects: 0, timeout: Math.max(timeout, 10_000) });
            const text = await res.text();
            let json: unknown;
            try {
                json = JSON.parse(text);
            } catch {
                json = undefined;
            }
            const call = { status: res.status(), headers: res.headers(), text, json };
            lastCalls.set(top, call);
            for (const [name, path] of Object.entries(step.extract ?? {})) {
                const v = at(json, path);
                if (v === undefined || v === null || v === "") throw new Error(`Could not capture "${name}": no value at "${path}" in the HTTP ${call.status} response`);
                data[name] = typeof v === "object" ? JSON.stringify(v) : String(v);
            }
            return;
        }
        case "assertResponse": {
            if (!WEB_RESPONSE_CHECKS.has(step.check)) throw new Error(`The response check "${step.check}" runs in API tests only`);
            const call = lastCalls.get(top);
            if (!call) throw new Error("A response check needs a request step before it");
            const exp = step.expected;
            const text = interpolate(String(exp ?? ""), data);
            switch (step.check) {
                case "status":
                    return expect(call.status).toBe(Number(exp));
                case "statusClass":
                    return expect(Math.floor(call.status / 100)).toBe(Number(String(exp).charAt(0)));
                case "statusBelow":
                    return expect(call.status).toBeLessThan(Number(exp));
                case "jsonPath":
                    if (exp === undefined) return expect(at(call.json, step.path ?? "")).toBeDefined();
                    return expect(String(at(call.json, step.path ?? ""))).toBe(text);
                case "jsonType":
                    return expect(typeOf(step.path ? at(call.json, step.path) : call.json)).toBe(String(exp));
                case "header":
                    return expect(call.headers[(step.path ?? "").toLowerCase()] ?? "").toContain(text);
                case "bodyContains":
                    return expect(call.text).toContain(text);
                case "bodyNotContains":
                    return expect(call.text).not.toContain(text);
            }
            return;
        }
        case "launchApp":
        case "closeApp":
            throw new Error(`Step "${step.action}" is for Windows desktop tests, not a web step`);
        case "useBlock":
            // Reusable steps are put in place before anything runs (engine/blocks/expand.ts). Doing nothing here would let a test pass without running them.
            throw new Error(`The reusable steps “${step.block}” were not put in place before this step ran`);
        case "email":
            // Waiting for an email needs the project's test mailbox, which only a real run reads (see ../auth/run-session.ts): never faked here.
            throw new Error("Waiting for an email works only when the test runs, not while steps are tried one by one");
        case "clock":
            await applyClock(page, step);
            return;
        case "condition":
            await applyCondition(page, step, baseUrl);
            return;
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
        case "checked":
            return expect(target).toBeChecked(opt);
        case "unchecked":
            return expect(target).toBeChecked({ ...opt, checked: false });
        case "focused":
            return expect(target).toBeFocused(opt);
        case "editable":
            return expect(target).toBeEditable(opt);
        case "inViewport":
            return expect(target).toBeInViewport(opt);
        case "attribute":
            if (!step.name) throw new Error('"attribute" needs the attribute name');
            return step.expected === undefined ? expect(target).toHaveAttribute(step.name, opt) : expect(target).toHaveAttribute(step.name, exp, opt);
        case "class":
            return expect(target).toHaveClass(classPattern(exp), opt);
        case "css":
            if (!step.name) throw new Error('"css" needs the CSS property name');
            return expect(target).toHaveCSS(step.name, exp, opt);
        case "accessibleName":
            return expect(target).toHaveAccessibleName(exp, opt);
        case "accessibleErrorMessage":
            return expect(target).toHaveAccessibleErrorMessage(re, opt);
        case "exactText":
            return expect(target).toHaveText(exp, opt);
        case "notText":
            return expect(target).not.toContainText(exp, opt);
        case "urlPattern":
            return expect(page).toHaveURL(urlPatternRegex(exp), opt);
        case "ariaSnapshot": {
            // toMatchAriaSnapshot works only inside a Playwright test. Here the region is captured again and turned into a template the
            // same way the author made it; the rendered script (the source of truth) matches the template itself, which also allows a part of it.
            const want = String(step.expected ?? "");
            let got = "";
            const until = Date.now() + timeout;
            do {
                got = await target.ariaSnapshot({ timeout }).catch(() => "");
                if (got === want || ariaTemplate(got) === want) return;
                await page.waitForTimeout(200);
            } while (Date.now() < until);
            throw new Error(`The structure of the region does not match its snapshot. Expected:\n${want.slice(0, 800)}\nReceived:\n${got.slice(0, 800)}`);
        }
        case "remembered": {
            const kept = data[step.name ?? ""];
            if (kept === undefined) throw new Error(`Nothing was remembered as {{${step.name ?? ""}}}: a step before this one must remember it`);
            if (step.compare === "contains") return expect(target).toContainText(kept, opt);
            if (step.compare === "greater" || step.compare === "less") {
                const want = numberIn(kept);
                if (Number.isNaN(want)) throw new Error(`The remembered {{${step.name}}} ("${kept.slice(0, 80)}") holds no number`);
                const poll = expect.poll(async () => numberIn(await target.innerText({ timeout })), opt);
                return step.compare === "greater" ? poll.toBeGreaterThan(want) : poll.toBeLessThan(want);
            }
            return expect(target).toHaveText(kept, opt);
        }
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

/** The ARIA snapshot of a region as a template a later run still matches (numbers, dates, ids as /regex/): what the author records for "ariaSnapshot". */
export async function captureAriaTemplate(page: Page, l: Locator, data: RuntimeData, timeout = 6_000): Promise<string> {
    const snap = await locate(page, l, data).ariaSnapshot({ timeout });
    const template = ariaTemplate(snap);
    if (template.length > ARIA_TEMPLATE_MAX) throw new Error(`This region's snapshot is too large (${template.length} characters, at most ${ARIA_TEMPLATE_MAX}): pick the list, table or summary that shows the result`);
    return template;
}
