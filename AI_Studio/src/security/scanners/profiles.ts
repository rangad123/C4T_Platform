/**
 * Scan profiles: how much a run is allowed to do, and what must be in place before it may do it.
 *
 * WORDING STATUS: NOT APPROVED. The sentences below are a draft awaiting review; nothing above passive is
 * switched on (SECURITY_ACTIVE_PROFILES defaults to off), so passive is the only profile that runs.
 *
 * Three levels, and the platform never runs a tool above the level the profile allows (each adapter answers `supports(profile)`):
 *
 *   passive               the same ordinary requests a visitor's browser makes. Nothing is sent that aims to make the application
 *                         behave differently. Needs only the client's authorization.
 *   conservative-active   crafted read requests (GET, HEAD, OPTIONS) that look for known configuration problems (missing headers,
 *                         exposed files, known bad defaults). They may trigger alerts and they do touch unusual paths.
 *   advanced              checks that need many repeated requests or that reach an authenticated area with a test account.
 *
 * Every profile, passive included, is read-only: no create, update, delete, overwrite or other operation meant to change data. A check
 * that would need one is skipped and listed as skipped. Both profiles above passive need, on the server (profile-gate.ts): the client's
 * authorization naming the profile, a Crowd4Test admin's approval for the application's environment, an application marked development
 * or staging, and SECURITY_ACTIVE_PROFILES=on. Two different things: the client (the application's owner) AUTHORIZES the assessment;
 * a Crowd4Test admin APPROVES a profile above passive. An application owner never approves a Crowd4Test profile.
 *
 * Nothing in this module implements destructive payloads, unrestricted exploitation, persistence or credential stealing: `advanced`
 * selects whole categories of conservative checks and refuses anything else.
 *
 * The levels are ordered: `rank(profile)` gives the order, so "at most this level" is a comparison rather than a list.
 */
import { SCAN_INTENSITIES, type ScanApproval, type ScanIntensity, type ScannerId } from "./contract.js";

export interface ScanProfile {
    readonly id: ScanIntensity;
    readonly title: string;
    /** What a run at this level actually sends, in words a client can read. */
    readonly description: string;
    /** True when the level can raise an alert on the target or load it noticeably. */
    readonly intrusive: boolean;
    /** True when a run needs a recorded human approval before it may start. */
    readonly requiresApproval: boolean;
    /** When set, this profile is refused for that environment. */
    readonly refusedIn?: readonly string[];
    /** The tools this level may use at all, whichever adapters are installed. An adapter outside this list never runs. */
    readonly allowedScanners: readonly ScannerId[];
    /** What this level never does. Printed in the report next to the profile. */
    readonly never: readonly string[];
}

/** Said for every profile, passive included (draft wording, not approved). */
const NO_DATA_CHANGES = [
    "It never intentionally creates, updates, deletes or overwrites anything the application holds, and requests no operation meant to change data.",
    "A check that would need such an operation is skipped, and the report lists it as skipped.",
    "Even a read request can have a side effect nobody intended in the target application (for example a page that changes something when it is merely visited). The platform does not detect such a change automatically. If anyone sees that something changed during the assessment, the tester records what was observed in the report and the client is told. No further request is made to undo it.",
    "It never exfiltrates data, never installs persistence, and never tries to keep access after the assessment ends.",
    "It never takes over an account, steals a credential, or bypasses an authorization control on purpose.",
    "It never runs a payload that aims to damage or disable the application.",
] as const;

/** Said for both profiles above passive. */
const ABOVE_PASSIVE = [
    "It runs only against an application marked as development or staging, never production; the server refuses any other.",
    "It needs the client's authorization naming this profile, and separately a Crowd4Test admin's approval for this application's environment. The approval is kept with the scan run.",
    "Only checks from the platform's reviewed list run; no template or payload may be supplied by hand at run time.",
    "Requests are rate limited and capped, and the run stops at its time limit.",
] as const;

/** The only environments a profile above passive runs in (profile-gate.ts ACTIVE_ENVIRONMENTS); every other one is refused. */
const NOT_DEV_OR_STAGING = ["production", "other"] as const;

export const SCAN_PROFILES: Record<ScanIntensity, ScanProfile> = {
    passive: {
        id: "passive",
        title: "Passive",
        description: "The ordinary requests a visitor's browser makes, plus known-file and configuration requests that do not aim to change anything.",
        intrusive: false,
        requiresApproval: false,
        allowedScanners: ["zap", "nuclei", "schemathesis", "promptfoo"],
        never: ["It sends no crafted payload aimed at the application.", "It does not try to make any request fail.", ...NO_DATA_CHANGES],
    },
    "conservative-active": {
        id: "conservative-active",
        title: "Conservative active checks",
        description:
            "Crafted read requests (GET, HEAD and OPTIONS only) from a reviewed list of checks that look for known configuration problems. They may raise alerts on the target and they request paths that are not linked from the site. No request is meant to create, update, delete or overwrite anything, but the application may still react to a read request in a way nobody intended. Only for a development or staging copy, never for production.",
        intrusive: true,
        requiresApproval: true,
        refusedIn: NOT_DEV_OR_STAGING,
        allowedScanners: ["zap", "nuclei", "schemathesis", "promptfoo"],
        never: [...ABOVE_PASSIVE, ...NO_DATA_CHANGES],
    },
    advanced: {
        id: "advanced",
        title: "Advanced assessment (controlled environment only)",
        description:
            "Every conservative check plus the categories that need many repeated requests or that reach an authenticated area with a test account. Still read requests only: none is meant to create, update, delete or overwrite anything, but the application may still react to a read request in a way nobody intended. Only for a development or staging copy the client controls, never for production.",
        intrusive: true,
        requiresApproval: true,
        refusedIn: NOT_DEV_OR_STAGING,
        allowedScanners: ["zap", "nuclei", "schemathesis", "promptfoo"],
        never: [...ABOVE_PASSIVE, "It adds no data-changing or destructive check: the extra categories are still read-only, rate limited and capped.", ...NO_DATA_CHANGES],
    },
};

export const rank = (p: ScanIntensity): number => SCAN_INTENSITIES.indexOf(p);

/** True when `allowed` is this level or a gentler one. */
export const atMost = (allowed: ScanIntensity, p: ScanIntensity): boolean => rank(p) <= rank(allowed);

const APPROVAL_NEEDED = (title: string) => `The ${title} profile needs a Crowd4Test admin's approval for this application's environment before a scan may start.`;

/** Why this profile may not be used for this application right now, or undefined when it may. Plain sentences, never codes. */
export function profileRefusal(profile: ScanIntensity, environment: string, hasApproval: boolean): string | undefined {
    const p = SCAN_PROFILES[profile];
    if (!p) return `"${String(profile)}" is not a scan profile.`;
    if (p.refusedIn?.includes(environment))
        return `The ${p.title} profile runs only against an application marked as development or staging, and this one is marked “${environment}”. Only a passive assessment can run here.`;
    if (p.requiresApproval && !hasApproval) return APPROVAL_NEEDED(p.title);
    return undefined;
}

/**
 * The part of the refusal that does not depend on which application is being scanned: an intrusive profile needs a Crowd4Test admin's
 * approval, whichever environment it runs in. Used where no application has been named yet, so the answer does not depend
 * on an environment nobody has given.
 */
export function approvalProblem(profile: ScanIntensity): string | undefined {
    const p = SCAN_PROFILES[profile];
    return p?.requiresApproval ? APPROVAL_NEEDED(p.title) : undefined;
}

/** The approval a scan at this profile needs, or undefined when the profile needs none. */
export function requiredApproval(profile: ScanIntensity, environment: string, by: { id: string; name: string }, at = new Date()): ScanApproval | undefined {
    const p = SCAN_PROFILES[profile];
    if (!p.requiresApproval) return undefined;
    return {
        profile,
        approvedByUserId: by.id,
        approvedByName: by.name,
        approvedAt: at.toISOString(),
        environment,
        statement: `The ${p.title} profile was approved for this ${environment} application.`,
    };
}

/** One plain sentence of what a report must say about a profile, printed with every run's findings. */
export function profileStatement(profile: ScanIntensity): string {
    const p = SCAN_PROFILES[profile];
    return `${p.title}: ${p.description}`;
}
