/**
 * What one page shows, read from its DOM in a single round trip: title, visible text, same-document links, forms with their
 * fields, and the controls a person can use. The crawler turns this into a PageModel; the security assessment reads its
 * forms and links. The accessibility tree is read separately (ariaSnapshot in ./browser.ts).
 *
 * The function given to page.evaluate runs in the browser, so it declares no named functions of its own (the TypeScript
 * loader would wrap them in a helper the page does not have).
 */
import type { Page } from "playwright";

export interface PageSnapshot {
    url: string;
    title: string;
    text: string;
    links: Array<{ text: string; href: string }>;
    forms: FormSnapshot[];
    interactiveElements: InteractiveElement[];
}

export interface FormSnapshot {
    id?: string;
    action?: string;
    method?: string;
    fields: FormField[];
}

export interface FormField {
    type: string;
    name?: string;
    id?: string;
    label?: string;
    placeholder?: string;
    required: boolean;
    /** Declared constraints (attributes as written); options are a select's choice labels, not their values. */
    min?: string;
    max?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    options?: string[];
}

export interface InteractiveElement {
    /** The element's role attribute, or else its tag name in lower case (a, button, input...). */
    role: string;
    name: string;
    tagName: string;
}

/** Bounds on what one page contributes, so a huge page cannot flood the model or the store. */
export const SNAPSHOT_LIMITS = { textChars: 3_000, links: 120, linkTextChars: 80, controls: 80, controlNameChars: 60, options: 20, constraintChars: 200 } as const;

const CONTROLS = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"]';

type DomRead = Omit<PageSnapshot, "url" | "title">;

export async function captureSnapshot(page: Page): Promise<PageSnapshot> {
    const url = page.url();
    const title = await page.title().catch(() => "");
    const read = await page
        .evaluate(
            ({ limits, controls }): DomRead => {
                const links: DomRead["links"] = [];
                for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
                    if (links.length >= limits.links) break;
                    const text = (a.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, limits.linkTextChars);
                    if (text && !/^javascript:/i.test(a.href)) links.push({ text, href: a.href });
                }

                const forms: DomRead["forms"] = Array.from(document.forms).map((form) => {
                    const fields: FormField[] = [];
                    for (const el of Array.from(form.elements)) {
                        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
                        if (el instanceof HTMLInputElement && el.type === "hidden") continue;
                        const label = Array.from(el.labels ?? []).map((l) => l.textContent ?? "").join(" ").replace(/\s+/g, " ").trim() || (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim() || (el.getAttribute("placeholder") ?? "").replace(/\s+/g, " ").trim();
                        // Constraints as attributes, not properties: an absent maxlength reads as -1, an absent min as "".
                        const input = el instanceof HTMLInputElement ? el : null;
                        const minLength = el instanceof HTMLSelectElement ? null : (el.getAttribute("minlength") ?? "").trim();
                        const maxLength = el instanceof HTMLSelectElement ? null : (el.getAttribute("maxlength") ?? "").trim();
                        fields.push({
                            type: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
                            name: el.getAttribute("name") || undefined,
                            id: el.getAttribute("id") || undefined,
                            label: label || undefined,
                            placeholder: el instanceof HTMLSelectElement ? undefined : el.placeholder || undefined,
                            required: el.required,
                            min: input?.getAttribute("min")?.slice(0, limits.constraintChars) || undefined,
                            max: input?.getAttribute("max")?.slice(0, limits.constraintChars) || undefined,
                            minLength: minLength && /^\d+$/.test(minLength) ? Number(minLength) : undefined,
                            maxLength: maxLength && /^\d+$/.test(maxLength) ? Number(maxLength) : undefined,
                            pattern: input?.getAttribute("pattern")?.slice(0, limits.constraintChars) || undefined,
                            options:
                                el instanceof HTMLSelectElement
                                    ? Array.from(el.options)
                                          .filter((o) => o.value !== "")
                                          .slice(0, limits.options)
                                          .map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, limits.controlNameChars))
                                    : undefined,
                        });
                    }
                    // Attributes, not properties: a field named "action", "method" or "id" shadows the form's own property.
                    let action = form.getAttribute("action") || document.URL;
                    try {
                        action = new URL(action, document.baseURI).href;
                    } catch {
                        /* no base to resolve against (about:blank): keep it as written */
                    }
                    return {
                        id: form.getAttribute("id") || undefined,
                        action,
                        method: (form.getAttribute("method") || "get").toLowerCase(),
                        fields,
                    };
                });

                const interactiveElements: DomRead["interactiveElements"] = [];
                const named = new Set<string>();
                for (const el of Array.from(document.querySelectorAll<HTMLElement>(controls))) {
                    if (interactiveElements.length >= limits.controls) break;
                    const name = ((el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim() || (el.getAttribute("placeholder") ?? "").replace(/\s+/g, " ").trim() || (el.textContent ?? "").replace(/\s+/g, " ").trim()).slice(0, limits.controlNameChars);
                    if (!name || named.has(name)) continue;
                    named.add(name);
                    const tagName = el.tagName.toLowerCase();
                    interactiveElements.push({ role: el.getAttribute("role") || tagName, name, tagName });
                }

                return { text: (document.body?.innerText ?? "").slice(0, limits.textChars), links, forms, interactiveElements };
            },
            { limits: SNAPSHOT_LIMITS, controls: CONTROLS },
        )
        .catch((): DomRead => ({ text: "", links: [], forms: [], interactiveElements: [] }));
    return { url, title, ...read };
}

/** Dialogs, menus and tables on a page: names, menu item names and column headers. Never a table cell. */
export interface PageStructures {
    dialogs: string[];
    menus: Array<{ name: string; items: string[] }>;
    tables: Array<{ name: string; headers: string[] }>;
}

export const STRUCTURE_LIMITS = { dialogs: 20, menus: 10, items: 20, tables: 10, headers: 20, chars: 80 } as const;

/**
 * The page's dialogs (open or closed: dialog elements and dialog roles), menus (menu and menubar roles, with their items) and tables
 * (table elements and grid/table roles, with their column headers: the header row of a table, columnheader roles of a grid). A
 * dialog is named by its label or first heading; a table by its caption or label. A table with no header row is left out: its first
 * row is data.
 */
export async function readStructures(page: Page): Promise<PageStructures> {
    return page
        .evaluate((limits): PageStructures => {
            const out: PageStructures = { dialogs: [], menus: [], tables: [] };
            for (const el of Array.from(document.querySelectorAll<HTMLElement>("dialog, [role=dialog], [role=alertdialog]"))) {
                if (out.dialogs.length >= limits.dialogs) break;
                const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
                const name = (el.getAttribute("aria-label") || labelled || el.querySelector("h1,h2,h3,h4,h5,h6")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, limits.chars);
                if (name && !out.dialogs.includes(name)) out.dialogs.push(name);
            }
            for (const el of Array.from(document.querySelectorAll<HTMLElement>("[role=menu], [role=menubar]"))) {
                if (out.menus.length >= limits.menus) break;
                const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
                const name = (el.getAttribute("aria-label") || labelled).replace(/\s+/g, " ").trim().slice(0, limits.chars);
                const items = Array.from(el.querySelectorAll("[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]"))
                    .map((i) => (i.getAttribute("aria-label") || i.textContent || "").replace(/\s+/g, " ").trim().slice(0, limits.chars))
                    .filter(Boolean)
                    .slice(0, limits.items);
                if (items.length) out.menus.push({ name, items });
            }
            for (const el of Array.from(document.querySelectorAll<HTMLElement>("table, [role=grid], [role=table], [role=treegrid]"))) {
                if (out.tables.length >= limits.tables) break;
                const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
                const caption = el instanceof HTMLTableElement ? (el.caption?.textContent ?? "") : "";
                const name = (caption || el.getAttribute("aria-label") || labelled).replace(/\s+/g, " ").trim().slice(0, limits.chars);
                const headerRow = el instanceof HTMLTableElement ? (el.tHead ? el.tHead.rows[el.tHead.rows.length - 1] : el.rows[0]) : undefined;
                const cells = headerRow ? Array.from(headerRow.cells).filter((c) => c.tagName === "TH") : Array.from(el.querySelectorAll("[role=columnheader]"));
                const headers = cells
                    .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, limits.chars))
                    .filter(Boolean)
                    .slice(0, limits.headers);
                if (headers.length) out.tables.push({ name, headers });
            }
            return out;
        }, STRUCTURE_LIMITS)
        .catch((): PageStructures => ({ dialogs: [], menus: [], tables: [] }));
}

/** Add what a later read found (a dialog a click opened) to what the page already lists, without repeats, within the limits. */
export function mergeStructures(into: PageStructures, more: PageStructures): void {
    for (const d of more.dialogs) if (!into.dialogs.includes(d) && into.dialogs.length < STRUCTURE_LIMITS.dialogs) into.dialogs.push(d);
    const key = (x: unknown) => JSON.stringify(x);
    for (const m of more.menus) if (!into.menus.some((x) => key(x) === key(m)) && into.menus.length < STRUCTURE_LIMITS.menus) into.menus.push(m);
    for (const t of more.tables) if (!into.tables.some((x) => key(x) === key(t)) && into.tables.length < STRUCTURE_LIMITS.tables) into.tables.push(t);
}
