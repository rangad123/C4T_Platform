import { z } from "zod";
import { capMessage, capScope, dayOf, daySeries, daysBetween, GROUP_BYS, groupRows, monthBounds, monthOf, shortTokens, totalsOf, type Group, type GroupBy, type Totals, type UsageRow } from "../../engine/llm/usage.js";
import { HttpError } from "../http-error.js";
import { CONNECTION_CHECK_PROJECT } from "../llm-health.js";
import { snapshotSavingsOfJob } from "../snapshot-settings.js";
import { withoutAiOfJob } from "../without-ai-settings.js";
import { usageStoreFor, type UsageStore } from "../usage-store.js";
import type { RouteCtx } from "./types.js";

/**
 * AI usage and budget routes (Builder AB). Only counts and labels are ever returned or stored.
 *
 *   GET    /api/usage?from=&to=&projectId=&groupBy=day|project|purpose|model   totals, groups, a day series and this month against its cap
 *   GET    /api/jobs/:id/usage                                                 one job's breakdown and the cap that stopped it, if any
 *   GET    /api/usage/prices            PUT /api/usage/prices   { model, inputPerMTok, outputPerMTok } and/or { currency }
 *   DELETE /api/usage/prices?model=     remove one price
 *   GET    /api/usage/budgets           PUT /api/usage/budgets  { monthlyTokens, jobTokens, warnPercent } (null = no limit)
 *   GET    /api/projects/:id/usage-budget      PUT the same path { monthlyTokens, jobTokens }
 */

/** Longest range one request may ask for. */
const MAX_RANGE_DAYS = 366;

/** ", 30K of the input from the prompt cache" (and what was written to it) for a job's one-line summary; empty without caching. */
function cacheSummary(t: Totals): string {
    if (!t.cacheReadTokens && !t.cacheWriteTokens) return "";
    if (!t.cacheReadTokens) return `, ${shortTokens(t.cacheWriteTokens)} written to the prompt cache`;
    return `, ${shortTokens(t.cacheReadTokens)} of the input read from the prompt cache${t.cacheWriteTokens ? ` and ${shortTokens(t.cacheWriteTokens)} written to it` : ""}`;
}

/** ", 2 escalated to the main model" (model routing, routing.ts); empty when the fast model never handed over. */
function escalationSummary(t: Totals): string {
    return t.escalations ? `, ${t.escalations} escalated to the main model` : "";
}

const Day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31")
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && dayOf(Date.parse(`${v}T00:00:00Z`)) === v, "Not a real date");

const UsageQuery = z
    .object({
        from: Day.optional(),
        to: Day.optional(),
        projectId: z.string().min(1).max(100).optional(),
        groupBy: z.enum(GROUP_BYS as unknown as [GroupBy, ...GroupBy[]]).default("day"),
    })
    .strict();

/** A limit in tokens: a whole number of at least 1, or null for "no limit". */
const Limit = z.number().int().min(1).max(1_000_000_000_000).nullable();
const BudgetBody = z.object({ monthlyTokens: Limit.optional(), jobTokens: Limit.optional(), warnPercent: z.number().int().min(1).max(99).optional() }).strict();
const ProjectBudgetBody = z.object({ monthlyTokens: Limit.optional(), jobTokens: Limit.optional() }).strict();

const Money = z.number().min(0).max(1_000_000);
const PriceBody = z
    .object({
        model: z.string().trim().min(1).max(200).optional(),
        inputPerMTok: Money.optional(),
        outputPerMTok: Money.optional(),
        // Optional prompt-cache prices (prompt-cache.ts); without them cached input is charged at the input price.
        cachedInputPerMTok: Money.optional(),
        cacheWritePerMTok: Money.optional(),
        // A label the user picks ("USD", "EUR", "$"); empty = none.
        currency: z
            .string()
            .trim()
            .max(8)
            .regex(/^[^\u0000-\u001f<>]*$/, "Use a short label like USD")
            .optional(),
    })
    .strict()
    .refine((b) => (b.model === undefined) === (b.inputPerMTok === undefined && b.outputPerMTok === undefined) && (b.model === undefined ? b.currency !== undefined : b.inputPerMTok !== undefined && b.outputPerMTok !== undefined), {
        message: "Send a model with both prices, or only a currency",
    })
    .refine((b) => b.model !== undefined || (b.cachedInputPerMTok === undefined && b.cacheWritePerMTok === undefined), { message: "Cache prices belong to a model: send them with the model and its two prices" });

export function registerUsageRoutes(ctx: RouteCtx): void {
    const { app, repo, p } = ctx;
    const store = (): UsageStore => usageStoreFor(p.db, p.config);

    // "Check the connection" in Settings is counted under its own name (platform/llm-health.ts).
    const projectName = (id: string): string => (id === CONNECTION_CHECK_PROJECT ? "Connection checks" : (repo.getProject(id)?.name ?? "Deleted project"));

    /** The extra numbers a person needs next to a total: the money format and whether a cost could be worked out. */
    const money = (s: UsageStore) => ({ currency: s.currency() });

    function monthBlock(s: UsageStore, projectId?: string) {
        const month = monthOf(Date.now());
        const b = s.platformBudget();
        const used = s.monthTokens(month);
        const level = (u: number, cap: number | null) => (cap === null ? "none" : u >= cap ? "reached" : u * 100 >= b.warnPercent * cap ? "warning" : "ok");
        const out: Record<string, unknown> = {
            month,
            usedTokens: used,
            limitTokens: b.monthlyTokens,
            percent: b.monthlyTokens ? Math.round((used / b.monthlyTokens) * 100) : null,
            level: level(used, b.monthlyTokens),
            warnPercent: b.warnPercent,
        };
        if (projectId) {
            const pb = s.projectBudget(projectId);
            const pu = s.monthTokens(month, projectId);
            out.project = { usedTokens: pu, limitTokens: pb.monthlyTokens, percent: pb.monthlyTokens ? Math.round((pu / pb.monthlyTokens) * 100) : null, level: level(pu, pb.monthlyTokens) };
        }
        return out;
    }

    app.get("/api/usage", async (req) => {
        const q = UsageQuery.parse(req.query);
        const now = Date.now();
        const to = q.to ?? dayOf(now);
        const from = q.from ?? monthBounds(monthOf(now)).from;
        if (from > to) throw new HttpError(400, "“from” must not be after “to”");
        const span = daysBetween(from, to).length;
        if (span > MAX_RANGE_DAYS) throw new HttpError(400, `Ask for at most ${MAX_RANGE_DAYS} days at a time`);
        if (q.projectId) ctx.project(q.projectId);

        const s = store();
        const prices = s.prices();
        const rows: UsageRow[] = s.rows(from, to, q.projectId);
        const totals: Totals = totalsOf(rows, prices);
        const groups: Array<Group & { label?: string }> = groupRows(rows, q.groupBy, prices).map((g) => (q.groupBy === "project" ? { ...g, label: projectName(g.key) } : g));
        return {
            from,
            to,
            groupBy: q.groupBy,
            projectId: q.projectId ?? null,
            ...money(s),
            totals,
            groups,
            series: daySeries(rows, from, to, prices),
            month: monthBlock(s, q.projectId),
            // Nothing is priced until the user says so: a cost shown here is theirs, never a built-in guess.
            pricing: totals.cost === null ? (totals.totalTokens > 0 ? "Set a price to see a cost." : null) : totals.unpricedTokens > 0 ? "The cost covers only the models that have a price." : null,
        };
    });

    app.get("/api/jobs/:id/usage", async (req) => {
        const { id } = req.params as { id: string };
        const job = repo.getJob(id);
        if (!job) throw new HttpError(404, "Job not found");
        const s = store();
        const prices = s.prices();
        const rows = s.jobRows(id);
        const totals = totalsOf(rows, prices);
        const stop = s.stopOf(id);
        return {
            jobId: id,
            projectId: job.projectId,
            ...money(s),
            totals,
            byPurpose: groupRows(rows, "purpose", prices),
            byModel: groupRows(rows, "model", prices),
            // Smaller page snapshots (SNAP): estimated snapshot tokens saved in this job, from its job events; null when none were used.
            snapshotSavings: snapshotSavingsOfJob(p.db, id),
            // Repair without AI and exploration reuse (DET): what this job did without asking the model, from its job events; null when nothing.
            withoutAi: withoutAiOfJob(p.db, id),
            summary: totals.calls === 0 ? "No AI calls" : `${shortTokens(totals.inputTokens)} in, ${shortTokens(totals.outputTokens)} out, ${totals.calls} ${totals.calls === 1 ? "call" : "calls"}${cacheSummary(totals)}${escalationSummary(totals)}`,
            stop: stop
                ? { cap: stop.cap, scope: capScope(stop.cap as "job" | "project" | "month"), message: capMessage(stop.cap as "job" | "project" | "month"), usedTokens: stop.used, limitTokens: stop.limit, at: stop.at }
                : null,
        };
    });

    // ── prices ───────────────────────────────────────────────────────────────
    const pricesView = (s: UsageStore) => ({ ...money(s), prices: [...s.prices()].map(([model, v]) => ({ model, ...v })).sort((a, b) => a.model.localeCompare(b.model)) });

    app.get("/api/usage/prices", async () => pricesView(store()));
    app.put("/api/usage/prices", async (req) => {
        const body = PriceBody.parse(req.body);
        const s = store();
        s.db.tx(() => {
            if (body.model !== undefined)
                s.setPrice(body.model, {
                    inputPerMTok: body.inputPerMTok!,
                    outputPerMTok: body.outputPerMTok!,
                    ...(body.cachedInputPerMTok !== undefined ? { cachedInputPerMTok: body.cachedInputPerMTok } : {}),
                    ...(body.cacheWritePerMTok !== undefined ? { cacheWritePerMTok: body.cacheWritePerMTok } : {}),
                });
            if (body.currency !== undefined) s.setCurrency(body.currency);
        });
        return pricesView(s);
    });
    app.delete("/api/usage/prices", async (req) => {
        const { model } = z.object({ model: z.string().min(1).max(200) }).strict().parse(req.query);
        const s = store();
        if (!s.deletePrice(model)) throw new HttpError(404, "No price is set for that model");
        return pricesView(s);
    });

    // ── budgets ──────────────────────────────────────────────────────────────
    function budgetsView(s: UsageStore) {
        const month = monthOf(Date.now());
        return {
            platform: s.platformBudget(),
            month: monthBlock(s),
            projects: s.projectBudgets().map((b) => ({ projectId: b.projectId, name: projectName(b.projectId), monthlyTokens: b.monthlyTokens, jobTokens: b.jobTokens, usedTokens: s.monthTokens(month, b.projectId) })),
        };
    }
    app.get("/api/usage/budgets", async () => budgetsView(store()));
    app.put("/api/usage/budgets", async (req) => {
        const body = BudgetBody.parse(req.body);
        const s = store();
        s.setPlatformBudget(body);
        return budgetsView(s);
    });

    const projectBudgetView = (s: UsageStore, projectId: string) => {
        const b = s.projectBudget(projectId);
        return { projectId, ...b, usedTokens: s.monthTokens(monthOf(Date.now()), projectId), warnPercent: s.platformBudget().warnPercent };
    };
    app.get("/api/projects/:id/usage-budget", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return projectBudgetView(store(), id);
    });
    app.put("/api/projects/:id/usage-budget", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = ProjectBudgetBody.parse(req.body);
        const s = store();
        s.setProjectBudget(id, body);
        return projectBudgetView(s, id);
    });
}
