/**
 * What the page offers right now: every visible element a test could plausibly mean, described the way a user (and a
 * Playwright locator) would. Collected inside the page by plain JavaScript passed as a string, so the code that runs in
 * the browser is exactly what is written here (no bundler helpers get injected into it).
 */
export interface Candidate {
    /** Index of the element: it carries data-heal-cand="<key>" while the page is being examined. */
    key: number;
    tag: string;
    /** ARIA role (explicit, or the element's built-in one); null for plain elements. */
    role: string | null;
    /** Accessible name, approximated from aria-label / label / alt / text. */
    name: string;
    /** Visible text, clipped. */
    text: string;
    /** True when no child element carries the same text: the innermost element holding it. */
    ownsText: boolean;
    testId: string | null;
    label: string | null;
    placeholder: string | null;
    id: string | null;
    classes: string[];
    nameAttr: string | null;
    type: string | null;
    /** Where it sits: ancestor tags with their id or first class, nearest first. */
    container: string;
    disabled: boolean;
}

export const MARKER = "data-heal-cand";
export const MAX_CANDIDATES = 1500;

/** An expression for page.evaluate(): returns Candidate[] and marks each element with data-heal-cand. */
export const COLLECT_SOURCE = `(() => {
  const MAX = ${MAX_CANDIDATES};
  const clip = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n);
  const ROLE_BY_TAG = { a: "link", button: "button", select: "combobox", textarea: "textbox", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading", nav: "navigation", main: "main", ul: "list", ol: "list", li: "listitem", table: "table", img: "img", summary: "button", dialog: "dialog", form: "form" };
  const INPUT_ROLE = { button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox" };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "img") return el.getAttribute("alt") === "" ? null : "img";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return null;
      return INPUT_ROLE[type] || "textbox";
    }
    if (tag === "select" && (el.multiple || el.size > 1)) return "listbox";
    return ROLE_BY_TAG[tag] || null;
  };
  const textOf = (el) => clip(el.innerText != null ? el.innerText : el.textContent, 200);
  const labelOf = (el) => {
    const parts = [];
    if (el.labels && el.labels.length) for (const l of el.labels) parts.push(clip(l.innerText, 120));
    const by = el.getAttribute("aria-labelledby");
    if (by) for (const id of by.split(/\\s+/)) { const n = document.getElementById(id); if (n) parts.push(clip(n.innerText, 120)); }
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(clip(aria, 120));
    return parts.filter(Boolean)[0] || null;
  };
  const nameOf = (el, role, text, label) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria, 120);
    if (label) return label;
    const tag = el.tagName.toLowerCase();
    if (tag === "img") return clip(el.getAttribute("alt"), 120);
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") return clip(el.value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : ""), 120);
      if (type === "image") return clip(el.getAttribute("alt"), 120);
      return clip(el.getAttribute("title") || el.getAttribute("placeholder"), 120);
    }
    if (role === "textbox" || role === "searchbox" || role === "combobox") return clip(el.getAttribute("title") || el.getAttribute("placeholder"), 120);
    return text || clip(el.getAttribute("title"), 120);
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const where = (el) => {
    const out = [];
    for (let p = el.parentElement, i = 0; p && p !== document.body && i < 4; p = p.parentElement, i++) {
      const cls = (p.getAttribute("class") || "").split(/\\s+/).filter(Boolean)[0];
      out.push(p.tagName.toLowerCase() + (p.id ? "#" + p.id : cls ? "." + cls : ""));
    }
    return out.join("<");
  };
  const SKIP = new Set(["script", "style", "meta", "link", "head", "title", "noscript", "html", "body", "svg", "path", "br", "hr"]);
  const out = [];
  let key = 0;
  for (const old of document.querySelectorAll("[${MARKER}]")) old.removeAttribute("${MARKER}");
  for (const el of document.querySelectorAll("*")) {
    if (out.length >= MAX) break;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag) || !visible(el)) continue;
    const role = roleOf(el);
    const testId = el.getAttribute("data-testid");
    const placeholder = el.getAttribute("placeholder");
    const text = tag === "input" ? "" : textOf(el);
    const label = labelOf(el);
    const ownsText = !!text && ![...el.children].some((c) => textOf(c) === text);
    if (!role && !testId && !placeholder && !label && !(ownsText && text.length <= 120) && !el.id) continue;
    el.setAttribute("${MARKER}", String(key));
    out.push({
      key: key++,
      tag,
      role,
      name: nameOf(el, role, text, label),
      text,
      ownsText,
      testId,
      label,
      placeholder,
      id: el.id || null,
      classes: (el.getAttribute("class") || "").split(/\\s+/).filter(Boolean).slice(0, 8),
      nameAttr: el.getAttribute("name"),
      type: el.getAttribute("type"),
      container: where(el),
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
    });
  }
  return out;
})()`;
