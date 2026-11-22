/**
 * Which pages and API endpoints a test touches, worked out without AI from what is stored (pure functions; facts.ts reads the data).
 *
 *   declared   the test's own steps say so: a `navigate` step's address, a `request` step's method and path (reusable steps already
 *              put in place by the caller). True of every run of this version of the test.
 *   observed   a run of the test's current script recorded it: the footprint of that run (every page the main frame reached, also routes
 *              reached inside the page, and every endpoint: fetch/XHR, forms sent to the server, WebSockets, EventSource streams and
 *              beacons), or, for older records, the requests of its stored evidence. Requests to every host are kept: the application's
 *              own hosts (isOwnHost: its address and hosts under its name, its API base address, the hosts its request steps name) and
 *              every other host, recorded as "external".
 *
 * Nothing is taken from a test's title or description.
 *
 * URL matching semantics (one rule set for tests and changes; `matchesChange` in preview.ts compares the keys):
 *   - scheme and host are compared case-insensitively; the scheme itself is not compared (http, https, ws, wss reach the same host);
 *     a default port is dropped (`:443` on https);
 *   - the path is case-sensitive (RFC 3986): `/Orders` and `/orders` are different;
 *   - percent-encoded unreserved characters (letters, digits, `-` `.` `_` `~`) are decoded, other escapes are upper-cased;
 *   - a trailing slash is dropped (`/orders/` is `/orders`);
 *   - ids (numbers, UUIDs, long hex, long mixed ids), `{{variables}}`, `{name}`, `:name` and `*` segments become `{}`, and `{}` matches any
 *     one segment on either side (`/products/{slug}` matches `/products/blue-shirt`);
 *   - the query is ignored unless the change names query parameters; then a test matches only when it is known to use those names (or
 *     when its record keeps no query names, which is never a reason to leave it out);
 *   - a hash route (`/app#/cart/7`) is a page; its route is compared as a path. A plain anchor (`#top`) is not a route.
 */
import { templatePath } from "../../engine/contracts/drift.js";
import { ownAppHost } from "../../shared/app-host.js";

export type CoverageSource = "declared" | "observed";
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
/** Endpoints that are not plain fetch/XHR calls. */
export type EndpointType = "form" | "websocket" | "eventsource" | "beacon";

/** A page (`/orders/{}`, `/app#/orders/{}`) or an endpoint (`POST /orders/{}`). `host` only for a host other than the application's address. */
export interface CoverageItem {
    kind: "page" | "endpoint";
    /** Normalised path pattern (with `#route` for a hash route). */
    path: string;
    /** Endpoints only. */
    method?: (typeof HTTP_METHODS)[number];
    host?: string;
    /** The host is not one of the application's (a third-party site). */
    external?: true;
    /** Endpoints that are not fetch/XHR. */
    type?: EndpointType;
    /** Query parameter names seen with it (values are never kept). */
    query: string[];
    /** The record keeps no query names (a footprint): a change that names query parameters still matches. */
    queryUnknown?: true;
    source: CoverageSource;
    /** Where it was found, for the reason shown to a person: "step 3", "run of 12 Nov". At most 3. */
    seenIn: string[];
}

/**
 * declared-complete  every step that reaches the application is accounted for (API tests: their requests are the whole test), and the
 *                    test's latest relevant run is fresh (freshnessOf), as for web tests;
 * observed-complete  the test's latest relevant run is fresh (freshnessOf: passed, current version and script, recent) and recorded
 *                    everything it touched (nothing cut, nothing it could not classify);
 * partial            something is known, but the test can reach more than that (pages opened by clicking, requests a page makes);
 * unknown            nothing reliable is known.
 */
export type Completeness = "declared-complete" | "observed-complete" | "partial" | "unknown";

export interface TestCoverage {
    testId: string;
    testKey: string;
    title: string;
    kind: string;
    items: CoverageItem[];
    completeness: Completeness;
    /** Plain sentences: what this mapping cannot see for this test. */
    limits: string[];
    /** For a complete test: what its completeness rests on ("its steps", "the passing run of 2026-11-10"). */
    completeFrom?: string;
    /** A web or API test whose latest relevant run cannot vouch for it (freshnessOf): why, in words. Its coverage is out of date. */
    stale?: string;
}

/** A test as facts.ts hands it over: the spec is untrusted JSON (it may be malformed). */
export interface TestFacts {
    id: string;
    testKey: string;
    title: string;
    kind: string;
    spec: unknown;
    /** The spec_json could not be read at all. */
    specUnreadable?: boolean;
    /** Stored evidence of runs of the test's current script, newest first. */
    runs: ObservedRun[];
    /** Whether the test's latest relevant run can vouch for what it touches now (freshnessOf). Only that run can make it complete. */
    freshness: Freshness;
}

/**
 * Freshness (the rules; facts.ts reads the data, freshnessOf decides). A web test's coverage is complete only when its LATEST relevant run:
 *   - is on the deploy target: no browser/screen variant and no named environment (what a deploy trigger runs);
 *   - passed (a failed, errored, cancelled or unfinished latest run makes it stale, whatever passed before it);
 *   - ran the test's current version: the latest approved version, the one runs execute (`test_executions.test_version_id`), and its
 *     current script; a newer version that has not run yet, or a run not linked to any version, makes it stale;
 *   - is no older than the freshness window (14 days by default, SELECTION_FRESH_DAYS);
 *   - left a footprint that is complete: not cut, no request it could not classify, at least one page or endpoint (extractCoverage).
 * Any other case is stale or incomplete, and the preview then requires a full run. Older passing runs still add pages and endpoints (more
 * matches, never fewer), but never make a test complete. An API test's coverage rests on the steps of its current version (they are the
 * whole test, true of every run), and it counts only with a fresh passing run too (the first four rules; its record is not needed, as
 * runs of API tests keep no footprint): one that never ran is unknown, one whose latest run is not fresh is stale.
 */
export type Freshness = { fresh: true; executionId: string } | { fresh: false; why: string; /** No run of what it runs now exists at all: unknown rather than out of date. */ never?: true };

/** The latest execution of a test on the deploy target (any status, with or without a stored record). */
export interface LatestRun {
    executionId: string;
    status: string;
    startedAt: string;
    versionId: string | null;
    scriptId: string | null;
}

/** What runs execute now: the latest approved version (and its number, for the words) and the current script. */
export interface CurrentVersion {
    versionId?: string;
    version?: number;
    scriptId?: string;
}

export const DEFAULT_FRESH_DAYS = 14;

/** SELECTION_FRESH_DAYS as a whole number of days from 1 to 365; anything else is the default. */
export function freshDaysFrom(raw: string | undefined): number {
    const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_FRESH_DAYS;
}

const STATUS_WORDS: Record<string, string> = { failed: "failed", error: "ended with an error", cancelled: "was cancelled", canceled: "was cancelled", skipped: "was skipped", timed_out: "timed out", stopped: "was stopped" };

/** Whether the latest relevant run can vouch for the test's coverage now (the rules above). Pure: `now` in epoch ms. */
export function freshnessOf(latest: LatestRun | undefined, current: CurrentVersion, now: number, days: number = DEFAULT_FRESH_DAYS): Freshness {
    if (!current.versionId) return { fresh: false, why: "It has no approved version, so no run of what it would run now exists.", never: true };
    if (!latest) return { fresh: false, why: "No run of it has been recorded yet, so what it touches is only known from its steps.", never: true };
    const on = latest.startedAt.slice(0, 10);
    if (latest.status !== "passed") {
        const words = STATUS_WORDS[latest.status] ?? `did not pass (${String(latest.status).slice(0, 30)})`;
        return { fresh: false, why: `Its latest run (${on}) ${words}, so earlier passing runs no longer show what it touches.` };
    }
    if (!latest.versionId) return { fresh: false, why: `Its latest run (${on}) is not linked to a version of the test, so it may have run older steps.` };
    if (latest.versionId !== current.versionId) return { fresh: false, why: `It changed after its latest run (${on}): ${current.version ? `version ${current.version}` : "its current version"} has not run yet.` };
    if (current.scriptId && latest.scriptId !== current.scriptId) return { fresh: false, why: `Its code changed after its latest run (${on}), and the new code has not run yet.` };
    const at = Date.parse(latest.startedAt);
    if (!Number.isFinite(at) || now - at > days * 86_400_000) return { fresh: false, why: `Its latest run (${on}) is older than ${days} day${days === 1 ? "" : "s"}, so it may no longer show what the test touches.` };
    return { fresh: true, executionId: latest.executionId };
}

export interface ObservedRun {
    executionId: string;
    status: string;
    startedAt: string;
    /** The record says it holds everything the run touched (a footprint that was not cut and classified every request). */
    complete: boolean;
    /** Why the record is not the whole story, in words (when `complete` is false for a reason other than a failed run). */
    incompleteWhy?: string;
    /** The record keeps no query names (a footprint). */
    queryUnknown?: boolean;
    /** Requests the recorder itself could not classify (counted, not listed). */
    unclassified?: number;
    /**
     * The host of the address the run itself opened (its BASE_URL: the application's address when it ran). The record leaves that host
     * out, so its other hosts are classified against it, not against today's address. Unknown on older data: today's address is used.
     */
    baseHost?: string;
    /**
     * What it touched. Types: `document` (a page load; a form when the method is not GET), `route` (a page the main frame reached),
     * `fetch`/`xhr`, `websocket`, `eventsource`, `beacon`/`ping`, files (`script`, `image`, ...). Anything else is unclassified.
     */
    requests: Array<{ method: string; type: string; path: string; host?: string }>;
}

export interface AppFacts {
    /** Host of the application's address (pages on it carry no host). */
    appHost?: string;
    /** Hosts of the application's API (its API base address): the application's own, not "external". */
    apiHosts?: string[];
    /** The application's documented or observed endpoint templates (the app model): what a captured path part can resolve to. */
    endpoints?: ReadonlyArray<{ method: string; path: string }>;
}

const PLACEHOLDER = /\{\{[^}]*\}\}/g;
const MAX_SEEN = 3;
const STATIC_TYPES = new Set(["stylesheet", "image", "media", "font", "script", "texttrack", "manifest"]);
const TYPED: Record<string, EndpointType> = { websocket: "websocket", eventsource: "eventsource", beacon: "beacon", ping: "beacon" };

/**
 * Whether a host (a port is ignored) is the application's own, by the API checks' strict rule (src/shared/app-host.ts): its address's
 * host on any port, a host under that name (www. dropped), a known API host or a host the test's own request steps name (`extra`).
 * A shared parent domain or hosting provider proves nothing (app.shop.example and api.shop.example, a.vercel.app and b.vercel.app are
 * different unless set as the API address); IPs and one-label names match only exactly. A host that is not the application's own is
 * external, which keeps a web test partial while the API address is not set (unknownSite), so an unclear host forces a full run.
 */
export function isOwnHost(host: string | undefined, app: AppFacts, extra: Iterable<string> = []): boolean {
    if (!host) return true;
    const exact = [...(app.apiHosts ?? []), ...extra].map(hostName);
    return Boolean(app.appHost) ? ownAppHost(hostName(host), hostName(app.appHost!), exact) : exact.includes(hostName(host));
}

/** A host's machine name without its port (`shop.example:8443` -> `shop.example`, `[::1]:8080` -> `[::1]`), in lower case. */
function hostName(host: string): string {
    try {
        return new URL(`http://${host}/`).hostname;
    } catch {
        return host.toLowerCase();
    }
}

/** The host part of an absolute address, normalised by the URL parser (lower case, default port dropped, IDN as punycode). */
function normaliseHost(scheme: string, raw: string): string | undefined {
    try {
        const s = /^wss?$/i.test(scheme) ? scheme.toLowerCase().replace("ws", "http") : scheme.toLowerCase();
        return new URL(`${s}://${raw}/`).host.toLowerCase() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Split an address or a path into host, path, query names and hash route. Undefined when it is not usable (empty, only a variable, a
 * variable that is part of the host). An address that starts with a variable (`{{base}}/orders`) has an unknown start: what follows it is
 * read as the path (`/orders`, not `/{}/orders`) and `leadingVariable` says the address is not fully known.
 */
export function splitAddress(raw: string): { host?: string; path: string; query: string[]; route?: string; leadingVariable?: true } | undefined {
    if (typeof raw !== "string") return undefined;
    let text = raw.trim().replace(PLACEHOLDER, "{}");
    if (!text || /^\{\}$/.test(text)) return undefined;
    let leadingVariable: true | undefined;
    if (text.startsWith("{}")) {
        // `{{base}}/orders`, `{{base}}?x=1`: the variable stands for a host or a path prefix. `{{sub}}.example.test/x`: part of a host.
        if (!/^\{\}[/?#]/.test(text)) return undefined;
        text = text.replace(/^(?:\{\})+/, "");
        leadingVariable = true;
        if (text.startsWith("//")) text = text.replace(/^\/+/, "/");
    }
    let host: string | undefined;
    let rest = text;
    const abs = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(text);
    if (abs) {
        if (!/^(?:https?|wss?)$/i.test(abs[1]!)) return undefined;
        if (!abs[2] || abs[2].includes("{}") || abs[2].includes("@")) return undefined;
        host = normaliseHost(abs[1]!, abs[2]);
        if (!host) return undefined;
        rest = abs[3] || "/";
    } else if (text.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(text)) return undefined; // another site with no scheme, or mailto:, javascript:, data:
    const hashAt = rest.indexOf("#");
    const hash = hashAt >= 0 ? rest.slice(hashAt + 1) : "";
    const beforeHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
    const qAt = beforeHash.indexOf("?");
    const pathPart = qAt >= 0 ? beforeHash.slice(0, qAt) : beforeHash;
    const query = new Set(queryNames(qAt >= 0 ? beforeHash.slice(qAt + 1) : ""));
    const path = normalisePath(pathPart.startsWith("/") ? pathPart : `/${pathPart}`);
    let route: string | undefined;
    // A hash route (`#/orders/12?tab=x`) is a page of a single-page app; a plain anchor (`#top`) is not.
    if (hash.startsWith("/") || hash.startsWith("!/")) {
        const r = hash.replace(/^!/, "");
        const rq = r.indexOf("?");
        route = normalisePath(rq >= 0 ? r.slice(0, rq) : r);
        for (const n of queryNames(rq >= 0 ? r.slice(rq + 1) : "")) query.add(n);
    }
    return { ...(host ? { host } : {}), path, query: [...query].sort(), ...(route ? { route } : {}), ...(leadingVariable ? { leadingVariable } : {}) };
}

/** The limit of a web test whose run called another site's endpoints while the application's API address is not set (preview.ts reads it). */
export const UNKNOWN_SITE_LIMIT = "A run called endpoints on another site, and the application's API address is not set, so whether they are the application's own API is not known.";

/** Names of the `{{variables}}` in the path part of a request address, after any leading one (`{{base}}/orders`: splitAddress's leadingVariable). */
function pathVariables(raw: string): string[] {
    const rest = raw.trim().replace(/^(?:\{\{[^}]*\}\})+/, "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
    return [...rest.split(/[?#]/)[0]!.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]!);
}
/**
 * A variable's test data value that fills one part of a path. A variable not in the test data (set while the test runs, or a data-set
 * column) may hold several parts, so it is not taken as one.
 */
const oneSegment = (value: unknown): boolean => (typeof value === "string" || typeof value === "number") && /^[^/?#\\]+$/.test(String(value));

/** The names of the `{{variables}}` that are a whole part of the address's path (`/orders/{{id}}/pay`, not `/orders/ord-{{id}}`). */
function wholeSegmentVariables(raw: string): Set<string> {
    const rest = raw.trim().replace(/^(?:\{\{[^}]*\}\})+/, "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
    return new Set(rest.split(/[?#]/)[0]!.split("/").flatMap((seg) => /^\{\{\s*([^}]*?)\s*\}\}$/.exec(seg)?.slice(1, 2) ?? []));
}

function queryNames(q: string): string[] {
    const out: string[] = [];
    for (const part of q.split("&")) {
        const name = part.split("=")[0]!.trim();
        if (!name || name.includes("{}")) continue;
        let decoded = name;
        try {
            decoded = decodeURIComponent(name.replace(/\+/g, " "));
        } catch {
            /* keep the name as written */
        }
        if (decoded.length <= 60) out.push(decoded);
    }
    return out;
}

/** Decode percent-escapes of unreserved characters (RFC 3986 2.3); upper-case the hex of the others. */
const decodeUnreserved = (seg: string): string =>
    seg.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => {
        const c = String.fromCharCode(parseInt(hex, 16));
        return /[A-Za-z0-9\-._~]/.test(c) ? c : `%${hex.toUpperCase()}`;
    });

/** A segment that holds a variable (`{x}`, `:x`, `*`) or an id is `{}`; the rest is the drift convention (`templatePath`). */
export function normalisePath(path: string): string {
    const segs = path.split("/").map((raw) => {
        const s = decodeUnreserved(raw);
        return s.includes("{") || s.includes("}") || /^:[A-Za-z_]/.test(s) || s === "*" ? "{}" : s;
    });
    return templatePath(segs.join("/") || "/");
}

/** `POST /orders/{id}?x=1`, `GET https://api.example.test/v1/items`, `/orders` (any method). */
export function parseEndpoint(raw: string): { method?: (typeof HTTP_METHODS)[number]; host?: string; path: string; query: string[] } | undefined {
    const m = /^\s*(?:([A-Za-z]+|\*)\s+)?(\S+)\s*$/.exec(raw ?? "");
    if (!m) return undefined;
    const method = m[1] && m[1] !== "*" ? m[1].toUpperCase() : undefined;
    if (method && !(HTTP_METHODS as readonly string[]).includes(method)) return undefined;
    const a = splitAddress(m[2]!);
    // An endpoint has no hash route: "#..." would be a page address given as an endpoint.
    if (!a || a.route) return undefined;
    return { ...(method ? { method: method as (typeof HTTP_METHODS)[number] } : {}), ...(a.host ? { host: a.host } : {}), path: a.path, query: a.query };
}

/**
 * What an access check (`assert` with check "accessDenied") opens: its settings are JSON with `path` (a page), or `api: true` with `path`
 * and the API's `origin` (one GET of that address). Undefined when the settings cannot be read.
 */
export function accessTarget(expected: unknown): { kind: "page" | "endpoint"; address: NonNullable<ReturnType<typeof splitAddress>> } | undefined {
    let cfg: unknown;
    try {
        cfg = typeof expected === "string" ? JSON.parse(expected) : undefined;
    } catch {
        return undefined;
    }
    if (!cfg || typeof cfg !== "object") return undefined;
    const c = cfg as { api?: unknown; path?: unknown; origin?: unknown };
    if (typeof c.path !== "string" || !c.path.trim()) return undefined;
    if (c.api === true) {
        const path = c.path.trim();
        const origin = typeof c.origin === "string" && /^https?:\/\/[^/?#]+$/i.test(c.origin.trim().replace(/\/+$/, "")) ? c.origin.trim().replace(/\/+$/, "") : "";
        const a = splitAddress(origin && path.startsWith("/") && !path.startsWith("//") ? `${origin}${path}` : path);
        return a && !a.route ? { kind: "endpoint", address: a } : undefined;
    }
    const a = splitAddress(c.path);
    return a ? { kind: "page", address: a } : undefined;
}

export const pageKey = (a: { path: string; route?: string }): string => (a.route ? `${a.path}#${a.route}` : a.path);

/** One test's coverage. Never throws: what cannot be read becomes a limit. */
export function extractCoverage(t: TestFacts, app: AppFacts = {}): TestCoverage {
    const items = new Map<string, CoverageItem>();
    const limits: string[] = [];
    const steps = !t.specUnreadable && t.spec && typeof t.spec === "object" && Array.isArray((t.spec as { steps?: unknown }).steps) ? ((t.spec as { steps: unknown[] }).steps) : undefined;
    // Hosts the test's own request steps call are its API: the application's own for this test.
    const testHosts = new Set<string>();
    for (const raw of steps ?? []) {
        const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
        if (s?.action === "request" && typeof s.path === "string") {
            const h = splitAddress(s.path)?.host;
            if (h) testHosts.add(h);
        }
    }
    // `base`: the host the run itself opened (ObservedRun.baseHost); hosts are judged against it as well as against today's address.
    const addItem = (item: Omit<CoverageItem, "seenIn" | "external">, where: string, base?: string) => {
        const host = item.host && item.host !== (base ?? app.appHost) ? item.host : undefined;
        const external = host && !isOwnHost(host, app, testHosts) && !(base && isOwnHost(host, { ...app, appHost: base }, testHosts)) ? true : undefined;
        const k = [item.kind, host ?? "", item.method ?? "", item.type ?? "", item.path, item.source].join("|");
        const had = items.get(k);
        if (had) {
            for (const q of item.query) if (!had.query.includes(q)) had.query.push(q);
            had.query.sort();
            if (item.queryUnknown) had.queryUnknown = true;
            if (had.seenIn.length < MAX_SEEN && !had.seenIn.includes(where)) had.seenIn.push(where);
            return;
        }
        items.set(k, {
            kind: item.kind,
            path: item.path,
            ...(item.method ? { method: item.method } : {}),
            ...(host ? { host } : {}),
            ...(external ? { external } : {}),
            ...(item.type ? { type: item.type } : {}),
            query: [...item.query].sort(),
            ...(item.queryUnknown ? { queryUnknown: true as const } : {}),
            source: item.source,
            seenIn: [where],
        });
    };

    const add = (item: Omit<CoverageItem, "seenIn" | "external">, where: string) => addItem(item, where);
    const rawData = steps ? (t.spec as { testData?: unknown }).testData : undefined;
    const testData = rawData && typeof rawData === "object" ? (rawData as Record<string, unknown>) : {};
    let dynamicRequest = false;
    let prefixedRequest = false;
    let requests = 0;
    let navigates = 0;
    let unreachedBlocks = 0;
    let accessChecks = 0;
    let linkChecks = 0;
    let variablePath = false;
    // Values an earlier request step captured (`extract`); they hold what the application answered, one value each.
    const captured = new Set<string>();
    const templates = new Set((app.endpoints ?? []).map((e) => `${e.method.toUpperCase()} ${normalisePath(e.path)}`));
    if (!steps) {
        limits.push(t.specUnreadable ? "The test's stored steps could not be read." : "The test has no readable steps.");
    } else {
        steps.forEach((raw, i) => {
            if (!raw || typeof raw !== "object") return;
            const s = raw as Record<string, unknown>;
            const where = `step ${i + 1}`;
            if (s.action === "useBlock") unreachedBlocks++;
            if (s.action === "navigate" && typeof s.url === "string") {
                const a = splitAddress(s.url);
                if (a) {
                    navigates++;
                    add({ kind: "page", path: pageKey(a), ...(a.host ? { host: a.host } : {}), query: a.query, source: "declared" }, where);
                } else limits.push(`Step ${i + 1} opens an address made only of a variable, so which page it opens is not known.`);
            }
            if (s.action === "request" && typeof s.path === "string" && typeof s.method === "string") {
                const method = s.method.toUpperCase();
                const a = splitAddress(s.path);
                if (a && (HTTP_METHODS as readonly string[]).includes(method)) {
                    requests++;
                    // `{{base}}/orders`: the endpoint is matched by what follows the variable, but where it goes is not known.
                    if (a.leadingVariable) prefixedRequest = true;
                    // `/{{ordersPath}}` with test data ordersPath = "orders/list": the variable stands for several parts of the path (or for
                    // none), so the endpoint read from the step (`/{}`) is not the one called.
                    // A captured value that is a whole part of the path resolves to the application's template of that endpoint, if it has one.
                    const whole = wholeSegmentVariables(s.path);
                    const resolved = templates.has(`${method} ${a.path}`);
                    const knownCapture = (n: string) => !(n in testData) && captured.has(n) && whole.has(n) && resolved;
                    if (pathVariables(s.path).some((n) => !oneSegment(testData[n]) && !knownCapture(n))) variablePath = true;
                    const q = new Set(a.query);
                    if (s.query && typeof s.query === "object") for (const n of Object.keys(s.query as object)) if (n.length <= 60) q.add(n);
                    add({ kind: "endpoint", method: method as (typeof HTTP_METHODS)[number], path: a.path, ...(a.host ? { host: a.host } : {}), query: [...q], source: "declared" }, where);
                } else dynamicRequest = true;
                if (s.extract && typeof s.extract === "object") for (const n of Object.keys(s.extract as object)) captured.add(n);
            }
            // An access check opens its page (or calls its API address) in a browser of its own, signed in as another account: the run's
            // record never sees that traffic. Its target is read from the check's settings; what the page loads there stays unknown.
            if (s.action === "assert" && s.check === "accessDenied") {
                accessChecks++;
                const target = accessTarget(s.expected);
                if (target?.kind === "page") add({ kind: "page", path: pageKey(target.address), ...(target.address.host ? { host: target.address.host } : {}), query: target.address.query, source: "declared" }, where);
                else if (target) add({ kind: "endpoint", method: "GET", path: target.address.path, ...(target.address.host ? { host: target.address.host } : {}), query: target.address.query, source: "declared" }, where);
            }
            // A broken-links check asks for every link of the page through the browser's request channel (page.request), which the
            // run's record does not see: the test also depends on the pages those links lead to.
            if (s.action === "assert" && s.check === "noBrokenLinks") linkChecks++;
        });
        if (unreachedBlocks) limits.push("Some reusable steps could not be put in place, so what they do is not counted.");
        if (dynamicRequest) limits.push("A request's address is made only of a variable, so that endpoint is not known.");
        if (prefixedRequest) limits.push("A request's address starts with a variable, so where it is sent is not fully known.");
        if (variablePath) limits.push("A request's address has a variable inside its path that is missing from the test data or whose value is not one part of a path, so that endpoint is not fully known.");
        if (linkChecks) limits.push("A broken-links check asks for every link on its page outside the page itself, which the run's record does not see, so the pages it depends on are not all known.");
        if (accessChecks) limits.push("An access check opens its page as another account in a browser of its own, which the run's record does not see, so what that page loads is not known.");
    }

    // Observed: the newest runs of the current script only (an older script may have done something else). Every one adds what it
    // touched; only the latest relevant run, when it is fresh (freshnessOf), can make the test complete.
    let completeRun: ObservedRun | undefined;
    const runLimits: string[] = [];
    const fresh = t.freshness;
    if (!fresh.fresh) runLimits.push(fresh.why);
    else if (!t.runs.some((r) => r.executionId === fresh.executionId)) runLimits.push("Its latest run kept no readable record of what it touched, so what it touches now is not known.");
    for (const run of t.runs) {
        const where = `run of ${run.startedAt.slice(0, 10)}`;
        let unclassified = run.unclassified ?? 0;
        let touched = 0;
        const add = (item: Omit<CoverageItem, "seenIn" | "external">, where: string) => addItem(item, where, run.baseHost);
        for (const r of run.requests) {
            const type = String(r.type).toLowerCase();
            if (STATIC_TYPES.has(type)) continue;
            const a = splitAddress(r.host ? `http://${r.host}${r.path.startsWith("/") ? "" : "/"}${r.path}` : r.path);
            const method = String(r.method).toUpperCase();
            const knownMethod = (HTTP_METHODS as readonly string[]).includes(method) ? (method as (typeof HTTP_METHODS)[number]) : undefined;
            const base = { ...(a?.host ? { host: a.host } : {}), source: "observed" as const, ...(run.queryUnknown ? { queryUnknown: true as const } : {}) };
            if (!a) {
                unclassified++;
            } else if (type === "route" || (type === "document" && method === "GET")) {
                add({ kind: "page", path: pageKey(a), query: a.query, ...base }, where);
                touched++;
            } else if (type === "document" && knownMethod) {
                // A form sent to the server: the page it leads to and the endpoint it calls.
                add({ kind: "page", path: pageKey(a), query: a.query, ...base }, where);
                add({ kind: "endpoint", method: knownMethod, type: "form", path: a.path, query: a.query, ...base }, where);
                touched++;
            } else if ((type === "xhr" || type === "fetch") && knownMethod) {
                add({ kind: "endpoint", method: knownMethod, path: a.path, query: a.query, ...base }, where);
                touched++;
            } else if (TYPED[type]) {
                add({ kind: "endpoint", method: knownMethod ?? (type === "websocket" || type === "eventsource" ? "GET" : "POST"), type: TYPED[type], path: a.path, query: a.query, ...base }, where);
                touched++;
            } else {
                unclassified++;
            }
        }
        if (run.status !== "passed" || !fresh.fresh || run.executionId !== fresh.executionId) continue;
        if (!run.complete) runLimits.push(run.incompleteWhy ?? "The recorded runs failed or were cut down, so they show only part of what the test does.");
        else if (unclassified) runLimits.push(`A passing run made ${unclassified} request${unclassified === 1 ? "" : "s"} the mapping could not classify, so what it touched is not fully known.`);
        else if (!touched) runLimits.push("A passing run recorded no page or endpoint at all, so what it touched is not known.");
        else completeRun ??= run;
    }

    // Endpoints on another site while the application's API address is not set: they may well be the application's own API (on a
    // different site), so a change that names a path without a host could be one of them. Then what the test touches is not fully known.
    const unknownSite = !app.apiHosts?.length && [...items.values()].some((i) => i.kind === "endpoint" && i.external && i.source === "observed");
    if (unknownSite && t.kind === "web") limits.push(UNKNOWN_SITE_LIMIT);
    const kind = t.kind;
    let completeness: Completeness;
    let completeFrom: string | undefined;
    const list = [...items.values()];
    if (!steps || (kind !== "web" && kind !== "api")) {
        completeness = list.length ? "partial" : "unknown";
        if (steps && kind !== "web" && kind !== "api") limits.push(`What ${kind} tests touch is not mapped yet.`);
    } else if (kind === "api") {
        const declared = requests > 0 && !dynamicRequest && !prefixedRequest && !variablePath && !unreachedBlocks;
        completeness = declared && fresh.fresh ? "declared-complete" : list.length ? "partial" : "unknown";
        if (completeness === "declared-complete") completeFrom = "its steps";
        // Same freshness rules as web tests: why its latest run cannot vouch for its steps comes first.
        if (!fresh.fresh) limits.unshift(fresh.why);
        if (requests === 0 && !dynamicRequest) limits.push("The test sends no request the mapping can read.");
    } else if (completeRun && !unreachedBlocks && !dynamicRequest && !prefixedRequest && !variablePath && !accessChecks && !linkChecks && !unknownSite) {
        // Also not with a request step whose address is not fully known (web `request` steps run outside the page, so the record never
        // sees them), an access check, a broken-links check, or another site's endpoint while the application's API address is not set
        // (unknownSite).
        completeness = "observed-complete";
        completeFrom = `the passing run of ${completeRun.startedAt.slice(0, 10)}`;
    } else {
        completeness = list.length ? "partial" : "unknown";
        // Why the latest run cannot vouch for it comes first: that is what a person can act on (run it again).
        limits.unshift(...runLimits);
        if (navigates === 0 && !t.runs.length) limits.push("The test opens no address of its own, and no run of it recorded what it reached.");
        if (!completeRun) limits.push("Pages reached by clicking and requests the pages make are only known from a recorded run, and the latest run of this version is not a recent passing run with a complete record.");
    }
    if (t.runs.length && !completeRun && kind === "web" && t.runs.some((r) => r.status !== "passed")) limits.push("The recorded runs failed or were cut down, so they show only part of what the test does.");
    const stale = (kind === "web" || kind === "api") && steps && completeness !== "observed-complete" && !fresh.fresh && !fresh.never ? fresh.why : undefined;
    return { testId: t.id, testKey: t.testKey, title: t.title, kind, items: list.sort(byItem), completeness, limits: [...new Set(limits)], ...(completeFrom ? { completeFrom } : {}), ...(stale ? { stale } : {}) };
}

const sortKey = (i: CoverageItem) => [i.kind, i.host ?? "", i.path, i.method ?? "", i.type ?? "", i.source].join("\u0000");
const byItem = (a: CoverageItem, b: CoverageItem) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);
