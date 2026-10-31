/**
 * SCAN routes: what the external scanners can do for this project, and the record of what they did.
 *
 *   GET  /api/v1/security/projects/:id/scanners          viewer   the health of every known scanner for this project, and what it covers
 *   PUT  /api/v1/security/projects/:id/scanners          editor   { enabled: [...] }  which of them this project allows
 *   GET  /api/v1/security/assessments/:aid/scans        viewer   the scanner runs of one assessment, with what each found and did not cover
 *   GET  /api/v1/security/projects/:id/scans            viewer   the recent scanner runs of this project
 *   GET  /api/v1/security/scanners                      viewer   the platform's scanner settings, with every secret reported only as set or not set
 *
 * What is deliberately NOT here:
 *   - A route that runs a scanner directly. A scan runs as part of an assessment, so it inherits that assessment's authorization,
 *     its rate limit, its exclusions and its cancellation. A separate "run this tool now" endpoint would bypass all four.
 *   - The ZAP API key, any credential, or any address the tool is configured with. `scannerSettingsPublic` reports each of those as
 *     present or absent, and nothing in this file reads a secret out of the settings.
 *   - A way to pass a template, a flag, a path or a command to a tool at run time. Template selection is the reviewed policy's job.
 *
 * The profile a client may ask for is reported, not applied, here: `GET .../scanners?profile=advanced` answers with what that profile
 * would do and whether it is allowed, so the interface can say no before a scan is started rather than failing one halfway through.
 * Which profiles are allowed depends on the application's environment, so `?applicationId=` names the application being judged; without
 * one the answer reports only what does not depend on the environment (an intrusive profile always needs an owner's approval) and says
 * `allowedHere: null` rather than guessing at an environment nobody named.
 */
import { z } from "zod";
import { HttpError } from "../../platform/http-error.js";
import { ASSESSMENT_KINDS, type SecurityEnvironment } from "../contract.js";
import { profileProblem, scannerHealth } from "../scanners/registry.js";
import { listRuns, projectScanners, runsOfAssessment, setProjectScanners } from "../scanners/store.js";
import { scannerSettings, scannerSettingsPublic } from "../scanners/settings.js";
import { approvalProblem, SCAN_PROFILES } from "../scanners/profiles.js";
import { AI_EVALUATION_CASES } from "../scanners/promptfoo/cases.js";
import { SECURITY_API, type SecurityRouteCtx } from "./context.js";

const params = (req: { params: unknown }) => req.params as Record<string, string>;
const query = (req: { query: unknown }) => req.query as Record<string, unknown>;

/** The profile asked for, or the default passive one. An unknown profile is a plain 400 rather than a silent fallback. */
function wantedProfile(req: { query: unknown }): (typeof ASSESSMENT_KINDS)[number] {
    const raw = String(query(req).profile ?? "passive").trim();
    if (!(ASSESSMENT_KINDS as readonly string[]).includes(raw)) throw new HttpError(400, `"${raw}" is not a security scan profile. Use passive, conservative-active or advanced.`);
    return raw as (typeof ASSESSMENT_KINDS)[number];
}

const ScannerIds = z.array(z.enum(["zap", "nuclei", "schemathesis", "promptfoo"])).max(4);

export function registerSecurityScannerRoutes(ctx: SecurityRouteCtx): void {
    const { app, p } = ctx;
    const settings = scannerSettings(p.config as unknown as Record<string, string | undefined>);

    /** Everything a client is told about a profile before starting a scan: what it does, what it never does, and whether it is allowed. */
    const profiles = (environment: SecurityEnvironment | null, hasApproval: boolean) =>
        ASSESSMENT_KINDS.map((id) => {
            const definition = SCAN_PROFILES[id];
            const problem = environment === null ? (approvalProblem(id) ?? undefined) : profileProblem(id, environment, hasApproval) || undefined;
            return {
                id,
                title: definition.title,
                description: definition.description,
                intrusive: definition.intrusive,
                requiresApproval: definition.requiresApproval,
                never: [...definition.never],
                allowedScanners: [...definition.allowedScanners],
                allowedHere: environment === null ? (definition.requiresApproval ? null : true) : problem === undefined,
                problem: problem ?? null,
            };
        });

    app.get(`${SECURITY_API}/projects/:id/scanners`, async (req) => {
        const { id } = params(req);
        ctx.project(id!);
        const profile = wantedProfile(req);
        const named = String(query(req).applicationId ?? "").trim();
        const application = named ? ctx.application(named, req) : null;
        // An application of another project answers 404 here: this route is about the project in the path, not about whatever id was sent.
        if (application && application.projectId !== id) throw new HttpError(404, "Application not found");
        const allowed = projectScanners(p.db, id!);
        const health = await scannerHealth(settings, allowed, profile);
        return {
            profile,
            application: application ? { id: application.id, name: application.name, environment: application.environment } : null,
            profiles: profiles(application?.environment ?? null, false),
            allowed,
            scanners: health,
            aiCases: AI_EVALUATION_CASES.map((c) => ({ id: c.id, category: c.category, what: c.what })),
        };
    });

    app.put(`${SECURITY_API}/projects/:id/scanners`, async (req) => {
        const { id } = params(req);
        const project = ctx.project(id!);
        const body = ctx.body(z.object({ enabled: ScannerIds }), req.body);
        // A scanner the platform has not switched on cannot be allowed here. Which ones were dropped is answered rather than swallowed,
        // so an administrator who ticked a box does not watch it disappear.
        const refused = body.enabled.filter((s) => !settings.enabled.includes(s));
        const known = body.enabled.filter((s) => settings.enabled.includes(s));
        const kept = setProjectScanners(p.db, id!, known);
        ctx.audit({
            projectId: id!,
            action: "scanners.changed",
            objectType: "project",
            objectId: id!,
            summary: `Changed the allowed security scanners for "${project.name}": ${kept.length ? kept.join(", ") : "none"}.`,
        });
        return { allowed: kept, refused, scanners: await scannerHealth(settings, kept, "passive") };
    });

    app.get(`${SECURITY_API}/projects/:id/scans`, async (req) => {
        const { id } = params(req);
        ctx.project(id!);
        return { runs: listRuns(p.db, id!) };
    });

    app.get(`${SECURITY_API}/assessments/:aid/scans`, async (req) => {
        const { aid } = params(req);
        const assessment = ctx.assessment(aid!, req);
        return { assessmentId: assessment.id, profile: assessment.kind, runs: runsOfAssessment(p.db, assessment.id) };
    });

    app.get(`${SECURITY_API}/scanners`, async () => ({
        settings: scannerSettingsPublic(settings),
        profiles: ASSESSMENT_KINDS.map((id) => ({ id, title: SCAN_PROFILES[id].title, description: SCAN_PROFILES[id].description, never: [...SCAN_PROFILES[id].never] })),
        aiCases: AI_EVALUATION_CASES.map((c) => ({ id: c.id, category: c.category, what: c.what })),
    }));
}
