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
}

export interface InteractiveElement {
    /** The element's role attribute, or else its tag name in lower case (a, button, input...). */
    role: string;
    name: string;
    tagName: string;
}

/** Bounds on what one page contributes, so a huge page cannot flood the model or the store. */
export const SNAPSHOT_LIMITS = { textChars: 3_000, links: 120, linkTextChars: 80, controls: 80, controlNameChars: 60 } as const;

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
                        fields.push({
                            type: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
                            name: el.getAttribute("name") || undefined,
                            id: el.getAttribute("id") || undefined,
                            label: label || undefined,
                            placeholder: el instanceof HTMLSelectElement ? undefined : el.placeholder || undefined,
                            required: el.required,
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
