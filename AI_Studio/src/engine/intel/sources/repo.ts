/**
 * Repository artefacts as sources of application knowledge: OpenAPI documents, database schema files, test files and documents
 * (README, docs/) found in a checked-out repository. Each one becomes its own source (kind, ref = path @ commit). Application code is
 * never returned, nothing is executed, symbolic links are never followed and only paths inside the repository are read.
 */
import { classifyPath, decodeUtf8, isSafeRepoPath, isUnder, type SkipReason } from "../../gitimport/files.js";
import type { SourceKind } from "../model.js";

/** A checked-out tree as git lists it (the platform's checkout has this shape); blobs are read by object id. */
export interface RepoTree {
    commit: string;
    entries: { path: string; mode: string; type: string; sha: string; size: number }[];
    read(shas: string[]): Promise<Map<string, Buffer>>;
}

export type ArtefactKind = Extract<SourceKind, "openapi" | "db_schema" | "existing_tests" | "requirements">;

export interface RepoArtefact {
    kind: ArtefactKind;
    /** `path@commit`: the source's ref. */
    ref: string;
    path: string;
    text: string;
}

export interface RepoArtefacts {
    artefacts: RepoArtefact[];
    skipped: SkipReason[];
    /** Sentences about caps that were reached. */
    notes: string[];
}

const KB = 1024;
/** Per kind: how many files are read and the largest file read. */
export const ARTEFACT_LIMITS: Record<ArtefactKind, { files: number; bytes: number; words: string }> = {
    openapi: { files: 10, bytes: 2048 * KB, words: "OpenAPI documents" },
    db_schema: { files: 50, bytes: 1024 * KB, words: "schema files" },
    existing_tests: { files: 200, bytes: 200 * KB, words: "test files" },
    requirements: { files: 50, bytes: 500 * KB, words: "documents" },
};

const ext = (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};
const DOC_FOLDERS = new Set(["docs", "doc", "documentation", "requirements", "specs", "spec"]);

/** The kind of artefact a path may be, from the path alone; undefined for everything else (application code included). */
function kindOf(path: string): ArtefactKind | undefined {
    const parts = path.split("/");
    const name = parts[parts.length - 1]!.toLowerCase();
    const e = ext(name);
    if (["json", "yaml", "yml"].includes(e) && /^(openapi|swagger|api-docs)([._-].*)?\.(json|ya?ml)$|\.(openapi|swagger)\.(json|ya?ml)$/.test(name)) return "openapi";
    if (e === "sql" || e === "prisma") return "db_schema";
    if (classifyPath(path) === "candidate" || e === "feature") return "existing_tests";
    if (/^readme(\.(md|markdown|txt))?$/.test(name)) return "requirements";
    if (["md", "markdown", "txt"].includes(e) && parts.slice(0, -1).some((p) => DOC_FOLDERS.has(p.toLowerCase()))) return "requirements";
    return undefined;
}

/** An OpenAPI-named file is used only when it says it is one near its start. */
const isOpenApiText = (text: string) => /["']?(openapi|swagger)["']?\s*:/.test(text.slice(0, 4096));

export async function findRepoArtefacts(tree: RepoTree, opts: { subpath?: string } = {}): Promise<RepoArtefacts> {
    const skipped: SkipReason[] = [];
    const notes: string[] = [];
    const counts: Record<ArtefactKind, number> = { openapi: 0, db_schema: 0, existing_tests: 0, requirements: 0 };
    const chosen: { entry: RepoTree["entries"][number]; kind: ArtefactKind }[] = [];
    const entries = [...tree.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const entry of entries) {
        if (!isSafeRepoPath(entry.path)) {
            skipped.push({ path: entry.path, reason: "A path outside the repository, which is never read." });
            continue;
        }
        if (!isUnder(entry.path, opts.subpath ?? "")) continue;
        const kind = kindOf(entry.path);
        if (!kind) continue;
        // Dependency and hidden folders are not the application's own files.
        const folders = entry.path.split("/").slice(0, -1);
        if (folders.some((p) => p === "node_modules" || p.startsWith("."))) continue;
        if (entry.mode === "120000") {
            skipped.push({ path: entry.path, reason: "A symbolic link, which is never followed." });
            continue;
        }
        if (entry.type !== "blob") {
            skipped.push({ path: entry.path, reason: "Not a regular file." });
            continue;
        }
        const limit = ARTEFACT_LIMITS[kind];
        if (entry.size > limit.bytes) {
            skipped.push({ path: entry.path, reason: `Larger than ${limit.bytes / KB} KB.` });
            continue;
        }
        if (counts[kind] >= limit.files) {
            if (counts[kind] === limit.files) notes.push(`Only the first ${limit.files} ${limit.words} were read.`);
            counts[kind]++;
            continue;
        }
        counts[kind]++;
        chosen.push({ entry, kind });
    }
    const blobs = chosen.length ? await tree.read([...new Set(chosen.map((c) => c.entry.sha))]) : new Map<string, Buffer>();
    const artefacts: RepoArtefact[] = [];
    for (const { entry, kind } of chosen) {
        const buf = blobs.get(entry.sha);
        const text = buf && buf.length <= ARTEFACT_LIMITS[kind].bytes ? decodeUtf8(buf) : null;
        if (text === null) {
            skipped.push({ path: entry.path, reason: "Not a text file (binary content or not UTF-8)." });
            continue;
        }
        if (kind === "openapi" && !isOpenApiText(text)) continue;
        artefacts.push({ kind, ref: `${entry.path}@${tree.commit}`, path: entry.path, text });
    }
    return { artefacts, skipped, notes };
}
