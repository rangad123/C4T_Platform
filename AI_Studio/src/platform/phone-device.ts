/**
 * Where the AI's phone comes from for a job: this computer's adb, or a runner agent, as the project's runner choice says (platform/agent-device.ts does the
 * work; this only hands the explorer the one function it calls). Tests hand in their own opener instead.
 */
import type { DeviceOpener } from "../engine/mobile/explore/types.js";
import { agentServiceOf } from "./agent-services.js";
import { openDeviceSession } from "./agent-device.js";
import type { JobRow } from "./repo.js";

export function deviceOpenerFor(job: Pick<JobRow, "id" | "projectId">, override?: DeviceOpener): DeviceOpener {
    if (override) return override;
    return (opts) => openDeviceSession(opts, { projectId: job.projectId, jobId: job.id, ...(agentServiceOf(job.projectId) ? { agents: agentServiceOf(job.projectId)! } : {}) });
}
