import { z } from "zod";
import { gatherReport, renderReportHtml } from "../reports/project-report.js";
import { HttpError } from "../http-error.js";
import { toPdf } from "../pdf.js";
import type { RouteCtx } from "./types.js";

/** Routes for the "reports" feature: a shareable project report. */
export function registerReportRoutes({ app, p, repo, project }: RouteCtx): void {
    app.get("/api/projects/:id/report", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const { format } = z.object({ format: z.enum(["html", "pdf"]).default("html") }).parse(req.query);
        const data = await gatherReport(repo, p.store, id);
        if (!data) throw new HttpError(404, "Project not found");
        const html = renderReportHtml(data);
        const base = `report-${data.projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"}-${data.generatedAt.slice(0, 10)}`;
        if (format === "pdf") {
            const pdf = await toPdf(html, p.config.HEADLESS);
            return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="${base}.pdf"`).send(pdf);
        }
        return reply.header("content-type", "text/html; charset=utf-8").header("content-disposition", `attachment; filename="${base}.html"`).send(html);
    });
}
