/**
 * The recorded client authorization: what it covers, when it is current, and the sentence a person confirms.
 *
 * Stable API:
 *   scopeFingerprint(app)                       sha256 over target, scope, exclusions and rate limit (normalized, order-free)
 *   authorizationStateOf(app, latest?, opts?)   { state: "current" | "stale" | "expired" | "revoked" | "none", message, authorizationId, ... }
 *   detailsFingerprint({ environment, profile, credentials })   sha256 over what else an authorization with the authorizer details, or an approval, covers
 *   authorizationStatement(orgName, app)        the plain, specific sentence shown before confirming and stored with the record
 *   LEGACY_AUTHORIZATION_EXPIRES_AT             when every record without the authorizer details stops counting (release + 90 days)
 *   AUTHORIZATION_WORDS                         the plain sentences (the UI and tests may compare with them)
 *
 * An authorization is tied to the fingerprint of what it covers: changing the target, the scope, the exclusions or the request rate
 * makes it stale, and a new confirmation is needed before the next assessment.
 *
 * Expiry (approved): an authorization recorded with the authorizing person's role and authority also carries a details
 * fingerprint (detailsFingerprint: the environment, the profile it allows as worded now, and the sign-in details of the accounts it uses)
 * and lasts AUTHORIZATION_VALID_DAYS from when it was recorded. One recorded before that ("details not recorded", a legacy record) is
 * judged on the scope fingerprint only and never allows anything above passive (profile-gate.ts), and it is never valid indefinitely:
 * it stops counting LEGACY_AUTHORIZATION_VALID_DAYS after the release that introduced this rule was deployed (release.ts, a timestamp
 * shipped with the code, so a database restored from an older backup cannot extend it). The stricter reading is used: release + 90
 * days, even for a record confirmed shortly before the release.
 *
 * This is the CLIENT's authorization (the application's owner, or someone with the owner's documented permission), recorded in the
 * platform by a project owner. It is not the Crowd4Test admin's approval of a profile above passive (profile-gate.ts), which is a
 * separate record. Wording: NOT APPROVED (a draft awaiting review).
 */
import { createHash } from "node:crypto";
import type { AssessmentKind, SecurityApplication, SecurityAuthorization } from "./contract.js";
import { LEGACY_AUTHORIZATION_RELEASE_AT } from "./release.js";
import { SCAN_PROFILES } from "./scanners/profiles.js";

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

/** Approved: a client authorization lasts this many days from when it is recorded. */
export const AUTHORIZATION_VALID_DAYS = 90;
/** Approved: an authorization recorded without the new authorizer details stops counting this many days after the release was deployed. */
export const LEGACY_AUTHORIZATION_VALID_DAYS = 90;
const DAY_MS = 86_400_000;

/** When a record made at `recordedAt` stops counting, `days` days later (ISO). */
export const expiryOf = (recordedAt: string, days: number): string => new Date(Date.parse(recordedAt) + days * DAY_MS).toISOString();

/** When every legacy record (no details fingerprint) stops counting: the release (release.ts) + LEGACY_AUTHORIZATION_VALID_DAYS. An unreadable
 *  release timestamp throws here, at startup, rather than leaving legacy records valid indefinitely. */
export const LEGACY_AUTHORIZATION_EXPIRES_AT = expiryOf(LEGACY_AUTHORIZATION_RELEASE_AT, LEGACY_AUTHORIZATION_VALID_DAYS);

export const AUTHORIZATION_WORDS = {
    current: "Authorized. Assessments can start within the recorded scope.",
    stale: "The target, scope, exclusions, request limit, saved sign-in or sensitive workflows changed after the authorization was recorded. Record a new authorization before the next assessment.",
    staleDetails:
        "The application's environment, the sign-in details of a test account it uses, the cross-account designation or the description of the profile it allows changed after the authorization was recorded. Record a new authorization before the next assessment.",
    expired: `The authorization has expired: it lasts ${AUTHORIZATION_VALID_DAYS} days from when it was recorded. Record a new authorization from the client before the next assessment.`,
    legacyExpired: `The authorization has expired: it was recorded without the authorizing person's role and documented authority, and such an authorization stops counting ${LEGACY_AUTHORIZATION_VALID_DAYS} days after the server was updated to require them. Record a new authorization from the client before the next assessment.`,
    revoked: "The authorization was revoked. Record a new one before the next assessment.",
    none: "No authorization is recorded yet. Before the first assessment, a project owner records the authorization the client gave to assess this application.",
} as const;

export type AuthorizationStateName = "current" | "stale" | "expired" | "revoked" | "none";

export interface AuthorizationState {
    state: AuthorizationStateName;
    message: string;
    /** The latest authorization the state is about (null for "none"). */
    authorizationId: string | null;
    /** When the latest authorization stops counting (null: none, or a record with the authorizer details but without a confirmation date). */
    expiresAt?: string | null;
    /** False when the latest authorization was recorded without the authorizing person's role and authority (passive only). */
    detailsRecorded?: boolean;
}

/** The profile as it is worded now: an authorization or approval of it stops counting when its words or limits change. */
const profileDefinition = (profile: AssessmentKind) => {
    const p = SCAN_PROFILES[profile];
    return { id: p.id, title: p.title, description: p.description, never: [...p.never], refusedIn: [...(p.refusedIn ?? [])], scanners: [...p.allowedScanners] };
};

/**
 * What else an authorization with the authorizer details, or an approval, covers, beyond the scope fingerprint: the environment, the profile as worded now, and the
 * sign-in details of the accounts it uses (store-built: saved sign-ins, the test-account list's version, the cross-account designation).
 */
export function detailsFingerprint(input: { environment: string; profile: AssessmentKind; credentials: unknown }): string {
    return createHash("sha256").update(JSON.stringify({ v: 3, environment: input.environment, profile: profileDefinition(input.profile), credentials: input.credentials ?? null })).digest("hex");
}

type LatestAuthorization = Pick<SecurityAuthorization, "id" | "revokedAt" | "scopeFingerprint"> & { confirmedAt?: string; detailsFingerprint?: string | null };

/**
 * The state of the application's authorization, judged from its latest record. `details` is the details fingerprint the latest record
 * would have now (store-built); `now` defaults to the clock. A record without a details fingerprint (a legacy record, recorded before the
 * details fingerprint existed) is judged on revocation and scope only, and expires at LEGACY_AUTHORIZATION_EXPIRES_AT.
 */
export function authorizationStateOf(app: ScopeFields, latest: LatestAuthorization | undefined, opts: { details?: string; now?: number } = {}): AuthorizationState {
    if (!latest) return { state: "none", message: AUTHORIZATION_WORDS.none, authorizationId: null };
    const v3 = Boolean(latest.detailsFingerprint);
    const expiresAt = v3 ? (latest.confirmedAt ? expiryOf(latest.confirmedAt, AUTHORIZATION_VALID_DAYS) : null) : LEGACY_AUTHORIZATION_EXPIRES_AT;
    const extra = { expiresAt, detailsRecorded: v3 };
    if (latest.revokedAt != null) return { state: "revoked", message: AUTHORIZATION_WORDS.revoked, authorizationId: latest.id, ...extra };
    if (expiresAt && (opts.now ?? Date.now()) >= Date.parse(expiresAt))
        return { state: "expired", message: v3 ? AUTHORIZATION_WORDS.expired : AUTHORIZATION_WORDS.legacyExpired, authorizationId: latest.id, ...extra };
    if (latest.scopeFingerprint !== scopeFingerprint(app)) return { state: "stale", message: AUTHORIZATION_WORDS.stale, authorizationId: latest.id, ...extra };
    if (v3 && opts.details !== undefined && opts.details !== latest.detailsFingerprint) return { state: "stale", message: AUTHORIZATION_WORDS.staleDetails, authorizationId: latest.id, ...extra };
    return { state: "current", message: AUTHORIZATION_WORDS.current, authorizationId: latest.id, ...extra };
}

/**
 * The sentence the person confirms (stored with the record as confirmed). `orgName` is the project's name: the client the work is for.
 * `allows` (profile-gate.ts): the most the authorization allows and the cross-account test accounts it names. Without it, or for passive
 * with no accounts, the sentence is exactly the passive one it always was.
 */
export function authorizationStatement(
    orgName: string,
    app: Pick<SecurityApplication, "targetUrl" | "scope" | "excludedPaths" | "signInAccount" | "sensitiveWorkflows">,
    allows: { maxProfile?: AssessmentKind; crossAccounts?: readonly string[] } = {},
): string {
    const scope = app.scope.length ? ` Also in scope: ${app.scope.join(", ")}.` : "";
    const excluded = app.excludedPaths.length ? ` Never requested: ${app.excludedPaths.join(", ")}.` : "";
    // Round 20 (SIGN): only said when set, so the sentence for an application without them is unchanged.
    const sensitive = app.sensitiveWorkflows?.length ? ` Sensitive workflows, never requested: ${app.sensitiveWorkflows.map((w) => `${w.name} (${w.pathPrefixes.join(", ")})`).join("; ")}.` : "";
    const signedIn = app.signInAccount
        ? ` It visits signed in with the saved sign-in of ${signInLabel(app.signInAccount)} (no password is typed and no form is submitted; sign-out links are not followed).`
        : "";
    const max = allows.maxProfile ?? "passive";
    const level =
        max === "passive"
            ? " The assessment is passive: it only sends the ordinary requests a visitor's browser makes."
            : ` The assessment may run at most the ${SCAN_PROFILES[max].title} profile: ${SCAN_PROFILES[max].description} This profile runs only while the application is marked as development or staging. The platform prohibits intentional operations that change data: no request is meant to create, update, delete or overwrite anything, and a check that would need one is skipped and listed as skipped in the report. A target application may still have unintended side effects even from read requests. Every request an external scanner sends goes through the platform's request guard, and each scanner run keeps a request log (time, method, host, path, result) that shows what was sent; it does not show whether the application changed. The platform does not detect such a change automatically; if the tester or the client sees that something changed, the tester records what was observed in the report and the client is told, and no further request is made to undo it. This authorization does not approve the profile by itself: each run above passive also needs a Crowd4Test admin's approval for this application's environment.`;
    const accounts = allows.crossAccounts?.length
        ? ` For the cross-account checks it also signs in, read-only, as ${allows.crossAccounts.map(signInLabel).join(" and ")}, to see whether one test account can read what belongs to the other.`
        : "";
    return `I confirm that ${orgName.trim() || "the client"} owns ${app.targetUrl} or that its owner has given documented permission to assess it, within the scope listed.${scope}${excluded}${sensitive}${level}${signedIn}${accounts}`;
}

/** "the project's own account" for "main", otherwise “the test account “admin””. */
export function signInLabel(account: string): string {
    return account === "main" ? "the project's own account" : `the test account “${account}”`;
}
