import { LIBRARY_SECTIONS, RELEASE_SECTIONS, RUNS_SECTIONS, SETUP_SECTIONS, routes } from "../../lib/router.js";
import type { WhereTo } from "./types.js";

/** Places that live inside one project. The others (projects, new project, settings) need no project. */
export function needsProject(where: WhereTo): boolean {
    return !["projects", "new-project", "settings"].includes(where.place);
}

const inList = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => list.find((x) => x === v);

/**
 * The address a `WhereTo` opens, with the router's own builders (so it can never drift from the real routes).
 * Returns null when the place needs a project and none is given. An unknown section opens the place's first section.
 */
export function whereToHref(where: WhereTo, projectId: string | null | undefined): string | null {
    switch (where.place) {
        case "projects":
            return routes.home;
        case "new-project":
            return routes.newProject();
        case "settings":
            return routes.settings;
    }
    if (!projectId) return null;
    switch (where.place) {
        case "overview":
            return routes.project(projectId);
        case "tests":
            return routes.tests(projectId);
        case "runs":
            return routes.runs(projectId, inList(RUNS_SECTIONS, where.section));
        case "library":
            return routes.library(projectId, inList(LIBRARY_SECTIONS, where.section));
        case "release":
            return routes.releaseHub(projectId, inList(RELEASE_SECTIONS, where.section));
        case "setup":
            return routes.setup(projectId, inList(SETUP_SECTIONS, where.section));
    }
}

/** The sections a place has, for tests that check the content only names real ones. */
export const SECTIONS_OF: Record<string, readonly string[]> = { runs: RUNS_SECTIONS, library: LIBRARY_SECTIONS, release: RELEASE_SECTIONS, setup: SETUP_SECTIONS };
