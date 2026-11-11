/**
 * Lays a project's phone choice over a job (called once by job-runner.ts, before the framework settings, so the project's time limits still apply):
 *  - "Run on: device farm": the job's Android tests run on the farm, the AI explores the app on the farm's first picked phone, and every farm session is
 *    kept with its link;
 *  - "Phone tests at once" > 1 on this computer: the local runner shares the tests out among the connected phones.
 * With the defaults nothing at all changes (no event, the same executor).
 */
import type { Config } from "../config.js";
import type { EngineContext } from "../engine/context.js";
import { localExecutor } from "../engine/frameworks/index.js";
import { withDeviceChoice } from "../engine/mobile/cloud/farm-executor.js";
import { openFarmDeviceSession } from "../engine/mobile/cloud/farm-session.js";
import { deviceLabel } from "../engine/mobile/cloud/farm-runner.js";
import { connectionProblem, PROVIDERS } from "../engine/mobile/cloud/providers.js";
import { DeviceFarmStore } from "./device-farm-store.js";
import type { JobRow, Repo } from "./repo.js";
import { SecretBox } from "./secrets.js";

/** Test seams only (never set in production): a shorter wait for elements so failing steps fail fast in the tests. */
export const farmTestHooks: { expectTimeoutMs?: number } = {};

export function farmStoreFor(repo: Repo, config: Pick<Config, "dataDir" | "SECRET_KEY">): DeviceFarmStore {
    return new DeviceFarmStore(repo.db, new SecretBox(config.dataDir, config.SECRET_KEY));
}

export function applyDeviceFarm(ctx: EngineContext, repo: Repo, config: Config, job: Pick<JobRow, "id" | "projectId">): void {
    let store: DeviceFarmStore;
    let choice: ReturnType<DeviceFarmStore["choice"]>;
    let plan: ReturnType<DeviceFarmStore["plan"]>;
    try {
        store = farmStoreFor(repo, config);
        choice = store.choice(job.projectId);
        plan = store.plan(job.projectId);
    } catch {
        return; // an unreadable table must never stop a run
    }
    if (choice.runOn === "farm" && !plan) {
        ctx.emit({ stage: "orchestration", kind: "device_farm", level: "warn", message: "The device farm chosen for this project no longer exists, so phone tests run on this computer's phone or the project's runner." });
    }
    if (plan) {
        const info = PROVIDERS[plan.connection.provider];
        const phones = plan.connection.devices.map(deviceLabel).join(", ");
        ctx.deviceFarm = { label: info.label };
        ctx.emit({
            stage: "orchestration",
            kind: "device_farm",
            message: `Phone tests run on ${info.label} (“${plan.connection.label}”): ${plan.matrix ? `every test on each of ${phones}` : phones}, ${plan.parallel} at a time.`,
            data: { provider: plan.connection.provider, devices: plan.connection.devices.length, parallel: plan.parallel, matrix: plan.matrix },
        });
        const problem = connectionProblem(plan.connection);
        if (problem) ctx.emit({ stage: "orchestration", kind: "device_farm", level: "warn", message: `The device farm can't be used yet: ${problem}` });
        // The AI explores on the farm's first picked phone, through the same safety rules as on a local phone.
        if (ctx.openDevice) {
            const farm = plan;
            ctx.openDevice = (opts) => openFarmDeviceSession(opts, farm);
        }
    }
    const inner = ctx.executor ?? localExecutor;
    const farmId = plan?.connection.id ?? null;
    const exec = withDeviceChoice(inner, {
        ...(plan ? { farm: plan } : {}),
        localParallel: choice.parallel,
        onSession: (s) => {
            try {
                store.addSession(job.projectId, job.id, farmId, s);
            } catch {
                /* keeping the link is a courtesy; the result itself is stored by the job */
            }
        },
        buildName: `AI Testing Platform job ${job.id.slice(0, 8)}`,
        ...(farmTestHooks.expectTimeoutMs ? { expectTimeoutMs: farmTestHooks.expectTimeoutMs } : {}),
    });
    if (exec !== inner) {
        ctx.executor = exec;
        if (!plan && choice.parallel > 1) ctx.emit({ stage: "orchestration", kind: "device_farm", message: `Up to ${choice.parallel} phone tests run at once when that many phones are connected.` });
    }
}
