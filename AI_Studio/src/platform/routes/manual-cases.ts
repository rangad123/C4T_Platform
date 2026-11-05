import { z } from "zod";
import { ManualCaseInputSchema, MAX_CASES, MAX_NAME, MAX_NOTE, ResultInputSchema, clean } from "../../engine/manual/cases.js";
import { casesToCsv, casesToJson, ManualImportError, parseImport } from "../../engine/manual/csv.js";
import { HttpError } from "../http-error.js";
import { buildManualIssueDraft } from "../issues/manual.js";
import { TrackerError } from "../issues/http.js";
import { IntegrationStore } from "../issues/store.js";
import { keptSnapshot, newReleaseSnapshot, releaseSummaries, releaseView, reopenRelease, requireOpen, signRelease } from "../manual-releases.js";
import { ManualCaseStore, MAX_RELEASES } from "../manual-case-store.js";
import { RequirementStore } from "../requirement-store.js";
import { releaseReportName, renderReleaseHtml } from "../reports/release-report.js";
import { SecretBox } from "../secrets.js";
import type { RouteCtx } from "./types.js";

/**
 * Written test cases (automated or manual by type; the "manual cases" of earlier versions) and release sign-off.
 *
 *   GET/POST        /api/projects/:id/manual-cases                      list, add
 *   GET/PUT/DELETE  /api/projects/:id/manual-cases/:cid                 one case
 *   POST            /api/projects/:id/manual-cases/import               { format?, content } JSON or CSV
 *   GET             /api/projects/:id/manual-cases/export?format=json|csv
 *   GET/POST        /api/projects/:id/releases                          list, open a release
 *   GET             /api/projects/:id/releases/:rid                     everything about one release
 *   POST            /api/projects/:id/releases/:rid/refresh             take the automated state again (open releases)
 *   PUT             /api/projects/:id/releases/:rid/results/:cid        { result, note?, by? }
 *   POST            /api/projects/:id/releases/:rid/results/:cid/issue  { integrationId } file an issue for a failed check
 *   POST            /api/projects/:id/releases/:rid/signoff             { decision, by, comment?, override? }
 *   POST            /api/projects/:id/releases/:rid/reopen              { by, comment }
 *   GET             /api/projects/:id/releases/:rid/report?format=html
 *
 * Every lookup is by project and id together, so one project can never read or change another project's cases or releases.
 */

const Text = (max: number, what: string) =>
    z
        .string({ invalid_type_error: `${what} must be text` })
        .transform(clean)
        .pipe(z.string().max(max, `${what} can be at most ${max} characters`));
const Required = (max: number, what: string) => Text(max, what).pipe(z.string().min(1, `${what} is required`));

const NewRelease = z.object({ name: Required(80, "The release name"), notes: Text(1000, "The notes").default("") });
const Signoff = z.object({
    decision: z.enum(["approved", "rejected"]),
    by: Required(MAX_NAME, "Your name"),
    comment: Text(MAX_NOTE, "The comment").default(""),
    override: z.boolean().default(false),
});
const Reopen = z.object({ by: Required(MAX_NAME, "Your name"), comment: Required(MAX_NOTE, "The comment") });
const ImportBody = z.object({
    format: z.enum(["json", "csv"]).optional(),
    content: z.union([z.string().min(1, "There is nothing to import"), z.array(z.unknown()), z.object({}).passthrough()]),
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";

export function registerManualCaseRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = new ManualCaseStore(p.db);
    // Same key as the repository's own SecretBox, as in the issue-tracker routes.
    const integrations = new IntegrationStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));
    /** Requests in flight per check: a double click must not file two issues. */
    const inFlight = new Map<string, Promise<unknown>>();
    const projectId = (req: { params: unknown }): string => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return id;
    };
    const getCase = (pid: string, cid: string) => {
        const c = store.getCase(pid, cid);
        if (!c) throw new HttpError(404, "Test case not found");
        return c;
    };
    const getRelease = (pid: string, rid: string) => {
        const r = store.getRelease(pid, rid);
        if (!r) throw new HttpError(404, "Release not found");
        return r;
    };
    const limit = (e: unknown): never => {
        if (e instanceof Error && e.message === "limit") throw new HttpError(409, `A project can have at most ${MAX_CASES} manual cases.`);
        throw e;
    };
    /** Linked tests must be this project's own. */
    const checkLinked = (pid: string, ids: string[]) => {
        for (const id of ids) if (repo.getTest(id)?.projectId !== pid) throw new HttpError(400, "A linked test does not belong to this project.");
    };
    const requirements = new RequirementStore(p.sql);
    /** The requirement a case comes from must be one of this project's records. */
    const checkRequirement = async (pid: string, rid: string | null | undefined) => {
        if (rid && !(await requirements.get(pid, rid))) throw new HttpError(400, "The requirement does not belong to this project.");
    };
    /** A case that comes from a requirement also covers it (the requirement's coverage counts it). */
    const linkRequirement = async (pid: string, c: { id: string; requirementId: string | null }) => {
        if (c.requirementId) await requirements.link(pid, c.requirementId, { automated: [], manual: [c.id] });
    };

    // ── manual cases ───────────────────────────────────────────────────────────
    app.get("/api/projects/:id/manual-cases", async (req) => {
        const pid = projectId(req);
        const cases = store.listCases(pid);
        return { cases, total: cases.length, max: MAX_CASES, areas: [...new Set(cases.map((c) => c.area))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })) };
    });

    app.post("/api/projects/:id/manual-cases", async (req, reply) => {
        const pid = projectId(req);
        const input = ManualCaseInputSchema.parse(req.body);
        checkLinked(pid, input.linkedTestIds);
        await checkRequirement(pid, input.requirementId);
        let made;
        try {
            made = store.createCase(pid, input);
        } catch (e) {
            return limit(e);
        }
        await linkRequirement(pid, made);
        return reply.code(201).send(made);
    });

    app.post("/api/projects/:id/manual-cases/import", async (req, reply) => {
        const pid = projectId(req);
        const body = ImportBody.parse(req.body);
        let parsed;
        try {
            parsed = parseImport(body.content, body.format);
        } catch (e) {
            if (e instanceof ManualImportError) throw new HttpError(400, e.message);
            throw e;
        }
        for (const c of parsed.cases) checkLinked(pid, c.linkedTestIds);
        try {
            // A file names no requirement record of this project (their ids are not portable): its cases come in without one.
            const r = store.importCases(pid, parsed.cases.map((c) => ({ ...c, requirementId: undefined })));
            return reply.code(r.created.length ? 201 : 200).send({ created: r.created.length, duplicates: r.duplicates, skipped: parsed.skipped, total: store.countCases(pid) });
        } catch (e) {
            if (e instanceof Error && e.message === "limit") throw new HttpError(409, `Importing these would pass the ${MAX_CASES} manual cases a project can have. Nothing was imported.`);
            throw e;
        }
    });

    app.get("/api/projects/:id/manual-cases/export", async (req, reply) => {
        const pid = projectId(req);
        const { format } = z.object({ format: z.enum(["json", "csv"]).default("json") }).parse(req.query);
        const cases = store.listCases(pid);
        const base = `manual-cases-${slug(String(ctx.project(pid).name))}`;
        if (format === "csv") return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${base}.csv"`).send(casesToCsv(cases));
        return reply.header("content-type", "application/json; charset=utf-8").header("content-disposition", `attachment; filename="${base}.json"`).send(casesToJson(cases));
    });

    app.get("/api/projects/:id/manual-cases/:cid", async (req) => {
        const pid = projectId(req);
        return getCase(pid, (req.params as { cid: string }).cid);
    });

    app.put("/api/projects/:id/manual-cases/:cid", async (req) => {
        const pid = projectId(req);
        const { cid } = req.params as { cid: string };
        getCase(pid, cid);
        const input = ManualCaseInputSchema.parse(req.body);
        checkLinked(pid, input.linkedTestIds);
        await checkRequirement(pid, input.requirementId);
        const saved = store.updateCase(pid, cid, input)!;
        await linkRequirement(pid, saved);
        return saved;
    });

    app.delete("/api/projects/:id/manual-cases/:cid", async (req, reply) => {
        const pid = projectId(req);
        const { cid } = req.params as { cid: string };
        getCase(pid, cid);
        store.deleteCase(pid, cid);
        return reply.code(204).send();
    });

    // ── releases ───────────────────────────────────────────────────────────────
    app.get("/api/projects/:id/releases", async (req) => {
        const pid = projectId(req);
        return { releases: releaseSummaries(store, p.db, pid), manualCases: store.countCases(pid) };
    });

    app.post("/api/projects/:id/releases", async (req, reply) => {
        const pid = projectId(req);
        const body = NewRelease.parse(req.body);
        if (store.countReleases(pid) >= MAX_RELEASES) throw new HttpError(409, `A project can have at most ${MAX_RELEASES} releases.`);
        const release = store.createRelease(pid, { name: body.name, notes: body.notes, snapshot: newReleaseSnapshot(p.db, pid) });
        return reply.code(201).send(releaseView(store, p.db, release));
    });

    app.get("/api/projects/:id/releases/:rid", async (req) => {
        const pid = projectId(req);
        return releaseView(store, p.db, getRelease(pid, (req.params as { rid: string }).rid));
    });

    app.post("/api/projects/:id/releases/:rid/refresh", async (req) => {
        const pid = projectId(req);
        const release = getRelease(pid, (req.params as { rid: string }).rid);
        // A signed release stays as it was signed; reopen it first.
        requireOpen(release);
        store.saveSnapshot(release.id, keptSnapshot(p.db, release));
        return releaseView(store, p.db, getRelease(pid, release.id));
    });

    app.put("/api/projects/:id/releases/:rid/results/:cid", async (req) => {
        const pid = projectId(req);
        const { rid, cid } = req.params as { rid: string; cid: string };
        const release = getRelease(pid, rid);
        requireOpen(release);
        getCase(pid, cid);
        const body = ResultInputSchema.parse(req.body);
        store.setResult(release.id, cid, body);
        return releaseView(store, p.db, getRelease(pid, rid));
    });

    app.post("/api/projects/:id/releases/:rid/results/:cid/issue", async (req, reply) => {
        const pid = projectId(req);
        const { rid, cid } = req.params as { rid: string; cid: string };
        const release = getRelease(pid, rid);
        getCase(pid, cid);
        const { integrationId } = z.object({ integrationId: z.string().min(1) }).parse(req.body);
        const conn = integrations.get(integrationId);
        if (!conn || conn.projectId !== pid) throw new HttpError(404, "Issue tracker connection not found for this project");
        const view = releaseView(store, p.db, release);
        const item = view.manual.items.find((i) => i.id === cid);
        if (!item) throw new HttpError(404, "Manual case not found");
        if (item.result !== "failed") throw new HttpError(422, "An issue can only be created for a check that failed.");
        if (item.issue) return reply.code(200).send({ issue: item.issue, existing: true });

        const key = `${rid}:${cid}`;
        const pending = inFlight.get(key);
        if (pending) {
            await pending.catch(() => undefined);
            const made = store.results(rid).get(cid)?.issue;
            if (made) return reply.code(200).send({ issue: made, existing: true });
        }
        const work = (async () => {
            const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/+$/, "");
            const draft = buildManualIssueDraft({ item, releaseName: release.name, projectName: String(ctx.project(pid).name), releaseUrl: `${base}/#/projects/${pid}/releases/${rid}` });
            try {
                const created = await integrations.provider(integrationId)!.createIssue(draft);
                const issue = { provider: conn.kind, externalId: created.externalId, url: created.url };
                store.setIssue(rid, cid, issue);
                return issue;
            } catch (e) {
                if (e instanceof TrackerError) throw new HttpError(502, e.message, { code: e.code, upstreamStatus: e.upstreamStatus });
                throw e;
            }
        })();
        inFlight.set(key, work);
        try {
            return reply.code(201).send({ issue: await work, existing: false });
        } finally {
            inFlight.delete(key);
        }
    });

    app.post("/api/projects/:id/releases/:rid/signoff", async (req) => {
        const pid = projectId(req);
        const release = getRelease(pid, (req.params as { rid: string }).rid);
        const body = Signoff.parse(req.body);
        signRelease(store, p.db, release, body);
        return releaseView(store, p.db, getRelease(pid, release.id));
    });

    app.post("/api/projects/:id/releases/:rid/reopen", async (req) => {
        const pid = projectId(req);
        const release = getRelease(pid, (req.params as { rid: string }).rid);
        const body = Reopen.parse(req.body);
        reopenRelease(store, release, body);
        return releaseView(store, p.db, getRelease(pid, release.id));
    });

    app.get("/api/projects/:id/releases/:rid/report", async (req, reply) => {
        const pid = projectId(req);
        z.object({ format: z.enum(["html"]).default("html") }).parse(req.query);
        const view = releaseView(store, p.db, getRelease(pid, (req.params as { rid: string }).rid));
        const name = String(ctx.project(pid).name);
        return reply
            .header("content-type", "text/html; charset=utf-8")
            .header("content-disposition", `attachment; filename="${releaseReportName(view, name)}.html"`)
            // The page needs no script and loads nothing: say so, whatever a title contains.
            .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
            .send(renderReleaseHtml(name, view));
    });
}
