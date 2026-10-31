/** Compact text for AI tools: summaries first, ids always, anything big cut to a cap with a count of what was left out. */

/** Most characters one tool answer may have. */
export const MAX_OUTPUT_CHARS = 12_000;

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One line of at most `max` characters. */
export function oneLine(s: unknown, max = 200): string {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Cut a long text at a line boundary and say how much is missing. */
export function cap(text: string, max = MAX_OUTPUT_CHARS): string {
    if (text.length <= max) return text;
    const cut = text.lastIndexOf("\n", max);
    const head = text.slice(0, cut > max / 2 ? cut : max);
    return `${head}\n…${plural(text.length - head.length, "more character")} not shown (the answer was cut to ${max} characters).`;
}

/** At most `limit` rendered lines, then "…N more". */
export function listLines<T>(items: T[], limit: number, render: (item: T) => string): string[] {
    const lines = items.slice(0, limit).map(render);
    if (items.length > limit) lines.push(`…${items.length - limit} more`);
    return lines;
}

/** `camelCase` counter name to words. */
export const words = (key: string): string => key.replace(/([A-Z])/g, " $1").toLowerCase();

/** Replace every occurrence of a secret by a placeholder (defence in depth: the key is never put into output on purpose). */
export function scrub(text: string, secret?: string): string {
    return secret && secret.length >= 4 ? text.split(secret).join("[hidden]") : text;
}
