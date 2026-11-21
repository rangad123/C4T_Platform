/**
 * Access-control checks: can someone open a page they should not be able to open? (no LLM)
 *
 * How it works, in three honest steps:
 *  1. SURVEY (discovery): the app is crawled a little as "not signed in" and as each named test account, recording which
 *     pages each of them can reach and the heading of each page.
 *  2. GENERATE: a page reached by a more privileged account (one that reaches strictly more pages) but not by a lesser
 *     account — or by any account but not anonymously — becomes a check: "<lesser account> cannot open <page>". The page's
 *     heading is the marker: if that heading is shown to the lesser account, the page is open to it.
 *  3. EXECUTE (in the generated script): a fresh browser context signs in as the lesser account (including a one-time code),
 *     opens the page directly by address, and decides: denied (HTTP 401/403/404, redirected to a sign-in or error page, a
 *     sign-in form, an "access denied" message, or the marker not shown) or open (the marker is shown).
 *
 * It is a heuristic and says so: "possible broken access control — check that this page is meant to be open to them". A page
 * that is simply public but was not linked where the crawl looked can be flagged. Severity reflects that: a page whose address
 * looks privileged (/admin, /users, /billing, /settings...) is high, anything else low. Only GET requests are made.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Browser, Response } from "playwright";
import type { DraftSpec } from "../api/test-specs.js";
import type { EngineContext } from "../context.js";
import { login } from "../discovery/auth.js";
import { BrowserSession } from "../discovery/browser.js";
import { crawl, type CrawlOptions, type CrawlResult } from "../discovery/crawler.js";
import { isApiRequest } from "../discovery/network.js";
import { ownAppHost } from "../../shared/app-host.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "../validation/runner.js";

/** First words of every access-control failure; the finding classifier keys on it. */
export const ACCESS_FAILURE_PREFIX = "Access control check failed:";

export const ACCESS_HELPER_SOURCE = String.raw`const ACCESS_PREFIX = ${JSON.stringify(ACCESS_FAILURE_PREFIX)};
const ACCESS_OTP = 'input[autocomplete="one-time-code"]:visible, input[name*="otp" i]:visible, input[name*="totp" i]:visible, input[name*="2fa" i]:visible, input[name*="mfa" i]:visible, input[name*="verif" i]:visible, input[name="code" i]:visible, input[id*="otp" i]:visible, input[id*="code" i]:visible, input[placeholder*="code" i]:visible';

function accessEnv(role) {
    const k = "TEST_" + role.toUpperCase().replace(/-/g, "_");
    return { username: process.env[k + "_USERNAME"] || "", password: process.env[k + "_PASSWORD"] || "", totp: process.env[k + "_TOTP_SECRET"] || "" };
}

/** Sign in as a named test account in a fresh page. Throws a plain explanation when that is not possible. */
async function accessSignIn(p, base, role) {
    const c = accessEnv(role);
    if (!c.username || !c.password) throw new Error("No sign-in details are set for the test account “" + role + "”.");
    const hasPw = async () => (await p.locator("input[type=password]:visible").count()) > 0;
    await p.goto(base, { waitUntil: "domcontentloaded" });
    if (!(await hasPw())) {
        const link = p.getByRole("link", { name: /log\s?in|sign\s?in/i }).or(p.getByRole("button", { name: /log\s?in|sign\s?in/i })).first();
        if (await link.isVisible().catch(() => false)) {
            await link.click({ timeout: 5000 }).catch(() => undefined);
            await p.waitForLoadState("load").catch(() => undefined);
        }
    }
    if (!(await hasPw())) {
        for (const path of ["/login", "/signin", "/sign-in", "/auth/login", "/account/login", "/users/sign_in"]) {
            const r = await p.goto(new URL(path, base).toString(), { waitUntil: "domcontentloaded" }).catch(() => null);
            if (r && r.status() < 400 && (await hasPw())) break;
        }
    }
    if (!(await hasPw())) throw new Error("Could not find the sign-in form to sign in as “" + role + "”.");
    const pw = p.locator("input[type=password]:visible").first();
    const form = pw.locator("xpath=ancestor::form[1]");
    const root = (await form.count()) > 0 ? form : p;
    const user = root.locator("input[type=email]:visible, input[type=text]:visible, input[type=tel]:visible, input:not([type]):visible").first();
    await user.fill(c.username);
    await pw.fill(c.password);
    const submit = root.locator("button[type=submit]:visible, input[type=submit]:visible").or(root.getByRole("button", { name: /log\s?in|sign\s?in|submit|continue/i })).first();
    if (await submit.count()) await submit.click({ timeout: 5000 }).catch(() => undefined);
    else await pw.press("Enter");
    await p.waitForLoadState("load").catch(() => undefined);
    await p.waitForTimeout(500);
    if (!(await hasPw()) && (await p.locator(ACCESS_OTP).first().count())) {
        if (!c.totp) throw new Error("Signing in as “" + role + "” needs a one-time code, but no authenticator secret is set for it.");
        const field = p.locator(ACCESS_OTP).first();
        await field.fill(totpCode(c.totp));
        const f2 = field.locator("xpath=ancestor::form[1]");
        const r2 = (await f2.count()) > 0 ? f2 : p;
        const s2 = r2.locator("button[type=submit]:visible, input[type=submit]:visible").or(r2.getByRole("button", { name: /verify|confirm|continue|submit|log\s?in|sign\s?in/i })).first();
        if (await s2.count()) await s2.click({ timeout: 5000 }).catch(() => undefined);
        else await field.press("Enter");
        await p.waitForLoadState("load").catch(() => undefined);
        await p.waitForTimeout(500);
    }
    if ((await hasPw()) || (await p.locator(ACCESS_OTP).first().count())) throw new Error("Could not sign in as “" + role + "”: the sign-in details were not accepted.");
}

/**
 * spec = JSON {as, path, marker, by, sev, of?, pattern?}: as = "anonymous" or a test account name; by = who normally reaches the page;
 * of = for a record of another account of the same kind (horizontal), the account it belongs to, and pattern = the address kind.
 * Opens the page directly in a fresh browser context and fails only when its marker is shown to someone it should be hidden from.
 */
async function accessAssert(page, base, spec) {
    const cfg = JSON.parse(spec);
    if (cfg.api) return await accessApiAssert(page, base, cfg);
    // The page must be one of the application's own (the address the run was started for): a path that names its own host
    // ("//other.example/x", "http://10.0.0.5/") or a scheme is refused before anything is opened, like a request step's address.
    const home = new URL(base).origin;
    const pagePath = typeof cfg.path === "string" ? cfg.path.split(/[?#]/)[0] : "";
    let pageTarget;
    try { pageTarget = new URL(String(cfg.path), base); } catch { pageTarget = null; }
    if (!/^\/(?![\/\\])/.test(pagePath) || /\\/.test(pagePath) || !pageTarget || pageTarget.origin !== home) throw new Error("The address " + cfg.path + " is not a page of the application (" + home + "), so it was not opened and it could not be judged whether it is open to “" + cfg.as + "”.");
    const browser = page.context().browser();
    const ctx = browser ? await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } }) : page.context();
    const p = await ctx.newPage();
    try {
        if (cfg.as !== "anonymous") await accessSignIn(p, base, cfg.as);
        const res = await p.goto(pageTarget.toString(), { waitUntil: "load", timeout: 30000 }).catch(() => null);
        await p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
        const status = res ? res.status() : 0;
        const finalPath = new URL(p.url()).pathname;
        const hasPassword = (await p.locator("input[type=password]:visible").count()) > 0;
        const text = (await p.locator("body").innerText().catch(() => "")) || "";
        const redirectedAway = finalPath !== cfg.path && /log-?in|sign-?in|auth|forbidden|denied|unauthori[sz]ed|\b40[13]\b/i.test(finalPath);
        const deniedText = /access denied|forbidden|not authori[sz]ed|insufficient permission|you (?:do not|don't) have (?:access|permission)/i.test(text);
        const shown = text.toLowerCase().indexOf(String(cfg.marker).toLowerCase()) >= 0;
        // A page that could not be loaded at all, an error status, a sign-in redirect/form, or no trace of the marker: not open.
        if (status === 0 || status >= 400 || redirectedAway || hasPassword || deniedText || !shown) return;
        if (cfg.of) throw new Error(ACCESS_PREFIX + " 1 record may be open to another account\n- [" + cfg.sev + "] A signed-in “" + cfg.as + "” user can open " + cfg.path + " and see “" + cfg.marker + "”, which belongs to the “" + cfg.of + "” account (each account reaches its own records at addresses like " + cfg.pattern + "), so this is possible broken access control between accounts: check that one account cannot open another account's records");
        const who = cfg.as === "anonymous" ? "Anyone who is not signed in" : "A signed-in “" + cfg.as + "” user";
        throw new Error(ACCESS_PREFIX + " 1 page may be open to someone who should not see it\n- [" + cfg.sev + "] " + who + " can open " + cfg.path + " and see “" + cfg.marker + "”. It is normally reached only by " + (cfg.by === "anonymous" ? "visitors" : "“" + cfg.by + "”") + ", so this is possible broken access control: check that this page is meant to be open to them");
    } finally {
        await p.close().catch(() => undefined);
        if (browser) await ctx.close().catch(() => undefined);
    }
}

/**
 * Same-level API check: is another account's record readable through the API by cfg.as? The check stores no values and no
 * fingerprints of them, only which fields held the owner's content (cfg.evidence: field name, length, a preview without characters).
 * So each run first reads the record as its owner (cfg.of) and keeps that account's values of those fields in memory, then makes one
 * GET as cfg.as. It is open only when that answer is a 2xx JSON body holding one of the owner's values. Any other answer (refused,
 * redirected, not JSON, none of the owner's values) is not open. When the owner's own read does not give its record, nothing can be
 * judged and the check says so (it is not a finding). The address must stay on the recorded API host. GET only; nothing is changed.
 */
async function accessApiAssert(page, base, cfg) {
    const where = (cfg.origin || "") + cfg.path;
    const origin = cfg.origin || new URL(base).origin;
    // The API host comes from the check's own settings, which a person can edit: it is called only when it is the application's own
    // (the address the run was started for, or its API address; the same machine name on another port counts, as when it was recorded).
    if (!accessOwnApi(origin, base)) throw new Error("The API host " + origin + " in this check is not the application's own address (" + new URL(base).origin + ") or its API address, so it was not called and it could not be judged whether GET " + where + " is open to “" + cfg.as + "”. If it is the application's API, set it as the project's API address.");
    const q = cfg.path.indexOf("?");
    const pathOnly = q < 0 ? cfg.path : cfg.path.slice(0, q);
    // A path that names its own host ("//other.example/x", "/\\other.example/x") or a scheme would send the account's API credentials elsewhere.
    let target;
    try { target = new URL(pathOnly, origin); } catch { target = null; }
    if (!/^\/(?![\/\\])/.test(pathOnly) || /\\/.test(pathOnly) || !target || target.origin !== origin) throw new Error("The address " + where + " is not a path on the application's API host (" + origin + "), so it was not called and it could not be judged whether it is open to “" + cfg.as + "”.");
    if (!cfg.of) throw new Error("The check does not name the account the record belongs to, so it could not be judged whether GET " + where + " is open to “" + cfg.as + "”.");
    const evidence = (cfg.evidence || []).map((e) => {
        const m = /\((\d+) characters\)/.exec(e.mask || "");
        return { key: e.key, length: typeof e.length === "number" ? e.length : m ? Number(m[1]) : -1 };
    });
    const ownerRead = await accessApiRead(page, base, cfg, cfg.of, origin, target, where);
    if (!ownerRead || ownerRead.body === undefined) throw new Error("The “" + cfg.of + "” account's own GET " + where + " was not answered with its record (" + (ownerRead ? "HTTP " + ownerRead.status : "no answer") + "), so it could not be judged whether it is open to “" + cfg.as + "”.");
    const ownerValues = new Map();
    accessWalk(ownerRead.body, "", (v, key) => {
        const e = evidence.find((x) => x.key === key && x.length === v.length);
        if (e && !ownerValues.has(v)) ownerValues.set(v, e);
    });
    if (!ownerValues.size) throw new Error("The “" + cfg.of + "” account's own GET " + where + " no longer holds the content it had when this check was made, so it could not be judged whether it is open to “" + cfg.as + "”. Generate the access checks again.");
    const read = await accessApiRead(page, base, cfg, cfg.as, origin, target, where);
    if (!read || read.body === undefined) return;
    const hits = new Map();
    accessWalk(read.body, "", (v) => { if (ownerValues.has(v)) hits.set(v, ownerValues.get(v)); });
    if (!hits.size) return;
    const shown = [...new Set([...hits.values()])].map((e) => e.key + ": " + "•".repeat(Math.min(6, Math.max(1, e.length))) + " (" + e.length + " characters)").join("; ");
    throw new Error(ACCESS_PREFIX + " 1 record may be open to another account\n- [" + cfg.sev + "] A signed-in “" + cfg.as + "” user can call GET " + where + " (HTTP " + read.status + ") and the answer holds content of a record that belongs to the “" + cfg.of + "” account (" + shown + "; values masked, compared with the “" + cfg.of + "” account's own answer in this run only). Each account reaches its own records through addresses like " + cfg.pattern + ", so this is possible broken access control between accounts: check that the API refuses one account's records to another account");
}

/**
 * Whether an origin is the application's own: http(s) on the machine name of the run's address or of its API address (API_BASE_URL), or
 * under the app's own name (api.shop.example for shop.example or www.shop.example). Another host of the same site that is not under it
 * (api.shop.example for app.shop.example) counts only once it is the project's API address: without the public suffix list here,
 * shop-b.herokuapp.com must never pass for shop-a.herokuapp.com's.
 */
function accessOwnApi(origin, base) {
    let o;
    try { o = new URL(origin); } catch { return false; }
    if ((o.protocol !== "http:" && o.protocol !== "https:") || o.origin !== String(origin).replace(/\/+$/, "")) return false;
    const h = o.hostname.toLowerCase();
    const hostOf = (u) => { try { return u ? new URL(u).hostname.toLowerCase() : ""; } catch { return ""; } };
    const app = hostOf(base);
    const under = (name) => !!name && !/^[\d.]+$|^\[|:/.test(name) && name.includes(".") && h.endsWith("." + name);
    return h === app || h === hostOf(process.env.API_BASE_URL) || under(app) || under(app.replace(/^www\./, ""));
}

/** Every trimmed string in a JSON answer with the name of the field holding it (an array keeps its field's name). Bounded. */
function accessWalk(body, key0, visit) {
    let leaves = 0;
    const walk = (v, key, depth) => {
        if (depth > 8 || leaves > 5000 || v === null || v === undefined) return;
        if (typeof v === "string") { leaves++; visit(v.trim(), key); }
        else if (Array.isArray(v)) for (const x of v) walk(x, key, depth + 1);
        else if (typeof v === "object") for (const k of Object.keys(v)) walk(v[k], k, depth + 1);
    };
    walk(body, key0, 0);
}

/**
 * One GET of the record as one account (or anonymously), in its own fresh browser context: signs in, takes that account's own
 * Authorization header and its own values of the address's secret-named query parameters (cfg.secrets) from the app's calls to the API
 * host, and calls target. Returns the status and the JSON body (undefined when not 2xx JSON), or null when there was no answer.
 */
async function accessApiRead(page, base, cfg, who, origin, target, where) {
    const browser = page.context().browser();
    if (!browser) throw new Error("A separate browser context could not be opened, so it could not be judged whether GET " + where + " is open to “" + cfg.as + "”.");
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    let auth = "";
    const own = {};
    const secrets = cfg.secrets || [];
    const seen = (r) => {
        try {
            const u = new URL(r.url());
            if (u.origin !== origin) return;
            const h = r.headers()["authorization"];
            if (h) auth = h;
            for (const k of secrets) { const v = u.searchParams.get(k); if (v) own[k] = v; }
        } catch {}
    };
    if (cfg.header || secrets.length) p.on("request", seen);
    try {
        if (who !== "anonymous") await accessSignIn(p, base, who);
        const missing = () => secrets.filter((k) => !own[k]);
        if (((cfg.header && !auth) || missing().length) && cfg.page) {
            await p.goto(new URL(cfg.page, base).toString(), { waitUntil: "load", timeout: 30000 }).catch(() => null);
            await p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
        }
        if (cfg.header && !auth) throw new Error("The app's own calls for the “" + who + "” account carried no API credentials after signing in, so it could not be judged whether GET " + where + " is open to “" + cfg.as + "”.");
        if (missing().length) throw new Error("The app's own calls for the “" + who + "” account carried no value of its own for " + missing().join(", ") + " after signing in, so it could not be judged whether GET " + where + " is open to “" + cfg.as + "”.");
        // The address as stored has its secret-named query values masked: each is replaced by this account's own value.
        const url = new URL(target.toString());
        const q = cfg.path.indexOf("?");
        if (q >= 0) url.search = cfg.path.slice(q + 1).split("&").map((pair) => {
            const i = pair.indexOf("=");
            const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, " "));
            return secrets.includes(k) ? encodeURIComponent(k) + "=" + encodeURIComponent(own[k]) : pair;
        }).join("&");
        if (url.origin !== origin) throw new Error("The address " + where + " is not on the application's API host, so it was not called.");
        const res = await ctx.request.get(url.toString(), { headers: auth ? { authorization: auth } : {}, maxRedirects: 0, failOnStatusCode: false, timeout: 30000 }).catch(() => null);
        if (!res) return null;
        const status = res.status();
        if (status < 200 || status >= 300) return { status, body: undefined };
        try { return { status, body: JSON.parse(await res.text()) }; } catch { return { status, body: undefined }; }
    } finally {
        p.off("request", seen);
        await p.close().catch(() => undefined);
        await ctx.close().catch(() => undefined);
    }
}
`;

/** Script-side check for API endpoints: the answer to a request must be a refusal. */
export const ACCESS_API_HELPER_SOURCE = String.raw`const ACCESS_API_PREFIX = ${JSON.stringify(ACCESS_FAILURE_PREFIX)};
/** spec = JSON {as, path, by, sev}. Refusal = 401 / 403 / 404 / redirect. A 2xx is open to someone who may be restricted. */
function accessStatusAssert(last, spec) {
    const cfg = JSON.parse(spec);
    const s = last.status;
    if (s === 401 || s === 403 || s === 404 || (s >= 300 && s < 400)) return;
    if (s < 200 || s >= 300) throw new Error("The endpoint answered HTTP " + s + ", so it could not be judged whether it is open or closed.");
    const who = cfg.as === "anonymous" ? "A caller without credentials" : "A caller with the “" + cfg.as + "” account\u2019s token";
    throw new Error(ACCESS_API_PREFIX + " 1 endpoint may be open to someone who should not call it\n- [" + cfg.sev + "] " + who + " can call GET " + cfg.path + " (HTTP " + s + "). It is normally reached only by " + (cfg.by === "anonymous" ? "visitors" : "“" + cfg.by + "”") + ", so this is possible broken access control: check that this endpoint is meant to be open to them");
}
`;

export const ACCESS_ADVICE =
    "Decide on the server, for every request, whether the signed-in person may see the page, and answer with the sign-in page or HTTP 403 when not. Hiding a link in the menu is not access control. If the page is meant to be public, ignore this finding.";
export const ACCESS_BASIS = "page open to someone it may be restricted from";

// ── 1. survey ────────────────────────────────────────────────────────────────

export interface RoleLogin {
    name: string;
    username: string;
    password: string;
    totpSecret?: string;
    /** Bearer token for API calls as this account. */
    apiToken?: string;
}

export interface ReachedPage {
    path: string;
    /** First heading (or the title): what identifies the page's content. */
    heading: string;
}

/** What one viewer ("anonymous" or a role name) could reach in a small crawl. */
export interface Reach {
    who: string;
    pages: ReachedPage[];
    /** The account's sign-in asked for an authenticator code (lets signed-in speed / visual checks repeat it). */
    needsCode?: boolean;
    /** Buttons, tabs and menu entries shown on each page reached (role scenarios: "the admin sees Delete"). */
    /**
     * Why this viewer's crawl ended early (the browser crashed): its reach is not the whole of what it can open, so it is never taken
     * as evidence that a page or record is closed to it (no "cannot open" checks are made for it as the viewer).
     */
    incomplete?: string;
    controls?: Array<{ path: string; names: string[] }>;
    /** Record-scoped API reads (GET, an id in the path, a 2xx JSON answer) the app made for this account while it was surveyed. */
    api?: ApiRecordSeen[];
}

/** One record the app read from its own API for a signed-in account. Values are kept only as fingerprints and masked previews. */
export interface ApiRecordSeen {
    /** Address path called, with its query string; the values of secret-named query parameters are masked (•••), never stored. */
    path: string;
    /** The API host's origin when it is not the app's own (a separate API host of the application, see ownApiHost). */
    origin?: string;
    /** Names of the secret-named query parameters in path: the check fills in the viewer's own values. */
    secrets?: string[];
    /** The kind of record, e.g. /api/notes/{} or /v1/note?id={} (with the origin in front for a separate API host). */
    pattern: string;
    /** The page that made the call (to repeat it for the account's own credentials). */
    page: string;
    /** The call carried an Authorization header (the app does not rely on cookies alone). */
    header?: boolean;
    /** Content values of the record: field name, a fingerprint for comparing within the survey, length and masked preview. */
    values: ApiValue[];
}

export interface ApiValue {
    key: string;
    /** Fingerprint under the survey's own random key (newEvidenceKey): compares values within that survey only; never written into a test. */
    hash: string;
    /** Characters in the trimmed value. */
    length: number;
    /** A preview without any of the value's characters: "•••••• (19 characters)". */
    mask: string;
}

/** How big each viewer's crawl is. */
export interface SurveyOptions {
    maxPages: number;
    maxDepth?: number;
    perPattern?: number;
    /** Each viewer's whole crawl, for the screen map (../screenmap/map.ts). */
    onCrawl?: (who: string, result: CrawlResult) => void;
    /** The project's "never ..." notes refuse these controls and links (memory/notes.ts refusedBy). */
    refuse?: CrawlOptions["refuse"];
    /** The project's known API addresses (its API base URL): their hosts count as the application's own API hosts. */
    apiHosts?: string[];
}

/** Fewest pages each viewer's crawl gets, however many accounts share the level's budget. */
export const MIN_ROLE_PAGES = 20;

/** Pages each viewer's crawl may visit: the exploration's page budget split across the accounts, at least MIN_ROLE_PAGES. */
export function rolePageBudget(maxPages: number, roles: number): number {
    return Math.max(MIN_ROLE_PAGES, Math.floor(maxPages / Math.max(1, roles)));
}

const CONTROL_ROLES = new Set(["button", "menuitem", "tab", "checkbox", "switch"]);

const pathOf = (p: { path: string }) => (p.path || "/").split(/[?#]/)[0] || "/";

/** Most API records kept per account, the largest answer read, and the most values kept per record. */
const MAX_API_RECORDS = 40;
const MAX_API_BODY = 256 * 1024;
const MAX_RECORD_VALUES = 20;
/**
 * Field names whose values are credentials or sensitive personal or payment data: never fingerprinted or previewed, and neither is
 * anything nested under such a field ({"credentials": {"value": ...}}).
 */
const SECRET_FIELD =
    /pass(word|phrase)?|secret|token|authoriz|credential|api[-_]?key|private[-_]?key|session|signature|cookie|csrf|ssn|social[-_]?security|national[-_]?id|tax[-_]?id|passport|card[-_]?(num|no|number)|credit[-_]?card|cc[-_]?(num|number)|cvv|cvc|cvn|security[-_]?code|iban|swift|routing[-_]?(num|number)?|sort[-_]?code|(bank|account|acct)[-_]?(num|no|number)|^(auth|sig|otp|pin|code|pan|bic|key)$/i;

/**
 * The key of this process's fingerprints: random, held only in memory, never stored or written into a test. A survey makes its own
 * (newEvidenceKey), so fingerprints compare only within one survey and cannot be looked up against a list of likely values later.
 */
const PROCESS_EVIDENCE_KEY = randomBytes(32);
export const newEvidenceKey = (): Buffer => randomBytes(32);

/** A fingerprint for comparing values within one survey: HMAC-SHA-256 of the trimmed value under a random key, first 32 hex. */
export function valueHash(value: string, key: Buffer = PROCESS_EVIDENCE_KEY): string {
    return createHmac("sha256", key).update(value.trim()).digest("hex").slice(0, 32);
}

/** A preview that shows what kind of value matched without showing any of it: "•••••• (19 characters)". */
export function maskValue(value: string): string {
    const v = value.trim();
    return `${"•".repeat(Math.min(6, Math.max(1, v.length)))} (${v.length} characters)`;
}

/**
 * The values of a JSON record that identify its content: string fields of 4-200 characters that are not ids, numbers, dates, addresses
 * or credentials. Numbers and ids are left out because two accounts' records easily share them.
 */
export function recordValues(body: unknown, evidenceKey: Buffer = PROCESS_EVIDENCE_KEY): ApiValue[] {
    const out: ApiValue[] = [];
    const seen = new Set<string>();
    const walk = (v: unknown, key: string, depth: number) => {
        if (depth > 5 || out.length >= MAX_RECORD_VALUES || v === null || v === undefined) return;
        // A secret-named field hides its value and everything under it.
        if (key && SECRET_FIELD.test(key)) return;
        if (typeof v === "string") {
            const t = v.trim();
            if (t.length < 4 || t.length > 200) return;
            if (/^[\d\s.,:+\-/TZ]+$/.test(t) || /^(true|false|null|undefined)$/i.test(t) || /^[0-9a-f-]{12,}$/i.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return;
            const hash = valueHash(t, evidenceKey);
            if (seen.has(hash)) return;
            seen.add(hash);
            out.push({ key: key || "value", hash, length: t.length, mask: maskValue(t) });
            return;
        }
        if (Array.isArray(v)) for (const x of v.slice(0, 20)) walk(x, key, depth + 1);
        else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
    };
    walk(body, "", 0);
    return out;
}

/**
 * Whether an API host the app's own pages called is the application's own, so its record reads may be replayed as another account.
 * Own: the app's host name (any port or scheme), the host of one of the project's known API addresses (apiHosts), or a host under the
 * app's own name (api.shop-a.herokuapp.com for shop-a.herokuapp.com; www. dropped, so api.shop.example for www.shop.example), by the
 * shared rule in src/shared/app-host.ts (the selection preview uses it too). Nothing is
 * inferred from a shared parent domain or hosting provider: api.shop.example for app.shop.example (a sibling), b.vercel.app for
 * a.vercel.app are not the application's unless set as the project's API address. The same rule as the script's check (accessOwnApi).
 * An IP or a one-label name (localhost) counts only by its exact name.
 * Anything else, such as a third-party service the page happens to call, is never replayed: the check would send the viewer's own
 * credentials for that host there, and the host belongs to someone else.
 */
export function ownApiHost(url: string, appUrl: string, apiHosts: string[] = []): boolean {
    let u: URL;
    let app: URL;
    try {
        u = new URL(url);
        app = new URL(appUrl);
    } catch {
        return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    const hostOf = (a: string) => {
        try {
            return new URL(a).hostname;
        } catch {
            return "";
        }
    };
    return ownAppHost(h, app.hostname, apiHosts.map(hostOf));
}

/** Query parameters whose values are credentials: masked in what is kept, and replayed with the viewer's own value. */
const SECRET_PARAM = /pass|secret|token|^auth|authoriz|api[-_]?key|session|signature|^sig$|cookie|csrf|jwt|otp|nonce|^(key|sid|code|pin|hash)$/i;
/** Query parameters that name a record (?id=, ?noteId=, ?note_id=). */
const ID_PARAM = /^(?:id|uuid|guid)$|[_-](?:id|uuid|guid)$|[a-z](?:Id|ID|Uuid|Guid)$/;
const SECRET_MASK = "•••";
const isIdValue = (v: string) => /^\d+$/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^[0-9a-f]{12,}$/i.test(v);
/** A short prefix plus digits (ord-1001, n2): only a candidate, since v2, page3 and step-1 look the same (see prefixedKinds). */
const isPrefixedId = (v: string) => /^[a-z]{1,6}[-_]?\d{1,12}$/i.test(v);
const isId = (v: string, prefixed: boolean) => isIdValue(v) || (prefixed && isPrefixedId(v));

/**
 * How a record read is kept: the address path with its query string (secret-named values masked), the secret names, and the kind of
 * record (ids in the path or in id-named query parameters become {}). Undefined when the address names no record.
 */
export function apiRecordAddress(url: URL, prefixed = false): { path: string; pattern: string; secrets: string[] } | undefined {
    // "//other.example/x" would name another host when the check resolves it against the API host: never kept.
    if (/^\/[\/\\]/.test(url.pathname) || url.pathname.includes("\\")) return undefined;
    const pathPattern = recordPattern(url.pathname, prefixed);
    const enc = encodeURIComponent;
    const text: string[] = [];
    const kind: string[] = [];
    const secrets: string[] = [];
    let scoped = false;
    for (const [k, v] of url.searchParams) {
        if (SECRET_PARAM.test(k)) {
            if (!secrets.includes(k)) secrets.push(k);
            text.push(`${enc(k)}=${SECRET_MASK}`);
            kind.push(`${enc(k)}=${SECRET_MASK}`);
        } else {
            const id = ID_PARAM.test(k) && isId(v, prefixed);
            scoped ||= id;
            text.push(`${enc(k)}=${enc(v)}`);
            kind.push(`${enc(k)}=${id ? "{}" : enc(v)}`);
        }
    }
    if (!pathPattern && !scoped) return undefined;
    const q = (parts: string[]) => (parts.length ? `?${parts.join("&")}` : "");
    return { path: url.pathname + q(text), pattern: (pathPattern ?? url.pathname) + q(kind), secrets };
}

const recordKey = (r: ApiRecordSeen) => (r.origin ?? "") + r.path;

/** Notes one answer the app received while an account was surveyed, if it is a record-scoped GET read from the application's own API host. */
async function noteApiRecord(res: Response, appUrl: string, apiHosts: string[], pageUrl: string, out: ApiRecordSeen[], evidenceKey: Buffer): Promise<void> {
    const req = res.request();
    if (req.method() !== "GET" || !isApiRequest(req.url(), req.resourceType()) || !ownApiHost(req.url(), appUrl, apiHosts)) return;
    const u = new URL(req.url());
    const addr = apiRecordAddress(u, true);
    if (!addr || res.status() < 200 || res.status() >= 300) return;
    const origin = u.origin === new URL(appUrl).origin ? undefined : u.origin;
    const seen: ApiRecordSeen = { path: addr.path, ...(origin ? { origin } : {}), ...(addr.secrets.length ? { secrets: addr.secrets } : {}), pattern: (origin ?? "") + addr.pattern, page: "/", values: [] };
    const known = () => out.length >= MAX_API_RECORDS || out.some((r) => recordKey(r) === recordKey(seen));
    if (!/json/i.test(res.headers()["content-type"] ?? "") || known()) return;
    const header = Boolean(req.headers()["authorization"]);
    if (!(await smallAnswer(res))) return;
    const buf = await res.body();
    if (buf.length > MAX_API_BODY) return;
    let body: unknown;
    try {
        body = JSON.parse(buf.toString("utf8"));
    } catch {
        return;
    }
    const values = recordValues(body, evidenceKey);
    if (!values.length || known()) return;
    let page = "/";
    try {
        page = new URL(pageUrl).pathname || "/";
    } catch {
        /* keep the start page */
    }
    out.push({ ...seen, page, ...(header ? { header } : {}), values });
}

/**
 * Whether an answer is small enough to read (at most MAX_API_BODY) before its body is fetched from the browser: by its Content-Length,
 * else by the size the browser received. Playwright has no streamed read of a page's answer, so an answer of unknown size is not read.
 */
export async function smallAnswer(res: Pick<Response, "headerValue" | "request">): Promise<boolean> {
    const declared = await res.headerValue("content-length").catch(() => null);
    if (declared !== null && declared.trim() !== "") {
        const n = Number(declared);
        return Number.isFinite(n) && n >= 0 && n <= MAX_API_BODY;
    }
    const sizes = await res
        .request()
        .sizes()
        .catch(() => undefined);
    return sizes !== undefined && sizes.responseBodySize >= 0 && sizes.responseBodySize <= MAX_API_BODY;
}

async function surveyOne(ctx: EngineContext, browser: Browser, startUrl: string, role: RoleLogin | undefined, opts: SurveyOptions, evidenceKey: Buffer): Promise<Reach | undefined> {
    const session = await BrowserSession.launch(browser, { startUrl });
    try {
        let seed: string | undefined;
        let needsCode = false;
        if (role) {
            const r = await login(session, startUrl, { username: role.username, password: role.password, totpSecret: role.totpSecret });
            if (!r.ok) {
                ctx.emit({ stage: "discovery", kind: "access_survey_skipped", level: "warn", message: `Could not sign in as test account “${role.name}” (${r.error}); it is left out of the access-control checks.` });
                return undefined;
            }
            seed = r.landingUrl;
            needsCode = r.mechanisms.includes("totp");
        }
        // Signed in: the record-scoped API reads the app makes for this account (for the same-level API checks).
        const api: ApiRecordSeen[] = [];
        const reads: Array<Promise<void>> = [];
        const onResponse = (res: Response) => void reads.push(noteApiRecord(res, startUrl, opts.apiHosts ?? [], session.page.url(), api, evidenceKey).catch(() => undefined));
        if (role) session.page.on("response", onResponse);
        const result = await crawl(session, ctx, { startUrl, maxPages: opts.maxPages, maxDepth: opts.maxDepth ?? 2, maxPerPattern: opts.perPattern ?? 2, seedUrls: seed ? [seed] : undefined, ...(opts.refuse ? { refuse: opts.refuse } : {}) });
        if (role) session.page.off("response", onResponse);
        await Promise.allSettled(reads);
        const who = role?.name ?? "anonymous";
        opts.onCrawl?.(who, result);
        // A crawl the browser crash cut short saw only part of what this viewer can open: it is kept, but never as evidence of a closed page.
        const lost = session.lostReason();
        if (lost) ctx.emit({ stage: "discovery", kind: "access_survey_incomplete", level: "warn", message: `The access survey for ${role ? `test account “${role.name}”` : "visitors who are not signed in"} stopped early (${lost}); no “cannot open” checks are made for it.` });
        const ok = result.pages.filter((p) => p.type !== "error" && p.type !== "login" && (p.status === 0 || (p.status >= 200 && p.status < 400)));
        const pages = ok.map((p) => ({ path: pathOf(p), heading: (p.headings.find((h) => h.trim()) ?? p.title ?? "").trim() }));
        const seen = new Set<string>();
        const controls = ok
            .map((p) => ({ path: pathOf(p), names: [...new Set(p.components.filter((c) => CONTROL_ROLES.has(c.role)).map((c) => c.name))].slice(0, 30) }))
            .filter((c) => c.names.length);
        return { who, pages: pages.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true))), ...(needsCode ? { needsCode } : {}), ...(controls.length ? { controls } : {}), ...(api.length ? { api } : {}), ...(lost ? { incomplete: lost } : {}) };
    } finally {
        await session.close();
    }
}

/**
 * Crawl the app as "not signed in" and as each test account. A number alone is the old small survey (that many pages, 2 deep);
 * an exploration passes its share of the level's page budget (rolePageBudget) and depth.
 */
export async function surveyAccess(ctx: EngineContext, browser: Browser, startUrl: string, roles: RoleLogin[], size: number | SurveyOptions = 12): Promise<Reach[]> {
    const opts: SurveyOptions = typeof size === "number" ? { maxPages: size } : size;
    const out: Reach[] = [];
    // One random fingerprint key per survey, held only here: the accounts' record values compare with each other and nothing else.
    const evidenceKey = newEvidenceKey();
    const anon = await surveyOne(ctx, browser, startUrl, undefined, opts, evidenceKey);
    if (anon) out.push(anon);
    for (const role of roles) {
        const r = await surveyOne(ctx, browser, startUrl, role, opts, evidenceKey);
        if (r) out.push(r);
    }
    return out;
}

// ── 2. generate ──────────────────────────────────────────────────────────────

/** Addresses that sound like they belong to staff or the owner. */
const PRIVILEGED = /(^|\/)(admin|administrator|manage|management|staff|internal|backoffice|users?|roles?|billing|settings|reports?|audit|secrets?|console)(\/|$)/i;

export interface AccessGenOptions {
    maxSpecs: number;
    /** At most this many checks for pages whose address does not sound privileged (they are the likelier false alarms). */
    maxOrdinary: number;
    /** At most this many checks of one account's records opened as another account of the same kind (default 4). */
    maxHorizontal?: number;
    /** At most this many checks of one account's API records read as another account of the same kind (default 4). */
    maxApiHorizontal?: number;
    /**
     * The application's address and the project's API addresses: when given, API records on any other host (ownApiHost) are dropped before
     * checks are made, so no check is generated for a sibling or shared-hosting neighbour the survey should not have kept.
     */
    appUrl?: string;
    apiHosts?: string[];
}

/**
 * The kind of record an address shows ("/notes/{}"), or undefined when the address names no record (no id-like segment): an id is a
 * number, a UUID or a long hex string, and with prefixed also a short prefix plus digits (ord-1001). Two accounts that each reach their
 * own records of one kind are the evidence that records are owned.
 */
export function recordPattern(path: string, prefixed = false): string | undefined {
    let found = false;
    const out = path
        .split("/")
        .map((seg) => {
            if (isId(seg, prefixed)) {
                found = true;
                return "{}";
            }
            return seg;
        })
        .join("/");
    return found ? out : undefined;
}

/**
 * The kind of each address under the prefixed-id rule: a kind that only prefixed values make (/orders/{} from /orders/ord-1001) counts
 * when two accounts each reach an address of that kind the other does not, beyond what the strict ids already tell apart. Otherwise the
 * strict kind stands, so v2, page3 or step-1 reached by one account (or by all alike) stay words.
 */
function prefixedKinds(addresses: string[][], loose: (a: string) => string | undefined, strict: (a: string) => string | undefined): (a: string) => string | undefined {
    const byKind = addresses.map((list) => {
        const m = new Map<string, Set<string>>();
        for (const a of list) {
            const k = loose(a);
            if (!k || k === strict(a)) continue;
            if (!m.has(k)) m.set(k, new Set());
            m.get(k)!.add(strict(a) ?? a);
        }
        return m;
    });
    const counted = new Set<string>();
    for (const [i, mine] of byKind.entries())
        for (const [k, set] of mine)
            for (const theirs of byKind.slice(i + 1)) {
                const other = theirs.get(k);
                if (other && [...set].some((x) => !other.has(x)) && [...other].some((x) => !set.has(x))) counted.add(k);
            }
    return (a) => {
        const k = loose(a);
        return k && counted.has(k) ? k : strict(a);
    };
}

const GENERIC_HEADING = /^(home|welcome|index|menu|dashboard|untitled|page)$/i;

export function generateAccessSpecs(given: Reach[], opts: AccessGenOptions = { maxSpecs: 8, maxOrdinary: 3 }): DraftSpec[] {
    const appUrl = opts.appUrl;
    const hosted = appUrl ? given.map((r) => (r.api ? { ...r, api: r.api.filter((a) => !a.origin || ownApiHost(`${a.origin}/`, appUrl, opts.apiHosts ?? [])) } : r)) : given;
    const signedIn = hosted.filter((r) => r.who !== "anonymous");
    const kind = prefixedKinds(signedIn.map((r) => r.pages.map((p) => p.path)), (p) => recordPattern(p, true), (p) => recordPattern(p));
    const recs = new Map(signedIn.flatMap((r) => r.api ?? []).map((x) => [recordKey(x), x]));
    const apiKindOf = (prefixed: boolean) => (key: string) => {
        const r = recs.get(key)!;
        const a = apiRecordAddress(new URL(r.path, "http://h"), prefixed);
        return a && (r.origin ?? "") + a.pattern;
    };
    const apiKind = prefixedKinds(signedIn.map((r) => (r.api ?? []).map(recordKey)), apiKindOf(true), apiKindOf(false));
    // A record whose kind only prefixed values made takes the kind the evidence allows, or is dropped when that leaves no id.
    const reaches = hosted.map((r) => {
        if (!r.api) return r;
        const api = r.api.flatMap((x) => {
            const key = recordKey(x);
            if (apiKindOf(false)(key) === apiKindOf(true)(key)) return [x];
            const k = apiKind(key);
            return k ? [{ ...x, pattern: k }] : [];
        });
        return { ...r, api };
    });
    const byWho = new Map(reaches.map((r) => [r.who, r]));
    const viewers = reaches.map((r) => r.who);
    interface Candidate {
        as: string;
        by: string;
        path: string;
        marker: string;
        privileged: boolean;
    }
    const candidates: Candidate[] = [];
    // Two or more test accounts: a record of a kind the viewer also has records of is another account's record (the horizontal pass
    // below), not a page reserved for a more privileged account.
    const named = reaches.filter((r) => r.who !== "anonymous");
    const horizontalOn = named.length >= 2;
    const patternsOf = (r: Reach) => new Set(r.pages.map((p) => kind(p.path)).filter((x): x is string => Boolean(x)));
    for (const viewer of viewers) {
        const vReach = byWho.get(viewer)!;
        if (vReach.incomplete) continue;
        const vPatterns = horizontalOn && viewer !== "anonymous" ? patternsOf(vReach) : new Set<string>();
        const vPaths = new Set(vReach.pages.map((p) => p.path));
        const vHeadings = new Set(vReach.pages.map((p) => p.heading.toLowerCase()));
        for (const owner of reaches) {
            if (owner.who === viewer || owner.who === "anonymous") continue;
            // The owner must be the more privileged one: strictly more pages than the viewer (anonymous reaches the least).
            if (viewer !== "anonymous" && owner.pages.length <= vReach.pages.length) continue;
            for (const page of owner.pages) {
                if (vPaths.has(page.path) || page.path === "/") continue;
                const k = kind(page.path);
                if (k && vPatterns.has(k)) continue;
                const marker = page.heading;
                // The marker must say something about this page: long enough, not generic, and not a heading the viewer already sees elsewhere.
                if (marker.length < 4 || marker.length > 80 || GENERIC_HEADING.test(marker) || vHeadings.has(marker.toLowerCase())) continue;
                // One check per (viewer, page): the first owner to claim it wins.
                if (candidates.some((c) => c.as === viewer && c.path === page.path)) continue;
                candidates.push({ as: viewer, by: owner.who, path: page.path, marker, privileged: PRIVILEGED.test(page.path) });
            }
        }
    }
    const privileged = candidates.filter((c) => c.privileged);
    const ordinary = candidates.filter((c) => !c.privileged).slice(0, opts.maxOrdinary);
    const vertical = [...privileged, ...ordinary].slice(0, opts.maxSpecs).map((c) => specFor(c));
    return horizontalOn ? [...vertical, ...horizontalSpecs(named, opts.maxHorizontal ?? 4, kind), ...horizontalApiSpecs(named, opts.maxApiHorizontal ?? 4)] : vertical;
}

/**
 * One account's records opened by another test account. A check is made only with evidence that the record is the owner's: both accounts
 * reach records of the same kind (the same address pattern) at different addresses, the viewer never reached this one, and its heading is
 * one the viewer saw nowhere (a heading every record shares, or one both see, says nothing about who owns it). Without that evidence
 * nothing is generated. The check opens the address once, GET only, and fails only when the owner's heading is shown to the viewer.
 */
function horizontalSpecs(named: Reach[], max: number, kind: (path: string) => string | undefined): DraftSpec[] {
    const out: Array<{ as: string; of: string; path: string; marker: string; pattern: string }> = [];
    for (const viewer of named) {
        if (viewer.incomplete) continue;
        const vPaths = new Set(viewer.pages.map((p) => p.path));
        const vPatterns = new Set(viewer.pages.map((p) => kind(p.path)).filter((x): x is string => Boolean(x)));
        const vHeadings = new Set(viewer.pages.map((p) => p.heading.toLowerCase()));
        for (const owner of named) {
            if (owner.who === viewer.who) continue;
            for (const page of owner.pages) {
                const pattern = kind(page.path);
                if (!pattern || !vPatterns.has(pattern) || vPaths.has(page.path)) continue;
                const marker = page.heading;
                if (marker.length < 4 || marker.length > 80 || GENERIC_HEADING.test(marker) || vHeadings.has(marker.toLowerCase())) continue;
                // A heading the owner's other records of this kind also carry is a page title, not the record's own content.
                if (owner.pages.some((q) => q.path !== page.path && kind(q.path) === pattern && q.heading.toLowerCase() === marker.toLowerCase())) continue;
                if (out.some((c) => c.as === viewer.who && c.path === page.path)) continue;
                out.push({ as: viewer.who, of: owner.who, path: page.path, marker, pattern });
            }
        }
    }
    return out.slice(0, max).map((c) => ({
        title: `“${c.as}” account: cannot open a record of “${c.of}” (${c.path})`,
        description: `The “${c.as}” account opens ${c.path} directly by its address. While browsing, only “${c.of}” reached this record, and “${c.as}” reached its own records of the same kind (${c.pattern}), so it belongs to “${c.of}”. Fails if the record's content ("${c.marker}") is shown. Only a page address is requested; nothing is changed.`,
        kind: "web",
        category: "Access control",
        type: "security",
        priority: "high",
        preconditions: [`Test accounts named “${c.as}” and “${c.of}” are set up for this project`],
        steps: [
            { action: "navigate", url: "/", description: "Start at the home page" },
            {
                action: "assert",
                check: "accessDenied",
                expected: JSON.stringify({ as: c.as, path: c.path, marker: c.marker, by: c.of, sev: "high", of: c.of, pattern: c.pattern }),
                description: `The “${c.as}” account cannot open ${c.path} (a record of “${c.of}”)`,
            },
        ],
        expectedResults: [`${c.path} is not shown to the “${c.as}” account`],
        testData: {},
        tags: ["security", "access-control", "cross-account"],
        source: { origin: "access-check" },
    }));
}

/**
 * The same-level pass for API records: account A's record-scoped GET reads are replayed as account B. A check is made only with evidence
 * that the record is A's: both accounts read records of the same kind (the same address pattern) at different addresses, B never read this
 * one, and the record holds values B saw in none of its own records and A's other records of this kind do not share (the evidence). The
 * check (accessApiAssert) keeps only those values' field names and lengths; each run reads the record as A, then makes one GET as B and
 * fails only when a 2xx answer holds one of A's values of those fields.
 */
function horizontalApiSpecs(named: Reach[], max: number): DraftSpec[] {
    const out: Array<{ as: string; of: string; rec: ApiRecordSeen; evidence: ApiValue[]; page: string }> = [];
    for (const viewer of named) {
        if (viewer.incomplete) continue;
        const vRecs = viewer.api ?? [];
        const vPaths = new Set(vRecs.map(recordKey));
        const vHashes = new Set(vRecs.flatMap((r) => r.values.map((v) => v.hash)));
        for (const owner of named) {
            if (owner.who === viewer.who) continue;
            for (const rec of owner.api ?? []) {
                const own = vRecs.find((r) => r.pattern === rec.pattern);
                if (!own || vPaths.has(recordKey(rec))) continue;
                const shared = new Set((owner.api ?? []).filter((r) => recordKey(r) !== recordKey(rec) && r.pattern === rec.pattern).flatMap((r) => r.values.map((v) => v.hash)));
                const evidence = rec.values.filter((v) => !vHashes.has(v.hash) && !shared.has(v.hash)).slice(0, 5);
                if (!evidence.length || out.some((c) => c.as === viewer.who && recordKey(c.rec) === recordKey(rec))) continue;
                out.push({ as: viewer.who, of: owner.who, rec, evidence, page: own.page });
            }
        }
    }
    return out.slice(0, max).map((c) => ({
        title: `“${c.as}” account: cannot read a record of “${c.of}” through the API (GET ${recordKey(c.rec)})`,
        description: `The “${c.as}” account calls GET ${recordKey(c.rec)} directly. While browsing, the app read this record only for “${c.of}”, and read “${c.as}”'s own records of the same kind (${c.rec.pattern}), so it belongs to “${c.of}”. Fails if the answer holds the record's content, compared with “${c.of}”'s own answer read in the same run (values are not stored).${c.rec.secrets ? ` Its ${c.rec.secrets.join(", ")} value is masked here and replaced by “${c.as}”'s own when the request is made.` : ""} A single GET request; nothing is changed.`,
        kind: "web",
        category: "Access control",
        type: "security",
        priority: "high",
        preconditions: [`Test accounts named “${c.as}” and “${c.of}” are set up for this project`],
        steps: [
            { action: "navigate", url: "/", description: "Start at the home page" },
            {
                action: "assert",
                check: "accessDenied",
                expected: JSON.stringify({ api: true, as: c.as, path: c.rec.path, ...(c.rec.origin ? { origin: c.rec.origin } : {}), ...(c.rec.secrets ? { secrets: c.rec.secrets } : {}), by: c.of, of: c.of, sev: "high", pattern: c.rec.pattern, page: c.page, ...(c.rec.header ? { header: true } : {}), evidence: c.evidence.map((e) => ({ key: e.key, ...(typeof e.length === "number" ? { length: e.length } : {}), mask: e.mask.replace(/^[^•]*/, "") })) }),
                description: `The “${c.as}” account cannot read GET ${recordKey(c.rec)} (a record of “${c.of}”)`,
            },
        ],
        expectedResults: [`GET ${recordKey(c.rec)} does not give the “${c.as}” account the content of a record of “${c.of}”`],
        testData: {},
        tags: ["security", "access-control", "cross-account", "api"],
        source: { origin: "access-check" },
    }));
}

function specFor(c: { as: string; by: string; path: string; marker: string; privileged: boolean }): DraftSpec {
    const who = c.as === "anonymous" ? "Someone who is not signed in" : `The “${c.as}” account`;
    const sev = c.privileged ? "high" : "low";
    const steps: Step[] = [
        { action: "navigate", url: "/", description: "Start at the home page" },
        {
            action: "assert",
            check: "accessDenied",
            expected: JSON.stringify({ as: c.as, path: c.path, marker: c.marker, by: c.by, sev }),
            description: `${who} cannot open ${c.path} (it is only reached by ${c.by === "anonymous" ? "visitors" : `“${c.by}”`} when browsing)`,
        },
    ];
    return {
        title: `${c.as === "anonymous" ? "Not signed in" : `“${c.as}” account`}: cannot open ${c.path}`,
        description: `${who} opens ${c.path} directly by its address. While browsing, only “${c.by}” reached this page, so it may be restricted. Fails if the page's content ("${c.marker}") is shown. Only a page address is requested; nothing is changed.`,
        kind: "web",
        category: "Access control",
        type: "security",
        priority: c.privileged ? "high" : "medium",
        preconditions: c.as === "anonymous" ? [] : [`A test account named “${c.as}” is set up for this project`],
        steps,
        expectedResults: [`${c.path} is not shown to ${c.as === "anonymous" ? "visitors who are not signed in" : `the “${c.as}” account`}`],
        testData: {},
        tags: ["security", "access-control"],
        source: { origin: "access-check" },
    };
}

// ── 2b. API endpoints ────────────────────────────────────────────────────────

/** What each viewer ("anonymous" or a role name) was answered when calling one safe GET endpoint. */
export interface ApiAccessRow {
    method: "GET";
    /** Template, e.g. /api/admin/users. */
    path: string;
    /** The concrete path that was called. */
    called: string;
    status: Record<string, number>;
}

export interface ApiRequester {
    get(url: string, opts: { headers: Record<string, string>; failOnStatusCode: false; maxRedirects: 0; timeout: number }): Promise<{ status(): number }>;
}

/**
 * Call each endpoint once as a visitor and once per account that has an API token — GET only, one request at a time, at most
 * `maxEndpoints` endpoints. Only addresses that sound privileged are worth probing, so only those are called.
 */
export async function surveyApiAccess(request: ApiRequester, apiBase: string, endpoints: Array<{ method: string; path: string; called: string }>, roles: RoleLogin[], maxEndpoints = 12): Promise<ApiAccessRow[]> {
    const withToken = roles.filter((r) => r.apiToken);
    if (withToken.length === 0) return [];
    const rows: ApiAccessRow[] = [];
    for (const ep of endpoints.filter((e) => e.method === "GET" && PRIVILEGED.test(e.path)).slice(0, maxEndpoints)) {
        const status: Record<string, number> = {};
        const viewers: Array<[string, Record<string, string>]> = [["anonymous", {}], ...withToken.map((r): [string, Record<string, string>] => [r.name, { Authorization: `Bearer ${r.apiToken}` }])];
        for (const [who, headers] of viewers) {
            try {
                status[who] = (await request.get(new URL(ep.called, apiBase).toString(), { headers, failOnStatusCode: false, maxRedirects: 0, timeout: 15_000 })).status();
            } catch {
                /* unreachable for this viewer: no verdict about it */
            }
        }
        rows.push({ method: "GET", path: ep.path, called: ep.called, status });
    }
    return rows;
}

const ok2xx = (s: number | undefined) => s !== undefined && s >= 200 && s < 300;

/**
 * Checks for privileged-looking endpoints that an account with a token can call: every other viewer (a visitor, and accounts
 * that reach fewer of these endpoints) gets a "must be refused" check. Ones that are refused today guard against regressions;
 * ones that are open today fail and become findings.
 */
export function generateApiAccessSpecs(rows: ApiAccessRow[], opts: { maxSpecs: number } = { maxSpecs: 8 }): DraftSpec[] {
    const reached = new Map<string, number>();
    for (const r of rows) for (const [who, s] of Object.entries(r.status)) if (ok2xx(s)) reached.set(who, (reached.get(who) ?? 0) + 1);
    const out: DraftSpec[] = [];
    for (const row of rows) {
        // The most privileged account that can call it (reaches the most of these endpoints).
        const owner = Object.keys(row.status)
            .filter((w) => w !== "anonymous" && ok2xx(row.status[w]))
            .sort((a, b) => (reached.get(b) ?? 0) - (reached.get(a) ?? 0) || a.localeCompare(b))[0];
        if (!owner) continue;
        for (const viewer of Object.keys(row.status)) {
            if (viewer === owner || (viewer !== "anonymous" && (reached.get(viewer) ?? 0) >= (reached.get(owner) ?? 0))) continue;
            const who = viewer === "anonymous" ? "A caller without credentials" : `The “${viewer}” account`;
            const headers = viewer === "anonymous" ? undefined : { Authorization: `Bearer {{credentials.${viewer}.apiToken}}` };
            out.push({
                title: `${viewer === "anonymous" ? "Not signed in" : `“${viewer}” account`}: cannot call GET ${row.path}`,
                description: `${who} calls GET ${row.path}. It is normally reached only by “${owner}”, so it may be restricted. Fails if the endpoint answers with a success status. A single GET request; nothing is changed.`,
                kind: "api",
                category: "Access control",
                type: "security",
                priority: "high",
                preconditions: viewer === "anonymous" ? [] : [`A test account named “${viewer}” with an API token is set up for this project`],
                steps: [
                    { action: "request", method: "GET", path: row.called, auth: "none", ...(headers ? { headers } : {}), description: `Call GET ${row.path} as ${viewer === "anonymous" ? "a caller without credentials" : `the “${viewer}” account`}` },
                    { action: "assertResponse", check: "statusDenied", expected: JSON.stringify({ as: viewer, path: row.path, by: owner, sev: "high" }), description: `${who} is refused (HTTP 401, 403 or 404)` },
                ],
                expectedResults: [`GET ${row.path} is refused for ${viewer === "anonymous" ? "callers without credentials" : `the “${viewer}” account`}`],
                testData: {},
                tags: ["security", "access-control", "api"],
                source: { origin: "access-check" },
            });
        }
    }
    return out.slice(0, opts.maxSpecs);
}

// ── 3. classify ──────────────────────────────────────────────────────────────

function ownMessage(text: string): string | undefined {
    const at = text.indexOf(ACCESS_FAILURE_PREFIX);
    if (at < 0) return undefined;
    const lines = text.slice(at).split("\n");
    const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("- "));
    return lines
        .slice(0, end < 0 ? lines.length : end)
        .join("\n")
        .trim();
}

/** A failed run is an access finding only when it is the check's own message (not "could not sign in as ..."). */
export function accessFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const isStep = (s: Step | undefined) => (s?.action === "assert" && s.check === "accessDenied") || (s?.action === "assertResponse" && s.check === "statusDenied");
    let message: string | undefined;
    for (const st of run.steps) if (st.status === "failed" && isStep(spec.steps[st.index])) message = ownMessage(st.error ?? "") ?? message;
    if (!message && run.steps.length === 0 && spec.steps.some(isStep)) message = ownMessage(run.error ?? "");
    return message ? `${message}\nHow to fix: ${ACCESS_ADVICE}`.slice(0, 2500) : undefined;
}

/** Severity of an access finding reason (undefined if it is not one). */
export function parseAccessReason(reason: string): "high" | "medium" | "low" | undefined {
    if (!reason.includes(ACCESS_FAILURE_PREFIX)) return undefined;
    const body = reason.split(/^how to fix:/im)[0] ?? "";
    for (const s of ["high", "medium", "low"] as const) if (body.includes(`[${s}]`)) return s;
    return "low";
}
