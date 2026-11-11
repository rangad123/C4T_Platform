import { z } from "zod";
import { parseSpecText } from "../../engine/api/openapi.js";
import { diffOpenApi, renderDiffMarkdown } from "../../engine/contracts/diff.js";
import { apiChanges } from "../drift-store.js";
import { HttpError } from "../http-error.js";
import { guardedFetch, refusedRedirect } from "../guarded-fetch.js";
import { assertAllowedTarget } from "../net-guard.js";
import type { RouteCtx } from "./types.js";

/** One side of a comparison: the document itself (text or already-parsed object) or an address to download it from. */
const SideSchema = z.union([z.string().min(2).max(3_000_000), z.record(z.string(), z.unknown())]);

export async function resolve(side: z.infer<typeof SideSchema>, which: string): Promise<Record<string, any>> {
    if (typeof side !== "string") return side;
    const text = side.trim();
    if (/^https?:\/\//i.test(text)) {
        await assertAllowedTarget(text);
        // Connects only to the address that was checked (a name that resolves privately later is refused too) and follows no redirect.
        let status: number | undefined;
        const res = await guardedFetch(text, { signal: AbortSignal.timeout(20_000) }).catch((e: unknown) => void (status = refusedRedirect(e)));
        status ??= res?.status;
        if (!res || !res.ok) throw new HttpError(422, `Could not download the ${which} description${status ? ` (HTTP ${status})` : ""}.`);
        return parse((await res.text()).slice(0, 5_000_000), which);
    }
    return parse(text, which);
}
function parse(text: string, which: string): Record<string, any> {
    try {
        return parseSpecText(text);
    } catch {
        throw new HttpError(422, `The ${which} description is not valid OpenAPI/Swagger (JSON or YAML).`);
    }
}

/** Routes for the "contracts" feature. */
export function registerContractRoutes({ app, repo, project }: RouteCtx): void {
    /** Compare two API descriptions: which changes would break existing clients. */
    app.post("/api/projects/:id/api-diff", async (req) => {
        project((req.params as { id: string }).id);
        const body = z.object({ old: SideSchema, new: SideSchema }).parse(req.body);
        const [a, b] = await Promise.all([resolve(body.old, "old"), resolve(body.new, "new")]);
        const diff = diffOpenApi(a, b);
        return { ...diff, summary: { breaking: diff.breaking.length, nonBreaking: diff.nonBreaking.length }, markdown: renderDiffMarkdown(diff) };
    });

    /**
     * What the live API changed between two runs (shapes recorded by the API tests; no description needed).
     * Latest run against the one before it, or against the run `since` names. Nothing to compare is a 200 with a message.
     */
    app.get("/api/projects/:id/api-changes", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const q = z.object({ since: z.string().min(1).max(80).optional() }).parse(req.query);
        const changes = apiChanges(repo.db, id, { since: q.since });
        if (!changes) throw new HttpError(404, "No API snapshot was recorded for that run.");
        return changes;
    });
}
