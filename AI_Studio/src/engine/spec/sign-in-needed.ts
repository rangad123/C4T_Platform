/**
 * A test that types the project's sign-in ({{credentials.username}}, {{credentials.password}}, {{credentials.totp}}; in a code test
 * TEST_USERNAME, TEST_PASSWORD, TEST_TOTP_SECRET) while the run has none would type empty text and fail somewhere unrelated. The run
 * says instead, before it starts the test, what is missing and where to enter it. Named accounts ({{credentials.admin.password}}) are
 * the project's test accounts and are not checked here.
 */
import type { TestSpec } from "./schema.js";

type Field = "username" | "password" | "totp";
const IN_STEPS = /\{\{\s*credentials\.(username|password|totp)\s*\}\}/g;
const IN_CODE = /\bTEST_(USERNAME|PASSWORD|TOTP_SECRET)\b/g;
const CODE_FIELD: Record<string, Field> = { USERNAME: "username", PASSWORD: "password", TOTP_SECRET: "totp" };
const WORDS: Record<Field, string> = { username: "user name", password: "password", totp: "authenticator secret" };

export const WHERE_TO_ENTER_SIGN_IN = "Project settings → Sign-in";

/** The parts of the project's sign-in this test types. */
export function signInFieldsUsed(test: { spec: Pick<TestSpec, "steps" | "testData">; custom?: { content: string } }): Set<Field> {
    const used = new Set<Field>();
    if (test.custom) for (const m of test.custom.content.matchAll(IN_CODE)) used.add(CODE_FIELD[m[1]!]!);
    else for (const m of JSON.stringify([test.spec.steps, test.spec.testData ?? {}]).matchAll(IN_STEPS)) used.add(m[1] as Field);
    return used;
}

/**
 * The sentence a test fails with when the run cannot give it the sign-in it types; undefined when it can. `have` is what is saved, as
 * saved: the run hands a sign-in to the test only when both its user name and password are saved (and the authenticator secret when the
 * test types a one-time code), so a user name saved without a password is named as a missing password. `where` names the place to
 * enter it (an environment's own settings for an environment the project's sign-in is not sent to).
 */
export function missingSignIn(testId: string, test: Parameters<typeof signInFieldsUsed>[0], have: { username?: string; password?: string; totpSecret?: string } | undefined, where = WHERE_TO_ENTER_SIGN_IN): string | undefined {
    const used = signInFieldsUsed(test);
    if (!used.size) return undefined;
    const needed: Field[] = ["username", "password", ...(used.has("totp") ? (["totp"] as const) : [])];
    const missing = needed.filter((f) => !(f === "totp" ? have?.totpSecret : have?.[f]));
    if (!missing.length) return undefined;
    const list = missing.map((f) => WORDS[f]);
    const named = list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
    return `${testId} signs in with the project's sign-in, and no ${named} ${missing.length === 1 ? "is" : "are"} saved for this run, so it was not run. Enter the sign-in in ${where}, then run it again.`;
}
