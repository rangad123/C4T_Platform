import { z } from "zod";
import { convertMaestroFlows, MAESTRO_MAX_BYTES, MAESTRO_MAX_FLOWS, type FlowReport } from "../../engine/import/maestro.js";
import { callerCredentials } from "../auth/access.js";
import { HttpError } from "../http-error.js";
import type { RouteCtx } from "./types.js";

const Body = z.object({
    // Counted and measured below, so the answer can say which file is too big.
    files: z.array(z.object({ name: z.string().trim().min(1).max(260), content: z.string() })).min(1, "Add at least one flow file"),
    /** Web flows only: the site to test, when it should not be the origin of the flow's own url. */
    baseUrl: z.string().url().optional(),
    /** Run the imported tests right away (default). */
    validate: z.boolean().default(true),
    /** Only convert and report; store nothing. */
    dryRun: z.boolean().default(false),
});

/** What a person needs to see about one flow: no spec body. */
const publicReport = ({ spec: _spec, ...r }: FlowReport) => r;

/** Maestro and other import routes (Builder W). */
export function registerImportRoutes(ctx: RouteCtx): void {
    const { app, project } = ctx;

    /**
     * Convert Maestro flows to specs and store them through the same route as a spec import, so the same checks apply
     * (address guard, rendering, all-or-nothing storing, validation job). Nothing in a flow is executed.
     */
    app.post("/api/projects/:id/import/maestro", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = Body.parse(req.body);
        if (body.files.length > MAESTRO_MAX_FLOWS) throw new HttpError(400, `Import at most ${MAESTRO_MAX_FLOWS} flows at a time.`);
        const tooBig = body.files.find((f) => Buffer.byteLength(f.content, "utf8") > MAESTRO_MAX_BYTES);
        if (tooBig) throw new HttpError(400, `${tooBig.name} is larger than ${MAESTRO_MAX_BYTES / 1024} KB; a flow that size is probably not a Maestro flow.`);

        const { reports, syntaxErrors } = convertMaestroFlows(body.files);
        if (syntaxErrors.length) throw new HttpError(400, "Some files are not valid YAML. Fix them or leave them out and try again.", syntaxErrors.map((e) => ({ file: e.file, message: e.message })));

        const converted = reports.filter((r) => r.status === "converted");
        const skipped = reports.filter((r) => r.status === "skipped").map((r) => ({ file: r.file, reason: r.reason ?? "Not converted" }));
        const summary = { reports: reports.map(publicReport), skipped };
        if (body.dryRun || converted.length === 0) return reply.code(200).send({ dryRun: body.dryRun, jobId: null, imported: [], ...summary });

        const first = converted[0]!;
        const payload = {
            specs: converted.map((r) => r.spec),
            validate: body.validate,
            ...(first.kind === "mobile" ? { mobile: { appPackage: first.appId } } : { baseUrl: body.baseUrl ?? new URL(first.url!).origin }),
        };
        // The platform's own spec import does the storing; its answer (including its refusals) is passed on as it is.
        const res = await app.inject({ method: "POST", url: `/api/projects/${id}/specs`, payload, headers: callerCredentials(req) });
        const answer = res.body ? (JSON.parse(res.body) as { jobId?: string | null; tests?: Array<{ id: string; testId: string }>; error?: string; details?: unknown; notRun?: string }) : {};
        if (res.statusCode >= 400) throw new HttpError(res.statusCode, answer.error ?? "The tests could not be stored", answer.details);

        const imported = converted.map((r, i) => ({ file: r.file, id: answer.tests?.[i]?.id, testId: answer.tests?.[i]?.testId, title: r.title, kind: r.kind, steps: r.spec!.steps.length, checks: r.checks }));
        // Asked to run them while tests are switched off on this server: kept, and the answer says they were not run.
        return reply.code(answer.jobId ? 202 : 201).send({ dryRun: false, jobId: answer.jobId ?? null, ...(answer.notRun ? { notRun: answer.notRun } : {}), imported, ...summary });
    });
}
