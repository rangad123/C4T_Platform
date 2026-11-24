/**
 * Signing in before discovery, unattended: find the sign-in form (on the page, behind a "Log in" link, or at a usual
 * address), fill in the project's credentials, pass a one-time-code step when there is one, and decide whether it worked.
 * No model is involved: the form is found from its password field.
 */
import type { Page } from "playwright";
import { activityLine } from "../frames/activity.js";
import type { FrameSink } from "../frames/sink.js";
import { secondsLeft, totp } from "../identity/totp.js";
import { settle, type BrowserSession } from "./browser.js";
import { captchaMessage, detectCaptcha } from "../auth/captcha.js";

export interface Credentials {
    username: string;
    password: string;
    /** Authenticator-app secret (base32). Lets the login pass a one-time-code step (TOTP only; no email/SMS codes). */
    totpSecret?: string;
}

export interface LoginResult {
    ok: boolean;
    error?: string;
    loginPath?: string;
    /** Where a successful login landed (e.g. /inventory.html). Often the real entry point of the app. */
    landingUrl?: string;
    mechanisms: string[];
    /** With LoginOptions.loginPath: signed in there ("used"), no sign-in form there ("not-found"), or the sign-in failed there ("failed"). */
    remembered?: "used" | "not-found" | "failed";
}

/** A link or button that leads to the sign-in form. */
const TO_SIGN_IN = /(log|sign)\s?in|account/i;
/** The button that sends the form, when it is not a submit button. */
const SEND_FORM = /(log|sign)\s?in|submit|continue|enter/i;
/** Text only a signed-in person sees. */
const SIGNED_IN_TEXT = /(log|sign)\s?out|my account|dashboard|profile|welcome/i;
/** Usual addresses of a sign-in page, tried when the start page has neither the form nor a link to it. */
const SIGN_IN_PATHS = ["/login", "/signin", "/sign-in", "/auth/login", "/account/login", "/users/sign_in"];

/** An input that asks for a one-time code (autocomplete hint, or a name / id / placeholder that says so). */
const OTP_FIELD =
    'input[autocomplete="one-time-code"]:visible, input[name*="otp" i]:visible, input[name*="totp" i]:visible, input[name*="2fa" i]:visible, input[name*="mfa" i]:visible, input[name*="verif" i]:visible, input[name="code" i]:visible, input[id*="otp" i]:visible, input[id*="code" i]:visible, input[placeholder*="code" i]:visible';

/**
 * If the app now asks for a one-time code, enter the current one. Returns undefined when no code was asked for, or an
 * error message. Never waits for a code that is about to expire: it uses the next window instead.
 */
async function passOneTimeCode(page: Page, secret: string | undefined): Promise<{ asked: boolean; error?: string }> {
    // A password field still on screen means this is (still) the login form, not a second step.
    if ((await hasPasswordField(page)) || !(await page.locator(OTP_FIELD).first().count())) return { asked: false };
    if (!secret) return { asked: true, error: "The login asks for a one-time code, but no authenticator secret (TOTP) was provided for this project." };
    if (secondsLeft() < 3) await new Promise((r) => setTimeout(r, secondsLeft() * 1000 + 150));
    const field = page.locator(OTP_FIELD).first();
    let code: string;
    try {
        code = totp(secret);
    } catch (e) {
        return { asked: true, error: e instanceof Error ? e.message : String(e) };
    }
    await field.fill(code);
    const form = field.locator("xpath=ancestor::form[1]");
    const root = (await form.count()) > 0 ? form : page;
    const submit = root.locator("button[type=submit]:visible, input[type=submit]:visible").or(root.getByRole("button", { name: /verify|confirm|continue|submit|log\s?in|sign\s?in/i })).first();
    const beforeCode = page.url();
    const sent = watchSubmit(page);
    if (await submit.count()) await submit.click({ timeout: 5_000 }).catch(() => undefined);
    else await field.press("Enter");
    await sent.outcome(beforeCode, async () => (await page.locator(OTP_FIELD).first().count()) > 0);
    // Still being asked: the code was not accepted.
    if (await page.locator(OTP_FIELD).first().count()) return { asked: true, error: "The one-time code was not accepted. Check that the authenticator secret belongs to this account and that this computer's clock is correct." };
    return { asked: true };
}

/**
 * Wait for what sending a sign-in form (or a code step) led to, instead of judging the page right after the click: a form sent by a
 * script (fetch, then `location.href`) has not navigated yet when the click returns, and the already-loaded page gives `settle()` nothing
 * to wait for. `watchSubmit` starts listening before the click (the request may be answered during it); `outcome` then waits until the
 * form is gone, the address changed, or the page has been quiet for a second after its last request (a wrong password shown in place, so
 * a failure is not held for the whole deadline). A main-frame navigation that has started is always waited for. Bounded by `deadlineMs`.
 * Only waits: it clicks, types and sends nothing.
 */
function watchSubmit(page: Page) {
    let pending = 0;
    let lastActivity = Date.now();
    /** Main-frame navigation requests not answered yet (a redirect's hops each count until answered). */
    const navigations = new Set<unknown>();
    const isMainNavigation = (r: { isNavigationRequest(): boolean; frame(): unknown }): boolean => {
        try {
            return r.isNavigationRequest() && r.frame() === page.mainFrame();
        } catch {
            return false; // a request without a frame (a service worker's)
        }
    };
    const onRequest = (r: { isNavigationRequest(): boolean; frame(): unknown }) => {
        pending++;
        lastActivity = Date.now();
        if (isMainNavigation(r)) navigations.add(r);
    };
    const onDone = (r: unknown) => {
        pending = Math.max(0, pending - 1);
        lastActivity = Date.now();
        navigations.delete(r);
    };
    const onResponse = (resp: { request(): unknown }) => navigations.delete(resp.request());
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfinished", onDone);
    page.on("requestfailed", onDone);
    const stop = () => {
        page.off("request", onRequest);
        page.off("response", onResponse);
        page.off("requestfinished", onDone);
        page.off("requestfailed", onDone);
    };
    return {
        async outcome(preUrl: string, stillForm: () => Promise<boolean>, deadlineMs = 15_000): Promise<void> {
            const end = Date.now() + deadlineMs;
            try {
                while (Date.now() < end) {
                    if (navigations.size === 0) {
                        if (page.url() !== preUrl) break;
                        if (!(await stillForm().catch(() => true))) break;
                        if (pending === 0 && Date.now() - lastActivity >= 1_000) break;
                    }
                    await new Promise((r) => setTimeout(r, 100));
                }
            } finally {
                stop();
            }
            await settle(page, 8_000);
        },
    };
}

/** Does the current page contain a visible password field (i.e. is it a login/sign-up form)? */
export async function hasPasswordField(page: Page): Promise<boolean> {
    return (await page.locator("input[type=password]:visible").count().catch(() => 0)) > 0;
}

async function navigateToLogin(page: Page): Promise<boolean> {
    if (await hasPasswordField(page)) return true;
    const way = page.getByRole("link", { name: TO_SIGN_IN }).or(page.getByRole("button", { name: TO_SIGN_IN })).first();
    if (await way.isVisible().catch(() => false)) {
        await way.click({ timeout: 5_000 }).catch(() => undefined);
        // A sign-in form a script shows after the click (a client-side route, a dialog) needs a moment to appear.
        await page.locator("input[type=password]:visible").first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
        await settle(page);
        if (await hasPasswordField(page)) return true;
    }
    for (const path of SIGN_IN_PATHS) {
        const res = await page.goto(new URL(path, page.url()).toString(), { waitUntil: "domcontentloaded" }).catch(() => null);
        if (res && res.status() < 400) {
            await settle(page);
            if (await hasPasswordField(page)) return true;
        }
    }
    return false;
}

export interface LoginOptions {
    /**
     * Reuse earlier runs: the sign-in page the last exploration found. It is opened first; the form is still filled and the result still
     * checked. No sign-in form there, or the sign-in failed there while the usual search finds another page: the usual search is used.
     */
    loginPath?: string;
}

export async function login(session: BrowserSession, startUrl: string, creds: Credentials, frames?: FrameSink, opts: LoginOptions = {}): Promise<LoginResult> {
    const { page } = session;
    let remembered: LoginResult["remembered"];
    if (opts.loginPath) {
        const res = await page.goto(new URL(opts.loginPath, startUrl).toString(), { waitUntil: "domcontentloaded" }).catch(() => null);
        await settle(page);
        if (res && res.status() < 400 && (await hasPasswordField(page))) {
            const r = await signInHere(page, creds, frames);
            if (r.ok) return { ...r, remembered: "used" };
            remembered = "failed";
            // The usual search, and a second try only on another page (the same form twice would only fail twice).
            const other = await findSignIn(page, startUrl);
            if (!other.ok || new URL(page.url()).pathname === r.loginPath) return { ...r, remembered };
            return { ...(await signInHere(page, creds, frames)), remembered };
        }
        remembered = "not-found";
    }
    const found = await findSignIn(page, startUrl);
    if (!found.ok) return { ...found.result, ...(remembered ? { remembered } : {}) };
    return { ...(await signInHere(page, creds, frames)), ...(remembered ? { remembered } : {}) };
}

/** Open the start page and find the sign-in form from there (links, buttons, the usual addresses). */
async function findSignIn(page: Page, startUrl: string): Promise<{ ok: true } | { ok: false; result: LoginResult }> {
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await settle(page);
    if (await navigateToLogin(page)) return { ok: true };
    const captcha = await detectCaptcha(page);
    return { ok: false, result: { ok: false, error: captcha ? captchaMessage(captcha, new URL(page.url()).pathname) : "No login form found", mechanisms: captcha ? ["captcha"] : [] } };
}

/** Fill and send the sign-in form on the page now open, and check that it worked. */
async function signInHere(page: Page, creds: Credentials, frames?: FrameSink): Promise<LoginResult> {
    const loginPath = new URL(page.url()).pathname;
    // A captcha is never solved: the sign-in stops with a plain finding (hard sign-ins, ../auth/captcha.ts).
    const captcha = await detectCaptcha(page);
    if (captcha) return { ok: false, error: captchaMessage(captcha, loginPath), loginPath, mechanisms: ["form", "captcha"] };
    const preUrl = page.url();

    const pw = page.locator("input[type=password]:visible").first();
    const scope = pw.locator("xpath=ancestor::form[1]");
    const root = (await scope.count()) > 0 ? scope : page;
    const user = root
        .locator('input[type=email]:visible, input[type=text]:visible, input[type=tel]:visible, input:not([type]):visible')
        .first();

    if (!(await user.count())) return { ok: false, error: "Login form has no username/email field", loginPath, mechanisms: ["form"] };
    await user.fill(creds.username);
    await pw.fill(creds.password);
    // The Explorer view (when someone watches): the form filled in; the password field is covered in the picture.
    await frames?.capture(page, { note: activityLine({ kind: "typedSignIn" }), phase: "signing-in", pagesSeen: 0 });

    const submit = root
        .locator('button[type=submit]:visible, input[type=submit]:visible')
        .or(root.getByRole("button", { name: SEND_FORM }))
        .first();
    // The outcome, not the page as it is right after the click (a script-sent form navigates later).
    const sent = watchSubmit(page);
    if (await submit.count()) await submit.click({ timeout: 5_000 }).catch(() => undefined);
    else await pw.press("Enter");
    await sent.outcome(preUrl, () => hasPasswordField(page));

    const otp = await passOneTimeCode(page, creds.totpSecret);
    if (otp.error) return { ok: false, error: otp.error, loginPath, mechanisms: ["form", "totp"] };

    const ok = await signedIn(page, preUrl);
    await frames?.capture(page, { note: activityLine({ kind: ok ? "signedIn" : "signInFailed" }), phase: "signing-in", pagesSeen: 0 });
    return ok
        ? { ok: true, loginPath, landingUrl: page.url(), mechanisms: otp.asked ? ["form", "totp", "session-cookie"] : ["form", "session-cookie"] }
        : { ok: false, error: "Login did not succeed with the supplied credentials", loginPath, mechanisms: ["form"] };
}

/** A sign-in form on the page: a visible password field with a visible name or email field in its own form (a change-password form has none). */
async function signInFormShowing(page: Page): Promise<boolean> {
    return page
        .locator("input[type=password]:visible")
        .evaluateAll((pws) => pws.some((pw) => Array.from((pw.closest("form") ?? document.body).querySelectorAll("input")).some((i) => ["text", "email", "tel"].includes((i.getAttribute("type") ?? "text").toLowerCase()) && i.getClientRects().length > 0)))
        .catch(() => false);
}

/**
 * Did the sign-in work? Not while the form is still showing (it came back, usually with an error): on the same address any password
 * field, on another one a sign-in form (the account page the practice store opens has a change-password form, N2).
 * Otherwise yes when the app moved to another address, or shows something only a signed-in person sees.
 */
async function signedIn(page: Page, before: string): Promise<boolean> {
    if (page.url() === before ? await hasPasswordField(page) : await signInFormShowing(page)) return false;
    if (page.url() !== before) return true;
    const text = await page.locator("body").innerText().catch(() => "");
    return SIGNED_IN_TEXT.test(text);
}
