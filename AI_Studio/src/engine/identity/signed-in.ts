/**
 * Speed and visual checks for pages that sit behind a login (no LLM).
 *
 * Page-speed and visual-baseline tests used to cover anonymous pages only: a page reached while logged in would send a fresh
 * browser to the sign-in page, so it would test the wrong page. This module lets those two check families work as a signed-in
 * account — the project's default credentials, or a named test account (see ../../../docs/features/identity.md).
 *
 *  1. PLAN (generation time, one visitor-only browser context): find out which candidate pages really need a login (a visitor is
 *     sent to a sign-in page, refused, or shown a sign-in form) and read the shape of the sign-in form at the address discovery
 *     learned. Only pages that pass that test become signed-in checks; at most 3 pages for each of at most 2 accounts.
 *  2. SPEC: a signed-in spec is the sign-in steps (open the sign-in page, fill username and password from the account's
 *     `{{credentials...}}` placeholders, submit, enter the one-time code when the account has one), a check that sign-in worked,
 *     the navigation to the page, and then the ordinary speed / screenshot step. Plain steps: the script stays portable and holds
 *     only environment-variable names, never a secret.
 *  3. RUN: the speed helper receives the session (`signed-in` in the assert's `expected`), see ../performance/checks.ts.
 *     A sign-in that does not work is a plain validation failure ("Could not sign in as ..."), never a finding.
 */
import type { Browser, Page } from "playwright";
import type { DraftSpec } from "../api/test-specs.js";
import { selectKeyPages, type KeyPage } from "../a11y/specs.js";
import type { EngineContext } from "../context.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";
import type { Reach, RoleLogin } from "./access.js";

/** Every step that proves a sign-in worked starts its description with this; failures at or before the last one are "could not sign in". */
export const SIGN_IN_STEP_PREFIX = "Signed in as ";

/** The token that makes the speed helper carry the page's session into its fresh measurement contexts. */
export const SIGNED_IN_SPEED_TOKEN = "signed-in";

export const MAX_SIGNED_IN_PAGES = 3;
export const MAX_SIGNED_IN_ACCOUNTS = 2;
/** Upper bound on pages loaded once as a visitor to tell public from signed-in-only pages. */
const MAX_PROBES = 30;

const SIGN_IN_PATHS = ["/login", "/signin", "/sign-in", "/auth/login", "/account/login", "/users/sign_in"];
const NON_HTML = /\.(json|xml|txt|pdf|csv|zip|png|jpe?g|gif|svg|webp|ico|css|js|map|ya?ml)$/i;

/** An input that asks for a one-time code (same rule as discovery's login). */
export const OTP_CSS =
    'input[autocomplete="one-time-code"]:visible, input[name*="otp" i]:visible, input[name*="totp" i]:visible, input[name*="2fa" i]:visible, input[name*="mfa" i]:visible, input[name*="verif" i]:visible, input[name="code" i]:visible, input[id*="otp" i]:visible, input[id*="code" i]:visible, input[placeholder*="code" i]:visible';
const PASSWORD_VISIBLE_CSS = "input[type=password]:visible";
const GENERIC_USER_CSS = "form:has(input[type=password]) :is(input[type=email], input[type=text], input[type=tel], input:not([type])):visible";
const FORM_SUBMIT_CSS = "form:has(input[type=password]) :is(button:not([type=button]):not([type=reset]), input[type=submit]):visible";

// ── who signs in ─────────────────────────────────────────────────────────────

export interface SignInAccount {
    /** null = the project's default credentials, otherwise the name of a test account. */
    role: string | null;
    /** How the account is named to people: "admin", or "the default account". */
    who: string;
    /** The sign-in asks for an authenticator code after the password. */
    needsCode: boolean;
}

export const defaultAccount = (needsCode: boolean): SignInAccount => ({ role: null, who: "the default account", needsCode });
export const roleAccount = (name: string, needsCode: boolean): SignInAccount => ({ role: name, who: name, needsCode });

const ref = (a: SignInAccount, field: "username" | "password" | "totp") => `{{credentials.${a.role ? `${a.role}.` : ""}${field}}}`;

// ── the sign-in form, as seen by a visitor ──────────────────────────────────

export interface LoginForm {
    /** Address of the sign-in page. */
    path: string;
    userCss: string;
    passwordCss: string;
    /** Absent: the form is submitted with Enter. */
    submit?: { css: string } | { buttonName: string };
}

/** What the page-side script reports about the first visible password form. */
export interface RawLoginForm {
    pw: { id: string; name: string };
    user: { id: string; name: string } | null;
    inForm: boolean;
    submitName: string | null;
}

/** Plain-JS (a string: bundlers must not rewrite helper functions inside it) run inside the sign-in page. */
const FORM_SCRIPT = `(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const pw = Array.from(document.querySelectorAll("input[type=password]")).find(vis);
    if (!pw) return null;
    const form = pw.closest("form");
    const root = form || document;
    const user = Array.from(root.querySelectorAll("input")).find((el) => el !== pw && vis(el) && /^(email|text|tel|)$/.test((el.getAttribute("type") || "").toLowerCase()));
    const btn = Array.from(root.querySelectorAll("button, input[type=submit]")).find((el) => vis(el) && (el.getAttribute("type") || "submit").toLowerCase() !== "button" && (el.getAttribute("type") || "submit").toLowerCase() !== "reset");
    const label = btn ? ((btn.tagName === "INPUT" ? btn.value : btn.textContent) || "").replace(/\\s+/g, " ").trim() : "";
    return { pw: { id: pw.id || "", name: pw.getAttribute("name") || "" }, user: user ? { id: user.id || "", name: user.getAttribute("name") || "" } : null, inForm: !!form, submitName: label || null };
})()`;

const quote = (s: string) => JSON.stringify(s);
/** Ids that look generated (framework counters, random suffixes) change between loads: do not rely on them. */
const stableId = (id: string) => id !== "" && !/^:|\d{3,}|[0-9a-f]{8,}/i.test(id);

function fieldCss(f: { id: string; name: string } | null, fallback: string): string {
    if (!f) return fallback;
    if (f.name) return `input[name=${quote(f.name)}]:visible`;
    if (stableId(f.id)) return `input[id=${quote(f.id)}]:visible`;
    return fallback;
}

/** CSS selectors for the sign-in form's fields, from what the page reported. Pure, so it can be tested without a browser. */
export function loginFormFrom(raw: RawLoginForm, path: string): LoginForm {
    const submit = raw.inForm ? { css: FORM_SUBMIT_CSS } : raw.submitName ? { buttonName: raw.submitName } : undefined;
    return { path, userCss: fieldCss(raw.user, GENERIC_USER_CSS), passwordCss: fieldCss(raw.pw, PASSWORD_VISIBLE_CSS), ...(submit ? { submit } : {}) };
}

// ── steps ────────────────────────────────────────────────────────────────────

/** Steps that sign the account in and prove it worked. Secrets appear only as `{{credentials...}}` placeholders. */
export function signInSteps(account: SignInAccount, form: LoginForm): Step[] {
    const css = (value: string) => ({ by: "css" as const, value, nth: 0 });
    const steps: Step[] = [
        { action: "navigate", url: form.path, description: `Open the sign-in page (${form.path})` },
        { action: "fill", locator: css(form.userCss), value: ref(account, "username"), description: `Enter ${account.who === "the default account" ? "the default" : `the “${account.who}”`} username` },
        { action: "fill", locator: css(form.passwordCss), value: ref(account, "password"), description: "Enter the password" },
    ];
    if (form.submit && "css" in form.submit) steps.push({ action: "click", locator: css(form.submit.css), description: "Submit the sign-in form" });
    else if (form.submit) steps.push({ action: "click", locator: { by: "role", role: "button", value: form.submit.buttonName, nth: 0 }, description: "Submit the sign-in form" });
    else steps.push({ action: "press", key: "Enter", locator: css(form.passwordCss), description: "Submit the sign-in form" });
    steps.push({ action: "assert", check: "hidden", locator: css(PASSWORD_VISIBLE_CSS), description: `${SIGN_IN_STEP_PREFIX}${account.who}: no sign-in form is shown` });
    if (account.needsCode) {
        steps.push(
            { action: "fill", locator: css(OTP_CSS), value: ref(account, "totp"), description: "Enter the one-time code from the authenticator" },
            { action: "press", key: "Enter", locator: css(OTP_CSS), description: "Submit the one-time code" },
            { action: "assert", check: "hidden", locator: css(OTP_CSS), description: `${SIGN_IN_STEP_PREFIX}${account.who}: the one-time code was accepted` },
        );
    }
    return steps;
}

/** Sign in, open the page, then the check steps. */
export function signedInPageSteps(account: SignInAccount, form: LoginForm, pagePath: string, check: Step[]): Step[] {
    return [...signInSteps(account, form), { action: "navigate", url: pagePath, description: `Open ${pagePath} (signed in)` }, ...check];
}

// ── plan ─────────────────────────────────────────────────────────────────────

export interface SignedInPage {
    path: string;
    /** What the page is called (its title or first heading). */
    name: string;
    /** "Dashboard", "Account"... when known. */
    label?: string;
    priority: TestSpec["priority"];
}

export interface SignedInPlan {
    form: LoginForm;
    accounts: Array<{ account: SignInAccount; pages: SignedInPage[] }>;
    /** Pages a visitor cannot open: the anonymous speed / visual checks leave these out (they would test the sign-in page). */
    gated: Set<string>;
}

export interface SignedInInput {
    model: AppModel;
    /** Present when discovery signed in with the project's default credentials. */
    defaultAccount?: SignInAccount;
    roles: RoleLogin[];
    /** What each test account reached in the access survey (accounts missing here could not sign in). */
    reach: Reach[];
}

const pathOnly = (p: string) => (p.split(/[?#]/)[0] ?? "/") || "/";

/** What a visitor was answered when opening a page directly. */
export interface VisitorView {
    status: number;
    finalPath: string;
    hasPasswordField: boolean;
    text: string;
}

const DENIED_PATH = /log-?in|sign-?in|auth|forbidden|denied|unauthori[sz]ed|\b40[13]\b/i;
const DENIED_TEXT = /access denied|forbidden|not authori[sz]ed|insufficient permission|you (?:do not|don't) have (?:access|permission)/i;

/** True when the visitor was not given the page: refused, sent to a sign-in or error page, shown a sign-in form, or told "access denied". */
export function needsSignIn(path: string, signInPath: string, v: VisitorView): boolean {
    if (v.status === 0 || v.status >= 500) return false; // could not tell: leave the page where it is
    if (v.status === 401 || v.status === 403 || v.status === 404) return true;
    const asked = pathOnly(path);
    if (v.finalPath !== asked && DENIED_PATH.test(v.finalPath)) return true;
    if (v.hasPasswordField && asked !== pathOnly(signInPath)) return true;
    return DENIED_TEXT.test(v.text);
}

/** Open pages and read the sign-in form as a visitor (a fresh context: no cookies, nothing stored). GET only. */
async function surveyAsVisitor(browser: Browser, origin: string, signInHint: string | undefined, paths: string[]): Promise<{ form?: LoginForm; gated: Set<string> }> {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    try {
        const page = await context.newPage();
        const open = async (p: string): Promise<number> => {
            const res = await page.goto(new URL(p, origin).toString(), { waitUntil: "load", timeout: 20_000 }).catch(() => null);
            await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => undefined);
            return res ? res.status() : 0;
        };
        const readForm = async (p: string): Promise<LoginForm | undefined> => {
            const status = await open(p);
            if (status === 0 || status >= 400) return undefined;
            const raw = (await page.evaluate(FORM_SCRIPT).catch(() => null)) as RawLoginForm | null;
            return raw ? loginFormFrom(raw, new URL(page.url()).pathname) : undefined;
        };
        let form: LoginForm | undefined;
        for (const p of [...(signInHint ? [signInHint] : []), ...SIGN_IN_PATHS.filter((x) => x !== signInHint)]) {
            form = await readForm(p);
            if (form) break;
        }
        const gated = new Set<string>();
        if (form) {
            for (const p of paths) {
                const status = await open(p);
                const view = await visitorView(page, status);
                if (needsSignIn(p, form.path, view)) gated.add(p);
            }
        }
        return { form, gated };
    } finally {
        await context.close().catch(() => undefined);
    }
}

async function visitorView(page: Page, status: number): Promise<VisitorView> {
    return {
        status,
        finalPath: new URL(page.url()).pathname,
        hasPasswordField: (await page.locator(PASSWORD_VISIBLE_CSS).count().catch(() => 0)) > 0,
        text: ((await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "")) ?? "").slice(0, 4_000),
    };
}

/** Path with ids collapsed, so /orders/1 and /orders/2 count as one page. */
const shape = (path: string) =>
    pathOnly(path)
        .split("/")
        .map((seg) => (/^\d+$/.test(seg) || /\d{3,}/.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) ? "{id}" : seg))
        .join("/");

/**
 * Candidate pages of the default account: the model's important pages first (most important first), then the other pages that
 * returned a normal answer, shallowest first — with no regard to whether they are public: looking decides that.
 */
function modelCandidates(model: AppModel, signInPath: string | undefined): KeyPage[] {
    // `loggedIn: false` lifts selectKeyPages' rule that drops account / dashboard pages.
    const open: AppModel = { ...model, authentication: { ...model.authentication, loggedIn: false } };
    const ranked = selectKeyPages(open, 40);
    const have = new Set(ranked.map((k) => k.page.path || "/"));
    const rest: KeyPage[] = model.pages
        .filter((p) => !have.has(p.path || "/") && p.type !== "error" && (p.status === 0 || (p.status >= 200 && p.status < 400)) && !NON_HTML.test(pathOnly(p.path || "/")))
        .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
        .map((p) => ({ page: p, type: p.type, priority: "medium" as const }));
    const seen = new Set<string>();
    return [...ranked, ...rest]
        .filter((k) => k.type !== "login" && k.type !== "register" && !(signInPath && pathOnly(k.page.path || "/") === pathOnly(signInPath)))
        .filter((k) => (seen.has(shape(k.page.path || "/")) ? false : (seen.add(shape(k.page.path || "/")), true)))
        .slice(0, 14);
}

function pageFrom(path: string, key: KeyPage | undefined, heading: string): SignedInPage {
    return { path, name: key?.page.title?.trim() || heading || path, ...(key?.label ? { label: key.label } : {}), priority: key?.priority ?? "medium" };
}

/**
 * Decide which pages get signed-in checks. Returns undefined when there is nobody to sign in as, or the sign-in form cannot be
 * found (the reason is reported as an event, so it never disappears silently).
 */
export async function planSignedIn(ctx: EngineContext, browser: Browser, input: SignedInInput): Promise<SignedInPlan | undefined> {
    const origin = input.model.origin;
    const signInHint = input.model.authentication.loginPath;
    const keyed = modelCandidates(input.model, signInHint);
    const byPath = new Map(keyed.map((k) => [k.page.path || "/", k]));

    interface Who {
        account: SignInAccount;
        candidates: Array<{ path: string; heading: string }>;
    }
    const who: Who[] = [];
    if (input.defaultAccount) who.push({ account: input.defaultAccount, candidates: keyed.map((k) => ({ path: k.page.path || "/", heading: k.page.headings.find((h) => h.trim()) ?? "" })) });
    for (const r of input.reach) {
        if (who.length >= MAX_SIGNED_IN_ACCOUNTS + 1) break; // a spare in case an account turns out to have no signed-in-only pages
        if (r.who === "anonymous" || !input.roles.some((x) => x.name === r.who)) continue;
        const candidates = r.pages.filter((p) => p.path !== (signInHint ?? "") && !NON_HTML.test(p.path)).map((p) => ({ path: p.path, heading: p.heading }));
        who.push({ account: roleAccount(r.who, Boolean(r.needsCode)), candidates });
    }
    if (who.length === 0) return undefined;

    const toProbe = [...new Set(who.flatMap((w) => w.candidates.map((c) => c.path)))].slice(0, MAX_PROBES);
    const { form, gated } = await surveyAsVisitor(browser, origin, signInHint, toProbe);
    if (!form) {
        ctx.emit({ stage: "generation", kind: "signed_in_skipped", level: "warn", message: "Speed and visual checks as a signed-in account were skipped: the sign-in form could not be found as a visitor." });
        return undefined;
    }

    const accounts: SignedInPlan["accounts"] = [];
    for (const w of who) {
        const pages = w.candidates
            .filter((c) => gated.has(c.path))
            .slice(0, MAX_SIGNED_IN_PAGES)
            .map((c) => pageFrom(c.path, byPath.get(c.path), c.heading));
        if (pages.length) accounts.push({ account: w.account, pages });
        if (accounts.length >= MAX_SIGNED_IN_ACCOUNTS) break;
    }
    return { form, accounts, gated };
}

// ── titles ───────────────────────────────────────────────────────────────────

export function signedInTitle(base: string, account: SignInAccount): string {
    return `${base} (signed in as ${account.who})`;
}

export function signedInPreconditions(account: SignInAccount): string[] {
    return [account.role ? `A test account named “${account.role}” is set up for this project` : "The project's sign-in details (username and password) are set"];
}

/** The speed budgets string with the session token added. */
export function signedInBudgets(budgets: string | undefined): string {
    return [budgets?.trim(), SIGNED_IN_SPEED_TOKEN].filter(Boolean).join(" ");
}

// ── classify ─────────────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * When a signed-in spec failed in its sign-in part, the reason in plain words; otherwise undefined. Such a run is a plain
 * validation failure, never a finding: the page under test was never reached.
 */
export function signInFailure(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status === "passed" || run.status === "skipped") return undefined;
    let last = -1;
    spec.steps.forEach((s, i) => {
        if (s.description?.startsWith(SIGN_IN_STEP_PREFIX)) last = i;
    });
    if (last < 0) return undefined;
    const failed = run.steps.find((s) => s.status === "failed");
    if (!failed || failed.index > last) return undefined;
    const step = spec.steps[failed.index];
    const who = /^Signed in as (.+?): /.exec(spec.steps[last]!.description ?? "")?.[1] ?? "the account";
    const desc = step?.description ?? "";
    if (desc.startsWith(SIGN_IN_STEP_PREFIX) && desc.includes("no sign-in form")) return `Could not sign in as ${who}: the sign-in form was still shown after the sign-in details were submitted. Check the account's username and password (and whether the app asks for anything more).`;
    if (desc.startsWith(SIGN_IN_STEP_PREFIX) && desc.includes("one-time code")) return `Could not sign in as ${who}: the one-time code was not accepted. Check the authenticator secret and this computer's clock.`;
    return `Could not sign in as ${who}: the step "${clip(failed.title, 120)}" did not work (${clip((failed.error ?? run.error ?? "no details").split("\n")[0]!, 160)}).`;
}
