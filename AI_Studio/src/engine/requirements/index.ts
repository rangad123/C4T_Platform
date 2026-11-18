/**
 * A word index over one project's requirements (BM25 over words; no dependency, no AI), so a planning call can be given the
 * requirements that belong to the pages it plans, in full, instead of a cut-down list.
 *
 * Isolation: an index holds only the requirements it was built from, and there is no shared registry. The planner builds one for each
 * planning run from that job's requirements (one project's), and it lives only as long as that run: another project's index is never
 * reachable, and an edited or removed requirement is never served from an older index. Building takes milliseconds for thousands of
 * requirements, so nothing is kept between runs.
 */
import crypto from "node:crypto";

export interface IndexedDoc {
    id: string;
    text: string;
}

/** Words too common to tell requirements apart. */
const STOP = new Set(
    "a an and are as at be by can could do does for from has have if in into is it its may must not of on or shall should so such than that the their them then there these they this to was were when where which while who will with would you your user users system page".split(" "),
);

/** A word's plain form: lower case, a plural or verb ending taken off (enough for "carts" to find "cart", "saving" to find "saved"). */
function stem(w: string): string {
    if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
    return w;
}

/** The words of a text, for indexing and for queries. */
export function wordsOf(text: string): string[] {
    // Bare numbers ("/products/12", "step 3") say little about what a requirement is about and would match by accident.
    return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}

const K1 = 1.2;
const B = 0.75;

export class RequirementIndex {
    private readonly docs: Array<{ id: string; text: string; sha256: string; tf: Map<string, number>; len: number }> = [];
    private readonly df = new Map<string, number>();
    private avgLen = 0;

    constructor(docs: readonly IndexedDoc[]) {
        const seen = new Set<string>();
        for (const d of docs) {
            if (seen.has(d.id)) continue;
            seen.add(d.id);
            const words = wordsOf(d.text);
            const tf = new Map<string, number>();
            for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
            for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
            this.docs.push({ id: d.id, text: d.text, sha256: crypto.createHash("sha256").update(d.text).digest("hex"), tf, len: words.length });
        }
        this.avgLen = this.docs.length ? this.docs.reduce((s, d) => s + d.len, 0) / this.docs.length : 0;
    }

    get size(): number {
        return this.docs.length;
    }

    /** The content hash each requirement was indexed with (what an edit changes). */
    sha256Of(id: string): string | undefined {
        return this.docs.find((d) => d.id === id)?.sha256;
    }

    /** The requirements that match the query best, best first; only those sharing a word with it, at most `k`. */
    search(query: string, k: number): Array<{ id: string; score: number }> {
        const q = [...new Set(wordsOf(query))];
        if (!q.length || !this.docs.length) return [];
        const n = this.docs.length;
        const scored: Array<{ id: string; score: number; at: number }> = [];
        this.docs.forEach((d, at) => {
            let score = 0;
            for (const w of q) {
                const f = d.tf.get(w);
                if (!f) continue;
                const df = this.df.get(w)!;
                const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
                score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / (this.avgLen || 1)));
            }
            if (score > 0) scored.push({ id: d.id, score, at });
        });
        return scored
            .sort((a, b) => b.score - a.score || a.at - b.at)
            .slice(0, Math.max(0, k))
            .map(({ id, score }) => ({ id, score }));
    }

    /** The requirements whose text names one of these page paths ("/account/settings"; "/" and bare words are not names), in order. */
    naming(paths: readonly string[]): string[] {
        const names = [...new Set(paths.map((p) => (p.split("?")[0] ?? "").replace(/\/+$/, "").toLowerCase()).filter((p) => p.length > 1))];
        if (!names.length) return [];
        return this.docs
            .filter((d) => {
                const t = d.text.toLowerCase();
                return names.some((p) => {
                    for (let i = t.indexOf(p); i >= 0; i = t.indexOf(p, i + 1)) if (!/[\p{L}\p{N}/_-]/u.test(t[i + p.length] ?? "")) return true;
                    return false;
                });
            })
            .map((d) => d.id);
    }
}
