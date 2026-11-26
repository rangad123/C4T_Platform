/**
 * One run = one agent (Agent Workspace D1), owner report 2026-11-25: "When I run the API testing agent, it shows UI exploration. It should
 * only test the APIs and show results, PASS and FAIL." Each agent's run does its own work only:
 *   - the API agent explores the API only (no page exploration, whatever targets were asked), from the OpenAPI document or the calls
 *     earlier explorations captured (D4); with neither it needs input;
 *   - the page agents (accessibility, security, responsive UI, UX) explore pages, without the API tests;
 *   - Performance keeps the API target for its own timings and load check, without the API tests;
 *   - no check agent's run explores by objectives (that writes functional tests, Test Case Generation's work), and its progress has no
 *     test ideas stage.
 *
 * Browser-free: node scripts/with-lock.mjs tsc -- npx vitest run -c vitest.fast.config.ts tests/agent-run-scope-unit.test.ts
 */
import { describe, expect, it } from "vitest";
import { knownApisOf } from "../src/engine/memory/probe-reuse.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { objectivesOf } from "../src/platform/explore-task.js";
import { treePhases } from "../web/src/features/explore/explore-tree.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions } from "../src/platform/repo.js";
import { missingInputs } from "../src/platform/routes/agent-inputs.js";
import { agentRunOptions, type AgentId } from "../src/platform/testing-agents.js";

const o: JobOptions = { ...DEFAULT_JOB_OPTIONS };
const run = (agentId: AgentId, asked: { targets?: Array<"web" | "api" | "mobile"> } = {}) => agentRunOptions(agentId, { ...o, ...(asked.targets ? { targets: asked.targets } : {}) }, asked);
/** Another agent's switches a run has on (the page checks, the API tests and contract checks, functional test cases). */
const others = (r: JobOptions, own: string[]) =>
    ["accessibility", "securityChecks", "accessChecks", "visual", "healthChecks", "visionChecks", "performanceChecks", "loadChecks", "contractChecks", "inputChecks"].filter((k) => !own.includes(k) && (r as unknown as Record<string, unknown>)[k] === true);

describe("an API agent run tests the API only", () => {
    it("explores the API target alone, whatever targets the run asked for", () => {
        for (const targets of [undefined, ["web", "api"], ["web"], ["api"]] as const) {
            const r = run("api", targets ? { targets: [...targets] } : {});
            expect(r.targets, String(targets)).toEqual(["api"]);
            expect(r.agentId).toBe("api");
        }
    });

    it("turns on its API tests and contract checks and none of the page agents' checks or functional test cases", () => {
        const r = run("api");
        expect(r.contractChecks).toBe(true);
        expect(r.apiTests).not.toBe(false);
        expect(r.functionalTests).toBe(false);
        expect(others(r, ["contractChecks"])).toEqual([]);
        expect(r.variants ?? []).toEqual([]);
    });

    it("needs the OpenAPI document, or API calls captured by an earlier exploration (D4); with neither it needs input", () => {
        expect(missingInputs(["api"], {}, ["api"]).map((m) => m.input)).toEqual(["openApiUrl"]);
        expect(missingInputs(["api"], { openApiUrl: "http://shop.test/openapi.json" }, ["api"])).toEqual([]);
        expect(missingInputs(["api"], { capturedApis: true }, ["api"])).toEqual([]);
        expect(missingInputs(["api"], { capturedApis: false }, ["api"]).map((m) => m.input)).toEqual(["openApiUrl"]);
    });

    it("tests the calls earlier explorations captured, not the document's operations (the run reads the document itself)", () => {
        const api = (path: string, source: "network" | "openapi" | "documentation") => ({ method: "GET", path, origin: "http://shop.test", statuses: [200], source, usedIn: [], requiresAuth: false });
        const model = { origin: "http://shop.test", pages: [], apis: [api("/api/cart", "network"), api("/api/items", "openapi"), api("/api/list", "documentation")] } as unknown as AppModel;
        expect(knownApisOf(model)).toEqual({ origin: "http://shop.test", apis: [model.apis[0], model.apis[2]] });
        expect(knownApisOf({ ...model, apis: [model.apis[1]!] } as AppModel)).toBeUndefined();
        expect(knownApisOf(null)).toBeUndefined();
    });
});

describe("the other agents' runs do their own work only", () => {
    const OWN: Record<string, { targets: string[]; on: string[] }> = {
        accessibility: { targets: ["web"], on: ["accessibility"] },
        // Owner 2026-11-26: its access checks of API calls need the API target too; the API agent's tests stay off.
        security: { targets: ["web", "api"], on: ["securityChecks", "accessChecks"] },
        "responsive-ui": { targets: ["web"], on: ["visual"] },
        ux: { targets: ["web"], on: ["healthChecks"] },
        // Its timings of safe API calls and its load check need the API target; the API tests stay off.
        performance: { targets: ["web", "api"], on: ["performanceChecks", "loadChecks"] },
    };
    for (const [agentId, own] of Object.entries(OWN)) {
        it(`${agentId}: its own target and checks, no API tests, no functional test cases`, () => {
            const r = run(agentId as AgentId);
            expect(r.targets).toEqual(own.targets);
            if (r.targets.includes("api")) expect(r.apiTests).toBe(false);
            expect(r.contractChecks).toBe(false);
            expect(r.functionalTests).toBe(false);
            expect(others(r, own.on)).toEqual([]);
        });
    }

    it("no check agent's run explores by objectives; a Test Case Generation run and a run of a project without the Workspace still do", () => {
        const project = { testingModes: ["agent"] };
        for (const agentId of ["api", ...Object.keys(OWN)]) expect(objectivesOf(project, true, { agentId }), agentId).toEqual({});
        expect(objectivesOf(project, true, { agentId: "test-generation" })).toEqual({ objectives: true, dataOperators: true });
        expect(objectivesOf(project, false, {})).toEqual({ objectives: true });
        expect(objectivesOf(project, false)).toEqual({ objectives: true });
    });

    it("a check agent's progress has no test ideas stage (Test Case Generation's work); a plan and a run without an agent keep theirs", () => {
        for (const agentId of Object.keys(OWN)) expect(treePhases({ agentId }), agentId).toEqual(["discovery", "understanding", "generation", "validation"]);
        expect(treePhases({ agentId: "test-generation", planOnly: true })).toEqual(["discovery", "understanding", "planning"]);
        expect(treePhases({})).toEqual(["discovery", "understanding", "planning", "generation", "validation"]);
    });
});
