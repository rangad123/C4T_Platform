/**
 * Session ends on sign-out (no LLM): a test account signs in, its session cookies are kept in the script's memory, it signs out, and the
 * old cookies are tried again in a fresh browser context on a signed-in API endpoint (or page). Still signed in is a finding: signing out
 * only cleared the browser, not the session on the server. Made only when the app has a sign-out (a documented endpoint or a control the
 * survey saw). Cookie values are never written into a test, a result or a finding; the check holds only addresses and a control's name.
 */
import type { DraftSpec } from "../api/test-specs.js";
import type { Reach } from "./access.js";

/**
 * Script-side check, appended to the access helper (it uses ACCESS_PREFIX, accessSignIn and accessOwnApi from there).
 * cfg = {sessionEnd: true, as, signOut: {api} | {control}, path, api?, origin?, marker?, sev}: path is the signed-in API endpoint
 * (api: true) or page (with its marker) that shows whether the session still works.
 */
export const SESSION_END_HELPER_SOURCE = String.raw`
async function accessSessionEndAssert(page, base, cfg) {
    const browser = page.context().browser();
    if (!browser) throw new Error("A separate browser context could not be opened, so it could not be judged whether the session ends on sign-out.");
    const origin = cfg.origin || new URL(base).origin;
    const own = (path, host) => {
        let u;
        try { u = new URL(String(path), host); } catch { return null; }
        return /^\/(?![\/\\])/.test(String(path)) && !/\\/.test(String(path)) && u.origin === host ? u : null;
    };
    if (cfg.api && !accessOwnApi(origin, base)) throw new Error("The API host " + origin + " in this check is not the application's own address, so it was not called.");
    const target = own(cfg.path, cfg.api ? origin : new URL(base).origin);
    const signOut = cfg.signOut && cfg.signOut.api ? own(cfg.signOut.api, origin) : null;
    if (!target || (cfg.signOut && cfg.signOut.api && !signOut)) throw new Error("The addresses in this check are not the application's own, so nothing was called.");
    const what = (cfg.api ? "GET " : "the page ") + cfg.path;
    const probe = async (ctx) => {
        if (cfg.api) {
            const r = await ctx.request.get(target.toString(), { maxRedirects: 0, failOnStatusCode: false, timeout: 30000 }).catch(() => null);
            return r ? { on: r.status() >= 200 && r.status() < 300, why: "HTTP " + r.status() } : { on: false, why: "no answer" };
        }
        const p = await ctx.newPage();
        try {
            const res = await p.goto(target.toString(), { waitUntil: "load", timeout: 30000 }).catch(() => null);
            const status = res ? res.status() : 0;
            const finalPath = new URL(p.url()).pathname;
            const password = (await p.locator("input[type=password]:visible").count()) > 0;
            const text = ((await p.locator("body").innerText().catch(() => "")) || "").toLowerCase();
            const on = status > 0 && status < 400 && !password && finalPath === target.pathname && text.indexOf(String(cfg.marker).toLowerCase()) >= 0;
            return { on, why: on ? "the page and its content “" + cfg.marker + "” were shown" : "HTTP " + status + (password ? ", a sign-in form" : "") };
        } finally {
            await p.close().catch(() => undefined);
        }
    };
    const ctx = await browser.newContext({ ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS, viewport: { width: 1280, height: 800 } });
    let later;
    try {
        const p = await ctx.newPage();
        await accessSignIn(p, base, cfg.as);
        const before = await probe(ctx);
        if (!before.on) throw new Error("Signed in as “" + cfg.as + "”, " + what + " did not answer as signed in (" + before.why + "), so it could not be judged whether the session ends on sign-out.");
        // The session's cookies, held only here in memory.
        const kept = await ctx.cookies();
        if (signOut) {
            const r = await ctx.request.post(signOut.toString(), { maxRedirects: 0, failOnStatusCode: false, timeout: 30000 }).catch(() => null);
            if (!r || r.status() >= 400) throw new Error("Signing out (POST " + cfg.signOut.api + ") answered " + (r ? "HTTP " + r.status() : "nothing") + ", so it could not be judged whether the session ends on sign-out.");
        } else {
            const name = String(cfg.signOut && cfg.signOut.control || "");
            const control = p.getByRole("button", { name, exact: true }).or(p.getByRole("link", { name, exact: true })).first();
            if (!name || !(await control.isVisible().catch(() => false))) await p.goto(base, { waitUntil: "load" }).catch(() => null);
            if (!name || !(await control.isVisible().catch(() => false))) throw new Error("The “" + name + "” control was not found after signing in as “" + cfg.as + "”, so it could not be judged whether the session ends on sign-out.");
            await control.click({ timeout: 5000 });
            await p.waitForLoadState("load").catch(() => undefined);
            await p.waitForTimeout(500);
        }
        later = await browser.newContext({ ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS, viewport: { width: 1280, height: 800 } });
        await later.addCookies(kept);
        const after = await probe(later);
        if (!after.on) return;
        throw new Error(ACCESS_PREFIX + " 1 session may still work after signing out\n- [" + cfg.sev + "] After the “" + cfg.as + "” account signed out, its old session cookies still opened " + what + " (" + after.why + "), so signing out may end the session only in the browser: check that signing out ends the session on the server");
    } finally {
        await ctx.close().catch(() => undefined);
        if (later) await later.close().catch(() => undefined);
    }
}
`;

const SIGN_OUT_PATH = /(^|\/)(log-?out|sign-?out|log-?off)$/i;
const SIGN_OUT_NAME = /^(log|sign)\s?(out|off)$/i;
export const WHO_AM_I = /(^|\/)(me|whoami|session|account|profile|user)$/i;
const GENERIC = /^(home|welcome|index|menu|dashboard|untitled|page)$/i;

/**
 * At most one check that the session ends on sign-out, as the first test account the survey signed in: the sign-out is a documented POST
 * (/logout, /sign-out ...) or a "Sign out" control the account was shown; the signed-in target is a GET without parameters documented to
 * answer 401 (an address like /me first), else a page the account reached and a visitor did not. Nothing without a sign-out or a target.
 */
export function generateSessionEndSpecs(input: { apis: Array<{ method: string; path: string; statuses?: number[] }>; reach: Reach[]; origin?: string }): DraftSpec[] {
    const anon = input.reach.find((r) => r.who === "anonymous");
    const account = input.reach.find((r) => r.who !== "anonymous" && !r.incomplete);
    if (!account) return [];
    const plain = input.apis.filter((a) => !a.path.includes("{"));
    const signOutApi = plain.find((a) => a.method === "POST" && SIGN_OUT_PATH.test(a.path))?.path;
    const control = account.controls?.flatMap((c) => c.names).find((n) => SIGN_OUT_NAME.test(n.trim()));
    if (!signOutApi && !control) return [];
    const gets = plain.filter((a) => a.method === "GET" && a.statuses?.includes(401) && !SIGN_OUT_PATH.test(a.path));
    const api = (gets.find((a) => WHO_AM_I.test(a.path)) ?? gets[0])?.path;
    const page = api || !anon ? undefined : account.pages.find((p) => p.path !== "/" && !anon.pages.some((q) => q.path === p.path) && p.heading.length >= 4 && p.heading.length <= 80 && !GENERIC.test(p.heading));
    if (!api && !page) return [];
    const what = api ? `GET ${api}` : `the page ${page!.path}`;
    const how = signOutApi ? `signs out (POST ${signOutApi})` : `signs out with its “${control}” control`;
    const cfg = { sessionEnd: true, as: account.who, signOut: signOutApi ? { api: signOutApi } : { control: control!.trim() }, ...(api ? { api: true, path: api, ...(input.origin ? { origin: input.origin } : {}) } : { path: page!.path, marker: page!.heading }), sev: "high" };
    return [
        {
            title: `“${account.who}” account: the session ends on sign-out`,
            description: `The “${account.who}” account signs in, checks that ${what} answers as signed in, then ${how}. Its old session cookies, kept only in the script's memory, are tried again in a fresh browser: fails if ${what} still answers as signed in. The cookies are never stored.`,
            kind: "web",
            category: "Access control",
            type: "security",
            priority: "high",
            preconditions: [`A test account named “${account.who}” is set up for this project`],
            steps: [
                { action: "navigate", url: "/", description: "Start at the home page" },
                { action: "assert", check: "accessDenied", expected: JSON.stringify(cfg), description: `After signing out, the “${account.who}” account's old session no longer opens ${what}` },
            ],
            expectedResults: [`After signing out, ${what} is refused to the old session (HTTP 401 or 403, or the sign-in page)`],
            testData: {},
            tags: ["security", "access-control", "session"],
            source: { origin: "access-check" },
        },
    ];
}
