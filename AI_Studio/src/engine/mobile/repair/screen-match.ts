/**
 * Which elements of a phone screen a test's locator names, judged from the device session's snapshot the way the Taqwright locators read it:
 * test id = resource id, label = accessibility label, text = visible text, placeholder = a text field's hint, role + name. CSS has no meaning on a
 * native screen and finds nothing. Used to replay a phone test on the device and to tell whether an element is really missing.
 */
import type { ScreenElement } from "../device/types.js";
import { roleOf } from "../explore/locators.js";
import type { Locator } from "../../spec/schema.js";

const key = (v: string) => v.trim().toLowerCase();

export function matchesOnScreen(loc: Locator, elements: readonly ScreenElement[]): ScreenElement[] {
    const v = key(String(loc.value ?? ""));
    const exact = (s: string) => key(s) === v;
    let found: ScreenElement[];
    switch (loc.by) {
        case "testId":
            found = elements.filter((e) => e.id !== "" && (e.id === loc.value || exact(e.id)));
            break;
        case "label":
            found = elements.filter((e) => exact(e.desc));
            break;
        case "text": {
            const same = elements.filter((e) => !e.password && exact(e.text));
            // Taqwright's text locator also finds a partial match when nothing matches exactly.
            found = same.length || loc.exact ? same : elements.filter((e) => !e.password && v !== "" && key(e.text).includes(v));
            break;
        }
        case "placeholder":
            found = elements.filter((e) => e.editable && exact(e.text));
            break;
        case "role":
            found = elements.filter((e) => roleOf(e.cls) === loc.role && (loc.value === undefined || exact(e.desc || (e.password ? "" : e.text))));
            break;
        default:
            found = [];
    }
    if (loc.nth !== undefined) {
        const one = found[loc.nth];
        return one ? [one] : [];
    }
    return found;
}
