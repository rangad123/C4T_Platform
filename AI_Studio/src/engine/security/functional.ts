/**
 * Functional security checks (testing-engine Phase 4 C11), deterministic (no AI), each a saved test the platform runs like any other:
 *
 *  - Sensitive fields: credential-like field names (password, its hash, a secret) or values (a password hash, a private key) in the API
 *    answers captured while a test was written (web/correlation.ts CapturedCall). A GET that showed one becomes a test that reads it again.
 *  - Rate limit: only from a stated limit ("after 5 failed sign-ins ... refused", with a number), at most 7 sign-in attempts, at most once
 *    a run, only with the gate (bench or fixture app, or a current client authorization, plus data changes on) and only where the app has a
 *    documented sign-up: the attempts go to a fresh account made for the check, so no shared test account is ever locked.
 *  - Stored injection: a written workflow again, with a marker payload in the fields it fills before its first successful write, then a
 *    look for the parsed marker element on the page it lands on.
 *  - Hand-over: the two-account list evidence of the access stage (identity/access.ts ApiListRow) is drafted as the security module's
 *    cross-account designation by the module itself (security/cross-account-store.ts, which this engine may not import); a person
 *    confirms it there. The draft names the engine's findings, and the findings carry `handOverLine`.
 *
 * The scanners (ZAP, nuclei, Schemathesis) and the passive checks (./checks.ts) are not repeated here: these are the checks they cannot
 * make, because each needs a stated expectation or a workflow the engine wrote.
 */
import type { DraftSpec } from "../api/test-specs.js";
import type { Step } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import type { CapturedCall } from "../web/correlation.js";

/** At most this many sign-in attempts in a rate-limit check (spec C11). */
export const RATE_LIMIT_MAX_ATTEMPTS = 7;
/** The marker attribute a stored-injection payload carries; a page element with it means the input became markup. */
export const INJECTION_MARKER = "data-c4t-probe";
const INJECTION_FIELDS_MAX = 3;
const SENSITIVE_SPECS_MAX = 4;

export interface StatedRequirement {
    id: string;
    text: string;
}

// ── sensitive fields ─────────────────────────────────────────────────────────

/** Field names (lower case, without _ - .) that hold a sign-in secret. Not tokens or session ids: a sign-in answer may return those. */
const CREDENTIAL_NAMES = new Set(["password", "passwd", "pwd", "passwordhash", "hashedpassword", "passworddigest", "encryptedpassword", "passwordsalt", "salt", "secret", "clientsecret", "apisecret", "secretkey", "privatekey", "otpsecret", "totpsecret", "mfasecret"]);
/** Values that are a credential whatever the field is called: bcrypt, argon2, scrypt and crypt hashes, PEM private keys. */
const CREDENTIAL_VALUE = /^\$(?:2[aby]\$\d\d\$[./A-Za-z0-9]{53}|argon2(?:id|i|d)\$|scrypt\$|[156]\$[^$]{1,16}\$[./A-Za-z0-9]{20,})|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;

export interface SensitiveHit {
    method: string;
    /** Path without the query. */
    path: string;
    /** Dotted paths of the fields that held a credential (0.password for a list's first record). At most 10. */
    fields: string[];
    status: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The dotted paths of credential-like fields with a value (a non-empty string or a number; null, "" and false hold nothing). */
function credentialFields(v: unknown, at: string, out: string[], depth = 0): void {
    if (out.length >= 10 || depth > 8) return;
    if (Array.isArray(v)) return v.slice(0, 20).forEach((x, i) => credentialFields(x, at ? `${at}.${i}` : String(i), out, depth + 1));
    if (!isRecord(v)) return;
    for (const [k, x] of Object.entries(v)) {
        const here = at ? `${at}.${k}` : k;
        const held = (typeof x === "string" && x.trim() !== "") || typeof x === "number";
        if (held && (CREDENTIAL_NAMES.has(k.toLowerCase().replace(/[-_.]/g, "")) || (typeof x === "string" && CREDENTIAL_VALUE.test(x)))) out.push(here);
        else credentialFields(x, here, out, depth + 1);
    }
}

/**
 * Credential-like fields in captured answers (masked bodies keep the field and a mask for its value, which is enough). One hit per method
 * and path. Bodies that are not JSON, or were cut at the capture limit, are not judged.
 */
export function sensitiveFields(calls: readonly CapturedCall[]): SensitiveHit[] {
    const hits = new Map<string, SensitiveHit>();
    for (const c of calls) {
        if (c.status < 200 || c.status > 299) continue;
        let body: unknown;
        try {
            body = JSON.parse(c.body);
        } catch {
            continue;
        }
        const fields: string[] = [];
        credentialFields(body, "", fields);
        const path = c.path.split(/[?#]/)[0]!;
        const key = `${c.method} ${path}`;
        if (fields.length && !hits.has(key)) hits.set(key, { method: c.method, path, fields, status: c.status });
    }
    return [...hits.values()];
}

/** The stated requirement that credentials are never returned, if the document has one. */
export function credentialRequirement(reqs: readonly StatedRequirement[]): StatedRequirement | undefined {
    return reqs.find((r) => /\b(password|credential|sign-in secret)s?\b/i.test(r.text) && /\b(never|not|no)\b/i.test(r.text) && /\b(respon[sc]e|returned|answer)s?\b/i.test(r.text));
}

/** A saved test per GET hit (a write's answer is not sent again just to look at it): read it again, and no credential field is there. */
export function sensitiveFieldSpecs(hits: readonly SensitiveHit[], reqs: readonly StatedRequirement[] = []): DraftSpec[] {
    const req = credentialRequirement(reqs);
    const source = req?.id ?? "standard security rule: credentials are never returned in a response";
    return hits
        .filter((h) => h.method === "GET")
        .slice(0, SENSITIVE_SPECS_MAX)
        .map((h) => ({
            title: `GET ${h.path} returns no password or other sign-in secret`,
            description: `While a test was written, GET ${h.path} answered with ${h.fields.map((f) => `“${f}”`).join(", ")}, which hold${h.fields.length === 1 ? "s" : ""} a sign-in secret. Anyone who can read the answer (a script, a proxy log) learns it. Fails while the answer still holds one.`,
            kind: "api",
            category: "Security",
            type: "security",
            priority: "critical",
            preconditions: ["Signed in with the project's test account"],
            steps: [
                { action: "request", method: "GET", path: h.path, auth: "default", description: `Read ${h.path} signed in` },
                { action: "assertResponse", check: "statusClass", expected: 2, description: `${h.path} answers` },
                ...h.fields.map((f): Step => ({ action: "assertResponse", check: "jsonType", path: f, expected: "undefined", source, description: `The answer holds no “${f}”` })),
            ],
            expectedResults: [req ? `No API response contains a password or other sign-in secret (requirement ${req.id})` : "No API response contains a password or other sign-in secret"],
            testData: {},
            tags: ["security", "sensitive-data"],
            source: { origin: "security-check", ...(req ? { requirements: [req.id] } : {}) },
        }));
}

// ── rate limit ───────────────────────────────────────────────────────────────

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** A stated sign-in limit: "after 5 failed sign-ins ... refused / 429". Undefined when no requirement states one with a number. */
export function statedSignInLimit(reqs: readonly StatedRequirement[]): { req: StatedRequirement; fails: number; status: number; rightPassword: boolean } | undefined {
    for (const req of reqs) {
        const m = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\w+\s+){0,2}?(?:failed|wrong|unsuccessful|incorrect|invalid)\s+(?:sign-?ins?|log-?ins?|logins?|sign-in attempts?|login attempts?|attempts?|passwords?)\b/i.exec(req.text);
        if (!m || !/\b(refused|blocked|locked|429|rejected|denied|too many)\b/i.test(req.text)) continue;
        const fails = /^\d+$/.test(m[1]!) ? Number(m[1]) : WORDS[m[1]!.toLowerCase()]!;
        if (fails >= 1) return { req, fails, status: /\b423\b/.test(req.text) ? 423 : 429, rightPassword: /even with the (right|correct|valid) password/i.test(req.text) };
    }
    return undefined;
}

const SIGN_IN_PATH = /(^|\/)(log-?in|sign-?in|session|sessions|auth|authenticate|token)$/i;
const SIGN_UP = /(^|\/)(register|registration|sign-?up)$/i;
const NEW_ACCOUNT = /(^|\/)(users|accounts)$/i;
type BodyOf = Pick<ApiEndpointModel, "requestSchema" | "spec">;
/** The documented request body (OpenAPI), else the one seen on the wire, as validation/invariants.ts reads it. */
const bodyOf = (a: BodyOf) => (a.spec?.requestBody?.schema ?? a.requestSchema) as Record<string, unknown> | undefined;
const props = (schema: Record<string, unknown> | undefined) => (isRecord(schema?.properties) ? (schema!.properties as Record<string, Record<string, unknown>>) : {});
const required = (schema: Record<string, unknown> | undefined) => (Array.isArray(schema?.required) ? (schema!.required as unknown[]).map(String) : []);

/**
 * At most one bounded rate-limit check a run. Without a stated limit, the gate, a documented sign-in and sign-up, or within the attempt
 * cap, there is none, and `skipped` says why. The account is made by the check itself ({{unique}} address), never a test account.
 */
export function rateLimitSpec(input: { apis: readonly Pick<ApiEndpointModel, "method" | "path" | "statuses" | "requestSchema" | "spec">[]; requirements: readonly StatedRequirement[]; gate: boolean }): { spec?: DraftSpec; skipped?: string } {
    const stated = statedSignInLimit(input.requirements);
    if (!stated) return { skipped: "No requirement states a sign-in limit, so no rate-limit check was made." };
    const attempts = stated.fails + 1;
    if (attempts > RATE_LIMIT_MAX_ATTEMPTS) return { skipped: `Requirement ${stated.req.id} allows ${stated.fails} failed sign-ins; checking it would take ${attempts} attempts, more than the ${RATE_LIMIT_MAX_ATTEMPTS} allowed.` };
    if (!input.gate) return { skipped: "The rate-limit check needs a benchmark or fixture app, or the client's current authorization, with data changes on." };
    const posts = input.apis.filter((a) => a.method.toUpperCase() === "POST" && !a.path.includes("{"));
    const signIn = posts.find((a) => SIGN_IN_PATH.test(a.path) && a.statuses.includes(401)) ?? posts.find((a) => SIGN_IN_PATH.test(a.path));
    const withPassword = posts.filter((a) => !/\/admin\//i.test(a.path) && Object.keys(props(bodyOf(a))).some((k) => /pass/i.test(k)));
    const signUp = withPassword.find((a) => SIGN_UP.test(a.path)) ?? withPassword.find((a) => NEW_ACCOUNT.test(a.path));
    if (!signIn) return { skipped: "No documented sign-in endpoint, so no rate-limit check was made." };
    if (!signUp) return { skipped: "The app has no documented sign-up, so a rate-limit check would lock a shared test account; none was made." };
    const up = props(bodyOf(signUp));
    const idField = Object.keys(up).find((k) => up[k]!.format === "email" || /e-?mail/i.test(k)) ?? Object.keys(up).find((k) => /^(user(name)?|login)$/i.test(k));
    const pwField = Object.keys(up).find((k) => /pass/i.test(k));
    if (!idField || !pwField) return { skipped: `The sign-up at ${signUp.path} has no address and password fields the check can fill.` };
    const body: Record<string, string> = {};
    for (const k of new Set([...required(bodyOf(signUp)), idField, pwField])) {
        const t = up[k]?.type;
        if (t !== undefined && t !== "string") return { skipped: `The sign-up field “${k}” is not text, so the check cannot make an account.` };
        body[k] = k === idField ? (up[k]!.format === "email" || /e-?mail/i.test(k) ? "rate-limit-{{unique}}@example.test" : "rate-limit-{{unique}}") : k === pwField ? "Rl-{{unique}}-Pw1!" : "Rate limit check {{unique}}";
    }
    // The sign-in's own documented fields when it has them, else the sign-up's names for the same two values.
    const inProps = props(bodyOf(signIn));
    const inId = Object.keys(inProps).find((k) => inProps[k]!.format === "email" || /e-?mail|user|login/i.test(k)) ?? idField;
    const inPw = Object.keys(inProps).find((k) => /pass/i.test(k)) ?? pwField;
    const login = (password: string) => ({ [inId]: body[idField]!, [inPw]: password });
    const wrong = "Wrong-{{unique}}-x";
    const steps: Step[] = [
        { action: "request", method: "POST", path: signUp.path, body, auth: "none", description: "Make a fresh account for this check (no shared test account is ever locked)" },
        { action: "assertResponse", check: "statusClass", expected: 2, description: "The fresh account is made" },
        ...Array.from({ length: stated.fails }, (_, i): Step => ({ action: "request", method: "POST", path: signIn.path, body: login(wrong), auth: "none", description: `Failed sign-in ${i + 1} of ${stated.fails}` })),
        { action: "request", method: "POST", path: signIn.path, body: login(stated.rightPassword ? body[pwField]! : wrong), auth: "none", description: `Sign-in attempt ${attempts}${stated.rightPassword ? ", with the right password" : ""}` },
        { action: "assertResponse", check: "status", expected: stated.status, source: stated.req.id, description: `After ${stated.fails} failed sign-ins the next one is refused (requirement ${stated.req.id})` },
    ];
    return {
        spec: {
            title: `Sign-in is limited after ${stated.fails} failed attempts`,
            description: `A fresh account is made, then signed in to ${stated.fails} times with a wrong password and once more${stated.rightPassword ? " with the right one" : ""}: ${attempts} attempts in all. Requirement ${stated.req.id} says the last is refused (HTTP ${stated.status}). Fails when it is not, so passwords can be guessed without limit.`,
            kind: "api",
            category: "Security",
            type: "security",
            priority: "high",
            preconditions: ["The app lets anyone create an account", "Data changes are allowed in this environment"],
            steps,
            expectedResults: [`After ${stated.fails} failed sign-ins, the next sign-in is refused with HTTP ${stated.status} (requirement ${stated.req.id})`],
            testData: {},
            tags: ["security", "rate-limiting", "data-changing"],
            source: { origin: "security-check", requirements: [stated.req.id] },
        },
    };
}

// ── stored injection ─────────────────────────────────────────────────────────

const WRITES = new Set(["POST", "PUT", "PATCH"]);
const NOT_FREE_TEXT = /pass|e-?mail|phone|date|time|price|amount|quantity|qty|number|zip|postcode|card|search|url|link|code|otp|token/i;

/** The requirement that typed text is shown as text (markup never becomes part of the page), if the document has one. */
export function plainTextRequirement(reqs: readonly StatedRequirement[]): StatedRequirement | undefined {
    return reqs.find((r) => /(plain text|as text|escaped|exactly as typed)/i.test(r.text) && /(markup|html|<|tags?|script)/i.test(r.text));
}

/**
 * The written workflow again with a marker payload in each free-text field it fills before its first successful write (at most 3), up to
 * that write and the waits right after it; then the page it lands on must hold no element with the marker. Undefined when the workflow
 * fills no such field before a successful write, or without data changes.
 */
export function storedInjectionSpec(input: { title: string; steps: readonly Step[]; calls: readonly CapturedCall[]; requirements?: readonly StatedRequirement[]; dataChanges: boolean }): DraftSpec | undefined {
    if (!input.dataChanges) return undefined;
    const write = input.calls.find((c) => c.step !== undefined && !c.readBack && WRITES.has(c.method) && c.status >= 200 && c.status <= 299);
    if (write?.step === undefined || write.step >= input.steps.length) return undefined;
    let end = write.step + 1;
    while (end < input.steps.length && input.steps[end]!.action === "wait") end++;
    let marked = 0;
    const steps = input.steps.slice(0, end).map((s): Step => {
        if (s.action !== "fill" || marked >= INJECTION_FIELDS_MAX || /\{\{/.test(s.value)) return s;
        const where = JSON.stringify(s.locator);
        if (NOT_FREE_TEXT.test(where) || NOT_FREE_TEXT.test(s.description ?? "")) return s;
        marked++;
        return { ...s, value: `C4T <i ${INJECTION_MARKER}="${marked}">probe</i> {{unique}}`, description: `${s.description ?? "Fill the field"}, with a marker in markup` };
    });
    if (!marked) return undefined;
    const req = plainTextRequirement(input.requirements ?? []);
    const source = req?.id ?? "standard security rule: stored input is shown as text, never as markup";
    steps.push(
        { action: "wait", ms: 500, description: "Let the page show what was saved" },
        { action: "assert", check: "count", locator: { by: "css", value: `[${INJECTION_MARKER}]` }, expected: 0, source, description: "The marker is shown as text: the page holds no element made from it" },
    );
    return {
        title: `${input.title}: typed markup is shown as text`,
        description: `The same workflow, with “<i ${INJECTION_MARKER}>” markup typed into ${marked} field${marked === 1 ? "" : "s"} before it saves. The page it then shows must not turn that text into an element: fails when it does (stored markup injection; with a weaker page policy, script injection into anyone who opens it).`,
        kind: "web",
        category: "Security",
        type: "security",
        priority: "high",
        preconditions: ["Data changes are allowed in this environment"],
        steps,
        expectedResults: [req ? `Typed text is shown as text (requirement ${req.id})` : "Typed text is shown as text, never as markup"],
        testData: {},
        tags: ["security", "input-injection", "data-changing"],
        source: { origin: "security-check", ...(req ? { requirements: [req.id] } : {}) },
    };
}

// ── hand-over to the security module ─────────────────────────────────────────

/** The line an engine finding carries for its hand-over (the security module's draft names the finding back). */
export function handOverLine(applicationName: string): string {
    return `Handed over: a draft cross-account check for “${applicationName}” waits in Security, under Cross-account checks, until a person confirms it.`;
}
