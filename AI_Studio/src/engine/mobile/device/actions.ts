/**
 * What an action may do, decided without touching the phone: the checks every action passes before a single tap is made.
 *
 * An action comes from an AI model (or, on a runner agent, from the network) and is therefore untrusted. It names an element of the LAST snapshot by number;
 * this module turns it into a plan with concrete points computed from that element's bounds, or refuses it in plain words. A password field accepts only the
 * credential stand-in and the real value is attached to the plan here, on the computer that owns the phone, and never leaves in any answer.
 */
import { DeviceActionWire, DEVICE_MAX_TYPED } from "../../../agent-protocol/schema.js";
import type { DeviceAction, ScreenElement, ScreenSnapshot } from "./types.js";
import { needsUnicodeKeyboard, unicodeProblem } from "../state/unicode.js";

/** How the phone can type. `unicode`: its current keyboard is ADBKeyboard, so text beyond plain ASCII can be typed (added for phone reliability; optional). */
export interface TypingOptions {
    unicode?: boolean;
}

export const PLACEHOLDER_USERNAME = "{{credentials.username}}";
export const PLACEHOLDER_PASSWORD = "{{credentials.password}}";

export const REFUSALS = {
    nothingYet: "Look at the screen first: there is nothing to act on yet.",
    stale: "That element is not on the screen any more. Look at the screen again.",
    notVisible: "That element is not visible on the screen.",
    disabled: "That element is switched off, so it can't be used.",
    notTextField: "That element is not a text field.",
    notScrollable: "That element does not scroll.",
    needCredentials: "Sign-in details are needed for this field. Add them in the project's settings.",
    passwordOnly: `This is a password field. It can only be filled with ${PLACEHOLDER_PASSWORD}.`,
    passwordElsewhere: `${PLACEHOLDER_PASSWORD} can only go into a password field.`,
    unknownPlaceholder: `Only ${PLACEHOLDER_USERNAME} and ${PLACEHOLDER_PASSWORD} can be used as stand-ins for sign-in details.`,
    notAscii: "That text has characters the phone can't type here. Use plain letters, digits and common symbols.",
    lineBreak: "Text with line breaks can't be typed. Type one line at a time.",
    percentS: "The sequence %s can't be typed. Write the text another way.",
    nothingToType: "There is no text to type.",
    storedUntypable: "The saved sign-in detail for this field has characters the phone can't type here.",
    badAction: "That is not something the phone can be asked to do.",
    carriesMore: "An action can only name an element by its number: it can't carry coordinates, packages or commands.",
} as const;

export function parseAction(raw: unknown): { ok: true; action: DeviceAction } | { ok: false; error: string } {
    const r = DeviceActionWire.safeParse(raw);
    if (r.success) return { ok: true, action: r.data as DeviceAction };
    const issue = r.error.issues[0];
    if (issue?.code === "unrecognized_keys") return { ok: false, error: REFUSALS.carriesMore };
    // Only the sentences written for a person are passed on; zod's own wording ("Required", "Expected object") never reaches one.
    const own = issue?.message && !/^(Invalid|Required|Expected|Unrecognized|String must|Number must|Array must)/.test(issue.message);
    return { ok: false, error: own ? issue!.message : REFUSALS.badAction };
}

/** Nothing but printable ASCII can be handed to `input text` safely. Returns the reason in words, or undefined when the text can be typed. */
export function untypable(text: string, o: TypingOptions = {}): string | undefined {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) return REFUSALS.lineBreak;
    // The phone's keyboard is ADBKeyboard: any one-line text goes through it as base64 (see ../state/unicode.ts), so only its own limits apply.
    if (o.unicode && needsUnicodeKeyboard(text)) return unicodeProblem(text);
    if (/[^\x20-\x7e]/.test(text)) return REFUSALS.notAscii;
    if (text.includes("%s")) return REFUSALS.percentS;
    if (text.length > DEVICE_MAX_TYPED) return `Text to type can be at most ${DEVICE_MAX_TYPED} characters.`;
    return undefined;
}

export interface Credentials {
    username?: string;
    password?: string;
}

export type Plan =
    | { kind: "tap"; x: number; y: number }
    | { kind: "longPress"; x: number; y: number }
    /** `text` is what is typed: for a stand-in it is the real value, so a plan must never be logged or returned. */
    | { kind: "type"; x: number; y: number; clearCount: number; text: string; secret: boolean; /** Typed through ADBKeyboard (text beyond ASCII). */ unicode?: boolean }
    | { kind: "scroll"; from: [number, number]; to: [number, number] }
    | { kind: "back" }
    | { kind: "hideKeyboard" }
    | { kind: "launch" }
    | { kind: "restart" }
    | { kind: "wait"; ms: number };

export type Planned = { ok: true; plan: Plan; element?: ScreenElement } | { ok: false; error: string };

const refuse = (error: string): Planned => ({ ok: false, error });

/** The part of the element that is on the screen, or undefined when none of it is. */
function visibleBounds(el: ScreenElement, snap: Pick<ScreenSnapshot, "width" | "height">): [number, number, number, number] | undefined {
    let [l, t, r, b] = el.bounds;
    if (snap.width > 0) {
        l = Math.max(0, l);
        r = Math.min(snap.width, r);
    }
    if (snap.height > 0) {
        t = Math.max(0, t);
        b = Math.min(snap.height, b);
    }
    return r - l >= 2 && b - t >= 2 ? [l, t, r, b] : undefined;
}

const centre = (b: [number, number, number, number]): [number, number] => [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)];

/** What to type for the text an action carries, or the refusal. Stand-ins are replaced by the real value only for the matching kind of field. */
export function resolveTypedText(el: ScreenElement, text: string, creds: Credentials | undefined, o: TypingOptions = {}): { ok: true; text: string; secret: boolean } | { ok: false; error: string } {
    const isPassword = text === PLACEHOLDER_PASSWORD;
    const isUser = text === PLACEHOLDER_USERNAME;
    if (el.password) {
        if (!isPassword) return { ok: false, error: REFUSALS.passwordOnly };
        if (!creds?.password) return { ok: false, error: REFUSALS.needCredentials };
        if (untypable(creds.password, o)) return { ok: false, error: REFUSALS.storedUntypable };
        return { ok: true, text: creds.password, secret: true };
    }
    if (isPassword) return { ok: false, error: REFUSALS.passwordElsewhere };
    if (isUser) {
        if (!creds?.username) return { ok: false, error: REFUSALS.needCredentials };
        if (untypable(creds.username, o)) return { ok: false, error: REFUSALS.storedUntypable };
        return { ok: true, text: creds.username, secret: false };
    }
    if (text.includes("{{credentials.")) return { ok: false, error: REFUSALS.unknownPlaceholder };
    const why = untypable(text, o);
    return why ? { ok: false, error: why } : { ok: true, text, secret: false };
}

/**
 * Turns an action into a plan against the last snapshot. `last` is the only thing an element number refers to: a number outside it, or a snapshot that does
 * not exist yet, is a stale reference and is refused.
 */
export function planAction(action: DeviceAction, last: ScreenSnapshot | undefined, creds?: Credentials, typing: TypingOptions = {}): Planned {
    switch (action.kind) {
        case "back":
        case "hideKeyboard":
        case "launch":
        case "restart":
            return { ok: true, plan: { kind: action.kind } };
        case "wait":
            return { ok: true, plan: { kind: "wait", ms: action.ms } };
        default:
            break;
    }
    if (!last) return refuse(REFUSALS.nothingYet);
    if (action.kind === "scroll" && action.index === undefined) {
        const w = last.width || 1080;
        const h = last.height || 1920;
        return { ok: true, plan: scrollPlan([0, 0, w, h], action.direction) };
    }
    const index = (action as { index: number }).index;
    const el = Number.isInteger(index) ? last.elements[index] : undefined;
    if (!el || el.index !== index) return refuse(REFUSALS.stale);
    const b = visibleBounds(el, last);
    if (!b) return refuse(REFUSALS.notVisible);
    switch (action.kind) {
        case "tap":
        case "longPress": {
            if (!el.enabled) return refuse(REFUSALS.disabled);
            const [x, y] = centre(b);
            return { ok: true, plan: { kind: action.kind, x, y }, element: el };
        }
        case "type": {
            if (!el.editable) return refuse(REFUSALS.notTextField);
            if (!el.enabled) return refuse(REFUSALS.disabled);
            const typed = resolveTypedText(el, action.text, creds, typing);
            if (!typed.ok) return refuse(typed.error);
            if (typed.text.length === 0 && action.clear !== true) return refuse(REFUSALS.nothingToType);
            const [x, y] = centre(b);
            const clearCount = action.clear ? (el.password ? 64 : Math.min(100, el.text.length + 10)) : 0;
            const unicode = typing.unicode === true && needsUnicodeKeyboard(typed.text);
            return { ok: true, plan: { kind: "type", x, y, clearCount, text: typed.text, secret: typed.secret, ...(unicode ? { unicode: true } : {}) }, element: el };
        }
        case "scroll": {
            if (!el.scrollable) return refuse(REFUSALS.notScrollable);
            return { ok: true, plan: scrollPlan(b, action.direction), element: el };
        }
        default:
            return refuse(REFUSALS.badAction);
    }
}

/** A swipe inside the area, in the middle half of it (away from the edges, where the system has gestures). "Down" moves the content up: the finger goes up. */
export function scrollPlan(b: [number, number, number, number], direction: "up" | "down" | "left" | "right"): Extract<Plan, { kind: "scroll" }> {
    const [cx, cy] = centre(b);
    const w = b[2] - b[0];
    const h = b[3] - b[1];
    const q = (a: number, size: number, f: number) => Math.round(a + size * f);
    switch (direction) {
        case "down":
            return { kind: "scroll", from: [cx, q(b[1], h, 0.75)], to: [cx, q(b[1], h, 0.25)] };
        case "up":
            return { kind: "scroll", from: [cx, q(b[1], h, 0.25)], to: [cx, q(b[1], h, 0.75)] };
        case "right":
            return { kind: "scroll", from: [q(b[0], w, 0.75), cy], to: [q(b[0], w, 0.25), cy] };
        default:
            return { kind: "scroll", from: [q(b[0], w, 0.25), cy], to: [q(b[0], w, 0.75), cy] };
    }
}

/** True when the same thing is still at the same place: an element of a fresh snapshot that the old one names. Used to refuse an action on a screen that moved on. */
export function sameElement(a: ScreenElement, b: ScreenElement): boolean {
    // What a person typed into a field changes its text; that is the same field.
    const sameText = a.editable || a.password ? true : a.text === b.text;
    return a.cls === b.cls && a.id === b.id && a.desc === b.desc && sameText && a.bounds.every((v, i) => v === b.bounds[i]);
}
