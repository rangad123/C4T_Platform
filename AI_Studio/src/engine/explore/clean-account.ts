/**
 * Clean account state for the replays that judge a defect test (row 229, fix 1b of the row 227 triage). The independence check and the
 * own-steps replay (./independence.ts) open a fresh browser, but the application keeps the shared test account's cart lines, orders and
 * applied codes on its server. A saved test that only fails because of what earlier tests left there came out `independent` (row 227:
 * WEB-023, 049, 062, 064), and the one true positive came out `state_dependent` (WEB-006).
 *
 * Design: each replay of a test that signs in with the project's main test account signs in as a NEW account the engine registers
 * through the application's own sign-up page, only when
 *   - the project allows tests that change data (allowMutatingApiTests, off by default; a customer app never gets an account it did not
 *     allow), and
 *   - the exploration found a sign-up page, and
 *   - the test signs in as the main account, not a named role account (a new account would not have the role's rights), and
 *   - the test does not use the main account's own starting data (a record id the discovery crawl saw, such as ord-1000: a new account
 *     does not own it).
 * A new account is registered deterministically (no AI): the sign-up form's fields are filled by what they ask for (email, password,
 * name, user name); a required field of any other kind, a required checkbox (terms) or a captcha ends the attempt. It is a clean account
 * only when signing in with it afterwards works. Otherwise (and whenever the plan does not allow one) the replay runs as today, on the
 * shared account, and says so: the verdict is "not checked on clean state" (`not_on_clean_state`), never `independent` / high.
 * A test that never signs in is replayed signed out in a fresh browser: no account state to clean.
 *
 * The project's test-data reset hook (platform/test-data-reset-run.ts) is not used: it resets the whole application, is sent from the
 * platform's server (private hosts refused in runners mode), and runs only before validation runs by design; sent per replay it would
 * wipe what the scenarios written alongside (other lanes) depend on. The `prepare` hook of ./independence.ts can carry such a reset
 * later. No AI calls.
 */
import { randomBytes } from "node:crypto";
import type { Browser, Locator } from "playwright";
import { captchaMessage, detectCaptcha } from "../auth/captcha.js";
import { hasPasswordField, login } from "../discovery/auth.js";
import { BrowserSession, settle } from "../discovery/browser.js";
import type { SiteNote } from "../memory/notes.js";
import type { Scenario, Step } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";

export interface ReplayCredentials {
    username: string;
    password: string;
    totpSecret?: string;
}

/** Who a replay signs in as and whether that is clean account state (independence.ts `prepare`). */
export interface ReplayAccount {
    /** The credentials the replay's sign-in steps use; absent: the test's own. */
    credentials?: ReplayCredentials;
    /** The replay runs on clean account state: a newly registered account, or a test that never signs in. */
    clean: boolean;
    /** How, for the replay's summary ("as a newly registered account", "on the shared test account: ..."). */
    note: string;
}

/** The test signs in with the project's test account: one of its steps uses a `{{credentials.*}}` value. */
export const usesTestAccount = (steps: readonly Step[]): boolean => JSON.stringify(steps).includes("{{credentials.");

/** The sign-up page the exploration found: the model's sign-up path, else the first page the crawl classed as registration. */
export function signupPathOf(model: Pick<AppModel, "authentication" | "pages"> | undefined): string | undefined {
    return model?.authentication?.signupPath ?? model?.pages?.find((p) => p.type === "register")?.path;
}

const RECORD_ID = /\b[a-z]+-\d{3,}\b/g;

export type CleanPlan = { register: true; signupPath: string } | { register: false; clean: boolean; why: string };

/** Whether a replay of `steps` can run on a newly registered account, is clean already (signed out), or must use the shared account (why). */
export function cleanReplayPlan(p: { steps: readonly Step[]; roleAccount: boolean; dataChanges: boolean; signupPath?: string; startingIds?: ReadonlySet<string> }): CleanPlan {
    if (!usesTestAccount(p.steps)) return { register: false, clean: true, why: "signed out in a fresh browser" };
    const shared = (why: string): CleanPlan => ({ register: false, clean: false, why: `on the shared test account (${why}), so not checked on clean state` });
    if (p.roleAccount) return shared("it signs in as a named test account, whose rights a new account would not have");
    if (!p.dataChanges) return shared("the project does not allow tests that change data, so no account is registered for the replay");
    if (!p.signupPath) return shared("the application has no sign-up page the exploration found");
    const own = [...JSON.stringify(p.steps).matchAll(RECORD_ID)].map((m) => m[0]).find((id) => p.startingIds?.has(id));
    if (own) return shared(`the test uses the account's own starting data, ${own}, which a new account does not have`);
    return { register: true, signupPath: p.signupPath };
}

/** Words of a test that changes the account's state on the server (cart, orders, account details), so leftovers would change what it sees. */
const STATE_WORDS = /\b(cart|basket|checkout|orders?|discount|coupon|profile|delivery address|account (details|page|settings))\b/i;
/** Words of a test that checks an amount the cart works out. */
const TOTAL_WORDS = /\b(sub-?totals?|totals?|discounts?|shipping)\b/i;
const scenarioText = (s: Pick<Scenario, "title" | "description" | "preconditions" | "requiredData" | "expectedResults">) =>
    [s.title, s.description, ...s.preconditions, ...s.requiredData, ...s.expectedResults].join("\n");

/**
 * Row 235 (fix 2 of ROW233-ROOT-CAUSE.md): whether a test is WRITTEN as a newly registered account, so the amounts and records it checks
 * come from its own steps, not from what earlier tests left on the shared account (62 lost sightings, e.g. "−$113.71" = 10% of a
 * $1,137.14 leftover cart). Every objective pursuit, and a planned test that changes cart, orders or account state; the same safety
 * conditions as the replays (cleanReplayPlan), with the scenario's text standing in for steps that do not exist yet.
 */
export function cleanAuthoringPlan(p: { scenario: Pick<Scenario, "title" | "description" | "preconditions" | "requiredData" | "expectedResults">; objective: boolean; signsInAsMain: boolean; roleAccount: boolean; dataChanges: boolean; signupPath?: string; startingIds?: ReadonlySet<string> }): CleanPlan {
    const text = scenarioText(p.scenario);
    const shared = (why: string): CleanPlan => ({ register: false, clean: false, why: `written on the shared test account: ${why}` });
    if (p.roleAccount) return shared("it signs in as a named test account, whose rights a new account would not have");
    if (!p.signsInAsMain) return shared("it does not sign in as the project's test account");
    if (!p.objective && !STATE_WORDS.test(text)) return shared("it does not change cart, orders or account state");
    if (!p.dataChanges) return shared("the project does not allow tests that change data, so no account is registered");
    if (!p.signupPath) return shared("the application has no sign-up page the exploration found");
    const own = [...text.matchAll(RECORD_ID)].map((m) => m[0]).find((id) => p.startingIds?.has(id));
    if (own) return shared(`it uses the account's own starting data, ${own}, which a new account does not have`);
    return { register: true, signupPath: p.signupPath };
}

/** The scenario as written on a new account: it starts empty, and a total is checked on two or more lines the test adds itself (BS-01, BS-02). */
export function freshAccountScenario<S extends Pick<Scenario, "title" | "description" | "preconditions" | "requiredData" | "expectedResults">>(s: S): S {
    const lines = ["Signed in as a newly registered account with an empty cart and no orders: build every cart line, order or saved detail the test checks with its own steps"];
    if (TOTAL_WORDS.test(scenarioText(s))) lines.push("The test checks a total: add at least two different products to the cart with its own steps, the last with quantity 2 or more, before checking it, so every amount comes from the test's own steps");
    return { ...s, preconditions: [...s.preconditions, ...lines] };
}

/** What a sign-up field asks for, from its type, autocomplete hint, name, id, label and placeholder. */
type Ask = "email" | "password" | "name" | "username" | "other";
async function askOf(field: Locator): Promise<Ask> {
    const d = await field.evaluate((el) => {
        const i = el as HTMLInputElement;
        const labels = Array.from(i.labels ?? []).map((l) => l.textContent ?? "").join(" ");
        return { type: (i.getAttribute("type") ?? "text").toLowerCase(), hints: [i.getAttribute("autocomplete"), i.name, i.id, i.getAttribute("placeholder"), i.getAttribute("aria-label"), labels].join(" ").toLowerCase() };
    });
    if (d.type === "password") return "password";
    if (d.type === "email" || /e-?mail/.test(d.hints)) return "email";
    if (/\b(user ?name|username|login|handle|nickname)\b/.test(d.hints)) return "username";
    if (/\b(name|given-name|family-name|first ?name|last ?name|full ?name|surname)\b/.test(d.hints)) return "name";
    return "other";
}

const FIELDS = 'input:visible:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea:visible, select:visible';

/**
 * Registers a new account through the sign-up page and checks that signing in with it works, each in its own fresh browser. Returns
 * its credentials, or why none could be made. Bounded: each page action has at most `timeoutMs` (default 8 s).
 */
export async function registerFreshAccount(
    browser: Browser,
    baseUrl: string,
    signupPath: string,
    opts: { loginPath?: string; notes?: readonly SiteNote[]; timeoutMs?: number } = {},
): Promise<{ ok: true; credentials: ReplayCredentials } | { ok: false; why: string }> {
    const tag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const email = `qa+replay-${tag}@example.com`;
    const password = `Qa-${randomBytes(6).toString("hex")}-7z!`;
    const values: Record<Exclude<Ask, "other">, string> = { email, password, name: `QA Replay ${tag}`, username: `qareplay${tag}` };
    const timeoutMs = opts.timeoutMs ?? 8_000;
    let username = email;
    const session = await BrowserSession.launch(browser, { startUrl: baseUrl, secrets: [password], ...(opts.notes?.length ? { notes: opts.notes } : {}) });
    try {
        const { page } = session;
        page.setDefaultTimeout(timeoutMs);
        const res = await page.goto(new URL(signupPath, baseUrl).toString(), { waitUntil: "domcontentloaded" }).catch(() => null);
        if (!res || res.status() >= 400) return { ok: false, why: `the sign-up page ${signupPath} did not open` };
        await settle(page, 2_000);
        const captcha = await detectCaptcha(page);
        if (captcha) return { ok: false, why: captchaMessage(captcha, signupPath) };
        const pw = page.locator("input[type=password]:visible").first();
        if (!(await pw.count())) return { ok: false, why: `the sign-up page ${signupPath} has no password field` };
        const form = pw.locator("xpath=ancestor::form[1]");
        const root = (await form.count()) ? form : page.locator("body");
        const fields = root.locator(FIELDS);
        for (let i = 0; i < (await fields.count()); i++) {
            const f = fields.nth(i);
            const tagName = await f.evaluate((el) => el.tagName.toLowerCase());
            const type = ((await f.getAttribute("type")) ?? "").toLowerCase();
            const required = (await f.evaluate((el) => (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true"));
            if (type === "checkbox" || type === "radio") {
                // Agreeing to terms is a person's decision: a required box ends the attempt.
                if (required) return { ok: false, why: "the sign-up form has a required checkbox (terms or consent)" };
                continue;
            }
            if (tagName === "select") continue; // its default choice
            const ask = await askOf(f);
            if (ask === "other") {
                if (required) return { ok: false, why: "the sign-up form asks for a field the engine cannot fill on its own" };
                continue;
            }
            if (ask === "username") username = values.username;
            await f.fill(values[ask]);
        }
        const before = page.url();
        const submit = root.locator("button[type=submit]:visible, input[type=submit]:visible, button:not([type]):visible").first();
        if (await submit.count()) await submit.click();
        else await pw.press("Enter");
        // The outcome, not the page right after the click: a form a script sends navigates later.
        await page.waitForURL((u) => u.toString() !== before, { timeout: timeoutMs }).catch(() => undefined);
        await settle(page, 2_000);
        if (page.url() === before && (await hasPasswordField(page))) return { ok: false, why: "the sign-up form came back without creating the account" };
    } catch (e) {
        return { ok: false, why: `registering failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.split(password).join("***").slice(0, 200)}` };
    } finally {
        await session.close();
    }
    // A clean account only when it can sign in: a sign-up that waits for an e-mailed link, or was refused, cannot.
    const check = await BrowserSession.launch(browser, { startUrl: baseUrl, secrets: [password], ...(opts.notes?.length ? { notes: opts.notes } : {}) });
    try {
        check.page.setDefaultTimeout(timeoutMs);
        const r = await login(check, baseUrl, { username, password }, undefined, opts.loginPath ? { loginPath: opts.loginPath } : {});
        return r.ok ? { ok: true, credentials: { username, password } } : { ok: false, why: `signing in with the new account did not work (${r.error ?? "no reason given"})` };
    } catch (e) {
        return { ok: false, why: `signing in with the new account failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.split(password).join("***").slice(0, 200)}` };
    } finally {
        await check.close();
    }
}

/**
 * The `prepare` hook for one test's replays (independence.ts): each call registers a new account when the plan allows one, else says
 * why the replay is on the shared account (or is signed out). A failed registration falls back to the shared account and says why.
 */
export function replayAccountPreparer(plan: CleanPlan, register: () => ReturnType<typeof registerFreshAccount>): () => Promise<ReplayAccount> {
    return async () => {
        if (!plan.register) return { clean: plan.clean, note: plan.why };
        const r = await register().catch((e: unknown) => ({ ok: false as const, why: `registering failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200)}` }));
        return r.ok
            ? { credentials: r.credentials, clean: true, note: "as a newly registered account" }
            : { clean: false, note: `on the shared test account (a new account could not be registered: ${r.why}), so not checked on clean state` };
    };
}
