/**
 * Failure evidence for web tests: what the page asked for and what the browser console said, kept in memory while the
 * test runs and written next to the result only when the test fails.
 *
 * One source of truth: `EVIDENCE_HELPER_SOURCE` is plain JavaScript. The Playwright generator pastes it verbatim into every
 * web script (so a downloaded script records evidence on its own), and `loadEvidenceRuntime()` compiles the very same text
 * for the platform and for tests. That matters most for redaction: the script masks what it records, and the platform masks
 * it again with the same functions before anything is stored.
 *
 * What is recorded, per request: method, host (only when it is not the application's own), path and query with sensitive
 * values hidden, status, resource type, duration, size, and why it failed. Never: bodies, cookies, any header (headers are
 * not read at all), URL fragments or credentials inside a URL. Per console line: type, text (masked), where it came from.
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

/** Values of the run's credentials: from the environment variables a script is given, plus any the caller adds. Shortest 4 characters. */
function evidenceSecrets(extra) {
    const found = new Set(Array.isArray(extra) ? extra : []);
    const env = typeof process !== "undefined" && process.env ? process.env : {};
    for (const k of Object.keys(env)) {
        const v = env[k];
        if (!v || v.length < 4) continue;
        if (!/(?:^|_)(?:PASS[W]ORD|SECRET|TOKEN|AUTH_HEADER)$/.test(k)) continue;
        found.add(v);
    }
    const out = new Set();
    for (const s of Array.from(found)) {
        if (typeof s !== "string" || s.length < 4) continue;
        out.add(s);
        // A "Name: value" header: the value alone must not survive either.
        const header = /^[A-Za-z][\w-]*:\s*(.{4,})$/.exec(s);
        if (header) out.add(header[1]);
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
    });
    page.on("response", (res) => {
        const e = rec.byRequest.get(res.request());
        if (!e) return;
        e.status = res.status();
        // Only the length is read from the headers; no header is ever stored.
        const len = parseInt(res.headers()["content-length"] || "", 10);
        if (len >= 0) e.size = len;
    });
    page.on("requestfinished", (r) => {
        const e = rec.byRequest.get(r);
        if (e) e.ms = Date.now() - e.t1;
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
    page.on("pageerror", (e) => {
        log({ t: Date.now() - rec.t0, step: rec.step, type: "pageerror", text: String((e && e.message) || e || "").slice(0, EVIDENCE_RAW_TEXT) });
    });
}

/** Start recording. Call once per test, before the first navigation. Cheap: it only keeps small objects in memory. */
function installEvidence(page, baseUrl) {
    const rec = { t0: Date.now(), base: evidenceHostOf(baseUrl), step: 0, steps: [], reqs: [], totalReqs: 0, logs: [], totalLogs: 0, byRequest: new WeakMap() };
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
    if (rec.steps.length < 200) rec.steps.push({ n: n, t: Date.now() - rec.t0 });
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
        if (e.status === undefined && !e.failed) o.pending = true;
        return o;
    });
    const logs = rec.logs.map((l) => {
        const o = { t: l.t, step: l.step, type: evidenceClip(String(l.type), 16), text: evidenceText(l.text, secrets, EVIDENCE_MAX_TEXT) };
        if (l.loc) {
            const u = evidenceSplitUrl(l.loc.url, rec.base, secrets);
            o.loc = (u.host ? u.host : "") + u.path.split("?")[0] + (l.loc.line >= 0 ? ":" + l.loc.line : "");
        }
        return o;
    });
    return {
        v: 1,
        durationMs: Date.now() - rec.t0,
        counts: { requests: rec.totalReqs, requestsKept: requests.length, console: rec.totalLogs, consoleKept: logs.length },
        steps: rec.steps,
        requests: requests,
        console: logs,
    };
}

/** After a test: attach the evidence when it failed (or when AITP_EVIDENCE=always). A passing test attaches nothing. */
async function evidenceAttach(page, testInfo) {
    if (testInfo.status === testInfo.expectedStatus && process.env.AITP_EVIDENCE !== "always") return;
    const rec = EVIDENCE_RECORDERS.get(page);
    if (!rec) return;
    try {
        const body = JSON.stringify(evidenceSerialize(rec, evidenceSecrets()));
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
    evidenceAttach(page: unknown, testInfo: unknown): Promise<void>;
}

let runtime: EvidenceRuntime | undefined;

export function loadEvidenceRuntime(): EvidenceRuntime {
    runtime ??= new Function(
        `${EVIDENCE_HELPER_SOURCE}\nreturn { evidenceSecrets, evidenceText, evidenceSplitUrl, installEvidence, evidenceStep, evidenceSerialize, evidenceAttach };`,
    )() as EvidenceRuntime;
    return runtime;
}
