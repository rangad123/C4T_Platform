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
import type { Browser } from "playwright";
import type { DraftSpec } from "../api/test-specs.js";
import type { EngineContext } from "../context.js";
import { login } from "../discovery/auth.js";
import { BrowserSession } from "../discovery/browser.js";
import { crawl, type CrawlOptions, type CrawlResult } from "../discovery/crawler.js";
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
 * spec = JSON {as, path, marker, by, sev}: as = "anonymous" or a test account name; by = who normally reaches the page.
 * Opens the page directly in a fresh browser context and fails only when its marker is shown to someone it should be hidden from.
 */
async function accessAssert(page, base, spec) {
    const cfg = JSON.parse(spec);
    const browser = page.context().browser();
    const ctx = browser ? await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } }) : page.context();
    const p = await ctx.newPage();
    try {
        if (cfg.as !== "anonymous") await accessSignIn(p, base, cfg.as);
        const res = await p.goto(new URL(cfg.path, base).toString(), { waitUntil: "load", timeout: 30000 }).catch(() => null);
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
        const who = cfg.as === "anonymous" ? "Anyone who is not signed in" : "A signed-in “" + cfg.as + "” user";
        throw new Error(ACCESS_PREFIX + " 1 page may be open to someone who should not see it\n- [" + cfg.sev + "] " + who + " can open " + cfg.path + " and see “" + cfg.marker + "”. It is normally reached only by " + (cfg.by === "anonymous" ? "visitors" : "“" + cfg.by + "”") + ", so this is possible broken access control: check that this page is meant to be open to them");
    } finally {
        await p.close().catch(() => undefined);
        if (browser) await ctx.close().catch(() => undefined);
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
    controls?: Array<{ path: string; names: string[] }>;
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
}

/** Fewest pages each viewer's crawl gets, however many accounts share the level's budget. */
export const MIN_ROLE_PAGES = 20;

/** Pages each viewer's crawl may visit: the exploration's page budget split across the accounts, at least MIN_ROLE_PAGES. */
export function rolePageBudget(maxPages: number, roles: number): number {
    return Math.max(MIN_ROLE_PAGES, Math.floor(maxPages / Math.max(1, roles)));
}

const CONTROL_ROLES = new Set(["button", "menuitem", "tab", "checkbox", "switch"]);

const pathOf = (p: { path: string }) => (p.path || "/").split(/[?#]/)[0] || "/";

async function surveyOne(ctx: EngineContext, browser: Browser, startUrl: string, role: RoleLogin | undefined, opts: SurveyOptions): Promise<Reach | undefined> {
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
        const result = await crawl(session, ctx, { startUrl, maxPages: opts.maxPages, maxDepth: opts.maxDepth ?? 2, maxPerPattern: opts.perPattern ?? 2, seedUrls: seed ? [seed] : undefined, ...(opts.refuse ? { refuse: opts.refuse } : {}) });
        const who = role?.name ?? "anonymous";
        opts.onCrawl?.(who, result);
        const ok = result.pages.filter((p) => p.type !== "error" && p.type !== "login" && (p.status === 0 || (p.status >= 200 && p.status < 400)));
        const pages = ok.map((p) => ({ path: pathOf(p), heading: (p.headings.find((h) => h.trim()) ?? p.title ?? "").trim() }));
        const seen = new Set<string>();
        const controls = ok
            .map((p) => ({ path: pathOf(p), names: [...new Set(p.components.filter((c) => CONTROL_ROLES.has(c.role)).map((c) => c.name))].slice(0, 30) }))
            .filter((c) => c.names.length);
        return { who, pages: pages.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true))), ...(needsCode ? { needsCode } : {}), ...(controls.length ? { controls } : {}) };
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
    const anon = await surveyOne(ctx, browser, startUrl, undefined, opts);
    if (anon) out.push(anon);
    for (const role of roles) {
        const r = await surveyOne(ctx, browser, startUrl, role, opts);
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
}

const GENERIC_HEADING = /^(home|welcome|index|menu|dashboard|untitled|page)$/i;

export function generateAccessSpecs(reaches: Reach[], opts: AccessGenOptions = { maxSpecs: 8, maxOrdinary: 3 }): DraftSpec[] {
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
    for (const viewer of viewers) {
        const vReach = byWho.get(viewer)!;
        const vPaths = new Set(vReach.pages.map((p) => p.path));
        const vHeadings = new Set(vReach.pages.map((p) => p.heading.toLowerCase()));
        for (const owner of reaches) {
            if (owner.who === viewer || owner.who === "anonymous") continue;
            // The owner must be the more privileged one: strictly more pages than the viewer (anonymous reaches the least).
            if (viewer !== "anonymous" && owner.pages.length <= vReach.pages.length) continue;
            for (const page of owner.pages) {
                if (vPaths.has(page.path) || page.path === "/") continue;
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
    return [...privileged, ...ordinary].slice(0, opts.maxSpecs).map((c) => specFor(c));
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
