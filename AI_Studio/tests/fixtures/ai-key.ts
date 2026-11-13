/**
 * Since round 57 a signed-in person's AI work uses their own chosen key, never the server's (docs/features/ai-keys.md). Tests whose people
 * do AI work give each of them a personal key on the test's stand-in provider, chosen, as a person would in Settings, AI keys.
 */
import { aiConfigStore } from "../../src/platform/ai-config.js";
import type { Platform } from "../../src/platform/bootstrap.js";

export async function givePersonalKeys(platform: Pick<Platform, "sql" | "config">, personIds: readonly string[], ai: { baseUrl: string; model: string; apiKey?: string }): Promise<void> {
    const store = aiConfigStore({ sql: platform.sql, config: platform.config });
    for (const person of personIds) {
        if (await store.chosenOf(person)) continue;
        const key = await store.create({ kind: "personal", ownerPersonId: person, label: "Test key", provider: "openai-compatible", model: ai.model, baseUrl: ai.baseUrl, apiKey: ai.apiKey ?? "fake-key", createdBy: "test" });
        await store.setChosen(person, key.id);
    }
}
