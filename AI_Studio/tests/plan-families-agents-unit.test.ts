/**
 * The plan's kinds of test follow the project's chosen testing agents (founder 2026-11-19, sheet row 19; SPEC R13, P4): a family is
 * listed only when one of the chosen agents does it. The switches come from the server's own switchesFor, so the test follows the
 * agent catalogue (src/platform/testing-agents.ts) and not a copy of it. Browser-free.
 */
import { describe, expect, it } from "vitest";
import { switchesFor, type AgentId } from "../src/platform/testing-agents.js";
import { familiesForAgents } from "../web/src/features/onboarding/plan-agents.js";
import type { PlanFamily } from "../web/src/features/onboarding/onboarding.js";
import { projectAgentView } from "../web/src/features/testing-agents/case-agent-view.js";

// The twelve web and API families of a plan (src/engine/planning/preview.ts webAndApiFamilies), by id and the switch each answers to.
const WEB_API: Array<[string, string]> = [
    ["journeys", "web"],
    ["api", "api"],
    ["contract", "contractChecks"],
    ["accessibility", "accessibility"],
    ["health", "healthChecks"],
    ["input", "inputChecks"],
    ["security", "securityChecks"],
    ["access", "accessChecks"],
    ["performance", "performanceChecks"],
    ["load", "loadChecks"],
    ["visual", "visual"],
    ["vision", "visionChecks"],
];
const fam = (id: string, option: string, needs: PlanFamily["needs"] = "web"): PlanFamily => ({ id, label: id, about: "", count: 3, on: true, option, needs });
const ALL = WEB_API.map(([id, option]) => fam(id, option));
const PHONE = [fam("phoneStart", "mobile", "mobile"), fam("phoneAccessibility", "accessibility", "mobile")];
const shown = (agents: AgentId[], families = ALL) => familiesForAgents(families, switchesFor(agents)).map((f) => f.id);

describe("the plan's kinds of test, per chosen agent", () => {
    it("an Accessibility-only project lists only Accessibility", () => {
        expect(shown(["accessibility"])).toEqual(["accessibility"]);
    });

    it("a Test Case Generation project lists no check: only the journeys its test cases come from", () => {
        expect(shown(["test-generation"])).toEqual(["journeys"]);
        // Q6: with other agents chosen as well, the project still does the test-case job only.
        expect(shown(["test-generation", "accessibility", "security"])).toEqual(["journeys", "accessibility", "security", "access"]);
    });

    it("each agent brings its own kinds, including the ones it offers per run", () => {
        expect(shown(["performance"])).toEqual(["performance", "load"]);
        expect(shown(["ux"])).toEqual(["health", "vision"]);
        expect(shown(["api"])).toEqual(["api", "contract"]);
        expect(shown(["responsive-ui"])).toEqual(["visual"]);
    });

    it("no agent owns form input any more, so it is never listed for chosen agents", () => {
        const everyAgent: AgentId[] = ["api", "accessibility", "security", "responsive-ui", "ux", "performance", "test-generation"];
        expect(shown(everyAgent)).not.toContain("input");
        expect(shown(everyAgent)).toHaveLength(11);
    });

    it("a phone plan keeps its own screens; its accessibility follows the Accessibility agent", () => {
        expect(shown(["test-generation"], PHONE)).toEqual(["phoneStart"]);
        expect(shown(["accessibility", "test-generation"], PHONE)).toEqual(["phoneStart", "phoneAccessibility"]);
    });

    it("nothing narrows the list when no agents were chosen (code, mixed, or no choice saved)", () => {
        expect(familiesForAgents(ALL, null)).toBe(ALL);
    });
});

describe("which projects are Test Case Generation projects (SPEC D3, Q6)", () => {
    type Agents = Parameters<typeof projectAgentView>[1] & {};
    const agents = (over: Partial<Agents>): Agents => ({ applies: true, agents: ["test-generation"], source: "chosen", switches: switchesFor(["test-generation"]), ...over });
    const agentOnly = { testingModes: ["agent"] };

    it("an AI-agent-only project whose saved agents include it", () => {
        expect(projectAgentView(agentOnly, agents({})).caseAgent).toBe(true);
        expect(projectAgentView(agentOnly, agents({ agents: ["accessibility", "test-generation"] })).caseAgent).toBe(true);
    });

    it("not a mixed or code project, not one with no saved choice, not one without the agent", () => {
        expect(projectAgentView({ testingModes: ["agent", "code"] }, agents({}))).toEqual({ caseAgent: false, switches: null });
        expect(projectAgentView({ testingModes: ["code"] }, agents({ applies: false }))).toEqual({ caseAgent: false, switches: null });
        expect(projectAgentView(agentOnly, agents({ source: "matched" }))).toEqual({ caseAgent: false, switches: null });
        expect(projectAgentView(agentOnly, agents({ agents: ["accessibility"], switches: switchesFor(["accessibility"]) })).caseAgent).toBe(false);
        expect(projectAgentView(undefined, undefined)).toEqual({ caseAgent: false, switches: null });
        // An older project with no modes saved is a mixed one.
        expect(projectAgentView({ testingModes: [] }, agents({}))).toEqual({ caseAgent: false, switches: null });
    });
});
