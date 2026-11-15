/**
 * The gate in front of every assessment profile above passive (roadmap C-4 / H-2). It only decides whether an assessment may START at a
 * profile; it adds no check of its own and switches on no scanner.
 *
 * An assessment may start above passive only when all of these hold, checked in this order on the server:
 *   0. the application is marked development or staging (never production or "other");
 *   1. the application's current authorization names that profile (or a higher one) as the most it allows: an authorization recorded
 *      before this gate, or one that names no profile, covers passive only, so old passive consent never covers anything active;
 *   2. the server has Crowd4Test sign-in, and an approval of that profile by a Crowd4Test admin (who is still one), for the environment
 *      the application is marked with now, is recorded and not withdrawn. Nobody else ever approves: no fallback for a server without
 *      Crowd4Test sign-in, the open server or an access key (route, store and this start check all refuse);
 *   3. the profile's own refusal (scanners/profiles.ts profileRefusal: the advanced profile is refused for production) does not apply;
 *   4. the machine can run the scanners in an isolated network whose only way out is the request guard (egress/isolation.ts; the
 *      scanner orchestration proves it again from the scanners' own context before any of them starts);
 *   5. the server allows active profiles at all (SECURITY_ACTIVE_PROFILES=on, default off).
 * Passive starts exactly as before: none of this is asked.
 *
 * Two separate records, never confused in the wording: the client's AUTHORIZATION (authorization.ts: recorded by a project owner, it
 * states that the client owns the application or gave documented permission, and the most it allows), and the Crowd4Test admin's
 * PROFILE APPROVAL (this file). An application owner never approves a Crowd4Test profile. Wording: NOT APPROVED (a draft awaiting review).
 *
 * Expiry policy (approved): a Crowd4Test admin's approval lasts APPROVAL_VALID_DAYS from when it is
 * recorded, and stops counting at once when the application's target, scope, exclusions, request limit, saved sign-in, sensitive
 * workflows, environment, the approved profile's wording, or the sign-in details of an account it uses change (approvalFingerprint).
 * An approval recorded before the details fingerprint existed has no fingerprint and never counts again. The client's authorization: authorization.ts. Both are
 * judged on the server at start, at approval and when shown, and again while an assessment above passive runs: when it is claimed or
 * picked up again, before the external scanners and every few seconds while it runs (store.ts gateCheck, assessment/runner.ts).
 *
 * The same authorization also names the test accounts of the read-only cross-account checks (assessment/cross-account.ts); that step runs
 * only when both of its accounts are named there.
 *
 * Schema: module-owned, created on first use like the other security tables (no migration slot): two additive columns on
 * security_authorizations and one table of approvals. Kept in step with src/platform/pg/baseline.sql.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db, Row } from "../platform/db.js";
import { detailsFingerprint, expiryOf, scopeFingerprint } from "./authorization.js";
import { ASSESSMENT_KINDS, type AssessmentKind, type SecurityApplication } from "./contract.js";
import { readExtras } from "./extras.js";
import type { ScanApproval } from "./scanners/contract.js";
import { profileRefusal, rank, SCAN_PROFILES } from "./scanners/profiles.js";

export const PROFILE_APPROVALS_MIGRATION = `
CREATE TABLE IF NOT EXISTS security_profile_approvals (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES security_applications(id) ON DELETE CASCADE,
    profile TEXT NOT NULL,                    -- conservative-active | advanced
    environment TEXT NOT NULL,                -- the environment the application was marked with when it was approved
    approved_by_user_id TEXT,
    approved_by_name TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    statement TEXT NOT NULL,                  -- the exact sentence the approver confirmed
    withdrawn_at TEXT,
    withdrawn_by TEXT,
    details_fingerprint TEXT                  -- approvalFingerprint; NULL: recorded before it existed, never counts again
);
CREATE INDEX IF NOT EXISTS idx_sec_profile_approvals_app ON security_profile_approvals(application_id, profile);
`;

const ensured = new WeakSet<Db>();
export function ensureProfileGateTables(db: Db): void {
    if (ensured.has(db)) return;
    db.raw.exec(PROFILE_APPROVALS_MIGRATION);
    // Additive columns: an authorization recorded before them reads back as passive only, naming no cross-account test account.
    // The authorizing person's role and documented authority, and the details fingerprint (NULL on a record made before them:
    // it reads "not recorded", keeps its passive behaviour and never allows anything above passive).
    for (const [table, column, definition] of [
        ["security_authorizations", "max_profile", "TEXT NOT NULL DEFAULT 'passive'"],
        ["security_authorizations", "cross_accounts_json", "TEXT"],
        ["security_authorizations", "approver_role", "TEXT"],
        ["security_authorizations", "authority", "TEXT"],
        ["security_authorizations", "details_fingerprint", "TEXT"],
        ["security_profile_approvals", "details_fingerprint", "TEXT"],
    ] as const) {
        if (db.dialect.tableExists(db, table) && !db.dialect.columnExists(db, table, column)) {
            db.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    }
    ensured.add(db);
}

export const isAssessmentKind = (s: unknown): s is AssessmentKind => typeof s === "string" && (ASSESSMENT_KINDS as readonly string[]).includes(s);

/** The most an authorization allows, from its stored value: anything unreadable is passive. */
export const maxProfileOf = (raw: unknown): AssessmentKind => (isAssessmentKind(raw) ? raw : "passive");

/** The cross-account test accounts an authorization names, from its stored value. */
export function crossAccountsOf(raw: unknown): string[] {
    if (typeof raw !== "string" || !raw) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 2) : [];
    } catch {
        return [];
    }
}

export interface ProfileApproval {
    id: string;
    applicationId: string;
    profile: Exclude<AssessmentKind, "passive">;
    environment: string;
    approvedByUserId: string | null;
    approvedByName: string;
    approvedAt: string;
    statement: string;
    withdrawnAt: string | null;
    withdrawnBy: string | null;
    /** What it covers (approvalFingerprint); null when recorded before the details fingerprint existed (it never counts again). */
    detailsFingerprint: string | null;
    /** When it stops counting (APPROVAL_VALID_DAYS after it was recorded). */
    expiresAt: string;
}

const approvalOf = (r: Row): ProfileApproval => ({
    id: r.id,
    applicationId: r.application_id,
    profile: r.profile,
    environment: r.environment,
    approvedByUserId: r.approved_by_user_id ?? null,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at,
    statement: r.statement,
    withdrawnAt: r.withdrawn_at ?? null,
    withdrawnBy: r.withdrawn_by ?? null,
    detailsFingerprint: r.details_fingerprint ?? null,
    expiresAt: expiryOf(r.approved_at, APPROVAL_VALID_DAYS),
});

/** Approved: a Crowd4Test admin's profile approval lasts this many days from when it is recorded. */
export const APPROVAL_VALID_DAYS = 30;

const tableHas = (db: Db, table: string) => db.dialect.tableExists(db, table);

/**
 * The sign-in details of the accounts a record uses, as the platform holds them now (no secret is read: only what identifies the
 * credential). A test account counts by the version of the project's test-account list (any change to a test account's username,
 * password or secret changes it); the cross-account designation by its full content. A saved sign-in (cookies) is a refreshable session
 * of the account it names, not a credential: which account is used is already in the scope fingerprint, and saving or refreshing that
 * account's sign-in does not invalidate anything.
 */
export function credentialDetails(db: Db, app: Pick<SecurityApplication, "id" | "projectId">, accounts: readonly string[], withDesignation: boolean): unknown {
    const names = [...new Set(accounts.filter(Boolean))].sort();
    const testAccounts = names.some((a) => a !== "main") && tableHas(db, "project_roles") ? (db.get<{ updated_at: string }>("SELECT updated_at FROM project_roles WHERE project_id = ?", app.projectId)?.updated_at ?? null) : null;
    const designation = withDesignation && tableHas(db, "security_cross_account") ? (db.get<{ designation_json: string }>("SELECT designation_json FROM security_cross_account WHERE application_id = ?", app.id)?.designation_json ?? null) : null;
    return { accounts: names, testAccounts, designation };
}

type FingerprintApp = Pick<SecurityApplication, "id" | "projectId" | "environment" | "targetUrl" | "scope" | "excludedPaths" | "maxRequestsPerSecond" | "signInAccount" | "sensitiveWorkflows">;

/** The details fingerprint a client authorization allowing `maxProfile` and naming `crossAccounts` would have for the application now. */
export function authorizationFingerprint(db: Db, app: FingerprintApp, maxProfile: AssessmentKind, crossAccounts: readonly string[]): string {
    const accounts = [...(app.signInAccount ? [app.signInAccount] : []), ...crossAccounts];
    return detailsFingerprint({ environment: app.environment, profile: maxProfile, credentials: credentialDetails(db, app, accounts, crossAccounts.length > 0) });
}

/** The cross-account designation's two accounts, when one is set (read loosely: only the names matter here). */
function designatedAccounts(db: Db, appId: string): string[] {
    if (!tableHas(db, "security_cross_account")) return [];
    try {
        const d = JSON.parse(db.get<{ designation_json: string }>("SELECT designation_json FROM security_cross_account WHERE application_id = ?", appId)?.designation_json ?? "null");
        return [d?.accountA, d?.accountB].filter((x): x is string => typeof x === "string");
    } catch {
        return [];
    }
}

/** What an approval of `profile` covers for the application now: its scope fingerprint plus the environment, the profile and the accounts it uses. */
export function approvalFingerprint(db: Db, app: FingerprintApp, profile: AssessmentKind): string {
    const crossAccounts = designatedAccounts(db, app.id);
    const accounts = [...(app.signInAccount ? [app.signInAccount] : []), ...crossAccounts];
    const details = detailsFingerprint({ environment: app.environment, profile, credentials: credentialDetails(db, app, accounts, true) });
    return createHash("sha256").update(`${scopeFingerprint(app)}:${details}`).digest("hex");
}

export type ApprovalStateName = "current" | "expired" | "changed" | "withdrawn" | "not-admin" | "other-environment";

/** Whether this approval lets its profile start now, and the plain sentence for it (shown with the approval and used at start). */
export function approvalStateOf(db: Db, app: FingerprintApp, a: ProfileApproval, now = Date.now()): { state: ApprovalStateName; message: string } {
    const title = SCAN_PROFILES[a.profile].title;
    if (a.withdrawnAt != null) return { state: "withdrawn", message: `Withdrawn: ${a.withdrawnBy ?? "withdrawn"}` };
    if (a.environment !== app.environment) return { state: "other-environment", message: `Approved for ${a.environment}; the application is now marked ${app.environment}, so it no longer counts.` };
    if (now >= Date.parse(a.expiresAt)) return { state: "expired", message: GATE_WORDS.approvalExpired(title) };
    if (!a.detailsFingerprint || a.detailsFingerprint !== approvalFingerprint(db, app, a.profile)) return { state: "changed", message: GATE_WORDS.approvalChanged(title) };
    if (!isCrowd4TestAdminUser(db, a.approvedByUserId)) return { state: "not-admin", message: "The person who approved it is no longer a Crowd4Test admin, so it no longer counts." };
    return { state: "current", message: `Counts until ${a.expiresAt.slice(0, 10)}, unless withdrawn or the application's details change first.` };
}

/** Newest first. */
export function listApprovals(db: Db, appId: string): ProfileApproval[] {
    ensureProfileGateTables(db);
    return db.all(`SELECT * FROM security_profile_approvals WHERE application_id = ? ORDER BY approved_at DESC, ${db.dialect.insertionOrder()} DESC`, appId).map(approvalOf);
}

export function getApproval(db: Db, id: string): ProfileApproval | undefined {
    ensureProfileGateTables(db);
    const r = db.get("SELECT * FROM security_profile_approvals WHERE id = ?", id);
    return r ? approvalOf(r) : undefined;
}

/**
 * The approval that lets this profile start now: same profile, the application's current environment, not withdrawn, recorded within
 * APPROVAL_VALID_DAYS, for the application's details as they are now (approvalFingerprint), and recorded by someone who is still a
 * Crowd4Test admin (an approval whose approver has lost that role no longer counts). `problem` says why the newest one does not count.
 */
export function currentApproval(db: Db, app: FingerprintApp, profile: AssessmentKind, now = Date.now()): ProfileApproval | undefined {
    return approvalCheck(db, app, profile, now).approval;
}

export function approvalCheck(db: Db, app: FingerprintApp, profile: AssessmentKind, now = Date.now()): { approval?: ProfileApproval; problem?: "expired" | "changed" } {
    if (profile === "passive") return {};
    ensureProfileGateTables(db);
    const r = db.get(
        `SELECT * FROM security_profile_approvals WHERE application_id = ? AND profile = ? AND environment = ? AND withdrawn_at IS NULL ORDER BY approved_at DESC, ${db.dialect.insertionOrder()} DESC LIMIT 1`,
        app.id,
        profile,
        app.environment,
    );
    if (!r) return {};
    const a = approvalOf(r);
    const state = approvalStateOf(db, app, a, now).state;
    if (state === "current") return { approval: a };
    return state === "expired" || state === "changed" ? { problem: state } : {};
}

/**
 * Is this person a Crowd4Test admin (signed in through Crowd4Test, C4T role ADMIN), as the platform's people table knows them now? The
 * only people who may approve a profile above passive (approved policy): there is no fallback for a server without Crowd4Test
 * sign-in, for the open server or for an access key. The routes check the sign-in itself; the store and the start check this as well.
 * Only a person whose account is active counts. The C4T role is the one the people table holds, refreshed when that person signs in.
 */
export function isCrowd4TestAdminUser(db: Db, userId: string | null | undefined): boolean {
    if (!userId || !db.dialect.tableExists(db, "users")) return false;
    // A disabled person's approvals stop counting at once (disabling keeps their roles in place).
    return db.get<{ c4t_role: string | null }>("SELECT c4t_role FROM users WHERE id = ? AND role IS NOT NULL AND status = 'active'", userId)?.c4t_role === "ADMIN";
}

/** Records an approval; an earlier one of the same profile and environment that is still in force is withdrawn (replaced). Refused unless the approver is a Crowd4Test admin. */
export function addApproval(db: Db, appId: string, input: { profile: Exclude<AssessmentKind, "passive">; environment: string; statement: string; byUserId: string; byName: string }): ProfileApproval {
    ensureProfileGateTables(db);
    if (!isCrowd4TestAdminUser(db, input.byUserId)) throw new Error(GATE_WORDS.onlyAdmins);
    if (!ACTIVE_ENVIRONMENTS.includes(input.environment)) throw new Error(GATE_WORDS.wrongEnvironment(input.environment));
    const app = applicationRow(db, appId);
    if (!app) throw new Error(`Unknown application ${appId}`);
    if (app.environment !== input.environment) throw new Error(GATE_WORDS.wrongEnvironment(app.environment));
    const fingerprint = approvalFingerprint(db, app, input.profile);
    const id = randomUUID();
    const at = new Date().toISOString();
    db.tx(() => {
        db.run("UPDATE security_profile_approvals SET withdrawn_at = ?, withdrawn_by = ? WHERE application_id = ? AND profile = ? AND environment = ? AND withdrawn_at IS NULL", at, "Replaced by a newer approval.", appId, input.profile, input.environment);
        db.run(
            "INSERT INTO security_profile_approvals (id, application_id, profile, environment, approved_by_user_id, approved_by_name, approved_at, statement, details_fingerprint) VALUES (?,?,?,?,?,?,?,?,?)",
            id,
            appId,
            input.profile,
            input.environment,
            input.byUserId,
            input.byName.slice(0, 200),
            at,
            input.statement.slice(0, 2000),
            fingerprint,
        );
    });
    return getApproval(db, id)!;
}

/** The application as the fingerprints need it, read straight from its rows (the store's own reader lives in store.ts). */
function applicationRow(db: Db, appId: string): FingerprintApp | undefined {
    const r = db.get("SELECT id, project_id, environment, target_url, scope_json, excluded_paths_json, max_rps FROM security_applications WHERE id = ?", appId);
    if (!r) return undefined;
    const list = (raw: unknown): string[] => {
        try {
            const v = JSON.parse(String(raw ?? "[]"));
            return Array.isArray(v) ? v : [];
        } catch {
            return [];
        }
    };
    const x = readExtras(db, appId);
    return { id: r.id, projectId: r.project_id, environment: r.environment, targetUrl: r.target_url, scope: list(r.scope_json), excludedPaths: list(r.excluded_paths_json), maxRequestsPerSecond: r.max_rps, signInAccount: x.signInAccount, sensitiveWorkflows: x.sensitiveWorkflows };
}

export function withdrawApproval(db: Db, id: string, by: string): ProfileApproval | undefined {
    ensureProfileGateTables(db);
    db.run("UPDATE security_profile_approvals SET withdrawn_at = ?, withdrawn_by = ? WHERE id = ? AND withdrawn_at IS NULL", new Date().toISOString(), by.slice(0, 200), id);
    return getApproval(db, id);
}

/** The approval as the scanner layer keeps it with an assessment and its scan runs. */
export const scanApprovalOf = (a: ProfileApproval): ScanApproval => ({ profile: a.profile, approvedByUserId: a.approvedByUserId ?? "", approvedByName: a.approvedByName, approvedAt: a.approvedAt, environment: a.environment, statement: a.statement });

/** The sentence an approver confirms for a profile above passive. */
export function approvalStatement(profile: Exclude<AssessmentKind, "passive">, app: { name: string; targetUrl: string; environment: string }): string {
    const p = SCAN_PROFILES[profile];
    return `As a Crowd4Test admin, I approve the ${p.title} profile for “${app.name}” (${app.targetUrl}), marked as a ${app.environment} environment. This approval is separate from the client's authorization, which must also name this profile. ${p.description}`;
}

/** The only environments an assessment above passive ever runs against (approved policy). Production and "other" never. */
export const ACTIVE_ENVIRONMENTS: readonly string[] = ["development", "staging"];

export const GATE_WORDS = {
    wrongEnvironment: (environment: string) =>
        `Assessments above passive run only against an application marked as development or staging, and this one is marked “${environment}”. Only a passive assessment can start here.`,
    onlyAdmins: "Only a Crowd4Test admin can approve a profile above passive.",
    noCrowd4Test:
        "Only a Crowd4Test admin can approve a profile above passive, and this server has no Crowd4Test sign-in, so nobody can approve one here. Only passive assessments can start.",
    notAuthorized: (title: string) =>
        `The client's current authorization does not allow the ${title} profile, so it cannot start. Record a new authorization from the client that names the ${title} profile (or a higher one) as the most it allows.`,
    notApproved: (title: string, environment: string) => `The ${title} profile needs an approval for this ${environment} application before it may start. Ask a Crowd4Test admin to record one.`,
    switchedOff: "Assessments above passive are switched off on this server (SECURITY_ACTIVE_PROFILES). Only passive assessments can start here.",
    detailsNotRecorded:
        "The client's authorization was recorded without the authorizing person's role and documented authority, so it covers passive assessments only. Record a new authorization with those details before anything above passive.",
    approvalExpired: (title: string) => `The Crowd4Test admin's approval of the ${title} profile has expired: it lasts ${APPROVAL_VALID_DAYS} days from when it was recorded. Ask a Crowd4Test admin to record a new one.`,
    approvalChanged: (title: string) =>
        `The application's target, scope, exclusions, request limit, environment, saved sign-in, sensitive workflows, test-account sign-in details, cross-account designation or the ${title} profile's description changed after the Crowd4Test admin approved it, so that approval no longer counts. Ask a Crowd4Test admin to record a new one.`,
    authorizationReplaced: (title: string) =>
        `The client's authorization this assessment started under was replaced by a newer one, so the ${title} profile no longer runs under it. Start a new assessment if the current authorization allows it.`,
    approvalWithdrawn: (title: string) => `The Crowd4Test admin's approval of the ${title} profile was withdrawn.`,
    stopped: (why: string) => `Stopped, because what this assessment needs to run above passive no longer holds: ${why}`,
    approvalNeedsAuthorization: (title: string) =>
        `A Crowd4Test admin approves the ${title} profile only while the client's current authorization, recorded with the authorizing person's role and documented authority, allows it. Record that authorization first.`,
} as const;

/**
 * Why an assessment of this application may not start at this profile, or undefined when it may. Passive is never refused here (its
 * conditions are the ones it always had: a current authorization, checked by the start route).
 */
export function startRefusal(i: {
    kind: AssessmentKind;
    environment: string;
    authorizationMaxProfile: AssessmentKind;
    /** False when the authorization was recorded without the authorizing person's role and authority (passive only). Default true. */
    authorizationDetailsRecorded?: boolean;
    approval: ProfileApproval | undefined;
    /** Why the newest approval of this profile does not count (approvalCheck), for a plainer refusal. */
    approvalProblem?: "expired" | "changed";
    activeProfilesOn: boolean;
    crowd4testOn: boolean;
    /**
     * Why this machine cannot run scanners in an isolated network whose only way out is the request guard (egress/isolation.ts
     * egressIsolationProblem), or undefined when it can. The scanner orchestration proves the isolation again before any scanner runs.
     */
    egressIsolationProblem?: string;
}): string | undefined {
    if (i.kind === "passive") return undefined;
    const title = SCAN_PROFILES[i.kind].title;
    if (!ACTIVE_ENVIRONMENTS.includes(i.environment)) return GATE_WORDS.wrongEnvironment(i.environment);
    if (rank(i.authorizationMaxProfile) < rank(i.kind)) return GATE_WORDS.notAuthorized(title);
    if (i.authorizationDetailsRecorded === false) return GATE_WORDS.detailsNotRecorded;
    if (!i.crowd4testOn) return GATE_WORDS.noCrowd4Test;
    if (!i.approval && i.approvalProblem === "expired") return GATE_WORDS.approvalExpired(title);
    if (!i.approval && i.approvalProblem === "changed") return GATE_WORDS.approvalChanged(title);
    if (!i.approval) return GATE_WORDS.notApproved(title, i.environment);
    const own = profileRefusal(i.kind, i.environment, true);
    if (own) return own;
    // The server switch first (it is the server's policy, and true on any machine); then the network isolation check.
    if (!i.activeProfilesOn) return GATE_WORDS.switchedOff;
    if (i.egressIsolationProblem) return i.egressIsolationProblem;
    return undefined;
}

/** Why the cross-account step may not run under this authorization, or undefined when both of its accounts are named there. */
export function crossAccountConsentProblem(named: readonly string[], accountA: string, accountB: string, label: (a: string) => string): string | undefined {
    const missing = [accountA, accountB].filter((a) => !named.includes(a));
    if (!missing.length) return undefined;
    return `Cross-account checks were not made: the current authorization does not name ${missing.map(label).join(" and ")}. Record a new authorization that names the cross-account test accounts.`;
}
