/**
 * The recorder's data model (the shapes of `.scratch/briefs/RECORDER-API-SHAPES.md`) and the rules that do not need a browser:
 * what looks generated, which fields hold secrets, the caps.
 */

export const REC_STRATEGIES = ["testId", "role", "label", "placeholder", "text", "css"] as const;
export type RecStrategy = (typeof REC_STRATEGIES)[number];

export interface RecLocator {
    strategy: RecStrategy;
    /** testId / label / placeholder / text / css value, or the ARIA role for strategy "role". */
    value: string;
    /** Accessible name, for strategy "role". */
    name?: string;
    exact?: boolean;
}

export const REC_STEP_KINDS = ["goto", "click", "fill", "select", "check", "uncheck", "press", "assert", "upload", "drag"] as const;
export type RecStepKind = (typeof REC_STEP_KINDS)[number];

export const REC_ASSERT_CHECKS = ["visible", "hidden", "text", "value", "enabled", "disabled", "count"] as const;
export type RecAssertCheck = (typeof REC_ASSERT_CHECKS)[number];
export interface RecAssert {
    check: RecAssertCheck;
    expected?: string | number;
}

export interface RecAlternative {
    locator: RecLocator;
    matches: number;
}

export interface RecStep {
    index: number;
    kind: RecStepKind;
    url?: string;
    locator?: RecLocator;
    alternatives?: RecAlternative[];
    matches?: number;
    value?: string;
    secret?: boolean;
    assert?: RecAssert;
    /** Name of the shared element (object repository) this step uses. The locator stays for display. */
    ref?: string;
    /** drag: the element it was dropped on. */
    target?: RecLocator;
    /** The frames (iframes) the element is inside, outermost first. */
    frame?: Array<{ by: "name" | "title" | "url"; value: string }>;
    /** The step happened in the popup window an earlier click opened. */
    inPopup?: boolean;
    /** This click opened a popup window or a new tab. */
    opensPopup?: boolean;
    describe: string;
    at: string;
}

export const REC_LIMITS = {
    maxSteps: 300,
    /** Longest text a locator may carry. */
    maxLocatorText: 60,
    /** Longest typed value kept. */
    maxValue: 500,
    /** Longest text an assertion keeps. */
    maxAssertText: 120,
    maxDescribe: 240,
    maxAlternatives: 4,
    maxNotes: 20,
} as const;

/** Text shapes that change between visits: such a locator would break on the next run. Shared with the injected script (see page-script.ts). */
export const DYNAMIC_PATTERNS: Array<[string, string]> = [
    // uuid
    ["[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "i"],
    // long hex / token-like runs that contain a digit (css-in-js hashes, object ids)
    ["(?=[a-z]*\\d)(?=\\d*[a-f])[0-9a-f]{8,}", "i"],
    // three or more digits in a row (timestamps, ids, order numbers)
    ["\\d{3,}", ""],
    // dates and clock times
    ["\\d{4}-\\d{2}-\\d{2}", ""],
    ["\\b\\d{1,2}:\\d{2}(:\\d{2})?\\b", ""],
    // a counter: "(3)", "3 items", "12 results", "2 new"
    ["(^|[\\s(\\[])\\d+([)\\]]|\\s+(items?|results?|new|unread|selected|notifications?|comments?|likes?|views?))", "i"],
    // random-looking suffix: name-a8f3k2, css-1x9y8z
    ["[-_](?=[a-z]*\\d)[a-z0-9]{6,}$", "i"],
];
const DYNAMIC = DYNAMIC_PATTERNS.map(([s, f]) => new RegExp(s, f));
export const looksDynamic = (text: string): boolean => DYNAMIC.some((re) => re.test(text));

/** Placeholders standing in for secrets. Only these ever reach a step, a spec or an API answer. */
export const SECRET_PLACEHOLDERS = {
    password: "{{credentials.password}}",
    otp: "{{credentials.totp}}",
    card_number: "{{secret.card_number}}",
    card_cvc: "{{secret.card_cvc}}",
} as const;
export type SecretKind = keyof typeof SECRET_PLACEHOLDERS;
export const isSecretKind = (k: unknown): k is SecretKind => typeof k === "string" && Object.prototype.hasOwnProperty.call(SECRET_PLACEHOLDERS, k);

/** What the person is told a secret step typed. */
export const SECRET_WORDS: Record<SecretKind, string> = {
    password: "the password",
    otp: "the one-time code",
    card_number: "the card number",
    card_cvc: "the card security code",
};

export const MESSAGES = {
    typeWarning: "Don't type real personal data or secrets while recording.",
} as const;

export function clip(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A stable key of a locator, for deduping fills of the same field. */
export const locatorKey = (l: RecLocator | undefined): string => (l ? JSON.stringify([l.strategy, l.value, l.name ?? null, l.exact ?? false]) : "");
