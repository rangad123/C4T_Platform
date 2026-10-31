/**
 * The recorded client authorization: what it covers, when it is current, and the sentence a person confirms.
 *
 * Stable API:
 *   scopeFingerprint(app)                       sha256 over target, scope, exclusions and rate limit (normalized, order-free)
 *   authorizationStateOf(app, latest?)          { state: "current" | "stale" | "revoked" | "none", message, authorizationId }
 *   authorizationStatement(orgName, app)        the plain, specific sentence shown before confirming and stored with the record
 *   AUTHORIZATION_WORDS                         the plain sentences (the UI and tests may compare with them)
 *
 * An authorization is tied to the fingerprint of what it covers: changing the target, the scope, the exclusions or the request rate
 * makes it stale, and a new confirmation is needed before the next assessment.
 */
import { createHash } from "node:crypto";
import type { SecurityApplication, SecurityAuthorization } from "./contract.js";

type ScopeFields = Pick<SecurityApplication, "targetUrl" | "scope" | "excludedPaths" | "maxRequestsPerSecond" | "signInAccount" | "sensitiveWorkflows">;

const normTarget = (raw: string): string => {
    try {
        const u = new URL(raw.trim());
        u.hash = "";
        return u.href;
    } catch {
        return raw.trim();
    }
};

export function scopeFingerprint(app: ScopeFields): string {
    const canonical = {
        v: 1,
        target: normTarget(app.targetUrl),
        scope: [...new Set(app.scope.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort(),
        excluded: [...new Set(app.excludedPaths.map((s) => s.trim()).filter(Boolean))].sort(),
        rps: app.maxRequestsPerSecond,
        // Round 20 (SIGN): the saved sign-in used and the sensitive workflows are part of what was authorized. Only present when set,
        // so the fingerprint of an application without them is exactly what it was (its authorization stays current).
        ...(app.signInAccount ? { signIn: app.signInAccount } : {}),
        ...(app.sensitiveWorkflows?.length
            ? { sensitive: app.sensitiveWorkflows.map((w) => ({ name: w.name.trim(), prefixes: [...new Set(w.pathPrefixes.map((p) => p.trim()))].sort() })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }
            : {}),
    };
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export const AUTHORIZATION_WORDS = {
    current: "Authorized. Assessments can start within the recorded scope.",
    stale: "The target, scope, exclusions, request limit, saved sign-in or sensitive workflows changed after the authorization was recorded. Record a new authorization before the next assessment.",
    revoked: "The authorization was revoked. Record a new one before the next assessment.",
    none: "No authorization is recorded yet. An owner must record the client's authorization before the first assessment.",
} as const;

export interface AuthorizationState {
    state: keyof typeof AUTHORIZATION_WORDS;
    message: string;
    /** The latest authorization the state is about (null for "none"). */
    authorizationId: string | null;
}

/** The state of the application's authorization, judged from its latest record. */
export function authorizationStateOf(app: ScopeFields, latest: Pick<SecurityAuthorization, "id" | "revokedAt" | "scopeFingerprint"> | undefined): AuthorizationState {
    if (!latest) return { state: "none", message: AUTHORIZATION_WORDS.none, authorizationId: null };
    if (latest.revokedAt) return { state: "revoked", message: AUTHORIZATION_WORDS.revoked, authorizationId: latest.id };
    if (latest.scopeFingerprint !== scopeFingerprint(app)) return { state: "stale", message: AUTHORIZATION_WORDS.stale, authorizationId: latest.id };
    return { state: "current", message: AUTHORIZATION_WORDS.current, authorizationId: latest.id };
}

/** The sentence the person confirms (stored with the record as confirmed). `orgName` is the project's name: the client the work is for. */
export function authorizationStatement(orgName: string, app: Pick<SecurityApplication, "targetUrl" | "scope" | "excludedPaths" | "signInAccount" | "sensitiveWorkflows">): string {
    const scope = app.scope.length ? ` Also in scope: ${app.scope.join(", ")}.` : "";
    const excluded = app.excludedPaths.length ? ` Never requested: ${app.excludedPaths.join(", ")}.` : "";
    // Round 20 (SIGN): only said when set, so the sentence for an application without them is unchanged.
    const sensitive = app.sensitiveWorkflows?.length ? ` Sensitive workflows, never requested: ${app.sensitiveWorkflows.map((w) => `${w.name} (${w.pathPrefixes.join(", ")})`).join("; ")}.` : "";
    const signedIn = app.signInAccount
        ? ` It visits signed in with the saved sign-in of ${signInLabel(app.signInAccount)} (no password is typed and no form is submitted; sign-out links are not followed).`
        : "";
    return `I confirm that ${orgName.trim() || "the client"} owns ${app.targetUrl} or that its owner has given documented permission to assess it, within the scope listed.${scope}${excluded}${sensitive} The assessment is passive: it only sends the ordinary requests a visitor's browser makes.${signedIn}`;
}

/** "the project's own account" for "main", otherwise “the test account “admin””. */
export function signInLabel(account: string): string {
    return account === "main" ? "the project's own account" : `the test account “${account}”`;
}
