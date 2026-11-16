/**
 * Rules and workflows guessed from the application's pages (their purpose, labels, field constraints and the messages they show). A page
 * shows what the application does, not what it should do, so everything read here is inferred: never explicit, never an expectation, and
 * like every rule it waits for a person to confirm it. Pages that have not changed since the last exploration are not sent again.
 */
import type { LlmClient } from "../../llm/provider.js";
import type { ModelFragment } from "../fragment.js";
import type { AppModel } from "../model.js";
import { extractRules, type ExtractionDocument } from "./rules.js";

type Page = AppModel["pages"][number];

const quoted = (s: string | undefined) => (s ? `"${s}"` : "");

/** What a page says about itself, one fact per line. */
export function pageDocument(p: Page): ExtractionDocument {
    const lines = [`Page ${p.path}`];
    if (p.purpose) lines.push(`Purpose: ${p.purpose}`);
    for (const e of p.elements.slice(0, 150)) if (e.name) lines.push(`${e.kind === "other" ? e.role : e.kind}: ${quoted(e.name)}`);
    for (const f of p.forms) {
        lines.push(`Form ${quoted(f.name)}`.trim());
        for (const x of f.fields) {
            const limits = [
                x.type,
                x.required ? "required" : "",
                x.min !== undefined ? `min ${x.min}` : "",
                x.max !== undefined ? `max ${x.max}` : "",
                x.minLength !== undefined ? `at least ${x.minLength} characters` : "",
                x.maxLength !== undefined ? `at most ${x.maxLength} characters` : "",
                x.pattern ? `pattern ${x.pattern}` : "",
                x.options?.length ? `options ${x.options.join(", ")}` : "",
            ].filter(Boolean);
            lines.push(`Field ${quoted(x.label || x.name)} (${limits.join("; ")})`);
            if (x.message) lines.push(`Message for ${quoted(x.label || x.name)}: ${x.message}`);
        }
    }
    for (const s of p.structures) lines.push(`${s.kind[0]!.toUpperCase()}${s.kind.slice(1)} ${quoted(s.name)}${s.headers?.length ? ` with columns ${s.headers.join(", ")}` : ""}`.trim());
    return { ref: `page:${p.path}`, lines: lines.slice(0, 300) };
}

export async function extractFromPages(
    llm: LlmClient,
    pages: Page[],
    opts: { unchanged?: ReadonlySet<string>; knownWorkflows?: { id: string; name: string }[]; ref?: string; now?: string; signal?: AbortSignal } = {},
): Promise<ModelFragment> {
    const changed = pages.filter((p) => !opts.unchanged?.has(p.path));
    const f = await extractRules(llm, { source: { kind: "exploration", ref: opts.ref ?? "pages" }, sourceType: "inferred", documents: changed.map(pageDocument), knownWorkflows: opts.knownWorkflows, now: opts.now, signal: opts.signal });
    const kept = pages.length - changed.length;
    if (kept && f.source.status === "processed") f.notes.push(`${kept} page${kept === 1 ? " has" : "s have"} not changed since the last exploration and ${kept === 1 ? "was" : "were"} not sent again.`);
    return f;
}
