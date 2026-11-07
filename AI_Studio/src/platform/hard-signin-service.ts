/**
 * Hard sign-ins on the platform side: "Sign in once yourself" browsers (one per project, in memory, like recordings), the "Still signed
 * in?" check, and what a job needs before it runs (the saved session for its tests and exploration, the test mailbox for email steps).
 */
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import type { Config } from "../config.js";
import { SignInCapture, type CaptureState } from "../engine/auth/capture.js";
import { checkStillSignedIn, type SignedInVerdict, type StorageState } from "../engine/auth/storage-state.js";
import type { EngineContext } from "../engine/context.js";
import type { ExecutionBatch, ExecutionEnv, ExecutionOptions, ScriptExecutor, ScriptRun } from "../engine/frameworks/types.js";
import { localExecutor } from "../engine/frameworks/executor.js";
import { SIGN_IN_BROWSER_REFUSED } from "./runner-only.js";
import type { MailSource } from "../engine/auth/mail.js";
import type { Db } from "./db.js";
import { HttpError } from "./http-error.js";
import { mailSourceFor } from "./mailbox/feed.js";
import { assertAllowedTarget } from "./net-guard.js";
import { SecretBox } from "./secrets.js";
import { MAIN_ACCOUNT, SessionStore, type PublicSession } from "./session-store.js";

export interface CaptureView extends CaptureState {
    id: string;
    account: string;
}

interface Active {
    id: string;
    projectId: string;
    account: string;
    appUrl: string;
    capture: SignInCapture;
}

export interface HardSignInOptions {
    /** Tests launch their own (headless) browser. */
    launch?: (headless: boolean) => Promise<Browser>;
    guard?: (url: string) => Promise<void>;
}

/** The words of the message a run stops with when the saved sign-in no longer works. */
export function signInAgainMessage(account: string, why: string): string {
    const who = account === MAIN_ACCOUNT ? "this project" : `the test account “${account}”`;
    return `The saved sign-in for ${who} no longer works (${why.replace(/\.$/, "")}). Sign in again under Test accounts, then run again. No test was run, so no result changed.`;
}

export class HardSignInService {
    private readonly active = new Map<string, Active>();

    constructor(
        private readonly store: SessionStore,
        private readonly opts: HardSignInOptions = {},
        /** False when the platform runs tests only on runners (EXECUTION_MODE=runners): capturing or checking a sign-in opens a browser here. */
        private readonly serverBrowser = true,
    ) {}

    static for(db: Db, config: Pick<Config, "dataDir" | "SECRET_KEY"> & Partial<Pick<Config, "EXECUTION_MODE">>, opts: HardSignInOptions = {}): HardSignInService {
        return new HardSignInService(new SessionStore(db, new SecretBox(config.dataDir, config.SECRET_KEY)), opts, config.EXECUTION_MODE !== "runners");
    }

    private refuseWithoutServerBrowser(): void {
        if (!this.serverBrowser) throw new HttpError(409, SIGN_IN_BROWSER_REFUSED, { cannotRunHere: true, executionMode: "runners" });
    }

    get sessions(): SessionStore {
        return this.store;
    }

    // ── "Sign in once yourself" ────────────────────────────────────────────

    startCapture(projectId: string, account: string, appUrl: string, startUrl: string, headed: boolean): CaptureView {
        this.refuseWithoutServerBrowser();
        const current = this.active.get(projectId);
        if (current && (current.capture.state().status === "open" || current.capture.state().status === "starting")) {
            throw new HttpError(409, "A sign-in browser is already open for this project. Save or cancel it first.");
        }
        const capture = new SignInCapture({ startUrl, headed, guard: this.opts.guard ?? assertAllowedTarget, ...(this.opts.launch ? { launch: this.opts.launch } : {}) });
        const a: Active = { id: randomUUID(), projectId, account, appUrl, capture };
        this.active.set(projectId, a);
        capture.start();
        return view(a);
    }

    capture(projectId: string): CaptureView | undefined {
        const a = this.active.get(projectId);
        return a ? view(a) : undefined;
    }

    /** The capture's browser (tests drive its page as the person). */
    captureHandle(projectId: string): SignInCapture | undefined {
        return this.active.get(projectId)?.capture;
    }

    async saveCapture(projectId: string): Promise<PublicSession> {
        const a = this.active.get(projectId);
        if (!a) throw new HttpError(404, "There is no sign-in browser open for this project.");
        let saved: { state: StorageState; checkUrl: string };
        try {
            saved = await a.capture.save();
        } catch (e) {
            throw new HttpError(409, e instanceof Error ? e.message : String(e));
        }
        // The check page must be on the application's own site: a sign-in that ended elsewhere is checked at the application's address.
        const checkUrl = sameOrigin(saved.checkUrl, a.appUrl) ? saved.checkUrl : a.appUrl;
        return this.store.saveSession(projectId, a.account, { state: saved.state, appUrl: a.appUrl, checkUrl, how: "browser" });
    }

    async cancelCapture(projectId: string): Promise<void> {
        const a = this.active.get(projectId);
        if (!a) return;
        await a.capture.cancel();
    }

    /** Platform shutdown: close every browser this service opened. */
    async dispose(): Promise<void> {
        await Promise.all([...this.active.values()].map((a) => a.capture.cancel().catch(() => undefined)));
    }

    // ── "Still signed in?" ─────────────────────────────────────────────────

    async check(projectId: string, account: string): Promise<SignedInVerdict & { session?: PublicSession }> {
        const s = this.store.sessionState(projectId, account);
        if (!s) throw new HttpError(404, "No sign-in is saved for this account.");
        this.refuseWithoutServerBrowser();
        const browser = await (this.opts.launch ?? ((headless) => chromium.launch({ headless })))(true);
        try {
            const v = await checkStillSignedIn(browser, s.state, s.row.checkUrl);
            if (!v.unreachable) this.store.recordCheck(projectId, account, v.signedIn, v.reason);
            return { ...v, session: this.store.publicSession(projectId, account) };
        } finally {
            await browser.close().catch(() => undefined);
        }
    }
}

function view(a: Active): CaptureView {
    return { id: a.id, account: a.account, ...a.capture.state() };
}

const sameOrigin = (a: string, b: string) => {
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
};

// ── what a job does before it runs ───────────────────────────────────────────

/** A script signs in by itself (it types the stored password or a one-time code): it starts signed out, as before. */
export const signsInByItself = (content: string): boolean =>
    /process\.env\.TEST_[A-Z0-9_]*(PASSWORD|TOTP_SECRET)\b/.test(content) ||
    // Access checks open pages as a visitor and as named accounts: they must never start signed in as the project.
    content.includes("await accessAssert(");

/**
 * Wraps the job's executor: Playwright runs against the session's own site start signed in (scripts that sign in by themselves, code
 * tests and other sites excepted), and email steps are answered from the project's test mailbox. Nothing changes for a project that
 * has neither.
 */
export class HardSignInExecutor implements ScriptExecutor {
    readonly name: string;
    readonly remote?: boolean;

    constructor(
        private readonly inner: ScriptExecutor,
        private readonly session: { state: StorageState; appUrl: string } | undefined,
        private readonly mail: MailSource | undefined,
    ) {
        this.name = inner.name;
        if (inner.remote) this.remote = true;
    }

    execute(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        const sessionApplies = this.session && sameOrigin(env.run.baseUrl, this.session.appUrl);
        const scripts = sessionApplies ? batch.scripts.map((s) => (s.custom || signsInByItself(s.content) ? s : { ...s, session: true })) : batch.scripts;
        const runEnv = sessionApplies && scripts.some((s) => s.session) ? { ...env.run, storageState: JSON.stringify(this.session!.state) } : env.run;
        return this.inner.execute(adapterId, { ...batch, scripts }, { ...env, run: runEnv }, this.mail && !this.inner.remote ? { ...opts, mail: this.mail } : opts);
    }
}

export interface JobSignIn {
    /** The run must not start: the saved sign-in no longer works (a plain sentence for the job). */
    stop?: string;
    /** For exploration: start the browser signed in and skip the form sign-in. */
    savedSession?: { storageState: StorageState; landingUrl: string };
}

/**
 * Before a job runs: when the project has a saved sign-in for its own account on the job's site, check it ("Still signed in?") and
 * either stop the job with a plain message (nothing has run, so no verdict changes) or wrap the executor so its tests start signed in.
 * A project with a test mailbox gets email steps answered. `checkBrowser` lets tests pass their own browser launcher.
 */
export async function prepareJobSignIn(ctx: EngineContext, db: Db, config: Pick<Config, "dataDir" | "SECRET_KEY"> & Partial<Pick<Config, "EXECUTION_MODE">>, projectId: string, appUrl: string, o: { launch?: (headless: boolean) => Promise<Browser> } = {}): Promise<JobSignIn> {
    let store: SessionStore;
    try {
        store = new SessionStore(db, new SecretBox(config.dataDir, config.SECRET_KEY));
    } catch {
        return {};
    }
    const mail = mailSourceFor(store, projectId);
    const saved = store.sessionState(projectId, MAIN_ACCOUNT);
    const applies = saved && sameOrigin(saved.row.appUrl, appUrl);
    let session: { state: StorageState; appUrl: string } | undefined;
    if (saved && applies) {
        const expires = saved.row.expiresAt ? Date.parse(saved.row.expiresAt) : undefined;
        if (expires !== undefined && expires <= Date.now()) {
            const why = "its cookies ran out";
            store.recordCheck(projectId, MAIN_ACCOUNT, false, why);
            return { stop: signInAgainMessage(MAIN_ACCOUNT, why) };
        }
        if (config.EXECUTION_MODE === "runners") {
            // This server opens no browser (runner-only.ts): the sign-in is not checked first. It goes to the runner as it is, and a test that finds it expired fails and says so.
            ctx.emit({ stage: "orchestration", kind: "sign_in_unchecked", level: "warn", message: "The saved sign-in was not checked before the run: tests run only on runners here, and the platform opens no browser of its own. It goes to the runner with the tests." });
            session = { state: saved.state, appUrl: saved.row.appUrl };
        }
    }
    if (saved && applies && !session) {
        const browser = await (o.launch ?? ((headless) => chromium.launch({ headless })))(true);
        let v: SignedInVerdict;
        try {
            v = await checkStillSignedIn(browser, saved.state, saved.row.checkUrl);
        } finally {
            await browser.close().catch(() => undefined);
        }
        if (v.unreachable) {
            // The application could not be opened: the run goes ahead and its tests say what is wrong; the session is not blamed.
            ctx.emit({ stage: "orchestration", kind: "sign_in_unchecked", level: "warn", message: `The saved sign-in could not be checked: ${v.reason}` });
        } else {
            store.recordCheck(projectId, MAIN_ACCOUNT, v.signedIn, v.reason);
            if (!v.signedIn) return { stop: signInAgainMessage(MAIN_ACCOUNT, v.reason) };
            ctx.emit({ stage: "orchestration", kind: "sign_in_saved_session", message: "Tests start signed in with the saved sign-in (tests that sign in by themselves start signed out)." });
        }
        session = { state: saved.state, appUrl: saved.row.appUrl };
    }
    const inner = ctx.executor ?? localExecutor;
    if (session || mail) ctx.executor = new HardSignInExecutor(inner, session, mail);
    if (session && inner.remote) ctx.emit({ stage: "orchestration", kind: "sign_in_runner", message: "The saved sign-in goes to the runner with the tests (encrypted like the other sign-in details)." });
    if (mail && inner.remote) ctx.emit({ stage: "orchestration", kind: "mailbox_runner", level: "warn", message: "Email steps cannot run on a runner: the test mailbox is read by the platform. Tests with an email step will fail with that message." });
    return session ? { savedSession: { storageState: session.state, landingUrl: saved!.row.checkUrl } } : {};
}
