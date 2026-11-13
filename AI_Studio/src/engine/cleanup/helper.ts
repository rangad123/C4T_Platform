/**
 * Test-data cleanup, the part that runs inside a generated API script.
 *
 * A data-changing API test (a POST that succeeds) leaves a record behind in the real application. This module decides
 * three things, with plain rules and no model:
 *   - which POST answers name a newly created record (a JSON `id`, `<singular>Id`, `<singular>_id` or `uuid`, or a
 *     `Location` header on the same resource);
 *   - which DELETE operation removes it (only one the API description, or the test itself, knows: `DELETE /things/{id}`
 *     for `POST /things`; never a guess, never a listing, never "delete everything");
 *   - what the script writes down about it (the path and the id; never a body, a header or a token).
 *
 * `CLEANUP_HELPER_SOURCE` is plain JavaScript pasted into every API script that can POST (so a downloaded script runs on its
 * own) and compiled for the platform and the tests from the same text. `CLEANUP_SCRIPT_SOURCE` is the script-only part
 * (hooks into the script's `call()` helper and removes records after each test).
 *
 * Who removes the records in one run (exactly one party):
 *   AITP_CLEANUP unset or "self"  the script itself, after each test (a downloaded script run on its own);
 *   AITP_CLEANUP="platform"       the platform, after the whole run (it keeps a ledger of what it removed and what it could not);
 *   AITP_CLEANUP="off"            nobody: cleanup is switched off for the project and the ledger says the records stay.
 * In the last two cases the script only writes what it created to `AITP_CREATED_DIR/<test>.jsonl`, one line per event, as it
 * happens (so a run that is killed on a timeout still tells the platform what it created).
 */
import type { Step, TestSpec } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";

/** POSTs to paths like these answer with tokens or results, not with a record that was created. */
export const CLEANUP_IGNORED_PATHS = String.raw`/(login|log-in|signin|sign-in|signout|logout|token|oauth|authenticate|auth|search|query|graphql|verify|refresh)(/|$)`;

/** Shape of a run tag (testdata/generate.ts): "qa" and four letters or digits. */
export const RUN_TAG = /^qa[0-9a-z]{4}$/;
/** The testData key holding the run tag of a spec's generated data. */
export const RUN_TAG_KEY = "runTag";

/** The run tag a spec's generated data carries, if any. */
export const runTagOf = (spec: Pick<TestSpec, "testData">): string | undefined => {
    const t = (spec.testData as Record<string, string> | undefined)?.[RUN_TAG_KEY];
    return typeof t === "string" && RUN_TAG.test(t) ? t : undefined;
};

/** Cap on the records kept per test (a runaway loop must not fill the ledger). */
export const MAX_RECORDS_PER_TEST = 200;

export const CLEANUP_HELPER_SOURCE = String.raw`const CLEANUP_IGNORED = new RegExp(${JSON.stringify(CLEANUP_IGNORED_PATHS)}, "i");
function cleanupSegments(p) {
    return String(p == null ? "" : p).split(/[?#]/)[0].split("/").filter(Boolean);
}
function cleanupIsParam(seg) {
    return /^\{[^{}]*\}$/.test(seg);
}
function cleanupSingular(word) {
    const w = String(word).toLowerCase();
    if (/ies$/.test(w) && w.length > 3) return w.slice(0, -3) + "y";
    if (/(ss|us|is)$/.test(w)) return w;
    return /s$/.test(w) ? w.slice(0, -1) : w;
}
function cleanupUsableId(v) {
    if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : undefined;
    if (typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v)) return v;
    return undefined;
}
/** The path (only) of a URL that is on the API's own origin; anything else (another host, another scheme) is not ours to touch. */
function cleanupPathOf(raw, base) {
    try {
        const b = new URL(base);
        const u = new URL(String(raw), b);
        if (u.origin !== b.origin) return undefined;
        return u.pathname;
    } catch {
        return undefined;
    }
}
/** Is a POST to this path one that creates a record (and not a login, a search or a token request)? */
function cleanupCandidate(postPath) {
    const segs = cleanupSegments(postPath);
    return segs.length > 0 && !CLEANUP_IGNORED.test("/" + segs.join("/"));
}
/** The id a creating answer names: top-level id, <singular>Id, <singular>_id or uuid of a JSON object. Nothing deeper, nothing guessed. */
function cleanupIdOf(json, postPath) {
    if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
    const literal = cleanupSegments(postPath).filter((s) => !cleanupIsParam(s));
    const one = literal.length ? cleanupSingular(literal[literal.length - 1]) : "";
    const wanted = ["id", one ? one + "id" : "", one ? one + "_id" : "", "uuid"].filter(Boolean);
    const keys = Object.keys(json);
    for (const w of wanted) {
        const k = keys.find((x) => x.toLowerCase() === w);
        if (k === undefined) continue;
        const id = cleanupUsableId(json[k]);
        if (id !== undefined) return id;
    }
    return undefined;
}
function cleanupFits(template, concrete) {
    return template.length === concrete.length && template.every((t, i) => cleanupIsParam(t) || t === concrete[i]);
}
/**
 * The concrete DELETE path for a record created by POST postPath, or undefined when no known operation removes it.
 * ops: templates such as "/things/{id}". The Location path wins when it is the new record's own address (one level below
 * the POST path and matching a known operation); otherwise the id is appended to the POST path, which a known operation must match.
 */
function cleanupDeletePath(ops, postPath, id, locationPath) {
    const post = cleanupSegments(postPath);
    const templates = (ops || []).map(cleanupSegments);
    if (locationPath) {
        const loc = cleanupSegments(locationPath);
        const below = loc.length === post.length + 1 && post.every((s, i) => s === loc[i]);
        if (below && templates.some((t) => cleanupIsParam(t[t.length - 1]) && cleanupFits(t, loc))) return "/" + loc.join("/");
    }
    if (id === undefined || id === "") return undefined;
    const candidate = post.concat([encodeURIComponent(id)]);
    if (templates.some((t) => t.length === candidate.length && cleanupIsParam(t[t.length - 1]) && post.every((s, i) => cleanupIsParam(t[i]) || t[i] === s))) return "/" + candidate.join("/");
    return undefined;
}
/** The id of a record from its own address (the last segment of a Location path below the POST path). */
function cleanupIdFromLocation(postPath, locationPath) {
    const post = cleanupSegments(postPath);
    const loc = cleanupSegments(locationPath);
    if (loc.length !== post.length + 1 || !post.every((s, i) => s === loc[i])) return undefined;
    try {
        return cleanupUsableId(decodeURIComponent(loc[loc.length - 1]));
    } catch {
        return undefined;
    }
}
`;

export interface CleanupRuntime {
    cleanupSegments(p: string): string[];
    cleanupPathOf(raw: string, base: string): string | undefined;
    cleanupCandidate(postPath: string): boolean;
    cleanupIdOf(json: unknown, postPath: string): string | undefined;
    cleanupDeletePath(ops: string[], postPath: string, id: string | undefined, locationPath: string | undefined): string | undefined;
    cleanupIdFromLocation(postPath: string, locationPath: string): string | undefined;
}

let runtime: CleanupRuntime | undefined;

/** The exact helper the generated scripts carry, compiled for use inside the platform and in tests. */
export function loadCleanupRuntime(): CleanupRuntime {
    runtime ??= new Function(
        `${CLEANUP_HELPER_SOURCE}\nreturn { cleanupSegments, cleanupPathOf, cleanupCandidate, cleanupIdOf, cleanupDeletePath, cleanupIdFromLocation };`,
    )() as CleanupRuntime;
    return runtime;
}

/** File (inside AITP_CREATED_DIR) a script writes its events to. Test ids are made file-safe the same way on both sides. */
export const createdFileName = (testId: string): string => `${testId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "test"}.jsonl`;

/** Does this spec send a POST, i.e. can it create a record? Only such scripts carry the cleanup machinery. */
export function canCreateRecords(spec: TestSpec): boolean {
    return spec.kind === "api" && spec.steps.some((s) => s.action === "request" && s.method === "POST");
}

const normalise = (p: string): string =>
    "/" +
    p
        .split(/[?#]/)[0]!
        .split("/")
        .filter(Boolean)
        .map((s) => (/^\{\{[^{}]*\}\}$/.test(s) || /^\{[^{}]*\}$/.test(s) ? "{id}" : s))
        .join("/");

const endsWithParam = (p: string): boolean => /\{[^{}]*\}$/.test(p.split(/[?#]/)[0]!.replace(/\/+$/, ""));

/** The DELETE operations the API description knows (templates such as /things/{id}); only single-record operations count. */
export function deleteOperationsOf(apis: Array<Pick<ApiEndpointModel, "method" | "path">> | undefined): string[] {
    const out = new Set<string>();
    for (const a of apis ?? []) {
        if (a.method.toUpperCase() !== "DELETE" || !a.path.startsWith("/") || !endsWithParam(a.path)) continue;
        out.add(normalise(a.path));
    }
    return [...out];
}

/** The DELETE operations a test itself spells out with a runtime id (DELETE /things/{{thing}}): the test knows how to remove its own record. */
export function deleteOperationsOfSpec(spec: Pick<TestSpec, "steps">): string[] {
    const out = new Set<string>();
    for (const s of spec.steps as Step[]) {
        if (s.action !== "request" || s.method !== "DELETE" || !s.path.startsWith("/")) continue;
        const p = s.path.split(/[?#]/)[0]!.replace(/\/+$/, "");
        // Only a path whose last segment is a placeholder is a single-record operation; DELETE /things/7 names one fixed record.
        if (/\{\{[^{}]*\}\}$/.test(p) || /\{[^{}]*\}$/.test(p)) out.add(normalise(s.path));
    }
    return [...out];
}

/** Known operations for a script: the API description's, plus the test's own. Sorted and de-duplicated so the rendered script is stable. */
export function mergeOperations(...lists: Array<string[] | undefined>): string[] {
    return [...new Set(lists.flatMap((l) => l ?? []))].sort();
}

/**
 * The script-only part. `Call`, `test`, `API_BASE_URL`, `IGNORE_HTTPS_ERRORS` and `cleanupFs`/`cleanupPath` (node:fs / node:path)
 * exist in the script. The header comment is part of the script on purpose: a person reading a downloaded test sees why it deletes.
 */
export function cleanupScriptSource(opts: { testId: string; ops: string[] }): string {
    return `
// ── Test-data cleanup ─────────────────────────────────────────────────────────────────────────────────
// A request in this test creates a record (a successful POST whose answer names it). The record is removed again after
// the test so that running the test over and over does not fill the application with leftovers. Safeguards: only
// records THIS run captured are removed (never a listing, never a guess), only through a DELETE operation known from the
// API description or from this test, only on the API's own address, with the same credentials the test used. Only the
// path and the id are written down, never a response body or a token.
// Who removes: nothing set (this script run on its own) = this script, right below. AITP_CLEANUP=platform = the AI
// Testing Platform removes them after the run and keeps the ledger (this script then only writes down what it created);
// AITP_CLEANUP=off = nobody removes them.
const CLEANUP_OPS: string[] = ${JSON.stringify(opts.ops)};
const cleanupMade: Array<{ path: string; id: string; deletePath?: string }> = [];
const cleanupDeleted = new Set<string>();
const CLEANUP_BY_SCRIPT = !process.env.AITP_CLEANUP || process.env.AITP_CLEANUP === "self";
function cleanupLog(line: Record<string, unknown>): void {
    const dir = process.env.AITP_CREATED_DIR;
    if (!dir || CLEANUP_BY_SCRIPT) return;
    try {
        cleanupFs.mkdirSync(dir, { recursive: true });
        cleanupFs.appendFileSync(cleanupPath.join(dir, ${JSON.stringify(createdFileName(opts.testId))}), JSON.stringify(line) + "\\n");
    } catch {
        /* the ledger is best effort: a test never fails because it could not be written */
    }
}
/** Called by call() after every response. */
function cleanupObserve(method: string, path: string, res: Call): void {
    const m = method.toUpperCase();
    const p = cleanupPathOf(path, API_BASE_URL);
    if (p === undefined) return;
    if (m === "DELETE" && ((res.status >= 200 && res.status < 300) || res.status === 404 || res.status === 410)) {
        cleanupDeleted.add(p);
        cleanupLog({ k: "deleted", path: p, status: res.status });
        return;
    }
    if (m !== "POST" || res.status < 200 || res.status >= 300 || res.status === 204 || !cleanupCandidate(p) || cleanupMade.length >= ${MAX_RECORDS_PER_TEST}) return;
    const location = res.headers["location"] ? cleanupPathOf(res.headers["location"], API_BASE_URL) : undefined;
    const id = cleanupIdOf(res.json, p) ?? (location ? cleanupIdFromLocation(p, location) : undefined);
    if (id === undefined) return;
    const at = new Date().toISOString();
    cleanupMade.push({ path: p, id, deletePath: cleanupDeletePath(CLEANUP_OPS, p, id, location) });
    cleanupLog({ k: "created", path: p, id, ...(location ? { location } : {}), at });
}
test.afterEach(async ({ request }) => {
    if (!CLEANUP_BY_SCRIPT || cleanupMade.length === 0) return;
    const headers: Record<string, string> = {};
    if (process.env.API_TOKEN) headers["Authorization"] = \`Bearer \${process.env.API_TOKEN}\`;
    if (process.env.API_AUTH_HEADER) {
        const i = process.env.API_AUTH_HEADER.indexOf(":");
        if (i > 0) headers[process.env.API_AUTH_HEADER.slice(0, i).trim()] = process.env.API_AUTH_HEADER.slice(i + 1).trim();
    }
    let removed = 0;
    const left: string[] = [];
    // Newest first: a record that points at an older one goes before it.
    for (const rec of cleanupMade.splice(0).reverse()) {
        if (!rec.deletePath) {
            left.push(\`\${rec.path} (id \${rec.id}): no known way to remove it\`);
            continue;
        }
        if (cleanupDeleted.has(rec.deletePath)) {
            removed++;
            continue;
        }
        try {
            const res = await request.fetch(new URL(rec.deletePath, API_BASE_URL).toString(), { method: "DELETE", headers, failOnStatusCode: false, maxRedirects: 0, timeout: 10_000, ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS });
            if ((res.status() >= 200 && res.status() < 300) || res.status() === 404 || res.status() === 410) removed++;
            else left.push(\`DELETE \${rec.deletePath} answered \${res.status()}\`);
        } catch (e) {
            left.push(\`DELETE \${rec.deletePath} failed: \${e instanceof Error ? e.message.split("\\n")[0] : String(e)}\`);
        }
    }
    console.log(\`Cleanup: removed \${removed} of \${removed + left.length} records this test created\${left.length ? "; left behind: " + left.join("; ") : ""}\`);
});
`;
}

/**
 * The web-script part: a test whose spec carries generated data (testData.runTag) writes down each record the page's own
 * requests created with that data (a successful POST on the API's address whose request carries the tag and whose answer names
 * the record), so the platform can remove it after the run. Only when the platform asked (AITP_CLEANUP platform or off): a web
 * script run on its own removes nothing. Needs CLEANUP_HELPER_SOURCE, `BASE_URL`, and `cleanupFs`/`cleanupPath` (node:fs / node:path).
 */
export function webCleanupScriptSource(opts: { testId: string; tag: string }): string {
    return `
// ── Test-data cleanup ─────────────────────────────────────────────────────────────────────────────────
// This test fills forms with generated data tagged ${opts.tag}. When the AI Testing Platform runs it, each record the page creates
// with that data (its id and address only) is written down so the platform can remove it after the run.
const CLEANUP_TAG = ${JSON.stringify(opts.tag)};
const CLEANUP_BASE = process.env.API_BASE_URL || BASE_URL;
let cleanupCount = 0;
function cleanupLog(line: Record<string, unknown>): void {
    const dir = process.env.AITP_CREATED_DIR;
    if (!dir || !process.env.AITP_CLEANUP || process.env.AITP_CLEANUP === "self") return;
    try {
        cleanupFs.mkdirSync(dir, { recursive: true });
        cleanupFs.appendFileSync(cleanupPath.join(dir, ${JSON.stringify(createdFileName(opts.testId))}), JSON.stringify(line) + "\\n");
    } catch {
        /* the ledger is best effort: a test never fails because it could not be written */
    }
}
test.beforeEach(async ({ page }) => {
    page.on("response", async (res) => {
        try {
            const method = res.request().method();
            const p = cleanupPathOf(res.url(), CLEANUP_BASE);
            if (p === undefined) return;
            if (method === "DELETE" && ((res.status() >= 200 && res.status() < 300) || res.status() === 404 || res.status() === 410)) return cleanupLog({ k: "deleted", path: p, status: res.status() });
            if (method !== "POST" || res.status() < 200 || res.status() >= 300 || res.status() === 204 || !cleanupCandidate(p) || cleanupCount >= ${MAX_RECORDS_PER_TEST}) return;
            if (!(res.request().postData() ?? "").includes(CLEANUP_TAG)) return;
            const headers = res.headers();
            const location = headers["location"] ? cleanupPathOf(headers["location"], CLEANUP_BASE) : undefined;
            const json = /json/i.test(headers["content-type"] ?? "") ? await res.json().catch(() => undefined) : undefined;
            const id = cleanupIdOf(json, p) ?? (location ? cleanupIdFromLocation(p, location) : undefined);
            if (id === undefined) return;
            cleanupCount++;
            cleanupLog({ k: "created", path: p, id, ...(location ? { location } : {}), at: new Date().toISOString(), tag: CLEANUP_TAG });
        } catch {
            /* a page that closed mid-answer: nothing to write down */
        }
    });
});
`;
}
