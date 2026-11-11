/**
 * Driving a recording session step by step (the pure part): the vocabulary of actions, how an action is checked before it touches a page, what may be
 * typed into which field, and how the page's own description of itself becomes a snapshot that is safe to hand to a person or a tool.
 *
 * No browser in here: the recorder core (session.ts) performs the actions and collects the raw page data; this file decides what is allowed and what is
 * shown. Everything that comes from the page is untrusted text: lengths are capped, control characters are removed, nothing in it is ever executed.
 */
import { LIVE_ACTIONS, LIVE_IMAGE_MAX_BYTES, LiveActionWire, type LiveElementWire, type LiveSnapshotWire } from "../../agent-protocol/schema.js";
import type { RecLocator, RecStep, SecretKind } from "./model.js";
import { parseCands, rankCandidates } from "./rank.js";

export { LIVE_ACTIONS, LIVE_IMAGE_MAX_BYTES };
export type LiveAction = LiveActionWire;
export type LiveSnapshot = LiveSnapshotWire;
export type LiveElement = LiveElementWire;

/** The limits of a live session (the wire schema holds the same numbers as its maxima). */
export const LIVE_LIMITS = {
    maxText: 6000,
    maxElements: 60,
    maxName: 120,
    maxValue: 200,
    maxTitle: 200,
    /** One action may take this long (waiting for a page, a slow click). */
    actionTimeoutMs: 15_000,
    /** After an action, how long the recorder waits for the page to report the step it caused. */
    stepWaitMs: 1_200,
    /** After a click or a key, how long to look for a page change it started. */
    pageChangeWaitMs: 900,
    /** Frames of the live view: no more often than this. */
    minFrameGapMs: 1_000,
} as const;

/** What the snapshot shows in place of the content of a field that holds a secret. */
export const HIDDEN = "[hidden]";

// ── the action, checked ─────────────────────────────────────────────────────

export type ParsedAction = { ok: true; action: LiveAction } | { ok: false; error: string };

const NEEDS_LOCATOR = "Say which element to use: give a locator (strategy and value), for example { strategy: \"role\", value: \"button\", name: \"Sign in\" }.";

/** Checks an action a person or tool sent. The answer says in plain words what to fix. Nothing here looks at a page. */
export function parseAction(raw: unknown): ParsedAction {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send an action as an object, for example { action: \"click\", locator: ... }." };
    const name = (raw as { action?: unknown }).action;
    if (typeof name !== "string" || !(LIVE_ACTIONS as readonly string[]).includes(name)) return { ok: false, error: `Unknown action. Use one of: ${LIVE_ACTIONS.join(", ")}.` };
    const r = LiveActionWire.safeParse(raw);
    if (!r.success) return { ok: false, error: explain(name, r.error.issues[0]) };
    const a = r.data;
    if ("locator" in a && a.locator !== undefined && !a.locator.value.trim()) return { ok: false, error: NEEDS_LOCATOR };
    if (a.action === "navigate" && !/^https?:\/\//i.test(a.url.trim()) && !a.url.trim().startsWith("/")) return { ok: false, error: "Navigate to a full address starting with http:// or https://, or to a path on the current site such as /cart." };
    if (a.action === "waitForText" && !a.value.trim()) return { ok: false, error: "Say which text to wait for." };
    return { ok: true, action: a };
}

function explain(action: string, issue: { path: PropertyKey[]; message: string; code: string } | undefined): string {
    const field = String(issue?.path[0] ?? "");
    if (field === "locator") return NEEDS_LOCATOR;
    if (action === "navigate" && field === "url") return "Say which address to open (url).";
    if (action === "press" && field === "value") return "A key press can be Enter, Escape or Tab (value).";
    if (action === "scroll" && field === "value") return "Scroll can be down, up, top or bottom (value).";
    if ((action === "fill" || action === "select") && field === "value") return `Say what to ${action === "fill" ? "type" : "choose"} (value, at most 500 characters).`;
    if (action === "waitForText" && field === "value") return "Say which text to wait for (value, at most 200 characters).";
    if (field === "timeoutMs") return "The wait can be from 100 to 15000 milliseconds (timeoutMs).";
    return `The ${action} action is not complete: check ${field || "its fields"}.`;
}

// ── secrets: what may be typed where ────────────────────────────────────────

/** `{{credentials.username}}`, `{{credentials.password}}` or `{{credentials.totp}}`: the only stand-ins a tool may type. */
export type CredentialSlot = "username" | "password" | "totp";
const PLACEHOLDER = /^\{\{\s*credentials\.(username|password|totp)\s*\}\}$/;

export function credentialSlotOf(value: string): CredentialSlot | undefined {
    const m = PLACEHOLDER.exec(value.trim());
    return m ? (m[1] as CredentialSlot) : undefined;
}

/** What the page script's secret test looks at (see `secretKind` in page-script.ts, which this mirrors: a unit test keeps them agreeing). */
export interface FieldFacts {
    tag: string;
    type?: string;
    autocomplete?: string;
    name?: string;
    id?: string;
    ariaLabel?: string;
    placeholder?: string;
}

export function secretKindOfField(f: FieldFacts): SecretKind | "" {
    if (f.tag.toLowerCase() !== "input") return "";
    const type = (f.type || "text").toLowerCase();
    const ac = (f.autocomplete ?? "").toLowerCase();
    if (type === "password") return "password";
    if (/one-time-code/.test(ac)) return "otp";
    if (/cc-number/.test(ac)) return "card_number";
    if (/cc-csc/.test(ac)) return "card_cvc";
    if (/(current|new)-password/.test(ac)) return "password";
    const hint = [f.name, f.id, f.ariaLabel, f.placeholder].map((x) => x ?? "").join(" ");
    if (/pass(word|wd|code)/i.test(hint)) return "password";
    if (/\botp\b|one.?time|verification code/i.test(hint)) return "otp";
    if (/cvv|cvc|security code/i.test(hint)) return "card_cvc";
    if (/card.?(number|no\b)/i.test(hint)) return "card_number";
    return "";
}

export type FillDecision = { ok: true; slot?: CredentialSlot } | { ok: false; status: number; error: string };

/**
 * May this value be typed into this field? A secret field (password, one-time code, card) only ever receives its own stand-in; the value is looked up on the
 * machine that owns the browser and is never sent back. Card details are never typed by a tool. An ordinary field takes any text, and of the stand-ins only
 * `{{credentials.username}}`: the password and the one-time code are typed into a field that the page script classifies as a password or code field, nowhere
 * else (a stand-in typed into a plain text field could be read back from it, so that is refused rather than scrubbed after the fact).
 */
export function decideFill(value: string, field: SecretKind | ""): FillDecision {
    const slot = credentialSlotOf(value);
    if (!field) {
        if (slot === "password" || slot === "totp") {
            return { ok: false, status: 422, error: `This field is not a ${slot === "totp" ? "one-time code" : "password"} field, so ${slot === "totp" ? "{{credentials.totp}}" : "{{credentials.password}}"} is not typed into it: the stored sign-in details only go into the fields meant for them. Only {{credentials.username}} can be typed into an ordinary field.` };
        }
        return slot ? { ok: true, slot } : { ok: true };
    }
    if (field === "card_number" || field === "card_cvc") return { ok: false, status: 422, error: "This is a card field. Card details are never typed by a tool. Use a test card in the application's own test mode by hand, or leave this step to a person." };
    const want: CredentialSlot = field === "otp" ? "totp" : "password";
    if (slot === want) return { ok: true, slot };
    const placeholder = field === "otp" ? "{{credentials.totp}}" : "{{credentials.password}}";
    return { ok: false, status: 422, error: `This field holds a ${field === "otp" ? "one-time code" : "password"}, so it can only be filled with ${placeholder}, which is taken from the project's stored sign-in details. A real value is never accepted here.` };
}

// ── text from the page ──────────────────────────────────────────────────────

// Control characters (except tab and line feed), the C1 range, zero-width and bidirectional controls: none of it belongs in text shown to a person or a tool.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** One line of page text: no control characters, runs of white space become one space, capped (a cut ends in an ellipsis). */
export function cleanLine(s: unknown, max: number): string {
    const t = String(s ?? "").replace(CONTROL, "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Several lines of page text: control characters removed, blank runs squeezed, capped. */
export function cleanBlock(s: unknown, max: number): { text: string; cut: boolean } {
    const t = String(s ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(CONTROL, "")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return t.length > max ? { text: `${t.slice(0, max - 1)}…`, cut: true } : { text: t, cut: false };
}

// ── the snapshot ────────────────────────────────────────────────────────────

/** What the page script reports about itself (untrusted: every field is checked). */
export interface RawElement {
    tag?: unknown;
    role?: unknown;
    name?: unknown;
    visible?: unknown;
    enabled?: unknown;
    value?: unknown;
    checked?: unknown;
    secretKind?: unknown;
    cands?: unknown;
}
export interface RawSnapshot {
    url?: unknown;
    title?: unknown;
    text?: unknown;
    elements?: unknown;
}

/**
 * The page's description of itself, made into a snapshot. Interactive elements come first as the page reported them (visible ones first); each gets the
 * inspector's best locator and its match count. A secret field shows "[hidden]" whatever it holds (the page does not even read it).
 */
export function shapeSnapshot(raw: RawSnapshot, o: { url?: string; maxElements?: number; maxText?: number } = {}): LiveSnapshot {
    const maxEl = o.maxElements ?? LIVE_LIMITS.maxElements;
    const block = cleanBlock(raw.text, o.maxText ?? LIVE_LIMITS.maxText);
    const list = Array.isArray(raw.elements) ? (raw.elements as RawElement[]) : [];
    const elements: LiveElement[] = [];
    for (const e of list) {
        if (elements.length >= maxEl) break;
        if (!e || typeof e !== "object") continue;
        const ranked = rankCandidates(parseCands(e.cands));
        if (!ranked) continue; // an element nothing can point at is of no use to act on
        const secret = typeof e.secretKind === "string" && e.secretKind !== "";
        const role = cleanLine(e.role, 40);
        const name = cleanLine(e.name, LIVE_LIMITS.maxName);
        const value = secret ? HIDDEN : typeof e.value === "string" ? cleanLine(e.value, LIVE_LIMITS.maxValue) : "";
        elements.push({
            index: elements.length,
            tag: cleanLine(e.tag, 30) || "element",
            ...(role ? { role } : {}),
            ...(name ? { name } : {}),
            locator: ranked.chosen as RecLocator,
            matches: ranked.matches,
            visible: e.visible !== false,
            enabled: e.enabled !== false,
            ...(value ? { value } : {}),
            ...(typeof e.checked === "boolean" ? { checked: e.checked } : {}),
            ...(secret ? { secret: true } : {}),
        });
    }
    const cutElements = list.length > elements.length && elements.length >= maxEl;
    return {
        url: cleanLine(o.url ?? raw.url, 2000),
        title: cleanLine(raw.title, LIVE_LIMITS.maxTitle),
        text: block.text,
        elements,
        ...(block.cut || cutElements ? { truncated: true } : {}),
    };
}

/** The steps a recording gained (or changed at the end) between two readings of its step list. */
export function stepsGained(before: readonly RecStep[], after: readonly RecStep[]): RecStep[] {
    if (after.length > before.length) return after.slice(before.length);
    const last = after[after.length - 1];
    const was = before[after.length - 1];
    if (last && was && (last.value !== was.value || last.at !== was.at || JSON.stringify(last.locator) !== JSON.stringify(was.locator))) return [last];
    return [];
}

/** True when a base64 picture fits the cap (decoded size). */
export const imageFits = (base64: string): boolean => Math.floor((base64.length * 3) / 4) <= LIVE_IMAGE_MAX_BYTES;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A snapshot that arrived from a runner agent (semi-trusted: it is only as safe as the machine it runs on) made safe again before anyone sees it: text cleaned
 * and capped, a secret field always "[hidden]", a picture kept only when it is real base64 and small enough.
 */
export function cleanAgentSnapshot(s: LiveSnapshot): LiveSnapshot {
    const block = cleanBlock(s.text, LIVE_LIMITS.maxText);
    const elements: LiveElement[] = s.elements.slice(0, LIVE_LIMITS.maxElements).map((e, i) => {
        const name = cleanLine(e.name, LIVE_LIMITS.maxName);
        const role = cleanLine(e.role, 40);
        const value = e.secret ? HIDDEN : e.value !== undefined ? cleanLine(e.value, LIVE_LIMITS.maxValue) : "";
        return {
            index: i,
            tag: cleanLine(e.tag, 30) || "element",
            ...(role ? { role } : {}),
            ...(name ? { name } : {}),
            locator: e.locator,
            matches: e.matches,
            visible: e.visible,
            enabled: e.enabled,
            ...(value ? { value } : {}),
            ...(e.checked !== undefined ? { checked: e.checked } : {}),
            ...(e.secret ? { secret: true } : {}),
        };
    });
    const pictureOk = s.image !== undefined && s.imageType !== undefined && BASE64.test(s.image) && imageFits(s.image);
    return {
        url: cleanLine(s.url, 2000),
        title: cleanLine(s.title, LIVE_LIMITS.maxTitle),
        text: block.text,
        elements,
        ...(s.truncated || block.cut || s.elements.length > elements.length ? { truncated: true } : {}),
        ...(pictureOk ? { image: s.image, imageType: s.imageType } : {}),
    };
}
