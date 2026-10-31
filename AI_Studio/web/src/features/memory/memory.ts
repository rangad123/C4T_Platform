/** Types for what the platform remembers about a project's application (GET /projects/:id/memory). */

export interface MemoryChanges {
    /** When the analysis compared against ran. */
    since: string;
    pagesAdded: string[];
    pagesRemoved: string[];
    pagesChanged: string[];
    endpointsAdded: string[];
    endpointsRemoved: string[];
    journeysNoLongerValidating: string[];
    text: string;
}

export type SiteMemory =
    | { remembered: false; message: string }
    | {
          remembered: true;
          analysedAt: string;
          origin: string;
          siteType: string;
          purpose: string;
          learned: string;
          loginPath: string | null;
          counts: { pages: number; journeys: number; endpoints: number; journeysWithValidatedTests: number };
          /** Null after the first analysis: nothing to compare with yet. */
          changes: MemoryChanges | null;
      };

/** The change lists in the order and wording the card shows them. */
export function changeGroups(c: MemoryChanges): Array<{ key: string; title: string; items: string[] }> {
    return [
        { key: "added", title: "New pages", items: c.pagesAdded },
        { key: "changed", title: "Pages that changed", items: c.pagesChanged },
        { key: "removed", title: "Pages no longer found", items: c.pagesRemoved },
        { key: "ep-added", title: "New API endpoints", items: c.endpointsAdded },
        { key: "ep-removed", title: "API endpoints that are gone", items: c.endpointsRemoved },
        { key: "journeys", title: "Journeys with no passing test now", items: c.journeysNoLongerValidating },
    ].filter((g) => g.items.length > 0);
}
