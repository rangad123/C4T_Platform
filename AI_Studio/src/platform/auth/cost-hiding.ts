/**
 * Testers never see AI cost (D-24, US-005), and nobody else does without `ai_studio.usage.view`. The usage, price and budget routes
 * need that code (auth/roles.ts); every other answer loses its cost and token fields here, in one place: an onSend hook for JSON
 * answers, and `withoutCost` for the live-update streams (they write to the socket themselves, past the hook).
 *
 * Token counts go too: with the prices (public list prices) they give the cost. The fields are named exactly, never matched by a
 * pattern, so a field such as a page-speed budget or a personal API token list is left alone.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { EVENT_SNAPSHOT_SAVINGS } from "../../engine/snapshots/setting.js";
import { permissionsOf, type Actor } from "./actor.js";

export const COST_FIELDS: ReadonlySet<string> = new Set([
    // job counters (repo.ts JobCounters)
    "llmInputTokens",
    "llmOutputTokens",
    // AI usage records and summaries (usage-store.ts)
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cachedInputTokens",
    "totalTokens",
    "unpricedTokens",
    "monthTokens",
    "jobTokens",
    "monthlyTokens",
    "budgetTokens",
    "usedTokens",
    "savedTokens",
    // what smaller snapshots saved (engine/snapshots/compact.ts, snapshot-settings.ts); the summary sentence of a job goes with its object
    "baselineTokens",
    "sentTokens",
    "snapshotSavings",
    "cost",
    "costs",
    "costUsd",
    "estimatedCost",
    "estimatedCostUsd",
    "usd",
    "price",
    "prices",
    "spend",
]);

/** Whether this actor's answers lose their cost fields. */
export const hidesCost = (actor: Actor | undefined): boolean => Boolean(actor) && !permissionsOf(actor!).has("ai_studio.usage.view");

/** Job events about the AI usage limit (engine/llm/metered.ts): their words and data carry the tokens used and the limit. */
export const BUDGET_EVENT_WORDS: Record<string, string> = {
    ai_budget_warning: "AI usage is close to its limit.",
    ai_budget_stop: "The AI usage limit was reached. AI work stops here; what was already created is kept.",
    // Its words and data carry the tokens sent and saved (engine/snapshots/compact.ts).
    [EVENT_SNAPSHOT_SAVINGS]: "Smaller page snapshots were used.",
};

/** A copy of a JSON value without the cost fields, at any depth. */
export function withoutCost<T>(value: T): T {
    if (Array.isArray(value)) return value.map((v) => withoutCost(v)) as T;
    if (value && typeof value === "object") {
        const kind = String((value as { kind?: unknown }).kind);
        const budgetEvent = Object.hasOwn(BUDGET_EVENT_WORDS, kind) ? BUDGET_EVENT_WORDS[kind] : undefined;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (COST_FIELDS.has(k) || (budgetEvent && k === "data")) continue;
            out[k] = budgetEvent && k === "message" ? budgetEvent : withoutCost(v);
        }
        return out as T;
    }
    return value;
}

const isJson = (type: unknown) => typeof type === "string" && /^application\/(?:[\w.+-]+\+)?json\b/i.test(type);

/** Installs the hook. `actorOf` is passed in so this file does not import the access hook (which installs it). */
export function installCostHiding(app: FastifyInstance, actorOf: (req: FastifyRequest) => Actor | undefined): void {
    app.addHook("onSend", (req, reply, payload, done) => {
        if (!hidesCost(actorOf(req)) || typeof payload !== "string" || !isJson(reply.getHeader("content-type"))) return done(null, payload);
        // A quick look first: most answers have no cost field at all, and parsing them again would be wasted.
        let found = payload.includes("ai_budget_") || payload.includes(EVENT_SNAPSHOT_SAVINGS);
        for (const f of COST_FIELDS) {
            if (found) break;
            if (payload.includes(`"${f}"`)) {
                found = true;
                break;
            }
        }
        if (!found) return done(null, payload);
        try {
            done(null, JSON.stringify(withoutCost(JSON.parse(payload))));
        } catch {
            // Not JSON after all: nothing of ours to remove.
            done(null, payload);
        }
    });
}
