/**
 * Scan profiles: how much a run is allowed to do, and what a person must confirm before it may do it.
 *
 * Three levels, and the platform never runs a tool above the level the profile allows (each adapter answers `supports(profile)`):
 *
 *   passive               the same ordinary requests a visitor's browser makes. Nothing is sent that aims to make the application
 *                         behave differently. Safe on production. No approval needed.
 *   conservative-active   crafted requests that look for known configuration problems (missing headers, exposed files, known bad
 *                         defaults). They may trigger alerts and they do touch unusual paths, but nothing is written, deleted or
 *                         created. Allowed on a confirmed scope; the person starting the scan confirms the profile in the UI.
 *   advanced              checks that need many repeated requests or that reach an authenticated area with a test account. Requires a
 *                         recorded approval AND a non-production environment, because a bug in the tool is then indistinguishable
 *                         from the effect being tested.
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

const NO_DESTRUCTION = [
    "It never deletes, overwrites or exfiltrates data.",
    "It never installs persistence, and never tries to keep access after the assessment ends.",
    "It never takes over an account, steals a credential, or bypasses an authorization control on purpose.",
    "It never runs a payload that aims to damage or disable the application.",
] as const;

export const SCAN_PROFILES: Record<ScanIntensity, ScanProfile> = {
    passive: {
        id: "passive",
        title: "Passive",
        description: "The ordinary requests a visitor's browser makes, plus known-file and configuration requests that do not aim to change anything.",
        intrusive: false,
        requiresApproval: false,
        allowedScanners: ["zap", "nuclei", "schemathesis", "promptfoo"],
        never: ["It sends no crafted payload aimed at the application.", "It does not try to make any request fail.", ...NO_DESTRUCTION],
    },
    "conservative-active": {
        id: "conservative-active",
        title: "Conservative active checks",
        description:
            "Crafted requests from a reviewed list of checks that look for known configuration problems. They may raise alerts on the target and they request paths that are not linked from the site, but nothing is created, changed or deleted.",
        intrusive: true,
        requiresApproval: false,
        allowedScanners: ["zap", "nuclei", "schemathesis", "promptfoo"],
        never: [
            "State-changing operations are not requested (no create, update or delete).",
            "Only checks from the platform's reviewed list run; no template or payload may be supplied by hand at run time.",
            "Requests are rate limited and capped, and the run stops at its time limit.",
            ...NO_DESTRUCTION,
        ],
    },
    advanced: {
        id: "advanced",
        title: "Advanced assessment (controlled environment only)",
        description:
            "Every conservative check plus the categories that need many repeated requests or that reach an authenticated area with a test account. Intended for a staging or test copy the client controls, never for production.",
        intrusive: true,
        requiresApproval: true,
        refusedIn: ["production"],
        allowedScanners: ["zap", "nuclei", "schemathesis", "promptfoo"],
        never: [
            "It does not run against production. An advanced run is refused unless the application is registered as a non-production environment.",
            "It needs an approval recorded by an owner before it may start, and that approval is kept with the scan run.",
            "It adds no destructive check: the extra categories are still rate limited, capped and non-destructive.",
            ...NO_DESTRUCTION,
        ],
    },
};

export const rank = (p: ScanIntensity): number => SCAN_INTENSITIES.indexOf(p);

/** True when `allowed` is this level or a gentler one. */
export const atMost = (allowed: ScanIntensity, p: ScanIntensity): boolean => rank(p) <= rank(allowed);

/** Why this profile may not be used for this application right now, or undefined when it may. Plain sentences, never codes. */
export function profileRefusal(profile: ScanIntensity, environment: string, hasApproval: boolean): string | undefined {
    const p = SCAN_PROFILES[profile];
    if (!p) return `"${String(profile)}" is not a scan profile.`;
    if (p.requiresApproval && !hasApproval) return `The ${p.title} profile needs an approval recorded by an owner before a scan may start.`;
    if (p.refusedIn?.includes(environment)) return `The ${p.title} profile is refused for production: it sends requests that may change what the application holds, so it is only run against a test or staging copy the client controls.`;
    return undefined;
}

/**
 * The part of the refusal that does not depend on which application is being scanned: an intrusive profile needs an owner to have
 * recorded an approval, whichever environment it runs in. Used where no application has been named yet, so the answer does not depend
 * on an environment nobody has given.
 */
export function approvalProblem(profile: ScanIntensity): string | undefined {
    const p = SCAN_PROFILES[profile];
    return p?.requiresApproval ? `The ${p.title} profile needs an approval recorded by an owner before a scan may start.` : undefined;
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
