/**
 * FIND routes of the Security Assessment module: findings, validation, manual entry, the overview and the reports.
 * Permissions (src/platform/auth/roles.ts): reading needs access, report downloads reports.export; validating and entering findings
 * needs security.use; marking a finding an accepted risk is a business decision and needs tests.approve (checked here: owners only
 * on a local install). Every object is checked against the project it belongs to.
 *
 *   GET   /api/v1/security/projects/:id/findings            ?application&severity&category&validation&from&to&location&q&limit&offset
 *                                                           (severity/category/validation: one value or a comma list)  { findings, total, limit, offset }
 *   GET   /api/v1/security/findings/:fid                    { finding, history, application: { id, name }, sightings }
 *   PATCH /api/v1/security/findings/:fid                    { validation, comment }  -> { finding, history }
 *   POST  /api/v1/security/applications/:appId/findings     manual entry (service.ts ManualFinding)  201 { finding }
 *   GET   /api/v1/security/projects/:id/overview            overview.ts SecurityOverview
 *   GET   /api/v1/security/assessments/:aid/report          ?format=html|pdf|csv|xlsx (&download=1 for an html file)
 *   GET   /api/v1/security/projects/:id/report              same formats, every finding of the project
 * Report exports are recorded in the security trail and Activity.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isCrowd4TestActor, permissionRefusal, permissionsOf, type Actor } from "../../platform/auth/actor.js";
import { HttpError } from "../../platform/http-error.js";
import { toPdf } from "../../platform/pdf.js";
import { CATEGORIES, SEVERITIES, VALIDATION_STATES, type SecurityFinding } from "../contract.js";
import { computeOverview } from "../findings/overview.js";
import { buildReport, renderReportCsv, renderReportHtml, reportFileBase, type SecurityReportData } from "../findings/report.js";
import { renderReportXlsx, XLSX_CONTENT_TYPE } from "../findings/xlsx.js";
import { changeValidation, createManualFinding, FindingError, ManualFinding, ValidationPatch } from "../findings/service.js";
import type { SecurityStore } from "../store.js";
import { SECURITY_API, type SecurityRouteCtx } from "./context.js";

/** A comma list (or one value) of allowed words; an unknown word is a plain 400. */
const list = <T extends string>(allowed: readonly T[], what: string) =>
    z
        .string()
        .max(500)
        .optional()
        .transform((v, ctx) => {
            if (!v) return undefined;
            const parts = [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))];
            const bad = parts.find((p) => !(allowed as readonly string[]).includes(p));
            if (bad) {
                ctx.addIssue({ code: "custom", message: `Unknown ${what} “${bad.slice(0, 40)}”. Use one of: ${allowed.join(", ")}.` });
                return z.NEVER;
            }
            return parts as T[];
        });

const isoDate = (what: string) =>
    z
        .string()
        .max(40)
        .optional()
        .transform((v, ctx) => {
            if (!v) return undefined;
            const t = Date.parse(v);
            if (Number.isNaN(t)) {
                ctx.addIssue({ code: "custom", message: `The ${what} date is not a date. Use one like 2026-05-31.` });
                return z.NEVER;
            }
            return new Date(t).toISOString();
        });

const FindingQuery = z.object({
    application: z.string().max(100).optional(),
    severity: list(SEVERITIES, "severity"),
    category: list(CATEGORIES, "category"),
    validation: list(VALIDATION_STATES, "validation state"),
    from: isoDate("from"),
    // A bare day ("2026-05-31") includes that whole day.
    to: z
        .string()
        .max(40)
        .optional()
        .transform((v, ctx) => {
            if (!v) return undefined;
            const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v);
            if (Number.isNaN(t)) {
                ctx.addIssue({ code: "custom", message: "The to date is not a date. Use one like 2026-05-31." });
                return z.NEVER;
            }
            return new Date(t).toISOString();
        }),
    location: z.string().max(500).optional(),
    q: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    projectId: z.string().optional(),
});

const ReportQuery = z.object({ format: z.enum(["html", "pdf", "csv", "xlsx"]).default("html"), download: z.enum(["0", "1", "true", "false"]).optional(), projectId: z.string().optional() });

/** Every finding of a project, page by page (the store answers at most 1000 per call). */
function allFindings(store: SecurityStore, projectId: string, cap = 20_000): SecurityFinding[] {
    const out: SecurityFinding[] = [];
    for (let offset = 0; offset < cap; offset += 1000) {
        const page = store.listFindings({ projectId, limit: 1000, offset });
        out.push(...page);
        if (page.length < 1000) break;
    }
    return out;
}

const asFinding = (f: SecurityFinding & { checkId?: string | null }): SecurityFinding & { checkId: string | null } => ({ ...f, checkId: f.checkId ?? null });

export function registerSecurityFindingRoutes(ctx: SecurityRouteCtx): void {
    const { app, store } = ctx;

    const wrap = <T>(fn: () => T): T => {
        try {
            return fn();
        } catch (e) {
            if (e instanceof FindingError) throw new HttpError(e.status, e.message);
            throw e;
        }
    };

    app.get(`${SECURITY_API}/projects/:id/findings`, async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const q = ctx.body(FindingQuery, req.query);
        // An application of another project is unknown here.
        if (q.application) {
            const a = store.getApplication(q.application);
            if (!a || a.projectId !== id) throw new HttpError(404, "Application not found");
        }
        const filter = { projectId: id, applicationId: q.application, severities: q.severity, categories: q.category, validations: q.validation, from: q.from, to: q.to, location: q.location, q: q.q };
        return { findings: store.listFindings({ ...filter, limit: q.limit, offset: q.offset }).map(asFinding), total: store.countFindings(filter), limit: q.limit, offset: q.offset };
    });

    app.get(`${SECURITY_API}/findings/:fid`, async (req) => {
        const f = ctx.finding((req.params as { fid: string }).fid, req);
        const application = store.getApplication(f.applicationId);
        const sightings = sightingsOf(store, f.id, f.projectId);
        return { finding: f, history: store.findingHistory(f.id), application: application ? { id: application.id, name: application.name, targetUrl: application.targetUrl } : null, sightings };
    });

    app.patch(`${SECURITY_API}/findings/:fid`, async (req) => {
        const f = ctx.finding((req.params as { fid: string }).fid, req);
        const patch = ctx.body(ValidationPatch, req.body);
        if (patch.validation === "accepted-risk" && f.validation !== "accepted-risk" && !mayAcceptRisk(ctx.actor(req))) {
            throw new HttpError(403, riskRefusal(ctx.actor(req), "Accepting a risk is a decision for an owner of this platform. Ask an owner, or choose another state."));
        }
        const updated = wrap(() => changeValidation(store, f, patch));
        if (updated.validation !== f.validation) {
            ctx.audit({
                projectId: f.projectId,
                applicationId: f.applicationId,
                action: "finding.validation-changed",
                objectType: "finding",
                objectId: f.id,
                summary: `Changed “${f.title.slice(0, 120)}” from ${f.validation} to ${updated.validation}.`,
            });
        }
        return { finding: store.getFinding(f.id), history: store.findingHistory(f.id) };
    });

    app.post(`${SECURITY_API}/applications/:appId/findings`, async (req, reply) => {
        const application = ctx.application((req.params as { appId: string }).appId, req);
        const input = ctx.body(ManualFinding, req.body);
        if (input.validation === "accepted-risk" && !mayAcceptRisk(ctx.actor(req))) {
            throw new HttpError(403, riskRefusal(ctx.actor(req), "Accepting a risk is a decision for an owner of this platform. Enter the finding as needs review, and ask an owner."));
        }
        const finding = wrap(() => createManualFinding(store, application, input));
        ctx.audit({
            projectId: application.projectId,
            applicationId: application.id,
            action: "finding.created",
            objectType: "finding",
            objectId: finding.id,
            summary: `Entered the ${finding.severity} finding “${finding.title.slice(0, 120)}” by hand for “${application.name}”.`,
        });
        return reply.code(201).send({ finding: store.getFinding(finding.id) });
    });

    app.get(`${SECURITY_API}/projects/:id/overview`, async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const findings = allFindings(store, id);
        const fixedByRetest = new Map<string, { at: string; retestId: string | null }>();
        for (const f of findings) {
            if (f.validation !== "fixed") continue;
            const h = store.findingHistory(f.id).filter((e) => e.to === "fixed").at(-1);
            const by = h?.assessmentId ? store.getAssessment(h.assessmentId) : undefined;
            if (h && by?.retestOf) fixedByRetest.set(f.id, { at: h.at, retestId: by.id });
        }
        return computeOverview({ applications: store.listApplications(id), assessments: store.listAssessments({ projectId: id, limit: 500 }), findings, fixedByRetest });
    });

    const sendReport = async (req: FastifyRequest, reply: FastifyReply, data: SecurityReportData) => {
        const { format, download } = ctx.body(ReportQuery, req.query);
        const base = reportFileBase(data);
        const what = data.kind === "assessment" ? `the report of the assessment of “${data.applications[0]?.app.name ?? "an application"}”` : "the project's security report";
        ctx.audit({
            projectId: data.projectId,
            applicationId: data.kind === "assessment" ? (data.applications[0]?.app.id ?? null) : null,
            action: "report.exported",
            objectType: "report",
            objectId: data.kind === "assessment" ? (data.assessments[0]?.id ?? null) : data.projectId,
            summary: `Exported ${what} as ${format.toUpperCase()} (${data.findings.length} finding${data.findings.length === 1 ? "" : "s"}).`,
        });
        // An Excel workbook (src/security/findings/xlsx.ts): a Summary sheet and the CSV's findings, every cell text or a number.
        if (format === "xlsx") {
            return reply.header("content-type", XLSX_CONTENT_TYPE).header("content-disposition", `attachment; filename="${base}.xlsx"`).send(Buffer.from(renderReportXlsx(data)));
        }
        if (format === "csv") {
            return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${base}.csv"`).send(renderReportCsv(data));
        }
        const html = renderReportHtml(data);
        if (format === "pdf") {
            const pdf = await toPdf(html, ctx.p.config.HEADLESS);
            return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="${base}.pdf"`).send(pdf);
        }
        // Shown inside the app or saved as a file; either way the page can run nothing and load nothing.
        return reply
            .header("content-type", "text/html; charset=utf-8")
            .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'")
            .header("x-content-type-options", "nosniff")
            .header("content-disposition", `${download === "1" || download === "true" ? "attachment" : "inline"}; filename="${base}.html"`)
            .send(html);
    };

    app.get(`${SECURITY_API}/assessments/:aid/report`, async (req, reply) => {
        const a = ctx.assessment((req.params as { aid: string }).aid, req);
        const data = buildReport(ctx.p.db, { assessmentId: a.id });
        if (!data) throw new HttpError(404, "Assessment not found");
        return sendReport(req, reply, data);
    });

    app.get(`${SECURITY_API}/projects/:id/report`, async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const data = buildReport(ctx.p.db, { projectId: id });
        if (!data) throw new HttpError(404, "Project not found");
        return sendReport(req, reply, data);
    });
}

/** The assessments that saw a finding (newest first, at most 20), for the detail page's "seen in" list. */
function sightingsOf(store: SecurityStore, findingId: string, projectId: string): Array<{ assessmentId: string; createdAt: string; state: string }> {
    return store
        .listAssessments({ projectId, limit: 200 })
        .filter((a) => store.findingIdsSeenIn(a.id).has(findingId))
        .slice(0, 20)
        .map((a) => ({ assessmentId: a.id, createdAt: a.createdAt, state: a.state }));
}

/** Accepting a risk is a sign-off: tests.approve, which on a local install only owners hold (so this reads as before for them). */
const mayAcceptRisk = (actor: Actor) => permissionsOf(actor).has("ai_studio.tests.approve");
const riskRefusal = (actor: Actor, local: string) => (isCrowd4TestActor(actor) ? permissionRefusal(actor, "ai_studio.tests.approve") : local);
