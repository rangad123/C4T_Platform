/**
 * The cover Playwright applies to every screenshot a web test run keeps as proof (the `style` of the run config's `screenshot` option,
 * src/engine/validation/runner.ts). It hides the fields the recorder treats as secret by kind (`secretKindOfField` in recorder/act.ts:
 * passwords, one-time codes, card numbers and codes), the same fields the Explorer pictures cover (frames/shoot.ts). Playwright applies
 * the style only while it takes the picture, inside frames and shadow roots too, and the page itself is never changed.
 *
 * The selector is a superset of the recorder's rule for each attribute on its own: every field the rule calls secret is covered (a test
 * keeps them agreeing), and a few more may be (an id holding "otp" inside a longer word). It also covers the fields that hold personal
 * data or other secrets (PERSONAL_*: e-mail, phone, postal address, tokens, keys, sessions, connection strings), which the recorder types
 * as they are. A value that is not in such a field (a stored password typed into an ordinary text box) is not found: CSS cannot see what a
 * field holds. Text on the page itself is not covered. Videos cannot be covered at all.
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

/** Fields of personal data and other secrets, by type, autocomplete and the words of the name, id, label or placeholder (case-insensitive). */
const PERSONAL_TYPES = ["email", "tel"];
const PERSONAL_AUTOCOMPLETE = ["email", "tel", "street-address", "address-line", "postal-code", "cc-"];
const PERSONAL_WORDS = [
    "email", "e-mail", "phone", "mobile", "address", "token", "secret", "api_key", "api-key", "apikey", "api key", "session", "cookie", "dsn", "connection", "iban", "ssn",
    // Password in other languages (KNOWN-LIMITS-P3 T-9: a field named `Clave1`), as parts of a name, so a digit after one is covered too.
    // "clave" also covers a "palabra clave" search box: covering a field too many is the safe side.
    "clave", "senha", "contrase", "passwort", "kennwort", "wachtwoord", "mot de passe", "motdepasse", "haslo", "hasło", "sifre", "şifre",
    "losenord", "lösenord", "passord", "adgangskode", "salasana", "пароль", "密码", "密碼", "パスワード", "비밀번호", "암호", "geheimzahl",
];

/**
 * Whether a field's attributes (as a page snapshot keeps them: name, id, type, autocomplete, aria-label, placeholder) mark it as secret or
 * personal: the same rule as the cover below, for code that has the attributes rather than the element (evidence/trace-scrub.ts).
 */
export function isSensitiveField(attrs: Readonly<Record<string, unknown>>): boolean {
    const a = (k: string) => (typeof attrs[k] === "string" ? (attrs[k] as string).toLowerCase() : "");
    if (["password", ...PERSONAL_TYPES].includes(a("type"))) return true;
    if ([...AUTOCOMPLETE, ...PERSONAL_AUTOCOMPLETE].some((v) => a("autocomplete").includes(v))) return true;
    return HINTS.some((h) => [...HINT_WORDS, ...PERSONAL_WORDS.map((w) => [w])].some((words) => words.every((w) => a(h).includes(w))));
}

const attr = (name: string, value: string): string => `[${name}*=${JSON.stringify(value)} i]`;

/** Every `input` that is secret by kind, as one CSS selector list. */
export const PROOF_SECRET_FIELDS: string = [
    'input[type="password" i]',
    ...PERSONAL_TYPES.map((t) => `input[type="${t}" i]`),
    ...[...AUTOCOMPLETE, ...PERSONAL_AUTOCOMPLETE].map((v) => `input${attr("autocomplete", v)}`),
    ...HINTS.flatMap((h) => [...HINT_WORDS, ...PERSONAL_WORDS.map((w) => [w])].map((words) => `input${words.map((w) => attr(h, w)).join("")}`)),
    // A text area holding an address or a token is the same data.
    ...PERSONAL_AUTOCOMPLETE.map((v) => `textarea${attr("autocomplete", v)}`),
    ...HINTS.flatMap((h) => PERSONAL_WORDS.map((w) => `textarea${attr(h, w)}`)),
].join(",");

const COVER = "#475569";

/** The style sheet Playwright applies while it takes a proof screenshot. Separate rules, so a selector one browser does not know never drops the others. */
export const PROOF_SHOT_STYLE: string = [
    `${PROOF_SECRET_FIELDS}{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;caret-color:transparent !important;background:${COVER} !important;background-image:none !important;border-color:${COVER} !important;box-shadow:none !important}`,
    `${PROOF_SECRET_FIELDS.split(",").map((s) => `${s}::placeholder`).join(",")}{color:transparent !important;-webkit-text-fill-color:transparent !important}`,
    `${PROOF_SECRET_FIELDS.split(",").map((s) => `${s}:-webkit-autofill`).join(",")}{-webkit-box-shadow:0 0 0 1000px ${COVER} inset !important;-webkit-text-fill-color:transparent !important}`,
].join("\n");
