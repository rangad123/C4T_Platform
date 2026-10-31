/**
 * Everything the platform decides before an environment run starts: may this project run against that environment, with
 * which address, credentials and variables, and which tests. Shared by the API routes (which refuse early, with a plain
 * message) and the job runner (which re-checks, because the environment may have changed since the job was queued).
 */
import type { Config } from "../config.js";
import { isAppUri } from "../engine/desktop/target.js";
import { changesData } from "../engine/environments/env.js";
import { skipReason, type EnvironmentRunRequest, type EnvironmentTarget, type EnvironmentTest } from "../engine/environments/run.js";
import type { Role } from "./identity-store.js";
import { DataSetStore, EnvironmentStore, type Environment } from "./environments-store.js";
import { HttpError } from "./http-error.js";
import { blocksFor, blockView } from "./block-store.js";
import { LocatorStore } from "./locator-store.js";
import { assertAllowedTarget } from "./net-guard.js";
import { CustomScriptStore } from "./custom-script-store.js";
import type { JobRow, Repo } from "./repo.js";
import { SecretBox } from "./secrets.js";

export function environmentStore(repo: Repo, config: Pick<Config, "dataDir" | "SECRET_KEY">): EnvironmentStore {
    return new EnvironmentStore(repo.db, new SecretBox(config.dataDir, config.SECRET_KEY));
}

export const PRODUCTION_CONFIRM_MESSAGE = (name: string) => `“${name}” is a production environment. Running there needs your explicit confirmation (confirmProduction: true).`;

/** The environment's addresses must pass the same outbound guard as any tested application. */
export async function assertEnvironmentTargets(env: Pick<Environment, "baseUrl" | "apiBaseUrl">): Promise<void> {
    await assertAllowedTarget(env.baseUrl);
    if (env.apiBaseUrl) await assertAllowedTarget(env.apiBaseUrl);
}

/** Throws the plain-language 4xx a person should see when an environment run is not allowed. */
export async function assertMayRun(env: Environment | undefined, name: string, confirmProduction: boolean | undefined): Promise<Environment> {
    if (!env) throw new HttpError(404, `This project has no environment called “${name}”.`);
    if (env.production && !confirmProduction) throw new HttpError(409, PRODUCTION_CONFIRM_MESSAGE(env.name), { requiresConfirmation: true });
    await assertEnvironmentTargets(env);
    return env;
}

/** How a selection of tests will be treated in this environment, for the API's answer before the job starts. */
export function planEnvironmentRun(tests: Array<{ id: string; testKey: string; spec: Parameters<typeof changesData>[0] }>, env: Pick<Environment, "production">, view: (spec: any) => any = (s) => s) {
    const willRun: string[] = [];
    const skipped: Array<{ id: string; testId: string; reason: string }> = [];
    for (const t of tests) {
        const why = skipReason(view(t.spec), env);
        if (why) skipped.push({ id: t.id, testId: t.testKey, reason: why });
        else willRun.push(t.id);
    }
    return { willRun, skipped };
}

/** Inputs of an environment job, resolved at the time it runs. Throws a plain Error when it must not run. */
export async function prepareEnvironmentRun(
    repo: Repo,
    config: Pick<Config, "dataDir" | "SECRET_KEY">,
    job: JobRow,
    app: { url: string; config: Record<string, any> },
    roles: Role[],
): Promise<{ request: EnvironmentRunRequest; tests: EnvironmentTest[]; missing: string[] }> {
    const name = job.options.environment;
    if (!name) throw new Error("This run names no environment.");
    const store = environmentStore(repo, config);
    const env = store.get(job.projectId, name);
    if (!env) throw new Error(`The environment “${name}” no longer exists, so nothing was run.`);
    // A production run needs the confirmation that was given when it was queued; a stored job without one never runs there.
    if (env.production && !job.options.confirmProduction) throw new Error(PRODUCTION_CONFIRM_MESSAGE(env.name));
    await assertEnvironmentTargets(env);
    const secrets = store.secretsOf(env);
    const target: EnvironmentTarget = {
        name: env.name,
        production: env.production,
        baseUrl: env.baseUrl,
        ...(env.apiBaseUrl ? { apiBaseUrl: env.apiBaseUrl } : {}),
        credentials: secrets,
        vars: env.variables,
    };
    const tests: EnvironmentTest[] = [];
    const missing: string[] = [];
    // Reusable steps are put in place first: whether a test changes data or sends load is decided on what it really does.
    const view = blockView(repo.db, job.projectId);
    for (const id of job.options.testIds ?? []) {
        const t = repo.getTest(id);
        if (!t || t.projectId !== job.projectId) {
            missing.push(id);
            continue;
        }
        const current = repo.getCurrentScript(t.id);
        // A hand-written test runs its stored script as it is.
        const hand = new CustomScriptStore(repo.db).isCustom(t.id) && current ? { custom: { filename: current.filename as string, content: current.content as string } } : {};
        tests.push({ handle: { id: t.id, testId: t.testKey }, spec: view(t.spec), scriptId: (current?.id as string | undefined) ?? null, ...hand });
    }
    // Shared elements (object repository): a test that refers to one is resolved when its script is rendered.
    const objects = new LocatorStore(repo.db).index(job.projectId);
    const blocks = blocksFor(repo.db, job.projectId);
    return {
        request: {
            target,
            roles: env.useProjectAccounts ? roles : [],
            render: { baseUrl: isAppUri(app.url) ? env.baseUrl : new URL(app.url).origin, ...(app.config.apiBaseUrl ? { apiBaseUrl: app.config.apiBaseUrl } : {}), dataSets: new DataSetStore(repo.db).asMap(job.projectId), ...(objects ? { objects } : {}), ...(blocks ? { blocks } : {}) },
        },
        tests,
        missing,
    };
}
