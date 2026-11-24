/**
 * The project's connected GitHub repository as root cause's code source (findings/root-cause.ts): its code files at the default branch's
 * head, read through the stored token (pr-impact.ts repositorySources: JS/TS files, at most 300), kept in memory a few minutes per
 * project. Verification works out each group's cause with it and the job's model and keeps it on the finding (verify-service.ts);
 * `projectRootCause` is the routes' answer for a finding verified before that: no AI call, a location only from a stack frame.
 */
import { repositoryCodeSource, type CodeSource } from "../../engine/findings/code-source.js";
import { rootCause, type RootCause } from "../../engine/findings/root-cause.js";
import type { FindingView } from "../../engine/findings/view.js";
import type { LlmClient } from "../../engine/llm/provider.js";
import { redactText } from "../../shared/redact-text.js";
import type { Db } from "../db.js";
import { SecretBox } from "../secrets.js";
import { CodeHostStore } from "./store.js";

const KEEP_MS = 5 * 60_000;
// shortcut: a small in-process cache (each entry holds up to 300 files); a bigger fleet would keep the files with the connection instead.
const KEEP_PROJECTS = 20;
const kept = new Map<string, { key: string; at: number; code: Promise<CodeSource> }>();

function codeOf(store: CodeHostStore, projectId: string, c: { owner: string; repo: string; updatedAt: string }): Promise<CodeSource> {
    const hit = kept.get(projectId);
    if (hit && hit.key === c.updatedAt && Date.now() - hit.at < KEEP_MS) return hit.code;
    const code = (async () => {
        const client = store.client(projectId)!;
        const head = await client.head();
        // Loaded here: pr-impact.ts reaches schedule-services.ts, which loads verification, which loads this file.
        const { repositorySources } = await import("./pr-impact.js");
        return repositoryCodeSource(c, head, (await repositorySources(client, head, [])).sources);
    })();
    kept.delete(projectId);
    if (kept.size >= KEEP_PROJECTS) kept.delete(kept.keys().next().value!);
    kept.set(projectId, { key: c.updatedAt, at: Date.now(), code });
    return code;
}

type PlatformLike = { db: Db; config: { dataDir: string; SECRET_KEY?: string } };

/** The project's code source: none connected (`{}`), the repository's files, or why they could not be read. */
export async function projectCodeSource(p: PlatformLike, projectId: string): Promise<{ code?: CodeSource; why?: string }> {
    const store = new CodeHostStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));
    const c = store.get(projectId);
    if (!c) return {};
    try {
        return { code: await codeOf(store, projectId, c) };
    } catch (e) {
        kept.delete(projectId);
        return { why: `The connected repository ${c.owner}/${c.repo} could not be read: ${redactText(e instanceof Error ? e.message : String(e), 300)}` };
    }
}

/** Root cause of a group from a code source answer (`llm`: verification's model; the routes pass none). */
export async function rootCauseWith(src: { code?: CodeSource; why?: string }, members: readonly FindingView[], llm?: LlmClient): Promise<RootCause> {
    if (src.why) return { ...(await rootCause({ members })), reason: src.why };
    return rootCause({ members, ...(src.code ? { code: src.code } : {}), ...(llm ? { llm } : {}) });
}

/** Root cause of a group on a product route, for a finding verification has not kept one for: no AI call. */
export async function projectRootCause(p: PlatformLike, projectId: string, members: readonly FindingView[]): Promise<RootCause> {
    return rootCauseWith(await projectCodeSource(p, projectId), members);
}
