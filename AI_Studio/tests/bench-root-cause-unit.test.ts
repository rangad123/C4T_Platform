/**
 * Root cause in a bench trial (V7): the trial's platforms have no code connection, so in paid-rbac-1 and paid-shop-1 every finding
 * was Unknown ("No code source is connected") and no root-cause AI call was made. The harness now gives each app's findings the app's
 * own source folder as the code source (cli.ts withRootCauses), on the trial's model, metered under the project. A scripted model, a
 * temporary platform and the real bench-shop source; no app, no browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { verifierOf, withRootCauses } from "../src/eval/bench/cli.js";
import { BenchVerificationSchema } from "../src/eval/bench/schema.js";
import { verificationOf } from "../src/eval/bench/verify-score.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { usageStoreFor } from "../src/platform/usage-store.js";

let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-bench-root-cause-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "bench-root-cause-secret-key-0123456789", API_KEY: "k-bench-root-cause", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// The line of bench-shop's BS-02 seed (the subtotal of a cart's lines).
const SEED_LINE = fs.readFileSync(path.join(REPO_ROOT, "examples/bench-shop/server.mjs"), "utf8").split("\n").findIndex((l) => l.includes('on("BS-02")')) + 1;

describe("root cause in a bench trial", () => {
    it("a finding gets a root cause from the app's source folder, with one metered AI call, and the result keeps it", async () => {
        const projectId = String(platform.repo.createProject({ name: "bench-shop" }).id);
        const store = new CandidateFindingStore(platform.sql);
        // paid-shop-1 API-034's finding: POST /api/cart/items accepted what its document refuses.
        const attempt = { outcome: "failed", failedStep: 5, check: "status", value: "400", error: "Error: expect(received).toBe(expected) Expected: 400 Received: 201", requests: [{ method: "POST", path: "/api/register", status: 201, own: true }, { method: "POST", path: "/api/cart/items", status: 201, own: true }], stack: [] };
        const { finding } = await store.upsert({
            projectId,
            finding: { objective: null, actions: { stepCount: 6 }, expected: { text: "HTTP 400, as the API document says", source: "API document: POST /api/cart/items 400" }, observed: "Error: expect(received).toBe(expected)", evidence: { screenshots: [], requests: [], console: [] }, capture: "captured", independence: "not_run", confidence: "medium", fingerprint: "f".repeat(64), modelVersion: null, replays: [] },
        });
        await platform.sql.run("UPDATE candidate_findings SET attempts_json = ? WHERE id = ?", JSON.stringify([attempt, attempt, attempt]), finding.id);

        const prompts: string[] = [];
        platform.llm = {
            modelName: "scripted",
            model: undefined as never,
            usage: { inputTokens: 0, outputTokens: 0 },
            text: async () => "",
            object: (async ({ prompt }: { prompt: string }) => {
                prompts.push(prompt);
                return { hypotheses: [{ file: "server.mjs", line: SEED_LINE, explanation: "the last line's unit price is added instead of its line total" }] };
            }) as LlmClient["object"],
        } as LlmClient;

        const v = await withRootCauses(platform, projectId, await verificationOf(store, projectId, { cost: 0, durationMs: 0 }), "examples/bench-shop");
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("server.mjs");
        const rc = v.findings[0]!.rootCause;
        expect(rc?.label).not.toBe("unknown");
        expect(rc?.locations[0]).toMatchObject({ path: "examples/bench-shop/server.mjs", exists: true });
        // The call is counted under the project, as the trial's jobs are (so the harness's cost line includes it).
        const used = await platform.sql.all<{ calls: number }>("SELECT calls FROM ai_usage WHERE project_id = ?", projectId);
        expect(used.reduce((n, r) => n + r.calls, 0)).toBe(1);
        // The bench result keeps it.
        expect(BenchVerificationSchema.parse(v).findings[0]!.rootCause).toEqual(rc);
        // The scripted model has no price: the added cost is unknown, not $0.
        expect(v.added.cost).toBeNull();
    });

    it("V11: the added cost is the root-cause calls' usage rows at the model's price, and the added time includes root cause", async () => {
        const projectId = String(platform.repo.createProject({ name: "bench-shop-cost" }).id);
        const store = new CandidateFindingStore(platform.sql);
        const attempt = { outcome: "failed", failedStep: 2, check: "status", value: "400", error: "Expected: 400 Received: 201", requests: [{ method: "POST", path: "/api/cart/items", status: 201, own: true }], stack: [] };
        const { finding } = await store.upsert({
            projectId,
            finding: { objective: null, actions: { stepCount: 2 }, expected: { text: "HTTP 400, as the API document says", source: "API document: POST /api/cart/items 400" }, observed: "201", evidence: { screenshots: [], requests: [], console: [] }, capture: "captured", independence: "not_run", confidence: "medium", fingerprint: "e".repeat(64), modelVersion: null, replays: [] },
        });
        await platform.sql.run("UPDATE candidate_findings SET attempts_json = ? WHERE id = ?", JSON.stringify([attempt, attempt, attempt]), finding.id);
        usageStoreFor(platform.db, platform.config).setPrice("scripted", { inputPerMTok: 3, outputPerMTok: 15 });
        let slow = 0;
        platform.llm = {
            modelName: "scripted",
            model: undefined as never,
            usage: { inputTokens: 0, outputTokens: 0 },
            text: async () => "",
            object: (async () => {
                await new Promise((r) => setTimeout(r, 30));
                slow++;
                return { hypotheses: [{ file: "server.mjs", line: SEED_LINE, explanation: "the unit price is added instead of the line total" }] };
            }) as LlmClient["object"],
        } as LlmClient;
        const v = await verifierOf(platform, 3)(projectId, [], undefined, "examples/bench-shop");
        expect(slow).toBe(1);
        const rows = await platform.sql.all<{ i: number; o: number }>("SELECT input_tokens AS i, output_tokens AS o FROM ai_usage WHERE project_id = ?", projectId);
        const expected = rows.reduce((n, r) => n + (r.i * 3 + r.o * 15) / 1_000_000, 0);
        expect(expected).toBeGreaterThan(0);
        expect(v.added.cost).toBeCloseTo(expected, 12);
        expect(v.added.durationMs).toBeGreaterThanOrEqual(30);
    });
});
