/**
 * The part of a passive assessment that touches the application: discovery (the browser and the uploaded API document's read-only operations),
 * the sign-in check and the read-only checks. Every request goes through the assessment's Guard. Split from runner.ts (round 52) so that the
 * same steps run either in the platform's loop (local mode) or on the starter's runner (EXECUTION_MODE=runners: `runAssessmentOnRunner`, called
 * by the runner's explore child), where the probes leave from the runner's network under its own address rule.
 *
 * This file reaches no database and no key: everything it needs comes in the input, and what it found goes back in `work`.
 */
import type { StorageState } from "../../engine/auth/storage-state.js";
import type { SecurityApplication } from "../contract.js";
import type { RawResult } from "../findings/ingest.js";
import type { SecuritySettings } from "../settings.js";
import { requestDocumentOperations } from "./api-operations.js";
import { checkSignInPlain, discover, emptyDiscovery, type DiscoverOptions } from "./discover.js";
import { guardFor } from "./guard.js";
import { scan, type ScanStepOutcome } from "./scan.js";
import { RequestCapError, type DiscoveryResult, type Guard } from "./types.js";

/** What the steps keep (the assessment's work data keeps the same fields, so a restarted assessment does not send the requests again). */
export interface ProbeWork {
    discovery?: DiscoveryResult;
    discoveryDone?: boolean;
    scan?: { results: RawResult[]; outcomes: ScanStepOutcome[]; capReached: boolean; requested: number };
}

export interface ProbeLimits {
    maxPages: number;
    maxDepth: number;
    maxPerPattern: number;
    retries: number;
    signInCheckEvery: number;
}

/** What the steps need, as data (the same on the platform and on a runner). */
export interface ProbeRequest {
    /** The application as the scope guard sees it (its sensitive workflows already among its excluded paths). */
    app: SecurityApplication;
    /** The saved sign-in limited to the scope, with the signed-in page to check, when the application names one that works. */
    signIn?: { state: StorageState; checkUrl?: string };
    limits: ProbeLimits;
    /** A retest: only the addresses and categories of the earlier assessment's open findings. */
    retest?: Array<{ urls: string[]; category: string }>;
    /** The uploaded API document (its text), when there is one. */
    document?: { text: string; fileName: string };
}

export type ProbeProgress = { state?: "DISCOVERING" | "SCANNING"; progress?: number; progressText?: string };

export interface ProbeInput extends ProbeRequest {
    guard: Guard;
    headless: boolean;
    launch?: DiscoverOptions["launch"];
    signal: AbortSignal;
    update(patch: ProbeProgress): void;
    /** Store `work` now (the platform's loop: into the assessment's work data). */
    save(): void;
}

/** Run the steps not done yet. "aborted": the signal ended them (what was seen is in `work`); otherwise every step is done. Throws a real failure. */
export async function probe(i: ProbeInput, work: ProbeWork, extra: string[]): Promise<"done" | "aborted"> {
    const { guard, app, signIn, limits, retest, signal } = i;
    const update = i.update;
    // Discovery interrupted half-way starts again from the beginning (its queue is not kept); a finished one is reused.
    const discovery = work.discoveryDone && work.discovery ? work.discovery : emptyDiscovery(app.targetUrl);
    work.discovery = discovery;
    // Round 21: picked up again after the saved sign-in had stopped working: nothing more goes out signed in.
    if (discovery.signInEnded) guard.endSignIn?.();
    if (retest) {
        discovery.startUrl = app.targetUrl;
        work.discoveryDone = true;
        extra.push(`This retest re-checked only the ${plural(new Set(retest.flatMap((t) => t.urls)).size, "address", "addresses")} where the earlier assessment's open findings were seen.`);
    }

    // ── DISCOVERING ──
    if (!work.discoveryDone) {
        update({ state: "DISCOVERING", progress: 5, progressText: "Opening the application in a browser (read-only)." });
        try {
            await discover(
                guard,
                {
                    startUrl: app.targetUrl,
                    excludedPaths: app.excludedPaths,
                    apiSpecUrl: app.apiSpecUrl,
                    ...(signIn?.state ? { signedIn: { storageState: signIn.state, ...(signIn.checkUrl ? { checkUrl: signIn.checkUrl } : {}), recheckEvery: limits.signInCheckEvery } } : {}),
                    maxPages: limits.maxPages,
                    maxDepth: limits.maxDepth,
                    maxPerPattern: limits.maxPerPattern,
                    headless: i.headless,
                    signal,
                    launch: i.launch,
                    onProgress: (seen, current) => {
                        let path = current;
                        try {
                            path = new URL(current).pathname;
                        } catch {
                            /* keep it */
                        }
                        update({ progress: 5 + Math.round((seen / limits.maxPages) * 40), progressText: `Looking at page ${seen + 1} (at most ${limits.maxPages}): ${path.slice(0, 120)}` });
                    },
                },
                discovery,
            );
        } catch (e) {
            if (e instanceof RequestCapError) extra.push("The most requests one assessment may send was reached while looking at the pages, so discovery stopped early.");
            else if (!signal.aborted) throw e;
        }
        // Round 20 (SIGN): the uploaded API document's GET operations without required parameters, through the guard.
        if (i.document && !signal.aborted) {
            update({ progress: 46, progressText: "Requesting the API document's read-only operations." });
            try {
                await requestDocumentOperations(guard, i.document, app, discovery, signal, (done, total, path) => update({ progressText: `Requesting API operation ${done + 1} of ${total} (GET only): ${path.slice(0, 120)}` }));
            } catch (e) {
                if (e instanceof RequestCapError) extra.push("The most requests one assessment may send was reached while requesting the API document's operations.");
                else if (!signal.aborted) throw e;
            }
        }
        i.save();
        if (signal.aborted) return "aborted";
        work.discoveryDone = true;
        i.save();
    }

    // ── SCANNING ──
    if (!work.scan) {
        // Round 21: the read-only checks carry the saved sign-in's cookies: first make sure it still works (never signing in again).
        if (signIn?.state && !discovery.signInEnded && discovery.signedInCheck?.ok !== false) {
            update({ progress: 48, progressText: "Checking that the saved sign-in still works." });
            let verdict: { ok: boolean; reason: string } | undefined;
            try {
                if (signIn.checkUrl) verdict = await checkSignInPlain(guard, signIn.checkUrl, signal);
                else if (signIn.state.cookies.length && signIn.state.cookies.every((c) => c.expires > 0 && c.expires * 1000 <= Date.now())) verdict = { ok: false, reason: "its cookies ran out" };
            } catch (e) {
                if (!(e instanceof RequestCapError) && !signal.aborted) throw e;
            }
            if (signal.aborted) return "aborted";
            if (verdict?.ok) discovery.signInConfirmedAfter = discovery.pages.length;
            else if (verdict) {
                discovery.signInEnded = {
                    when: "before-checks",
                    afterPages: discovery.pages.length,
                    lastOkAfterPages: discovery.signInConfirmedAfter ?? 0,
                    url: signIn.checkUrl ? new URL(signIn.checkUrl).pathname.slice(0, 300) : null,
                    reason: verdict.reason,
                };
                guard.endSignIn?.();
            }
            i.save();
        }
        update({ state: "SCANNING", progress: 50, progressText: "Making the read-only checks." });
        try {
            const s = await scan(guard, discovery, {
                signal,
                excludedPaths: app.excludedPaths,
                retries: limits.retries,
                only: retest ? { urls: [...new Set(retest.flatMap((t) => t.urls))], categories: [...new Set(retest.map((t) => t.category))] } : undefined,
                onProgress: (done, total, text) => update({ progress: 50 + Math.round((done / Math.max(1, total)) * 30), progressText: text }),
            });
            work.scan = { results: s.results, outcomes: s.outcomes, capReached: s.capReached, requested: s.requested.length };
        } catch (e) {
            if (!signal.aborted) throw e;
            return "aborted";
        }
        i.save();
    }
    return signal.aborted ? "aborted" : "done";
}

// ── on a runner ──────────────────────────────────────────────────────────────

/** The request of an assessment's explore task (mode "assessment"): the steps' request, the work done before, and the platform's caps. */
export interface AssessmentOnRunnerRequest extends ProbeRequest {
    /** The application's address (the offer's env.baseUrl: the private-address rule of offering and of the runner is checked on it). */
    url: string;
    work: ProbeWork;
    settings: Pick<SecuritySettings, "maxRequestsPerAssessment" | "maxResponseBytes" | "maxTotalBytes">;
}

/**
 * The assessment's progress as a log line of its task (the runner's heartbeat carries it; on-runner.ts copies the newest one into the assessment's
 * own progress, so the page shows it live as when it ran on the platform). Never an address with a query: the steps' texts are paths only.
 */
export const progressLine = (p: ProbeProgress, last: { state: string; progress: number }): string => {
    if (p.state) last.state = p.state;
    if (p.progress !== undefined) last.progress = p.progress;
    return `Assessment ${last.state} ${Math.max(0, Math.min(100, Math.round(last.progress)))}%: ${(p.progressText ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
};
const PROGRESS_LINE = /^Assessment (DISCOVERING|SCANNING) (\d{1,3})%: (.+)$/;
/** The newest progress line of a task's log, as a progress patch (undefined when there is none). */
export function progressOfLog(log: readonly string[]): ProbeProgress | undefined {
    for (let i = log.length - 1; i >= 0; i--) {
        const m = PROGRESS_LINE.exec(log[i] ?? "");
        if (m) return { state: m[1] as "DISCOVERING" | "SCANNING", progress: Number(m[2]), progressText: m[3]!.slice(0, 200) };
    }
    return undefined;
}

/** What the runner sends back (in its result): the work as it stands at the end, and the coverage sentences the steps added. */
export interface AssessmentOnRunnerOutcome {
    work: ProbeWork;
    extra: string[];
}

/**
 * The runner's side (src/agent/explore-child.ts): the steps with a guard of this computer. The platform's scope, exclusions, sign-out refusal,
 * rate limit and request budget are the guard's, as on the platform; private and local addresses follow this runner's own switch (refused
 * unless its owner allowed them), never the platform's setting, and no company proxy of the platform is used.
 */
export async function runAssessmentOnRunner(req: AssessmentOnRunnerRequest, o: { signal: AbortSignal; refusePrivate: boolean; launch?: DiscoverOptions["launch"]; log?: (line: string) => void }): Promise<AssessmentOnRunnerOutcome> {
    const settings: SecuritySettings = {
        enabled: true,
        allowPrivateTargets: !o.refusePrivate,
        retentionDays: 1,
        maxRequestsPerAssessment: req.settings.maxRequestsPerAssessment,
        maxResponseBytes: req.settings.maxResponseBytes,
        maxTotalBytes: req.settings.maxTotalBytes,
        assessmentMinutes: 0,
        useProxy: false,
    };
    const guard = guardFor(req.app, settings, o.signal, {}, req.signIn?.state ? { state: req.signIn.state, refuseSignOut: true } : {});
    const work: ProbeWork = { ...req.work };
    const extra: string[] = [];
    // Progress goes to the platform as log lines, at most about one a second (the last one of a step always).
    const last = { state: "DISCOVERING", progress: 5 };
    let sentAt = 0;
    const update = (p: ProbeProgress) => {
        const line = progressLine(p, last);
        if (!p.progressText || !o.log) return;
        if (Date.now() - sentAt < 900 && !p.state) return;
        sentAt = Date.now();
        o.log(line);
    };
    const ended = await probe({ ...req, guard, headless: true, ...(o.launch ? { launch: o.launch } : {}), signal: o.signal, update, save: () => undefined }, work, extra);
    if (ended === "aborted") throw new Error("The assessment was stopped.");
    return { work, extra };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
