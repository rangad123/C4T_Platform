/**
 * Tests whose framework comes from an adapter plug-in (src/engine/frameworks/plugin-loader.ts).
 *
 * The framework id of a test is stored in the database. If the plug-in that provided it is gone (removed, failed to load, switched
 * off), nothing may quietly run those tests with another framework, and nothing may be deleted: a job that would include them is
 * refused before it exists, with a sentence that says what is missing and that the tests are kept. The same checks protect the cases a
 * plug-in cannot serve: it runs on the server only, and only in a normal run.
 */
import { adapterForSpec, getAdapter, hasAdapter, isBuiltInAdapterId, listAdapters, UnknownFrameworkError } from "../engine/frameworks/index.js";
import { explainMissingFramework, getPluginStatus, type PluginStatus } from "../engine/frameworks/plugin-loader.js";
import type { TestSpec } from "../engine/spec/schema.js";
import type { Platform } from "./bootstrap.js";
import { getAgentServices } from "./agent-services.js";
import { HttpError } from "./http-error.js";
import type { JobOptions } from "./repo.js";

/** The stored framework ids of the job's tests that are not one of the built-in ones. */
export function pluginFrameworksOf(repo: Platform["repo"], options: JobOptions): string[] {
    const ids = [...(options.testIds ?? []), ...(options.rewriteTestId ? [options.rewriteTestId] : [])];
    const used = new Set<string>();
    for (const id of ids) {
        const t = repo.getTest(id);
        if (t && typeof t.framework === "string" && !isBuiltInAdapterId(t.framework)) used.add(t.framework);
    }
    return [...used];
}

/** Checked by `Repo.createJob`: a plain 409 when a job would include tests of a plug-in framework that cannot serve them now. */
export function pluginGate(p: Pick<Platform, "repo" | "db" | "config">, projectId: string, options: JobOptions): void {
    const used = pluginFrameworksOf(p.repo, options);
    if (used.length === 0) return;
    for (const id of used) if (!hasAdapter(id)) throw new HttpError(409, explainMissingFramework(id));
    const mode = options.mode ?? "generate";
    if (mode === "variants" || mode === "environment" || mode === "plain") {
        throw new HttpError(409, `This project has tests that use the plug-in framework "${used[0]}". They can be run with a normal run, but not as a browser and screen-size check, a run against an environment, or a plain-English rewrite.`);
    }
    // Plug-ins are loaded into the server only; a runner agent has no copy of them.
    if (getAgentServices(p as Platform).routesToAgent(projectId)) {
        const named = used.map((id) => (hasAdapter(id) ? `"${getAdapter(id).label}" (${id})` : `"${id}"`)).join(", ");
        throw new HttpError(409, `This project has tests that use the plug-in framework ${named}, which runs on the platform computer only: runners do not have plug-ins. This project runs its tests on runners. Run the project on the platform computer, or move these tests to another project.`);
    }
}

/**
 * Why tests of this plug-in framework must be left out of an automated run (schedule, trigger, runbook) now, in plain words; undefined when they
 * can run. The same three reasons `pluginGate` refuses a job for, but here the run goes on without those tests.
 */
export function pluginSkipReason(p: Pick<Platform, "repo" | "db" | "config">, projectId: string, framework: string, shape: "validate" | "environment"): string | undefined {
    if (!hasAdapter(framework)) return explainMissingFramework(framework);
    if (shape === "environment") return "A plug-in framework can't be used in a run against an environment.";
    if (getAgentServices(p as Platform).routesToAgent(projectId)) return "This project runs its tests on runners, and runners do not have plug-ins.";
    return undefined;
}

/** Install the gate on the platform's repository (every job, whoever creates it, passes through `Repo.createJob`). */
export function installPluginGate(p: Platform): void {
    p.repo.pluginGate = async (projectId, options) => pluginGate(p, projectId, options);
    p.repo.pluginPolicy = async (projectId, framework, shape) => pluginSkipReason(p, projectId, framework, shape);
}

/**
 * The framework a spec is stored for at import: its own kind's framework unless the import names an adapter plug-in framework (a
 * deliberate choice, `framework` in the import body). A built-in framework cannot be chosen for another kind of test, and a plug-in
 * framework must be loaded and run this kind of test: a plain 400 otherwise.
 */
export function frameworkForImport(spec: Pick<TestSpec, "kind"> & { platform?: string }, requested: string | undefined): string {
    const natural = adapterForSpec(spec).id;
    if (requested === undefined || requested === natural) return natural;
    if (isBuiltInAdapterId(requested)) throw new HttpError(400, `Tests of this kind are stored for "${natural}", so "${requested}" cannot be chosen for them. Only a framework added by an adapter plug-in can be chosen.`);
    if (!hasAdapter(requested)) throw new HttpError(400, new UnknownFrameworkError(requested, listAdapters().map((a) => a.id)).message);
    const adapter = getAdapter(requested);
    if (!adapter.kinds.includes(spec.kind)) throw new HttpError(400, `${adapter.label} does not run ${spec.kind} tests.`);
    return requested;
}

/** The plug-in block of GET /api/config: the switch as asked for and as in force, what loaded, what did not and why. No server paths. */
export function pluginStatusFor(config: Pick<Platform["config"], "ALLOW_ADAPTER_PLUGINS" | "adapterPluginsRequested" | "adapterPluginsReason">): PluginStatus {
    const s = getPluginStatus();
    const reason = config.adapterPluginsReason ?? s.reason;
    return { ...s, requested: config.adapterPluginsRequested, enabled: config.ALLOW_ADAPTER_PLUGINS === true, ...(reason ? { reason } : {}) };
}

/** For a route that is about to use a test's framework: a plain 409 (never a server error) when no adapter serves it now. */
export function assertFrameworkLoaded(framework: string): void {
    if (!hasAdapter(framework)) throw new HttpError(409, explainMissingFramework(framework));
}
