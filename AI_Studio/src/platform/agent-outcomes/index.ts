import type { AgentId } from "../testing-agents.js";
import { outcome as accessibility } from "./accessibility.js";
import { outcome as api } from "./api.js";
import { outcome as performance } from "./performance.js";
import { outcome as responsiveUi } from "./responsive-ui.js";
import { outcome as security } from "./security.js";
import { outcome as testGeneration } from "./test-generation.js";
import type { AgentOutcomeModule } from "./types.js";
import { outcome as ux } from "./ux.js";

/** Each agent's outcome, by id (null: not built yet). A builder edits only its agent's own file, never this one. */
export const AGENT_OUTCOMES: Record<AgentId, AgentOutcomeModule<any> | null> = {
    api,
    accessibility,
    security,
    chatbot: null,
    "responsive-ui": responsiveUi,
    ux,
    performance,
    "test-generation": testGeneration,
};
