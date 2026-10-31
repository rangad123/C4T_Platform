/** Types and wording for the object repository (the API lives in src/platform/routes/locators.ts). */
export type ElementKind = "web" | "mobile" | "desktop";
export type Strategy = "role" | "label" | "text" | "placeholder" | "testId" | "css";

export interface ElementLocator {
    by: Strategy;
    role?: string;
    value?: string;
    exact?: boolean;
    nth?: number;
}

export interface UserBrief {
    id: string;
    testId: string;
    title: string;
    /** The reusable steps this test reaches the element through (absent when the test spells the element out itself). */
    viaBlocks?: string[];
}

export interface SharedElement {
    id: string;
    name: string;
    kind: ElementKind;
    page: string | null;
    locator: ElementLocator;
    description: string;
    notes: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
    /** `blocks`: the reusable steps that hold the element themselves. */
    usedBy: { count: number; steps: number; tests: UserBrief[]; blocks?: string[] };
}

export interface ElementList {
    total: number;
    limit: number;
    elements: SharedElement[];
}

export interface Revalidation {
    status: "started" | "waiting" | "none";
    jobId?: string;
    message?: string;
}

export interface ChangeResult extends SharedElement {
    appliesTo: number;
    tests: UserBrief[];
    revalidation: Revalidation;
    problems: Array<{ testId: string; error: string }>;
}

export interface Proposal {
    key: string;
    name: string;
    kind: ElementKind;
    page: string | null;
    locator: ElementLocator;
    description: string;
    uses: number;
    testCount: number;
    tests: UserBrief[];
    existing: string | null;
}

export const KIND_TEXT: Record<ElementKind, string> = { web: "Web", mobile: "Mobile", desktop: "Desktop" };

/** The ways to find an element, in the words a person uses. Desktop apps only know some of them. */
export const STRATEGIES: Array<{ id: Strategy; label: string; valueLabel: string; kinds: ElementKind[] }> = [
    { id: "role", label: "Role and name", valueLabel: "Name (optional)", kinds: ["web", "mobile", "desktop"] },
    { id: "label", label: "Field label", valueLabel: "Label", kinds: ["web", "mobile", "desktop"] },
    { id: "text", label: "Visible text", valueLabel: "Text", kinds: ["web", "mobile", "desktop"] },
    { id: "placeholder", label: "Placeholder", valueLabel: "Placeholder", kinds: ["web", "mobile"] },
    { id: "testId", label: "Test id", valueLabel: "Test id", kinds: ["web", "mobile", "desktop"] },
    { id: "css", label: "CSS selector", valueLabel: "Selector", kinds: ["web", "mobile"] },
];

export const COMMON_ROLES = ["button", "link", "textbox", "checkbox", "radio", "combobox", "heading", "status", "tab", "menuitem", "searchbox", "dialog"];

/** The page group heading of an element. */
export const groupOf = (e: SharedElement): string => e.page ?? "No page";

export const usedByText = (n: number): string => (n === 0 ? "Not used yet" : n === 1 ? "Used by 1 test" : `Used by ${n} tests`);

const quoted = (names: string[]): string => names.map((n) => `“${n}”`).join(", ");

/** One test in the "used by" line: its title, and which reusable steps it reaches the element through when it does not spell it out. */
export const userText = (u: UserBrief): string => (u.viaBlocks?.length ? `${u.title} (through the reusable steps ${quoted(u.viaBlocks)})` : u.title);

/** The sentence under an element: who uses it, including through reusable steps, and which reusable steps hold it. */
export function usedByLine(u: SharedElement["usedBy"]): string {
    const held = u.blocks?.length ? `Held in the reusable steps ${quoted(u.blocks)}` : "";
    if (u.count === 0) return held ? `Not used by a test yet. ${held}` : usedByText(0);
    const list = u.tests.map(userText).join(", ");
    return `${usedByText(u.count)}: ${list}${u.count > u.tests.length ? " and more" : ""}${held ? `. ${held}` : ""}`;
}

export function appliesToText(n: number): string {
    return n === 0 ? "No test uses this element yet." : n === 1 ? "Applies to 1 test." : `Applies to ${n} tests.`;
}
