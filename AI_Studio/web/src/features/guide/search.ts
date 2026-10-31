import type { GlossaryEntry, Topic } from "./types.js";

/**
 * Search over the guide, in the browser, with no library. It is forgiving on purpose, because the person typing has never
 * seen our words: case and plurals do not matter, a word may be the start of a longer one ("night" finds "nightly"),
 * small words ("how do I") are ignored, and a word of five letters or more may have a typo or two.
 * Words that appear in many topics count for less than words that appear in few ("run" is everywhere, "nightly" is not).
 */

export interface Hit {
    kind: "topic" | "word";
    id: string;
    title: string;
    /** One plain line to show under the title. */
    snippet: string;
    score: number;
}

const STOP = new Set(["a", "an", "the", "to", "of", "in", "on", "at", "for", "and", "or", "with", "is", "it", "my", "me", "i", "we", "do", "does", "how", "can", "what", "where", "when", "why", "want", "need", "get", "make", "about", "this", "that", "are", "be", "from", "into", "you", "your", "our", "if", "so"]);

/** A small, predictable plural and ending trim, so "tests" matches "test" and "schedules" matches "schedule". */
export function stem(word: string): string {
    let w = word;
    if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
    if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    return w;
}

export function tokens(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 0 && !STOP.has(w))
        .map(stem);
}

/** Edit distance, stopping early once it is certain to be over `max`. */
export function editDistance(a: string, b: string, max = 2): number {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
            row.push(v);
            if (v < best) best = v;
        }
        if (best > max) return max + 1;
        prev = row;
    }
    return prev[b.length]!;
}

type Field = "title" | "keywords" | "what" | "why" | "steps" | "terms" | "meaning";
const FIELD_WEIGHT: Record<Field, number> = { title: 10, keywords: 8, terms: 10, what: 4, why: 3, steps: 2, meaning: 3 };

interface Doc {
    kind: "topic" | "word";
    index: number;
    id: string;
    title: string;
    snippet: string;
    fields: Partial<Record<Field, Set<string>>>;
}

function docsOf(topics: Topic[], glossary: GlossaryEntry[]): Doc[] {
    const set = (...texts: Array<string | undefined>) => new Set(texts.flatMap((t) => (t ? tokens(t) : [])));
    const docs: Doc[] = topics.map((t, index) => ({
        kind: "topic",
        index,
        id: t.id,
        title: t.title,
        snippet: t.what,
        fields: {
            title: set(t.title),
            keywords: set(...(t.keywords ?? [])),
            what: set(t.what),
            why: set(t.why),
            steps: set(...t.steps.map((s) => s.text)),
        },
    }));
    glossary.forEach((g, index) => docs.push({ kind: "word", index, id: g.id, title: g.term, snippet: g.meaning, fields: { terms: set(g.term, ...(g.alsoCalled ?? [])), meaning: set(g.meaning) } }));
    return docs;
}

/** How well one query word matches a set of words: 1 exact, 0.85 as the start of a longer word, 0.6 with a typo, else 0. */
function match(q: string, words: Set<string>): number {
    if (words.has(q)) return 1;
    let best = 0;
    for (const w of words) {
        if (q.length >= 4 && w.startsWith(q)) best = Math.max(best, 0.85);
        else if (w.length >= 4 && q.startsWith(w) && q.length - w.length <= 3) best = Math.max(best, 0.7);
        else if (q.length >= 5 && w.length >= 5 && editDistance(q, w, q.length >= 8 ? 2 : 1) <= (q.length >= 8 ? 2 : 1)) best = Math.max(best, 0.6);
    }
    return best;
}

/**
 * Topics and glossary words that fit `query`, best first. A word hit is listed after the topic hits with a similar score,
 * so a question like "how do I run tests every night" lands on a topic, and "flaky" lands on the word and the topics that use it.
 */
export function searchGuide(query: string, topics: Topic[], glossary: GlossaryEntry[], limit = 12): Hit[] {
    const q = [...new Set(tokens(query))];
    if (q.length === 0) return [];
    const docs = docsOf(topics, glossary);
    // Inverse document frequency over topics and words together.
    const df = (word: string) => docs.filter((d) => Object.values(d.fields).some((f) => f && match(word, f) > 0)).length;
    const idf = new Map(q.map((w) => [w, Math.log(1 + docs.length / Math.max(1, df(w)))]));
    const hits: Hit[] = [];
    for (const d of docs) {
        let score = 0;
        let covered = 0;
        for (const w of q) {
            let best = 0;
            for (const [field, words] of Object.entries(d.fields) as Array<[Field, Set<string>]>) best = Math.max(best, match(w, words) * FIELD_WEIGHT[field]);
            if (best > 0) covered++;
            score += best * (idf.get(w) ?? 1);
        }
        if (covered === 0) continue;
        // Covering more of what was asked matters more than one strong word.
        score *= 0.5 + covered / q.length;
        if (d.kind === "word") score *= 0.8;
        hits.push({ kind: d.kind, id: d.id, title: d.title, snippet: d.snippet, score });
    }
    // Stable: equal scores keep the order the content was written in (topics first).
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
