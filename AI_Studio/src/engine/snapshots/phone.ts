/**
 * Smaller screen descriptions for AI phone exploration (docs/features/smaller-snapshots.md). The explorer lists a screen's elements one per line,
 * `[12] TextView "Product 4" id=product_4 (label only)`, and the model names an element by its number. Each turn is a fresh question (the
 * model keeps no history between turns), so there is no "what changed" list here; only the screen itself is made smaller:
 *
 *  - an element nobody can act on or read (not clickable, editable, scrollable or checkable, and without text or label) is left out;
 *  - a run of look-alike elements (same class, same kind, same id apart from digits) keeps its first 3 lines in full, then one line
 *    saying what the rest share, then each of the rest as just its number and name: `[15] "Product 4"`.
 *
 * Every element that stays keeps its number and its exact text and label, so the model's answer means the same element as before.
 * Pure text in, text out: it works on the lines the explorer already wrote (describe.ts), whose format the tests read too.
 */

const LINE = /^\[(\d+)\] (\S+)((?: "[^"]*")?(?: label "[^"]*")?)(?: id=(\S+))?(?: \(([^)]*)\))?$/;

export const PHONE_RULES = { collapseFrom: 6, keepInRun: 3 } as const;

interface Parsed {
    text: string;
    cls: string;
    names: string;
    id: string;
    flags: string;
}

const parse = (text: string): Parsed | undefined => {
    const m = LINE.exec(text);
    return m ? { text, cls: m[2]!, names: (m[3] ?? "").trim(), id: m[4] ?? "", flags: m[5] ?? "" } : undefined;
};

const signature = (p: Parsed) => `${p.cls}|${p.flags}|${p.id.replace(/\d+/g, "#")}`;

/** One line to list: `elements` is how many screen elements it stands for (0 for the line that describes a run). */
export interface ScreenLine {
    text: string;
    elements: number;
}

export function compactScreenLines(lines: readonly string[]): { lines: ScreenLine[]; dropped: number } {
    const parsed = lines.map((text) => ({ text, p: parse(text) }));
    let dropped = 0;
    const kept = parsed.filter(({ p }) => {
        const decorative = p !== undefined && p.flags === "label only" && !p.names;
        if (decorative) dropped++;
        return !decorative;
    });
    const out: ScreenLine[] = [];
    let i = 0;
    while (i < kept.length) {
        const first = kept[i]!.p;
        let j = i + 1;
        if (first) while (j < kept.length && kept[j]!.p && signature(kept[j]!.p!) === signature(first)) j++;
        const run = kept.slice(i, j);
        if (first && run.length >= PHONE_RULES.collapseFrom) {
            for (const r of run.slice(0, PHONE_RULES.keepInRun)) out.push({ text: r.text, elements: 1 });
            const rest = run.slice(PHONE_RULES.keepInRun);
            const idPattern = first.id ? ` id like ${first.id.replace(/\d+/g, "#")}` : "";
            out.push({ text: `(${rest.length} more ${first.cls}${idPattern}${first.flags ? ` (${first.flags})` : ""} like the ${PHONE_RULES.keepInRun} above; each listed by number and name only)`, elements: 0 });
            for (const r of rest) {
                const index = /^\[(\d+)\]/.exec(r.text)![1];
                out.push({ text: `[${index}]${r.p!.names ? ` ${r.p!.names}` : " (no name)"}`, elements: 1 });
            }
        } else for (const r of run) out.push({ text: r.text, elements: 1 });
        i = j;
    }
    return { lines: out, dropped };
}
