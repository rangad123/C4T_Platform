/**
 * Whether a field is named like one that takes a secret: a password or passphrase, a PIN, a one-time or verification code, a token,
 * an API or private key, a secret, a credential, card security details. One rule for what is hidden of a field the engine typed into
 * or pictured: the exploration action log hides what was typed into such a field (engine/explore/action-mask.ts), and the pictures a
 * finding and the Explorer view keep cover it (engine/frames/shoot.ts), by its name, id, aria-label, placeholder or label text.
 *
 * It decides what is hidden, never what may be typed: the recorder's stricter `secretKindOfField` (recorder/act.ts) decides that,
 * and a field this rule names but that one does not stays an ordinary field to fill.
 *
 * Names are compared in words: `apiToken`, `api_token` and `api-token` are all "api token", so a PIN in `card_pin` is found while
 * `spinner` and `shipping` are not PIN fields. Covering a field too many is the safe side.
 */

/** A name as words: camelCase split, separators as spaces, lower case. */
export function nameWords(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[\s_.:\-[\]/]+/g, " ")
        .toLowerCase();
}

/** The rule on a name already in words (`nameWords`). */
const SECRET_WORDS =
    /pass(?:word|wd|code|phrase)|\bpass\b|\bpwd\b|\bpin\b|\botp\b|one ?time|verification code|\btotp\b|\b2fa\b|\bmfa\b|secret|token|\bapi ?key\b|apikey|private ?key|credential|\bcvv\b|\bcvc\b|security code|card ?(?:number|no\b)|\bssn\b/;

/** Whether any of these names (a field's name, id, labels, a locator's text, an element's accessible name) says it takes a secret. */
export function namesSecretField(...names: ReadonlyArray<string | null | undefined>): boolean {
    return names.some((n) => typeof n === "string" && n !== "" && SECRET_WORDS.test(nameWords(n)));
}
