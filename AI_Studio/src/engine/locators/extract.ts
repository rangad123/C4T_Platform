/**
 * Finding locators that several tests spell out identically, and proposing named elements for them.
 *
 * Nothing here changes anything: it reads specs and returns proposals. Applying a proposal (creating the element and turning those
 * steps into references) is a separate, confirmed action of the platform.
 */
import { isLocatorRef, type Locator, type TestSpec } from "../spec/schema.js";
import { locatorOf, refOf } from "./refs.js";
import { ELEMENT_KINDS, locatorKey, nameKey, NAME_MAX, nameProblem, tidy, type ElementKind } from "./model.js";

export interface ExtractTest {
    /** Database id of the test. */
    id: string;
    testKey: string;
    title: string;
    spec: TestSpec;
}

export interface ExtractUse {
    testId: string;
    testKey: string;
    title: string;
    stepIndex: number;
}

export interface ExtractProposal {
    /** Stable identifier of the locator (kind + locator): what a confirmation names. */
    key: string;
    kind: ElementKind;
    locator: Locator;
    /** Proposed element name (unique among the existing names and the other proposals). */
    name: string;
    page?: string;
    uses: ExtractUse[];
    /** The repository already has an element with exactly this locator: applying only points the steps at it. */
    existing?: string;
}

const ROLE_WORD: Record<string, string> = {
    textbox: "field",
    searchbox: "search field",
    combobox: "dropdown",
    spinbutton: "number field",
    menuitem: "menu item",
    listbox: "list",
};

const sentence = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Letters, numbers and the separators names allow; everything else becomes a space. */
const safe = (s: string): string =>
    s
        .replace(/[^\p{L}\p{N} _.\-/&'()+,:]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

/** "checkout-btn" -> "Checkout btn". */
const humanize = (s: string): string => sentence(safe(s.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()));

/** A readable label for the element a locator finds. */
export function labelFor(l: Locator): string {
    const v = (l.value ?? "").trim();
    switch (l.by) {
        case "role": {
            const role = l.role ?? "element";
            const word = ROLE_WORD[role] ?? role;
            return v ? `${safe(v)} ${word}` : `Unnamed ${word}`;
        }
        case "label":
        case "placeholder":
            return `${safe(v)} field`;
        case "text":
            return `${safe(v)} text`;
        case "testId":
            return humanize(v) || "Element";
        case "css":
            return `Element ${safe(v).slice(0, 30)}`.trim();
        default:
            return "Element";
    }
}

/** "/cart/checkout?x=1" -> "Cart checkout", "/" -> "Home". Undefined when the address is not a plain path. */
export function pageFromUrl(url: string): string | undefined {
    if (url.includes("{{")) return undefined;
    let path: string;
    try {
        path = new URL(url, "http://page.invalid").pathname;
    } catch {
        return undefined;
    }
    const words = path.split("/").filter(Boolean).map((s) => safe(decodeURIComponent(s).replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ")));
    if (!words.length) return "Home";
    return sentence(words.slice(-2).join(" ").slice(0, 40).trim()) || undefined;
}

/** The page a step happens on: the address of the latest `navigate` before it (web tests only). */
function pageAt(spec: TestSpec, stepIndex: number): string | undefined {
    if (spec.kind !== "web") return undefined;
    for (let i = stepIndex - 1; i >= 0; i--) {
        const s = spec.steps[i]!;
        if (s.action === "navigate") return pageFromUrl(s.url);
    }
    return undefined;
}

/** A name nobody uses yet: the wanted one, or with " 2", " 3" ... added. */
export function uniqueName(wanted: string, taken: Set<string>): string {
    const base = (safe(wanted) || "Element").slice(0, NAME_MAX - 5).trim();
    const first = sentence(base);
    let name = first;
    for (let n = 2; taken.has(nameKey(name)); n++) name = `${first} ${n}`;
    taken.add(nameKey(name));
    return nameProblem(name) ? uniqueName("Element", taken) : name;
}

export interface ExtractOptions {
    /** Existing elements: their names stay free of clashes, and an identical locator is pointed at instead of duplicated. */
    existing?: Array<{ name: string; kind: ElementKind; locator: Locator }>;
    /** Include locators found only once (the person picks one explicitly). Default: 2 or more places. */
    minUses?: number;
}

/**
 * Locators used in two or more places (same kind, same locator), most used first. A locator with a {{placeholder}} depends on one
 * test's data and is never proposed; steps that already use an element are skipped.
 */
export function proposeExtraction(tests: ExtractTest[], opts: ExtractOptions = {}): ExtractProposal[] {
    const minUses = opts.minUses ?? 2;
    const groups = new Map<string, { kind: ElementKind; locator: Locator; uses: ExtractUse[]; pages: Array<string | undefined> }>();
    for (const t of tests) {
        if (!(ELEMENT_KINDS as readonly string[]).includes(t.spec.kind)) continue;
        const kind = t.spec.kind as ElementKind;
        t.spec.steps.forEach((step, stepIndex) => {
            const l = locatorOf(step);
            if (!l || isLocatorRef(l) || refOf(l) !== undefined || !l.by) return;
            if ((l.value ?? "").includes("{{")) return;
            const key = locatorKey(kind, l);
            const g = groups.get(key) ?? { kind, locator: tidy(l), uses: [], pages: [] };
            g.uses.push({ testId: t.id, testKey: t.testKey, title: t.title, stepIndex });
            g.pages.push(pageAt(t.spec, stepIndex));
            groups.set(key, g);
        });
    }
    const existing = opts.existing ?? [];
    const byLocator = new Map(existing.map((e) => [locatorKey(e.kind, e.locator), e.name]));
    const taken = new Set(existing.map((e) => nameKey(e.name)));
    const out: ExtractProposal[] = [];
    const ranked = [...groups.entries()].filter(([, g]) => g.uses.length >= minUses).sort((a, b) => b[1].uses.length - a[1].uses.length || a[0].localeCompare(b[0]));
    for (const [key, g] of ranked) {
        const reuse = byLocator.get(key);
        const pages = new Set(g.pages);
        const page = pages.size === 1 ? g.pages[0] : undefined;
        const label = labelFor(g.locator);
        out.push({
            key,
            kind: g.kind,
            locator: g.locator,
            name: reuse ?? uniqueName(page ? `${page} / ${label}` : label, taken),
            ...(page ? { page } : {}),
            uses: g.uses,
            ...(reuse ? { existing: reuse } : {}),
        });
    }
    return out;
}
