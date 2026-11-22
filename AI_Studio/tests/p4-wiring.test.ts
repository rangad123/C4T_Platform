/**
 * Phase 4 integration wiring (CP2): the C11 checks the orchestrator makes itself, through runGeneration on the real bench-rbac app (API
 * only, data changes on, no real model):
 *   - the sign-in limit check (T25 rateLimitSpec): made once from requirement 2.14 behind the bench gate; red on BR-09, green clean; not
 *     made without the gate;
 *   - the cross-account hand-over (T25): the access stage's two-account list evidence goes to the security module's hook with the list
 *     checks that found a problem (BR-01), and those findings carry the hand-over line.
 * Ports 9621-9623. Run under the browser lock: node scripts/with-lock.mjs browser -- npx vitest run tests/p4-wiring.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { ApiListRow } from "../src/engine/identity/access.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { GenerationSink } from "../src/engine/orchestrator.js";
import { handOverLine } from "../src/engine/security/functional.js";
import { startBenchApp } from "../src/eval/bench/verify/app.js";
import { layersOnlyLlm } from "../src/eval/bench/layers-only.js";

beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
});

const LIMIT = "- 2.14 After 5 failed sign-ins for the same email address within one minute, every sign-in for that email address is refused for one minute with \"Too many failed sign-ins. Try again in a minute.\" (API: 429), even with the right password.";
const ROLES = ["ana", "ben"].map((n) => ({ name: n, username: `${n}@example.test`, password: "Password1!" }));
type Saved = { testId: string; title: string; validation?: string; reason?: string | null };
type HandOver = { origin: string; rows: readonly ApiListRow[]; findings: string[] };

async function generate(port: number, defects: string, o: { gate: boolean; access: boolean }) {
    const app = await startBenchApp("bench-rbac", port, defects);
    const tests: Saved[] = [];
    const handedOver: HandOver[] = [];
    let n = 0;
    const sink: GenerationSink = {
        phase: async () => undefined,
        counters: async () => undefined,
        saveModel: async () => undefined,
        nextTestKey: async (prefix) => `${prefix}-${String(++n).padStart(3, "0")}`,
        createTest: async ({ spec }) => {
            tests.push({ testId: spec.testId, title: spec.title });
            return { id: spec.testId, testId: spec.testId };
        },
        updateTest: async (h, patch) => {
            const t = tests.find((x) => x.testId === h.testId);
            if (t && patch.validation) Object.assign(t, { validation: patch.validation, reason: patch.reason });
            else if (t && patch.reason) t.reason = patch.reason;
        },
        saveScript: async (h) => `script-${h.testId}`,
        recordExecution: async () => undefined,
        saveTextArtifact: async () => undefined,
        saveBaselines: async () => undefined,
        loadBaselines: async () => [],
        startAgentRun: async (_role, subject) => `run-${subject.split(" ")[0]}`,
        agentAction: () => undefined,
        finishAgentRun: async () => undefined,
    };
    try {
        const { runGeneration } = await import("../src/engine/orchestrator.js");
        await runGeneration(
            {
                config: loadConfig({ CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" } as never),
                llm: layersOnlyLlm() as LlmClient,
                emit: () => undefined,
                handOverCrossAccount: (i) => (handedOver.push({ ...i, findings: [...i.findings] }), { applicationName: "Notes" }),
            },
            {
                url: app.base, targets: ["api"], maxPages: 3, maxDepth: 1, maxScenarios: 0, allowMutatingApiTests: true, useMemory: false,
                credentials: { username: "ana@example.test", password: "Password1!" },
                ...(o.access ? { roles: ROLES } : {}),
                ...(o.gate ? { riskyChecksGate: "bench" } : {}),
                requirements: { name: "requirements.md", text: LIMIT },
                functionalTests: false, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: o.access, visionChecks: false,
            } as never,
            sink,
        );
        return { tests, handedOver };
    } finally {
        await app.stop();
    }
}

const limited = (tests: Saved[]) => tests.filter((t) => t.title === "Sign-in is limited after 5 failed attempts");

describe("C11 wiring through the engine on bench-rbac", () => {
    it("BR-09 and BR-01 seeded: the sign-in limit check is red; the list evidence is handed over with the list findings, which say so", async () => {
        const { tests, handedOver } = await generate(9621, "BR-09,BR-01", { gate: true, access: true });
        expect(limited(tests)).toHaveLength(1);
        expect(limited(tests)[0]!.validation).toBe("NEEDS_REVIEW");
        expect(handedOver).toHaveLength(1);
        expect(handedOver[0]!.rows.length).toBeGreaterThan(0);
        expect(handedOver[0]!.findings.length).toBeGreaterThan(0);
        for (const key of handedOver[0]!.findings) {
            const t = tests.find((x) => x.testId === key)!;
            expect(t.validation).toBe("NEEDS_REVIEW");
            expect(t.reason).toContain(handOverLine("Notes"));
        }
        // Only the list findings carry the line.
        expect(tests.filter((t) => (t.reason ?? "").includes(handOverLine("Notes"))).map((t) => t.testId).sort()).toEqual([...handedOver[0]!.findings].sort());
    }, 1_500_000);

    it("clean: the sign-in limit check is green, and the evidence is handed over with no finding", async () => {
        const { tests, handedOver } = await generate(9622, "none", { gate: true, access: true });
        expect(limited(tests)).toHaveLength(1);
        expect(limited(tests)[0]!.validation).toBe("VALIDATED");
        expect(handedOver).toHaveLength(1);
        expect(handedOver[0]!.findings).toEqual([]);
    }, 1_500_000);

    it("without the gate no sign-in limit check is made", async () => {
        const { tests } = await generate(9623, "BR-09", { gate: false, access: false });
        expect(limited(tests)).toEqual([]);
        expect(tests.length).toBeGreaterThan(0);
    }, 1_500_000);
});
