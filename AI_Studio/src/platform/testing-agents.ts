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
import { z } from "zod";
import { SIZE_VARIANT_IDS } from "../engine/validation/variants.js";
import { effectiveLimits, LEVELS, type ExploreLevel } from "../engine/levels.js";

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

/**
 * Each agent's own saved defaults in a project (migration slot 75): its Settings tab. Kept apart from project_testing_agents, whose rows
 * are replaced whenever the choice is saved, so an agent taken off and added back keeps its settings.
 */
export const AGENT_SETTINGS_MIGRATION = `
CREATE TABLE project_agent_settings (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,              -- an id of TESTING_AGENTS
    settings_json TEXT NOT NULL,         -- AgentSettings: only the keys agentSettingKeys gives that agent
    updated_by TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, agent_id)
);
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
        description: "Checks the key pages for problems a visitor would notice: errors in the page's scripts, requests that fail, broken links. With AI screen review, a model that can read images looks at each key page and says whether it looks right; its verdict is a judgement, shown as such. It is on at Deep and Everything when your model can read images (screenshots go to your AI provider), and you can turn it on or off for any run.",
        checks: ["Script errors and failed requests on key pages", "Broken links", "AI screen review: on at Deep and Everything when your model can read images, or when you turn it on"],
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
        // Founder 2026-11-19: one job, one outcome. It writes test cases (plain English, no code) and stops; nothing is run here.
        summary: "Explores the application or reads your requirements, builds a tree of its pages and writes test cases for them.",
        description: "The AI goes through the application like a visitor, or reads a requirements document you give, and builds a tree of the application's pages. It then writes test cases in plain English for the main journeys through them. The outcome is that tree and its test cases: you can download them and import them into a code project to make test scripts there. Each new exploration adds to the same tree.",
        checks: ["The application's pages, as a tree", "Test cases for the main journeys through the application", "Requirements from a document you give", "Android: the app's screens and journeys"],
        platforms: ["web", "android"],
        needs: [EXPLORE_NEEDS, "The address of the application, or the Android app. Test accounts if the journeys need signing in."],
        available: true,
        turnsOn: ["functionalTests"],
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
const ownersOf = (k: AgentSwitch) => TESTING_AGENTS.filter((a) => a.turnsOn.includes(k) || a.allows.includes(k)).map((a) => a.name);
/** Form input checks have had no agent since 2026-11-19 (the Test Case Generation Agent writes test cases only). */
const NO_OWNER = (k: AgentSwitch) => `${SWITCH_WORDS[k]} are not part of any testing agent, so they cannot be turned on.`;
export const switchNeedsAgent = (k: AgentSwitch) => {
    const owners = ownersOf(k);
    if (!owners.length) return NO_OWNER(k);
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

/** One agent's saved defaults: used by every run of that agent (its Run form, schedules, runbook steps, CLI) unless the run says otherwise. */
export interface AgentSettings {
    /** How much it explores; none: the project's saved level. */
    level?: ExploreLevel;
    /** The AI model its runs use; none: the project's model. */
    model?: { provider: string; model: string };
    /** Responsive UI: the sizes it checks beside desktop. */
    variants?: string[];
    /** UX: the AI screen review on or off; none: the level decides. */
    visionChecks?: boolean;
}
export type AgentSettingKey = keyof AgentSettings;

const AgentSettingsSchema = z
    .object({
        level: z.enum(LEVELS).optional(),
        model: z.object({ provider: z.string().min(1, "Choose an AI model.").max(64), model: z.string().min(1, "Choose an AI model.").max(200) }).strict().optional(),
        variants: z.array(z.enum(SIZE_VARIANT_IDS)).max(SIZE_VARIANT_IDS.length).optional(),
        visionChecks: z.boolean().optional(),
    })
    .strict();

/**
 * The saved defaults an agent has: only the options its run uses. Every agent explores (level) with the AI (model); an `allows` switch is
 * a default only where it costs nothing extra to repeat (sizes, screen review). The load check stays a choice per run: it sends real load.
 */
export function agentSettingKeys(id: AgentId): AgentSettingKey[] {
    const a = agentById(id);
    if (!a?.available) return [];
    return ["level", "model", ...(a.allows.includes("variants") ? (["variants"] as const) : []), ...(a.allows.includes("visionChecks") ? (["visionChecks"] as const) : [])];
}
export const noSuchAgentSetting = (a: TestingAgent, key: string) => `The ${a.name} has no setting "${key.slice(0, 40)}".`;

/** A PUT body checked for this agent (400 in words for anything else). */
export function parseAgentSettings(id: AgentId, raw: unknown): AgentSettings {
    const r = AgentSettingsSchema.safeParse(raw ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? "Invalid request");
    const extra = Object.keys(r.data).find((k) => !agentSettingKeys(id).includes(k as AgentSettingKey));
    if (extra) throw new HttpError(400, noSuchAgentSetting(agentById(id)!, extra));
    return r.data;
}

/**
 * A run of this agent with its saved defaults filled in where the request said nothing: the level (with its limits, so the earlier
 * application's numbers do not hold it back), the sizes, the screen review and the model.
 */
export function withAgentSettings(d: AgentSettings, options: JobOptions, asked: AskedSwitches): { options: JobOptions; asked: AskedSwitches } {
    return {
        options: { ...options, ...(d.level ? { level: d.level, ...effectiveLimits({ level: d.level }) } : {}), ...(d.model ? { aiModel: d.model } : {}) },
        asked: { ...(d.variants ? { variants: d.variants } : {}), ...(d.visionChecks !== undefined ? { visionChecks: d.visionChecks } : {}), ...asked },
    };
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

    /** One agent's saved defaults ({} when none); a key the agent no longer has is left out. */
    async settingsOf(projectId: string, agentId: AgentId): Promise<AgentSettings> {
        const r = await this.sql.get<{ settings_json: string }>("SELECT settings_json FROM project_agent_settings WHERE project_id = ? AND agent_id = ?", projectId, agentId);
        if (!r) return {};
        let parsed: unknown;
        try {
            parsed = JSON.parse(r.settings_json);
        } catch {
            return {};
        }
        const ok = AgentSettingsSchema.safeParse(parsed);
        if (!ok.success) return {};
        const keys = agentSettingKeys(agentId);
        return Object.fromEntries(Object.entries(ok.data).filter(([k]) => keys.includes(k as AgentSettingKey))) as AgentSettings;
    }

    /** Replaces one agent's saved defaults (already checked by parseAgentSettings). */
    async setSettings(projectId: string, agentId: AgentId, settings: AgentSettings, by: string | null): Promise<void> {
        await this.sql.run(
            `INSERT INTO project_agent_settings (project_id, agent_id, settings_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (project_id, agent_id) DO UPDATE SET settings_json = excluded.settings_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
            projectId,
            agentId,
            JSON.stringify(settings),
            by,
            new Date().toISOString(),
        );
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
        } else if (k === "visionChecks") {
            // On, or off by the person's word (or no chosen agent owns it): stored. Nothing said: left out, so the level decides
            // (on at deep and everything when the model can read images, engine/levels visionOn).
            if (value) bag[k] = true;
            else if (state[k] === "off" || want === false) bag[k] = false;
            else delete bag[k];
        } else if (k === "loadChecks" || k === "visual" || k === "performanceChecks") {
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
export const droppedChecksNote = (dropped: readonly AgentSwitch[]): string => {
    const owned = dropped.filter((k) => ownersOf(k).length);
    const ownerless = dropped.filter((k) => !ownersOf(k).length);
    const words = (ks: AgentSwitch[]) => ks.map((k) => SWITCH_WORDS[k]).join(", ");
    return [
        owned.length ? `Left out because this project's testing agents do not include the agent that runs them: ${words(owned)}. Add the agent again in the project's Settings → General to bring them back.` : "",
        ownerless.length ? `Left out because no testing agent runs them: ${words(ownerless)}.` : "",
    ].filter(Boolean).join(" ");
};

/** An exploration's options under the project's current choice, narrowed (see narrowToChoice); unchanged when none is saved or the project is not in agent mode. */
export async function narrowedByChoice(store: TestingAgentStore, row: Row, options: JobOptions, asked: AskedSwitches, opts: { followChoice?: boolean } = {}): Promise<{ options: JobOptions; dropped: AgentSwitch[] }> {
    if (!projectSetupOf(row).testingModes.includes("agent")) return { options, dropped: [] };
    const chosen = await store.chosen(String(row.id));
    if (!chosen) return { options, dropped: [] };
    const n = narrowToChoice(asked, chosen, opts);
    return { options: applyAgentChoice(options, n.asked, chosen), dropped: n.dropped };
}

// ── one run = one agent (Agent Workspace, owner decision D1) ──
export const AGENT_RUNS_NEED_WORKSPACE = "A run belongs to one testing agent only in a project tested by the AI agent alone, with its agents chosen in Settings → General.";
export const agentNotChosen = (a: TestingAgent) => `The ${a.name} is not one of this project's testing agents. Add it in the project's Settings → General first.`;
const either = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", the ")} or the ${names.at(-1)}` : names[0]!);
export const chooseAgentToRun = (agents: readonly AgentId[]) => `Choose which testing agent runs: the ${either(agents.map((id) => agentById(id)!.name))}.`;

/**
 * Whose run this is (D1), for a project with the Agent Workspace: tested by the AI agent alone, with a saved choice. Undefined for every
 * other project (code, mixed, or agent with no choice saved), which runs as before; naming an agent there is refused (400). In a Workspace
 * project the agent must be one of the chosen ones (409). Left out, the run is the only chosen agent's, or Test Case Generation's when it
 * is chosen (owner decision Q6: older callers of such a project, the CLI, MCP and old links, keep getting a test case run); else 400.
 */
export async function runAgentOf(store: TestingAgentStore, row: Row, asked: string | undefined): Promise<AgentId | undefined> {
    const modes = projectSetupOf(row).testingModes;
    const chosen = modes.includes("agent") && !modes.includes("code") ? await store.chosen(String(row.id)) : undefined;
    if (!chosen) {
        if (asked !== undefined) throw new HttpError(400, AGENT_RUNS_NEED_WORKSPACE);
        return undefined;
    }
    if (asked === undefined) {
        if (chosen.length === 1) return chosen[0];
        if (chosen.includes("test-generation")) return "test-generation";
        throw new HttpError(400, chooseAgentToRun(chosen));
    }
    const a = agentById(asked);
    if (!a) throw new HttpError(400, unknownAgent(asked));
    if (!chosen.includes(a.id)) throw new HttpError(409, agentNotChosen(a));
    return a.id;
}

/** A Test Case Generation run: plan-only, with anything that would create from a plan or run test cases left out (case-agent.ts). */
export function caseRunOptions(options: JobOptions): JobOptions {
    const { runTestCases: _r, fromPlan: _f, carryFrom: _c, excludeIdeas: _e, ...rest } = options;
    return { ...rest, mode: "generate", planOnly: true };
}

/**
 * The options of one agent's run (D1; generalises caseAgentOptions): that agent's switches only, as applyAgentChoice gives them for a
 * choice of that one agent, and the run says whose it is. Test Case Generation stays plan-only. A check agent's run has no plan step
 * (the Workspace shows no plan): it makes and runs its checks. Everything else (the level, the limits, site memory, so the shared tree
 * is reused and grows) is as asked.
 */
export function agentRunOptions(agentId: AgentId, options: JobOptions, asked: AskedSwitches): JobOptions {
    const narrowed: JobOptions = { ...applyAgentChoice(options, asked, [agentId]), agentId };
    if (agentId === "test-generation") return caseRunOptions(narrowed);
    const { planOnly: _p, ...rest } = narrowed;
    // The Performance agent times safe API calls and runs the load check on the API target, without the API tests (the API agent's):
    // it keeps the target, unless the run asked for the web alone.
    if (agentId === "performance" && (asked.targets ?? ["web", "api"]).includes("api") && !rest.targets.includes("api")) return { ...rest, targets: [...rest.targets, "api"], apiTests: false };
    // The Responsive UI agent checks the phone and tablet sizes beside desktop unless the run names its sizes (none: desktop only).
    if (agentId === "responsive-ui" && asked.variants === undefined) return { ...rest, variants: [...SIZE_VARIANT_IDS] };
    return rest;
}

/**
 * A schedule's or a runbook step's exploration (D1): in a project with the Workspace, the run of the agent it keeps (none kept: as
 * runAgentOf picks), with that agent's own switches as its Run button starts them; `asked` is what the schedule or step itself says.
 * Undefined in every other project, which runs as before. An agent no longer chosen (409) or none for several agents (400) is refused.
 */
export async function savedAgentRun(store: TestingAgentStore, row: Row, agentId: string | null | undefined, options: JobOptions, asked: AskedSwitches = {}): Promise<JobOptions | undefined> {
    const modes = projectSetupOf(row).testingModes;
    if (!modes.includes("agent") || modes.includes("code") || !(await store.chosen(String(row.id)))) return undefined;
    const id = (await runAgentOf(store, row, agentId ?? undefined))!;
    // The agent's own saved defaults (its Settings tab) fill what the schedule or step leaves out.
    const d = withAgentSettings(await store.settingsOf(String(row.id), id), options, asked);
    return agentRunOptions(id, d.options, d.asked);
}
