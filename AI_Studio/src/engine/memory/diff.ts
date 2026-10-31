/**
 * Deterministic change summary between the remembered knowledge and a new analysis: pages added / removed / changed
 * (by content fingerprint), endpoints added / removed, journeys that no longer have a validated scenario.
 * Pure function: the model is never asked what changed. A page that is in memory but was not found is reported as
 * "no longer found" — it is not assumed deleted (the crawl may have been smaller or the page may be behind a login).
 */
import type { MemoryChanges, SiteKnowledge } from "./types.js";

const CAP = 50;

const endpointKey = (a: { method: string; path: string }) => `${a.method} ${a.path}`;
const jkey = (s: string) => s.trim().toLowerCase();

export interface DiffOptions {
    /** Compare journey validation too (false for the early, discovery-only comparison used in prompts). */
    journeys?: boolean;
}

export function diffKnowledge(previous: SiteKnowledge, current: SiteKnowledge, opts: DiffOptions = {}): MemoryChanges {
    const before = new Map(previous.pages.map((p) => [p.path, p.fp]));
    const after = new Map(current.pages.map((p) => [p.path, p.fp]));
    const pagesAdded = [...after.keys()].filter((p) => !before.has(p)).sort();
    const pagesRemoved = [...before.keys()].filter((p) => !after.has(p)).sort();
    const pagesChanged = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p)).sort();

    const beforeApis = new Set(previous.apis.map(endpointKey));
    const afterApis = new Set(current.apis.map(endpointKey));
    const endpointsAdded = [...afterApis].filter((e) => !beforeApis.has(e)).sort();
    const endpointsRemoved = [...beforeApis].filter((e) => !afterApis.has(e)).sort();

    let journeysNoLongerValidating: string[] = [];
    if ((opts.journeys ?? true) && current.validationKnown) {
        const now = new Map(current.journeys.map((j) => [jkey(j.name), j]));
        journeysNoLongerValidating = previous.journeys
            .filter((j) => j.validated.length > 0 && (now.get(jkey(j.name))?.validated.length ?? 0) === 0)
            .map((j) => j.name)
            .sort();
    }

    const counts = {
        pagesAdded: pagesAdded.length,
        pagesRemoved: pagesRemoved.length,
        pagesChanged: pagesChanged.length,
        endpointsAdded: endpointsAdded.length,
        endpointsRemoved: endpointsRemoved.length,
        journeysNoLongerValidating: journeysNoLongerValidating.length,
    };
    return {
        since: previous.analysedAt,
        pagesAdded: pagesAdded.slice(0, CAP),
        pagesRemoved: pagesRemoved.slice(0, CAP),
        pagesChanged: pagesChanged.slice(0, CAP),
        endpointsAdded: endpointsAdded.slice(0, CAP),
        endpointsRemoved: endpointsRemoved.slice(0, CAP),
        journeysNoLongerValidating: journeysNoLongerValidating.slice(0, CAP),
        counts,
        text: changeText(counts),
    };
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "Since the last analysis: 2 new pages, 1 page changed, 1 endpoint gone." */
export function changeText(c: MemoryChanges["counts"]): string {
    const parts: string[] = [];
    if (c.pagesAdded) parts.push(`${n(c.pagesAdded, "new page")}`);
    if (c.pagesChanged) parts.push(`${n(c.pagesChanged, "page")} changed`);
    if (c.pagesRemoved) parts.push(`${n(c.pagesRemoved, "page")} no longer found`);
    if (c.endpointsAdded) parts.push(`${n(c.endpointsAdded, "new endpoint")}`);
    if (c.endpointsRemoved) parts.push(`${n(c.endpointsRemoved, "endpoint")} gone`);
    if (c.journeysNoLongerValidating) parts.push(`${n(c.journeysNoLongerValidating, "journey", "journeys")} no longer validating`);
    return parts.length ? `Since the last analysis: ${parts.join(", ")}.` : "Since the last analysis: nothing changed.";
}
