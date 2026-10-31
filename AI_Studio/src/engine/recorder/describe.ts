/** Plain-words descriptions of recorded steps ("Click the button "Add to cart""). Never contains a secret: a secret step says what it typed, not its value. */
import { clip, isSecretKind, REC_LIMITS, SECRET_PLACEHOLDERS, SECRET_WORDS, type RecAssert, type RecLocator, type RecStep, type SecretKind } from "./model.js";

const ROLE_WORDS: Record<string, string> = {
    button: "button", link: "link", textbox: "text field", searchbox: "search box", checkbox: "checkbox", radio: "radio button", combobox: "drop-down list",
    listbox: "list", option: "option", tab: "tab", menuitem: "menu item", heading: "heading", img: "image", switch: "switch", slider: "slider", spinbutton: "number field",
    listitem: "list item", navigation: "navigation", dialog: "dialog", cell: "table cell", row: "table row", table: "table", list: "list",
};

/** The element in words: `button "Add to cart"`, `field labelled "Email"`. */
export function locatorWords(l: RecLocator | undefined): string {
    if (!l) return "the page";
    const v = clip(l.value, 80);
    switch (l.strategy) {
        case "role":
            return `${ROLE_WORDS[l.value] ?? l.value}${l.name ? ` "${clip(l.name, 80)}"` : ""}`;
        case "testId":
            return `element with test id "${v}"`;
        case "label":
            return `field labelled "${v}"`;
        case "placeholder":
            return `field with the hint "${v}"`;
        case "text":
            return `text "${v}"`;
        case "css":
            return `element ${v}`;
    }
}

export function assertWords(a: RecAssert, l: RecLocator | undefined): string {
    const what = locatorWords(l);
    switch (a.check) {
        case "visible":
            return `Check that the ${what} is visible`;
        case "hidden":
            return `Check that the ${what} is not visible`;
        case "enabled":
            return `Check that the ${what} is enabled`;
        case "disabled":
            return `Check that the ${what} is disabled`;
        case "text":
            return `Check that the ${what} shows "${clip(String(a.expected ?? ""), 80)}"`;
        case "value":
            return `Check that the ${what} holds "${clip(String(a.expected ?? ""), 80)}"`;
        case "count":
            return `Check that there are ${a.expected ?? 0} of ${what}`;
    }
}

/** `secretKind` is only needed to word a secret fill; the step's own `secret` flag says it is one. */
export function describeRecStep(s: Pick<RecStep, "kind" | "url" | "locator" | "value" | "secret" | "assert"> & Partial<Pick<RecStep, "target" | "frame" | "inPopup" | "opensPopup">>, extra: { positional?: boolean; generated?: boolean; secretKind?: SecretKind } = {}): string {
    const what = locatorWords(s.locator);
    let text: string;
    switch (s.kind) {
        case "goto":
            text = `Open ${clip(s.url ?? "", 120)}`;
            break;
        case "click":
            text = `Click the ${what}`;
            break;
        case "fill": {
            if (s.secret) {
                const kind = extra.secretKind ?? (Object.entries(SECRET_PLACEHOLDERS).find(([, p]) => p === s.value)?.[0] as SecretKind | undefined);
                text = `Type ${isSecretKind(kind) ? SECRET_WORDS[kind] : "the secret"} into the ${what}`;
            } else text = s.value === "" ? `Clear the ${what}` : `Type "${clip(s.value ?? "", 60)}" into the ${what}`;
            break;
        }
        case "select":
            text = `Choose "${clip(s.value ?? "", 60)}" in the ${what}`;
            break;
        case "check":
            text = `Tick the ${what}`;
            break;
        case "uncheck":
            text = `Untick the ${what}`;
            break;
        case "press":
            text = s.locator ? `Press ${s.value ?? "a key"} in the ${what}` : `Press ${s.value ?? "a key"}`;
            break;
        case "assert":
            text = s.assert ? assertWords(s.assert, s.locator) : `Check the ${what}`;
            break;
        case "upload":
            text = `Upload the test file "${clip(s.value ?? "", 60)}" to the ${what}`;
            break;
        case "drag":
            text = `Drag the ${what} to the ${locatorWords(s.target)}`;
            break;
    }
    // Frames and popups only add words to the steps that have them.
    if (s.frame?.length) text += ` inside ${s.frame.length === 1 ? "a frame" : `${s.frame.length} nested frames`} (${s.frame.map((f) => `"${clip(f.value, 40)}"`).join(", ")})`;
    if (s.opensPopup) text += ", which opens a popup";
    if (s.inPopup) text += " in the popup";
    if (extra.positional) text += " (no name or label to go by, so it is found by its place on the page)";
    else if (extra.generated) text += " (its only locator looks generated and may break after a release)";
    return clip(text, REC_LIMITS.maxDescribe);
}
