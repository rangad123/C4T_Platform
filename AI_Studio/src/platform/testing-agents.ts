/**
 * Testing agents: the named kinds of testing the AI does for a project (API, accessibility, security, responsive UI, UX, performance,
 * test case generation), each mapped onto the checks AI Studio already has. An agent is a name and a description over existing
 * switches, not a second set of them: choosing agents for a project decides which of the exploration's checks run.
 *
 *   turnsOn  the checks the agent runs whenever it is chosen
 *   allows   checks the agent makes possible but that stay a choice per run (they cost more, or send real load)
 *
 * A check whose agent is not chosen is off, and asking for it is refused with the agent to add. An agent the product cannot do yet
 * (Chatbot) is listed as not available and cannot be chosen.
 *
 * Storage (migration slot 46): one row per chosen agent. A project with no rows has never had a choice saved (older projects, and
 * projects made by the CLI or MCP): it shows the agents that match the switches of its latest exploration, and its runs keep the
 * switches exactly as before until someone saves a choice. Choosing applies only to projects tested by the AI agent.
 */
import type { JobOptions, Repo } from "./repo.js";
import type { Row } from "./db.js";
import type { Sql } from "./sql.js";
import { HttpError } from "./http-error.js";
import { projectSetupOf, type ProjectPlatform } from "./project-setup.js";

export const TESTING_AGENTS_MIGRATION = `
CREATE TABLE project_testing_agents (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,              -- an id of TESTING_AGENTS (testing-agents.ts)
    chosen_by TEXT,
    chosen_at TEXT NOT NULL,
    PRIMARY KEY (project_id, agent_id)
);
CREATE INDEX idx_project_testing_agents_agent ON project_testing_agents(agent_id);
`;

export const AGENT_IDS = ["api", "accessibility", "security", "chatbot", "responsive-ui", "ux", "performance", "test-generation"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** The switches of an exploration that agents own. `functionalTests` and `apiTests` (the "api" target) are not body switches of their own. */
export const AGENT_SWITCHES = ["functionalTests", "inputChecks", "apiTests", "contractChecks", "accessibility", "securityChecks", "accessChecks", "visual", "variants", "healthChecks", "visionChecks", "performanceChecks", "loadChecks"] as const;
export type AgentSwitch = (typeof AGENT_SWITCHES)[number];

/** What each switch is called on the page and in a refusal. */
export const SWITCH_WORDS: Record<AgentSwitch, string> = {
    functionalTests: "Functional test cases",
    inputChecks: "Form input checks",
    apiTests: "API tests",
    contractChecks: "API contract checks",
    accessibility: "Accessibility checks",
    securityChecks: "Basic security checks",
    accessChecks: "Access checks",
    visual: "Visual change checks",
    variants: "Other browsers and screen sizes",
    healthChecks: "Page health checks",
    visionChecks: "AI screen review",
    performanceChecks: "Page speed checks",
    loadChecks: "Load checks",
};

export interface TestingAgent {
    id: AgentId;
    name: string;
    /** One line for the card. */
    summary: string;
    /** What it does, in a few plain sentences. */
    description: string;
    /** What it checks, one item each. */
    checks: string[];
    platforms: ProjectPlatform[];
    /** What it needs to work. */
    needs: string[];
    available: boolean;
    /** Why it cannot be chosen, when it is not available. */
    unavailableReason?: string;
    turnsOn: AgentSwitch[];
    allows: AgentSwitch[];
}

const EXPLORE_NEEDS = "An AI model, set up in Settings, to explore the application.";

export const TESTING_AGENTS: readonly TestingAgent[] = [
    {
        id: "api",
        name: "API Testing Agent",
        summary: "Tests the API calls the application makes, and checks the answers against the API's own description.",
        description: "While the AI explores the application it notes every API call. This agent writes a test for each safe one and, when the API has an OpenAPI description, checks that every answer matches it. Calls that change data are left out unless you allow them for a run.",
        checks: ["Each safe API call answers as expected", "Answers match the OpenAPI description (contract checks)", "Calls that change data, only when you allow them for a run"],
        platforms: ["web"],
        needs: [EXPLORE_NEEDS, "The address of the API, or an application that calls it. An OpenAPI description for the contract checks."],
        available: true,
        turnsOn: ["apiTests", "contractChecks"],
        allows: [],
    },
    {
        id: "accessibility",
        name: "Accessibility Testing Agent",
        summary: "Checks key pages and phone screens for problems that stop people using assistive technology.",
        description: "Runs the axe-core accessibility rules on the key pages the AI finds: missing labels, low contrast, images without text, keyboard traps. On an Android app it checks each screen it explores for labels and touch target sizes.",
        checks: ["Labels, names and roles of controls", "Colour contrast", "Text for images", "Phone screens: content labels and touch target sizes"],
        platforms: ["web", "android"],
        needs: [EXPLORE_NEEDS, "The checks themselves are rules, not AI judgement."],
        available: true,
        turnsOn: ["accessibility"],
        allows: [],
    },
    {
        id: "security",
        name: "Security Testing Agent",
        summary: "A read-only look at security headers, cookies, exposed files and the HTTPS certificate, and that restricted pages stay closed.",
        description: "Passive checks only: it reads what the application already sends and never attacks, floods or changes anything. With test accounts, it also checks that pages and API calls meant for one account stay closed to lesser accounts and visitors. A full security assessment is a separate, authorised activity.",
        checks: ["Security headers and cookie settings", "Files that should not be public", "The HTTPS certificate and redirects", "Restricted pages stay closed to lesser accounts (needs test accounts)"],
        platforms: ["web"],
        needs: [EXPLORE_NEEDS, "Test accounts in the project's settings for the access checks."],
        available: true,
        turnsOn: ["securityChecks", "accessChecks"],
        allows: [],
    },
    {
        id: "chatbot",
        name: "Chatbot Testing Agent",
        summary: "Testing a chatbot's answers is not something AI Studio can do yet.",
        description: "This agent would hold conversations with a chatbot in the application and judge its answers. AI Studio does not have it yet, so it cannot be chosen for a project.",
        checks: [],
        platforms: [],
        needs: [],
        available: false,
        unavailableReason: "Not available yet.",
        turnsOn: [],
        allows: [],
    },
    {
        id: "responsive-ui",
        name: "Responsive UI Testing Agent",
        summary: "Keeps a picture of each key page and shows what changed, and runs tests on other browsers and screen sizes.",
        description: "Takes a baseline picture of each key page and compares later runs with it, so a layout that breaks shows up as a change to look at. For a run you can also ask for other browsers and screen sizes, such as a phone-sized screen, on the tests that pass.",
        checks: ["Visual changes against a saved picture of each key page", "Other browsers and screen sizes, when you pick them for a run"],
        platforms: ["web"],
        needs: [EXPLORE_NEEDS, "The browsers you pick, on this server or on a runner."],
        available: true,
        turnsOn: ["visual"],
        allows: ["variants"],
    },
    {
        id: "ux",
        name: "UX Testing Agent",
        summary: "Finds what spoils a visit: script errors, failed requests, broken links, and screens that do not look right.",
        description: "Checks the key pages for problems a visitor would notice: errors in the page's scripts, requests that fail, broken links. For a run you can also turn on AI screen review, where a model that can read images looks at each key page and says whether it looks right; its verdict is a judgement, shown as such.",
        checks: ["Script errors and failed requests on key pages", "Broken links", "AI screen review, when you turn it on for a run"],
        platforms: ["web"],
        needs: [EXPLORE_NEEDS, "AI screen review needs a model that can read images, and each picture is a paid AI call."],
        available: true,
        turnsOn: ["healthChecks"],
        allows: ["visionChecks"],
    },
    {
        id: "performance",
        name: "Performance Testing Agent",
        summary: "Times key pages and a few safe API calls, and can run a small load check.",
        description: "Loads key pages three times and compares the timings with budgets, and times a few safe API calls. For a run you can also ask for a basic load check: up to ten users at once on up to three safe calls, never against a production environment. On an Android app, it measures how long the app takes to start.",
        checks: ["Page load timings against budgets", "Timings of safe API calls", "A basic load check, when you turn it on for a run", "Android: the app's start time"],
        platforms: ["web", "android"],
        needs: [EXPLORE_NEEDS, "A steady test environment: timings depend on it. Load checks are refused for production environments."],
        available: true,
        turnsOn: ["performanceChecks"],
        allows: ["loadChecks"],
    },
    {
        id: "test-generation",
        name: "Test Case Generation Agent",
        summary: "Explores the application, plans the journeys worth testing, and writes a test case with steps for each.",
        description: "The AI goes through the application like a visitor, works out its main journeys, plans test cases for them (from a requirements document too, when you give one) and writes each one with plain-English steps and the code that runs them. It also tries search forms with harmless unusual input. Each test case is a draft until it is reviewed.",
        checks: ["The main journeys through the application", "Requirements from a document you give", "Search forms with unusual input", "Android: the app's screens and journeys"],
        platforms: ["web", "android"],
        needs: [EXPLORE_NEEDS, "The address of the application, or the Android app. Test accounts if the journeys need signing in."],
        available: true,
        turnsOn: ["functionalTests", "inputChecks"],
        allows: [],
    },
];

const BY_ID = new Map(TESTING_AGENTS.map((a) => [a.id, a]));
export const agentById = (id: string): TestingAgent | undefined => BY_ID.get(id as AgentId);
const ordered = (ids: Iterable<string>): AgentId[] => {
    const set = new Set(ids);
    return AGENT_IDS.filter((id) => set.has(id));
};

// ── words ──
export const CHOOSE_AN_AGENT = "Choose at least one testing agent.";
export const AGENTS_NEED_AGENT_MODE = "Testing agents are chosen for projects tested by the AI agent. Turn on the AI agent testing mode first.";
export const unknownAgent = (id: string) => `"${id.slice(0, 40)}" is not a testing agent.`;
export const agentNotAvailable = (a: TestingAgent) => `The ${a.name} is not available yet, so it cannot be chosen.`;
export const agentNotForPlatform = (a: TestingAgent, platforms: readonly string[]) => `The ${a.name} does not work on ${platforms.join(" or ")} projects.`;
export const switchNeedsAgent = (k: AgentSwitch) => {
    const owners = TESTING_AGENTS.filter((a) => a.turnsOn.includes(k) || a.allows.includes(k)).map((a) => a.name);
    return `${SWITCH_WORDS[k]} come with the ${owners.join(" or the ")}, which this project does not use. Add it in the project's Settings → General.`;
};

/**
 * Checks a choice of agents for a project of these platforms: known, available, working on at least one of its platforms, at least
 * one. Returns the ids in catalogue order without repeats.
 */
export function validateChoice(raw: unknown, platforms: readonly ProjectPlatform[]): AgentId[] {
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) throw new HttpError(400, 'Testing agents are a list of agent ids, such as ["test-generation", "accessibility"].');
    if (raw.length > AGENT_IDS.length * 2) throw new HttpError(400, "That is more testing agents than there are.");
    for (const id of raw as string[]) {
        const a = agentById(id);
        if (!a) throw new HttpError(400, unknownAgent(id));
        if (!a.available) throw new HttpError(400, agentNotAvailable(a));
        if (!a.platforms.some((p) => platforms.includes(p))) throw new HttpError(400, agentNotForPlatform(a, platforms));
    }
    const ids = ordered(raw as string[]);
    if (ids.length === 0) throw new HttpError(400, CHOOSE_AN_AGENT);
    return ids;
}

/** The agents a project's earlier exploration settings match (a project with no choice saved). `config` is its latest application's. */
export function agentsMatching(config: Partial<JobOptions> | undefined, platforms: readonly ProjectPlatform[]): AgentId[] {
    const o = config ?? {};
    const targets = o.targets?.length ? o.targets : ["web", "api"];
    const on: Record<AgentId, boolean> = {
        "test-generation": true,
        api: targets.includes("api"),
        accessibility: o.accessibility !== false,
        security: o.securityChecks !== false,
        chatbot: false,
        "responsive-ui": o.visual === true || Boolean(o.variants?.length),
        ux: o.healthChecks !== false || o.visionChecks === true,
        performance: o.performanceChecks === true || o.loadChecks === true,
    };
    const fits = AGENT_IDS.filter((id) => on[id] && agentById(id)!.platforms.some((p) => platforms.includes(p)));
    return fits.length ? fits : ["test-generation"];
}

export interface ProjectAgents {
    /** Whether the project is tested by the AI agent (agents apply only then). */
    applies: boolean;
    agents: AgentId[];
    /** "chosen": saved by a person; "matched": from the switches of its latest exploration (or the defaults), until one is saved. */
    source: "chosen" | "matched";
    chosenBy: string | null;
    chosenAt: string | null;
}

export class TestingAgentStore {
    constructor(
        private readonly sql: Sql,
        private readonly repo: Repo,
    ) {}

    private async stored(projectId: string): Promise<Row[]> {
        return this.sql.all("SELECT agent_id, chosen_by, chosen_at FROM project_testing_agents WHERE project_id = ?", projectId);
    }

    /** The agents of a project row: the saved choice, or those its latest exploration settings match. */
    async of(row: Row): Promise<ProjectAgents> {
        const setup = projectSetupOf(row);
        const applies = setup.testingModes.includes("agent");
        const rows = await this.stored(String(row.id));
        if (rows.length) return { applies, agents: ordered(rows.map((r) => String(r.agent_id))), source: "chosen", chosenBy: (rows[0]!.chosen_by as string | null) ?? null, chosenAt: String(rows[0]!.chosen_at) };
        const config = this.repo.getLatestApplicationPublic(String(row.id))?.config as Partial<JobOptions> | undefined;
        return { applies, agents: agentsMatching(config, setup.platforms), source: "matched", chosenBy: null, chosenAt: null };
    }

    /** The saved choice only (undefined: none saved). */
    async chosen(projectId: string): Promise<AgentId[] | undefined> {
        const rows = await this.stored(projectId);
        return rows.length ? ordered(rows.map((r) => String(r.agent_id))) : undefined;
    }

    /** Replaces the project's choice (already validated). */
    async set(projectId: string, agents: readonly AgentId[], by: string | null): Promise<void> {
        const at = new Date().toISOString();
        await this.sql.tx(async (t) => {
            await t.run("DELETE FROM project_testing_agents WHERE project_id = ?", projectId);
            for (const a of agents) await t.run("INSERT INTO project_testing_agents (project_id, agent_id, chosen_by, chosen_at) VALUES (?, ?, ?, ?)", projectId, a, by, at);
        });
    }
}

/** The state of every agent switch for a choice: on (runs), allowed (a choice per run, off unless asked) or off (no chosen agent owns it). */
export function switchesFor(agents: readonly AgentId[]): Record<AgentSwitch, "on" | "allowed" | "off"> {
    const chosen = agents.map((id) => agentById(id)!).filter(Boolean);
    return Object.fromEntries(AGENT_SWITCHES.map((k) => [k, chosen.some((a) => a.turnsOn.includes(k)) ? "on" : chosen.some((a) => a.allows.includes(k)) ? "allowed" : "off"])) as Record<AgentSwitch, "on" | "allowed" | "off">;
}

/** What an exploration request asked for, per agent switch (undefined: left to the agents). */
export interface AskedSwitches {
    targets?: Array<"web" | "api" | "mobile">;
    variants?: string[];
    [k: string]: unknown;
}

/**
 * The exploration options a saved choice of agents gives: each switch a chosen agent turns on is on unless the request turned it off;
 * an allowed switch is what the request said (off when it said nothing); a switch no chosen agent owns is off, and asking for it is
 * refused (409) naming the agent to add. The phone target is left as asked: an Android exploration's own checks are not switches.
 */
export function applyAgentChoice(options: JobOptions, asked: AskedSwitches, agents: readonly AgentId[]): JobOptions {
    const state = switchesFor(agents);
    const out: JobOptions = { ...options };
    const bag = out as unknown as Record<string, unknown>;
    const askedApi = asked.targets ? asked.targets.includes("api") : undefined;
    const askedOf = (k: AgentSwitch): boolean | undefined => (k === "apiTests" ? askedApi : k === "variants" ? (asked.variants?.length ? true : undefined) : k === "functionalTests" ? undefined : (asked[k] as boolean | undefined));
    for (const k of AGENT_SWITCHES) {
        const want = askedOf(k);
        if (state[k] === "off" && want === true) throw new HttpError(409, switchNeedsAgent(k));
        const value = state[k] === "on" ? want !== false : state[k] === "allowed" ? want === true : false;
        if (k === "apiTests") {
            const base = asked.targets ?? ["web", "api"];
            const targets = base.filter((t) => t !== "api" || value);
            out.targets = targets.length ? targets : ["web"];
        } else if (k === "variants") {
            if (!value) delete out.variants;
        } else if (k === "loadChecks" || k === "visionChecks" || k === "visual" || k === "performanceChecks") {
            // Off-by-default switches are stored only when on, as before.
            if (value) bag[k] = true;
            else delete bag[k];
        } else {
            bag[k] = value;
        }
    }
    return out;
}

/**
 * A request carried over from earlier (a plan's settings, the last exploration's settings for a schedule), narrowed to the current
 * choice: a check no chosen agent owns any more is left out and named, never refused. `followChoice`: the checks a chosen agent
 * turns on are on whatever the earlier settings said (nobody is asking now); allowed ones, the targets and the variants keep them.
 */
export function narrowToChoice(asked: AskedSwitches, agents: readonly AgentId[], opts: { followChoice?: boolean } = {}): { asked: AskedSwitches; dropped: AgentSwitch[] } {
    const state = switchesFor(agents);
    const out: AskedSwitches = { ...asked, ...(asked.targets ? { targets: [...asked.targets] } : {}) };
    const dropped: AgentSwitch[] = [];
    for (const k of AGENT_SWITCHES) {
        if (k === "functionalTests") continue;
        const on = k === "apiTests" ? Boolean(out.targets?.includes("api")) : k === "variants" ? Boolean(out.variants?.length) : out[k] === true;
        if (state[k] === "off" && on) {
            dropped.push(k);
            if (k === "apiTests") out.targets = out.targets!.filter((t) => t !== "api");
            else if (k === "variants") delete out.variants;
            else delete out[k];
        } else if (opts.followChoice && state[k] === "on" && k !== "apiTests" && k !== "variants") {
            // What is explored (the targets) and the variants stay as the earlier settings said.
            delete out[k];
        }
    }
    if (state.functionalTests === "off" && asked.functionalTests !== false) dropped.unshift("functionalTests");
    return { asked: out, dropped };
}

/** The job event that names what was left out because its agent is no longer chosen. */
export const droppedChecksNote = (dropped: readonly AgentSwitch[]): string =>
    `Left out because this project's testing agents do not include the agent that runs them: ${dropped.map((k) => SWITCH_WORDS[k]).join(", ")}. Add the agent again in the project's Settings → General to bring them back.`;

/** An exploration's options under the project's current choice, narrowed (see narrowToChoice); unchanged when none is saved or the project is not in agent mode. */
export async function narrowedByChoice(store: TestingAgentStore, row: Row, options: JobOptions, asked: AskedSwitches, opts: { followChoice?: boolean } = {}): Promise<{ options: JobOptions; dropped: AgentSwitch[] }> {
    if (!projectSetupOf(row).testingModes.includes("agent")) return { options, dropped: [] };
    const chosen = await store.chosen(String(row.id));
    if (!chosen) return { options, dropped: [] };
    const n = narrowToChoice(asked, chosen, opts);
    return { options: applyAgentChoice(options, n.asked, chosen), dropped: n.dropped };
}
