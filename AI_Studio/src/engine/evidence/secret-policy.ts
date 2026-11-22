/**
 * Which values of a run are secrets: the one policy behind the stored failure evidence (model.ts, secretsOfRun) and the failure traces
 * (trace-scrub.ts, traceSecretsOfRun). Masking is by value: every secret found here is hidden wherever it appears, in the forms each
 * consumer knows (URL-encoded, JSON-escaped, ...). Names only decide which of an environment's plain settings hold a secret.
 *
 * A run's secrets: the passwords, authenticator secrets and API tokens of its accounts, its API auth header (whole, its value, and the
 * credential without its scheme word), the base64 of a Basic
 * sign-in, every value of its saved sign-in (cookies, local and session storage, IndexedDB text) and the value of each environment setting
 * whose name says it is a secret. A username is not a secret (it is shown on the screens). A value shorter than 4 characters, or one that is
 * an ordinary word a setting could hold (`true`, `none`, ...), is never treated as a secret: hiding it everywhere would destroy the evidence
 * without protecting anything.
 */
import { parseStorageState, secretValuesOf } from "../auth/storage-state.js";

/**
 * A setting whose name says it holds a secret, matched at the end of the name, case-insensitive, with `_` or `-` between words or none
 * (camelCase): DB_PASSWORD, apiKey, client-secret, REFRESH_TOKEN, Proxy-Authorization, SESSION_ID, privateKey. Deliberately not a bare
 * "key" (PUBLIC_KEY, SORT_KEY), "id" or "code".
 */
export const SECRET_SETTING_NAME =
    /(?:pass(?:word|code|phrase)?|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|secret[_-]?key|signing[_-]?key|encryption[_-]?key|totp|otp[_-]?seed|auth[_-]?header|authori[sz]ation|cookies?|session(?:[_-]?(?:id|key))?|(?:^|[_-])sid|jwt|bearer|credentials?|connection[_-]?string|dsn)$/i;

/** Is this a setting name that holds a secret? */
export const isSecretSettingName = (name: string): boolean => SECRET_SETTING_NAME.test(name.trim());

/** Ordinary setting values that are never secrets, whatever the setting is called. */
const NOT_A_SECRET = /^(?:true|false|null|none|nil|undefined|yes|no|on|off|enabled|disabled|default|empty|unset|required|optional)$/i;

/** May this value be masked as a secret? At least 4 characters and not an ordinary word. */
export const isMaskableSecret = (v: unknown): v is string => typeof v === "string" && v.length >= 4 && !NOT_A_SECRET.test(v.trim());

/** What a run's environment holds that the policy reads. Every field is optional; nothing else of the environment is looked at. */
export interface RunSecretsEnv {
    credentials?: { username?: string; password?: string; totpSecret?: string } | undefined;
    roles?: Array<{ username?: string; password?: string; totpSecret?: string; apiToken?: string }> | undefined;
    apiToken?: string | undefined;
    apiAuthHeader?: string | undefined;
    storageState?: string | undefined;
    vars?: Record<string, string> | undefined;
    dbCheck?: { token: string } | undefined;
}

/** Every secret of a run's environment, as exact strings (see the header). Reads the environment, never changes it. */
export function runSecretValues(env: RunSecretsEnv): string[] {
    const out: Array<string | undefined> = [env.credentials?.password, env.credentials?.totpSecret, env.apiToken, env.apiAuthHeader, env.dbCheck?.token];
    for (const r of env.roles ?? []) out.push(r.password, r.totpSecret, r.apiToken);
    // An auth header ("Authorization: Bearer abc"): its value, and the credential alone without the scheme word, can each show up on their own.
    const header = /^[A-Za-z][\w-]*:\s*(.+)$/.exec(env.apiAuthHeader?.trim() ?? "");
    if (header) {
        out.push(header[1]);
        const scheme = /^(?:Bearer|Basic|Token|Digest|ApiKey|Key)\s+(.+)$/i.exec(header[1]!.trim());
        if (scheme) out.push(scheme[1]);
    }
    for (const [name, value] of Object.entries(env.vars ?? {})) if (isSecretSettingName(name)) out.push(value);
    for (const c of [env.credentials, ...(env.roles ?? [])]) {
        if (!c?.password || c.password.length < 4) continue;
        const b64 = Buffer.from(`${c.username ?? ""}:${c.password}`, "utf8").toString("base64");
        out.push(b64, b64.replace(/=+$/, ""));
    }
    if (env.storageState) {
        try {
            out.push(...secretValuesOf(parseStorageState(env.storageState)));
        } catch {
            /* a saved sign-in that does not parse was not used by the run */
        }
    }
    return [...new Set(out.filter(isMaskableSecret))];
}
