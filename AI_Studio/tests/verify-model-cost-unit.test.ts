/**
 * The verification after a job without a runner gets the project's model, as a verification job on a runner does (so the open classes
 * get their AI explanation and the root cause its model); the layer checks' AI proposals are counted under their own purpose; and the
 * benchmark's price table prices prompt-cache reads and writes. Scripted models only, no provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ calls: [] as Array<{ llm?: { modelName: string } }> }));
vi.mock("../src/platform/findings/verify-service.js", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    verifyAfterJob: async (_p: unknown, _job: unknown, o: { llm?: { modelName: string } } = {}) => {
        seen.calls.push(o);
        return undefined;
    },
}));

const { REPO_ROOT, loadConfig } = await import("../src/config.js");
const { bootstrap } = await import("../src/platform/bootstrap.js");
const { getScheduleServices } = await import("../src/platform/schedule-services.js");
const { DEFAULT_JOB_OPTIONS } = await import("../src/platform/repo.js");
const { proposeInvariants } = await import("../src/engine/validation/invariants.js");
const { proposeRowRelations } = await import("../src/engine/database/propose.js");
const { cleanSchema } = await import("../src/engine/database/probe.js");
const { normalisePurpose } = await import("../src/engine/llm/usage.js");
const { callCost, paidPricesIn, SpendGuard } = await import("../src/eval/bench/understanding/paid.js");
type LlmClient = import("../src/engine/llm/provider.js").LlmClient;
type Platform = import("../src/platform/bootstrap.js").Platform;

/** A scripted model that records the purpose of each call and answers `answer`. */
const scripted = (answer: unknown, purposes: string[] = []): LlmClient => ({
    modelName: "scripted-verify",
    model: undefined as never,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async (args: { purpose?: string }) => {
        purposes.push(String(args.purpose));
        return answer;
    }) as LlmClient["object"],
});

let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-model-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "verify-model-secret-key-0123456789", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", VERIFY_FINDINGS: "true" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the verification after a job on this machine", () => {
    it("is given the project's model; a job whose AI is blocked gets none", async () => {
        const services = getScheduleServices(platform, { makeLlm: () => scripted({}) });
        const projectId = String(platform.repo.createProject({ name: "Verify" }).id);
        const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5593", { ...DEFAULT_JOB_OPTIONS }) as string;
        const withAi = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [], startedBy: { kind: "key" } } as never);
        const blocked = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        for (const job of [withAi, blocked]) {
            platform.repo.setJobStatus(job.id, "COMPLETED");
            await services.onJobFinished(platform.repo.getJob(job.id)!);
        }
        await services.flush();
        expect(seen.calls.map((o) => o.llm?.modelName)).toEqual(["scripted-verify", undefined]);
    });
});

describe("the layer checks' AI proposals", () => {
    it("are counted under their own purpose, kept by the usage meter", async () => {
        const purposes: string[] = [];
        const apis = [{ method: "GET", path: "/api/cart", origin: "http://shop.test", statuses: [200], queryParams: [], source: "openapi" as const, usedIn: [], responseSchema: { type: "object", properties: { total: { type: "number" } } } }];
        const requirements = [{ id: "REQ-1", text: "The cart total is the sum of its lines." }];
        await proposeInvariants({ llm: scripted({ invariants: [] }, purposes) }, { requirements, apis, origins: new Set(["http://shop.test"]), dataChanges: true, secrets: [] });
        const schema = cleanSchema({ tables: [{ name: "carts", columns: ["id", "total"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [], rowCount: 1 }] } as never);
        await proposeRowRelations({ llm: scripted({ relations: [] }, purposes) }, { requirements, schema, secrets: [] });
        expect(purposes).toEqual(["layers", "layers"]);
        expect(normalisePurpose("layers")).toBe("layers");
    });
});

describe("the benchmark's price table", () => {
    const prices = paidPricesIn(path.join(REPO_ROOT, "eval/bench-prices-claude.json"))!;

    it("prices prompt-cache reads at a tenth of the input price and writes at 1.25 times, in both tiers", () => {
        expect(prices.tiers.map((t) => [t.inputPerMTok, t.cachedInputPerMTok, t.cacheWritePerMTok])).toEqual([
            [0.1, 0.01, 0.125],
            [0.5, 0.05, 0.625],
        ]);
        // 100,000 prompt tokens (90,000 read from the cache, 5,000 written to it, 5,000 plain) and 1,000 out, first tier:
        // 5,000 × 0.10 + 90,000 × 0.01 + 5,000 × 0.125 + 1,000 × 0.50, per million = $0.002525.
        expect(callCost(prices, 100_000, 1_000, { read: 90_000, write: 5_000 })).toBeCloseTo(0.002525, 10);
    });

    it("the spend guard charges what the answer's usage says at those prices", async () => {
        const f: typeof fetch = async () => new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1_000, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 1_000, output_tokens: 2_000 } }), { status: 200, headers: { "content-type": "application/json" } });
        const g = new SpendGuard(1, prices);
        await g.fetch(f)("https://provider.test/v1/messages", { method: "POST", body: JSON.stringify({ max_tokens: 4000 }) });
        // 1,000 × 0.10 + 2,000 × 0.01 + 1,000 × 0.125 + 2,000 × 0.50, per million = $0.001245.
        expect(g.spent).toBeCloseTo(0.001245, 10);
    });
});
