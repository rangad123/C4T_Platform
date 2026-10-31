/**
 * Stored sign-in details (the project's password, one-time-code secret, API token) may only ever be used on the application's own site.
 *
 * Why this exists: a test is data. A person (or an import, a recording, the step editor) can write "go to https://other.example/login and
 * type {{credentials.password}}", or "send this request to https://other.example with the stored API token". Left alone, the next run
 * would do exactly that and the secret, which the product otherwise treats as write-only, would leave for a site the owner never chose.
 *
 * The rule is enforced in two places that must agree:
 *   - here, on the steps (pure, no network): every path that stores or renders a test uses `credentialOriginProblems`, one verdict per step;
 *   - in the generated script at run time (`CREDENTIAL_ORIGIN_HELPER_SOURCE`): the web script checks the page's real address right before it
 *     fills a stored value, the API script checks the request's real target before it attaches the token. A redirect cannot get around it.
 *
 * Single sign-on on another site is therefore not supported with stored details: say so in the docs.
 */
import { interpolate, type Step, type TestSpec } from "./schema.js";

/** Starts every message of this rule; tests, the editor and the docs rely on the wording. */
export const CREDENTIAL_ORIGIN_RULE = "Stored sign-in details can only be used on the application's own site";

const CREDENTIAL_PLACEHOLDER = /\{\{\s*credentials\./;

export interface CredentialOriginProblem {
    /** Zero-based index of the step. */
    stepIndex: number;
    message: string;
}

/** Nesting deeper than this, or more values than this, is not read any further: it counts as using stored details (fail closed). */
const MAX_DEPTH = 64;
const MAX_VALUES = 20000;
const UNREADABLE = "{{credentials.unreadable}}";

/** The text values of a step (including header, query and body values, however deeply nested), read without recursion. */
function stringsOf(value: unknown): string[] {
    const out: string[] = [];
    const stack: Array<[unknown, number]> = [[value, 0]];
    let seen = 0;
    while (stack.length) {
        const [v, depth] = stack.pop()!;
        if (++seen > MAX_VALUES || depth > MAX_DEPTH) {
            out.push(UNREADABLE);
            break;
        }
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) for (const x of v) stack.push([x, depth + 1]);
        else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) stack.push([x, depth + 1]);
    }
    return out;
}

/** `{{name}}` replaced by the test data it names, a few levels deep (a data value may itself be a placeholder). */
function expand(text: string, testData: Record<string, string>): string {
    let cur = text;
    for (let i = 0; i < 4; i++) {
        const next = interpolate(cur, testData);
        if (next === cur) break;
        cur = next;
    }
    return cur;
}

/**
 * Does this step use a stored sign-in detail: a `{{credentials.*}}` placeholder anywhere in it (also through test data), or an API request
 * that attaches the project's API credential (`auth: default`, which is what a request has unless it says otherwise)?
 */
export function stepUsesCredentials(step: Step, testData: Record<string, string> = {}): boolean {
    if (step.action === "request" && step.auth === "default") return true;
    return stringsOf(step).some((s) => CREDENTIAL_PLACEHOLDER.test(s) || CREDENTIAL_PLACEHOLDER.test(expand(s, testData)));
}

/** Does any step of this test use stored sign-in details? (The web generator adds the run-time check only then.) */
export function specUsesCredentials(spec: Pick<TestSpec, "steps" | "testData">): boolean {
    return spec.steps.some((s) => stepUsesCredentials(s, spec.testData));
}

const originOf = (raw: string, base: string): string | undefined => {
    try {
        const o = new URL(raw, base).origin;
        return o === "null" ? undefined : o;
    } catch {
        return undefined;
    }
};

/** The origins stored details may go to for a test: web tests, the application; API tests, the API address (which defaults to the application). */
export function allowedCredentialOrigins(kind: "web" | "api", baseUrl: string, apiBaseUrl?: string): string[] {
    const origins = new Set<string>();
    const add = (u: string | undefined) => {
        const o = u ? originOf(u, "http://invalid.invalid") : undefined;
        if (o) origins.add(o);
    };
    // The run-time check compares with API_BASE_URL for an API test and with BASE_URL for a web test. Here an API test may use either
    // configured address, so a project that sets both is never refused for the one the script will in fact use.
    if (kind === "api") {
        add(apiBaseUrl);
        add(baseUrl);
    } else add(baseUrl);
    return [...origins];
}

/**
 * Per-step verdicts. `allowed` are the origins stored details may go to (see `allowedCredentialOrigins`). Walks the steps in order and follows
 * the address each navigation or request goes to, the way the rendered script resolves it (`new URL(address, BASE_URL)`).
 * Only web and API tests are judged: other kinds do not have an address to compare.
 */
export function credentialOriginProblems(spec: Pick<TestSpec, "kind" | "steps" | "testData">, allowed: readonly string[]): CredentialOriginProblem[] {
    if ((spec.kind !== "web" && spec.kind !== "api") || allowed.length === 0) return [];
    const base = allowed[0]!;
    const out: CredentialOriginProblem[] = [];
    const problem = (i: number, where: string) => out.push({ stepIndex: i, message: `Step ${i + 1}: ${CREDENTIAL_ORIGIN_RULE} (this step is on ${where}). Use the application's own address, or for a request set auth to none.` });
    // The site the browser is on after the steps so far. `undefined` = not known (an address that starts with a placeholder).
    let here: string | undefined = base;
    for (const [i, step] of spec.steps.entries()) {
        const uses = stepUsesCredentials(step, spec.testData);
        if (step.action === "navigate" || step.action === "request") {
            const raw = expand(step.action === "navigate" ? step.url : step.path, spec.testData).trim();
            const target = /^\{\{/.test(raw) ? undefined : originOf(raw, base);
            if (step.action === "navigate") here = target;
            if (uses) {
                if (target === undefined) out.push({ stepIndex: i, message: `Step ${i + 1}: ${CREDENTIAL_ORIGIN_RULE}, so an address that uses them must not start with a {{placeholder}} or be unreadable.` });
                else if (!allowed.includes(target)) problem(i, target);
            }
            continue;
        }
        if (uses && spec.kind === "web" && (here === undefined || !allowed.includes(here))) problem(i, here ?? "a site that cannot be told in advance");
    }
    return out;
}

// ── the run-time half, pasted into generated scripts ─────────────────────────

/**
 * Plain JavaScript on purpose (no type annotations): the text is pasted into generated scripts and also compiled with `new Function` in tests,
 * so the tests run the exact helper the scripts carry. `assertOwnOrigin(address, base)` throws unless both have the same origin.
 */
export const CREDENTIAL_ORIGIN_HELPER_SOURCE = String.raw`/** Stored sign-in details only go to the application's own site: checked with the real address, so a redirect cannot get around it. */
function assertOwnOrigin(address, base) {
    let here = "";
    let own = "";
    try {
        here = new URL(String(address)).origin;
        own = new URL(String(base)).origin;
    } catch {
        // an address that cannot be read is never "the same site"
    }
    if (!here || here === "null" || here !== own) {
        throw new Error(${JSON.stringify(CREDENTIAL_ORIGIN_RULE)} + " (this step ran on " + (here && here !== "null" ? here : "a page without an address") + ", not on " + (own || "the application") + "). Nothing was typed or sent.");
    }
}
`;

/** The helper compiled for use in tests (the exact text scripts carry). */
export function loadCredentialOriginRuntime(): { assertOwnOrigin(address: string, base: string): void } {
    return new Function(`${CREDENTIAL_ORIGIN_HELPER_SOURCE}\nreturn { assertOwnOrigin };`)() as { assertOwnOrigin(address: string, base: string): void };
}

/**
 * The same verdict as an exception, for code that stores or renders a test: throws one plain error naming every step that sends stored
 * details to another site. Call it BEFORE creating anything, so a refused test leaves no half-made row behind.
 */
export function assertCredentialsStayHome(spec: Pick<TestSpec, "kind" | "steps" | "testData">, ctx: { baseUrl: string; apiBaseUrl?: string }): void {
    if (spec.kind !== "web" && spec.kind !== "api") return;
    const leaks = credentialOriginProblems(spec, allowedCredentialOrigins(spec.kind, ctx.baseUrl, ctx.apiBaseUrl));
    if (leaks.length) throw new Error(leaks.map((l) => l.message).join(" "));
}
