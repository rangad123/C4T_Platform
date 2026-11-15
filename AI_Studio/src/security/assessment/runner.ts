/**
 * The passive assessment job: its own loop (not the functional job runner), following the platform Worker's pattern: claim with a lease,
 * renew it while working (heartbeat), give it up when another loop holds it, and pick up an assessment whose loop died (restart-safe).
 *
 *   QUEUED → DISCOVERING → SCANNING → VALIDATING → GENERATING_REPORT → COMPLETED | PARTIALLY_COMPLETED
 *                                                            any step → FAILED (plain reason) | CANCELLED (cancel, emergency stop)
 *
 * Restart safety: what discovery saw and what the scan judged are kept in the assessment's work data, so a restarted loop continues
 * from the last finished step instead of sending the requests again. Ingest is idempotent per assessment. An assessment interrupted
 * three times fails with that reason.
 *
 * Cancel and the emergency stop set `cancel_requested`; the loop checks it every second, aborts (which closes the browser it opened),
 * judges what it had already seen (judging sends nothing) so it is kept, and ends CANCELLED. The time limit works the same way and ends
 * PARTIALLY_COMPLETED with the reason.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../../platform/db.js";
import type { SecurityApplication, SecurityAssessment, SensitiveWorkflow } from "../contract.js";
import { ingest, retestTargets, type RawResult } from "../findings/ingest.js";
import { buildReport } from "../findings/report.js";
import type { SecuritySettings } from "../settings.js";
import { SecurityStore } from "../store.js";
import { emptyDiscovery, SIGN_IN_RECHECK_EVERY, type DiscoverOptions } from "./discover.js";
import type { ScanStepOutcome } from "./scan.js";
import type { DiscoveryResult, Guard } from "./types.js";
import { probe, type AssessmentOnRunnerOutcome, type AssessmentOnRunnerRequest, type ProbeProgress, type ProbeRequest } from "./probe.js";
import { apiDocumentText, sensitivePrefixes } from "../extras.js";
import { cookieHeaderFor, scrubSecrets, type ResolvedSignIn } from "../signin.js";
import type { GuardSignIn } from "./guard.js";
import { apiDocumentCoverage, requestDocumentOperations } from "./api-operations.js";
import type { ScanIntensity, ScannerAdapter } from "../scanners/contract.js";
import { scannerCoverageLines, runScanners } from "../scanners/orchestration/run.js";
import { savePlatformRequests, supersedeScannerRuns } from "../scanners/store.js";
import { mergeRequestLogs, type StoredRequestLog } from "../egress/request-log.js";
import type { ScannerSettings } from "../scanners/settings.js";
import { readDesignation } from "../cross-account-store.js";
import { crossAccountConsentProblem, GATE_WORDS } from "../profile-gate.js";
import { egressIsolationProblem } from "../egress/isolation.js";
import { signInLabel } from "../authorization.js";
import { CROSS_ACCOUNT_NOT_ON_RUNNER, environmentProblem, runCrossAccount, type Designation, type Identity } from "./cross-account.js";

export const LEASE_MS = 60_000;
/** How often the loop renews its lease and looks for a cancel request. */
export const TICK_MS = 1_000;
const RENEW_EVERY_TICKS = 5;
export const MAX_ATTEMPTS = 3;

export interface AssessmentLimits {
    maxPages: number;
    maxDepth: number;
    maxPerPattern: number;
    /** Time limit of one assessment in ms (default: the SECURITY_ASSESSMENT_MINUTES setting). */
    timeoutMs: number;
    retries: number;
    /** Round 21: a signed-in assessment checks every this many pages (and before the read-only checks) that the saved sign-in still works. */
    signInCheckEvery: number;
}

export const DEFAULT_LIMITS: Omit<AssessmentLimits, "timeoutMs"> = { maxPages: 30, maxDepth: 3, maxPerPattern: 5, retries: 2, signInCheckEvery: SIGN_IN_RECHECK_EVERY };

export interface RunnerDeps {
    db: Db;
    settings: SecuritySettings;
    headless: boolean;
    /** The scope guard for one assessment (rate limit and request budget are per assessment). `signIn`: round 20, signed-in assessments. */
    guardFor(app: SecurityApplication, signal: AbortSignal, signIn?: GuardSignIn): Guard;
    /** Round 20 (SIGN): the saved sign-in the application names, decrypted and limited to the scope (or the plain reason it is not used). */
    signInFor?(app: SecurityApplication): ResolvedSignIn | undefined;
    /** Audit + Activity for the assessment's end (CORE's recordSecurityEvent). Failures here never reach the assessment. */
    onFinished?(a: SecurityAssessment, app: SecurityApplication | undefined): void;
    limits?: Partial<AssessmentLimits>;
    /**
     * Additive (SCAN): the external scanner layer. Absent on a platform with no scanner configured, and then no scanner stage runs at
     * all and the assessment behaves exactly as it did before. Present means: run the scanners this project allows at this profile.
     */
    scanners?: {
        settings?: ScannerSettings;
        /** The saved sign-in presented to a scanner as one header. Never logged, never in evidence. */
        authHeader?: { name: string; value: string } | null;
        /** The AI interface a client configured, if any. Without it the AI scanner refuses to run. */
        aiInterface?: { kind: "http-chat" | "openai-compatible"; url: string; model?: string | null; messageTemplate?: string | null } | null;
        /** For tests: which adapters to use instead of building them. */
        adapters?: ScannerAdapter[];
        log?(event: string, data: Record<string, unknown>): void;
    };
    /**
     * Round 52, EXECUTION_MODE=runners: the steps that touch the application (probe.ts) run on the starter's runner instead of here
     * (on-runner.ts). Resolves with what the runner found; rejects with the plain reason it could not, or once `signal` ends it. The task
     * is stopped then, unless `keepTask` says the platform is only stopping (the next loop picks the same task up).
     */
    /** Round 52: the external scanners were left out because the steps run on a runner: this sentence goes in the coverage list. */
    scannersLeftOut?: string;
    onRunner?(o: {
        assessment: SecurityAssessment;
        ownerId: string | null;
        request: Omit<AssessmentOnRunnerRequest, "settings">;
        secrets: string[];
        signal: AbortSignal;
        keepTask(): boolean;
        update(patch: ProbeProgress): void;
    }): Promise<AssessmentOnRunnerOutcome>;
    /**
     * What the start gate needs from the platform (store.ts gateCheck), checked again when an assessment is claimed or picked up, before
     * the external scanners and while it runs. Absent: no Crowd4Test sign-in, so nothing above passive goes on.
     */
    gate?: { activeProfilesOn: boolean; crowd4testOn: boolean; isolationProblem: () => string | undefined };
    /** For tests: how the browser is started. */
    launch?: DiscoverOptions["launch"];
    log?(event: string, data: Record<string, unknown>): void;
}

/** RUN's scratch data kept with the assessment (bounded by the discovery caps). Never shown as it is. */
interface WorkData {
    attempts: number;
    /** Round 52 (runners mode): the person who started it (a users.id): its steps run on their runner. Set when it is created. */
    ownerId?: string | null;
    discovery?: DiscoveryResult;
    discoveryDone?: boolean;
    scan?: { results: RawResult[]; outcomes: ScanStepOutcome[]; capReached: boolean; requested: number };
    /**
     * Additive (SCAN): what the external scanners did. Kept in the assessment's own work data so a restarted loop does not run a
     * scanner twice, and so a cancelled assessment can report exactly which tool had finished and which had not.
     */
    scanners?: { results: RawResult[]; lines: string[]; failed: number; ran: string[]; notes?: string[] };
    /** The read-only cross-account step (cross-account.ts), when the application has a designation. `ran`: false when it was refused. */
    crossAccount?: { results: RawResult[]; lines: string[]; ran: boolean };
    /** The steps' request log (probe.ts), added up over restarts; stored beside the scanners' when the steps end. */
    requestLog?: StoredRequestLog;
    ingested?: boolean;
}

type StopReason = "cancel" | "unauthorized" | "timeout" | "lease";

/** Round 20 (SIGN): what the coverage list says about the sign-in and the sensitive workflows. */
export interface CoverageContext {
    signIn?: { label: string; used: boolean; problem?: string };
    sensitive?: SensitiveWorkflow[];
}

/** The application as the scope guard sees it: its sensitive workflows are excluded like its excluded paths. */
export function withSensitiveExclusions(app: SecurityApplication): SecurityApplication {
    const extra = sensitivePrefixes(app.sensitiveWorkflows);
    return extra.length ? { ...app, excludedPaths: [...new Set([...app.excludedPaths, ...extra])] } : app;
}

/** How many gate checks in a row may fail (throw) while a run goes on, before the run is stopped: about 15 seconds. */
export const GATE_CHECK_FAILURES = 3;
export const GATE_UNCHECKED_WORDS = "Stopped because the conditions this assessment needs to keep running (a current authorization and, above passive, a current approval) could not be checked for several seconds in a row.";
const UNAUTHORIZED_WORDS = "Stopped because the authorization is no longer current (it was revoked, or the target, scope, exclusions, request limit, saved sign-in or sensitive workflows changed).";

/** Structured, secret-free log lines (ids, states, counts: never addresses with queries, headers or bodies). */
function defaultLog(event: string, data: Record<string, unknown>): void {
    if (process.env.VITEST) return;
    console.log(JSON.stringify({ at: new Date().toISOString(), module: "security-assessment", event, ...data }));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const first = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

/**
 * Round 21: the coverage sentence for a saved sign-in that stopped working during the assessment: from which point nothing more was
 * inspected signed in, and what to do. The assessment never signs in again by itself.
 */
export function signInEndedSentence(label: string, e: NonNullable<DiscoveryResult["signInEnded"]>): string {
    const what = e.url ? `the signed-in page ${e.url} ${e.reason}` : e.reason;
    const lastWorked = e.lastOkAfterPages > 0 && e.lastOkAfterPages < e.afterPages ? `; it last worked after ${plural(e.lastOkAfterPages, "page")}` : "";
    const never = "It was not signed in again: no password was typed and no form was submitted.";
    if (e.when === "before-checks") {
        // Found only by the check before the read-only checks: pages after the last good check may have been seen signed out.
        const pages =
            e.afterPages === 0 || e.lastOkAfterPages >= e.afterPages
                ? ""
                : e.lastOkAfterPages > 0
                  ? ` Pages after the first ${plural(e.lastOkAfterPages, "page")} may have been looked at signed out.`
                  : ` Some of the ${plural(e.afterPages, "page")} may have been looked at signed out.`;
        return `The saved sign-in for ${label} no longer worked when the read-only checks started (${what}${lastWorked}); the read-only checks were made signed out.${pages} Save the sign-in again in Settings. ${never}`;
    }
    return `The saved sign-in for ${label} stopped working after ${plural(e.afterPages, "page")} (${what}${lastWorked}); signed-in pages after that were not inspected. Save the sign-in again in Settings. ${never}`;
}

/** The plain "what was not inspected" list: never presents the assessment as complete when it was not. */
export function notInspected(d: DiscoveryResult, outcomes: ScanStepOutcome[], extra: string[], limits: Pick<AssessmentLimits, "maxPages" | "maxDepth">, ctx: CoverageContext = {}): string[] {
    const out: string[] = [...extra];
    // Round 20 (SIGN): signed in with a saved sign-in, or why not.
    const signed = ctx.signIn;
    if (signed?.problem) out.push(signed.problem);
    else if (signed?.used && d.signedInCheck && !d.signedInCheck.ok)
        out.push(`Signed-in pages may not have been inspected: with the saved sign-in for ${signed.label}, the signed-in page ${d.signedInCheck.url} ${d.signedInCheck.reason}. Sign in again in Settings.`);
    else if (signed?.used && d.signInEnded) out.push(signInEndedSentence(signed.label, d.signInEnded));
    else if (signed?.used) out.push(`Signed in with the saved sign-in for ${signed.label}: pages behind the sign-in that are linked from the pages seen were looked at read-only. No password was typed and no form was submitted.`);
    else
        out.push(
            d.signInSeen
                ? "Signed-in areas: a sign-in form was seen and no account was given, so pages behind sign-in were not inspected."
                : "Signed-in areas: the assessment visits as an anonymous visitor, so pages that need signing in were not inspected.",
        );
    if (d.signOutSkipped?.length) out.push(`Sign-out links were not followed, so the session was not ended: ${d.signOutSkipped.slice(0, 8).join(", ")}${d.signOutSkipped.length > 8 ? ", …" : ""}.`);
    for (const w of ctx.sensitive ?? []) out.push(`Sensitive workflow “${w.name}” (${w.pathPrefixes.join(", ")}) was never requested${w.note ? `: ${w.note}` : "."}`);
    if (d.apiDocument) out.push(apiDocumentCoverage(d.apiDocument));
    if (d.notVisited > 0) out.push(`${plural(d.notVisited, "page")} found were not visited because of the limits (at most ${limits.maxPages} pages, ${limits.maxDepth} links deep, a few pages per address pattern) or because they look like sign-out or delete links.`);
    if (d.excluded.length) out.push(`Excluded paths were not requested: ${d.excluded.slice(0, 8).join(", ")}${d.excluded.length > 8 ? ", …" : ""}.`);
    if (d.outOfScope.length) out.push(`${plural(d.outOfScope.length, "address", "addresses")} outside the authorized scope were seen and not requested, for example ${d.outOfScope.slice(0, 3).map((o) => o.url).join(", ")}.`);
    if (d.blockedWrites.length) out.push(`${plural(d.blockedWrites.length, "request")} that the pages' own scripts tried to send and that could change data (for example ${d.blockedWrites[0]!.method} ${d.blockedWrites[0]!.url}) were blocked, so what they do was not inspected.`);
    if (d.forms.length) out.push(`${plural(d.forms.length, "form")} were recorded (field names and types only) and never submitted, so what happens after submitting them was not inspected.`);
    if (d.apiSpec && "operations" in d.apiSpec) out.push(`The API document lists ${plural(d.apiSpec.operations, "operation")}; it was read, and none of them was called.`);
    if (d.apiSpec && "skipped" in d.apiSpec) out.push(`The API document was not read: ${d.apiSpec.skipped}`);
    if (d.failures.length) out.push(`${plural(d.failures.length, "page")} could not be loaded: ${d.failures.slice(0, 3).map((f) => `${f.url} (${f.reason})`).join("; ")}.`);
    for (const o of outcomes) if (o.reason) out.push(o.ok ? o.reason : `${o.step}: ${o.reason}`);
    out.push("Only passive checks were made: no attack payloads, no form submissions, no sign-in attempts. Problems that only show under attack (injection, broken access control, logic flaws) are not covered.");
    return out.map((s) => s.slice(0, 500)).slice(0, 40);
}

/**
 * The loop. `start()` runs it in the background; `stop()` waits for the current assessment to give up its lease (it is picked up again
 * by the next loop that starts: restart-safe).
 */
export class AssessmentLoop {
    private running = false;
    private timer?: NodeJS.Timeout;
    private current?: Promise<void>;
    private wake?: () => void;
    private readonly owner = `security-${randomUUID()}`;
    private readonly store: SecurityStore;
    private stopping?: AbortController;

    constructor(
        private readonly deps: RunnerDeps,
        private readonly pollMs = 1_500,
    ) {
        this.store = new SecurityStore(deps.db);
    }

    get leaseOwner(): string {
        return this.owner;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.stopping = new AbortController();
        void this.loop();
    }

    /** Look for work now (a new assessment was queued). */
    poke(): void {
        this.wake?.();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.stopping?.abort();
        if (this.timer) clearTimeout(this.timer);
        this.wake?.();
        await this.current?.catch(() => undefined);
    }

    private async loop(): Promise<void> {
        while (this.running) {
            try {
                const a = this.store.claimAssessment(this.owner, LEASE_MS);
                if (a) {
                    this.current = this.runOne(a.id);
                    await this.current;
                    continue;
                }
            } catch (err) {
                (this.deps.log ?? defaultLog)("loop-error", { error: first(err) });
            }
            await new Promise<void>((resolve) => {
                this.wake = resolve;
                this.timer = setTimeout(resolve, this.pollMs);
            });
        }
    }

    /** Run one claimed assessment to its end (or until the lease is lost / the loop stops). Never throws. */
    async runOne(id: string): Promise<void> {
        const { store } = this;
        const log = this.deps.log ?? defaultLog;
        const a = store.getAssessment(id);
        if (!a) return;
        const app = store.getApplication(a.applicationId);
        const limits: AssessmentLimits = { ...DEFAULT_LIMITS, timeoutMs: this.deps.settings.assessmentMinutes * 60_000, ...this.deps.limits };
        const work: WorkData = { attempts: 0, ...(store.getWorkData<WorkData>(id) ?? {}) };
        work.attempts++;
        // Round 20 (SIGN): every value of the saved sign-in is scrubbed from the work data before it is stored (and from the results).
        let secrets: string[] = [];
        const scrub = () => {
            if (!secrets.length) return;
            if (work.discovery) Object.assign(work.discovery, scrubSecrets(work.discovery, secrets));
            if (work.scan) work.scan = scrubSecrets(work.scan, secrets);
        };
        const save = () => {
            scrub();
            store.setWorkData(id, work);
        };
        save();

        const abort = new AbortController();
        let cov: CoverageContext = {};
        let reason: StopReason | undefined;
        /** Above passive: the plain sentence when the start gate no longer holds (it replaces the passive "unauthorized" words). */
        let gateWords: string | undefined;
        const stopFor = (r: StopReason) => {
            if (!reason) reason = r;
            abort.abort();
        };
        // The whole start gate, judged now (store.ts gateCheck): for passive a current authorization, as always; above passive also the
        // authorization it started under, its profile, a current Crowd4Test admin approval, the environment, the switch and the isolation.
        const gate = this.deps.gate ?? { activeProfilesOn: this.deps.settings.activeProfiles === true, crowd4testOn: false, isolationProblem: () => egressIsolationProblem() };
        const gateNow = (): string | undefined => {
            const cur = store.getApplication(a.applicationId);
            if (!cur) return "The application was deleted.";
            return store.gateCheck(cur, { kind: a.kind, authorizationId: a.authorizationId }, gate).refused;
        };
        const stopForGate = (why: string) => {
            if (a.kind !== "passive") gateWords ??= GATE_WORDS.stopped(why);
            stopFor("unauthorized");
        };
        /** True when the gate stopped it (above passive also when a cancel was asked for because of it, e.g. a withdrawn approval). */
        const gateStops = (): boolean => {
            const why = gateNow();
            if (why) stopForGate(why);
            return Boolean(why);
        };
        const owns = () => reason !== "lease";
        let ticks = 0;
        let gateFailures = 0;
        const ticker = setInterval(() => {
            if (++ticks % RENEW_EVERY_TICKS === 0) {
                try {
                    if (!store.renewLease(id, this.owner, LEASE_MS)) stopFor("lease");
                    // No request goes out without a current authorization (a change of scope or a revoke stops the assessment), and above
                    // passive without the whole start gate (a withdrawn or expired approval, a replaced authorization, the switch turned off).
                    gateStops();
                    gateFailures = 0;
                } catch {
                    // The database busy for a moment is tried again at the next check. A check that keeps failing (an unreadable row, a
                    // database that stays away) is not a pass: after a few in a row the run stops, as a refused gate would stop it.
                    if (++gateFailures >= GATE_CHECK_FAILURES) {
                        gateWords ??= GATE_UNCHECKED_WORDS;
                        stopFor("unauthorized");
                    }
                }
            }
            try {
                if (store.cancelRequested(id)) {
                    // Above passive, a cancel caused by the gate is reported in the gate's words; a gate that cannot be read never holds
                    // a cancel back.
                    let gated = false;
                    try {
                        gated = a.kind !== "passive" && gateStops();
                    } catch {
                        gated = false;
                    }
                    if (!gated) stopFor("cancel");
                }
            } catch {
                /* the cancel flag could not be read this tick: try again next tick */
            }
        }, TICK_MS);
        const startedMs = a.startedAt ? Date.parse(a.startedAt) : Date.now();
        const timeout = setTimeout(() => stopFor("timeout"), Math.max(1_000, limits.timeoutMs - (Date.now() - startedMs)));
        const onLoopStop = () => stopFor("lease");
        this.stopping?.signal.addEventListener("abort", onLoopStop, { once: true });

        const update = (patch: Parameters<SecurityStore["updateAssessment"]>[1]) => {
            if (owns()) store.updateAssessment(id, patch);
        };
        const finish = (state: SecurityAssessment["state"], patch: Parameters<SecurityStore["updateAssessment"]>[1]) => {
            if (!owns() || !store.renewLease(id, this.owner, LEASE_MS)) return;
            const done = store.updateAssessment(id, { ...patch, state, finishedAt: new Date().toISOString() });
            store.releaseLease(id, this.owner);
            log("finished", { assessment: id, state, pages: work.discovery?.pages.length ?? 0, results: work.scan?.results.length ?? 0 });
            try {
                if (done) this.deps.onFinished?.(done, app);
            } catch {
                /* audit is best effort here; the state is recorded */
            }
        };

        try {
            if (!app) return finish("FAILED", { error: "The application was deleted before the assessment could run.", progressText: "Failed." });
            // Claimed, or picked up again after a restart: the whole start gate again, before anything is requested.
            const refused = gateNow();
            if (store.cancelRequested(id) && !(a.kind !== "passive" && refused)) return finish("CANCELLED", { progressText: "Cancelled before it started. Nothing was requested.", coverage: null });
            if (refused) {
                stopForGate(refused);
                if (work.discovery) return await this.endEarly(id, "unauthorized", work, work.discovery, [], limits, finish, {}, [], gateWords);
                return finish("CANCELLED", { progressText: `${gateWords ?? UNAUTHORIZED_WORDS} Nothing was requested.`, coverage: null });
            }
            if (work.attempts > MAX_ATTEMPTS) return finish("FAILED", { error: "The assessment was interrupted three times (the platform restarted or lost it while it ran), so it was stopped.", progressText: "Failed." });
            if (!a.startedAt) update({ startedAt: new Date().toISOString() });
            // Round 20 (SIGN): the saved sign-in (or why it is not used), and the sensitive workflows excluded like excluded paths.
            const signIn = app.signInAccount ? this.deps.signInFor?.(app) : undefined;
            secrets = signIn?.secrets ?? [];
            const scoped = withSensitiveExclusions(app);
            cov = {
                ...(app.signInAccount ? { signIn: { label: signIn?.label ?? app.signInAccount, used: Boolean(signIn?.state), ...(signIn?.problem ? { problem: signIn.problem } : !signIn ? { problem: "Signed-in pages were not inspected: saved sign-ins cannot be read here." } : {}) } } : {}),
                ...(app.sensitiveWorkflows?.length ? { sensitive: app.sensitiveWorkflows } : {}),
            };
            const extra: string[] = this.deps.scannersLeftOut ? [this.deps.scannersLeftOut] : [];
            const retest = a.retestOf ? retestTargets(this.deps.db, a.retestOf) : undefined;
            const document = work.discoveryDone || retest ? undefined : apiDocumentText(this.deps.db, app.id);
            const request: ProbeRequest = {
                app: scoped,
                ...(signIn?.state ? { signIn: { state: signIn.state, ...(signIn.checkUrl ? { checkUrl: signIn.checkUrl } : {}) } } : {}),
                limits,
                ...(retest ? { retest: retest.map((t) => ({ urls: t.urls, category: t.category })) } : {}),
                ...(document ? { document: { text: document.text, fileName: document.summary.fileName } } : {}),
            };
            let ended: "done" | "aborted";
            if (this.deps.onRunner) {
                // Round 52 (EXECUTION_MODE=runners): the steps that touch the application run on the starter's runner (on-runner.ts); nothing
                // is requested from here. What it found comes back with its result and goes on below exactly as a local one.
                log("claimed", { assessment: id, attempt: work.attempts, retest: Boolean(a.retestOf), onRunner: true });
                if (!work.discoveryDone) update({ state: "DISCOVERING", progress: 5, progressText: "Waiting for your runner to take the assessment." });
                try {
                    const out = await this.deps.onRunner({
                        assessment: a,
                        ownerId: work.ownerId ?? null,
                        request: { ...request, url: app.targetUrl, work: { ...(work.discoveryDone && work.discovery ? { discovery: work.discovery, discoveryDone: true } : {}), ...(work.scan ? { scan: work.scan } : {}) } },
                        secrets,
                        signal: abort.signal,
                        keepTask: () => reason === "lease",
                        update,
                    });
                    Object.assign(work, out.work);
                    extra.push(...out.extra);
                    save();
                    ended = "done";
                } catch (e) {
                    if (!abort.signal.aborted) throw e;
                    work.discovery ??= emptyDiscovery(app.targetUrl);
                    ended = "aborted";
                }
            } else {
                const guard = this.deps.guardFor(scoped, abort.signal, signIn?.state ? { state: signIn.state, refuseSignOut: true } : {});
                // The company proxy (SECURITY_USE_PROXY) is checked before the first request: a proxy that may not be used fails the assessment with the reason.
                await guard.ready?.();
                log("claimed", { assessment: id, attempt: work.attempts, retest: Boolean(a.retestOf) });
                ended = await probe({ ...request, guard, headless: this.deps.headless, launch: this.deps.launch, signal: abort.signal, update, save }, work, extra);
            }
            // The platform's own requests are kept beside the scanners' (one request log per assessment: scanners/store.ts).
            savePlatformRequests(this.deps.db, a, "steps", work.requestLog);
            const discovery = work.discovery!;
            if (ended === "aborted" || !work.scan) return await this.endEarly(id, reason ?? "lease", work, discovery, extra, limits, finish, cov, secrets, gateWords);

            // ── EXTERNAL SCANNERS (SCAN) ──
            // Run after the platform's own read-only checks and before VALIDATING, so a scanner's findings go through exactly the
            // same redaction, deduplication, history and retest code as the built-in ones. Each tool's outcome is recorded on its own:
            // one tool failing is a gap in the coverage list, never the end of the assessment.
            if (this.deps.scanners && work.scanners) {
                // Picked up after the stage was done: its sentences still belong in this report's coverage list.
                extra.push(...(work.scanners.notes ?? work.scanners.lines));
            }
            if (this.deps.scanners && !work.scanners) {
                // The start gate again right before any scanner (and before each one: orchestration/run.ts), and once they are done.
                if (!gateStops()) await this.runScanners(id, scoped, discovery, work, extra, update, abort.signal, gateNow, () => reason === "lease");
                if (!abort.signal.aborted) gateStops();
                if (abort.signal.aborted) return await this.endEarly(id, reason!, work, discovery, extra, limits, finish, cov, secrets, gateWords);
            }

            // ── CROSS-ACCOUNT (read-only) ── only for an application with a designation (cross-account.ts); nothing changes otherwise.
            const designation = readDesignation(this.deps.db, app.id);
            if (designation && !work.crossAccount) {
                update({ state: "SCANNING", progress: 80, progressText: "Checking what one test account can read of another's." });
                // The accounts the CURRENT authorization names (a newer one may have narrowed what the assessment started under).
                const named = this.store.currentAuthorization(this.store.getApplication(app.id) ?? app)?.crossAccounts ?? [];
                work.crossAccount = await this.crossAccountStep(scoped, designation, named, abort.signal, (more) => (secrets = [...secrets, ...more]), (kept) => savePlatformRequests(this.deps.db, a, "cross-account", kept));
                save();
                if (abort.signal.aborted) return await this.endEarly(id, reason!, work, discovery, extra, limits, finish, cov, secrets, gateWords);
            }
            if (work.crossAccount) extra.push(...work.crossAccount.lines);

            // ── VALIDATING ── (FIND: normalize, redact, deduplicate, keep people's validation; a retest marks what is gone as fixed)
            const failedSteps = work.scan.outcomes.filter((o) => !o.ok);
            // A designated cross-account step that could not run leaves the assessment incomplete (a retest then marks none of its findings fixed).
            const complete = failedSteps.length === 0 && !work.scan.capReached && discovery.failures.length === 0 && (!designation || work.crossAccount?.ran === true);
            update({ state: "VALIDATING", progress: 85, progressText: "Comparing with earlier findings." });
            scrub();
            const summary = await ingest(this.deps.db, a, [...work.scan.results, ...(work.crossAccount?.results ?? [])], { retestComplete: complete });
            work.ingested = true;
            save();

            // ── GENERATING_REPORT ── (the report itself is built when someone opens or downloads it; this proves it can be built)
            update({ state: "GENERATING_REPORT", progress: 95, progressText: "Preparing the report." });
            const coverage = { pagesSeen: discovery.pages.length, formsSeen: discovery.forms.length, apiCallsSeen: discovery.apiCalls.length, notInspected: notInspected(discovery, work.scan.outcomes, extra, limits, cov) };
            update({ coverage });
            let reportProblem: string | undefined;
            try {
                if (!buildReport(this.deps.db, { assessmentId: id })) reportProblem = "The report could not be prepared.";
            } catch (e) {
                reportProblem = `The report could not be prepared: ${first(e)}`;
            }
            const counts = `${plural(summary.created, "new finding")}, ${plural(summary.updated, "finding")} seen again${a.retestOf ? `, ${summary.markedFixed} marked fixed` : ""}`;
            if (complete && !reportProblem) {
                finish("COMPLETED", { progress: 100, progressText: `Finished: ${counts}.`, error: null });
            } else {
                const why = [
                    ...failedSteps.map((o) => `${o.step}: ${o.reason}`),
                    ...(work.scan.capReached ? ["The most requests one assessment may send was reached."] : []),
                    ...(discovery.failures.length ? [`${plural(discovery.failures.length, "page")} could not be loaded.`] : []),
                    ...(reportProblem ? [reportProblem] : []),
                ];
                finish("PARTIALLY_COMPLETED", { progress: 100, progressText: `Finished with gaps: ${counts}.`, error: why.join(" ").slice(0, 1500) });
            }
        } catch (e) {
            // The steps keep their request log even when they fail (probe.ts).
            savePlatformRequests(this.deps.db, a, "steps", work.requestLog);
            log("failed", { assessment: id, error: first(e) });
            finish("FAILED", { error: plainFailure(e), progressText: "Failed." });
        } finally {
            clearInterval(ticker);
            clearTimeout(timeout);
            this.stopping?.signal.removeEventListener("abort", onLoopStop);
            if (reason === "lease") log("lease-lost", { assessment: id });
        }
    }

    /** Cancelled, out of time, or the loop is stopping: keep what was seen (judging sends nothing), then record the end. */
    private async endEarly(
        id: string,
        reason: StopReason,
        work: WorkData,
        discovery: DiscoveryResult,
        extra: string[],
        limits: AssessmentLimits,
        finish: (state: SecurityAssessment["state"], patch: Parameters<SecurityStore["updateAssessment"]>[1]) => void,
        cov: CoverageContext = {},
        secrets: string[] = [],
        /** Above passive: why the start gate stopped it (replaces the passive "unauthorized" words). */
        gateWords?: string,
    ): Promise<void> {
        // Losing the lease (another loop has it, or this one is shutting down): record nothing; the next owner continues from work data.
        if (reason === "lease") return;
        const a = this.store.getAssessment(id)!;
        const stage = a.state === "QUEUED" ? "DISCOVERING" : a.state;
        let results = work.scan?.results;
        if (!results) {
            // Only what was already received is judged: no request is sent after a cancel.
            const { judgeHeaders, judgeCookies, judgeDisclosure } = await import("./judge.js");
            const pages = discovery.documents.filter((c) => c.status >= 200 && c.status < 300 && /text\/html/i.test(c.headers["content-type"] ?? ""));
            results = [...(await judgeHeaders(pages)), ...(await judgeCookies([...discovery.documents, ...discovery.apiAnswers])), ...(await judgeDisclosure([...discovery.documents, ...discovery.apiAnswers]))];
        }
        const summary = await ingest(this.deps.db, a, scrubSecrets([...results, ...(work.crossAccount?.results ?? [])], secrets), { retestComplete: false });
        const where = { DISCOVERING: "while looking at the pages", SCANNING: "while making the checks", VALIDATING: "while comparing findings", GENERATING_REPORT: "while preparing the report" }[stage as string] ?? "";
        const kept = `What was seen until then is kept (${plural(summary.created + summary.updated, "finding")}); the steps after it were not made.`;
        const words =
            reason === "cancel"
                ? `Cancelled ${where}. ${kept}`
                : reason === "unauthorized"
                  ? `${gateWords ?? UNAUTHORIZED_WORDS} ${kept}`
                  : `The time limit (${Math.round(limits.timeoutMs / 60_000) || "under 1"} min) was reached ${where}. ${kept}`;
        const coverage = { pagesSeen: discovery.pages.length, formsSeen: discovery.forms.length, apiCallsSeen: discovery.apiCalls.length, notInspected: notInspected(discovery, work.scan?.outcomes ?? [], [words, ...extra], limits, cov) };
        if (reason === "cancel" || reason === "unauthorized") finish("CANCELLED", { progressText: words, coverage });
        else finish("PARTIALLY_COMPLETED", { progressText: words, coverage, error: words });
    }

    /**
     * The read-only cross-account step: A's, B's and a signed-out visitor's view of each designated resource, each through a guard of its
     * own (GET only, the same scope, excluded paths and sensitive workflows, sign-out addresses refused). Refused, with a coverage sentence,
     * on a platform that runs assessments on runners, for an application not marked development or staging, and when A's or B's saved
     * sign-in cannot be used. Every value of both saved sign-ins is scrubbed from what is kept (`addSecrets`).
     */
    private async crossAccountStep(app: SecurityApplication, d: Designation, named: readonly string[], signal: AbortSignal, addSecrets: (s: string[]) => void, keepLog: (log: StoredRequestLog) => void): Promise<NonNullable<WorkData["crossAccount"]>> {
        const skip = (line: string) => ({ results: [], lines: [line], ran: false });
        if (this.deps.onRunner) return skip(CROSS_ACCOUNT_NOT_ON_RUNNER);
        const env = environmentProblem(app.environment);
        if (env) return skip(env);
        // Its two test accounts must be named in the authorization the assessment runs under (profile-gate.ts).
        const consent = crossAccountConsentProblem(named, d.accountA, d.accountB, signInLabel);
        if (consent) return skip(consent);
        if (!this.deps.signInFor) return skip("Cross-account checks were not made: saved sign-ins cannot be read here.");
        const labels = { A: signInLabel(d.accountA), B: signInLabel(d.accountB) };
        const signIns = { A: this.deps.signInFor({ ...app, signInAccount: d.accountA }), B: this.deps.signInFor({ ...app, signInAccount: d.accountB }) };
        addSecrets([...(signIns.A?.secrets ?? []), ...(signIns.B?.secrets ?? [])]);
        for (const who of ["A", "B"] as const) {
            const s = signIns[who];
            if (!s?.state) return skip(`Cross-account checks were not made: the saved sign-in of ${labels[who]} (account ${who}) cannot be used. ${s?.problem ?? "No sign-in is saved for it."}`);
        }
        const guards: Record<Identity, Guard> = {
            A: this.deps.guardFor(app, signal, { state: signIns.A!.state!, refuseSignOut: true, source: "cross-account" }),
            B: this.deps.guardFor(app, signal, { state: signIns.B!.state!, refuseSignOut: true, source: "cross-account" }),
            visitor: this.deps.guardFor(app, signal, { refuseSignOut: true, source: "cross-account" }),
        };
        // Each guard owns a local proxy server: always closed, whatever happens.
        try {
            for (const g of Object.values(guards)) await g.ready?.();
            const run = await runCrossAccount({
                targetUrl: app.targetUrl,
                designation: d,
                labels,
                signal,
                fetchAs: (who, path) => guards[who].fetch(new URL(path, app.targetUrl).href, { method: "GET", maxBytes: 512_000, signal }),
            });
            return { results: run.results, lines: run.lines, ran: !signal.aborted };
        } finally {
            keepLog(mergeRequestLogs(Object.values(guards).map((g) => g.requestLog?.().stored())));
            for (const g of Object.values(guards)) await g.close?.();
        }
    }

    /**
     * Run the external scanners this project allows at this assessment's profile, and fold what they report into the same result list
     * the built-in checks fill.
     *
     * The target they receive is built from what discovery actually reached, never widened: the addresses the scope guard already
     * resolved and refused, with the application's excluded paths and sensitive workflows taken out. `this.deps.scanners` is absent on a
     * platform with no scanner configured, in which case this method is never called and the assessment behaves exactly as it did
     * before the scanner layer existed.
     */
    private async runScanners(
        id: string,
        scoped: SecurityApplication,
        discovery: DiscoveryResult,
        work: WorkData,
        extra: string[],
        update: (patch: Parameters<SecurityStore["updateAssessment"]>[1]) => void,
        signal: AbortSignal,
        gateRefusal?: () => string | undefined,
        /** True when this loop lost the assessment mid-stage: nothing is recorded, so the next owner runs the whole stage again. */
        leaseLost: () => boolean = () => false,
    ): Promise<void> {
        const deps = this.deps.scanners!;
        const a = this.store.getAssessment(id);
        const profile = (a?.kind ?? "passive") as ScanIntensity;
        // Only the addresses discovery actually reached: a scanner must never be handed a page nobody saw.
        const seen: string[] = [...discovery.pages.map((p) => p.url), ...discovery.apiCalls].filter((u): u is string => typeof u === "string");
        // `scoped` already carries the client's sensitive workflows in its excluded paths (withSensitiveExclusions), so one list is
        // enough here: a path the read-only checks never request is never handed to a tool that sends crafted requests either.
        const urls = [...new Set(seen)].filter((u) => !scoped.excludedPaths.some((p) => p && safeStartsWith(u, p)));
        if (!urls.length) {
            work.scanners = { results: [], lines: ["No external scanner ran: no in-scope address was reached during discovery."], failed: 0, ran: [], notes: ["No external scanner ran: no in-scope address was reached during discovery."] };
            saveWork(this.store, id, work);
            return;
        }

        // The saved sign-in belongs to THIS application. One loop serves every application in the platform, so it is resolved here rather
        // than read from loop-wide deps, and it is resolved to a single Cookie header for the application's own origin - never the whole
        // saved state, and never a value that reaches a log or a piece of evidence.
        let authHeader: { name: string; value: string } | undefined;
        const resolved = this.deps.signInFor?.(scoped);
        if (resolved?.state) {
            const cookie = cookieHeaderFor(resolved.state, scoped.targetUrl);
            if (cookie) authHeader = { name: "Cookie", value: cookie };
        }

        update({ progress: 80, progressText: "Running the configured security scanners." });
        // An earlier attempt of this stage that lost its lease left runs behind: this attempt replaces them in the run lists.
        supersedeScannerRuns(this.deps.db, id);
        try {
            const out = await runScanners({
                db: this.deps.db,
                application: scoped,
                assessmentId: id,
                profile,
                approval: a?.approval ?? null,
                ...(gateRefusal ? { gateRefusal } : {}),
                allowPrivateTargets: this.deps.settings.allowPrivateTargets,
                signal,
                target: { urls, origin: new URL(scoped.targetUrl).origin },
                settings: deps.settings,
                ...(authHeader ? { authHeader } : {}),
                ...(deps.aiInterface ? { aiInterface: deps.aiInterface } : {}),
                onProgress: (text) => update({ progressText: text }),
                log: (event, data) => deps.log?.(event, data),
                ...(deps.adapters ? { adapters: deps.adapters } : {}),
            });
            // Stopped part-way because another loop has it (or this one is shutting down): the scanners that had not run would be
            // skipped for good if this partial outcome were kept, so nothing is: the next owner runs the stage again.
            if (leaseLost()) {
                deps.log?.("scanners-interrupted", { assessment: id });
                return;
            }
            const lines = scannerCoverageLines(out.outcomes);
            const failed = out.outcomes.filter((o) => o.state === "FAILED").length;
            // Scanner results join the built-in ones and are judged by exactly the same pipeline.
            if (work.scan) {
                work.scan.results = [...work.scan.results, ...out.results];
                for (const o of out.outcomes) if (o.state === "FAILED") work.scan.outcomes.push({ step: `External scanner: ${o.scanner}`, ok: false, reason: o.reason });
            }
            // The limitation sentences belong in the report's "what was not inspected" list, where a client will actually read them.
            const notes = out.outcomes.flatMap((o) => o.coverage.notInspected).slice(0, 20);
            work.scanners = { results: out.results, lines, failed, ran: out.outcomes.filter((o) => o.state === "COMPLETED").map((o) => o.scanner), notes };
            extra.push(...notes);
            saveWork(this.store, id, work);
            deps.log?.("scanners-finished", { assessment: id, ran: work.scanners.ran.length, failed, findings: out.results.length });
        } catch (e) {
            if (leaseLost()) return;
            // The scanner layer failing must not fail the assessment: say so plainly and let the built-in results stand.
            const message = `The external scanners did not run: ${first(e)}`;
            work.scanners = { results: [], lines: [message], failed: 1, ran: [], notes: [message] };
            work.scan?.outcomes.push({ step: "External scanners", ok: false, reason: message });
            saveWork(this.store, id, work);
            deps.log?.("scanners-failed", { assessment: id, error: first(e) });
        }
    }
}

/** A failure in words a person can act on. */
export function plainFailure(e: unknown): string {
    const m = first(e);
    if (/ECONNREFUSED/.test(m)) return "The application did not accept connections (connection refused). Check that it is running and that the address is right, then start a new assessment.";
    if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "The application's host name could not be found. Check the address, then start a new assessment.";
    if (/Executable doesn't exist|browserType\.launch/i.test(m)) return "The platform's browser could not be started, so the pages could not be looked at. Ask the administrator to install the browsers (npx playwright install chromium).";
    return `The assessment stopped because of an error: ${m}`;
}

/** One path against one address, without letting a differing origin or a partial prefix slip through. */
function safeStartsWith(url: string, prefix: string): boolean {
    try {
        const p = new URL(url).pathname;
        return p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
    } catch {
        return false;
    }
}

/** Persist the loop's scratch data, so a restarted loop never re-runs a scanner that already finished. */
function saveWork(store: SecurityStore, id: string, work: WorkData): void {
    try {
        store.setWorkData(id, work);
    } catch {
        /* the assessment still has its results; a lost scratch note must not end the run */
    }
}
