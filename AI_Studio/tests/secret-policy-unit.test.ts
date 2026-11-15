/**
 * One secret policy for stored failure evidence and failure traces (src/engine/evidence/secret-policy.ts): the same values are hidden in
 * both, including the ones the evidence list used to miss (a saved sign-in's values, secret-named settings, a Basic sign-in's base64).
 * Masking is by value; names only decide which settings hold a secret.
 */
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { sanitizeEvidence, secretsOfRun, type Evidence } from "../src/engine/evidence/model.js";
import { isMaskableSecret, isSecretSettingName, runSecretValues, type RunSecretsEnv } from "../src/engine/evidence/secret-policy.js";
import { scrubTraceBytes, traceSecretForms, traceSecretsOfChildEnv, traceSecretsOfRun } from "../src/engine/evidence/trace-scrub.js";

const cookie = (name: string, value: string) => ({ name, value, domain: "app.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const });
const storageState = JSON.stringify({
    cookies: [cookie("sid", "COOKIE-session-7f3a9c")],
    origins: [{ origin: "https://app.example", localStorage: [{ name: "auth", value: "LS-refresh-tok-55aa" }], sessionStorage: [{ name: "jwt", value: "SS-access-tok-66bb" }], indexedDB: [{ name: "db", stores: [{ records: [{ value: { nested: ["IDB-id-token-77cc99"] } }] }] }] }],
});
const env: RunSecretsEnv = {
    credentials: { username: "ana@example.test", password: "Pw-main 9!" },
    roles: [{ username: "admin@example.test", password: "Admin-pw-42", apiToken: "role-access-token-11" }],
    apiToken: "api-refresh-token-22",
    apiAuthHeader: "Authorization: Bearer hdr-bearer-33",
    storageState,
    vars: {
        DB_PASSWORD: "db-pass-44",
        apiKey: "camel-api-key-55",
        "client-secret": "kebab-client-secret-66",
        REFRESH_TOKEN: "env-refresh-77",
        "Proxy-Authorization": "Basic cHJveHk6cHc=",
        SESSION_ID: "env-session-88",
        privateKey: "pk-material-99",
        // Not secrets: must stay as they are.
        BASE_URL: "https://app.example",
        PUBLIC_KEY: "pub-key-plain",
        SORT_KEY: "created_at",
        keyword: "checkout",
        user_id: "u-12345",
        SHOW_COOKIES: "true",
    },
};
const SECRETS = ["Pw-main 9!", "Admin-pw-42", "role-access-token-11", "api-refresh-token-22", "hdr-bearer-33", "COOKIE-session-7f3a9c", "LS-refresh-tok-55aa", "SS-access-tok-66bb", "IDB-id-token-77cc99", "db-pass-44", "camel-api-key-55", "kebab-client-secret-66", "env-refresh-77", "Basic cHJveHk6cHc=", "env-session-88", "pk-material-99"];
const PLAIN = ["https://app.example", "pub-key-plain", "created_at", "checkout", "u-12345", "ana@example.test"];

/** A stored evidence attachment whose console lines and request paths carry every value. */
function evidenceWith(values: string[]): Evidence {
    return {
        v: 1,
        durationMs: 10,
        counts: { requests: values.length, requestsKept: values.length, console: values.length, consoleKept: values.length },
        steps: [{ n: 1, t: 1 }],
        requests: values.map((v, i) => ({ t: i, step: 1, method: "GET", type: "fetch", path: `/api/items/${encodeURIComponent(v)}`, status: 500 })),
        console: values.map((v, i) => ({ t: i, step: 1, type: "error", text: `value=${v} seen` })),
    };
}
const evidenceText = (values: string[]) => JSON.stringify(sanitizeEvidence(evidenceWith(values), secretsOfRun(env)));

async function traceText(values: string[]): Promise<string> {
    const zip = zipSync({ "1-trace.trace": [strToU8(values.map((v) => JSON.stringify({ type: "log", message: `fill(${JSON.stringify(v)})` })).join("\n")), { level: 6 }] });
    const r = await scrubTraceBytes(zip, traceSecretForms(traceSecretsOfRun(env)));
    expect(r.ok).toBe(true);
    const files = unzipSync((r as { data: Uint8Array }).data);
    return new TextDecoder().decode(files["1-trace.trace"]);
}

describe("one secret list for evidence and traces", () => {
    it("evidence and traces hide exactly the same secrets (the evidence list is no shorter than the trace list)", async () => {
        const ev = evidenceText(SECRETS);
        const tr = await traceText(SECRETS);
        for (const s of SECRETS) {
            expect(ev, `evidence: ${s}`).not.toContain(s);
            expect(tr, `trace: ${s}`).not.toContain(s);
        }
        expect(new Set(runSecretValues(env))).toEqual(new Set(traceSecretsOfRun(env)));
        for (const s of traceSecretsOfRun(env)) expect(secretsOfRun(env), s).toContain(s);
    });

    it("the gaps the evidence list had: saved sign-in values, secret-named settings, a Basic sign-in's base64, a bearer credential alone", () => {
        expect(evidenceText(["hdr-bearer-33"])).not.toContain("hdr-bearer-33");
        const basic = Buffer.from("ana@example.test:Pw-main 9!").toString("base64");
        const s = secretsOfRun(env);
        for (const v of ["COOKIE-session-7f3a9c", "LS-refresh-tok-55aa", "SS-access-tok-66bb", "IDB-id-token-77cc99", "db-pass-44", "camel-api-key-55", basic, basic.replace(/=+$/, "")]) expect(s, v).toContain(v);
        expect(evidenceText([basic])).not.toContain(basic);
    });
});

describe("what counts as a secret", () => {
    it("passwords, access and refresh tokens, authorization and cookie values, API keys and client secrets", () => {
        const s = runSecretValues(env);
        for (const v of SECRETS) expect(s, v).toContain(v);
        expect(s).not.toContain("ana@example.test");
    });

    it("password variants in the encoded forms text carries them in (URL, form, JSON) are hidden in evidence", () => {
        const pw = 'Pw-main 9!';
        const ev = JSON.stringify(sanitizeEvidence({ ...evidenceWith([]), counts: { requests: 0, requestsKept: 0, console: 3, consoleKept: 3 }, console: [encodeURIComponent(pw), encodeURIComponent(pw).replace(/%20/g, "+"), JSON.stringify(pw).slice(1, -1)].map((t, i) => ({ t: i, step: 1, type: "error", text: `x ${t} y` })) }, secretsOfRun(env)));
        for (const form of [encodeURIComponent(pw), encodeURIComponent(pw).replace(/%20/g, "+")]) expect(ev).not.toContain(form);
        expect(ev).not.toContain("Pw-main 9");
    });

    it("setting names match case-insensitively in snake, kebab and camel case, at the end of the name", () => {
        for (const n of ["DB_PASSWORD", "db-password", "dbPassword", "PASSPHRASE", "apiKey", "API-KEY", "x_api_key", "clientSecret", "CLIENT_SECRET", "accessToken", "refresh-token", "AUTH_HEADER", "Authorization", "proxy-authorization", "COOKIE", "cookies", "sessionId", "SESSION_KEY", "session", "SID", "app_sid", "privateKey", "secret-key", "jwt", "TOTP", "credentials", "DATABASE_DSN", "connectionString"]) expect(isSecretSettingName(n), n).toBe(true);
        for (const n of ["BASE_URL", "PUBLIC_KEY", "SORT_KEY", "keyword", "user_id", "tokenizer", "passwordPolicy", "COOKIE_BANNER_TEXT", "outside", "consider", "status_code", "region"]) expect(isSecretSettingName(n), n).toBe(false);
    });

    it("ordinary values are never secrets, even under a secret-sounding name", () => {
        for (const v of ["true", "FALSE", "none", "yes", "off", "abc", ""]) expect(isMaskableSecret(v), v).toBe(false);
        expect(runSecretValues({ vars: { SHOW_COOKIES: "true", SESSION: "none" } })).toEqual([]);
    });
});

describe("structure and safety", () => {
    it("nested saved-sign-in values (local, session storage and IndexedDB records) are found", () => {
        const s = runSecretValues({ storageState });
        for (const v of ["COOKIE-session-7f3a9c", "LS-refresh-tok-55aa", "SS-access-tok-66bb", "IDB-id-token-77cc99"]) expect(s, v).toContain(v);
    });

    it("ordinary fields stay as they are in evidence and traces", async () => {
        const ev = evidenceText(PLAIN);
        const tr = await traceText(PLAIN);
        for (const v of PLAIN) {
            expect(ev, v).toContain(v.replace("https://app.example", "app.example").startsWith("app.example") ? "app.example" : v);
            expect(tr, v).toContain(v);
        }
        const out = sanitizeEvidence(evidenceWith(["hello"]), secretsOfRun(env))!;
        expect(out.requests[0]!.method).toBe("GET");
        expect(out.requests[0]!.status).toBe(500);
    });

    it("never changes the environment or the evidence it is given", () => {
        const before = JSON.stringify(env);
        const raw = evidenceWith(SECRETS);
        const rawBefore = JSON.stringify(raw);
        runSecretValues(env);
        secretsOfRun(env);
        traceSecretsOfRun(env);
        sanitizeEvidence(raw, secretsOfRun(env));
        expect(JSON.stringify(env)).toBe(before);
        expect(JSON.stringify(raw)).toBe(rawBefore);
    });

    it("an unreadable saved sign-in does not stop the rest of the list", () => {
        const s = runSecretValues({ credentials: { password: "still-hidden-1" }, storageState: "{not json" });
        expect(s).toContain("still-hidden-1");
        // Only the password and its Basic sign-in form: nothing from the saved sign-in that could not be read.
        expect(s.every((v) => v === "still-hidden-1" || Buffer.from(v, "base64").toString().endsWith("still-hidden-1"))).toBe(true);
    });
});

describe("compatible with the lists before", () => {
    it("secretsOfRun still lists what it listed before, with its encoded forms", () => {
        const s = secretsOfRun({ credentials: { password: "pw one!", totpSecret: "KRSXG5CTMVRXEZLU" }, apiToken: "tok-111", apiAuthHeader: "X-Key: kv-2222", roles: [{ password: "adminpw", apiToken: "admtok1" }] });
        for (const needle of ["pw one!", "pw%20one!", "pw+one!", "KRSXG5CTMVRXEZLU", "tok-111", "X-Key: kv-2222", "kv-2222", "adminpw", "admtok1"]) expect(s, needle).toContain(needle);
    });

    it("traceSecretsOfRun keeps every value the earlier pattern found, and the child-process list uses the same names", () => {
        const old = { DB_PASSWORD: "a1b2c3d4", MY_SECRET: "e5f6g7h8", STRIPE_TOKEN: "i9j0k1l2", API_KEY: "m3n4o5p6", PRIVATE_KEY: "q7r8s9t0", ACCESS_KEY: "u1v2w3x4", TOTP: "y5z6a7b8", AUTH_HEADER: "c9d0e1f2", CREDENTIALS: "g3h4i5j6", PASSCODE: "k7l8m9n0" };
        const s = traceSecretsOfRun({ vars: old });
        for (const v of Object.values(old)) expect(s, v).toContain(v);
        const child = traceSecretsOfChildEnv({ TEST_ENV_clientSecret: "child-secret-1", TEST_ENV_BASE_URL: "https://x.example", TEST_PASSWORD: "child-pw-22" });
        expect(child.sort()).toEqual(["child-pw-22", "child-secret-1"]);
    });
});
