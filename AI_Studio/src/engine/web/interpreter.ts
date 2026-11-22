/**
 * Live interpreter for canonical web steps. Used while *authoring* (so only steps that actually
 * worked against the real app are recorded) and when *replaying* a spec prefix during repair.
 *
 * It must stay semantically aligned with ../generators/playwright.ts; the validator always runs
 * the rendered script, so the rendered script remains the source of truth for pass/fail.
 */
import { expect, type FrameLocator, type Locator as PwLocator, type Page, type Response } from "@playwright/test";
import { frameSelector, MAIN_PAGE_ONLY_CHECKS } from "./pages.js";
import { a11yThreshold, runA11yAudit } from "../a11y/audit.js";
import { runHealthCheck } from "../health/checks.js";
import { totp } from "../identity/totp.js";
import { runInputCheck } from "../inputs/checks.js";
import { runPageSpeed } from "../performance/checks.js";
import { checkedAddress } from "../spec/run-address.js";
import { armDialog } from "../discovery/browser.js";
import { gotoOnceMore } from "../discovery/crawler.js";
import { dialogProblem, downloadProblem, generatedSample } from "./interruptions.js";
import { labelledField, LABEL_WAIT_MS, type FieldClue } from "./label-fallback.js";
import { applyClock, applyCondition } from "./conditions.js";
import { interpolate, type Locator, type PlainLocator, type Step } from "../spec/schema.js";
import { ARIA_TEMPLATE_MAX, classPattern, ariaTemplate, DB_CHECK_NOT_YET, numberIn, urlPatternRegex, WEB_REQUEST_RULE, WEB_RESPONSE_CHECKS } from "./checks.js";
import { checkRelation } from "../validation/relation.js";

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

/**
 * The element a step acts on: a label locator on its own goes through labelledField (./label-fallback.ts), as in the rendered script
 * (../generators/render-utils.ts actionLocatorCall). Checks use locate().
 */
async function actOn(top: Page, l: Locator, data: RuntimeData, timeout: number, near: readonly FieldClue[] = []): Promise<PwLocator> {
    if (l.by !== "label" || l.filter || l.nth !== undefined) return locate(top, l, data);
    const scope: Page | FrameLocator = (l.frame ?? []).reduce<Page | FrameLocator>((r, f) => r.frameLocator(frameSelector(f)), top);
    const root = l.within ? locatePlain(scope, l.within, data, true) : scope;
    return labelledField(root, interpolate(l.value ?? "", data), l.exact === true, !!l.within, Math.min(timeout, LABEL_WAIT_MS), [...near]);
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
/** The responses each page received since its latest step other than a response wait began, so a "wait for the response" step after the action that caused it still sees it. */
const seenResponses = new WeakMap<Page, Response[]>();
/** The bodies of the API answers (fetch / XHR) a page received, read as they arrive: a page that moves on right after takes them away. */
const answerBodies = new WeakMap<Response, Promise<string | undefined>>();
/** Said when a kept answer's body is gone (the rendered script reads it through a route, see KEPT_CALL_HELPER_SOURCE in ./checks.ts). */
export const KEPT_BODY_GONE = (part: string) => `The answer from the address containing "${part}" could not be read: the page moved on before its body could be read. The saved test reads it on its own; here, keep an answer the page stays on.`;
const at = (json: unknown, path: string): unknown => path.split(".").filter(Boolean).reduce<unknown>((acc, k) => (acc === null || acc === undefined ? undefined : (acc as Record<string, unknown>)[k]), json);
const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

/** Keeps an answer as the page's latest (what the next response check judges) and captures its values into the test data. */
function keep(top: Page, res: { status: number; headers: Record<string, string>; text: string }, extract: Record<string, string>, data: RuntimeData): void {
    let json: unknown;
    try {
        json = JSON.parse(res.text);
    } catch {
        json = undefined;
    }
    lastCalls.set(top, { ...res, json });
    for (const [name, path] of Object.entries(extract)) {
        const v = at(json, path);
        if (v === undefined || v === null || v === "") throw new Error(`Could not capture "${name}": no value at "${path}" in the HTTP ${res.status} response`);
        data[name] = typeof v === "object" ? JSON.stringify(v) : String(v);
    }
}

/** The popup an earlier step opened, per page the steps run on (the same rule as the rendered script: "in the popup" means the latest one). */
const popups = new WeakMap<Page, Page>();

/** Where an upload step finds a test file on this machine; without one, upload steps are refused (the interpreter never guesses a path). */
export interface StepOptions {
    testFile?: (name: string) => string | undefined;
    /** What the test's neighbouring steps act on (nearbyTargets in ./label-fallback.ts), as the rendered script gets them. */
    near?: readonly FieldClue[];
}

/** A popup the authoring session saw a click open (the click is then recorded with opensPopup): later "in the popup" steps work in it. */
export function rememberPopup(top: Page, popup: Page): void {
    popups.set(top, popup);
}

/** The dialog a dialog step armed on each page: checked after the step that follows it (the step that should open it), as the script does. */
const pendingDialogs = new WeakMap<Page, { shown: Promise<string>; message?: string }>();

/** The step running on each page: the next one waits for it. */
const runningStep = new WeakMap<Page, Promise<void>>();

/**
 * Runs one step. The steps of one page run one at a time, in the order they were started: the AI SDK runs the tool calls of one model
 * turn at the same time, and two fills at once type into whichever field took the focus last (a fill focuses its field, then types with
 * the page keyboard), so a sign-in's email went into the Password field.
 */
export function executeStep(top: Page, step: Step, data: RuntimeData, baseUrl: string, timeout = 6_000, options: StepOptions = {}): Promise<void> {
    const mine = (runningStep.get(top) ?? Promise.resolve()).then(() => executeOne(top, step, data, baseUrl, timeout, options));
    runningStep.set(top, mine.catch(() => undefined));
    return mine;
}

async function executeOne(top: Page, step: Step, data: RuntimeData, baseUrl: string, timeout: number, options: StepOptions): Promise<void> {
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
        const seen: Response[] = [];
        seenResponses.set(top, seen);
        top.on("response", (r) => {
            if (seen.push(r) > 300) seen.shift();
            const type = typeof r.request === "function" ? r.request().resourceType() : "";
            if (type === "fetch" || type === "xhr") answerBodies.set(r, r.text().catch(() => undefined));
        });
    }
    // A "wait for the response" step takes only a response that came while the step before it ran, or after: the rendered script starts
    // listening right before that step (generators/playwright.ts), so an earlier response (the page's own load) does not count. Row 227's
    // WEB-026 waited for "account" after Save: the interpreter took the page load's /account response, the script timed out (queue row 228).
    if (!(step.action === "wait" && step.until === "response")) seenResponses.get(top)?.splice(0);
    if ("inPopup" in step && step.inPopup === true) {
        const p = popups.get(top);
        if (!p || p.isClosed()) throw new Error("No popup window is open. A step before this one must open it (Click ... and wait for the popup).");
        if (step.action === "assert" && MAIN_PAGE_ONLY_CHECKS.has(step.check)) throw new Error(`The check "${step.check}" works on the page the test started on, not in a popup`);
        page = p;
    }
    switch (step.action) {
        case "navigate":
            // The AI writes a test by running its steps here, so its addresses meet the same check as a script's (spec/run-address.ts).
            // A load cut off by the previous page's scripted redirect (net::ERR_ABORTED) is tried once more (row 236), as the crawler does.
            await gotoOnceMore(page, await checkedAddress(interpolate(step.url, data), baseUrl));
            return;
        case "click":
            if (step.opensPopup) {
                const opened = page.waitForEvent("popup", { timeout: Math.max(timeout, 10_000) });
                await (await actOn(page, step.locator, data, timeout, options.near)).click(opt);
                const p = await opened;
                await p.waitForLoadState("domcontentloaded").catch(() => undefined);
                popups.set(top, p);
                return;
            }
            await (await actOn(page, step.locator, data, timeout, options.near)).click(opt);
            return;
        case "upload": {
            // A generated sample (./interruptions.ts) is made here; any other name is one of the project's test files.
            const file = generatedSample(step.file) ?? options.testFile?.(step.file);
            if (!file) throw new Error(`The test file "${step.file}" is not available here. Upload steps run in test runs, with the project's test files.`);
            const target = await actOn(page, step.locator, data, timeout, options.near);
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
            await (await actOn(page, step.locator, data, timeout, options.near)).click(opt);
            const problem = await downloadProblem(await started, step.filename !== undefined ? interpolate(step.filename, data) : undefined);
            if (problem) throw new Error(problem);
            return;
        }
        case "drag":
            await (await actOn(page, step.locator, data, timeout, options.near)).dragTo(await actOn(page, step.target, data, timeout, options.near), opt);
            return;
        case "fill":
            await (await actOn(page, step.locator, data, timeout, options.near)).fill(interpolate(step.value, data), opt);
            return;
        case "select":
            await (await actOn(page, step.locator, data, timeout, options.near)).selectOption(interpolate(step.value, data), opt);
            return;
        case "check":
            await (await actOn(page, step.locator, data, timeout, options.near)).setChecked(step.checked, opt);
            return;
        case "press":
            if (step.locator) await (await actOn(page, step.locator, data, timeout, options.near)).press(step.key, opt);
            else await page.keyboard.press(step.key);
            return;
        case "hover":
            await (await actOn(page, step.locator, data, timeout, options.near)).hover(opt);
            return;
        case "wait": {
            const value = interpolate(step.value ?? "", data);
            if (step.until === "url") return page.waitForURL(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), opt);
            if (step.until === "response") {
                const seen = seenResponses.get(top) ?? [];
                const i = seen.findIndex((r) => r.url().includes(value));
                // Seen already (the action before caused it): taken, so the next wait for the same address waits for a new one.
                const res = i >= 0 ? seen.splice(0, i + 1)[i]! : await page.waitForResponse((r) => r.url().includes(value), opt);
                if (i < 0) seen.splice(0);
                // With extract, the answer is kept as the latest one (what response checks judge) and its values captured.
                if (step.extract) {
                    const text = await (answerBodies.get(res) ?? res.text().catch(() => undefined));
                    if (text === undefined) throw new Error(KEPT_BODY_GONE(value));
                    keep(top, { status: res.status(), headers: res.headers(), text }, step.extract, data);
                }
                return;
            }
            if (step.until) {
                if (!step.locator) throw new Error(`Waiting until an element is ${step.until} needs the element (a locator)`);
                return locate(page, step.locator, data).waitFor({ state: step.until, timeout });
            }
            await page.waitForTimeout(step.ms);
            return;
        }
        case "remember": {
            const target = await actOn(page, step.locator, data, timeout, options.near);
            data[step.name] = step.from === "value" ? await target.inputValue(opt) : (await target.innerText(opt)).replace(/\s+/g, " ").trim();
            return;
        }
        case "assert":
            await executeAssert(page, step, data, timeout);
            return;
        case "request": {
            if (step.parallel !== undefined) throw new Error("A request sent several times at once runs only in a saved API script, not step by step.");
            // Through the page's own request context: the browser's cookies for that site go with it, and only to the application's own site.
            const target = await checkedAddress(interpolate(step.path, data), baseUrl);
            if (new URL(target).origin !== new URL(baseUrl).origin) throw new Error(`${WEB_REQUEST_RULE} (this request went to ${new URL(target).origin}). Nothing was sent.`);
            const fill = (r?: Record<string, string>) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, interpolate(v, data)])) : undefined);
            const body = step.body === undefined ? undefined : JSON.parse(interpolate(JSON.stringify(step.body), data));
            const res = await page.request.fetch(target, { method: step.method, headers: fill(step.headers), params: fill(step.query), data: body, failOnStatusCode: false, maxRedirects: 0, timeout: Math.max(timeout, 10_000) });
            keep(top, { status: res.status(), headers: res.headers(), text: await res.text() }, step.extract ?? {}, data);
            return;
        }
        case "assertResponse": {
            if (step.check === "dbCheck") throw new Error(DB_CHECK_NOT_YET(step.name ?? ""));
            if (!WEB_RESPONSE_CHECKS.has(step.check)) throw new Error(`The response check "${step.check}" runs in API tests only`);
            if (step.check === "relation") {
                const r = checkRelation(step.expression ?? "", { body: lastCalls.get(top)?.json, vars: data }, step.source);
                if (!r.held) throw new Error(r.message);
                return;
            }
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
