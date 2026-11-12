/**
 * Testing agents (platform/testing-agents.ts):
 *
 *   GET /api/testing-agents                   → { agents: [agent + projects], canRun, ai }   every agent, with the asker's projects using it
 *   GET /api/testing-agents/:agentId          → { agent, projects, canRun, ai }               one agent (404 for an unknown id)
 *   GET /api/projects/:id/testing-agents      → { applies, agents, source, switches, platforms }
 *   PUT /api/projects/:id/testing-agents      { agents: [ids] } → the same, after saving the choice
 *
 * Projects are listed only when the asker can reach them (visibleProjectsOf). A project's choice is changed with "Change project
 * settings" and only while it is tested by the AI agent; at least one available agent that works on its platform is required.
 */
import type { Platform } from "../bootstrap.js";
import { actorOf } from "../auth/access.js";
import { actorLabel, currentActor } from "../auth/actor.js";
import { visibleProjectsOf } from "../auth/project-scope.js";
import { HttpError } from "../http-error.js";
import type { Row } from "../db.js";
import { DEFAULT_PLATFORMS, projectSetupOf, type ProjectPlatform, type TestingMode } from "../project-setup.js";
import type { JobOptions, Repo } from "../repo.js";
import { runsCanStartHere } from "../suite-run.js";
import { platformAi } from "../ai-config.js";
import { AGENTS_NEED_AGENT_MODE, agentById, applyAgentChoice, switchesFor, TESTING_AGENTS, TestingAgentStore, validateChoice, type AgentId, type AskedSwitches, type TestingAgent } from "../testing-agents.js";
import type { RouteCtx } from "./types.js";

export const AGENT_NOT_FOUND = "Testing agent not found";

const stores = new WeakMap<Platform, TestingAgentStore>();
/** The one store of a platform (server.ts reads the choice when an exploration starts). */
export function testingAgentsOf(p: Platform, repo: Repo = p.repo): TestingAgentStore {
    let s = stores.get(p);
    if (!s) stores.set(p, (s = new TestingAgentStore(p.db.sql, repo)));
    return s;
}

/**
 * The `agents` of a new project's body (POST /api/projects), checked before the project is made: left out, undefined (none saved,
 * so older clients keep working); given for a project not tested by the AI agent, refused.
 */
export function checkedAgentChoice(body: unknown, platforms: readonly ProjectPlatform[] | undefined, modes: readonly TestingMode[]): AgentId[] | undefined {
    const raw = (body as { agents?: unknown } | null | undefined)?.agents;
    if (raw === undefined) return undefined;
    if (!modes.includes("agent")) throw new HttpError(400, AGENTS_NEED_AGENT_MODE);
    return validateChoice(raw, platforms?.length ? platforms : DEFAULT_PLATFORMS);
}

/** An exploration's options under the project's saved choice of agents (unchanged when none is saved or the project is not in agent mode). */
export async function withAgentChoice(p: Platform, row: Row, options: JobOptions, asked: AskedSwitches): Promise<JobOptions> {
    if (!projectSetupOf(row).testingModes.includes("agent")) return options;
    const chosen = await testingAgentsOf(p).chosen(String(row.id));
    return chosen ? applyAgentChoice(options, asked, chosen) : options;
}

/** The public shape of an agent: everything but the switch names, which the page reads per project. */
const publicAgent = (a: TestingAgent) => ({
    id: a.id,
    name: a.name,
    summary: a.summary,
    description: a.description,
    checks: a.checks,
    platforms: a.platforms,
    needs: a.needs,
    available: a.available,
    ...(a.unavailableReason ? { unavailableReason: a.unavailableReason } : {}),
});

export function registerTestingAgentRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const store = testingAgentsOf(p, repo);

    /** The asker's reachable, unarchived projects tested by the AI agent, with the agents of each. */
    const projectsUsing = async (req: Parameters<typeof actorOf>[0]) => {
        const visible = visibleProjectsOf(req, actorOf(req));
        const rows = repo.listProjects().filter((r) => (!visible || visible.has(r.id as string)) && !r.archived_at);
        const out: Array<{ id: string; name: string; agents: AgentId[]; source: "chosen" | "matched" }> = [];
        for (const r of rows) {
            const a = await store.of(r);
            if (a.applies) out.push({ id: String(r.id), name: String(r.name), agents: a.agents, source: a.source });
        }
        return out;
    };
    const where = async () => ({ canRun: runsCanStartHere(p), ai: { configured: (await platformAi(p, p.llm.modelName)).configured } });

    app.get("/api/testing-agents", async (req) => {
        const projects = await projectsUsing(req);
        return {
            agents: TESTING_AGENTS.map((a) => ({ ...publicAgent(a), projects: projects.filter((x) => x.agents.includes(a.id)).map(({ id, name, source }) => ({ id, name, source })) })),
            ...(await where()),
        };
    });

    app.get("/api/testing-agents/:agentId", async (req) => {
        const a = agentById((req.params as { agentId: string }).agentId);
        if (!a) throw new HttpError(404, AGENT_NOT_FOUND);
        const projects = (await projectsUsing(req)).filter((x) => x.agents.includes(a.id)).map(({ id, name, source }) => ({ id, name, source }));
        return { agent: publicAgent(a), projects, ...(await where()) };
    });

    const view = async (id: string) => {
        const row = project(id);
        const a = await store.of(row);
        return { ...a, switches: switchesFor(a.agents), platforms: projectSetupOf(row).platforms };
    };

    app.get("/api/projects/:id/testing-agents", async (req) => view((req.params as { id: string }).id));

    app.put("/api/projects/:id/testing-agents", async (req) => {
        const { id } = req.params as { id: string };
        const row = project(id);
        const setup = projectSetupOf(row);
        if (!setup.testingModes.includes("agent")) throw new HttpError(409, AGENTS_NEED_AGENT_MODE);
        const agents = validateChoice((req.body as { agents?: unknown } | undefined)?.agents, setup.platforms);
        await store.set(id, agents, actorLabel(actorOf(req) ?? currentActor()));
        return view(id);
    });
}
