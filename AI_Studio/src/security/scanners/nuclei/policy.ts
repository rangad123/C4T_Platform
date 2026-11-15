/**
 * The reviewed-template policy for Nuclei, kept apart from the adapter on purpose.
 *
 * Nuclei can run thousands of community templates, some of which flood a target, brute force a login, try known default passwords,
 * read or delete records, or exploit a flaw. Running "everything" against a client's application is not an assessment, it is an
 * uncontrolled attack. So selection and execution are two separate things:
 *
 *   - `selectTemplates` decides WHICH templates may run, from a directory the administrator configured
 *     (SECURITY_NUCLEI_TEMPLATES). Nothing outside that directory is ever considered, and a template id supplied by a user is only
 *     ever used as a filter against that directory, never as a path or a command.
 *   - `./adapter.ts` decides HOW they are run: fixed arguments, a rate limit, a request budget, a time limit, and the abort signal.
 *
 * The policy has three parts, all deliberately conservative:
 *   1. `BLOCKED_TAGS`      categories that are refused outright (brute force, fuzzing, dos, and anything that exploits a flaw to
 *                          gain access). They are refused at every profile.
 *   2. `PROFILE_TAGS`      the categories each profile may use. `passive` is a very short list of read-only checks.
 *   3. `ALLOWED_SEVERITIES` the severities a template may claim; a template claiming "critical" must say what it does, and the
 *                          platform's own wording still wins in the finding.
 *
 * An administrator who wants a category that is blocked here has to change this file and say why in the review. That is the point.
 */
import type { ScanIntensity } from "../contract.js";
import type { Severity } from "../../contract.js";

/** Template tags refused at every profile. A template carrying any of them is not selected, whatever its directory. */
export const BLOCKED_TAGS: readonly string[] = [
    "bruteforce",
    "brute",
    "fuzz",
    "fuzzing",
    "dos",
    "denial-of-service",
    "headless",
    "code",
    "rce",
    "lfi",
    "rfi",
    "xss",
    "sqli",
    "ssrf",
];

/**
 * Tags each profile may use. Anything not listed is not selected: the list is an allow-list, never a deny-list.
 *
 * Note that "xss", "sqli", "ssrf" and "rce" are blocked even for `advanced`. This module does not implement payload libraries, and
 * injection findings come from the Schemathesis adapter (schema-driven, non-destructive by default) and from a person's own
 * confirmation, not from a community exploitation template.
 */
export const PROFILE_TAGS: Record<ScanIntensity, readonly string[]> = {
    // No "default-login" (it signs in with guessed passwords), no "cve" (a CVE template may exploit), no "headless" (blocked anyway).
    passive: ["exposure", "misconfig", "tech", "ssl", "header", "config"],
    "conservative-active": ["exposure", "misconfig", "tech", "ssl", "header", "config", "default-login", "cve", "files", "backup", "swagger", "graphql", "jwt", "exposure"],
    advanced: ["exposure", "misconfig", "tech", "ssl", "header", "config", "default-login", "cve", "files", "backup", "swagger", "graphql", "jwt", "exposure", "misconfiguration"],
};

/** Severities a selected template may claim. */
export const ALLOWED_SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

/** Most templates one run may select (a directory with ten thousand templates must not become one enormous scan). */
export const MAX_TEMPLATES_PER_RUN = 200;

export interface TemplateFacts {
    /** The template's own id, as written in the file. */
    id: string;
    /** Its severity word. */
    severity: string;
    /** Its tags, lower case. */
    tags: string[];
    /** The file it came from (only ever a file inside the configured directory). */
    path?: string;
    /**
     * Read from the template's own request blocks: true when it only sends GET or HEAD over HTTP (or only opens a TLS connection), with
     * no payloads, fuzzing or attack section. Undefined when not known; the passive profile then refuses it.
     */
    readOnly?: boolean;
    /** True when it sends nothing but GET, HEAD or OPTIONS (crafted values allowed). Above passive a template must be this or read-only. */
    safeMethodsOnly?: boolean;
    /**
     * True when it opens its own connection rather than sending HTTP requests (an `ssl` section dials `{{Host}}:{{Port}}` or a fixed
     * port itself). Such a connection does not go through the request guard's proxy, so it skips the scope, rate and budget checks
     * and the request log. Only allowed when the run is isolated, where the guard is the only way out.
     */
    dialsDirectly?: boolean;
}

/** What the run itself offers, for the decisions that depend on it. */
export interface TemplateRunContext {
    /** The run has an isolated network whose only way out is the request guard (src/security/egress/isolation.ts). */
    isolated?: boolean;
}

export interface TemplateDecision {
    ok: boolean;
    /** Why not, in plain words (shown in the run's coverage list). */
    reason?: string;
}

/** May this template run at this profile at all? Tags decide; severity is checked separately. */
export function templateAllowed(template: TemplateFacts, profile: ScanIntensity, run: TemplateRunContext = {}): TemplateDecision {
    const tags = (template.tags ?? []).map((t) => String(t).toLowerCase());
    const blocked = tags.find((t) => BLOCKED_TAGS.includes(t));
    if (blocked) return { ok: false, reason: `Tag "${blocked}" is not used by this platform at any profile.` };
    const allowed = PROFILE_TAGS[profile] ?? [];
    if (!tags.some((t) => allowed.includes(t))) return { ok: false, reason: `None of its tags (${tags.join(", ") || "none"}) is in the ${profile} list.` };
    if (!ALLOWED_SEVERITIES.includes(template.severity as Severity)) return { ok: false, reason: `It claims the severity "${template.severity}", which is not one of the five this platform uses.` };
    // nuclei has no live read-only mode (its -passive flag processes stored responses instead), so the passive profile's promise is kept here.
    if (profile === "passive" && template.readOnly !== true) return { ok: false, reason: "At the passive profile only templates that send nothing but GET or HEAD requests are used, and this one may send more." };
    // No profile changes data: above passive a template that may send any other method than GET, HEAD or OPTIONS is skipped (and listed).
    if (template.readOnly !== true && template.safeMethodsOnly !== true) return { ok: false, reason: "It may send a request that can change data (a method other than GET, HEAD or OPTIONS), and no profile sends one, so it was skipped." };
    if (template.dialsDirectly === true && run.isolated !== true)
        return { ok: false, reason: "It opens its own connection to the target (a TLS check, or a raw request nuclei sends outside its proxy) instead of an ordinary HTTP request, which would bypass the platform's request guard, and this run is not isolated, so it was skipped." };
    return { ok: true };
}

/** How many templates a profile may run at once. */
export const concurrencyFor = (profile: ScanIntensity, configured: number): number => (profile === "passive" ? Math.min(2, configured) : Math.max(1, Math.min(configured, 10)));

/** The request rate handed to nuclei: never above what the application allows, never above the platform's ceiling. */
export const rateFor = (profile: ScanIntensity, applicationRps: number, ceiling: number): number => {
    const byProfile = profile === "passive" ? 2 : profile === "conservative-active" ? 5 : 10;
    return Math.max(1, Math.min(byProfile, applicationRps || 1, ceiling));
};
