/**
 * Text tests, step 2: the grammar. One table says how every step of the canonical spec is written as one line of text. The parser,
 * the printer, the "Phrases you can use" list in the editor and the documentation are all made from this table, so they cannot drift.
 * A test (tests/dsl-unit.test.ts) fails when a step action or a check of the schema has no phrase.
 *
 * A phrase is a template of words and slots:
 *   Click {locator:loc}                                  words are matched without regard to case, slots read a value
 *   Expect no accessibility problems[ of impact {expected:str} or worse][ in {locator:loc}]
 *                                                        [ ... ] is a part that is written only when its slots have values
 * A slot is named after the step field it fills, so a phrase needs no code of its own: `fixed` are fields the phrase sets itself,
 * `absent` are fields that must not be there for the phrase to describe a step.
 */

export type SlotType = "str" | "url" | "int" | "scalar" | "loc" | "json" | "method" | "args" | "reqopts";

export interface PhraseDef {
    id: string;
    /** The heading it has in the "Phrases you can use" list. */
    group: string;
    /**
     * Which kind of test the phrase belongs to. "desktop" phrases exist so every step has a phrase, but desktop tests are not written as text. "mobile"
     * phrases print and read back (so a phone step has its line), but a web or API test refuses them and the editor's list leaves them out.
     */
    for: "web" | "api" | "both" | "desktop" | "mobile";
    /** One plain sentence for the reference. */
    about: string;
    template: string;
    /** Other ways to write the same step. They are read, never printed. */
    aliases?: string[];
    /** A complete line that uses the phrase. A test checks that it reads back as this phrase. */
    example: string;
    /** Fields of the step the phrase sets (always includes `action`). */
    fixed: Record<string, unknown>;
    /** Fields that must be missing from a step for this phrase to describe it. */
    absent?: string[];
}

const NAV = "Go to a page";
const ACT = "Do something on the page";
const SEE = "Check what the page shows";
const HEALTH = "Check the page as a whole";
const CALL = "Call an API";
const ANSWER = "Check the answer";
const ANSWER_SAFE = "Check the answer's safety and speed";
const REUSE = "Reuse steps";

const a = (check: string, extra: Record<string, unknown> = {}) => ({ action: "assert", check, ...extra });
const r = (check: string, extra: Record<string, unknown> = {}) => ({ action: "assertResponse", check, ...extra });

/** Order matters: when two phrases could read the same line, the first one wins. More specific phrases come first. */
export const PHRASES: readonly PhraseDef[] = [
    // ── going and doing ────────────────────────────────────────────────
    { id: "navigate", group: NAV, for: "web", about: "Open an address or a path of the site.", template: "Go to {url:url}", aliases: ["Open {url:url}", "Visit {url:url}"], example: "Go to /login", fixed: { action: "navigate" } },
    { id: "click", group: ACT, for: "web", about: "Click an element.", template: "Click {locator:loc}", example: 'Click the "Sign in" button', fixed: { action: "click" } },
    { id: "click-popup", group: ACT, for: "web", about: "Click an element that opens a popup window or a new tab. Later steps that end with in the popup work in it.", template: "Click {locator:loc} and wait for the popup", example: 'Click the "Terms" link and wait for the popup', fixed: { action: "click", opensPopup: true } },
    { id: "fill", group: ACT, for: "web", about: "Type text into a field. Use a {{credentials.password}} style placeholder for secrets.", template: "Type {value:str} into {locator:loc}", aliases: ["Enter {value:str} into {locator:loc}"], example: 'Type "{{credentials.username}}" into the "Email" field', fixed: { action: "fill" } },
    { id: "select", group: ACT, for: "web", about: "Choose an option of a drop-down list.", template: "Choose the option {value:str} in {locator:loc}", aliases: ["Select {value:str} in {locator:loc}"], example: 'Choose the option "Large" in the "Size" field', fixed: { action: "select" } },
    { id: "check", group: ACT, for: "web", about: "Tick a box or a switch.", template: "Check {locator:loc}", example: 'Check the "Remember me" field', fixed: { action: "check", checked: true } },
    { id: "uncheck", group: ACT, for: "web", about: "Clear a box or a switch.", template: "Uncheck {locator:loc}", example: 'Uncheck the "Newsletter" field', fixed: { action: "check", checked: false } },
    // Before the key phrases: it is a press with a fixed device key, and the printer takes the first phrase that fits.
    { id: "phone-permission", group: ACT, for: "mobile", about: "Phone tests: when the phone asks for a permission, tap this answer; when it does not ask, nothing happens.", template: "When the phone asks for a permission, tap {locator:loc}", example: `When the phone asks for a permission, tap the text "Don't allow"`, fixed: { action: "press", key: "device:permission" } },
    { id: "press-in", group: ACT, for: "web", about: "Press a key while an element has focus.", template: "Press the key {key:str} in {locator:loc}", example: 'Press the key "Enter" in the "Search" field', fixed: { action: "press" } },
    { id: "press", group: ACT, for: "web", about: "Press a key on the page.", template: "Press the key {key:str}", example: 'Press the key "Escape"', fixed: { action: "press" }, absent: ["locator"] },
    { id: "hover", group: ACT, for: "web", about: "Move the pointer over an element.", template: "Hover over {locator:loc}", example: 'Hover over the "Menu" button', fixed: { action: "hover" } },
    { id: "upload", group: ACT, for: "web", about: "Put a file of the project's test files into a file field (or the file chooser a button opens).", template: "Upload {file:str} to {locator:loc}", example: 'Upload "photo.png" to the "Avatar" field', fixed: { action: "upload" } },
    { id: "drag", group: ACT, for: "web", about: "Drag an element and drop it on another one.", template: "Drag {locator:loc} to {target:loc}", example: 'Drag the "Card 1" listitem to the "Done" list', fixed: { action: "drag" } },
    // Emailed codes and magic links (hard sign-ins): the platform reads the project's test mailbox while the test runs.
    { id: "email-code-after", group: ACT, for: "web", about: "Wait for an email to an address of the test mailbox, then type the code that follows this text into a field.", template: "Wait for an email to {to:str} and type its code after {after:str} into {locator:loc}", example: 'Wait for an email to "qa+{{unique}}@example.test" and type its code after "Your code is" into the "Code" field', fixed: { action: "email", use: "code" } },
    { id: "email-code", group: ACT, for: "web", about: "Wait for an email to an address of the test mailbox, then type the code it contains (4 to 8 digits after a word such as code) into a field.", template: "Wait for an email to {to:str} and type its code into {locator:loc}", example: 'Wait for an email to "qa+{{unique}}@example.test" and type its code into the "Code" field', fixed: { action: "email", use: "code" }, absent: ["after"] },
    { id: "email-link", group: ACT, for: "web", about: "Wait for an email to an address of the test mailbox, then open its link (only a link to the application's own site). Optionally the link whose address or words contain a text.", template: "Wait for an email to {to:str} and open its link[ containing {after:str}]", example: 'Wait for an email to "qa+{{unique}}@example.test" and open its link containing "sign-in"', fixed: { action: "email", use: "link" }, absent: ["locator"] },
    { id: "wait", group: ACT, for: "web", about: "Wait a fixed time, in milliseconds (at most 10000). Prefer an expectation: it waits only as long as needed.", template: "Wait {ms:int} ms", example: "Wait 500 ms", fixed: { action: "wait" } },
    { id: "launchApp", group: ACT, for: "desktop", about: "Start the Windows application of a desktop test.", template: "Start the application", example: "Start the application", fixed: { action: "launchApp" } },
    { id: "closeApp", group: ACT, for: "desktop", about: "Close the Windows application of a desktop test.", template: "Close the application", example: "Close the application", fixed: { action: "closeApp" } },

    // ── what the page shows ────────────────────────────────────────────
    { id: "see-visible-text", group: SEE, for: "web", about: "The page shows this text somewhere.", template: "Expect the page to show {expected:scalar}", example: 'Expect the page to show "Welcome back"', fixed: a("visible"), absent: ["locator"] },
    { id: "see-hidden-text", group: SEE, for: "web", about: "The page does not show this text.", template: "Expect the page not to show {expected:scalar}", example: 'Expect the page not to show "Error"', fixed: a("hidden"), absent: ["locator"] },
    { id: "see-visible", group: SEE, for: "web", about: "An element is visible.", template: "Expect {locator:loc} to be visible", example: 'Expect the text "Welcome back" to be visible', fixed: a("visible") },
    { id: "see-hidden", group: SEE, for: "web", about: "An element is not visible.", template: "Expect {locator:loc} to be hidden", example: 'Expect the test id "spinner" to be hidden', fixed: a("hidden") },
    { id: "see-enabled", group: SEE, for: "web", about: "An element can be used.", template: "Expect {locator:loc} to be enabled", example: 'Expect the "Pay" button to be enabled', fixed: a("enabled") },
    { id: "see-disabled", group: SEE, for: "web", about: "An element cannot be used yet.", template: "Expect {locator:loc} to be disabled", example: 'Expect the "Pay" button to be disabled', fixed: a("disabled") },
    { id: "see-page-text", group: SEE, for: "web", about: "The page contains this text.", template: "Expect the page to contain the text {expected:scalar}", example: 'Expect the page to contain the text "Order placed"', fixed: a("text"), absent: ["locator"] },
    { id: "see-text", group: SEE, for: "web", about: "An element contains this text.", template: "Expect {locator:loc} to contain the text {expected:scalar}", example: 'Expect the "Total" heading to contain the text "$12"', fixed: a("text") },
    { id: "see-value", group: SEE, for: "web", about: "A field holds this value.", template: "Expect {locator:loc} to have the value {expected:scalar}", example: 'Expect the "Email" field to have the value "ada@example.test"', fixed: a("value") },
    { id: "see-count", group: SEE, for: "web", about: "This many elements match.", template: "Expect {locator:loc} to appear {expected:scalar} times", aliases: ["Expect {locator:loc} to appear {expected:scalar} time"], example: 'Expect the "Item" listitem to appear 3 times', fixed: a("count") },
    { id: "see-url", group: SEE, for: "web", about: "The address of the page contains this text.", template: "Expect the address to contain {expected:scalar}", example: 'Expect the address to contain "/dashboard"', fixed: a("url") },
    { id: "see-title", group: SEE, for: "web", about: "The title of the page contains this text.", template: "Expect the page title to contain {expected:scalar}", example: 'Expect the page title to contain "Dashboard"', fixed: a("title") },
    { id: "see-a11y", group: SEE, for: "web", about: "No accessibility problems (axe-core). The impact is minor, moderate, serious (default) or critical.", template: "Expect no accessibility problems[ of impact {expected:str} or worse][ in {locator:loc}]", example: 'Expect no accessibility problems of impact "moderate" or worse', fixed: a("a11y") },
    { id: "see-screenshot-of", group: SEE, for: "web", about: "An element looks like its approved screenshot. The number is how many pixels may differ.", template: "Expect {locator:loc} to match its approved screenshot[ within {expected:scalar} pixels]", example: 'Expect the test id "header" to match its approved screenshot within 50 pixels', fixed: a("screenshot") },
    { id: "see-screenshot", group: SEE, for: "web", about: "The page looks like its approved screenshot. The first run saves it.", template: "Expect the page to match its approved screenshot[ within {expected:scalar} pixels]", example: "Expect the page to match its approved screenshot", fixed: a("screenshot"), absent: ["locator"] },
    { id: "ai-looks-right-of", group: SEE, for: "web", about: "A model looks at an element and says whether it looks right. Needs an AI model; never passes without one.", template: "Ask the AI whether {locator:loc} looks right[ checking {expected:str}]", example: 'Ask the AI whether the test id "cart" looks right checking "the total is visible"', fixed: a("looksRight") },
    { id: "ai-looks-right", group: SEE, for: "web", about: "A model looks at the page and says whether it looks right. Needs an AI model; never passes without one.", template: "Ask the AI whether the page looks right[ checking {expected:str}]", example: "Ask the AI whether the page looks right", fixed: a("looksRight"), absent: ["locator"] },

    // ── the page as a whole ────────────────────────────────────────────
    { id: "health-console", group: HEALTH, for: "web", about: "The page reports no JavaScript errors while it loads.", template: "Expect the page to have no JavaScript errors", example: "Expect the page to have no JavaScript errors", fixed: a("noConsoleErrors"), absent: ["locator", "expected"] },
    { id: "health-requests", group: HEALTH, for: "web", about: "No request to this site fails.", template: "Expect no failed requests", example: "Expect no failed requests", fixed: a("noFailedRequests"), absent: ["locator", "expected"] },
    { id: "health-links", group: HEALTH, for: "web", about: "No link to this site's own pages is broken.", template: "Expect no broken links", example: "Expect no broken links", fixed: a("noBrokenLinks"), absent: ["locator", "expected"] },
    { id: "health-mixed", group: HEALTH, for: "web", about: "No insecure (http) content is loaded on a secure page.", template: "Expect no insecure content", example: "Expect no insecure content", fixed: a("noMixedContent"), absent: ["locator", "expected"] },
    { id: "health-basics", group: HEALTH, for: "web", about: "The page has a title, a language, a viewport setting and one main heading.", template: "Expect the page basics to be in place", example: "Expect the page basics to be in place", fixed: a("pageBasics"), absent: ["locator", "expected"] },
    { id: "speed", group: HEALTH, for: "web", about: "The page loads within its speed budgets. Optional budgets look like lcp:2500 ttfb:800.", template: "Expect the page to load within its speed budget[ of {expected:str}]", example: 'Expect the page to load within its speed budget of "lcp:2500 ttfb:800"', fixed: a("pageSpeed"), absent: ["locator"] },
    { id: "input-handling", group: HEALTH, for: "web", about: "Forms handle unusual input safely. The setting is safe (default) or all.", template: "Expect forms to handle unusual input[ in mode {expected:str}]", example: "Expect forms to handle unusual input", fixed: a("inputHandling"), absent: ["locator"] },
    { id: "access", group: HEALTH, for: "web", about: "A page is closed to people who may not see it. The setting is the JSON the access check takes.", template: "Expect access to the page to be restricted as {expected:str}", example: 'Expect access to the page to be restricted as "{\\"as\\":\\"anonymous\\",\\"path\\":\\"/admin\\"}"', fixed: a("accessDenied"), absent: ["locator"] },

    // ── calling an API ─────────────────────────────────────────────────
    { id: "request", group: CALL, for: "api", about: "Send a request. Add with the query, with the header, with the body (JSON), without signing in, and remember a value of the answer for later steps.", template: "Send a {method:method} request to {path:url}{opts:reqopts}", example: 'Send a POST request to /api/orders with the header "X-Trace" = "1" with the body {"sku":"A1"} and remember "orderId" from "id"', fixed: { action: "request" } },

    // ── checking the answer ────────────────────────────────────────────
    { id: "answer-status-below", group: ANSWER, for: "api", about: "The status is lower than this number (500 means no server error).", template: "Expect the status to be below {expected:scalar}", example: "Expect the status to be below 500", fixed: r("statusBelow") },
    { id: "answer-status", group: ANSWER, for: "api", about: "The status is exactly this.", template: "Expect the status to be {expected:scalar}", example: "Expect the status to be 200", fixed: r("status") },
    { id: "answer-status-class", group: ANSWER, for: "api", about: "The status is in this family, such as 2xx.", template: "Expect the status class to be {expected:scalar}", example: 'Expect the status class to be "2xx"', fixed: r("statusClass") },
    { id: "answer-field-exists", group: ANSWER, for: "api", about: "The answer has this field (a dotted path such as items.0.id).", template: "Expect the response field {path:str} to exist", example: 'Expect the response field "items.0.id" to exist', fixed: r("jsonPath"), absent: ["expected"] },
    { id: "answer-field-type", group: ANSWER, for: "api", about: "The field is of this type: string, number, boolean, array, object or null.", template: "Expect the response field {path:str} to be of type {expected:scalar}", example: 'Expect the response field "items" to be of type "array"', fixed: r("jsonType") },
    { id: "answer-type", group: ANSWER, for: "api", about: "The whole answer is of this type.", template: "Expect the response to be of type {expected:scalar}", example: 'Expect the response to be of type "array"', fixed: r("jsonType"), absent: ["path"] },
    { id: "answer-field", group: ANSWER, for: "api", about: "The field has exactly this value.", template: "Expect the response field {path:str} to be {expected:scalar}", example: 'Expect the response field "name" to be "Mug"', fixed: r("jsonPath") },
    { id: "answer-header", group: ANSWER, for: "api", about: "A header of the answer contains this text.", template: "Expect the response header {path:str} to contain {expected:scalar}", example: 'Expect the response header "content-type" to contain "json"', fixed: r("header") },
    { id: "answer-not-body", group: ANSWER, for: "api", about: "The answer body does not contain this text.", template: "Expect the response body not to contain {expected:scalar}", example: 'Expect the response body not to contain "error"', fixed: r("bodyNotContains") },
    { id: "answer-body", group: ANSWER, for: "api", about: "The answer body contains this text.", template: "Expect the response body to contain {expected:scalar}", example: 'Expect the response body to contain "Mug"', fixed: r("bodyContains") },
    { id: "answer-schema", group: ANSWER, for: "api", about: "The answer matches a documented JSON schema (a subset of JSON Schema).", template: "Expect the response to match the schema {schema:json}", example: 'Expect the response to match the schema {"type":"object","required":["id"]}', fixed: r("matchesSchema") },
    { id: "safe-headers", group: ANSWER_SAFE, for: "api", about: "Browser security headers are set. The setting lists csp, frame, nosniff, referrer, hsts.", template: "Expect the browser security headers to be set[ for {expected:str}]", example: 'Expect the browser security headers to be set for "csp,hsts"', fixed: r("securityHeaders"), absent: ["path"] },
    { id: "safe-cookies", group: ANSWER_SAFE, for: "api", about: "Session cookies are protected (HttpOnly, Secure, SameSite). The setting lists httponly, secure, samesite.", template: "Expect session cookies to be protected[ by {expected:str}]", example: "Expect session cookies to be protected", fixed: r("cookieFlags"), absent: ["path"] },
    { id: "safe-cors", group: ANSWER_SAFE, for: "api", about: "Cross-origin access (CORS) is not wide open.", template: "Expect the CORS policy to be safe", example: "Expect the CORS policy to be safe", fixed: r("corsPolicy"), absent: ["path", "expected"] },
    { id: "safe-files", group: ANSWER_SAFE, for: "api", about: "No sensitive file can be read.", template: "Expect no sensitive files to be exposed", example: "Expect no sensitive files to be exposed", fixed: r("noExposedFiles"), absent: ["path", "expected"] },
    { id: "safe-banners", group: ANSWER_SAFE, for: "api", about: "The server does not reveal software versions or list folders.", template: "Expect no software versions to be revealed", example: "Expect no software versions to be revealed", fixed: r("noInfoDisclosure"), absent: ["path", "expected"] },
    { id: "safe-tls", group: ANSWER_SAFE, for: "api", about: "The HTTPS certificate is valid and not about to expire (default 14 days).", template: "Expect the HTTPS certificate to be valid[ for at least {expected:scalar} days]", example: "Expect the HTTPS certificate to be valid for at least 30 days", fixed: r("tlsCertificate"), absent: ["path"] },
    { id: "safe-latency", group: ANSWER_SAFE, for: "api", about: "The request before this step answers fast enough, measured on repeated calls. Optional budgets look like p95:1000.", template: "Expect the response time to stay within its budget[ of {expected:str}]", example: 'Expect the response time to stay within its budget of "p95:800"', fixed: r("latency"), absent: ["path"] },
    { id: "safe-load", group: ANSWER_SAFE, for: "api", about: "The GET request before this step holds up with several users at once. Optional limits look like users:5.", template: "Expect the endpoint to hold up under load[ within {expected:str}]", example: 'Expect the endpoint to hold up under load within "users:5 seconds:5"', fixed: r("load"), absent: ["path"] },
    { id: "safe-denied", group: ANSWER_SAFE, for: "api", about: "The request is refused (401, 403, 404 or a redirect). The setting is the JSON the access check takes.", template: "Expect the request to be refused[ as {expected:str}]", example: "Expect the request to be refused", fixed: r("statusDenied"), absent: ["path"] },

    // ── reusing steps ──────────────────────────────────────────────────
    { id: "use-block", group: REUSE, for: "both", about: "Run a group of steps saved once for the project. Give values for its parameters after with.", template: "Run the reusable steps {block:str}[ with {args:args}]", example: 'Run the reusable steps "Open the cart" with item = "Mug"', fixed: { action: "useBlock" } },
];

// ── templates ───────────────────────────────────────────────────────────

export type El = { t: "lit"; w: string } | { t: "slot"; name: string; type: SlotType } | { t: "opt"; els: El[] };

const compiled = new Map<string, El[]>();

/** Template text into elements. Throws on a malformed template (a mistake in this file, caught by the unit test). */
export function compileTemplate(template: string): El[] {
    const hit = compiled.get(template);
    if (hit) return hit;
    const parse = (s: string): El[] => {
        const els: El[] = [];
        let i = 0;
        while (i < s.length) {
            const ch = s[i]!;
            if (ch === " ") {
                i++;
                continue;
            }
            if (ch === "[") {
                const close = s.indexOf("]", i);
                if (close < 0) throw new Error(`Unclosed [ in template: ${template}`);
                els.push({ t: "opt", els: parse(s.slice(i + 1, close)) });
                i = close + 1;
                continue;
            }
            if (ch === "{" && s[i + 1] !== "{") {
                const close = s.indexOf("}", i);
                if (close < 0) throw new Error(`Unclosed { in template: ${template}`);
                const [name, type] = s.slice(i + 1, close).split(":");
                if (!name || !type) throw new Error(`Bad slot in template: ${template}`);
                els.push({ t: "slot", name, type: type as SlotType });
                i = close + 1;
                continue;
            }
            let j = i;
            while (j < s.length && s[j] !== " " && s[j] !== "[" && !(s[j] === "{" && s[j + 1] !== "{")) j++;
            els.push({ t: "lit", w: s.slice(i, j) });
            i = j;
        }
        return els;
    };
    const els = parse(template);
    compiled.set(template, els);
    return els;
}

/** The words a template starts with, before its first slot (used to find the nearest phrase for a mistyped line). */
export function headWords(template: string): string[] {
    const out: string[] = [];
    for (const el of compileTemplate(template)) {
        if (el.t !== "lit") break;
        out.push(el.w.toLowerCase());
    }
    return out;
}

/** A plain-language placeholder form of a template: `Click <element>`. For the reference list. */
export function readableTemplate(template: string): string {
    const words = (els: El[]): string =>
        els
            .map((el) => {
                if (el.t === "lit") return el.w;
                if (el.t === "opt") return `[${words(el.els)}]`;
                return `<${SLOT_WORDS[el.type]}>`;
            })
            .join(" ");
    return words(compileTemplate(template));
}

/** How a frame is written after an element: `inside the frame "name"`, `inside the frame titled "x"`, `inside the frame at "address part"`. */
export const FRAME_LEAD: Record<"name" | "title" | "url", string[]> = { name: [], title: ["titled"], url: ["at"] };

/** The words a step line ends with when the step works in the popup an earlier click opened. */
export const POPUP_SUFFIX = ["in", "the", "popup"] as const;

export const SLOT_WORDS: Record<SlotType, string> = {
    str: "text",
    url: "address",
    int: "number",
    scalar: "text or number",
    loc: "element",
    json: "JSON",
    method: "method",
    args: "values",
    reqopts: "options",
};

/** The fields a phrase's slots fill, in the order the template names them. */
export function slotsOf(template: string): Array<{ name: string; type: SlotType; optional: boolean }> {
    const out: Array<{ name: string; type: SlotType; optional: boolean }> = [];
    const walk = (els: El[], optional: boolean) => {
        for (const el of els) {
            if (el.t === "slot") out.push({ name: el.name, type: el.type, optional: optional || el.type === "reqopts" });
            else if (el.t === "opt") walk(el.els, true);
        }
    };
    walk(compileTemplate(template), false);
    return out;
}

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/**
 * Words that name something else than an ARIA role right after `the` (so `the page` is never read as an element called page).
 * Only an UNNAMED element is affected: after a name in quotes (`the "Cart updated" status`) any word is a role. An unnamed element
 * whose role is one of these words (a status message, say) is written `the role "status"`.
 */
export const RESERVED_ROLE_WORDS = new Set(["page", "text", "test", "element", "shared", "field", "placeholder", "address", "response", "status", "endpoint", "application", "key", "role"]);

/** The header lines of a text test, in the order the printer writes them. */
export const HEADER_KEYS = ["test", "kind", "category", "type", "priority", "description", "tag", "precondition", "result", "data"] as const;
export type HeaderKey = (typeof HEADER_KEYS)[number];

/** Other names a header line is read under (never printed). */
export const HEADER_ALIASES: Record<string, HeaderKey> = { title: "test" };

export const HEADER_INFO: Record<HeaderKey, { line: string; about: string; repeats: boolean }> = {
    test: { line: "Test: Sign in and see the dashboard", about: "The title of the test (3 to 160 characters). Required.", repeats: false },
    kind: { line: "Kind: web", about: "web (default) or api.", repeats: false },
    category: { line: "Category: Authentication", about: "The group the test is listed under.", repeats: false },
    type: { line: "Type: functional", about: "What the test is for: functional, negative, boundary, security, smoke, validation, navigation, accessibility, workflow, visual, health, performance, input or vision.", repeats: false },
    priority: { line: "Priority: high", about: "critical, high, medium (default) or low.", repeats: false },
    description: { line: "Description: Checks the sign-in form", about: "A sentence about the test.", repeats: false },
    tag: { line: "Tag: smoke", about: "A label. Repeat the line for more.", repeats: true },
    precondition: { line: "Precondition: The account exists", about: "Something that must be true before the test. Repeat the line for more.", repeats: true },
    result: { line: "Result: The dashboard is shown", about: "What a person should see when it works. Repeat the line for more.", repeats: true },
    data: { line: 'Data: name = "Ada"', about: 'A value steps can use as {{name}}. Repeat the line for more.', repeats: true },
};

/** What the editor shows as "Phrases you can use": made from the table, nothing hand-written twice. */
export function phraseReference() {
    return {
        headers: HEADER_KEYS.map((k) => ({ key: k, ...HEADER_INFO[k] })),
        phrases: PHRASES.filter((p) => p.for !== "desktop" && p.for !== "mobile").map((p) => ({ id: p.id, group: p.group, for: p.for, about: p.about, template: readableTemplate(p.template), example: p.example, aliases: (p.aliases ?? []).map(readableTemplate) })),
        notes: [
            'Elements are written as: the "Email" field, the "Sign in" button, the text "Welcome", the test id "cart", the element "#id" (a CSS selector), the shared element "Cart / Checkout button". Another role works as the "Name" tab. An element with a role and no name is written the button, or the role "status" for a role whose word the grammar also uses. Add exactly or loosely, and number 2 to pick the second match.',
            'Texts are in double quotes. Write \\" for a quote, \\\\ for a backslash and \\n for a new line. Placeholders such as {{credentials.password}} and {{name}} are kept as they are.',
            'Add note "why" at the end of a step to keep a description with it.',
            'An element inside a frame is written with the frame after it: the "Pay" button inside the frame "checkout". A frame can also be named by its title (inside the frame titled "Payment") or a part of its address (inside the frame at "pay.example.com/form"). Frames in frames: the inner one first.',
            "End a step with in the popup to do it in the window that a step written Click ... and wait for the popup opened.",
            "Blank lines and lines that start with # are ignored, and are not kept when the test is saved.",
        ],
    };
}
