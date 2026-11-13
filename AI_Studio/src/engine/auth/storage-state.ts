/**
 * A saved signed-in session: the browser's cookies and local storage after a person signed in by hand (single sign-on, Google or
 * Microsoft sign-in, a captcha they solved). This is Playwright's "storage state". It is as good as a password while it lasts, so it is
 * kept encrypted by the platform, never shown, and only ever written to a run's own folder for the length of the run.
 *
 * This file holds what is the same wherever it runs: the shape with its caps, when the session runs out (the cookies' own expiry), the
 * values that must be masked in anything a run keeps, and the "Still signed in?" judgement on a page opened with the session.
 */
import { z } from "zod";
import type { Browser, Page } from "playwright";
import { detectCaptcha } from "./captcha.js";

export const MAX_STATE_BYTES = 1_000_000;
export const MAX_COOKIES = 300;
export const MAX_ORIGINS = 40;
/** sessionStorage a run hands to the browser (an environment variable: Windows allows about 32,000 characters). */
export const MAX_SESSION_STORAGE_CHARS = 24_000;

/** The sessionStorage of every site in a state, as the init script reads it (empty text: none). */
export function sessionStorageText(state: { origins: Array<{ origin: string; sessionStorage?: Array<{ name: string; value: string }> }> }): string {
    const list = state.origins.filter((o) => o.sessionStorage?.length).map((o) => ({ origin: o.origin, items: o.sessionStorage! }));
    return list.length ? JSON.stringify(list) : "";
}

/** The state as Playwright reads it: what Playwright does not know (sessionStorage, the check page) left out. */
export function playwrightState(state: StorageState): { cookies: StorageState["cookies"]; origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }>; indexedDB?: unknown[] }> } {
    return { cookies: state.cookies, origins: state.origins.map((o) => ({ origin: o.origin, localStorage: o.localStorage, ...(o.indexedDB ? { indexedDB: o.indexedDB } : {}) })) };
}

/**
 * Restores sessionStorage in every page, before the page's own code runs, once per tab (a page that changes or clears it later keeps its
 * change across reloads). Plain JavaScript in a string (bundlers must not rewrite it); called with the parsed `sessionStorageText`.
 */
export const RESTORE_SESSION_STORAGE_SOURCE = `(list) => {
    try {
        const mine = list.find((o) => o.origin === location.origin);
        if (!mine || sessionStorage.getItem("__aitp_restored") === "1") return;
        for (const i of mine.items) sessionStorage.setItem(i.name, i.value);
        sessionStorage.setItem("__aitp_restored", "1");
    } catch {
        /* a page without storage (about:blank, a sandboxed frame) */
    }
}`;
/** The init script for one state's sessionStorage text. */
export const restoreSessionStorageScript = (text: string): string => `(${RESTORE_SESSION_STORAGE_SOURCE})(${text});`;

const Cookie = z.object({
    name: z.string().max(512),
    value: z.string().max(8192),
    domain: z.string().max(253),
    path: z.string().max(1024),
    /** Seconds since 1970; -1 for a cookie that lasts as long as the browser. */
    expires: z.number(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]),
});
const Item = z.object({ name: z.string().max(512), value: z.string().max(100_000) });
const OriginStorage = z.object({
    origin: z.string().max(300),
    localStorage: z.array(Item).max(500),
    /** The site's IndexedDB databases, as Playwright writes them with `storageState({ indexedDB: true })` (Firebase-style sign-ins keep their token there). */
    indexedDB: z.array(z.unknown()).max(50).optional(),
    /**
     * The site's sessionStorage (not part of Playwright's storage state): restored by an init script before the site's own code runs (see
     * ./run-session.ts). Kept small, because a run hands it to the browser in an environment variable.
     */
    sessionStorage: z.array(Item).max(200).optional(),
});
export const StorageStateSchema = z
    .object({
        cookies: z.array(Cookie).max(MAX_COOKIES),
        origins: z.array(OriginStorage).max(MAX_ORIGINS),
        /** The page the "Still signed in?" check opens; a run carries it so a session that runs out can be renewed once (./run-session.ts). */
        checkUrl: z.string().max(2000).optional(),
    })
    .refine((st) => sessionStorageText(st).length <= MAX_SESSION_STORAGE_CHARS, { message: "The saved sign-in's session storage is too large." });
export type StorageState = z.infer<typeof StorageStateSchema>;

export class StorageStateError extends Error {}

/** Reads a storage state from text or a parsed object, with plain refusals. */
export function parseStorageState(raw: unknown): StorageState {
    let value = raw;
    if (typeof raw === "string") {
        if (raw.length > MAX_STATE_BYTES) throw new StorageStateError(`The saved sign-in is too large (more than ${Math.round(MAX_STATE_BYTES / 1000)} KB).`);
        try {
            value = JSON.parse(raw);
        } catch {
            throw new StorageStateError("The saved sign-in is not valid JSON. Use the file Playwright writes with --save-storage, or sign in once yourself.");
        }
    } else if (JSON.stringify(raw ?? null).length > MAX_STATE_BYTES) {
        throw new StorageStateError(`The saved sign-in is too large (more than ${Math.round(MAX_STATE_BYTES / 1000)} KB).`);
    }
    const r = StorageStateSchema.safeParse(value);
    if (!r.success) throw new StorageStateError("The saved sign-in does not look like a browser storage state (cookies and origins).");
    return r.data;
}

/** Does a cookie's domain cover this host (RFC 6265 domain matching, leading dot allowed)? */
export function cookieMatchesHost(domain: string, host: string): boolean {
    const d = domain.replace(/^\./, "").toLowerCase();
    const h = host.toLowerCase();
    return h === d || h.endsWith(`.${d}`);
}

const SESSION_NAME = /sess|auth|token|sid|login|jwt|remember|identity|user/i;

/**
 * When the session runs out, as far as the cookies say: the earliest expiry among the application's session-looking cookies (or among
 * all of its cookies when none looks like one). Undefined when the cookies give no date (they last as long as the browser, or the app
 * keeps its session in local storage): then only the "Still signed in?" check can tell.
 */
export function sessionExpiry(state: StorageState, appUrl: string): Date | undefined {
    const host = new URL(appUrl).hostname;
    const mine = state.cookies.filter((c) => cookieMatchesHost(c.domain, host) && c.expires > 0);
    const pick = mine.filter((c) => SESSION_NAME.test(c.name));
    const list = pick.length ? pick : mine;
    if (!list.length) return undefined;
    return new Date(Math.min(...list.map((c) => c.expires)) * 1000);
}

/** Everything in the session that must never appear in a log, an event, evidence or an answer: cookie and storage values. */
export function secretValuesOf(state: StorageState): string[] {
    const out = new Set<string>();
    for (const c of state.cookies) if (c.value.length >= 6) out.add(c.value);
    for (const o of state.origins) for (const i of [...o.localStorage, ...(o.sessionStorage ?? [])]) if (i.value.length >= 6) out.add(i.value);
    // IndexedDB records: every text in them that is long enough to be a token (the database and store names are left alone).
    const walk = (v: unknown, depth: number) => {
        if (out.size > 5_000 || depth > 12) return;
        if (typeof v === "string") {
            if (v.length >= 8) out.add(v);
        } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
        else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
    };
    for (const o of state.origins) for (const db of o.indexedDB ?? []) for (const store of (db as { stores?: Array<{ records?: unknown[] }> }).stores ?? []) walk(store.records ?? [], 0);
    return [...out];
}

/** What the API may show about a session: never a value. */
export function describeState(state: StorageState, appUrl: string): { cookies: number; sites: string[]; expiresAt?: string } {
    const sites = [...new Set(state.cookies.map((c) => c.domain.replace(/^\./, "")).concat(state.origins.map((o) => safeHost(o.origin))))].filter(Boolean).slice(0, 10);
    const exp = sessionExpiry(state, appUrl);
    return { cookies: state.cookies.length, sites, ...(exp ? { expiresAt: exp.toISOString() } : {}) };
}

function safeHost(origin: string): string {
    try {
        return new URL(origin).host;
    } catch {
        return "";
    }
}

export const SIGN_IN_PATH = /(^|\/)(log-?in|sign-?in|signin|auth|sso|oauth2?|session\/new|account\/login|users\/sign_in)(\/|$|\?)/i;

export interface SignedInVerdict {
    signedIn: boolean;
    /** A plain sentence: why we think so. */
    reason: string;
    /** The check page could not be opened at all (the app is down or unreachable): that says nothing about the session. */
    unreachable?: true;
}

/**
 * Is the page that was opened with the saved session a signed-in page? Signed out = it shows a password field, a captcha, ended on a
 * sign-in address (when the check page itself is not one), or answered 401/403. Anything else is taken as signed in.
 */
export async function judgeSignedIn(page: Page, checkUrl: string, status?: number): Promise<SignedInVerdict> {
    if (status === 401 || status === 403) return { signedIn: false, reason: `The page answered HTTP ${status}.` };
    if ((await page.locator("input[type=password]:visible").count().catch(() => 0)) > 0) return { signedIn: false, reason: "The page asks for a password again." };
    const captcha = await detectCaptcha(page);
    if (captcha) return { signedIn: false, reason: `The page shows a captcha (${captcha}).` };
    const landed = new URL(page.url());
    const wanted = new URL(checkUrl);
    if (landed.origin !== wanted.origin) return { signedIn: false, reason: `The page moved to another site (${landed.host}), which usually means a sign-in page.` };
    if (SIGN_IN_PATH.test(landed.pathname) && !SIGN_IN_PATH.test(wanted.pathname)) return { signedIn: false, reason: `The page moved to a sign-in address (${landed.pathname}).` };
    return { signedIn: true, reason: `The page ${landed.pathname} opened without asking to sign in.` };
}

/**
 * The "Still signed in?" check: opens the check page in a fresh, headless browser context with the saved session and judges it. Nothing
 * is clicked or typed. `browser` is the caller's (it closes it); the context is closed here.
 */
export async function checkStillSignedIn(browser: Browser, state: StorageState, checkUrl: string): Promise<SignedInVerdict> {
    const context = await browser.newContext({ storageState: playwrightState(state), viewport: { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false });
    const session = sessionStorageText(state);
    if (session) await context.addInitScript({ content: restoreSessionStorageScript(session) });
    try {
        const page = await context.newPage();
        const res = await page.goto(checkUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
        return await judgeSignedIn(page, checkUrl, res?.status());
    } catch (e) {
        return { signedIn: false, unreachable: true, reason: `The check page could not be opened: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200)}` };
    } finally {
        await context.close().catch(() => undefined);
    }
}
