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
import type { Credentials, JobRow, Repo } from "./repo.js";
import { SecretBox } from "./secrets.js";
import { envSecrets } from "./agent-routing.js";
import { WHERE_TO_ENTER_SIGN_IN } from "../engine/spec/sign-in-needed.js";

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

/** The site of an address: its host without the first labels, so staging.shop.example and shop.example share "shop.example". */
function siteOf(raw: string): string | null {
    let host: string;
    try {
        host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    } catch {
        return null;
    }
    if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return host || null;
    const labels = host.split(".");
    // Two labels (example.com), or three when the second-to-last is a short country suffix part (example.co.uk, example.com.au).
    const keep = labels.length >= 3 && labels[labels.length - 2]!.length <= 3 && labels[labels.length - 1]!.length === 2 ? 3 : 2;
    return labels.slice(-keep).join(".");
}

/**
 * The project's accounts go only to an environment on the project's own site (the same host, or another host under the same
 * site, like staging.shop.example for shop.example). An environment somewhere else would receive the project's passwords just
 * because someone could edit its address, so it runs without them and gets its own accounts instead.
 */
export function projectAccountsReach(appUrl: string, env: Pick<Environment, "baseUrl" | "apiBaseUrl">): boolean {
    const site = isAppUri(appUrl) ? null : siteOf(appUrl);
    if (!site) return false;
    return [env.baseUrl, env.apiBaseUrl].filter((u): u is string => !!u).every((u) => siteOf(u) === site);
}

const originOf = (u: string | undefined): string | undefined => {
    try {
        return u ? new URL(u).origin : undefined;
    } catch {
        return undefined;
    }
};

/**
 * May the project's own sign-in go to this environment? Only when its address is exactly the project application's origin (scheme, host
 * and port) and its API address, if it has one, is that origin or the project's own API address.
 */
export function signInReaches(app: { url: string; config?: Record<string, any> }, env: Pick<Environment, "baseUrl" | "apiBaseUrl">): boolean {
    const own = originOf(app.url);
    if (!own || own === "null" || originOf(env.baseUrl) !== own) return false;
    if (!env.apiBaseUrl) return true;
    const api = originOf(env.apiBaseUrl);
    return api === own || (api !== undefined && api === originOf(typeof app.config?.apiBaseUrl === "string" ? app.config.apiBaseUrl : undefined));
}

/** Inputs of an environment job, resolved at the time it runs. Throws a plain Error when it must not run. */
export async function prepareEnvironmentRun(
    repo: Repo,
    config: Pick<Config, "dataDir" | "SECRET_KEY">,
    job: JobRow,
    app: { url: string; config: Record<string, any>; credentials?: Credentials },
    roles: Role[],
): Promise<{ request: EnvironmentRunRequest; tests: EnvironmentTest[]; missing: string[]; notes: string[]; secrets: string[] }> {
    const name = job.options.environment;
    if (!name) throw new Error("This run names no environment.");
    const store = environmentStore(repo, config);
    const env = store.get(job.projectId, name);
    if (!env) throw new Error(`The environment “${name}” no longer exists, so nothing was run.`);
    // A production run needs the confirmation that was given when it was queued; a stored job without one never runs there.
    if (env.production && !job.options.confirmProduction) throw new Error(PRODUCTION_CONFIRM_MESSAGE(env.name));
    await assertEnvironmentTargets(env);
    const own = store.secretsOf(env);
    // The environment's own sign-in when it has one. Otherwise the project's sign-in (routes/project-sign-in.ts), only with "Use the
    // project's accounts" on, never on production (it needs its own), and only on exactly the project application's origin (scheme,
    // host and port; an API address too must be that origin or the project's own API address): a shared host such as *.vercel.app or
    // another port is someone else's site. The named test accounts keep the wider same-site rule below (projectAccountsReach).
    const p = app.credentials;
    const reachable = !env.production && signInReaches(app, env);
    const borrow = !own.username && !own.password && env.useProjectAccounts && reachable && p?.username && p.password;
    const secrets = borrow ? { ...own, username: p.username, password: p.password, ...(p.totpSecret ? { totpSecret: p.totpSecret } : {}) } : own;
    const signInWhere = !reachable
        ? `the settings of the environment “${env.name}” (Environments): the project's sign-in is not sent to ${env.production ? "a production environment" : "an address other than the project's own"}`
        : `the environment “${env.name}” (Environments), or in ${WHERE_TO_ENTER_SIGN_IN}${env.useProjectAccounts ? "" : " with “Use the project's accounts” on"}`;
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
    // The named test accounts: the same site is enough for them (projectAccountsReach), as before.
    const accounts = env.useProjectAccounts && projectAccountsReach(app.url, env);
    const notes =
        env.useProjectAccounts && !accounts && roles.length
            ? [`The project's accounts were not sent to “${env.name}”: it is not on the project's own site. Add the accounts this environment needs to the environment itself.`]
            : [];
    return {
        notes,
        // The environment's own secrets (and their Basic-auth and header-value forms), for the job to mask in what it writes.
        secrets: envSecrets({ credentials: { username: secrets.username ?? "", password: secrets.password ?? "", totpSecret: secrets.totpSecret }, apiToken: secrets.apiToken, apiAuthHeader: secrets.apiAuthHeader }),
        request: {
            target,
            roles: accounts ? roles : [],
            signInWhere,
            render: { baseUrl: isAppUri(app.url) ? env.baseUrl : new URL(app.url).origin, ...(app.config.apiBaseUrl ? { apiBaseUrl: app.config.apiBaseUrl } : {}), dataSets: new DataSetStore(repo.db).asMap(job.projectId), ...(objects ? { objects } : {}), ...(blocks ? { blocks } : {}) },
        },
        tests,
        missing,
    };
}
