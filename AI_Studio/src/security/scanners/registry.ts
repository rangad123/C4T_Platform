/**
 * The scanner registry: the one place that knows which adapters exist, builds them, and answers "what can run right now, and why
 * not?".
 *
 * Everything above this file (the assessment runner, the routes, the settings view) talks to adapters only through here, so there is a
 * single answer to the questions that matter operationally:
 *   - Which tools are switched on for this platform (SECURITY_SCANNERS) AND allowed for this project (the project's own allow-list)?
 *   - Which of those are actually installed and configured, and what is missing for the ones that are not?
 *   - Which of those may run at the profile this assessment is running at, and which profile does the application need first?
 *
 * The platform-wide switch and the per-project allow-list are two separate gates and both must be open. A tool installed on the server
 * is therefore never enough to scan a client's target: an administrator has to name it in the environment AND allow it for that
 * project. A project with no allow-list gets no scanners at all, whatever is installed.
 *
 * This module never starts a scan. It only builds adapters, reports their state, and hands the orchestration a list that is already
 * filtered by everything the platform and the project allow.
 */
import { SCANNER_IDS, type ScanIntensity, type ScannerAdapter, type ScannerAvailability, type ScannerId } from "./contract.js";
import { NucleiAdapter } from "./nuclei/adapter.js";
import { PromptfooAdapter } from "./promptfoo/adapter.js";
import { SchemathesisAdapter } from "./schemathesis/adapter.js";
import { ZapAdapter } from "./zap/adapter.js";
import { profileRefusal, SCAN_PROFILES } from "./profiles.js";
import type { ScannerSettings } from "./settings.js";

/** Every adapter this module knows, in the order they run. Cheap to build: none of them touches a process or a network in here. */
export function allAdapters(settings: ScannerSettings): ScannerAdapter[] {
    return [new ZapAdapter({ settings }), new NucleiAdapter({ settings }), new SchemathesisAdapter({ settings }), new PromptfooAdapter({ settings })];
}

export const adapterOf = (adapters: readonly ScannerAdapter[], id: ScannerId): ScannerAdapter | undefined => adapters.find((a) => a.id === id);

/**
 * The adapters that may consider running for this project, in run order, already filtered by the platform switch and the project's own
 * allow-list. Returns them whether or not they are installed; use `usableAdapters` for the ones that can actually run now.
 */
export function adaptersForProject(settings: ScannerSettings, projectAllowed: readonly ScannerId[]): ScannerAdapter[] {
    const all = allAdapters(settings);
    const allowed = new Set(projectAllowed);
    return SCANNER_IDS.filter((id) => settings.enabled.includes(id) && allowed.has(id)).map((id) => adapterOf(all, id)!).filter(Boolean);
}

export interface ScannerHealth {
    id: ScannerId;
    name: string;
    documentationUrl: string;
    description: string;
    /** What this tool could contribute at all. */
    purpose: string;
    capabilities: ScannerAdapter["capabilities"];
    /** "off" = not named in SECURITY_SCANNERS; "not-allowed" = on the platform but not for this project; otherwise the tool's own state. */
    status: "off" | "not-allowed" | ScannerAvailability["state"];
    /** One plain sentence for a person. Never contains a key, a token or a password. */
    reason: string;
    /** What to do about it. */
    remedy: string;
    version?: string;
    /** True when this tool can run at this profile. */
    supportsProfile: boolean;
    /** What the tool would contribute at this profile, in words a client can read. */
    covers: string;
    checkedAt: string;
}

/** What each tool is actually for, printed in the scanner health view and in the report. Written to be read by a client, not a
 * security engineer. */
const PURPOSE: Record<ScannerId, { purpose: string; covers: string }> = {
    zap: {
        purpose: "Sends the pages through OWASP ZAP and reports what its rules matched, mostly missing headers, cookie flags, disclosure and known injection patterns.",
        covers: "Well covered: missing security headers, cookie flags, information disclosure, and known injection and cross-site scripting patterns its rules know. Not covered: broken access control between users, business-logic problems, and anything needing a person's judgement.",
    },
    nuclei: {
        purpose: "Runs a reviewed set of Nuclei templates - one known problem each - against the pages in scope.",
        covers: "Well covered: the specific misconfigurations the reviewed templates check for. Not covered: anything no reviewed template checks for, and any template an administrator has not installed and reviewed.",
    },
    schemathesis: {
        purpose: "Reads the API document, generates test data from it, and reports where an answer contradicts what the document promised.",
        covers: "Well covered: operations the API document describes, compared against that document. Not covered: operations missing from the document, and broken access control between users.",
    },
    promptfoo: {
        purpose: "Sends a fixed, reviewed set of adversarial cases to a configured AI interface and reports the ones that did not meet their expected outcome.",
        covers: "Well covered: the defined cases, as observed behaviour for review. Not covered: the model's internals, and anything the defined cases do not ask about.",
    },
};

/**
 * The health of every known scanner for one project and profile, for the settings page and for `GET /scanners`. Unavailable tools are
 * reported with what to install and where to point the platform, never silently omitted: a client asking for an active scan is owed
 * the truth about what can and cannot be done.
 */
export async function scannerHealth(
    settings: ScannerSettings,
    projectAllowed: readonly ScannerId[],
    profile: ScanIntensity,
    signal?: AbortSignal,
    overrides: { resolve?: (settings: ScannerSettings) => ScannerAdapter[] } = {},
): Promise<ScannerHealth[]> {
    const adapters = overrides.resolve?.(settings) ?? allAdapters(settings);
    const allowed = new Set(projectAllowed);
    const now = new Date().toISOString();
    const reports = await Promise.all(
        SCANNER_IDS.map(async (id) => {
            const adapter = adapterOf(adapters, id);
            if (!adapter) return null;
            const base = { id, name: adapter.name, documentationUrl: adapter.documentationUrl, description: adapter.description, purpose: PURPOSE[id].purpose, capabilities: adapter.capabilities, checkedAt: now };
            if (!settings.enabled.includes(id)) {
                return { ...base, status: "off" as const, reason: `${adapter.name} is not switched on for this platform.`, remedy: `Add ${id} to SECURITY_SCANNERS in the environment file and restart the platform.`, supportsProfile: false, covers: PURPOSE[id].covers };
            }
            if (!allowed.has(id)) {
                return { ...base, status: "not-allowed" as const, reason: `${adapter.name} is switched on for the platform but is not allowed for this project.`, remedy: "Allow it for this project, or use an assessment of a project that allows it. Nothing runs a scanner that is not allowed for the project being assessed.", supportsProfile: false, covers: PURPOSE[id].covers };
            }
            let availability: ScannerAvailability;
            try {
                availability = await adapter.available(signal);
            } catch (e) {
                availability = { scanner: id, state: "unknown", checkedAt: now, reason: `Its state could not be checked: ${(e as Error).message.split("\n")[0]}.` };
            }
            return {
                ...base,
                status: availability.state,
                reason: availability.reason ?? (availability.state === "available" ? `${adapter.name} is installed and configured.` : ""),
                remedy: availability.remedy ?? "",
                ...(availability.version ? { version: availability.version } : {}),
                supportsProfile: adapter.supports(profile),
                covers: PURPOSE[id].covers,
            };
        }),
    );
    return reports.filter((r): r is ScannerHealth => r !== null);
}

/** The adapters that are switched on, allowed for the project, installed, configured, and able to run at this profile. */
export async function usableAdapters(settings: ScannerSettings, projectAllowed: readonly ScannerId[], profile: ScanIntensity, signal?: AbortSignal, overrides: { resolve?: (settings: ScannerSettings) => ScannerAdapter[] } = {}): Promise<{ adapters: ScannerAdapter[]; unavailable: ScannerHealth[] }> {
    const health = await scannerHealth(settings, projectAllowed, profile, signal, overrides);
    const all = overrides.resolve?.(settings) ?? allAdapters(settings);
    const ready = health.filter((h) => h.status === "available" && h.supportsProfile).map((h) => adapterOf(all, h.id)!).filter(Boolean);
    return { adapters: ready, unavailable: health.filter((h) => h.status !== "available" || !h.supportsProfile) };
}

/**
 * Why this application cannot run the profile its scanner configuration asks for, or "" when it can. An `advanced` profile is refused
 * for a production environment and needs a recorded approval, so this is what the route shows before somebody starts a scan.
 */
export function profileProblem(profile: ScanIntensity, environment: string, hasApproval: boolean): string {
    return profileRefusal(profile, environment, hasApproval) ?? "";
}
