/**
 * The one line under the picture of the Explorer view ("Opened /pricing", "Clicked Sign in", "Filled the Email field").
 *
 * Built from facts the platform already holds about what it just did, never from what a page says: a path, the accessible name of a control the AI chose to
 * use, a count. No page text beyond that, no value that was typed, and a line that would contain a stored secret loses the part that does. Pure: no browser.
 */
import { cleanLine } from "../recorder/act.js";
import type { Step } from "../spec/schema.js";

export type Activity =
    | { kind: "opened"; url: string }
    | { kind: "read"; links: number }
    | { kind: "clicked"; name?: string }
    | { kind: "pointed"; name?: string }
    | { kind: "filled"; field?: string; secret?: boolean }
    | { kind: "chose"; field?: string }
    | { kind: "checked"; field?: string }
    | { kind: "pressed"; key: string }
    | { kind: "verified" }
    | { kind: "waited" }
    | { kind: "signedIn" }
    | { kind: "signInFailed" }
    | { kind: "typedSignIn" };

export const NOTE_MAX = 80;
const NAME_MAX = 40;
const PATH_MAX = 60;

/** A secret is only searched for when it is long enough not to be found in ordinary words by accident. */
const MIN_SECRET = 3;

/** "/pricing" for https://shop.test/pricing?plan=x#top (no query, no host); a hash route such as #/inbox stays because it is the page. */
export function pathOf(url: string): string {
    try {
        const u = new URL(url);
        const hash = /^#!?\//.test(u.hash) ? u.hash.split("?")[0]! : "";
        const p = `${u.pathname}${hash}`;
        return p.length > PATH_MAX ? `${p.slice(0, PATH_MAX - 1)}…` : p || "/";
    } catch {
        return "";
    }
}

/** The address shown next to the picture: no credentials, no query values (they can carry tokens), a hash route kept. */
export function safeAddress(url: string): string {
    try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return "";
        const hash = /^#!?\//.test(u.hash) ? u.hash.split("?")[0]! : "";
        const text = `${u.protocol}//${u.host}${u.pathname}${u.search ? "?…" : ""}${hash}`;
        return text.length > 300 ? `${text.slice(0, 299)}…` : text;
    } catch {
        return "";
    }
}

const holdsSecret = (text: string, secrets: readonly string[]): boolean => secrets.some((s) => s.length >= MIN_SECRET && text.toLowerCase().includes(s.toLowerCase()));

/** A name taken from the page, made safe to show: short, one line, and gone when it contains a stored secret. */
function nameOf(raw: string | undefined, secrets: readonly string[]): string {
    const t = cleanLine(raw ?? "", NAME_MAX);
    return t && !holdsSecret(t, secrets) ? t : "";
}

/** The line for one thing the platform did. At most NOTE_MAX characters. */
export function activityLine(a: Activity, secrets: readonly string[] = []): string {
    let line: string;
    switch (a.kind) {
        case "opened": {
            const p = pathOf(a.url);
            line = p && !holdsSecret(p, secrets) ? `Opened ${p}` : "Opened a page";
            break;
        }
        case "read":
            line = `Read ${a.links} ${a.links === 1 ? "link" : "links"}`;
            break;
        case "clicked": {
            const n = nameOf(a.name, secrets);
            line = n ? `Clicked ${n}` : "Clicked a control";
            break;
        }
        case "pointed": {
            const n = nameOf(a.name, secrets);
            line = n ? `Pointed at ${n}` : "Pointed at a control";
            break;
        }
        case "filled": {
            const n = nameOf(a.field, secrets);
            line = a.secret ? "Filled in a hidden field" : n ? `Filled the ${n} field` : "Filled in a field";
            break;
        }
        case "chose": {
            const n = nameOf(a.field, secrets);
            line = n ? `Chose an option in ${n}` : "Chose an option";
            break;
        }
        case "checked": {
            const n = nameOf(a.field, secrets);
            line = n ? `Ticked ${n}` : "Ticked a box";
            break;
        }
        case "pressed":
            line = /^[A-Za-z0-9+ ]{1,20}$/.test(a.key) && !holdsSecret(a.key, secrets) ? `Pressed ${a.key}` : "Pressed a key";
            break;
        case "verified":
            line = "Checked what the page shows";
            break;
        case "waited":
            line = "Waited for the page";
            break;
        case "typedSignIn":
            line = "Filled in the sign-in form";
            break;
        case "signedIn":
            line = "Signed in";
            break;
        case "signInFailed":
            line = "Tried to sign in; it did not work";
            break;
    }
    return line.length > NOTE_MAX ? `${line.slice(0, NOTE_MAX - 1)}…` : line;
}

/** The part of a step's locator that is a name a person would recognise; a CSS rule or test id is not shown. */
function labelOf(step: Step): string | undefined {
    const l = "locator" in step ? step.locator : undefined;
    if (!l || !("by" in l) || !l.by) return undefined;
    return l.by === "css" || l.by === "testId" ? undefined : l.value;
}

/** What the AI just did in the plain-English builder, as an activity. `page` is the address the browser is on now. */
export function activityOfStep(step: Step, pageUrl: string): Activity {
    switch (step.action) {
        case "navigate":
            return { kind: "opened", url: pageUrl };
        case "click":
            return { kind: "clicked", name: labelOf(step) };
        case "hover":
            return { kind: "pointed", name: labelOf(step) };
        case "fill": {
            // A stand-in for the stored password, or a field whose name says password, is never described by its name.
            const field = labelOf(step);
            const secret = /\{\{\s*credentials\.(password|totp)\s*\}\}/.test(step.value) || /pass(word|wd|code)|one.?time|\botp\b|card|cvv|cvc/i.test(field ?? "");
            return { kind: "filled", field, secret };
        }
        case "select":
            return { kind: "chose", field: labelOf(step) };
        case "check":
            return { kind: "checked", field: labelOf(step) };
        case "press":
            return { kind: "pressed", key: step.key };
        case "assert":
            return { kind: "verified" };
        case "wait":
            return { kind: "waited" };
        default:
            return { kind: "verified" };
    }
}
