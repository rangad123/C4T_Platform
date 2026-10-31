/**
 * Wording similarity for locator healing. Deterministic and model-free: "Add to cart" and "Add to basket" mean the
 * same thing, "Add to cart" and "Remove from cart" do not. Everything here is a pure function so the rules can be tested
 * without a browser.
 */

/** Lower case, no accents, punctuation turned into spaces, single spaces. camelCase and snake/kebab case are split into words. */
export function normalise(raw: string): string {
    return raw
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/['’`]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/** Phrases that name one action in different words. Applied before splitting into words. */
const PHRASES: Array<[RegExp, string]> = [
    [/\b(sign in|log in|signin|login)\b/g, "login"],
    [/\b(sign out|log out|signout|logout)\b/g, "logout"],
    [/\b(sign up|signup|register|create an account|create account|join now)\b/g, "register"],
    [/\bcheck out\b/g, "checkout"],
    [/\be mail\b/g, "email"],
];
/** Single words used interchangeably. */
const WORDS: Record<string, string> = { basket: "cart", bag: "cart", trolley: "cart", mail: "email", purchase: "buy" };
const STOP = new Set(["a", "an", "the", "to", "of", "for", "your", "my", "this", "now", "please"]);

/** Pairs that mean the opposite of each other. A name that swaps one word for its opposite is a different control. */
const OPPOSITES: Array<[string, string]> = [
    ["add", "remove"], ["add", "delete"], ["create", "delete"], ["enable", "disable"], ["open", "close"], ["show", "hide"],
    ["accept", "decline"], ["accept", "reject"], ["accept", "deny"], ["yes", "no"], ["save", "discard"], ["next", "previous"],
    ["next", "prev"], ["next", "back"], ["login", "logout"], ["login", "register"], ["increase", "decrease"],
    ["expand", "collapse"], ["subscribe", "unsubscribe"], ["follow", "unfollow"], ["like", "unlike"], ["buy", "sell"],
    ["allow", "block"], ["start", "stop"], ["lock", "unlock"], ["join", "leave"], ["import", "export"], ["upload", "download"],
    ["publish", "unpublish"], ["approve", "reject"], ["confirm", "cancel"], ["select", "deselect"], ["undo", "redo"],
    ["first", "last"], ["up", "down"], ["more", "less"], ["on", "off"],
];
const NEGATIONS = new Set(["not", "no", "never", "dont", "cannot", "cant", "without"]);

export function words(raw: string): string[] {
    let s = ` ${normalise(raw)} `;
    for (const [re, to] of PHRASES) s = s.replace(re, to);
    const all = s.split(" ").filter(Boolean).map((w) => WORDS[w] ?? w);
    const kept = all.filter((w) => !STOP.has(w));
    return kept.length ? kept : all;
}

const numbersOf = (ws: string[]) => ws.filter((w) => /^\d+$/.test(w)).sort().join(",");

/** True when the two names differ in a way that changes the meaning: opposite word, negation, or a different number. */
export function contradicts(a: string[], b: string[]): boolean {
    const onlyA = a.filter((w) => !b.includes(w));
    const onlyB = b.filter((w) => !a.includes(w));
    if (OPPOSITES.some(([x, y]) => (onlyA.includes(x) && onlyB.includes(y)) || (onlyA.includes(y) && onlyB.includes(x)))) return true;
    if (a.some((w) => NEGATIONS.has(w)) !== b.some((w) => NEGATIONS.has(w))) return true;
    return numbersOf(a) !== numbersOf(b);
}

function levenshtein(a: string, b: string): number {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0]!;
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const keep = prev[j]!;
            prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = keep;
        }
    }
    return prev[b.length]!;
}

export type SimilarityKind = "same" | "synonym" | "close" | "none";
export interface Similarity {
    score: number;
    kind: SimilarityKind;
}

/**
 * How alike two names are, 0..1.
 *  - identical after tidying up: 1
 *  - identical once synonyms are unified ("cart" = "basket", "sign in" = "log in"): 0.95
 *  - otherwise the share of words they have in common, or a near-identical spelling (typo, hyphen, plural)
 * Names that contradict each other score 0 whatever they share.
 */
export function nameSimilarity(a: string, b: string): Similarity {
    const na = normalise(a);
    const nb = normalise(b);
    if (!na || !nb) return { score: 0, kind: "none" };
    if (na === nb) return { score: 1, kind: "same" };
    const wa = words(a);
    const wb = words(b);
    if (contradicts(wa, wb)) return { score: 0, kind: "none" };
    const ja = wa.join(" ");
    const jb = wb.join(" ");
    if (ja === jb) return { score: 0.95, kind: "synonym" };
    const shared = wa.filter((w) => wb.includes(w)).length;
    const union = new Set([...wa, ...wb]).size;
    let score = union ? shared / union : 0;
    const longest = Math.max(ja.length, jb.length);
    if (longest >= 4) {
        const ratio = 1 - levenshtein(ja, jb) / longest;
        if (ratio >= 0.85) score = Math.max(score, ratio);
    }
    return score > 0 ? { score, kind: "close" } : { score: 0, kind: "none" };
}
