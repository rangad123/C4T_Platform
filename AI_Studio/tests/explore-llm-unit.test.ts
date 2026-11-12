/**
 * The AI of an exploration on a runner (round 51): the runner's client (agent/remote-llm.ts) posts every model call to the platform's handler
 * (platform/explore-llm.ts), which runs it on the job's own model with the job's meter and budgets. The "transport" here is the handler
 * itself with a JSON round trip in between, and the job's model is a scripted double; nothing calls a real model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APICallError, generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { EXPLORE_LLM_MAX_CALLS } from "../src/agent-protocol/explore-llm.js";
import type { ExplorePost } from "../src/agent/explore-transport.js";
import { errorFromAnswer, remoteLlmClient } from "../src/agent/remote-llm.js";
import { loadConfig } from "../src/config.js";
import { isLlmCallError, LlmCallError } from "../src/engine/llm/errors.js";
import { llmClientFromModel, LlmNotConfiguredError } from "../src/engine/llm/provider.js";
import { isBudgetExceeded } from "../src/engine/llm/usage.js";
import { withRoute } from "../src/engine/llm/routing.js";
import { AI_REFUSED } from "../src/platform/ai-config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { AI_NOT_SET_UP, errorOf, forgetExploreLlm, handleExploreLlm } from "../src/platform/explore-llm.js";
import type { ExploreTaskRef } from "../src/platform/explore-task.js";
import { HttpError } from "../src/platform/http-error.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

const KEY = "sk-test-key-not-real-0123456789";
const PROVIDER = "secretprovider";
const usage = (i: number, o: number) => ({
    inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: o, text: o, reasoning: 0 },
});

type Gen = MockLanguageModelV3["doGenerate"];
/** What the job's model does next; each test sets it. */
let next: Gen = async () => ({
    content: [{ type: "text", text: "hello" }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: usage(10, 5),
    warnings: [],
});
let serverCalls = 0;
const mock = new MockLanguageModelV3({
    provider: PROVIDER,
    modelId: "main-model",
    doGenerate: (o) => (serverCalls++, next(o)),
});

let dir: string;
let platform: Platform;
let budgetPlatform: Platform;
const answers: string[] = [];

function platformWith(extra: Record<string, string>): Platform {
    const d = fs.mkdtempSync(path.join(dir, "p-"));
    return bootstrap(
        loadConfig({
            DATA_DIR: d,
            SCHEDULER_ENABLED: "false",
            WORKER_EMBEDDED: "false",
            LLM_PROVIDER: "anthropic",
            LLM_API_KEY: KEY,
            LLM_MODEL: "main-model",
            SECRET_KEY: "explore-llm-secret-0123456789",
            ...extra,
        } as never),
    );
}

let taskNo = 0;
async function taskOn(p: Platform): Promise<ExploreTaskRef> {
    const project = p.repo.createProject({ name: `p${++taskNo}` }) as {
        id: string;
    };
    const app = p.repo.createApplication(project.id, "http://example.test", {
        ...DEFAULT_JOB_OPTIONS,
    });
    const job = await p.repo.createJob(project.id, app, {
        ...DEFAULT_JOB_OPTIONS,
    });
    return {
        taskId: `t${taskNo}`,
        attempt: 1,
        jobId: job.id,
        projectId: project.id,
        agentId: "a1",
    };
}

/** The runner's transport: JSON both ways, an HttpError as a rejected request, every answer kept for the leak check. */
function postTo(p: Platform, task: ExploreTaskRef): ExplorePost {
    const deps = {
        repo: p.repo,
        config: p.config,
        makeLlm: () => llmClientFromModel(mock as unknown as LanguageModel, "main-model"),
    };
    return async (route, body) => {
        expect(route).toBe("llm");
        try {
            const a = await handleExploreLlm(deps, task, JSON.parse(JSON.stringify(body)));
            const text = JSON.stringify(a);
            answers.push(text);
            return JSON.parse(text);
        } catch (e) {
            if (e instanceof HttpError) throw Object.assign(new Error(e.message), { status: e.status });
            throw e;
        }
    };
}

beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-llm-"));
    platform = platformWith({});
    budgetPlatform = platformWith({ AI_JOB_TOKEN_LIMIT: "1000" });
});

afterAll(() => {
    // Nothing the platform answered names the key or the provider.
    expect(answers.length).toBeGreaterThan(5);
    // Provider metadata still comes back, under a name that says nothing.
    expect(answers.some((a) => a.includes('"p1"'))).toBe(true);
    for (const a of answers) {
        expect(a).not.toContain(KEY);
        expect(a.toLowerCase()).not.toContain(PROVIDER);
        expect(a.toLowerCase()).not.toContain("anthropic");
    }
    platform.db.close();
    budgetPlatform.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("remote AI client", () => {
    it("object, text and imageObject come back, and usage is counted on both sides", async () => {
        const task = await taskOn(platform);
        const llm = remoteLlmClient({
            post: postTo(platform, task),
            modelName: "main-model",
        });
        let seen: Parameters<Gen>[0] | undefined;
        next = async (o) => {
            seen = o;
            return {
                content: [{ type: "text", text: JSON.stringify({ answer: 42 }) }],
                finishReason: { unified: "stop", raw: "end_turn" },
                usage: usage(100, 20),
                warnings: [],
                providerMetadata: { anthropic: { cacheCreationInputTokens: 0 } },
            };
        };
        expect(
            await llm.object({
                system: "s",
                prompt: "p",
                schema: z.object({ answer: z.number() }),
                purpose: "planning",
            }),
        ).toEqual({ answer: 42 });
        expect(seen?.responseFormat?.type).toBe("json");
        expect(seen?.abortSignal).toBeUndefined();

        next = async () => ({
            content: [{ type: "text", text: "plain words" }],
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: usage(50, 10),
            warnings: [],
        });
        expect(await llm.text({ system: "s", prompt: "p" })).toBe("plain words");

        const png = new Uint8Array([137, 80, 78, 71, 0, 255, 1, 2]);
        next = async (o) => {
            const user = o.prompt.find((m) => m.role === "user")!;
            const file = (
                user.content as Array<{
                    type: string;
                    data?: unknown;
                    mediaType?: string;
                }>
            ).find((c) => c.type === "file")!;
            expect(file.mediaType).toBe("image/png");
            expect(Array.from(file.data as Uint8Array)).toEqual(Array.from(png));
            return {
                content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
                finishReason: { unified: "stop", raw: "end_turn" },
                usage: usage(30, 3),
                warnings: [],
            };
        };
        expect(
            await llm.imageObject!({
                system: "s",
                prompt: "look",
                images: [{ data: png, mediaType: "image/png" }],
                schema: z.object({ ok: z.boolean() }),
            }),
        ).toEqual({ ok: true });

        expect(llm.usage).toMatchObject({ inputTokens: 180, outputTokens: 33 });
        // The job's usage is the server's: written when the task ends.
        await forgetExploreLlm(task.taskId);
        const row = platform.db.get<{ i: number; o: number }>("SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM ai_usage WHERE job_id = ?", task.jobId);
        expect(row).toEqual({ i: 180, o: 33 });
    });

    it("a tool-calling agent works: the tool runs on the runner, the model on the platform", async () => {
        const task = await taskOn(platform);
        const llm = remoteLlmClient({
            post: postTo(platform, task),
            modelName: "main-model",
        });
        const ran: string[] = [];
        let step = 0;
        next = async (o) => {
            step++;
            if (step === 1) {
                expect(o.tools?.map((t) => t.name)).toEqual(["click"]);
                return {
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: "c1",
                            toolName: "click",
                            input: JSON.stringify({ target: "#go" }),
                        },
                    ],
                    finishReason: { unified: "tool-calls", raw: "tool_use" },
                    usage: usage(10, 5),
                    warnings: [],
                };
            }
            const tool_ = o.prompt.find((m) => m.role === "tool")!;
            expect(JSON.stringify(tool_.content)).toContain("clicked #go");
            return {
                content: [{ type: "text", text: "finished" }],
                finishReason: { unified: "stop", raw: "end_turn" },
                usage: usage(10, 5),
                warnings: [],
            };
        };
        const res = await generateText({
            model: llm.model,
            prompt: "do it",
            tools: {
                click: tool({
                    inputSchema: z.object({ target: z.string() }),
                    execute: async ({ target }) => (ran.push(target), `clicked ${target}`),
                }),
            },
            stopWhen: stepCountIs(4),
        });
        expect(ran).toEqual(["#go"]);
        expect(res.text).toBe("finished");
        await forgetExploreLlm(task.taskId);
    });

    it("failures come back as the same error classes, without the provider's words, and are not retried again", async () => {
        const task = await taskOn(platform);
        const llm = remoteLlmClient({
            post: postTo(platform, task),
            modelName: "main-model",
        });
        next = async () => {
            throw new APICallError({
                message: `invalid x-api-key ${KEY} for ${PROVIDER}`,
                url: "https://api.example.test",
                requestBodyValues: {},
                statusCode: 401,
                responseBody: JSON.stringify({
                    error: { type: "authentication_error", message: `bad key ${KEY}` },
                }),
                isRetryable: false,
            });
        };
        const err = await llm.text({ system: "s", prompt: "p" }).catch((e) => e);
        expect(isLlmCallError(err)).toBe(true);
        expect((err as LlmCallError).cls).toBe("auth");
        expect(err.message).not.toContain(KEY);
        expect(err.message.toLowerCase()).not.toContain(PROVIDER);

        serverCalls = 0;
        next = async () => {
            throw new APICallError({
                message: "Too many requests",
                url: "https://api.example.test",
                requestBodyValues: {},
                statusCode: 429,
                isRetryable: true,
            });
        };
        const busy = await llm.text({ system: "s", prompt: "p" }).catch((e) => e);
        expect((busy as LlmCallError).cls).toBe("rate_limited");
        // The platform's own retries are the only ones: the runner asks once.
        expect(serverCalls).toBe(1);
        await forgetExploreLlm(task.taskId);
    });

    it("a budget refusal stops the call before it reaches the model", async () => {
        const task = await taskOn(budgetPlatform);
        const llm = remoteLlmClient({
            post: postTo(budgetPlatform, task),
            modelName: "main-model",
        });
        next = async () => ({
            content: [{ type: "text", text: "big" }],
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: usage(2000, 500),
            warnings: [],
        });
        expect(await llm.text({ system: "s", prompt: "p" })).toBe("big");
        serverCalls = 0;
        const err = await llm.text({ system: "s", prompt: "p" }).catch((e) => e);
        expect(isBudgetExceeded(err)).toBe(true);
        expect(serverCalls).toBe(0);
        await forgetExploreLlm(task.taskId);
    });

    it("routing to the fast model follows the runner's agent scope, and an escalation on the platform moves the scope", async () => {
        const p = platformWith({ LLM_MODEL_FAST: "fast-model" });
        const task = await taskOn(p);
        const log: string[] = [];
        let fastFails = false;
        const fast = new MockLanguageModelV3({
            provider: PROVIDER,
            modelId: "fast-model",
            doGenerate: async () => {
                log.push("fast");
                if (fastFails)
                    throw new APICallError({
                        message: "bad request",
                        url: "https://api.example.test",
                        requestBodyValues: {},
                        statusCode: 400,
                        isRetryable: false,
                    });
                return {
                    content: [{ type: "text", text: "f" }],
                    finishReason: { unified: "stop", raw: "end_turn" },
                    usage: usage(1, 1),
                    warnings: [],
                };
            },
        });
        next = async () => (
            log.push("main"),
            {
                content: [{ type: "text", text: "m" }],
                finishReason: { unified: "stop", raw: "end_turn" },
                usage: usage(1, 1),
                warnings: [],
            }
        );
        const deps = {
            repo: p.repo,
            config: p.config,
            makeLlm: () => llmClientFromModel(mock as unknown as LanguageModel, "main-model"),
            makeFastLlm: () => llmClientFromModel(fast as unknown as LanguageModel, "fast-model"),
        };
        const post: ExplorePost = async (_r, body) => JSON.parse(JSON.stringify(await handleExploreLlm(deps, task, JSON.parse(JSON.stringify(body)))));
        const llm = remoteLlmClient({ post, modelName: "main-model" });
        const step = () => generateText({ model: llm.model, prompt: "step" });
        await step();
        await llm.text({ system: "s", prompt: "p", purpose: "planning" });
        expect(log).toEqual(["main", "main"]);
        log.length = 0;
        await withRoute({ task: "authoring", what: "Scenario S-001" }, async () => {
            await step();
            fastFails = true;
            await step();
            fastFails = false;
            await step();
        });
        // A fast step; a failed fast step answered by the main model; the rest of that scenario on the main model.
        expect(log).toEqual(["fast", "fast", "main", "main"]);
        await forgetExploreLlm(task.taskId);
        p.db.close();
    });

    it("own-key sentences and a missing AI keep their plain words only", () => {
        const own = errorOf(new LlmCallError({ cls: "auth", detail: `${KEY} rejected by ${PROVIDER}` }, { sentence: AI_REFUSED }));
        expect(JSON.stringify(own)).not.toContain(KEY);
        const back = errorFromAnswer(own, "m");
        expect(back).toBeInstanceOf(LlmCallError);
        expect(back.message).toBe(AI_REFUSED);

        const none = errorOf(new LlmNotConfiguredError('No credentials for LLM provider "anthropic". Set ANTHROPIC_API_KEY'));
        expect(none).toEqual({ kind: "unavailable", message: AI_NOT_SET_UP });
        expect(errorFromAnswer(none, "m")).toBeInstanceOf(LlmNotConfiguredError);
        expect(
            errorOf(new LlmNotConfiguredError("x"), {
                blocked: "Blocked for this project.",
            }),
        ).toEqual({ kind: "unavailable", message: "Blocked for this project." });
    });

    it("refuses a body too large (413), a malformed one (400) and calls past the cap (429)", async () => {
        const task = await taskOn(platform);
        const deps = {
            repo: platform.repo,
            config: platform.config,
            makeLlm: () => llmClientFromModel(mock as unknown as LanguageModel, "main-model"),
        };
        const status = (p: Promise<unknown>) =>
            p.then(
                () => 200,
                (e) => (e as HttpError).status,
            );
        const huge = "A".repeat(17 * 1024 * 1024);
        expect(
            await status(
                handleExploreLlm(deps, task, {
                    options: {
                        prompt: [
                            {
                                role: "user",
                                content: [{ type: "file", mediaType: "image/png", data: huge }],
                            },
                        ],
                    },
                }),
            ),
        ).toBe(413);
        expect(await status(handleExploreLlm(deps, task, { options: { prompt: "nope" } }))).toBe(400);
        // A file part never carries an address for the platform to fetch.
        expect(
            await status(
                handleExploreLlm(deps, task, {
                    options: {
                        prompt: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "file",
                                        mediaType: "image/png",
                                        data: "http://169.254.169.254/latest",
                                    },
                                ],
                            },
                        ],
                    },
                }),
            ),
        ).toBe(400);
        next = async () => ({
            content: [{ type: "text", text: "." }],
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: usage(0, 0),
            warnings: [],
        });
        const body = {
            options: {
                prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            },
        };
        for (let i = 0; i < EXPLORE_LLM_MAX_CALLS; i++) await handleExploreLlm(deps, task, body);
        expect(await status(handleExploreLlm(deps, task, body))).toBe(429);
        // A new attempt of the task starts its own count.
        expect(await status(handleExploreLlm(deps, { ...task, attempt: 2 }, body))).toBe(200);
        await forgetExploreLlm(task.taskId);
    }, 60_000);
});
