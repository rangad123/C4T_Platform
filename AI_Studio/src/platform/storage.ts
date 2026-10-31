import type { ObjectStore } from "./object-store.js";

/**
 * The artifact store is the platform's ObjectStore (object-store.ts):
 *   <projectId>/<suiteSlug>/<TEST-ID>.spec.ts
 *   <projectId>/_artifacts/<jobId|testId>/...
 * Paths stored in the DB are relative to the store root and are the object keys, so the store can move (local disk today, S3 later)
 * without data migration. The name is kept for the modules that import it.
 */
export type ArtifactStore = ObjectStore;

export function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "general";
}
