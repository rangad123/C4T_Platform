/**
 * Evidence for web tests: what the page asked for and what the browser console said, kept in memory while the test runs and
 * written next to the result when the test fails; a passing test writes only its compact footprint.
 *
 * One source of truth: `EVIDENCE_HELPER_SOURCE` is plain JavaScript. The Playwright generator pastes it verbatim into every
 * web script (so a downloaded script records evidence on its own), and `loadEvidenceRuntime()` compiles the very same text
 * for the platform and for tests. That matters most for redaction: the script masks what it records, and the platform masks
 * it again with the same functions before anything is stored.
 *
 * What is recorded, per request: method, host (only when it is not the application's own), path and query with sensitive
 * values hidden, status, resource type, duration, size, why it failed, and the value of one allow-listed correlation header of the
 * response (x-request-id, x-correlation-id, traceparent, x-amzn-trace-id, cf-ray; masked, capped). Never: bodies, cookies, any other
 * header, a header added to a request, URL fragments or credentials inside a URL. Per console line: type, text (masked), where it came from.
 * A passing test keeps only its footprint (pages and endpoints touched, counts; see evidenceFootprint); full evidence carries it too.
 * The footprint is built from every request, navigation and WebSocket of the run (not from the capped request list), so the test-selection
 * preview can tell whether it saw everything: it says how many requests it could not classify, and "truncated" when anything was cut.
 *
 * What is hidden (replaced by "[hidden]"):
 *   - the value of a query parameter whose name suggests a secret (token, key, secret, password, auth, session, code, otp ...);
 *   - any exact occurrence of a credential the run used (read from the run's environment variables, plus the ones the
 *     platform passes in), also in URL-encoded form;
 *   - in console text and paths: bearer tokens, JWTs, cookie lines, "password=..." style pairs, well-known key formats,
 *     long hex / base64 looking strings.
 *
 * Bounded: at most 300 requests and 200 console lines are kept (boring successful ones are dropped first), 2 KB per message.
 * Keep the source free of backticks and "${": it lives in a template literal and is evaluated with `new Function`.
 */

import { CAPTCHA_PROBE_SOURCE } from "../auth/captcha.js";

export const EVIDENCE_MAX_REQUESTS = 300;
export const EVIDENCE_MAX_CONSOLE = 200;
export const EVIDENCE_MAX_TEXT = 2048;
/** Name of the attachment the script writes (and the runner looks for). */
export const EVIDENCE_ATTACHMENT = "evidence";

export const EVIDENCE_HELPER_SOURCE = String.raw`const EVIDENCE_MAX_REQUESTS = ${EVIDENCE_MAX_REQUESTS};
const EVIDENCE_MAX_CONSOLE = ${EVIDENCE_MAX_CONSOLE};
const EVIDENCE_MAX_TEXT = ${EVIDENCE_MAX_TEXT};
const EVIDENCE_RAW_TEXT = 8192;
const EVIDENCE_MAX_PATH = 400;
const EVIDENCE_HIDDEN = "[hidden]";
// A query parameter with one of these words in its name never keeps its value.
const EVIDENCE_SENSITIVE_NAME = /token|key(?!word)|secret|pass|pwd|auth|session|code|otp|signature|^sig$|credential|jwt|bearer|csrf|xsrf|cookie|^sid$|^sess/i;
// The same idea for "name=value" or "name: value" inside console text (no "code": "status code: 500" is not a secret).
const EVIDENCE_SENSITIVE_TEXT_NAME = /token|key(?!word)|secret|pass|pwd|auth|session|otp|signature|credential|jwt|bearer|csrf|xsrf|cookie|^sid$/i;
const EVIDENCE_NOT_A_TOKEN = /^(?:token|tokens|required|authentication|auth|header|scheme|missing|invalid|expired|realm|here|value|string)$/i;
// A setting whose name says it holds a secret (TEST_ENV_<name>), matched at the end of the name: the same rule as the platform's secret
// policy (engine/evidence/secret-policy.ts SECRET_SETTING_NAME; a test keeps the two equal). Never a bare "key", "id" or "code".
const EVIDENCE_SECRET_SETTING_NAME = /(?:pass(?:word|code|phrase)?|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|secret[_-]?key|signing[_-]?key|encryption[_-]?key|totp|otp[_-]?seed|auth[_-]?header|authori[sz]ation|cookies?|session(?:[_-]?(?:id|key))?|(?:^|[_-])sid|jwt|bearer|credentials?|connection[_-]?string|dsn)$/i;
// Ordinary setting values that are never secrets, whatever the setting is called (the same list as the platform's policy).
const EVIDENCE_NOT_A_SECRET = /^(?:true|false|null|none|nil|undefined|yes|no|on|off|enabled|disabled|default|empty|unset|required|optional)$/i;
const EVIDENCE_MAX_STACK = 1500;
// Response headers that say which request this was on the application's side (read from responses only; nothing is ever added to a request).
const EVIDENCE_CORRELATION_HEADERS = ["x-request-id", "x-correlation-id", "traceparent", "x-amzn-trace-id", "cf-ray"];
const EVIDENCE_MAX_CORR = 120;
// A passing test keeps only a compact footprint: what it touched, never what was said.
const EVIDENCE_FOOTPRINT_BYTES = 6000;
const EVIDENCE_FOOTPRINT_PAGES = 40;
const EVIDENCE_FOOTPRINT_ENDPOINTS = 80;
// What the recorder remembers for the footprint before it is shortened (raw entries; cut beyond this and the footprint says so).
const EVIDENCE_FP_RAW_PAGES = 200;
const EVIDENCE_FP_RAW_ENDPOINTS = 400;
// Resource types that are files a page loads, not pages or endpoints: left out of the footprint on purpose.
const EVIDENCE_STATIC_TYPES = ["stylesheet", "image", "media", "font", "script", "texttrack", "manifest"];
// Resource types the footprint records as typed endpoints (a beacon is "ping" in Chromium).
const EVIDENCE_TYPED = { eventsource: "eventsource", websocket: "websocket", ping: "beacon", beacon: "beacon" };
const EVIDENCE_STACK_FRAMES = 8;
${CAPTCHA_PROBE_SOURCE}

/** Values of the run's credentials: from the environment variables a script is given, plus any the caller adds. Shortest 4 characters. */
function evidenceSecrets(extra) {
    const found = new Set(Array.isArray(extra) ? extra : []);
    const env = typeof process !== "undefined" && process.env ? process.env : {};
    for (const k of Object.keys(env)) {
        const v = env[k];
        if (!v || v.length < 4) continue;
        const named = /(?:^|_)(?:PASS[W]ORD|SECRET|TOKEN|AUTH_HEADER)$/.test(k);
        // An environment's own setting (TEST_ENV_<name>) whose name says it is a secret.
        const setting = k.indexOf("TEST_ENV_") === 0 && EVIDENCE_SECRET_SETTING_NAME.test(k.slice(9)) && !EVIDENCE_NOT_A_SECRET.test(v.trim());
        if (!named && !setting) continue;
        found.add(v);
    }
    const out = new Set();
    for (const s of Array.from(found)) {
        if (typeof s !== "string" || s.length < 4) continue;
        out.add(s);
        // A "Name: value" header: the value alone must not survive either.
        const header = /^[A-Za-z][\w-]*:\s*(.{4,})$/.exec(s);
        if (header) {
            out.add(header[1]);
            // The credential alone, without its scheme word ("Bearer abc" -> "abc"), can show up on its own too.
            const scheme = /^(?:Bearer|Basic|Token|Digest|Api(?:Key)|Key)\s+(.{4,})$/i.exec(header[1].trim());
            if (scheme) out.add(scheme[1]);
        }
        const enc = encodeURIComponent(s);
        out.add(enc);
        out.add(enc.replace(/%20/g, "+"));
        out.add(enc.replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase()));
        out.add(JSON.stringify(s).slice(1, -1));
        try { out.add(encodeURI(s)); } catch (e) { /* unpaired surrogate: the other forms still apply */ }
    }
    return Array.from(out).filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

function evidenceExact(text, secrets) {
    let s = text;
    for (const sec of secrets || []) if (s.indexOf(sec) !== -1) s = s.split(sec).join(EVIDENCE_HIDDEN);
    return s;
}

function evidenceLooksSecret(tok) {
    return /[0-9=+]/.test(tok) || /[a-z][A-Z]/.test(tok) || tok.length >= 24;
}

function evidenceIsUuid(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Secrets that have a recognisable shape (no knowledge of the run needed). Safe to run twice. */
function evidenceScrub(input) {
    let s = input;
    s = s.replace(/\b(set-cookie|cookie)(\s*:\s*)[^\n]*/gi, (m, name, sep) => name + sep + EVIDENCE_HIDDEN);
    s = s.replace(/\b(Bearer)(\s+)([A-Za-z0-9._~+\/=-]{4,})/gi, (m, scheme, sp, tok) => (EVIDENCE_NOT_A_TOKEN.test(tok) ? m : scheme + sp + EVIDENCE_HIDDEN));
    s = s.replace(/\b(Basic|Digest|Token)(\s+)([A-Za-z0-9._~+\/=-]{6,})/g, (m, scheme, sp, tok) => (evidenceLooksSecret(tok) && !EVIDENCE_NOT_A_TOKEN.test(tok) ? scheme + sp + EVIDENCE_HIDDEN : m));
    s = s.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g, EVIDENCE_HIDDEN);
    s = s.replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bsk[-][A-Za-z0-9_-]{20,}/g, EVIDENCE_HIDDEN);
    s = s.replace(/(["']?)\b([A-Za-z_][\w.-]{0,60})\1(\s*[:=]\s*)("[^"\n]{0,2000}"|'[^'\n]{0,2000}'|\[hidden\]|[^\s,;&"'}\]]{1,2000})/g, (m, q, name, sep, val) => {
        if (!EVIDENCE_SENSITIVE_TEXT_NAME.test(name)) return m;
        const quote = val.charAt(0) === '"' || val.charAt(0) === "'" ? val.charAt(0) : "";
        return q + name + q + sep + quote + EVIDENCE_HIDDEN + quote;
    });
    s = s.replace(/[A-Za-z0-9_+=-]{32,}/g, (tok) => {
        if (evidenceIsUuid(tok)) return tok;
        const hex = /^[0-9a-fA-F]+$/.test(tok);
        const mixed = /[0-9]/.test(tok) && /[A-Za-z]/.test(tok);
        return hex || mixed || tok.length >= 64 ? EVIDENCE_HIDDEN : tok;
    });
    return s;
}

function evidenceClip(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Console text, error messages and other free text: masked first, then shortened (never the other way round: a cut could leave half a secret). */
function evidenceText(input, secrets, max) {
    let s = String(input == null ? "" : input);
    if (s.length > EVIDENCE_RAW_TEXT) s = s.slice(0, EVIDENCE_RAW_TEXT - 64) + "…";
    s = evidenceExact(s, secrets);
    s = s.replace(/\b(?:https?|wss?|ftp):\/\/(?:\[hidden\]|[^\s"'<>\\)\]}]){1,2000}/gi, (u) => {
        const parts = evidenceParseUrl(u);
        return parts ? parts.proto + "//" + parts.host + evidenceCleanPathQuery(parts, secrets) : evidenceScrub(u);
    });
    s = evidenceScrub(s);
    s = evidenceExact(s, secrets);
    return evidenceClip(s, max || EVIDENCE_MAX_TEXT);
}

function evidenceParseUrl(raw) {
    try {
        const u = new URL(String(raw).slice(0, 4096));
        return { proto: u.protocol, host: u.host, pathname: u.pathname, search: u.search };
    } catch (e) {
        return null;
    }
}

function evidenceParam(part, secrets) {
    const i = part.indexOf("=");
    const rawName = i < 0 ? part : part.slice(0, i);
    const value = i < 0 ? "" : part.slice(i + 1);
    let name = rawName;
    try { name = decodeURIComponent(rawName.replace(/\+/g, " ")); } catch (e) { /* keep the raw name */ }
    const shownName = evidenceScrub(evidenceExact(rawName, secrets));
    if (i < 0) return shownName;
    if (EVIDENCE_SENSITIVE_NAME.test(name)) return shownName + "=" + EVIDENCE_HIDDEN;
    let decoded = value;
    try { decoded = decodeURIComponent(value.replace(/\+/g, " ")); } catch (e) { /* keep the raw value */ }
    // A secret hiding inside an encoded value hides the whole value.
    if (evidenceExact(decoded, secrets) !== decoded || evidenceScrub(decoded) !== decoded) return shownName + "=" + EVIDENCE_HIDDEN;
    const shown = evidenceScrub(evidenceExact(value, secrets));
    return shownName + "=" + evidenceClip(shown, 200);
}

/** Path plus query of a parsed URL, without fragment and without credentials, sensitive values hidden. */
function evidenceCleanPathQuery(parts, secrets) {
    const path = evidenceScrub(evidenceExact(parts.pathname, secrets));
    const query = parts.search && parts.search.length > 1 ? parts.search.slice(1).split("&").map((p) => evidenceParam(p, secrets)).join("&") : "";
    return evidenceClip(query ? path + "?" + query : path, EVIDENCE_MAX_PATH);
}

/** { host (only when it is not the application's own), path } for the address of a request. */
function evidenceSplitUrl(raw, baseHost, secrets) {
    const parts = evidenceParseUrl(raw);
    if (!parts) return { path: evidenceText(raw, secrets, 300) };
    const path = evidenceCleanPathQuery(parts, secrets);
    return parts.host === baseHost ? { path: path } : { host: evidenceText(parts.host, secrets, 100), path: path };
}

const EVIDENCE_RECORDERS = new WeakMap();

function evidenceHostOf(url) {
    try { return new URL(url).host; } catch (e) { return ""; }
}

/** Drop the oldest entry that is not interesting (an answered, non-error one), else the oldest. */
function evidencePush(list, entry, max, interesting) {
    list.push(entry);
    if (list.length <= max) return 1;
    let at = list.findIndex((x) => !interesting(x));
    if (at < 0) at = 0;
    list.splice(at, 1);
    return 1;
}

function evidenceHook(page, rec) {
    page.on("request", (r) => {
        const url = r.url();
        if (url.indexOf("data:") === 0 || url.indexOf("blob:") === 0) return;
        rec.totalReqs++;
        const e = { t: Date.now() - rec.t0, step: rec.step, method: r.method(), url: url.slice(0, 4096), type: r.resourceType(), t1: Date.now() };
        rec.byRequest.set(r, e);
        evidencePush(rec.reqs, e, EVIDENCE_MAX_REQUESTS, (x) => x.status === undefined || x.status >= 400 || x.failed);
        e.fp = evidenceFpRequest(rec, e);
    });
    page.on("response", (res) => {
        const e = rec.byRequest.get(res.request());
        if (!e) return;
        e.status = res.status();
        if (e.fp && e.fp.statuses.indexOf(e.status) < 0 && e.fp.statuses.length < 4) e.fp.statuses.push(e.status);
        // Only the length and one allow-listed correlation header are read; no other header is ever stored.
        const headers = res.headers();
        const len = parseInt(headers["content-length"] || "", 10);
        if (len >= 0) e.size = len;
        for (const h of EVIDENCE_CORRELATION_HEADERS) {
            const v = headers[h];
            if (typeof v === "string" && v) {
                e.corr = { name: h, value: v.slice(0, 400) };
                break;
            }
        }
    });
    page.on("requestfinished", (r) => {
        const e = rec.byRequest.get(r);
        if (!e) return;
        e.ms = Date.now() - e.t1;
        if (e.fp && (e.fp.ms === undefined || e.ms > e.fp.ms)) e.fp.ms = e.ms;
    });
    page.on("requestfailed", (r) => {
        const e = rec.byRequest.get(r);
        if (!e) return;
        const reason = (r.failure() && r.failure().errorText) || "network error";
        e.failed = reason;
        e.ms = Date.now() - e.t1;
        if (/ERR_ABORTED|NS_BINDING_ABORTED|cancel/i.test(reason)) e.aborted = true;
    });
    const log = (entry) => {
        rec.totalLogs++;
        evidencePush(rec.logs, entry, EVIDENCE_MAX_CONSOLE, (x) => x.type === "error" || x.type === "pageerror" || x.type === "warning");
    };
    page.on("console", (m) => {
        const loc = m.location();
        log({ t: Date.now() - rec.t0, step: rec.step, type: m.type(), text: m.text().slice(0, EVIDENCE_RAW_TEXT), loc: loc && loc.url ? { url: loc.url, line: loc.lineNumber } : undefined });
    });
    // Every address the main frame reaches, also without loading a document (pushState, hash routes): a page of the footprint.
    page.on("framenavigated", (f) => {
        try { if (f === page.mainFrame()) evidenceFpPage(rec, String(f.url()).slice(0, 4096), rec.step); } catch (e) { /* a closed page */ }
    });
    // A WebSocket does not go through "request": recorded here as a typed endpoint.
    page.on("websocket", (ws) => {
        try { evidenceFpEndpoint(rec, "GET", String(ws.url()).slice(0, 4096), "websocket", rec.step); } catch (e) { rec.fp.unclassified++; }
    });
    // The page's title as of its last load, for the step markers (see evidenceStep).
    page.on("load", () => {
        let at = "";
        try { at = String(page.url()).slice(0, 4096); } catch (e) { return; }
        const since = Date.now() - rec.t0;
        page.title().then((t) => {
            // A title that came back after the page moved on belongs to the next page (Chromium answers "Loading <address>"): not kept.
            let now = "";
            try { now = String(page.url()).slice(0, 4096); } catch (e) { return; }
            if (now !== at) return;
            const text = String(t).slice(0, 500);
            rec.titles.set(page, { url: at, text: text });
            // A step that began on this page before its title came back gets it now.
            for (const st of rec.steps) if (st.t >= since && st.url === at && st.title === undefined) st.title = text;
        }, () => undefined);
    });
    page.on("pageerror", (e) => {
        const entry = { t: Date.now() - rec.t0, step: rec.step, type: "pageerror", text: String((e && e.message) || e || "").slice(0, EVIDENCE_RAW_TEXT) };
        // The first frames of the stack (where in the page's code it happened); masked when the evidence is written.
        const stack = e && typeof e.stack === "string" ? e.stack.split("\n").filter((l) => /^\s*at\s|@/.test(l)).slice(0, EVIDENCE_STACK_FRAMES).map((l) => l.trim()).join("\n") : "";
        if (stack) entry.stack = stack.slice(0, EVIDENCE_RAW_TEXT);
        log(entry);
    });
}

/** A page the run was on (raw address; cleaned when the footprint is written). */
function evidenceFpPage(rec, url, step) {
    if (!/^https?:/i.test(url)) return;
    const fp = rec.fp;
    const key = url.split("?")[0];
    if (fp.pageKeys.has(key)) return;
    if (fp.pages.length >= EVIDENCE_FP_RAW_PAGES) { fp.over = true; return; }
    fp.pageKeys.add(key);
    fp.pages.push({ url: url, step: step });
}

/** An endpoint the run called (raw address), counted; the entry gets the statuses and the slowest time later. */
function evidenceFpEndpoint(rec, method, url, type, step) {
    const fp = rec.fp;
    const key = method + " " + (type || "") + " " + url.split("?")[0].split("#")[0];
    const had = fp.endpoints.get(key);
    if (had) { had.n++; return had; }
    if (fp.endpoints.size >= EVIDENCE_FP_RAW_ENDPOINTS) { fp.over = true; return undefined; }
    const entry = { method: method, url: url, type: type, step: step, n: 1, statuses: [] };
    fp.endpoints.set(key, entry);
    return entry;
}

/** Classify one request for the footprint: a page, an endpoint, a typed endpoint, a file (ignored), or unclassified (counted). */
function evidenceFpRequest(rec, e) {
    const type = String(e.type || "").toLowerCase();
    const method = String(e.method || "GET").toUpperCase().slice(0, 12);
    if (!/^(?:https?|wss?):/i.test(e.url)) { rec.fp.unclassified++; return undefined; }
    if (type === "document") {
        evidenceFpPage(rec, e.url, e.step);
        // A form sent to the server is an endpoint as well as the page it leads to.
        return method === "GET" ? undefined : evidenceFpEndpoint(rec, method, e.url, "document", e.step);
    }
    if (type === "fetch" || type === "xhr") return evidenceFpEndpoint(rec, method, e.url, "", e.step);
    if (EVIDENCE_TYPED[type]) return evidenceFpEndpoint(rec, method, e.url, EVIDENCE_TYPED[type], e.step);
    if (EVIDENCE_STATIC_TYPES.indexOf(type) >= 0) return undefined;
    rec.fp.unclassified++;
    return undefined;
}

/** A page's address for the footprint: path (host first when it is another site's), plus a hash route ("#/cart/7"), masked; no query. */
function evidenceFpPagePath(url, baseHost, secrets) {
    const parts = evidenceParseUrl(url);
    if (!parts) return "";
    let path = evidenceClip(evidenceScrub(evidenceExact(parts.pathname, secrets)), 200);
    const hashAt = url.indexOf("#");
    const hash = hashAt >= 0 ? url.slice(hashAt + 1) : "";
    // Only a route ("#/cart", "#!/cart") is kept; anything else after "#" (an anchor, a token handed over in the fragment) never is.
    if (hash.charAt(0) === "/" || hash.slice(0, 2) === "!/") {
        const route = hash.replace(/^!/, "").split("?")[0];
        path = path + "#" + evidenceClip(evidenceScrub(evidenceExact(route, secrets)), 120);
    }
    return parts.host === baseHost ? path : evidenceText(parts.host, secrets, 100) + path;
}

/**
 * The footprint of a recording: every page and endpoint the run touched, from the recorder's own tally (not the capped request list).
 * "unclassified" counts requests of a kind it does not map (so the coverage of the run is not complete); "truncated" says something was
 * left out to stay within the size limits.
 */
function evidenceFootprintOf(rec, secrets) {
    const fp = rec.fp;
    let truncated = fp.over;
    const pages = [];
    const seenPages = new Set();
    for (const p of fp.pages) {
        const path = evidenceFpPagePath(p.url, rec.base, secrets);
        if (!path || seenPages.has(path)) continue;
        if (pages.length >= EVIDENCE_FOOTPRINT_PAGES) { truncated = true; break; }
        seenPages.add(path);
        pages.push({ path: path, step: p.step });
    }
    const endpoints = new Map();
    for (const r of Array.from(fp.endpoints.values())) {
        const u = evidenceSplitUrl(r.url, rec.base, secrets);
        const path = evidenceClip(u.path.split("?")[0], 200);
        const key = r.method + " " + (r.type || "") + " " + (u.host || "") + path;
        const had = endpoints.get(key);
        if (had) {
            had.n += r.n;
            for (const s of r.statuses) if (had.statuses.indexOf(s) < 0 && had.statuses.length < 4) had.statuses.push(s);
            if (r.ms !== undefined && (had.ms === undefined || r.ms > had.ms)) had.ms = r.ms;
            continue;
        }
        if (endpoints.size >= EVIDENCE_FOOTPRINT_ENDPOINTS) { truncated = true; break; }
        const o = { method: r.method, path: path, step: r.step, n: r.n, statuses: r.statuses.slice(0, 4) };
        if (u.host) o.host = u.host;
        if (r.type) o.type = r.type;
        if (r.ms !== undefined) o.ms = r.ms;
        endpoints.set(key, o);
    }
    const out = { pages: pages, endpoints: Array.from(endpoints.values()) };
    if (fp.unclassified) out.unclassified = fp.unclassified;
    if (truncated) out.truncated = true;
    return out;
}

/** Start recording. Call once per test, before the first navigation. Cheap: it only keeps small objects in memory. */
function installEvidence(page, baseUrl) {
    const rec = { t0: Date.now(), base: evidenceHostOf(baseUrl), step: 0, steps: [], reqs: [], totalReqs: 0, logs: [], totalLogs: 0, byRequest: new WeakMap(), titles: new WeakMap(), fp: { pages: [], pageKeys: new Set(), endpoints: new Map(), unclassified: 0, over: false } };
    EVIDENCE_RECORDERS.set(page, rec);
    evidenceHook(page, rec);
    // A popup the page opens is part of the same story.
    try { page.context().on("page", (p) => evidenceHook(p, rec)); } catch (e) { /* recording the main page is enough */ }
    return rec;
}

/** The test is now at step n (1-based): requests and console lines from here on belong to it. */
function evidenceStep(page, n) {
    const rec = EVIDENCE_RECORDERS.get(page);
    if (!rec) return;
    rec.step = n;
    if (rec.steps.length >= 200) return;
    // Where the page was when the step began: its address, and the title it had when it last finished loading (read when it loads, never
    // waited for here: a title read now could arrive after the next page has started).
    const entry = { n: n, t: Date.now() - rec.t0 };
    try { entry.url = String(page.url()).slice(0, 4096); } catch (e) { /* a closed page has no address */ }
    const title = rec.titles.get(page);
    if (title && title.url === entry.url) entry.title = title.text;
    rec.steps.push(entry);
}

/** A page error's stack, masked like console text: addresses in it lose their host when it is the application's own, and their query values. */
function evidenceStack(stack, baseHost, secrets) {
    const lines = String(stack).split("\n").slice(0, EVIDENCE_STACK_FRAMES).map((l) => evidenceText(l, secrets, 300));
    return evidenceClip(lines.join("\n"), EVIDENCE_MAX_STACK);
}

/** The recording as plain data: every string masked, every list bounded. */
function evidenceSerialize(rec, secrets) {
    const requests = rec.reqs.map((e) => {
        const u = evidenceSplitUrl(e.url, rec.base, secrets);
        const o = { t: e.t, step: e.step, method: evidenceClip(String(e.method), 12), type: evidenceClip(String(e.type), 24), path: u.path };
        if (u.host) o.host = u.host;
        if (e.status !== undefined) o.status = e.status;
        if (e.ms !== undefined) o.ms = e.ms;
        if (e.size !== undefined) o.size = e.size;
        if (e.failed) o.failed = evidenceText(e.failed, secrets, 120);
        if (e.aborted) o.aborted = true;
        if (e.corr) o.corr = e.corr.name + ": " + evidenceText(e.corr.value, secrets, EVIDENCE_MAX_CORR);
        if (e.status === undefined && !e.failed) o.pending = true;
        return o;
    });
    const logs = rec.logs.map((l) => {
        const o = { t: l.t, step: l.step, type: evidenceClip(String(l.type), 16), text: evidenceText(l.text, secrets, EVIDENCE_MAX_TEXT) };
        if (l.loc) {
            const u = evidenceSplitUrl(l.loc.url, rec.base, secrets);
            o.loc = (u.host ? u.host : "") + u.path.split("?")[0] + (l.loc.line >= 0 ? ":" + l.loc.line : "");
        }
        if (l.stack) o.stack = evidenceStack(l.stack, rec.base, secrets);
        return o;
    });
    const steps = rec.steps.map((st) => {
        const o = { n: st.n, t: st.t };
        if (st.url && st.url !== "about:blank") {
            const u = evidenceSplitUrl(st.url, rec.base, secrets);
            o.url = (u.host ? u.host : "") + u.path;
        }
        if (st.title) o.title = evidenceText(st.title, secrets, 120);
        return o;
    });
    return {
        v: 1,
        durationMs: Date.now() - rec.t0,
        counts: { requests: rec.totalReqs, requestsKept: requests.length, console: rec.totalLogs, consoleKept: logs.length },
        steps: steps,
        requests: requests,
        console: logs,
        footprint: evidenceFootprint(rec, secrets).footprint,
        ...(rec.captcha ? { captcha: rec.captcha } : {}),
    };
}

/**
 * A passing test's footprint: the pages it was on (also routes reached inside the page) and the endpoints it called (method, cleaned path
 * without query values, type when not fetch/XHR, status, first step, count, slowest time), with the counts and duration. No console text,
 * no bodies, no header values, no picture. At most EVIDENCE_FOOTPRINT_BYTES: step times go first, then pages and endpoints, and then the
 * footprint is marked "truncated".
 */
function evidenceFootprint(rec, secrets) {
    const out = {
        v: 1,
        durationMs: Date.now() - rec.t0,
        counts: { requests: rec.totalReqs, requestsKept: 0, console: rec.totalLogs, consoleKept: 0 },
        steps: rec.steps.map((st) => ({ n: st.n, t: st.t })),
        requests: [],
        console: [],
        footprint: evidenceFootprintOf(rec, secrets),
    };
    const f = out.footprint;
    while (JSON.stringify(out).length > EVIDENCE_FOOTPRINT_BYTES && (f.endpoints.length || f.pages.length || out.steps.length)) {
        if (out.steps.length) { out.steps.pop(); continue; }
        if (f.endpoints.length > f.pages.length) f.endpoints.pop();
        else f.pages.pop();
        f.truncated = true;
    }
    return out;
}

/**
 * After a test: a failed test attaches its full evidence (so does every test with AITP_EVIDENCE=always); a passing one attaches only its
 * footprint (none with AITP_EVIDENCE=failures).
 */
async function evidenceAttach(page, testInfo) {
    const passed = testInfo.status === testInfo.expectedStatus && process.env.AITP_EVIDENCE !== "always";
    if (passed && process.env.AITP_EVIDENCE === "failures") return;
    const rec = EVIDENCE_RECORDERS.get(page);
    if (!rec) return;
    // A failed test notes a captcha a person could see on the page at that moment (the platform reports that instead of the failure).
    if (!passed && page && typeof page.evaluate === "function") {
        try {
            rec.captcha = await Promise.race([page.evaluate(captchaProbe), new Promise((done) => setTimeout(() => done(null), 2000))]) || undefined;
        } catch (e) { /* a closed page shows nothing */ }
    }
    try {
        const secrets = evidenceSecrets();
        const body = JSON.stringify(passed ? evidenceFootprint(rec, secrets) : evidenceSerialize(rec, secrets));
        await testInfo.attach(${JSON.stringify(EVIDENCE_ATTACHMENT)}, { body: body, contentType: "application/json" });
    } catch (e) {
        /* evidence is a bonus: never fail a test because of it */
    }
}
`;

/** The functions of the helper, compiled for the platform and for tests (the very text a script carries). */
export interface EvidenceRuntime {
    evidenceSecrets(extra?: string[]): string[];
    evidenceText(input: unknown, secrets: string[], max?: number): string;
    evidenceSplitUrl(raw: string, baseHost: string, secrets: string[]): { host?: string; path: string };
    installEvidence(page: unknown, baseUrl: string): unknown;
    evidenceStep(page: unknown, n: number): void;
    evidenceSerialize(rec: unknown, secrets: string[]): unknown;
    evidenceFootprint(rec: unknown, secrets: string[]): unknown;
    evidenceAttach(page: unknown, testInfo: unknown): Promise<void>;
}

let runtime: EvidenceRuntime | undefined;

export function loadEvidenceRuntime(): EvidenceRuntime {
    runtime ??= new Function(
        `${EVIDENCE_HELPER_SOURCE}\nreturn { evidenceSecrets, evidenceText, evidenceSplitUrl, installEvidence, evidenceStep, evidenceSerialize, evidenceFootprint, evidenceAttach };`,
    )() as EvidenceRuntime;
    return runtime;
}
