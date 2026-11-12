/**
 * Round 20 (SIGN): signed-in assessments. The application names one of the project's saved sign-ins ("main" = the project's own, or a
 * test account's): the browser storage state a person saved after signing in by hand (src/platform/session-store.ts, hard sign-ins).
 *
 * What this file guarantees:
 *  - no password is ever read or typed: only the saved storage state (cookies and local storage) is used, decrypted for the assessment
 *    only, and only the parts that belong to hosts in the authorized scope;
 *  - a missing, expired or unreadable saved sign-in never stops the assessment: it carries on signed out and the coverage says why in
 *    plain words ("Signed-in pages were not inspected: the saved sign-in for … has expired. Sign in again in Settings.");
 *  - cookies for plain requests (`cookieHeaderFor`) follow the browser's rules: host-only cookies to their own host, domain cookies to the
 *    domain and its subdomains, path and Secure respected, expired ones dropped; the scope guard decides whether the request is sent at
 *    all and drops cookies on a redirect to another origin;
 *  - sign-out addresses and links are never followed (`isSignOut`);
 *  - every cookie and storage value is scrubbed from whatever the assessment keeps (`scrubSecrets`), on top of FIND's redaction.
 */
import type { Config } from "../config.js";
import { secretValuesOf, type StorageState } from "../engine/auth/storage-state.js";
import type { Db } from "../platform/db.js";
import { IdentityStore } from "../platform/identity-store.js";
import { SecretBox } from "../platform/secrets.js";
import { ACCOUNT_NAME, MAIN_ACCOUNT, SessionStore, type PublicSession } from "../platform/session-store.js";
import { signInLabel } from "./authorization.js";
import type { SecurityApplication } from "./contract.js";
import { inScope } from "./scope.js";

export { signInLabel };
// The pure rules (also used by an assessment on a runner, which has none of the platform's storage): signin-rules.ts.
export { cookieHeaderFor, isSignOut, judgeSignedInPage, scrubSecrets, SIGN_OUT_REASON } from "./signin-rules.js";
import { isSignOut } from "./signin-rules.js";

type SecretSource = Pick<Config, "dataDir" | "SECRET_KEY">;
type ScopeFields = Pick<SecurityApplication, "targetUrl" | "scope" | "excludedPaths">;

// ── the choices and their state (for the API) ──────────────────────────────────────────────────────────────────────────────────────

export type SignInState = "ready" | "not-checked" | "expired" | "missing" | "other-site" | "unreadable";

export interface SignInStatus {
    account: string;
    label: string;
    state: SignInState;
    /** One plain sentence for the page. */
    message: string;
    savedAt: string | null;
    expiresAt: string | null;
    /** Origin the sign-in was saved for (never a cookie or a value). */
    site: string | null;
}

function sessionsOf(db: Db, cfg: SecretSource): SessionStore | undefined {
    try {
        return new SessionStore(db, new SecretBox(cfg.dataDir, cfg.SECRET_KEY));
    } catch {
        return undefined;
    }
}

/** "main" plus the project's test accounts (names only). */
export function accountNames(db: Db, cfg: SecretSource, projectId: string): string[] {
    try {
        return [MAIN_ACCOUNT, ...new IdentityStore(db, new SecretBox(cfg.dataDir, cfg.SECRET_KEY)).get(projectId).map((r) => r.name)];
    } catch {
        return [MAIN_ACCOUNT];
    }
}

const originOf = (raw: string): string | null => {
    try {
        return new URL(raw).origin;
    } catch {
        return null;
    }
};

/** Would anything of this session be used for this application (its site, or a cookie for a host in scope)? */
function sessionFits(session: PublicSession, app: ScopeFields): boolean {
    const site = originOf(session.appUrl);
    if (site && inScope(site, app).ok) return true;
    return false;
}

function statusOf(account: string, session: PublicSession | undefined, unreadable: boolean, app: ScopeFields | undefined): SignInStatus {
    const label = signInLabel(account);
    const base = { account, label, savedAt: session?.savedAt ?? null, expiresAt: session?.expiresAt ?? null, site: session ? originOf(session.appUrl) : null };
    if (unreadable) return { ...base, state: "unreadable", message: `The saved sign-in for ${label} could not be read (the platform's secret key changed). Sign in again in Settings.` };
    if (!session) return { ...base, state: "missing", message: `No sign-in is saved for ${label}. Save one in Settings (Test accounts, Saved sign-ins) or upload one here; until then the assessment visits signed out.` };
    if (session.state === "expired") return { ...base, state: "expired", message: `The saved sign-in for ${label} has expired. Sign in again in Settings.` };
    if (app && !sessionFits(session, app)) return { ...base, state: "other-site", message: `The saved sign-in for ${label} was saved for ${base.site ?? "another site"}, which is outside this application's scope, so it is not used.` };
    if (session.state === "unknown") return { ...base, state: "not-checked", message: `The assessment loads the saved sign-in for ${label}. It has not been checked yet and its cookies give no end date.` };
    return { ...base, state: "ready", message: `The assessment loads the saved sign-in for ${label}${session.expiresAt ? ` (its cookies run until ${session.expiresAt.slice(0, 10)})` : ""}.` };
}

/** The state of one account's saved sign-in, judged for an application (or in general without one). Never a value. */
export function signInStatus(db: Db, cfg: SecretSource, projectId: string, account: string, app?: ScopeFields): SignInStatus {
    const store = sessionsOf(db, cfg);
    const exists = db.get("SELECT 1 AS x FROM saved_sessions WHERE project_id = ? AND account = ?", projectId, account) !== undefined;
    const session = store?.publicSession(projectId, account);
    return statusOf(account, session, exists && !session, app);
}

/** Every account the project could sign in as, with the state of its saved sign-in. */
export function signInChoices(db: Db, cfg: SecretSource, projectId: string, app?: ScopeFields): SignInStatus[] {
    const saved = db.all<{ account: string }>("SELECT account FROM saved_sessions WHERE project_id = ? ORDER BY account", projectId).map((r) => r.account);
    const names = [...new Set([...accountNames(db, cfg, projectId), ...saved])].filter((n) => ACCOUNT_NAME.test(n));
    return names.map((n) => signInStatus(db, cfg, projectId, n, app));
}

// ── for the assessment ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ResolvedSignIn {
    account: string;
    label: string;
    /** The saved state limited to hosts in scope; undefined when the assessment visits signed out. */
    state?: StorageState;
    /** The signed-in page the person was on when saving (opened first, and judged: still signed in?). */
    checkUrl?: string;
    /** Why it is not used (a full coverage sentence), when it is not. */
    problem?: string;
    /** Every cookie and storage value of the WHOLE saved state (scrubbed from whatever the assessment keeps). */
    secrets: string[];
}

/** Only the cookies and local storage of hosts in the authorized scope go into the assessment's browser. */
export function limitToScope(state: StorageState, app: ScopeFields): StorageState {
    let target: URL | undefined;
    try {
        target = new URL(app.targetUrl);
    } catch {
        target = undefined;
    }
    const candidates = (domain: string): string[] => {
        const host = domain.replace(/^\./, "");
        const list = [`https://${host}/`, `http://${host}/`];
        if (target?.port) list.push(`${target.protocol}//${host}:${target.port}/`);
        return list;
    };
    const fits = (domain: string) => candidates(domain).some((u) => inScope(u, { ...app, excludedPaths: [] }).ok);
    return {
        cookies: state.cookies.filter((c) => fits(c.domain)),
        origins: state.origins.filter((o) => inScope(o.origin, { ...app, excludedPaths: [] }).ok),
    };
}

/** What the assessment loads for an application: the saved state (limited to the scope), or the plain reason it visits signed out. */
export function resolveSignIn(db: Db, cfg: SecretSource, app: SecurityApplication): ResolvedSignIn | undefined {
    const account = app.signInAccount;
    if (!account) return undefined;
    const label = signInLabel(account);
    const store = sessionsOf(db, cfg);
    const saved = store?.sessionState(app.projectId, account);
    const status = signInStatus(db, cfg, app.projectId, account, app);
    const secrets = saved ? secretValuesOf(saved.state) : [];
    const notInspected = (why: string) => ({ account, label, problem: `Signed-in pages were not inspected: ${why}`, secrets });
    if (status.state === "unreadable") return notInspected(`the saved sign-in for ${label} could not be read (the platform's secret key changed). Sign in again in Settings.`);
    if (!saved || status.state === "missing") return notInspected(`no sign-in is saved for ${label}. Save one in Settings (Test accounts, Saved sign-ins).`);
    if (status.state === "expired") return notInspected(`the saved sign-in for ${label} has expired. Sign in again in Settings.`);
    if (status.state === "other-site") return notInspected(`the saved sign-in for ${label} belongs to ${status.site ?? "another site"}, outside this application's scope.`);
    const state = limitToScope(saved.state, app);
    const now = Date.now() / 1000;
    state.cookies = state.cookies.filter((c) => c.expires <= 0 || c.expires > now);
    if (!state.cookies.length && !state.origins.length) return notInspected(`the saved sign-in for ${label} holds nothing for the hosts in this application's scope.`);
    const checkUrl = saved.row.checkUrl && inScope(saved.row.checkUrl, app).ok && !isSignOut(saved.row.checkUrl) ? saved.row.checkUrl : undefined;
    return { account, label, state, ...(checkUrl ? { checkUrl } : {}), secrets };
}

