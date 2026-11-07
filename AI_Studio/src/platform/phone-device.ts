/**
 * Where the AI's phone comes from for a job: this computer's adb, or a runner agent, as the project's runner choice says (platform/agent-device.ts does the
 * work; this only hands the explorer the one function it calls). Tests hand in their own opener instead.
 */
import type { DeviceOpener } from "../engine/mobile/explore/types.js";
import { agentServiceOf } from "./agent-services.js";
import { openDeviceSession } from "./agent-device.js";
import { chosenRunnerOf, jobOwnerId } from "./agent-services.js";
import type { JobRow } from "./repo.js";

export function deviceOpenerFor(job: Pick<JobRow, "id" | "projectId"> & Partial<Pick<JobRow, "options">>, override?: DeviceOpener): DeviceOpener {
    if (override) return override;
    // Whose exploration it is and the runner chosen for it: a person's own computer hosts only its owner's phone sessions.
    const startedBy = job.options ? jobOwnerId(job.options) : undefined;
    const runnerId = job.options ? chosenRunnerOf(job.options) : null;
    return (opts) => openDeviceSession(opts, { projectId: job.projectId, jobId: job.id, ...(startedBy !== undefined ? { startedBy } : {}), ...(runnerId ? { runnerId } : {}), ...(agentServiceOf(job.projectId) ? { agents: agentServiceOf(job.projectId)! } : {}) });
}
