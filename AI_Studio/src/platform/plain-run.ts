/**
 * What the platform decides before and around a plain-English job: which address and sign-in the test is built with (the
 * application's own, or a named environment's), which existing test is being rebuilt, and the checks the API route and the job
 * runner share. The engine part is src/engine/authoring/plain.ts.
 */
import type { Config } from "../config.js";
import type { EngineContext } from "../engine/context.js";
import { runPlainAuthoring, type PlainRequest } from "../engine/authoring/plain.js";
import type { CleanupRequest } from "../engine/cleanup/run.js";
import type { GenerationSink, GenerationSummary } from "../engine/orchestrator.js";
import type { DataSet } from "../engine/testdata/dataset.js";
import { assertEnvironmentTargets, environmentStore } from "./environment-run.js";
import { frameHub } from "./frame-hub.js";
import { HttpError } from "./http-error.js";
import type { Role } from "./identity-store.js";
import type { JobRow, Repo } from "./repo.js";

export const PLAIN_PRODUCTION_MESSAGE = (name: string) =>
    `“${name}” is a production environment, which is read-only. Building a test means clicking through the site, so it can’t be done there. Build it on another environment, then run it on “${name}” from the test’s page.`;

/** The environment a test is built on, or the plain 4xx explaining why it can’t be. */
export async function environmentFor(repo: Repo, config: Pick<Config, "dataDir" | "SECRET_KEY">, projectId: string, name: string) {
    const store = environmentStore(repo, config);
    const env = store.get(projectId, name);
    if (!env) throw new HttpError(404, `This project has no environment called “${name}”.`);
    if (env.production) throw new HttpError(422, PLAIN_PRODUCTION_MESSAGE(env.name));
    await assertEnvironmentTargets(env);
    return { env, secrets: store.secretsOf(env) };
}

/**
 * The sign-in a job uses on an environment. The environment's own secrets always; the application's (the project's) fill what the environment
 * leaves out only when the environment is on the application's own site, since stored sign-in details only go to that site (CREDENTIAL_ORIGIN_RULE).
 * An environment on another host gets its own details or none.
 */
export function environmentCredentials<C extends Record<string, unknown>>(appUrl: string, appCredentials: C | undefined, envBaseUrl: string, secrets: object): C | undefined {
    const own = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)) as Partial<C>;
    if (sameSite(appUrl, envBaseUrl)) return { ...appCredentials, ...own } as C;
    return Object.keys(own).length ? (own as C) : undefined;
}

/** Is the environment on the application's own site? An address that cannot be read is not. */
export function sameSite(appUrl: string, envBaseUrl: string): boolean {
    try {
        return new URL(appUrl).origin === new URL(envBaseUrl).origin;
    } catch {
        return false;
    }
}

type PlainJobArgs = {
    repo: Repo;
    config: Pick<Config, "dataDir" | "SECRET_KEY">;
    ctx: EngineContext;
    job: JobRow;
    app: { url: string; config: Record<string, any>; credentials?: PlainRequest["credentials"]; model: PlainRequest["model"] };
    roles: Role[];
    sink: GenerationSink;
    cleanup: CleanupRequest;
    dataSets: Record<string, DataSet>;
    deleteOps: string[];
    siteNotes?: import("../engine/memory/notes.js").SiteNote[];
};

/** Run one plain-English job: resolve its inputs at the time it runs (an environment may have changed since it was queued), then build and run the test. */
export async function runPlainJob(args: PlainJobArgs): Promise<GenerationSummary> {
    return runPlainAuthoring(args.ctx, await plainRequestOf(args), args.sink);
}

/** The engine's request for a plain-English job, resolved now. Round 52: also what goes to the starter's runner in runners mode. */
export async function plainRequestOf(args: Omit<PlainJobArgs, "ctx" | "sink">): Promise<PlainRequest> {
    const { repo, job, app } = args;
    const o = job.options;
    if (!o.plainDescription) throw new Error("This job has no description to build a test from.");
    if (app.url.startsWith("android-app://") || app.url.startsWith("ios-app://")) throw new Error("Plain-English tests are built for web and API applications, not mobile apps.");

    let url = app.url;
    let apiBaseUrl: string | undefined = app.config.apiBaseUrl ?? undefined;
    let credentials = app.credentials;
    let roles: Role[] = args.roles;
    if (o.environment) {
        const { env, secrets } = await environmentFor(repo, args.config, job.projectId, o.environment);
        url = env.baseUrl;
        apiBaseUrl = env.apiBaseUrl ?? undefined;
        // The environment's own sign-in wins; whatever it leaves out comes from the application, only on the application's own site.
        credentials = environmentCredentials(app.url, app.credentials, env.baseUrl, secrets);
        // The project's accounts are stored sign-in details too: "use the project's accounts" holds on the application's own site only.
        roles = env.useProjectAccounts && sameSite(app.url, env.baseUrl) ? args.roles : [];
    }

    let replace: PlainRequest["replace"];
    if (o.rewriteTestId) {
        const t = repo.getTest(o.rewriteTestId);
        if (!t || t.projectId !== job.projectId) throw new Error("The test to rebuild no longer exists.");
        replace = { handle: { id: t.id, testId: t.testKey }, spec: t.spec };
    }

    // An environment has its own sign-in: its secrets must not show in the Explorer view either.
    frameHub.addSecrets(job.id, [credentials?.password, credentials?.totpSecret, ...roles.flatMap((r) => [r.password, r.totpSecret])]);

    return {
        description: o.plainDescription,
        kind: o.plainKind ?? "web",
        url,
        apiBaseUrl,
        model: app.model,
        credentials,
        roles,
        allowChanges: o.allowMutatingApiTests === true,
        ...(o.environment ? { environment: o.environment } : {}),
        dataSets: args.dataSets,
        deleteOps: args.deleteOps,
        ...(args.siteNotes?.length ? { siteNotes: args.siteNotes } : {}),
        cleanup: args.cleanup,
        replace,
    };
}
