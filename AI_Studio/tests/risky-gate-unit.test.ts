/**
 * Risky saved checks at run time (Phase 4 Q4): a test that sends requests several times at once, writes as another identity, or repeats
 * sign-ins runs only when the job that runs it was given the gate. Without it the script skips itself with one sentence and the test keeps
 * its result; the identity-write helper also holds the revoke rule and the 8-write cap per run for an edited test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { riskyEnv } from "../src/engine/validation/runner.js";
import { RISKY_SKIPPED, riskyKindOf } from "../src/engine/validation/risky.js";
import { validateBatch } from "../src/engine/validation/validator.js";
import { accessHelper, fakeBrowser, setAccounts } from "./identity-fake-browser.js";

const api = (steps: unknown[], tags: string[] = []) => TestSpecSchema.parse({ testId: "API-001", title: "A risky check", kind: "api", tags, steps });
const parallel = api([{ action: "request", method: "POST", path: "/orders", parallel: 3 }, { action: "assertResponse", check: "relation", expression: "ok == 1" }]);
const rateLimit = api([{ action: "request", method: "POST", path: "/api/login", auth: "none" }, { action: "assertResponse", check: "status", expected: 429 }], ["security", "rate-limiting"]);
const identity = TestSpecSchema.parse({ testId: "WEB-001", title: "A risky check", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "accessDenied", expected: JSON.stringify({ identityWrite: "role", as: "ana", by: "ada", method: "PATCH", path: "/api/u/{id}", param: "id", whoAmI: "/api/me", sev: "high" }) }] });
const plain = api([{ action: "request", method: "GET", path: "/x" }, { action: "assertResponse", check: "status", expected: 200 }]);

describe("risky saved tests skip themselves without the gate", () => {
    it("are told by what they would send, a hand-written parallel step included", () => {
        expect([parallel, rateLimit, identity, plain].map(riskyKindOf)).toEqual(["concurrency", "rate-limit", "identity-write", undefined]);
    });

    it("every risky script starts with the gate line; other scripts do not", () => {
        const gate = 'test.skip(process.env.AITP_RISKY_CHECKS !== "1"';
        for (const [s, fw] of [[parallel, "playwright-api"], [rateLimit, "playwright-api"], [identity, "playwright"]] as const) expect(renderScript(s, fw, { baseUrl: "http://127.0.0.1:9000" }).content).toContain(gate);
        expect(renderScript(plain, "playwright-api", { baseUrl: "http://127.0.0.1:9000" }).content).not.toContain(gate);
    });

    it("the run's gate reaches the script only through the job: AITP_RISKY_CHECKS, the gate kind and the run's write counter folder", () => {
        expect(riskyEnv({}, "/run")).toEqual({});
        expect(riskyEnv({ riskyChecks: "bench" }, "/run")).toEqual({ AITP_RISKY_CHECKS: "1", AITP_RISKY_GATE: "bench", AITP_RISKY_DIR: path.join("/run", "risky") });
    });

    it("a skipped risky test is not run again and keeps its result (NOT_RUN), with the sentence", async () => {
        const config = loadConfig({});
        const runs: string[] = [];
        const events: Array<{ kind: string; message: string }> = [];
        const executor = {
            name: "fake",
            async execute(_a: unknown, batch: { scripts: Array<{ testId: string }> }) {
                runs.push(...batch.scripts.map((s) => s.testId));
                return batch.scripts.map((s) => ({ testId: s.testId, status: "skipped" as const, durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));
            },
        };
        const outcomes = await validateBatch(
            { config, llm: undefined as never, emit: (e) => events.push(e) },
            { scratchDir: config.scratchDir, env: { baseUrl: "http://127.0.0.1:1", headless: true }, render: { baseUrl: "http://127.0.0.1:1" }, model: { pages: [], apis: [] } as never, maxRepairAttempts: 2, workers: 1, retryFailures: 2, executor: executor as never },
            [{ spec: parallel, framework: "playwright-api" }],
            { async onAttempt() {}, async onFinal() {} },
        );
        expect(runs).toEqual(["API-001"]);
        expect(outcomes[0]!.status).toBe("NOT_RUN");
        expect(events.find((e) => e.kind === "risky_check_skipped")?.message).toBe(`API-001: ${RISKY_SKIPPED}`);
    });
});

describe("the identity-write helper holds its rules for an edited test", () => {
    const answer = (c: { url: string; method?: string; who: string }) => (c.url.endsWith("/api/me") ? { status: 200, body: JSON.stringify({ id: `u-${c.who}`, role: c.who === "ada" ? "admin" : "user" }) } : c.method && c.method !== "GET" ? { status: 403, body: "{}" } : { status: 200, body: JSON.stringify({ id: "n3", title: "x" }) });
    const run = (cfg: Record<string, unknown>) => {
        const b = fakeBrowser({ answer });
        return accessHelper.accessAssert(b.page, "http://127.0.0.1:9000/", JSON.stringify({ sev: "high", whoAmI: "/api/me", documented: "404", ...cfg })).then(() => ({ ok: true, error: undefined as string | undefined, b }), (e: Error) => ({ ok: false, error: e.message as string | undefined, b }));
    };

    it("stops a share only on a bench or fixture run", async () => {
        setAccounts(["ana", "ben"]);
        const revoke = { identityWrite: "revoke", as: "ana", by: "ben", method: "DELETE", path: "/api/notes/n3/share/{userId}", param: "userId", read: "/api/notes/n3" };
        process.env.AITP_RISKY_GATE = "authorization";
        const r = await run(revoke);
        expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: stopping a share is not undone/) });
        expect(r.b.calls.some((c) => c.method === "DELETE")).toBe(false);
        process.env.AITP_RISKY_GATE = "bench";
        expect((await run(revoke)).b.calls.some((c) => c.method === "DELETE")).toBe(true);
        delete process.env.AITP_RISKY_GATE;
    });

    it("sends at most 8 writes in one run, counted across the run's scripts", async () => {
        setAccounts(["ana"]);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risky-"));
        process.env.AITP_RISKY_DIR = dir;
        try {
            const owner = { identityWrite: "owner", as: "ana", method: "PATCH", path: "/api/notes/n3" };
            let sent = 0;
            let refused = 0;
            for (let i = 0; i < 10; i++) {
                const r = await run(owner);
                sent += r.b.calls.filter((c) => c.method === "PATCH").length;
                if (!r.ok && /more than 8 writes/.test(r.error ?? "")) refused++;
            }
            expect(sent).toBe(8);
            expect(refused).toBe(2);
        } finally {
            delete process.env.AITP_RISKY_DIR;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
