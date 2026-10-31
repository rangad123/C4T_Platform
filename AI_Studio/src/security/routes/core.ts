/**
 * CORE routes of the Security Assessment module: the switch's status, applications, the recorded client authorization, the security
 * activity of a project, and the project's testing type. Roles (src/platform/auth/roles.ts): viewer reads, editor registers and changes
 * applications and the testing type, owner records or revokes an authorization and deletes an application.
 *
 *   GET    /api/v1/security/status                                  { enabled, limits }
 *   GET    /api/v1/security/projects/:id/applications               { applications: [{ ...app, authorization, activeAssessmentId }], limits }
 *   POST   /api/v1/security/projects/:id/applications               201 { application, authorization, statement }
 *   GET    /api/v1/security/applications/:appId                     { application, authorization, currentAuthorization, statement, activeAssessmentId }
 *   PATCH  /api/v1/security/applications/:appId                     { application, authorization, changed }
 *   DELETE /api/v1/security/applications/:appId                     { deleted: true }
 *   GET    /api/v1/security/applications/:appId/authorizations      { authorizations, authorization, statement }
 *   POST   /api/v1/security/applications/:appId/authorizations      201 { authorization: record, state }
 *   DELETE /api/v1/security/authorizations/:authId                  { authorization: record, state, stoppedAssessmentId }
 *   GET    /api/v1/security/projects/:id/activity                   { events }
 *   GET    /api/v1/security/projects/:id/testing-type               { testingType }
 *   PUT    /api/v1/security/projects/:id/testing-type               { testingType }
 */
import net from "node:net";
import { z } from "zod";
import { HttpError } from "../../platform/http-error.js";
import { authorizationStatement } from "../authorization.js";
import { ENVIRONMENTS, type SecurityApplication } from "../contract.js";
import { METADATA_HOSTS, addressClass, staticTargetProblem } from "../scope.js";
import { SECURITY_LIMITS as L, TESTING_TYPES, type ApplicationPatch } from "../store.js";
import { SECURITY_API, type SecurityRouteCtx } from "./context.js";
import { EXTRAS_LIMITS } from "../extras.js";
import { accountNames, signInStatus } from "../signin.js";
import { ACCOUNT_NAME } from "../../platform/session-store.js";

const TEXT_OK = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

const plainText = (max: number, what: string) => z.string().trim().max(max, `${what} can be at most ${max} characters.`).regex(TEXT_OK, `${what} contains characters that are not allowed.`);

const WebAddress = (what: string) =>
    z
        .string()
        .trim()
        .min(1, `Give the ${what}.`)
        .max(L.urlMax, `The ${what} can be at most ${L.urlMax} characters.`)
        .transform((v, ctx) => {
            let u: URL;
            try {
                u = new URL(v);
            } catch {
                ctx.addIssue({ code: "custom", message: `The ${what} is not a web address. Use one like https://shop.example.com.` });
                return z.NEVER;
            }
            if (u.protocol !== "http:" && u.protocol !== "https:") {
                ctx.addIssue({ code: "custom", message: `The ${what} must start with http:// or https://.` });
                return z.NEVER;
            }
            if (u.username || u.password) {
                ctx.addIssue({ code: "custom", message: `Remove the user name and password from the ${what}.` });
                return z.NEVER;
            }
            u.hash = "";
            return u.href;
        });

/** "https://api.example.com" (origin only), "api.example.com", "api.example.com:8443", "*.example.com", an IP address. Lowercased. */
const ScopeEntry = z
    .string()
    .trim()
    .min(1)
    .max(L.scopeEntryMax, `A scope entry can be at most ${L.scopeEntryMax} characters.`)
    .transform((raw, ctx) => {
        const v = raw.toLowerCase();
        const bad = (message: string) => {
            ctx.addIssue({ code: "custom", message });
            return z.NEVER;
        };
        if (v.includes("://")) {
            let u: URL;
            try {
                u = new URL(v);
            } catch {
                return bad(`“${raw}” is not a web address.`);
            }
            if (u.protocol !== "http:" && u.protocol !== "https:") return bad(`“${raw}”: only http and https origins can be in scope.`);
            if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return bad(`“${raw}”: give only the origin (scheme, host and port), without a path.`);
            return u.origin;
        }
        if (v.startsWith("*.")) {
            if (!/^\*\.([a-z0-9-]+\.)+[a-z0-9-]+$/.test(v)) return bad(`“${raw}”: a pattern needs at least two name parts after “*.”, like *.example.com.`);
            return v;
        }
        const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(v);
        if (!m || (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535))) return bad(`“${raw}” is not a host name, an origin or a *.domain pattern.`);
        const host = m[1]!.replace(/^\[|\]$/g, "");
        if (!net.isIP(host) && !/^([a-z0-9-]+\.)*[a-z0-9-]+$/.test(host)) return bad(`“${raw}” is not a host name.`);
        return v;
    });

const ExcludedPath = z
    .string()
    .trim()
    .max(L.excludedPathMax, `An excluded path can be at most ${L.excludedPathMax} characters.`)
    .regex(/^\/\S*$/, "An excluded path starts with / and has no spaces, like /admin/billing.");

const nullableText = (max: number, what: string) =>
    plainText(max, what)
        .nullable()
        .optional()
        .transform((v) => (v ? v : v === undefined ? undefined : null));

/** Round 20 (SIGN): the saved sign-in an assessment loads ("main" or a test account's name; never a password), and sensitive workflows. */
const SignInAccount = z.string().trim().regex(ACCOUNT_NAME, "Choose “main” (the project's own sign-in) or the name of a test account.").nullable();
const SensitiveWorkflowBody = z
    .object({
        name: plainText(EXTRAS_LIMITS.workflowNameMax, "The workflow's name").min(1, "Give each sensitive workflow a name."),
        pathPrefixes: z
            .array(ExcludedPath)
            .min(1, "Give each sensitive workflow at least one path, like /checkout.")
            .max(EXTRAS_LIMITS.workflowPrefixes, `A sensitive workflow can have at most ${EXTRAS_LIMITS.workflowPrefixes} paths.`),
        note: nullableText(EXTRAS_LIMITS.workflowNoteMax, "The workflow's note").transform((v) => v ?? null),
    })
    .strict()
    .transform((w) => ({ name: w.name, pathPrefixes: [...new Set(w.pathPrefixes)], note: w.note }));
const SensitiveWorkflows = z.array(SensitiveWorkflowBody).max(EXTRAS_LIMITS.sensitiveWorkflows, `At most ${EXTRAS_LIMITS.sensitiveWorkflows} sensitive workflows.`);

const ApplicationFields = {
    name: plainText(L.nameMax, "The name").min(1, "Give the application a name."),
    targetUrl: WebAddress("target address"),
    environment: z.enum(ENVIRONMENTS, { message: "Choose the environment: development, staging, production or other." }),
    scope: z.array(ScopeEntry).max(L.scopeEntries, `At most ${L.scopeEntries} scope entries.`),
    excludedPaths: z.array(ExcludedPath).max(L.excludedPaths, `At most ${L.excludedPaths} excluded paths.`),
    maxRequestsPerSecond: z.number({ message: "The request limit is a whole number from 1 to 10." }).int("The request limit is a whole number from 1 to 10.").min(L.rpsMin, "The request limit is at least 1 per second.").max(L.rpsMax, "The request limit is at most 10 per second."),
    apiSpecUrl: WebAddress("API document address").nullable(),
    notes: plainText(L.notesMax, "Notes").nullable(),
};

const CreateApplication = z
    .object({
        name: ApplicationFields.name,
        targetUrl: ApplicationFields.targetUrl,
        environment: ApplicationFields.environment,
        scope: ApplicationFields.scope.default([]),
        excludedPaths: ApplicationFields.excludedPaths.default([]),
        maxRequestsPerSecond: ApplicationFields.maxRequestsPerSecond.default(L.rpsDefault),
        apiSpecUrl: ApplicationFields.apiSpecUrl.optional().default(null),
        notes: nullableText(L.notesMax, "Notes").default(null),
        signInAccount: SignInAccount.optional().default(null),
        sensitiveWorkflows: SensitiveWorkflows.default([]),
    })
    .strict();

const PatchApplication = z
    .object({
        name: ApplicationFields.name.optional(),
        targetUrl: ApplicationFields.targetUrl.optional(),
        environment: ApplicationFields.environment.optional(),
        scope: ApplicationFields.scope.optional(),
        excludedPaths: ApplicationFields.excludedPaths.optional(),
        maxRequestsPerSecond: ApplicationFields.maxRequestsPerSecond.optional(),
        apiSpecUrl: ApplicationFields.apiSpecUrl.optional(),
        notes: nullableText(L.notesMax, "Notes"),
        signInAccount: SignInAccount.optional(),
        sensitiveWorkflows: SensitiveWorkflows.optional(),
    })
    .strict();

const RecordAuthorization = z
    .object({
        basis: z.enum(["owner", "client-permission"], { message: "Say whether you own the application or have the owner's documented permission." }),
        approverName: plainText(L.approverNameMax, "The approver's name").min(1, "Give the name of the person who approved the assessment."),
        approverEmail: z
            .string()
            .trim()
            .max(L.emailMax)
            .email("The approver's email address does not look right.")
            .nullable()
            .optional()
            .or(z.literal("").transform(() => null)),
        documentReference: nullableText(L.documentReferenceMax, "The document reference"),
        restrictions: nullableText(L.restrictionsMax, "The restrictions"),
        confirm: z.boolean({ message: "Tick the box to confirm the statement." }).refine((v) => v === true, { message: "Tick the box to confirm the statement." }),
    })
    .strict();

const TestingTypeBody = z.object({ testingType: z.enum(TESTING_TYPES, { message: "Choose functional, security or both." }) }).strict();

const ActivityQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    before: z.coerce.number().int().min(1).optional(),
    applicationId: z.string().max(100).optional(),
});

const SCOPE_FIELDS = ["targetUrl", "scope", "excludedPaths", "maxRequestsPerSecond", "signInAccount", "sensitiveWorkflows"] as const;
const FIELD_WORDS: Record<keyof ApplicationPatch, string> = {
    name: "name",
    targetUrl: "target",
    environment: "environment",
    scope: "scope",
    excludedPaths: "excluded paths",
    maxRequestsPerSecond: "request limit",
    apiSpecUrl: "API document address",
    notes: "notes",
    signInAccount: "saved sign-in",
    sensitiveWorkflows: "sensitive workflows",
};

export function registerSecurityCoreRoutes(ctx: SecurityRouteCtx): void {
    const { app, store, settings } = ctx;
    const params = (req: { params: unknown }) => req.params as Record<string, string>;

    /** Addresses that are never allowed, or not under the private-target setting: said at registration, checked again (with DNS) at every request. */
    const assertTargets = (fields: { targetUrl?: string; scope?: string[]; apiSpecUrl?: string | null }) => {
        if (fields.targetUrl) {
            const problem = staticTargetProblem(fields.targetUrl, settings.allowPrivateTargets);
            if (problem) throw new HttpError(400, problem);
        }
        if (fields.apiSpecUrl) {
            const problem = staticTargetProblem(fields.apiSpecUrl, settings.allowPrivateTargets);
            if (problem) throw new HttpError(400, `API document address: ${problem}`);
        }
        for (const entry of fields.scope ?? []) {
            const host = (entry.includes("://") ? new URL(entry).hostname : entry.replace(/^\*\./, "").replace(/:\d+$/, "")).replace(/^\[|\]$/g, "");
            if (METADATA_HOSTS.has(host) || addressClass(host) === "cloud-metadata") throw new HttpError(400, `${entry} is a cloud metadata service; it can never be in scope.`);
            if (!settings.allowPrivateTargets && (addressClass(host) || host === "localhost" || host.endsWith(".localhost"))) {
                throw new HttpError(400, `${entry} is a private or local address. Private targets are refused unless the platform setting SECURITY_ALLOW_PRIVATE_TARGETS is on.`);
            }
        }
    };

    /** Round 20 (SIGN): a named sign-in must be the project's own, one of its test accounts, or one with a saved sign-in. */
    const assertAccount = (projectId: string, account: string | null | undefined) => {
        if (!account) return;
        const saved = ctx.p.db.get("SELECT 1 AS x FROM saved_sessions WHERE project_id = ? AND account = ?", projectId, account) !== undefined;
        if (!saved && !accountNames(ctx.p.db, ctx.p.config, projectId).includes(account)) throw new HttpError(400, `There is no test account named “${account}”. Add it under Test accounts first, or choose “main”.`);
    };
    const signInView = (a: SecurityApplication) => (a.signInAccount ? signInStatus(ctx.p.db, ctx.p.config, a.projectId, a.signInAccount, a) : null);

    const statementFor = (a: SecurityApplication) => authorizationStatement(String(ctx.project(a.projectId).name ?? ""), a);
    const appView = (a: SecurityApplication) => ({ ...a, authorization: store.authorizationState(a), activeAssessmentId: store.activeAssessment(a.id)?.id ?? null });
    const limits = () => ({
        applicationsPerProject: L.applicationsPerProject,
        maxRequestsPerSecond: { min: L.rpsMin, max: L.rpsMax, default: L.rpsDefault },
        maxRequestsPerAssessment: settings.maxRequestsPerAssessment,
        maxResponseBytes: settings.maxResponseBytes,
        assessmentMinutes: settings.assessmentMinutes,
        retentionDays: settings.retentionDays,
        privateTargetsAllowed: settings.allowPrivateTargets,
        scopeEntries: L.scopeEntries,
        excludedPaths: L.excludedPaths,
    });

    app.get(`${SECURITY_API}/status`, async () => ({ enabled: settings.enabled, limits: limits() }));

    // ── applications ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    app.get(`${SECURITY_API}/projects/:id/applications`, async (req) => {
        const { id } = params(req);
        ctx.project(id);
        return { applications: store.listApplications(id).map(appView), limits: limits() };
    });

    app.post(`${SECURITY_API}/projects/:id/applications`, async (req, reply) => {
        const { id } = params(req);
        const project = ctx.project(id);
        const body = ctx.body(CreateApplication, req.body);
        assertTargets(body);
        assertAccount(id, body.signInAccount);
        if (store.countApplications(id) >= L.applicationsPerProject) throw new HttpError(409, `This project already has ${L.applicationsPerProject} applications, the most it can have. Delete one you no longer assess first.`);
        const created = store.createApplication(id, { ...body, notes: body.notes ?? null });
        ctx.audit({ projectId: id, applicationId: created.id, action: "application.created", objectType: "application", objectId: created.id, summary: `Added the application “${created.name}” (${created.targetUrl}, ${created.environment}) to “${project.name}”.` });
        reply.code(201);
        return { application: appView(created), authorization: store.authorizationState(created), statement: statementFor(created) };
    });

    app.get(`${SECURITY_API}/applications/:appId`, async (req) => {
        const a = ctx.application(params(req).appId!, req);
        return { application: appView(a), authorization: store.authorizationState(a), currentAuthorization: store.currentAuthorization(a) ?? null, statement: statementFor(a), activeAssessmentId: store.activeAssessment(a.id)?.id ?? null, signIn: signInView(a) };
    });

    app.patch(`${SECURITY_API}/applications/:appId`, async (req) => {
        const cur = ctx.application(params(req).appId!, req);
        const patch = ctx.body(PatchApplication, req.body) as ApplicationPatch;
        const changed = (Object.keys(patch) as Array<keyof ApplicationPatch>).filter((k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(cur[k]));
        if (!changed.length) return { application: appView(cur), authorization: store.authorizationState(cur), changed: [] };
        const scopeChanged = changed.some((k) => (SCOPE_FIELDS as readonly string[]).includes(k));
        if (scopeChanged && store.activeAssessment(cur.id)) throw new HttpError(409, "An assessment of this application is running. Wait for it to finish or cancel it before changing the target, scope, exclusions, request limit, saved sign-in or sensitive workflows.");
        assertTargets({ ...(changed.includes("targetUrl") ? { targetUrl: patch.targetUrl! } : {}), ...(changed.includes("scope") ? { scope: patch.scope! } : {}), ...(changed.includes("apiSpecUrl") ? { apiSpecUrl: patch.apiSpecUrl ?? null } : {}) });
        if (changed.includes("signInAccount")) assertAccount(cur.projectId, patch.signInAccount);
        const before = store.authorizationState(cur);
        const next = store.updateApplication(cur.id, Object.fromEntries(changed.map((k) => [k, patch[k]])) as ApplicationPatch)!;
        const after = store.authorizationState(next);
        const staleNow = before.state === "current" && after.state === "stale" ? " The authorization no longer matches and must be recorded again." : "";
        ctx.audit({ projectId: next.projectId, applicationId: next.id, action: "application.changed", objectType: "application", objectId: next.id, summary: `Changed the ${changed.map((k) => FIELD_WORDS[k]).join(", ")} of “${next.name}”.${staleNow}` });
        return { application: appView(next), authorization: after, changed };
    });

    app.delete(`${SECURITY_API}/applications/:appId`, async (req) => {
        const a = ctx.application(params(req).appId!, req);
        if (store.activeAssessment(a.id)) throw new HttpError(409, "An assessment of this application is running. Cancel it first, then delete the application.");
        const findings = store.countFindingsOfApplication(a.id);
        store.deleteApplication(a.id);
        ctx.audit({ projectId: a.projectId, applicationId: a.id, action: "application.deleted", objectType: "application", objectId: a.id, summary: `Deleted the application “${a.name}” (${a.targetUrl}) with its authorizations, assessments and ${findings} finding${findings === 1 ? "" : "s"}.` });
        return { deleted: true };
    });

    // ── authorizations ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
    app.get(`${SECURITY_API}/applications/:appId/authorizations`, async (req) => {
        const a = ctx.application(params(req).appId!, req);
        return { authorizations: store.listAuthorizations(a.id), authorization: store.authorizationState(a), statement: statementFor(a) };
    });

    app.post(`${SECURITY_API}/applications/:appId/authorizations`, async (req, reply) => {
        const a = ctx.application(params(req).appId!, req);
        const body = ctx.body(RecordAuthorization, req.body);
        if (store.countAuthorizations(a.id) >= L.authorizationsPerApplication) throw new HttpError(409, `This application already has ${L.authorizationsPerApplication} recorded authorizations, the most it can keep.`);
        const actor = ctx.actor(req);
        const record = store.addAuthorization(a.id, {
            basis: body.basis,
            approverName: body.approverName,
            approverEmail: body.approverEmail ?? null,
            documentReference: body.documentReference ?? null,
            restrictions: body.restrictions ?? null,
            statement: statementFor(a),
            confirmedByUserId: actor.kind === "user" ? (actor.id ?? null) : null,
            confirmedByName: actor.name,
        });
        const basis = body.basis === "owner" ? "the organization owns it" : "the owner gave documented permission";
        ctx.audit({ projectId: a.projectId, applicationId: a.id, action: "authorization.recorded", objectType: "authorization", objectId: record.id, summary: `Recorded the authorization to assess “${a.name}” (${basis}), approved by ${body.approverName}${body.documentReference ? `, reference ${body.documentReference}` : ""}.` });
        reply.code(201);
        return { authorization: record, state: store.authorizationState(a) };
    });

    app.delete(`${SECURITY_API}/authorizations/:authId`, async (req) => {
        const auth = ctx.authorization(params(req).authId!, req);
        const a = ctx.application(auth.applicationId);
        if (auth.revokedAt) return { authorization: store.getAuthorization(auth.id), state: store.authorizationState(a), stoppedAssessmentId: null };
        const record = store.revokeAuthorization(auth.id, ctx.actorName(req), "Revoked.");
        // No assessment goes on without a current authorization: one that is running is asked to stop (the assessment loop honours it).
        const active = store.activeAssessment(a.id);
        const stopped = active && store.requestCancel(active.id) ? active.id : null;
        ctx.audit({ projectId: a.projectId, applicationId: a.id, action: "authorization.revoked", objectType: "authorization", objectId: auth.id, summary: `Revoked the authorization to assess “${a.name}”.${stopped ? " The running assessment was asked to stop." : ""}` });
        return { authorization: record, state: store.authorizationState(a), stoppedAssessmentId: stopped };
    });

    // ── the project's security activity and testing type ─────────────────────────────────────────────────────────────────────────────
    app.get(`${SECURITY_API}/projects/:id/activity`, async (req) => {
        const { id } = params(req);
        ctx.project(id);
        const q = ctx.body(ActivityQuery, req.query);
        return { events: store.listAudit(id, { ...(q.limit ? { limit: q.limit } : {}), ...(q.before ? { before: q.before } : {}), ...(q.applicationId ? { applicationId: q.applicationId } : {}) }) };
    });

    app.get(`${SECURITY_API}/projects/:id/testing-type`, async (req) => {
        const { id } = params(req);
        ctx.project(id);
        return { testingType: store.testingType(id) };
    });

    app.put(`${SECURITY_API}/projects/:id/testing-type`, async (req) => {
        const { id } = params(req);
        const project = ctx.project(id);
        const { testingType } = ctx.body(TestingTypeBody, req.body);
        const before = store.testingType(id);
        if (before !== testingType) {
            store.setTestingType(id, testingType);
            const words = { functional: "functional testing", security: "security assessment", both: "functional testing and security assessment" } as const;
            ctx.audit({ projectId: id, action: "testing-type.changed", objectType: "project", objectId: id, summary: `Set the testing type of “${project.name}” to ${words[testingType]} (was ${words[before]}).` });
        }
        return { testingType };
    });
}
