/**
 * The project's notes reach every rendered script: a validate-only job (what schedules, triggers and suite runs start) renders its web
 * scripts with the overlay a note names. Pure unit test (no browser): the run stops at the first saved script.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import type { GenerationSink } from "../src/engine/orchestrator.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runValidationOnly } from "../src/engine/validate-only.js";
import { playwrightGenerator } from "../src/engine/generators/playwright.js";
import { Db } from "../src/platform/db.js";
import { NotesStore } from "../src/platform/notes-store.js";
import { withProjectNotes } from "../src/platform/render-context.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";

describe("notes in rendered scripts", () => {
    it("a validate-only job's script closes the overlay a note names", async () => {
        const saved: string[] = [];
        const stop = new Error("stop after the first script");
        const sink = new Proxy({} as GenerationSink, {
            get: (_t, name) =>
                name === "saveScript"
                    ? async (_h: unknown, script: { content: string }) => {
                          saved.push(script.content);
                          throw stop;
                      }
                    : name === "then"
                      ? undefined
                      : async () => undefined,
        });
        const ctx = { config: loadConfig({}), emit: () => undefined, llm: { modelName: "none", usage: { inputTokens: 0, outputTokens: 0 } } } as unknown as EngineContext;
        const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Read news", kind: "web", steps: [{ action: "navigate", url: "/news" }, { action: "assert", check: "title", expected: "News" }] });
        // The failing save ends the job there (it reports the error), so no browser is started.
        await runValidationOnly(ctx, { url: "http://127.0.0.1:9301", siteNotes: [{ text: "Close the newsletter popup with 'No thanks'." }] } as never, [{ handle: { id: "t1", testId: "WEB-001" }, spec }], sink).catch(() => undefined);
        expect(saved).toHaveLength(1);
        expect(saved[0]).toContain('const OVERLAY_RULES: Array<{ phrase: string; button?: string }> = [{"phrase":"newsletter","button":"No thanks"}];');
        expect(saved[0]).toContain("await installOverlayHandlers(page);");
    });

    it("a script rendered outside a job (editor, restore, review, locator change) gets the project's notes too", async () => {
        const db = new Db(":memory:");
        const projectId = String(new Repo(db, new SecretBox("", "a-test-secret-key-of-enough-length")).createProject({ name: "P" }).id);
        await new NotesStore(db.sql).add(projectId, { path: "", text: "Dismiss the chat widget with 'Not now'." });
        const ctx = await withProjectNotes(db, projectId, { baseUrl: "https://shop.example.test" });
        expect(ctx.notes).toEqual([{ text: "Dismiss the chat widget with 'Not now'." }]);
        const spec = TestSpecSchema.parse({ testId: "WEB-002", title: "Home", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "title", expected: "Shop" }] });
        expect(playwrightGenerator.render(spec, ctx).content).toContain('[{"phrase":"chat","button":"Not now"}]');
    });
});
