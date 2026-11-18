import { hidesCost } from "../auth/cost-hiding.js";
import { actorOf } from "../auth/access.js";
import { AgentInputsStore } from "../agent-inputs-store.js";
import { HttpError } from "../http-error.js";
import { SecretBox } from "../secrets.js";
import type { RouteCtx } from "./types.js";

/**
 * "What the explorer knows" for one exploration (sheet #8 stage 5):
 *
 *   GET /api/projects/:id/jobs/:jobId/knowledge → {
 *       siteMap: { pages: [{ path, title, type, depth, reusedFrom?, thumbnail?, tests: [{ id, testKey, title }] }], from: "model" | "events" },
 *       reused: { pages: [{ path, since }], spotChecked, expired, changed, reprobed, signIn, pagesFromMemory, understanding, requirements, memory },
 *       reuseOff: [{ reason, message }],
 *       thumbnails: { keep, count },
 *       cacheSavings?: { aiCalls, inputTokens, cacheReadTokens, cacheWriteTokens, cacheReadPercent, aiCallsSaved, savedInputTokens, savedOutputTokens }
 *   }
 *
 * Built only from what the job recorded: its events (crawler.ts probes_reused / page_visited / reuse_off / reuse_reprobed / pages_from_memory,
 * orchestrator.ts signin_reused / understanding_reused / full_exploration, planner.ts requirements_retrieved, memory_used), the model it
 * saved (its `app-model` artifact; while it runs, the pages its events name), its tests, and its AI usage rows. Nothing is asked of the AI.
 *
 * Reused pages are the ones the job's last `probes_reused` names (pages tried again after reuse was switched off are not among them). A
 * page's tests are this job's tests that start on it. A thumbnail is named only while its file is kept (retention removes it with the
 * job's screenshots) and only when it is this project's. `cacheSavings` is left out for anyone without `ai_studio.usage.view` (its fields
 * are cost fields too, auth/cost-hiding.ts). Another project's job is a 404.
 */
const KINDS = ["page_visited", "probes_reused", "reuse_off", "reuse_reprobed", "pages_from_memory", "signin_reused", "understanding_reused", "full_exploration", "requirements_retrieved", "memory_used", "response_cache_hit"];

interface EventFacts {
    kind: string;
    message: string;
    data: Record<string, unknown>;
}

interface SitePage {
    path: string;
    title: string;
    type: string;
    depth: number;
    reusedFrom?: string;
    thumbnail?: string;
    tests: Array<{ id: string; testKey: string; title: string }>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const pathOf = (url: string): string => {
    try {
        return new URL(url).pathname || "/";
    } catch {
        return url.split(/[?#]/)[0] || "/";
    }
};

export function registerKnowledgeRoutes(ctx: RouteCtx): void {
    const { app, repo, p } = ctx;

    app.get("/api/projects/:id/jobs/:jobId/knowledge", async (req) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        ctx.project(id);
        const job = repo.getJob(jobId);
        if (!job || job.projectId !== id) throw new HttpError(404, "Job not found");

        const events: EventFacts[] = repo.db
            .all<{ kind: string; message: string; data_json: string | null }>(`SELECT kind, message, data_json FROM agent_events WHERE job_id = ? AND kind IN (${KINDS.map(() => "?").join(",")}) ORDER BY id LIMIT 5000`, jobId, ...KINDS)
            .map((r) => {
                let data: Record<string, unknown> = {};
                try {
                    const d = JSON.parse(r.data_json ?? "{}");
                    if (d && typeof d === "object") data = d as Record<string, unknown>;
                } catch {
                    /* the message is still there */
                }
                return { kind: r.kind, message: r.message, data };
            });
        const of = (kind: string) => events.filter((e) => e.kind === kind);
        const last = (kind: string) => of(kind).at(-1);

        // The thumbnails this project still has (retention removes the files; another project's id is never named).
        const shots = new Set(repo.db.all<{ id: string }>("SELECT id FROM artifacts WHERE project_id = ? AND kind = 'screenshot' AND execution_id IS NULL AND pruned_at IS NULL AND path LIKE ?", id, "%/thumbnails/thumb-%").map((r) => r.id));
        const thumbOf = (v: unknown) => (typeof v === "string" && shots.has(v) ? v : undefined);

        // The pages: from the model the job saved, else (still running, or an older job) from its page_visited events.
        let from: "model" | "events" = "events";
        let pages: SitePage[] = [];
        const modelRow = repo.db.get<{ path: string; pruned_at: string | null }>(`SELECT path, pruned_at FROM artifacts WHERE job_id = ? AND kind = 'app-model' ORDER BY created_at DESC LIMIT 1`, jobId);
        if (modelRow && !modelRow.pruned_at) {
            try {
                const model = JSON.parse((await p.store.getBytes(modelRow.path)).toString("utf8")) as { pages?: Array<Record<string, unknown>> };
                if (Array.isArray(model.pages)) {
                    from = "model";
                    pages = model.pages.slice(0, 1000).map((pg) => {
                        const reused = pg.reusedFrom && typeof pg.reusedFrom === "object" ? str((pg.reusedFrom as { at?: unknown }).at) : undefined;
                        const thumb = thumbOf(pg.thumbnail);
                        return { path: str(pg.path) ?? pathOf(String(pg.url ?? "/")), title: String(pg.title ?? "").slice(0, 200), type: String(pg.type ?? "other"), depth: num(pg.depth), ...(reused ? { reusedFrom: reused } : {}), ...(thumb ? { thumbnail: thumb } : {}), tests: [] };
                    });
                }
            } catch {
                pages = [];
            }
        }
        if (from === "events") {
            const seen = new Set<string>();
            for (const e of of("page_visited")) {
                const path = /^Visited (\S+)/.exec(e.message)?.[1] ?? pathOf(String(e.data.url ?? ""));
                if (seen.has(path)) continue;
                seen.add(path);
                const thumb = thumbOf(e.data.thumbnail);
                const reused = str(e.data.reusedFrom);
                pages.push({ path, title: "", type: String(e.data.type ?? "other"), depth: num(e.data.depth), ...(reused ? { reusedFrom: reused } : {}), ...(thumb ? { thumbnail: thumb } : {}), tests: [] });
            }
        }

        // What was tested on each page: this job's tests that start there (the test idea's start page, else the test's first page).
        const byPath = new Map(pages.map((pg) => [pg.path, pg]));
        for (const t of repo.listTests(id, { jobId })) {
            if (t.spec.kind !== "web") continue;
            const scenario = t.generationMeta?.scenario as { startPath?: unknown } | undefined;
            const first = t.spec.steps.find((s) => s.action === "navigate") as { url?: unknown } | undefined;
            const raw = str(scenario?.startPath) ?? str(first?.url);
            const start = raw ? pathOf(new URL(raw, "http://x").href) : undefined;
            const page = start ? byPath.get(start) : undefined;
            if (page && page.tests.length < 50) page.tests.push({ id: t.id, testKey: t.testKey, title: t.title });
        }

        // Reused: the final word of the crawl (pages tried again after reuse went off are not in it).
        const pr = last("probes_reused");
        const since = new Map(of("page_visited").flatMap((e) => (str(e.data.reusedFrom) ? [[/^Visited (\S+)/.exec(e.message)?.[1] ?? "", String(e.data.reusedFrom)] as const] : [])));
        const reusedPaths = Array.isArray(pr?.data.paths) ? (pr!.data.paths as unknown[]).filter((x): x is string => typeof x === "string") : [];
        for (const pg of pages) {
            if (!reusedPaths.includes(pg.path)) delete pg.reusedFrom;
        }
        const signIn = last("signin_reused");
        const fromMemory = last("pages_from_memory");
        const understood = last("understanding_reused");
        const reqs = last("requirements_retrieved");
        const memory = last("memory_used");
        const reused = {
            pages: reusedPaths.map((path) => ({ path, since: since.get(path) ?? str(pr?.data.since) ?? null })),
            /** More pages were reused than the event lists by name. */
            total: num(pr?.data.pages),
            spotChecked: num(pr?.data.spotChecked),
            expired: num(pr?.data.expired),
            changed: num(pr?.data.changed),
            reprobed: of("reuse_reprobed").reduce((n, e) => n + num(e.data.pages), 0),
            signIn: signIn ? { path: str(signIn.data.path) ?? null, since: str(signIn.data.since) ?? null } : null,
            pagesFromMemory: fromMemory ? { pages: num(fromMemory.data.pages), gone: num(fromMemory.data.gone) } : null,
            understanding: understood ? { pages: num(understood.data.pages), of: num(understood.data.of) } : null,
            requirements: reqs ? { total: num(reqs.data.total), inAreas: num(reqs.data.inAreas), catchAll: num(reqs.data.catchAll), notShown: num(reqs.data.notShown) } : null,
            memory: memory ? memory.message.slice(0, 500) : null,
        };
        const reuseOff = [
            ...of("full_exploration").map(() => ({ reason: "You asked to explore everything again, so nothing was reused.", message: "" })),
            ...of("reuse_off").map((e) => ({ reason: str(e.data.reason) ?? e.message, message: e.message })),
        ];

        const keep = new AgentInputsStore(repo.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY)).keepThumbnails(id);
        const answer: Record<string, unknown> = { siteMap: { pages, from }, reused, reuseOff, thumbnails: { keep, count: pages.filter((pg) => pg.thumbnail).length } };

        if (!hidesCost(actorOf(req))) {
            const u = repo.db.get<{ calls: number | null; i: number | null; cr: number | null; cw: number | null; cc: number | null; si: number | null; so: number | null }>(
                "SELECT SUM(calls) AS calls, SUM(input_tokens) AS i, SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw, SUM(cached_calls) AS cc, SUM(saved_input_tokens) AS si, SUM(saved_output_tokens) AS so FROM ai_usage WHERE job_id = ?",
                jobId,
            );
            const input = Number(u?.i ?? 0);
            const cr = Number(u?.cr ?? 0);
            answer.cacheSavings = {
                aiCalls: Number(u?.calls ?? 0),
                inputTokens: input,
                cacheReadTokens: cr,
                cacheWriteTokens: Number(u?.cw ?? 0),
                // Cached reads are part of the input tokens (engine/llm/usage.ts).
                cacheReadPercent: input > 0 ? Math.round((Math.min(cr, input) / input) * 100) : 0,
                // Answers served from the response cache, with no AI call, and the tokens those calls would have used
                // (metered by llm-response-cache.ts as cached_calls, never as calls).
                aiCallsSaved: Number(u?.cc ?? 0),
                savedInputTokens: Number(u?.si ?? 0),
                savedOutputTokens: Number(u?.so ?? 0),
            };
        }
        return answer;
    });
}
