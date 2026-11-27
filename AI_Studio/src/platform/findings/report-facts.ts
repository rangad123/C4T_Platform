/**
 * What a finding's report needs beyond the finding row (issues/content.ts buildFindingReport): the answers its failing verification
 * attempt received, from the evidence package verification kept (verify-service.ts keepEvidence, already masked), and the sign-in names
 * of the project's test accounts. Read only; never a password, token or authenticator secret.
 */
import type { Db } from "../db.js";
import { IdentityStore } from "../identity-store.js";
import type { Repo } from "../repo.js";
import type { SecretBox } from "../secrets.js";
import type { ArtifactStore } from "../storage.js";
import type { EvidencePackage } from "./verify-service.js";

/** The kept answers of the first failed attempt that has any (at most 3). */
export async function findingAnswers(db: Db, store: ArtifactStore, f: { id: string; projectId: string; testId: string | null }): Promise<EvidencePackage["responseBodies"]> {
    if (!f.testId) return [];
    const rows = db.all<{ path: string }>("SELECT path FROM artifacts WHERE project_id = ? AND test_case_id = ? AND kind = 'evidence' AND path LIKE ? AND pruned_at IS NULL ORDER BY path", f.projectId, f.testId, `%/verify-${f.id.slice(0, 8)}/attempt-%`);
    for (const r of rows) {
        try {
            const pkg = JSON.parse((await store.getBytes(r.path)).toString("utf8")) as Partial<EvidencePackage>;
            if (pkg.outcome === "failed" && pkg.responseBodies?.length) return pkg.responseBodies.slice(-3);
        } catch {
            /* a package that is gone or unreadable: the report goes without its answers */
        }
    }
    return [];
}

/** Account name → sign-in name; "main" is the project's own test account. Empty when the accounts cannot be read. */
export function accountSignIns(repo: Repo, secrets: SecretBox, projectId: string): Map<string, string> {
    const out = new Map<string, string>();
    try {
        for (const r of new IdentityStore(repo.db, secrets).get(projectId)) if (r.username) out.set(r.name, r.username);
        const app = repo.getLatestApplicationPublic(projectId) as { id?: string } | undefined;
        const main = app?.id ? repo.getApplication(app.id)?.credentials?.username : undefined;
        if (main) out.set("main", main);
    } catch {
        /* accounts that cannot be decrypted (a changed key): names only */
    }
    return out;
}
