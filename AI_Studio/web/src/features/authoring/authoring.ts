import { api, type PhaseKey, type PhaseState } from "../../api";

/** Same limits as the server (src/engine/authoring/describe.ts). */
export const MIN_LENGTH = 3;
export const MAX_LENGTH = 2000;

/** Sentences people can start from; they show up as the placeholder and as buttons. */
export const EXAMPLES = [
    "Add a product to the cart and check that the total is shown",
    "Log in with the test account and check that the welcome message appears",
    "Search for “mug” and check that at least one result is listed",
];

export interface Started {
    jobId: string;
    status: string;
    kind: "web" | "api";
}

export const startPlainTest = (projectId: string, body: { description: string; environment?: string }) =>
    api<Started>(`/projects/${projectId}/plain-tests`, { method: "POST", body });

export const rewritePlainTest = (testId: string, body: { description: string; environment?: string }) =>
    api<Started>(`/tests/${testId}/plain-rewrite`, { method: "POST", body });

/** The three things that happen to a description, in the words the person would use. */
export function plainPhaseText(phase: PhaseKey, state: PhaseState): { title: string; detail?: string } {
    switch (phase) {
        case "planning":
            return { title: state === "running" ? "Reading your description…" : state === "done" ? "Description read" : "Read your description" };
        case "generation":
            return state === "running"
                ? { title: "Building the test in a real browser…", detail: "We do each step on the page and keep the ones that work" }
                : { title: state === "done" ? "Test built" : "Build the test in a real browser" };
        case "validation":
            return state === "running"
                ? { title: "Running the test…", detail: "A fresh browser runs it from the start, the way it will run every time" }
                : { title: state === "done" ? "Test run" : "Run the test to check it" };
        default:
            return { title: "" };
    }
}

/** The sentence a plain-English test was built from, as stored with the test. */
export function descriptionOf(meta: { plain?: { description?: string } } | null | undefined, fallback?: string): string {
    return meta?.plain?.description ?? fallback ?? "";
}
