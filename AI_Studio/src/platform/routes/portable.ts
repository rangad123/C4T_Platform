import { strToU8, zipSync } from "fflate";
import { CustomScriptStore } from "../custom-script-store.js";
import { HttpError } from "../http-error.js";
import { exportPath, portableFiles, type ExportScript } from "../portable-export.js";
import type { RouteCtx } from "./types.js";

/**
 * One test as a folder that runs on its own: the script (and the shared helpers a code test imports), the steps it was made from, and
 * the files that pin what it runs with (package.json, lockfile, .nvmrc, playwright.config.ts, README.md, .gitignore). The project
 * download (GET /api/projects/:id/download, server.ts) is the same for every test. See docs/features/portable-code-tests.md.
 */
export function registerPortableRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;
    const custom = new CustomScriptStore(repo.db);

    app.get("/api/tests/:id/download", async (req, reply) => {
        const t = repo.getTest((req.params as { id: string }).id);
        if (!t) throw new HttpError(404, "Test not found");
        const p = ctx.project(t.projectId);
        const s = repo.getCurrentScript(t.id);
        if (!s) throw new HttpError(409, "This test has no script to download yet.");
        const slug = (s.storage_path as string).split("/")[1] ?? "general";
        const file = exportPath(s.framework as string, slug, s.filename as string);
        const files: Record<string, Uint8Array> = { [file]: strToU8(s.content as string) };
        const scripts: ExportScript[] = [{ path: file, framework: s.framework as string, content: s.content as string }];
        const isCustom = custom.isCustom(t.id);
        if (isCustom) {
            for (const h of custom.helpersFor(t.projectId, [s.content as string]).helpers) {
                const at = `tests/${slug}/helpers/${h.name}.ts`;
                files[at] = strToU8(h.content);
                scripts.push({ path: at, framework: "playwright", content: h.content });
            }
        } else files[`specs/${t.testKey}.json`] = strToU8(JSON.stringify(t.spec, null, 2));
        for (const [name, text] of Object.entries(portableFiles({ projectName: p.name as string, scripts, single: { title: t.title, testId: t.testKey } }).files)) files[name] = strToU8(text);
        const name = `${t.testKey}`.replace(/[^A-Za-z0-9_-]/g, "") || "test";
        return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${name}.zip"`).send(Buffer.from(zipSync(files)));
    });
}
