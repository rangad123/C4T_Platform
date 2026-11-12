import { z } from "zod";
import { getAdapter } from "../../engine/frameworks/index.js";
import { desktopUnavailableReason, lastProbe, probeDesktop } from "../../engine/desktop/probe.js";
import { mobileAvailability } from "../../engine/mobile/toolchain.js";
import {
    clampSettings,
    DEFAULT_FRAMEWORK_SETTINGS,
    effectiveSettings,
    FRAMEWORK_IDS,
    FrameworkSettingsInput,
    inputProblem,
    LIMITS,
    mergeSettings,
    type FrameworkId,
    type FrameworkSettings,
} from "../../engine/frameworks/settings.js";
import { capabilityProblem } from "../agent-routing.js";
import { getAgentServices } from "../agent-services.js";
import { ownerIdOfActor } from "../agent-store.js";
import { currentActor } from "../auth/actor.js";
import { FrameworkSettingsStore } from "../framework-settings-store.js";
import { HttpError } from "../http-error.js";
import type { RouteCtx } from "./types.js";

/**
 * Framework settings routes: how each testing framework runs for a project (see docs/features/framework-settings.md).
 *
 *   GET /api/projects/:id/framework-settings   { settings, effective, adapters, runner, defaults, limits, changes }
 *   PUT /api/projects/:id/framework-settings   { settings: partial settings, by? }: validated, clamped, 409 while a job runs
 *
 * `settings` is what the project stored. `effective` is what a run would use after clamping and after the constraints of where it
 * runs (headed windows only on a runner agent, workers never above the platform's). `adapters` says, per framework, whether this
 * server and the project's runner agents can run it.
 */
export function registerFrameworkRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;
    const store = () => new FrameworkSettingsStore(repo.db);
    const agents = () => getAgentServices(ctx.p);

    /** Emulator names the project could use: its agents' (when it runs on agents) or this server's. */
    const knownAvds = (projectId: string): { names: string[]; where: "agent" | "server" } => {
        const svc = agents();
        if (svc.routesToAgent(projectId)) {
            const names = new Set<string>();
            // The asker's own runner (round 45: the only one their runs go to).
            const owner = ownerIdOfActor(currentActor());
            const own = owner ? svc.store.runnerOf(owner)?.agent : undefined;
            for (const n of own?.capabilities.android?.avds ?? []) names.add(n);
            return { names: [...names], where: "agent" };
        }
        return { names: mobileAvailability().avds, where: "server" };
    };

    const adaptersFor = (projectId: string) => {
        const svc = agents();
        const onAgent = svc.routesToAgent(projectId);
        // The asker's own runner when it is online (round 45: the only one their runs go to).
        const own = svc.ownRunner(ownerIdOfActor(currentActor()), projectId);
        const online = own?.online ? own.agent : undefined;
        const settings = store().get(projectId);
        if (process.platform === "win32" && !lastProbe()) void probeDesktop();
        const mobile = mobileAvailability();
        const windowsWhy = desktopUnavailableReason(process.platform, lastProbe());
        return FRAMEWORK_IDS.map((id) => {
            const a = getAdapter(id);
            const platformWhy = id === "taqwright" ? (mobile.available ? undefined : mobile.reason) : id === "windows-uia" ? windowsWhy : undefined;
            const agentWhy = online ? capabilityProblem(a, online.capabilities) : undefined;
            const agentOk: boolean | null = online ? !agentWhy : null;
            const reason = onAgent ? (agentWhy ? `Your runner can't run these tests: ${agentWhy}.` : !online ? "Your runner is not connected." : undefined) : platformWhy;
            return {
                id,
                label: a.label,
                kinds: [...a.kinds],
                enabled: settings.enabled[id],
                available: { platform: !platformWhy, agent: agentOk, ...(reason ? { reason } : {}) },
            };
        });
    };

    const answer = (projectId: string, extra: Record<string, unknown> = {}) => {
        const svc = agents();
        const runner = svc.runnerStatus(projectId);
        const settings = store().get(projectId);
        const chosen = runner.agentId ? svc.store.getAgent(runner.agentId) : undefined;
        const own = svc.ownRunner(ownerIdOfActor(currentActor()), projectId);
        const onlineName = own?.online ? own.agent?.name : undefined;
        return {
            settings,
            effective: effectiveSettings(settings, { onAgent: runner.runOn === "agent", platformWorkers: ctx.p.config.CONCURRENCY }),
            adapters: adaptersFor(projectId),
            runner: { runOn: runner.runOn, ...(chosen ? { agentName: chosen.name } : onlineName ? { agentName: onlineName } : {}) },
            defaults: DEFAULT_FRAMEWORK_SETTINGS,
            limits: { ...LIMITS, platformWorkers: ctx.p.config.CONCURRENCY },
            avds: knownAvds(projectId).names,
            changes: store().changes(projectId, 10),
            ...extra,
        };
    };

    app.get("/api/projects/:id/framework-settings", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return answer(id);
    });

    app.put("/api/projects/:id/framework-settings", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = z.object({ settings: z.unknown().optional(), by: z.string().trim().max(60).optional() }).strict().safeParse(req.body ?? {});
        if (!body.success) throw new HttpError(400, "Send {\"settings\": {...}} with the values to change.");
        const patch = FrameworkSettingsInput.safeParse(body.data.settings ?? {});
        if (!patch.success) throw new HttpError(400, inputProblem(patch.error));
        // A running job reads the settings as it goes; change them between runs.
        await ctx.assertNoActiveJob(id);

        const svc = agents();
        const onAgent = svc.routesToAgent(id);
        if (patch.data.web?.headless === false && !onAgent) {
            throw new HttpError(400, "A visible browser window only opens when this project's tests run on a runner, where a person can watch them. On this server the browser always runs without a window. Run the project's tests on runners first.");
        }
        const current = store().get(id);
        const avd = patch.data.android?.defaultAvd?.trim();
        if (avd && avd !== current.android.defaultAvd) {
            const known = knownAvds(id);
            if (!known.names.includes(avd)) {
                throw new HttpError(
                    400,
                    known.names.length
                        ? `The emulator “${avd}” is not one of the known emulators (${known.names.join(", ")}).`
                        : `No Android emulators are known yet${known.where === "agent" ? " on this project's runner agents" : " on this server"}, so “${avd}” cannot be chosen.`,
                );
            }
        }
        const { settings, adjusted } = clampSettings(mergeSettings(current, patch.data));
        store().save(id, settings, body.data.by);
        return answer(id, { adjusted });
    });
}

export type { FrameworkId, FrameworkSettings };
