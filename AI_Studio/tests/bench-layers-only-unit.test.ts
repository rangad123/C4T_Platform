/**
 * T10 (Phase 4): `bench --layers-only`, the free mode for the deterministic layers. No AI key: a scripted model answers each call from its
 * fixed answers (the first that the call's own schema accepts), and a call none fits fails as an AI call would. Only the deterministic
 * check families run (API with its contract checks, access); the extension catalogue and the catalogue's accounts are on, as CP1 needs them.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseBenchArgs } from "../src/eval/bench/cli.js";
import { LAYERS_ONLY_EXPLORATION, layersOnlyLlm } from "../src/eval/bench/layers-only.js";

describe("--layers-only", () => {
    it("takes the extension catalogue and the catalogue's accounts unless they are given", () => {
        const a = parseBenchArgs(["--layers-only", "--apps", "bench-shop"]);
        expect(a).toMatchObject({ layersOnly: true, catalogue: "2026-11-21.1", roles: "catalogue" });
        expect(parseBenchArgs(["--layers-only", "--catalogue", "2026-11-14.1"]).catalogue).toBe("2026-11-14.1");
        expect(parseBenchArgs(["--apps", "bench-shop"]).layersOnly).toBe(false);
    });

    it("runs only the deterministic check families", () => {
        expect(LAYERS_ONLY_EXPLORATION).toMatchObject({ targets: ["web", "api"], accessChecks: true, contractChecks: true, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, performanceChecks: false, loadChecks: false, visual: false, visionChecks: false });
    });

    it("the scripted model answers from its fixture, by the call's schema, and refuses a call it has no answer for", async () => {
        const llm = layersOnlyLlm();
        const call = (schema: z.ZodTypeAny) => llm.object({ system: "s", prompt: "p", schema });
        expect(await call(z.object({ scenarios: z.array(z.unknown()) }))).toEqual({ scenarios: [] });
        expect(await call(z.object({ requirements: z.array(z.unknown()) }))).toEqual({ requirements: [] });
        expect(await call(z.object({ siteType: z.string(), purpose: z.string() }).passthrough())).toMatchObject({ siteType: "other" });
        await expect(call(z.object({ steps: z.array(z.string()).min(1) }))).rejects.toThrow(/no scripted answer/);
        // Every Phase 4 proposal call is answered, so a free trial completes: the invariants (T12) and the stored-data rules (T23, none).
        expect(await call(z.object({ invariants: z.array(z.unknown()) }))).toMatchObject({ invariants: expect.any(Array) });
        expect(await call(z.object({ relations: z.array(z.unknown()) }))).toEqual({ relations: [] });
        expect(llm.modelName).toBe("scripted");
    });
});
