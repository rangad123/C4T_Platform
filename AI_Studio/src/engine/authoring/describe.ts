/**
 * Plain-English test authoring, part 1: reading the sentence. Everything here is deterministic text handling, so it can be tested
 * without a model: is the request allowed at all, is it about a page or an API call, and what are the title and the expected results.
 * The model only ever sees descriptions that passed `refusalFor`.
 */
import { ScenarioSchema, type Scenario } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";

export const PLAIN_MIN_LENGTH = 3;
export const PLAIN_MAX_LENGTH = 2000;
/** Origin recorded in the spec, and the suite the tests are listed under. */
export const PLAIN_ORIGIN = "plain-english" as const;
export const PLAIN_CATEGORY = "Plain English";
/** Same bound as one planned scenario in an analysis (the default of the authoring agent is 28). */
export const PLAIN_MAX_STEPS = 24;

export const NO_MODEL_MESSAGE =
    "The AI model isn’t set up yet. Writing a test from a sentence needs access to an AI model. Add your API key in the server settings, then try again.";

// ── what is refused up front ────────────────────────────────────────────────

interface Rule {
    id: "payment" | "delete" | "others" | "attack";
    re: RegExp;
    reason: string;
    /** Only refused while tests that change data are switched off for the project. */
    onlyWhenChangesOff?: boolean;
}

const RULES: Rule[] = [
    {
        id: "payment",
        re: /\b(pay|pays|paying|paid)\b|\b(paypal|stripe|apple pay|google pay)\b|\b(enter|type|fill(?: in)?|use|submit|provide|add)\b[^.\n]{0,40}\b(?:credit|debit|payment)\s*card\b|\bcard number\b|\b(cvv|cvc)\b|\b(place|complete|confirm|finali[sz]e|make|submit)\b[^.\n]{0,20}\b(order|purchase|payment)\b/i,
        reason: "We don’t build tests that pay for something or type in card details. Describe the steps up to the payment page and what the page should show.",
    },
    {
        id: "delete",
        re: /\b(delete|erase|wipe|destroy|drop|purge|deactivate)\b[^.\n]{0,30}\b(accounts?|profiles?|everything|database|data|records?|users?|project|workspace)\b|\bcancel\s+(my|the|this)\s+(account|subscription)\b|\bremove\s+(my|the|this)\s+account\b/i,
        reason: "This would delete data in the application, and tests that change data are switched off for this project. Switch them on when you analyze the application, or describe a check that only looks.",
        onlyWhenChangesOff: true,
    },
    {
        id: "others",
        re: /\b(someone else|somebody else|another (?:user|person|customer|member)|other (?:users?|people|customers?|members?)|a stranger|the victim)(?:['’]s)\s+(password|credentials?|login|account|session|cookies?|token|e-?mail address)\b/i,
        reason: "We don’t build tests that use someone else’s password or account. Add a test account for the person you want to test as (Tests, More actions, Test accounts) and describe the test as that account.",
    },
    {
        id: "attack",
        re: /\b(brute[- ]?force|guess(?:ing)? (?:the |a |their |his |her )?(?:password|pin|code)s?|crack(?:ing)? (?:the |a )?passwords?|steal(?:ing)?|hijack|phish(?:ing)?|keylog|hack(?:ing)?|sql injection|take over (?:an? |the )?account)\b/i,
        reason: "We don’t build tests that try to break in or attack the application. The security checks in an analysis look at that safely.",
    },
];

/** A data-changing HTTP call named in the sentence ("POST /orders"). */
const CHANGING_CALL = /\b(POST|PUT|PATCH|DELETE)\s+\//i;

export function changesDataCall(description: string): boolean {
    return CHANGING_CALL.test(description);
}

/**
 * Why this request must not be built, in plain words, or undefined when it may go ahead.
 * `allowChanges` is the project's "include API tests that change data" switch.
 */
export function refusalFor(description: string, opts: { allowChanges: boolean }): string | undefined {
    for (const rule of RULES) {
        if (rule.onlyWhenChangesOff && opts.allowChanges) continue;
        if (rule.re.test(description)) return rule.reason;
    }
    if (!opts.allowChanges && changesDataCall(description)) {
        return "That call sends data to the application, and tests that change data are switched off for this project. Switch them on when you analyze the application, or describe a call that only reads (GET).";
    }
    return undefined;
}

// ── web or API ──────────────────────────────────────────────────────────────

const PATH_TOKEN = /(?:^|[\s("'`])(\/[A-Za-z0-9_\-./{}:%]*[A-Za-z0-9_}])/g;

function pathTokens(description: string): string[] {
    return [...description.matchAll(PATH_TOKEN)].map((m) => m[1]!.replace(/[.,;:)]+$/, ""));
}

const pathRegex = (template: string) => new RegExp(`^${template.split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}/?$`);

/** Does `token` (what the person wrote) name this operation's path, with or without concrete ids? */
export function namesPath(token: string, template: string): boolean {
    return pathRegex(template).test(token.split("?")[0]!);
}

/** "api" when the sentence names an HTTP call or an endpoint of the application; otherwise "web". */
export function detectKind(description: string, apis: Array<Pick<ApiEndpointModel, "path">>): "web" | "api" {
    if (/\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+\/\S*/i.test(description)) return "api";
    if (/\b(api|endpoint|http request|request to)\b/i.test(description)) {
        const tokens = pathTokens(description);
        if (tokens.some((t) => apis.some((a) => namesPath(t, a.path)))) return "api";
    }
    return "web";
}

// ── title, expected results, scenario ───────────────────────────────────────

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const tidy = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[\s.,;:!]+$/, "");

/** The first sentence or line, as a short title. */
export function titleOf(description: string): string {
    const first = description.trim().split(/(?<=[.!?])\s+|\n+/)[0] ?? description;
    const t = capital(tidy(first)).slice(0, 100).trim();
    return t.length >= 3 ? t : capital(tidy(description)).slice(0, 100).padEnd(3, ".");
}

const CHECK_WORDS = /\b(?:check(?:s|ing)?|verif(?:y|ies)|confirm(?:s)?|make sure|ensure|assert|expect(?:ed)?|see(?: that)?|should)\b\s*(?:that\s+)?(.+)$/i;

/** What the person said should be true afterwards: the part after "check", "verify", "should"..., or else the last line. */
export function expectedOf(description: string): string[] {
    const parts = description
        .trim()
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
    const found: string[] = [];
    for (const p of parts) {
        const m = CHECK_WORDS.exec(p);
        if (m && tidy(m[1]!).length >= 2) found.push(capital(tidy(m[1]!)).slice(0, 300));
    }
    if (!found.length) found.push(capital(tidy(parts.at(-1) ?? description)).slice(0, 300));
    return [...new Set(found)].slice(0, 6);
}

/** A page the sentence names ("Open /pricing and ..."), or undefined. */
export function startPathOf(description: string): string | undefined {
    for (const t of pathTokens(description)) if (t.length > 1 && !t.includes("{")) return t;
    return undefined;
}

/** The single scenario the authoring agent is given. The sentence stays in the description word for word. */
export function scenarioFor(description: string, opts: { startPath: string; requiresAuth: boolean }): Scenario {
    return ScenarioSchema.parse({
        scenarioId: "PLAIN-1",
        title: titleOf(description),
        description: description.trim(),
        category: PLAIN_CATEGORY,
        type: "functional",
        priority: "medium",
        journey: "Written in plain English",
        startPath: opts.startPath || "/",
        preconditions: [],
        expectedResults: expectedOf(description),
        requiresAuth: opts.requiresAuth,
        requiredData: [],
        requirements: [],
    });
}
