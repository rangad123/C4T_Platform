/** Where an imported test came from, and a short summary of how a refresh changed it. */

export interface GitProvenance {
    /** Host (and port) of the repository, as shown to people. */
    host: string;
    /** `owner/repo` on that host. */
    path: string;
    ref: string;
    commit: string;
    importedAt: string;
    /** The link to the stored repository row, and the file inside the repository. */
    repoId: string;
    file: string;
}

export function buildProvenance(p: { host: string; path: string; ref: string; commit: string; repoId: string; file: string; now?: Date }): GitProvenance {
    return { host: p.host, path: p.path, ref: p.ref, commit: p.commit, importedAt: (p.now ?? new Date()).toISOString(), repoId: p.repoId, file: p.file };
}

/** Line counts added and removed between two versions of a file (a multiset comparison: cheap, and honest about being approximate). */
export function summarizeDiff(before: string, after: string): { added: number; removed: number } {
    const count = (text: string) => {
        const m = new Map<string, number>();
        for (const l of text.split(/\r?\n/)) m.set(l, (m.get(l) ?? 0) + 1);
        return m;
    };
    const a = count(before);
    const b = count(after);
    let added = 0;
    let removed = 0;
    for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
    for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
    return { added, removed };
}

