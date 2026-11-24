/**
 * Root cause (findings/root-cause.ts) on the product's routes, with the project's connected GitHub repository as the code source: its
 * code files at the default branch's head, read through the stored token (pr-impact.ts repositorySources: JS/TS files, at most 300).
 * The files are kept in memory a few minutes per project, so a findings list does not read the repository once per finding. No AI call:
 * a location is found from the run's stack frames inside the handlers its requests reached. Without a connection, root cause says so.
 */
import { repositoryCodeSource, type CodeSource } from "../../engine/findings/code-source.js";
import { rootCause, type RootCause } from "../../engine/findings/root-cause.js";
import type { FindingView } from "../../engine/findings/view.js";
import { redactText } from "../../shared/redact-text.js";
import type { Db } from "../db.js";
import { SecretBox } from "../secrets.js";
import { repositorySources } from "./pr-impact.js";
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
        return repositoryCodeSource(c, head, (await repositorySources(client, head, [])).sources);
    })();
    kept.delete(projectId);
    if (kept.size >= KEEP_PROJECTS) kept.delete(kept.keys().next().value!);
    kept.set(projectId, { key: c.updatedAt, at: Date.now(), code });
    return code;
}

/** Root cause of a group on a product route: the connected repository when there is one, else Unknown with why. */
export async function projectRootCause(p: { db: Db; config: { dataDir: string; SECRET_KEY?: string } }, projectId: string, members: readonly FindingView[]): Promise<RootCause> {
    const store = new CodeHostStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));
    const c = store.get(projectId);
    if (!c) return rootCause({ members });
    let code: CodeSource;
    try {
        code = await codeOf(store, projectId, c);
    } catch (e) {
        kept.delete(projectId);
        return { ...(await rootCause({ members })), reason: `The connected repository ${c.owner}/${c.repo} could not be read: ${redactText(e instanceof Error ? e.message : String(e), 300)}` };
    }
    return rootCause({ members, code });
}
