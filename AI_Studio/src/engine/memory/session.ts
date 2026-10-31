/**
 * One analysis run's use of site memory, so the orchestrator needs only a few lines:
 *   open (load what is known) -> noteCrawl (what the crawl shows vs memory) -> context (prompt section)
 *   -> analysed (the model after understanding) -> remember (distil, compare, save).
 *
 * Memory only informs prompts and the change summary. It never filters, limits or reorders what discovery does,
 * and every failure here is a warning event: memory can never fail or slow a job in a way the user would notice.
 */
import type { EngineContext } from "../context.js";
import type { AppModel } from "../understanding/app-model.js";
import { memoryContext } from "./context.js";
import { diffKnowledge } from "./diff.js";
import { distillKnowledge, type ScenarioResult } from "./distill.js";
import { planReuse, type ReusePlan } from "./reuse.js";
import type { MemoryChanges, MemoryLoad, SiteKnowledge } from "./types.js";

/** The persistence a host provides (the platform stores it in SQLite; other hosts may provide none). */
export interface MemoryStorage {
    loadMemory?(origin: string): MemoryLoad | Promise<MemoryLoad>;
    saveMemory?(knowledge: SiteKnowledge, changes: MemoryChanges | null): void | Promise<void>;
}

export interface MemorySession {
    /** True when a usable record from an earlier analysis was loaded. */
    readonly hasPrevious: boolean;
    /** Compare the fresh crawl with memory (pages and endpoints only) so the prompts can say what looks new. */
    noteCrawl(model: AppModel): void;
    /** The "previously known" section for a prompt, or undefined when there is nothing (or memory is off). */
    context(stage: "understanding" | "planning"): string | undefined;
    /** Exploration reuse (reuse.ts): the crawled pages that did not change since the remembered exploration. Undefined without memory. */
    reusable(model: AppModel): ReusePlan | undefined;
    /** The model after understanding succeeded: the only point from which memory may be updated. */
    analysed(model: AppModel): void;
    /** After validation: save what was learned and report what changed. No-op unless `analysed` was called. */
    remember(scenarios: ScenarioResult[]): Promise<void>;
    /** The change summary computed by `remember` (for tests and hosts). */
    readonly changes: MemoryChanges | null;
}

interface SecretBearing {
    credentials?: { username?: string; password?: string; totpSecret?: string; apiToken?: string; apiAuthHeader?: string; oauth2?: { clientId?: string; clientSecret?: string } };
    roles?: Array<{ username?: string; password?: string; totpSecret?: string; apiToken?: string }>;
}

/** Every credential value of a request, so distillation can make sure none of them is ever stored. */
export function secretValues(req: SecretBearing): string[] {
    const c = req.credentials;
    const all = [c?.username, c?.password, c?.totpSecret, c?.apiToken, c?.apiAuthHeader, c?.oauth2?.clientId, c?.oauth2?.clientSecret, ...(req.roles ?? []).flatMap((r) => [r.username, r.password, r.totpSecret, r.apiToken])];
    const out = new Set<string>();
    for (const v of all) {
        if (typeof v !== "string" || !v) continue;
        out.add(v);
        // "Bearer abc" / "Basic abc": the value after the scheme is what leaks.
        const parts = v.split(/\s+/);
        if (parts.length > 1) out.add(parts[parts.length - 1]!);
    }
    return [...out];
}

const OFF: MemorySession = {
    hasPrevious: false,
    noteCrawl: () => undefined,
    context: () => undefined,
    reusable: () => undefined,
    analysed: () => undefined,
    remember: async () => undefined,
    changes: null,
};

export async function openMemory(ctx: EngineContext, storage: MemoryStorage, opts: { origin: string; enabled: boolean; secrets: string[] }): Promise<MemorySession> {
    if (!opts.enabled || !storage.loadMemory) return OFF;

    let previous: SiteKnowledge | null = null;
    try {
        const loaded = await storage.loadMemory(opts.origin);
        previous = loaded.knowledge;
        if (loaded.warning) ctx.emit({ stage: "analysis", kind: "memory_warning", level: "warn", message: loaded.warning });
    } catch (err) {
        ctx.emit({ stage: "analysis", kind: "memory_warning", level: "warn", message: `Site memory could not be read (${err instanceof Error ? err.message : String(err)}); continuing without it.` });
    }
    if (previous) {
        ctx.emit({
            stage: "analysis",
            kind: "memory_used",
            message: `Using what was learned on ${previous.analysedAt.slice(0, 10)}: ${previous.learned}`,
            data: { pages: previous.pages.length, journeys: previous.journeys.length, endpoints: previous.apis.length },
        });
    }

    let early: MemoryChanges | undefined;
    let model: AppModel | undefined;
    const session: MemorySession & { changes: MemoryChanges | null } = {
        hasPrevious: Boolean(previous),
        changes: null,
        noteCrawl(m) {
            if (!previous) return;
            try {
                early = diffKnowledge(previous, distillKnowledge(m, { secrets: opts.secrets }), { journeys: false });
            } catch {
                early = undefined;
            }
        },
        context(stage) {
            return previous ? memoryContext(previous, stage, early) : undefined;
        },
        reusable(m) {
            if (!previous) return undefined;
            try {
                return planReuse(previous, m, opts.secrets);
            } catch {
                return undefined;
            }
        },
        analysed(m) {
            model = m;
        },
        async remember(scenarios) {
            if (!model) return;
            try {
                const knowledge = distillKnowledge(model, { secrets: opts.secrets, scenarios, previous });
                const changes = previous ? diffKnowledge(previous, knowledge) : null;
                await storage.saveMemory?.(knowledge, changes);
                session.changes = changes;
                if (changes) ctx.emit({ stage: "analysis", kind: "memory_changes", message: changes.text, data: { ...changes.counts } });
                else ctx.emit({ stage: "analysis", kind: "memory_saved", message: `Saved what was learned about this site for next time: ${knowledge.learned}` });
            } catch (err) {
                ctx.emit({ stage: "analysis", kind: "memory_warning", level: "warn", message: `Could not save what was learned about this site (${err instanceof Error ? err.message : String(err)}).` });
            }
        },
    };
    return session;
}
