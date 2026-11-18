/**
 * The cover Playwright applies to every screenshot a web test run keeps as proof (the `style` of the run config's `screenshot` option,
 * src/engine/validation/runner.ts). It hides the fields the recorder treats as secret by kind (`secretKindOfField` in recorder/act.ts:
 * passwords, one-time codes, card numbers and codes), the same fields the Explorer pictures cover (frames/shoot.ts). Playwright applies
 * the style only while it takes the picture, inside frames and shadow roots too, and the page itself is never changed.
 *
 * The selector is a superset of the recorder's rule for each attribute on its own: every field the rule calls secret is covered (a test
 * keeps them agreeing), and a few more may be (an id holding "otp" inside a longer word). A value that is not in such a field (a stored
 * password typed into an ordinary text box) is not found: CSS cannot see what a field holds. Videos cannot be covered at all.
 */

const HINTS = ["name", "id", "aria-label", "placeholder"] as const;

/** One or more substrings that must all be in the same attribute (case-insensitive), standing for one part of the recorder's rule. */
const HINT_WORDS: ReadonlyArray<readonly string[]> = [
    ["password"],
    ["passwd"],
    ["passcode"],
    ["otp"],
    ["one", "time"],
    ["verification code"],
    ["cvv"],
    ["cvc"],
    ["security code"],
    ["card", "number"],
    ["card", "no"],
];

const AUTOCOMPLETE = ["one-time-code", "cc-number", "cc-csc", "current-password", "new-password"];

const attr = (name: string, value: string): string => `[${name}*=${JSON.stringify(value)} i]`;

/** Every `input` that is secret by kind, as one CSS selector list. */
export const PROOF_SECRET_FIELDS: string = [
    'input[type="password" i]',
    ...AUTOCOMPLETE.map((v) => `input${attr("autocomplete", v)}`),
    ...HINTS.flatMap((h) => HINT_WORDS.map((words) => `input${words.map((w) => attr(h, w)).join("")}`)),
].join(",");

const COVER = "#475569";

/** The style sheet Playwright applies while it takes a proof screenshot. Separate rules, so a selector one browser does not know never drops the others. */
export const PROOF_SHOT_STYLE: string = [
    `${PROOF_SECRET_FIELDS}{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;caret-color:transparent !important;background:${COVER} !important;background-image:none !important;border-color:${COVER} !important;box-shadow:none !important}`,
    `${PROOF_SECRET_FIELDS.split(",").map((s) => `${s}::placeholder`).join(",")}{color:transparent !important;-webkit-text-fill-color:transparent !important}`,
    `${PROOF_SECRET_FIELDS.split(",").map((s) => `${s}:-webkit-autofill`).join(",")}{-webkit-box-shadow:0 0 0 1000px ${COVER} inset !important;-webkit-text-fill-color:transparent !important}`,
].join("\n");
